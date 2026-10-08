import type { PrismaClient } from '../generated/prisma/client.js';
import { getLogger, safeError } from '../lib/logger.js';
import type { InboundMessage, StatusUpdate, WebhookEvent } from './webhook-parser.js';

/*
 * Recebe os eventos já validados do webhook e decide o que fazer com cada um:
 * - mensagem nova -> atendimento (MessageHandler; o funil do Passo 4);
 * - mensagem repetida (a Meta reentrega quando acha que não recebemos) -> ignora;
 * - mensagem antiga demais -> ignora (ver MAX_MESSAGE_AGE_MS);
 * - aviso de falha na entrega de algo que enviamos -> registra na fila outbound_messages.
 * Um evento com problema não impede os outros do mesmo lote.
 */

/**
 * Depois de 24 h da mensagem do cliente, a Meta só aceita template: uma resposta livre
 * falharia. E responder "qual horário prefere?" a uma mensagem de dias atrás (reentregas
 * depois de uma queda) só confunde.
 */
export const MAX_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000;

export interface MessageHandler {
  handle(message: InboundMessage): Promise<void>;
}

/** Quem recebe os eventos do webhook (o controller só conhece esta interface). */
export interface WebhookEventSink {
  handleEvents(events: WebhookEvent[]): Promise<void>;
}

export interface DispatcherStore {
  /** Registra a mensagem como processada. false = já estava (reentrega da Meta). */
  markProcessed(waMessageId: string): Promise<boolean>;
  /** Marca como falha a mensagem da fila com este wamid. Devolve quantas foram afetadas. */
  markOutboundFailed(waMessageId: string, errorCode: string | undefined): Promise<number>;
}

export function createPrismaDispatcherStore(prisma: PrismaClient): DispatcherStore {
  return {
    async markProcessed(waMessageId) {
      // skipDuplicates: a chave primária decide, sem corrida entre duas entregas simultâneas.
      const { count } = await prisma.processedMessage.createMany({
        data: [{ waMessageId }],
        skipDuplicates: true,
      });
      return count === 1;
    },
    async markOutboundFailed(waMessageId, errorCode) {
      const { count } = await prisma.outboundMessage.updateMany({
        where: { waMessageId },
        data: { status: 'FAILED', lastErrorCode: errorCode ?? null },
      });
      return count;
    },
  };
}

export function createInboundDispatcher(deps: {
  store: DispatcherStore;
  handler: MessageHandler;
  now?: () => Date;
}): WebhookEventSink {
  const now = deps.now ?? (() => new Date());

  async function onMessage(message: InboundMessage): Promise<void> {
    const logger = getLogger();
    // Registrar antes de atender: se a Meta reentregar enquanto respondemos, a segunda
    // entrega já encontra o registro e não gera resposta (ou agendamento) em dobro.
    const isNew = await deps.store.markProcessed(message.id);
    if (!isNew) {
      logger.debug('mensagem repetida ignorada');
      return;
    }
    if (now().getTime() - message.timestamp.getTime() > MAX_MESSAGE_AGE_MS) {
      logger.info({ contentType: message.content.type }, 'mensagem antiga ignorada (mais de 24 h)');
      return;
    }
    // PRIVACIDADE: só o tipo de conteúdo vai ao log; nunca telefone, nome ou texto.
    logger.info({ contentType: message.content.type }, 'mensagem recebida');
    await deps.handler.handle(message);
  }

  async function onStatus(status: StatusUpdate): Promise<void> {
    if (status.status !== 'failed') return;
    const affected = await deps.store.markOutboundFailed(status.messageId, status.errorCode);
    getLogger().warn(
      { errorCode: status.errorCode, queued: affected > 0 },
      'a Meta não conseguiu entregar uma mensagem nossa',
    );
  }

  return {
    async handleEvents(events) {
      for (const event of events) {
        try {
          if (event.kind === 'message') await onMessage(event.message);
          else await onStatus(event.status);
        } catch (err) {
          getLogger().error({ err: safeError(err), eventKind: event.kind }, 'falha ao tratar evento');
        }
      }
    },
  };
}
