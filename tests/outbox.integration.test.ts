import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTBOX } from '../src/config/business-rules.js';
import { currentConsentText } from '../src/content/consent.js';
import { defaultScheduleRows } from '../src/content/default-schedule.js';
import type { PrismaClient, ServiceType } from '../src/generated/prisma/client.js';
import { setLoggerForTesting } from '../src/lib/logger.js';
import { createPrismaClient } from '../src/lib/prisma.js';
import { addDays, formatDateTime, weekdayOf, zonedToUtc } from '../src/lib/time.js';
import { bookingWindow, findFreeSlots } from '../src/services/availability.js';
import { bookAppointment, reminderTime } from '../src/services/booking.js';
import { createChatbot } from '../src/services/chatbot/chatbot.js';
import { replyIds } from '../src/services/chatbot/reply-ids.js';
import { recordConsent, setClientName } from '../src/services/clients.js';
import { runMaintenance } from '../src/services/maintenance.js';
import { processOutbox, type OutboxDeps } from '../src/services/outbox.js';
import { captureLogs, recordingWhatsApp, type SentMessage } from './fixtures.js';

/*
 * Fila de lembretes/avisos e rotina de retenção contra um PostgreSQL de verdade
 * (TEST_DATABASE_URL, banco DESCARTÁVEL). "Agora" = segunda 08:00 num ano sorteado.
 */
const url = process.env.TEST_DATABASE_URL;
const SP = 'America/Sao_Paulo';
const POLICY = 'https://exemplo.com/privacidade';
const RECEPTION = '5511900000000';
const DAY = 24 * 3600_000;

function randomMonday8am(): Date {
  let day = { year: 2060 + randomInt(0, 40), month: randomInt(1, 13), day: 1 };
  while (weekdayOf(day) !== 1) day = addDays(day, 1);
  return zonedToUtc(day, 8 * 60, SP);
}

const params = (m: SentMessage): string[] =>
  (m.template?.components?.find((c: { type: string }) => c.type === 'body')?.parameters ?? []).map(
    (p: { text: string }) => p.text,
  );
const payloads = (m: SentMessage): string[] =>
  (m.template?.components ?? [])
    .filter((c: { type: string }) => c.type === 'button')
    .map((c: { parameters: Array<{ payload: string }> }) => c.parameters[0]!.payload);
const bodyOf = (m: SentMessage | undefined): string => m?.text?.body ?? m?.interactive?.body?.text ?? '';

describe.skipIf(!url)('fila de mensagens e retenção (integração)', () => {
  let prisma: PrismaClient;
  let now: Date;
  const logs = captureLogs();

  beforeAll(async () => {
    prisma = createPrismaClient(url!);
    now = randomMonday8am();
    setLoggerForTesting(logs.logger);
    if ((await prisma.availabilityRule.count()) === 0) {
      await prisma.availabilityRule.createMany({ data: defaultScheduleRows() });
    }
  });
  afterAll(async () => {
    setLoggerForTesting(undefined);
    await prisma.$disconnect();
  });

  /** Cliente com consentimento e nome único (o nome identifica as mensagens deste teste). */
  async function client(at = now) {
    const phone = `55319${randomInt(10_000_000, 99_999_999)}`;
    const name = `Teste${randomBytes(3).toString('hex')} Sobrenome`;
    const consent = currentConsentText(POLICY);
    const c = await recordConsent(prisma, {
      phone,
      version: consent.version,
      body: consent.body,
      evidenceMessageId: 'wamid.SETUP',
      now: at,
    });
    await setClientName(prisma, c.id, name);
    return { id: c.id, phone, name };
  }

  /** Marca no k-ésimo horário livre com mais de 48 h de antecedência. */
  async function book(clientId: string, k: number, service: ServiceType = 'PHYSIOTHERAPY') {
    const free = (await findFreeSlots(prisma, service, bookingWindow(now), SP)).filter(
      (s) => s.startsAt.getTime() - now.getTime() > 2 * DAY,
    );
    return bookAppointment(prisma, { clientId, serviceType: service, startsAt: free[k]!.startsAt, now, timeZone: SP });
  }

  function outbox(options: Parameters<typeof recordingWhatsApp>[0] & { withReception?: boolean } = {}) {
    const recorder = recordingWhatsApp(options);
    const receptionPhone = options.withReception === false ? undefined : RECEPTION;
    const deps: OutboxDeps = { prisma, whatsapp: recorder.whatsapp, timeZone: SP, receptionPhone };
    /** Processa até não sobrar nada vencido em `at` (a fila pode ter itens de outros testes). */
    async function drain(at: Date) {
      while ((await processOutbox(deps, at)).claimed > 0);
    }
    return { ...recorder, deps, drain };
  }

  const queued = (appointmentId: string) =>
    prisma.outboundMessage.findMany({ where: { appointmentId }, orderBy: { kind: 'asc' } });

  it('aviso de novo agendamento: sai uma vez, para a recepção, com os dados certos', async () => {
    const rita = await client();
    const appt = await book(rita.id, 0);
    const box = outbox();

    await box.drain(now);
    await box.drain(now); // segunda passada não reenvia
    const mine = box.sent.filter((m) => JSON.stringify(m).includes(rita.name));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ to: RECEPTION, template: { name: 'aviso_agenda_recepcao' } });
    expect(params(mine[0]!)).toEqual([
      'novo agendamento',
      rita.name,
      'Fisioterapia',
      formatDateTime(appt.startsAt, SP),
    ]);

    const rows = await queued(appt.id);
    expect(rows.find((r) => r.kind === 'RECEPTION_NEW_BOOKING')).toMatchObject({ status: 'SENT', attempts: 1 });
    expect(rows.find((r) => r.kind === 'RECEPTION_NEW_BOOKING')!.waMessageId).toMatch(/^wamid\./);
    // O lembrete ainda não venceu.
    expect(rows.find((r) => r.kind === 'CLIENT_REMINDER')).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('lembrete: sai no horário, para o cliente, com os botões; "Confirmo" registra a presença', async () => {
    const sara = await client();
    const appt = await book(sara.id, 1);
    const box = outbox();
    const remindAt = reminderTime(appt.startsAt, SP);

    await box.drain(new Date(remindAt.getTime() - 60_000)); // um minuto antes: não sai
    expect(box.sent.filter((m) => m.to === sara.phone)).toHaveLength(0);

    await box.drain(remindAt);
    const [reminder] = box.sent.filter((m) => m.to === sara.phone);
    expect(reminder).toMatchObject({ template: { name: 'lembrete_atendimento', language: { code: 'pt_BR' } } });
    expect(params(reminder!)).toEqual([sara.name.split(' ')[0], 'fisioterapia', formatDateTime(appt.startsAt, SP)]);
    expect(payloads(reminder!)).toEqual([replyIds.remindOk(appt.id), replyIds.remindChange(appt.id)]);

    // A cliente toca em "Confirmo".
    const chat = recordingWhatsApp();
    const bot = createChatbot({ prisma, whatsapp: chat.whatsapp, timeZone: SP, privacyPolicyUrl: POLICY, now: () => remindAt });
    await bot.handle({
      id: `wamid.T_${randomBytes(6).toString('hex')}`,
      from: sara.phone,
      timestamp: remindAt,
      profileName: undefined,
      content: { type: 'reply', replyId: payloads(reminder!)[0]!, title: 'Confirmo' },
    });
    expect(bodyOf(chat.sent[0])).toMatch(/Obrigado por confirmar/);
    expect(
      await prisma.auditEvent.count({ where: { entityId: appt.id, action: 'appointment.attendance_confirmed' } }),
    ).toBe(1);
  });

  it('opção (A): "Preciso remarcar" com menos de 24 h cancela e avisa a recepção como em cima da hora', async () => {
    const tais = await client();
    const appt = await book(tais.id, 2);
    const box = outbox();
    await box.drain(now); // recepção recebe o "novo agendamento"

    const late = new Date(appt.startsAt.getTime() - 20 * 3600_000); // 20 h antes
    const chat = recordingWhatsApp();
    const bot = createChatbot({ prisma, whatsapp: chat.whatsapp, timeZone: SP, privacyPolicyUrl: POLICY, now: () => late });
    const tap = (replyId: string) =>
      bot.handle({
        id: `wamid.T_${randomBytes(6).toString('hex')}`,
        from: tais.phone,
        timestamp: late,
        profileName: undefined,
        content: { type: 'reply', replyId, title: '' },
      });

    await tap(replyIds.remindChange(appt.id));
    expect(bodyOf(chat.sent[0])).toMatch(/menos de 24 horas/);
    await tap(replyIds.reschedule(appt.id));
    expect(bodyOf(chat.sent[1])).toMatch(/cancelamos/);
    expect(chat.sent[2]?.interactive?.type).toBe('list'); // novos horários

    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe('CANCELLED');
    await box.drain(late);
    const notice = box.sent.filter((m) => m.to === RECEPTION && JSON.stringify(m).includes(tais.name)).at(-1)!;
    expect(params(notice)[0]).toBe('cancelamento com menos de 24 h');
  });

  it('falha temporária: novas tentativas com espera; na 5ª, desiste e registra o código', async () => {
    const uma = await client();
    const appt = await book(uma.id, 3);
    const box = outbox({ fail: (m) => (JSON.stringify(m).includes(uma.name) ? { status: 503, code: 131016 } : undefined) });

    let at = now;
    for (let attempt = 1; attempt <= OUTBOX.maxAttempts; attempt++) {
      await box.drain(at);
      const row = (await queued(appt.id)).find((r) => r.kind === 'RECEPTION_NEW_BOOKING')!;
      expect(row.attempts).toBe(attempt);
      expect(row.lastErrorCode).toBe('131016');
      if (attempt < OUTBOX.maxAttempts) {
        expect(row.status).toBe('PENDING');
        expect(row.sendAfter.getTime() - at.getTime()).toBe(OUTBOX.retryDelaysMs[attempt - 1]);
        at = row.sendAfter;
      } else {
        expect(row.status).toBe('FAILED');
      }
    }
  });

  it('falha definitiva (template inexistente): desiste na hora', async () => {
    const vera = await client();
    const appt = await book(vera.id, 4);
    const box = outbox({ fail: (m) => (JSON.stringify(m).includes(vera.name) ? { status: 404, code: 132001 } : undefined) });
    await box.drain(now);
    const row = (await queued(appt.id)).find((r) => r.kind === 'RECEPTION_NEW_BOOKING')!;
    expect(row).toMatchObject({ status: 'FAILED', attempts: 1, lastErrorCode: '132001' });
  });

  it('duas instâncias processando ao mesmo tempo não enviam em dobro', async () => {
    const wal = await client();
    await book(wal.id, 5);
    const [a, b] = [outbox(), outbox()];
    await Promise.all([a.drain(now), b.drain(now)]);
    const total = [...a.sent, ...b.sent].filter((m) => JSON.stringify(m).includes(wal.name));
    expect(total).toHaveLength(1);
  });

  it('sem número da recepção, o aviso espera na fila (sem gastar tentativas)', async () => {
    const xena = await client();
    const appt = await book(xena.id, 6);
    await outbox({ withReception: false }).drain(now);
    const row = (await queued(appt.id)).find((r) => r.kind === 'RECEPTION_NEW_BOOKING')!;
    expect(row).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('enviada mas o registro falhou: fica como SENT e NÃO é reenviada', async () => {
    const zeca = await client();
    const appt = await book(zeca.id, 9);
    // Outra linha já usa este wamid: gravar o envio com ele estoura o índice único.
    const taken = `wamid.JA_USADO_${randomBytes(6).toString('hex')}`;
    const other = await book((await client()).id, 10);
    await prisma.outboundMessage.updateMany({
      where: { appointmentId: other.id, kind: 'CLIENT_REMINDER' },
      data: { waMessageId: taken },
    });

    const first = outbox({ messageId: taken });
    await first.drain(now);
    const row = (await queued(appt.id)).find((r) => r.kind === 'RECEPTION_NEW_BOOKING')!;
    expect(row).toMatchObject({ status: 'SENT', lastErrorCode: 'RECORD', waMessageId: null });

    // Depois do prazo da reserva, nada volta a sair para este agendamento.
    const later = outbox();
    await later.drain(new Date(now.getTime() + OUTBOX.leaseMs + 60_000));
    expect(later.sent.filter((m) => JSON.stringify(m).includes(zeca.name))).toHaveLength(0);
  });

  it('lembrete de agendamento que deixou de valer não é enviado', async () => {
    const yara = await client();
    const appt = await book(yara.id, 7);
    // Cancelado por fora (ex.: direto no banco), deixando o lembrete pendente.
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: 'STAFF' },
    });
    const box = outbox();
    await box.drain(reminderTime(appt.startsAt, SP));
    expect(box.sent.filter((m) => m.to === yara.phone)).toHaveLength(0);
    expect((await queued(appt.id)).find((r) => r.kind === 'CLIENT_REMINDER')!.status).toBe('CANCELLED');
  });

  it('retenção: apaga o que perdeu a finalidade e anonimiza quem sumiu há mais de 1 ano', async () => {
    const oldId = `wamid.VELHA_${randomBytes(6).toString('hex')}`;
    const newId = `wamid.NOVA_${randomBytes(6).toString('hex')}`;
    await prisma.processedMessage.createMany({
      data: [
        { waMessageId: oldId, receivedAt: new Date(now.getTime() - 8 * DAY) },
        { waMessageId: newId, receivedAt: now },
      ],
    });
    const sumida = await client(new Date(now.getTime() - 400 * DAY));
    const ativa = await client(new Date(now.getTime() - 10 * DAY));
    const comHorario = await client(new Date(now.getTime() - 400 * DAY));
    await book(comHorario.id, 8);
    await prisma.conversation.create({
      data: {
        clientId: ativa.id,
        step: 'menu',
        lastInboundAt: new Date(now.getTime() - DAY),
        expiresAt: new Date(now.getTime() - 1),
      },
    });

    // A rotina anonimiza no máximo 100 por rodada: repete até não sobrar ninguém.
    while ((await runMaintenance(prisma, now)).clientsAnonymized > 0);

    expect(await prisma.processedMessage.findUnique({ where: { waMessageId: oldId } })).toBeNull();
    expect(await prisma.processedMessage.findUnique({ where: { waMessageId: newId } })).not.toBeNull();
    expect(await prisma.conversation.count({ where: { clientId: ativa.id } })).toBe(0);

    const after = async (id: string) => prisma.client.findUniqueOrThrow({ where: { id } });
    expect((await after(sumida.id)).anonymizedAt).not.toBeNull();
    expect((await after(sumida.id)).phoneHash).toBeNull();
    expect((await after(ativa.id)).anonymizedAt).toBeNull();
    expect((await after(comHorario.id)).anonymizedAt).toBeNull();
    expect(
      await prisma.auditEvent.findFirst({ where: { entityId: sumida.id, action: 'client.anonymized' } }),
    ).toMatchObject({ actor: 'SYSTEM' });
  });

  it('nada de nome ou telefone no log da fila', () => {
    const output = logs.lines.join('');
    expect(output).not.toMatch(/Teste[0-9a-f]{6}/);
    expect(output).not.toMatch(/55319\d{8}/);
    expect(output).not.toContain(RECEPTION);
  });
});
