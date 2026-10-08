import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultScheduleRows } from '../src/content/default-schedule.js';
import { currentConsentText } from '../src/content/consent.js';
import type { PrismaClient, ServiceType } from '../src/generated/prisma/client.js';
import { phoneIndex } from '../src/lib/crypto.js';
import { setLoggerForTesting } from '../src/lib/logger.js';
import { createPrismaClient } from '../src/lib/prisma.js';
import { addDays, weekdayOf, zonedToUtc } from '../src/lib/time.js';
import { bookingWindow, findFreeSlots } from '../src/services/availability.js';
import { createChatbot } from '../src/services/chatbot/chatbot.js';
import { replyIds } from '../src/services/chatbot/reply-ids.js';
import { findClientByPhone, recordConsent, setClientName } from '../src/services/clients.js';
import type { MessageContent } from '../src/services/webhook-parser.js';
import { captureLogs, recordingWhatsApp, type SentMessage } from './fixtures.js';

/*
 * O funil inteiro contra um PostgreSQL de verdade (TEST_DATABASE_URL, banco DESCARTÁVEL).
 * O "agora" é uma segunda-feira 08:00 num ano sorteado entre 2060 e 2099: cada execução usa
 * uma agenda vazia, sem esbarrar em dados de execuções anteriores.
 */
const url = process.env.TEST_DATABASE_URL;
const SP = 'America/Sao_Paulo';
const POLICY = 'https://exemplo.com/privacidade';

function randomMonday8am(): Date {
  let day = { year: 2060 + randomInt(0, 40), month: randomInt(1, 13), day: 1 };
  while (weekdayOf(day) !== 1) day = addDays(day, 1);
  return zonedToUtc(day, 8 * 60, SP);
}

const randomPhone = (): string => `55219${randomInt(10_000_000, 99_999_999)}`;

const bodyOf = (m: SentMessage | undefined): string =>
  m?.text?.body ?? m?.interactive?.body?.text ?? '';
const buttonsOf = (m: SentMessage | undefined): Array<{ id: string; title: string }> =>
  (m?.interactive?.action?.buttons ?? []).map((b: { reply: { id: string; title: string } }) => b.reply);
const rowsOf = (m: SentMessage | undefined): Array<{ id: string; title: string }> =>
  (m?.interactive?.action?.sections ?? []).flatMap((s: { rows: unknown[] }) => s.rows);

describe.skipIf(!url)('atendimento completo (integração)', () => {
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

  /** Uma pessoa conversando com o bot. Devolve as mensagens que o bot mandou a cada ação. */
  function person(phone = randomPhone()) {
    const { whatsapp, sent } = recordingWhatsApp();
    const bot = createChatbot({ prisma, whatsapp, timeZone: SP, privacyPolicyUrl: POLICY, now: () => now });
    let seen = 0;
    let lastMessageId = '';
    async function send(content: MessageContent): Promise<SentMessage[]> {
      lastMessageId = `wamid.TESTE_${randomBytes(8).toString('hex')}`;
      await bot.handle({ id: lastMessageId, from: phone, timestamp: now, profileName: 'Perfil', content });
      const fresh = sent.slice(seen);
      seen = sent.length;
      return fresh;
    }
    return {
      phone,
      bot,
      lastMessageId: () => lastMessageId,
      say: (text: string) => send({ type: 'text', text }),
      tap: (replyId: string) => send({ type: 'reply', replyId, title: '' }),
    };
  }

  /** Cliente já com consentimento e nome (atalho para testes que não são do funil). */
  async function readyClient(name = 'Cliente Pronto') {
    const p = person();
    const consent = currentConsentText(POLICY);
    const client = await recordConsent(prisma, {
      phone: p.phone,
      version: consent.version,
      body: consent.body,
      evidenceMessageId: 'wamid.SETUP',
      now,
    });
    await setClientName(prisma, client.id, name);
    return { ...p, clientId: client.id };
  }

  async function freeSlots(service: ServiceType = 'PHYSIOTHERAPY') {
    return findFreeSlots(prisma, service, bookingWindow(now), SP);
  }

  it('funil completo: oi -> serviço -> consentimento -> dia -> horário (digitado) -> nome -> confirmar', async () => {
    const maria = person();

    const [menu] = await maria.say('Oi');
    expect(rowsOf(menu).map((r) => r.title)).toContain('1. Fisioterapia');

    const [consentPrompt] = await maria.tap(rowsOf(menu)[0]!.id);
    expect(bodyOf(consentPrompt)).toContain(POLICY);
    expect(buttonsOf(consentPrompt).map((b) => b.title)).toEqual(['Concordo', 'Não concordo']);
    expect(await findClientByPhone(prisma, maria.phone)).toBeNull(); // nada gravado ainda

    const [days] = await maria.tap(buttonsOf(consentPrompt)[0]!.id);
    const evidence = maria.lastMessageId();
    const client = await findClientByPhone(prisma, maria.phone);
    expect(client).not.toBeNull();
    const consent = await prisma.consent.findFirstOrThrow({ where: { clientId: client!.id } });
    expect(consent).toMatchObject({
      textVersion: currentConsentText(POLICY).version,
      evidenceMessageId: evidence,
      revokedAt: null,
    });
    expect(rowsOf(days).length).toBeGreaterThan(0);

    const [slots] = await maria.tap(rowsOf(days)[0]!.id);
    const firstSlot = rowsOf(slots)[0]!;
    expect(firstSlot.title).toMatch(/^1\. \d{2}:\d{2}$/);

    // Digitar o número em vez de tocar também funciona.
    const [askName] = await maria.say('1');
    expect(bodyOf(askName)).toMatch(/nome completo/);

    const [confirm] = await maria.say('Maria Teste da Silva');
    expect(bodyOf(confirm)).toContain('Maria Teste da Silva');
    expect(buttonsOf(confirm)[0]!.title).toBe('Confirmar');

    const [booked] = await maria.tap(buttonsOf(confirm)[0]!.id);
    expect(bodyOf(booked)).toMatch(/Agendado/);

    const appointment = await prisma.appointment.findFirstOrThrow({ where: { clientId: client!.id } });
    expect(appointment.status).toBe('CONFIRMED');
    expect(replyIds.slot('PHYSIOTHERAPY', appointment.startsAt)).toBe(firstSlot.id);
    const queued = await prisma.outboundMessage.findMany({ where: { appointmentId: appointment.id } });
    expect(queued.map((q) => q.kind)).toContain('RECEPTION_NEW_BOOKING');

    // O nome no banco está cifrado.
    const [row] = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM clients WHERE id = ${client!.id}::uuid`;
    expect(JSON.stringify(row)).not.toContain('Maria');

    // E nada disso apareceu no log.
    const output = logs.lines.join('');
    for (const secret of ['Maria', maria.phone, maria.phone.slice(-8)]) {
      expect(output).not.toContain(secret);
    }
  });

  it('duas pessoas confirmam o mesmo horário ao mesmo tempo: só uma leva', async () => {
    const [ana, bia] = [await readyClient('Ana'), await readyClient('Bia')];
    const slot = (await freeSlots()).at(-1)!;
    const confirm = replyIds.confirm('PHYSIOTHERAPY', slot.startsAt);

    const [ra, rb] = await Promise.all([ana.tap(confirm), bia.tap(confirm)]);
    const texts = [bodyOf(ra[0]), bodyOf(rb[0])];
    expect(texts.filter((t) => /Agendado/.test(t))).toHaveLength(1);
    expect(texts.filter((t) => /acabou de ser reservado/.test(t))).toHaveLength(1);

    const taken = await prisma.appointment.count({
      where: { serviceType: 'PHYSIOTHERAPY', startsAt: slot.startsAt, status: 'CONFIRMED' },
    });
    expect(taken).toBe(1);
  });

  it('meus agendamentos -> cancelar; a recepção só é avisada do que chegou a saber', async () => {
    const carla = await readyClient('Carla');
    const later = (await freeSlots()).filter((s) => s.startsAt.getTime() - now.getTime() > 48 * 3600_000);
    const [s1, s2] = [later[0]!, later[1]!];
    await carla.tap(replyIds.confirm('PHYSIOTHERAPY', s1.startsAt));
    await carla.tap(replyIds.confirm('PHYSIOTHERAPY', s2.startsAt));
    const [a1, a2] = await prisma.appointment.findMany({
      where: { clientId: carla.clientId },
      orderBy: { startsAt: 'asc' },
    });
    // O aviso do 1º já foi entregue à recepção; o do 2º ainda está na fila.
    await prisma.outboundMessage.updateMany({
      where: { appointmentId: a1!.id, kind: 'RECEPTION_NEW_BOOKING' },
      data: { status: 'SENT', sentAt: now },
    });

    const [list] = await carla.say('meus agendamentos');
    expect(buttonsOf(list).map((b) => b.title)).toHaveLength(2);
    expect(buttonsOf(list)[0]!.title).toMatch(/^Cancelar \d{2}\/\d{2} \d{2}:\d{2}$/);

    for (const appointment of [a1!, a2!]) {
      const [ask] = await carla.tap(replyIds.cancelAsk(appointment.id));
      expect(buttonsOf(ask)[0]!.title).toBe('Sim, cancelar');
      const [done] = await carla.tap(buttonsOf(ask)[0]!.id);
      expect(bodyOf(done)).toMatch(/cancelamos/);
    }

    const outbound = await prisma.outboundMessage.findMany({
      where: { appointmentId: { in: [a1!.id, a2!.id] } },
    });
    const of = (id: string) => outbound.filter((o) => o.appointmentId === id).map((o) => `${o.kind}:${o.status}`).sort();
    expect(of(a1!.id)).toEqual(
      ['CLIENT_REMINDER:CANCELLED', 'RECEPTION_CANCELLATION:PENDING', 'RECEPTION_NEW_BOOKING:SENT'].sort(),
    );
    expect(of(a2!.id)).toEqual(['CLIENT_REMINDER:CANCELLED', 'RECEPTION_NEW_BOOKING:CANCELLED'].sort());
    const statuses = await prisma.appointment.findMany({ where: { clientId: carla.clientId } });
    expect(statuses.every((a) => a.status === 'CANCELLED' && a.cancelledBy === 'CLIENT')).toBe(true);
  });

  it('com menos de 24 h, o cancelamento é encaminhado à recepção', async () => {
    const davi = await readyClient('Davi');
    const soon = (await freeSlots()).find((s) => s.startsAt.getTime() - now.getTime() < 24 * 3600_000)!;
    await davi.tap(replyIds.confirm('PHYSIOTHERAPY', soon.startsAt));
    const appt = await prisma.appointment.findFirstOrThrow({ where: { clientId: davi.clientId } });

    const [reply] = await davi.tap(replyIds.cancelYes(appt.id));
    expect(bodyOf(reply)).toMatch(/menos de 24 horas/);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe('CONFIRMED');
  });

  it('ninguém cancela o agendamento de outra pessoa (nem com o id certo)', async () => {
    const [dona, intrusa] = [await readyClient('Dona'), await readyClient('Intrusa')];
    const slot = (await freeSlots()).filter((s) => s.startsAt.getTime() - now.getTime() > 48 * 3600_000)[3]!;
    await dona.tap(replyIds.confirm('PHYSIOTHERAPY', slot.startsAt));
    const appt = await prisma.appointment.findFirstOrThrow({ where: { clientId: dona.clientId } });

    for (const id of [replyIds.cancelAsk(appt.id), replyIds.cancelYes(appt.id)]) {
      const [reply] = await intrusa.tap(id);
      expect(bodyOf(reply)).toMatch(/Não encontrei esse agendamento/);
    }
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe('CONFIRMED');
  });

  it('limite de agendamentos futuros por pessoa', async () => {
    const eva = await readyClient('Eva');
    const slots = (await freeSlots('PERSONAL_TRAINING')).slice(0, 4);
    for (const s of slots.slice(0, 3)) await eva.tap(replyIds.confirm('PERSONAL_TRAINING', s.startsAt));
    const [reply] = await eva.tap(replyIds.confirm('PERSONAL_TRAINING', slots[3]!.startsAt));
    expect(bodyOf(reply)).toMatch(/máximo/);
    expect(await prisma.appointment.count({ where: { clientId: eva.clientId } })).toBe(3);
  });

  it('horário forjado (fora da grade) é recusado e a pessoa recebe as datas reais', async () => {
    const fabio = await readyClient('Fábio');
    const threeAm = new Date(now.getTime() + 19 * 3600_000); // 03:00 de terça
    const replies = await fabio.tap(replyIds.confirm('PHYSIOTHERAPY', threeAm));
    expect(bodyOf(replies[0])).toMatch(/acabou de ser reservado|não está mais disponível/);
    expect(rowsOf(replies[1]).length).toBeGreaterThan(0);
    expect(await prisma.appointment.count({ where: { clientId: fabio.clientId } })).toBe(0);
  });

  it('consentimento: só vale o toque no botão da versão atual', async () => {
    const gil = person();
    await gil.say('concordo');
    await gil.tap(replyIds.consentYes('PHYSIOTHERAPY', '2020-01-01.deadbeef'));
    expect(await findClientByPhone(prisma, gil.phone)).toBeNull();
  });

  it('apagar meus dados: cancela o futuro, apaga a identificação, e "1" digitado não apaga', async () => {
    const helena = await readyClient('Helena');
    const slot = (await freeSlots('PERSONAL_TRAINING')).at(-1)!;
    await helena.tap(replyIds.confirm('PERSONAL_TRAINING', slot.startsAt));

    const [privacy] = await helena.say('privacidade');
    expect(buttonsOf(privacy).map((b) => b.title)).toContain('Apagar meus dados');
    const [confirm] = await helena.tap(replyIds.deleteAsk);
    expect(bodyOf(confirm)).toMatch(/não pode ser desfeito/);

    await helena.say('1'); // não pode valer como "Sim, apagar"
    expect(await findClientByPhone(prisma, helena.phone)).not.toBeNull();

    const [done] = await helena.tap(replyIds.deleteYes);
    expect(bodyOf(done)).toMatch(/dados foram apagados e 1 agendamento futuro foi cancelado/);

    const client = await prisma.client.findUniqueOrThrow({ where: { id: helena.clientId } });
    expect(client).toMatchObject({ phoneHash: null, phoneEncrypted: null, nameEncrypted: null });
    expect(client.anonymizedAt).not.toBeNull();
    expect(await prisma.consent.count({ where: { clientId: helena.clientId, revokedAt: null } })).toBe(0);
    expect(await prisma.conversation.count({ where: { clientId: helena.clientId } })).toBe(0);
    const appt = await prisma.appointment.findFirstOrThrow({ where: { clientId: helena.clientId } });
    expect(appt.status).toBe('CANCELLED');

    // Depois disso, o número é de um desconhecido de novo.
    await helena.say('oi');
    expect(await prisma.client.count({ where: { phoneHash: phoneIndex(helena.phone) } })).toBe(0);
  });

  it('quem não é cliente consulta sem deixar rastro', async () => {
    const ivo = person();
    expect(bodyOf((await ivo.tap(replyIds.myAppointments))[0])).toMatch(/Não encontrei agendamentos/);
    expect(bodyOf((await ivo.tap(replyIds.deleteYes))[0])).toMatch(/Não temos nenhum dado/);
    expect(bodyOf((await ivo.say('quanto custa?'))[0])).toMatch(/Valores/);
    expect(await findClientByPhone(prisma, ivo.phone)).toBeNull();
  });
});
