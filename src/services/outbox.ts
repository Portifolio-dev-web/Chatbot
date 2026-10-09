import { OUTBOX } from '../config/business-rules.js';
import { serviceLabel, type Profile } from '../profiles/index.js';
import { TEMPLATE_LANGUAGE, TEMPLATES } from '../content/templates.js';
import { Prisma, type OutboundKind, type PrismaClient } from '../generated/prisma/client.js';
import { getLogger, safeError } from '../lib/logger.js';
import { formatDateTime } from '../lib/time.js';
import { isLateCancellation } from './booking.js';
import { replyIds } from './chatbot/reply-ids.js';
import { decryptName, decryptPhone } from './clients.js';
import { WhatsAppApiError, type TemplateMessage, type WhatsAppClient } from './whatsapp-client.js';

/*
 * Envio da fila outbound_messages: lembretes ao cliente e avisos à recepção, por template.
 *
 * Como uma mensagem é enviada uma vez só, mesmo com mais de uma instância do servidor:
 * 1. "Reserva" um lote com FOR UPDATE SKIP LOCKED, empurrando send_after para daqui a
 *    OUTBOX.leaseMs. Quem chegar depois pula essas linhas.
 * 2. Envia fora da transação (sem segurar o banco durante a chamada à Meta).
 * 3. Marca SENT; em falha temporária, reagenda com espera crescente; em falha definitiva
 *    (ou na 5ª tentativa), marca FAILED com o código da Meta.
 * Se o processo cair entre 1 e 3, o prazo vence e a mensagem volta para a fila.
 *
 * PRIVACIDADE: o destinatário não fica na fila; o telefone do cliente é decifrado só na
 * hora de enviar. Nada de nome ou telefone no log: só tipo, código de erro e tentativas.
 */

export interface OutboxDeps {
  prisma: PrismaClient;
  whatsapp: WhatsAppClient;
  timeZone: string;
  /** Sem ele (fora de produção), os avisos à recepção ficam esperando na fila. */
  receptionPhone: string | undefined;
  /** Perfil da instalação: dá o nome do serviço mostrado no lembrete e no aviso. */
  profile: Profile;
}

interface Claimed {
  id: string;
  kind: OutboundKind;
  appointmentId: string;
  attempts: number;
}

export interface OutboxRun {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
}

/** Códigos da Meta que valem nova tentativa (limites de envio, instabilidade, token). */
const RETRYABLE_CODES = new Set(['130429', '131056', '131000', '131016', '190', '2', '4']);

/**
 * Falha definitiva = não adianta tentar de novo (template inexistente, parâmetro errado,
 * número sem WhatsApp). Rede, 5xx, 429 e token inválido são temporários: depois de trocar
 * o token, as mensagens ainda saem.
 */
export function isPermanentFailure(err: unknown): boolean {
  if (!(err instanceof WhatsAppApiError)) return true; // erro nosso (ex.: limite de parâmetro)
  if (err.httpStatus === undefined) return false;
  if (err.httpStatus === 401 || err.httpStatus === 429 || err.httpStatus >= 500) return false;
  return !RETRYABLE_CODES.has(err.code);
}

async function claim(deps: OutboxDeps, now: Date): Promise<Claimed[]> {
  const leaseUntil = new Date(now.getTime() + OUTBOX.leaseMs);
  // Sem número da recepção, só lembretes são reservados (avisos esperam a configuração).
  const kindFilter = deps.receptionPhone ? Prisma.empty : Prisma.sql`AND kind = 'CLIENT_REMINDER'`;
  return deps.prisma.$queryRaw<Claimed[]>`
    UPDATE outbound_messages
       SET send_after = ${leaseUntil}, attempts = attempts + 1, updated_at = ${now}
     WHERE id IN (
           SELECT id FROM outbound_messages
            WHERE status = 'PENDING' AND send_after <= ${now} ${kindFilter}
            ORDER BY send_after
            LIMIT ${OUTBOX.batchSize}
              FOR UPDATE SKIP LOCKED)
    RETURNING id, kind, appointment_id AS "appointmentId", attempts`;
}

/** Monta destinatário e template; null = não faz mais sentido enviar (cancela na fila). */
async function compose(
  deps: OutboxDeps,
  item: Claimed,
  now: Date,
): Promise<{ to: string; template: TemplateMessage } | null> {
  const appointment = await deps.prisma.appointment.findUnique({
    where: { id: item.appointmentId },
    include: { client: true },
  });
  if (!appointment) return null;
  const service = serviceLabel(deps.profile, appointment.serviceType);
  const when = formatDateTime(appointment.startsAt, deps.timeZone);
  const name = decryptName(appointment.client);

  if (item.kind === 'CLIENT_REMINDER') {
    const phone = decryptPhone(appointment.client);
    if (appointment.status !== 'CONFIRMED' || appointment.startsAt <= now || !phone) return null;
    return {
      to: phone,
      template: {
        name: TEMPLATES.reminder,
        language: TEMPLATE_LANGUAGE,
        bodyParams: [name?.split(' ')[0] ?? 'tudo bem', service.toLowerCase(), when],
        quickReplyPayloads: [replyIds.remindOk(appointment.id), replyIds.remindChange(appointment.id)],
      },
    };
  }

  if (!deps.receptionPhone) return null; // não acontece: claim() já filtra
  const event =
    item.kind === 'RECEPTION_NEW_BOOKING'
      ? 'novo agendamento'
      : isLateCancellation(appointment)
        ? 'cancelamento com menos de 24 h'
        : 'cancelamento';
  return {
    to: deps.receptionPhone,
    template: {
      name: TEMPLATES.receptionNotice,
      language: TEMPLATE_LANGUAGE,
      bodyParams: [event, name ?? 'cliente que pediu para apagar os dados', service, when],
    },
  };
}

/** Confere e envia o que está vencido na fila (um lote). */
export async function processOutbox(deps: OutboxDeps, now: Date): Promise<OutboxRun> {
  const logger = getLogger();
  const run: OutboxRun = { claimed: 0, sent: 0, retried: 0, failed: 0, cancelled: 0 };
  const items = await claim(deps, now);
  run.claimed = items.length;

  for (const item of items) {
    // Só segue se ainda estiver PENDING (pode ter sido cancelada depois da reserva).
    const stillPending = { id: item.id, status: 'PENDING' as const };
    let message: Awaited<ReturnType<typeof compose>>;
    try {
      message = await compose(deps, item, now);
    } catch (err) {
      // Ex.: dado cifrado com uma chave que saiu da configuração. Não insiste.
      logger.error({ err: safeError(err), kind: item.kind }, 'fila: não foi possível montar a mensagem');
      await deps.prisma.outboundMessage.updateMany({
        where: stillPending,
        data: { status: 'FAILED', lastErrorCode: 'COMPOSE' },
      });
      run.failed++;
      continue;
    }
    if (!message) {
      await deps.prisma.outboundMessage.updateMany({ where: stillPending, data: { status: 'CANCELLED' } });
      run.cancelled++;
      continue;
    }

    // O try cobre SÓ a chamada à Meta. Antes, o registro de "enviado" estava no mesmo bloco:
    // se ele falhasse depois de a mensagem já ter saído, a fila tratava como falha de envio e
    // podia mandar a mesma mensagem de novo ao cliente.
    let messageId: string | undefined;
    try {
      ({ messageId } = await deps.whatsapp.sendTemplate(message.to, message.template));
    } catch (err) {
      const code = err instanceof WhatsAppApiError ? err.code : 'INVALID';
      const giveUp = isPermanentFailure(err) || item.attempts >= OUTBOX.maxAttempts;
      if (giveUp) {
        await deps.prisma.outboundMessage.updateMany({
          where: stillPending,
          data: { status: 'FAILED', lastErrorCode: code },
        });
        logger.error(
          { err: safeError(err), kind: item.kind, errorCode: code, attempts: item.attempts },
          'fila: envio desistido',
        );
        run.failed++;
      } else {
        const delay = OUTBOX.retryDelaysMs[item.attempts - 1] ?? OUTBOX.retryDelaysMs.at(-1)!;
        await deps.prisma.outboundMessage.updateMany({
          where: stillPending,
          data: { sendAfter: new Date(now.getTime() + delay), lastErrorCode: code },
        });
        logger.warn({ kind: item.kind, errorCode: code, attempts: item.attempts }, 'fila: nova tentativa agendada');
        run.retried++;
      }
      continue;
    }

    await markSent(deps, stillPending, now, messageId, item.kind);
    run.sent++;
  }
  return run;
}

/**
 * Registra o envio. Se a gravação com o wamid falhar, tenta ao menos marcar SENT sem ele:
 * deixar a linha PENDING faria a mensagem sair de novo quando o prazo da reserva vencesse.
 */
async function markSent(
  deps: OutboxDeps,
  where: { id: string; status: 'PENDING' },
  now: Date,
  messageId: string | undefined,
  kind: OutboundKind,
): Promise<void> {
  try {
    await deps.prisma.outboundMessage.updateMany({
      where,
      data: { status: 'SENT', sentAt: now, waMessageId: messageId ?? null, lastErrorCode: null },
    });
  } catch (err) {
    getLogger().error({ err: safeError(err), kind }, 'fila: enviada, mas o registro com o wamid falhou');
    await deps.prisma.outboundMessage.updateMany({
      where,
      data: { status: 'SENT', sentAt: now, lastErrorCode: 'RECORD' },
    });
  }
}
