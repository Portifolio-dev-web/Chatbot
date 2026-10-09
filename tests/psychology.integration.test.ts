import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { phoneIndex } from '../src/lib/crypto.js';
import { setLoggerForTesting } from '../src/lib/logger.js';
import { createPrismaClient } from '../src/lib/prisma.js';
import { addDays, weekdayOf, zonedToUtc } from '../src/lib/time.js';
import { PROFILES, type Profile } from '../src/profiles/index.js';
import { reminderTime } from '../src/services/booking.js';
import { createChatbot } from '../src/services/chatbot/chatbot.js';
import { replyIds } from '../src/services/chatbot/reply-ids.js';
import { anonymizeClient, decryptPatientName, findClientByPhone } from '../src/services/clients.js';
import { processOutbox } from '../src/services/outbox.js';
import type { MessageContent } from '../src/services/webhook-parser.js';
import { captureLogs, ensureDefaultSchedule, recordingWhatsApp, type SentMessage } from './fixtures.js';

/*
 * Perfil de psicologia (online, menores com responsável, alerta de crise, lembrete discreto)
 * contra um PostgreSQL de verdade (TEST_DATABASE_URL, banco DESCARTÁVEL).
 */
const url = process.env.TEST_DATABASE_URL;
const SP = 'America/Sao_Paulo';
const POLICY = 'https://exemplo.com/privacidade';
const PSI = PROFILES.psicologia;
const ALERT_PHONE = '5511900000001';

function randomMonday8am(): Date {
  let day = { year: 2060 + randomInt(0, 40), month: randomInt(1, 13), day: 1 };
  while (weekdayOf(day) !== 1) day = addDays(day, 1);
  return zonedToUtc(day, 8 * 60, SP);
}

const randomPhone = (): string => `55419${randomInt(10_000_000, 99_999_999)}`;
const bodyOf = (m: SentMessage | undefined): string =>
  m?.text?.body ?? m?.interactive?.body?.text ?? '';
const buttonsOf = (m: SentMessage | undefined): Array<{ id: string; title: string }> =>
  (m?.interactive?.action?.buttons ?? []).map((b: { reply: { id: string; title: string } }) => b.reply);
const rowsOf = (m: SentMessage | undefined): Array<{ id: string; title: string; description?: string }> =>
  (m?.interactive?.action?.sections ?? []).flatMap((s: { rows: unknown[] }) => s.rows);
const params = (m: SentMessage): string[] =>
  (m.template?.components?.find((c: { type: string }) => c.type === 'body')?.parameters ?? []).map(
    (p: { text: string }) => p.text,
  );

describe.skipIf(!url)('perfil psicologia (integração)', () => {
  let prisma: PrismaClient;
  let now: Date;
  const logs = captureLogs();

  beforeAll(async () => {
    prisma = createPrismaClient(url!);
    now = randomMonday8am();
    setLoggerForTesting(logs.logger);
    await ensureDefaultSchedule(prisma, PSI);
  });
  afterAll(async () => {
    setLoggerForTesting(undefined);
    await prisma.$disconnect();
  });

  function person(profile: Profile = PSI, phone = randomPhone()) {
    const { whatsapp, sent } = recordingWhatsApp();
    const bot = createChatbot({
      prisma,
      whatsapp,
      timeZone: SP,
      privacyPolicyUrl: POLICY,
      profile,
      alertPhone: ALERT_PHONE,
      now: () => now,
    });
    let seen = 0;
    async function send(content: MessageContent): Promise<SentMessage[]> {
      await bot.handle({
        id: `wamid.PSI_${randomBytes(8).toString('hex')}`,
        from: phone,
        timestamp: now,
        profileName: 'Perfil',
        content,
      });
      const fresh = sent.slice(seen);
      seen = sent.length;
      return fresh;
    }
    return {
      phone,
      sent,
      say: (text: string) => send({ type: 'text', text }),
      tap: (replyId: string) => send({ type: 'reply', replyId, title: '' }),
    };
  }

  /**
   * Funil até a lista de horários do k-ésimo dia livre. O aviso de consentimento só aparece
   * para quem ainda não consentiu (com aquele público).
   */
  async function toSlots(p: ReturnType<typeof person>, who: 'self' | 'minor', dayIndex: number) {
    const [whoPrompt] = await p.say('quero agendar');
    expect(buttonsOf(whoPrompt).map((b) => b.title)).toEqual([
      'Para mim',
      'Para menor de 18',
      'Para outro adulto',
    ]);
    let [next] = await p.tap(replyIds.who('PSYCHOTHERAPY', who));
    let consent: SentMessage | undefined;
    if (buttonsOf(next)[0]?.title === 'Concordo') {
      consent = next;
      [next] = await p.tap(buttonsOf(consent)[0]!.id);
    }
    const [slots] = await p.tap(rowsOf(next)[dayIndex]!.id);
    return { consent, slots };
  }

  it('adulto: online, sessão de 50 min, e só a primeira sessão pelo bot', async () => {
    const lia = person();
    const [menu] = await lia.say('oi');
    expect(rowsOf(menu).map((r) => r.title)).toContain('3. Atendimento online');
    expect(bodyOf(menu)).toMatch(/não atende emergências/);

    const { consent, slots } = await toSlots(lia, 'self', 1);
    expect(bodyOf(consent)).toMatch(/seus dados/);
    expect(rowsOf(slots)[0]!.description).toMatch(/^até \d{2}:50$/);

    const [askName] = await lia.say('1');
    expect(bodyOf(askName)).toMatch(/seu \*nome completo\*/);
    const [confirm] = await lia.say('Lia Fictícia');
    expect(bodyOf(confirm)).toMatch(/online, por videochamada/);
    expect(bodyOf(confirm)).toMatch(/\(50 min\)/);
    expect(bodyOf(confirm)).not.toMatch(/Local:/);
    const [booked] = await lia.tap(buttonsOf(confirm)[0]!.id);
    expect(bodyOf(booked)).toMatch(/Sessão online/);

    const client = await findClientByPhone(prisma, lia.phone);
    const appt = await prisma.appointment.findFirstOrThrow({ where: { clientId: client!.id } });
    expect((appt.endsAt.getTime() - appt.startsAt.getTime()) / 60_000).toBe(50);
    expect(appt.patientIsMinor).toBe(false);

    // Segunda sessão pelo bot: não (as seguintes são combinadas direto com a profissional).
    const { consent: again, slots: more } = await toSlots(lia, 'self', 2);
    expect(again).toBeUndefined(); // já consentiu: não pergunta de novo
    const [confirm2] = await lia.tap(rowsOf(more)[0]!.id);
    const [tooMany] = await lia.tap(buttonsOf(confirm2)[0]!.id);
    expect(bodyOf(tooMany)).toMatch(/1 agendamento marcado/);
    expect(await prisma.appointment.count({ where: { clientId: client!.id } })).toBe(1);
  });

  it('menor: consentimento do responsável, nome do paciente cifrado, aviso e lembrete', async () => {
    const maria = person();
    const { consent, slots } = await toSlots(maria, 'minor', 2);
    expect(bodyOf(consent)).toMatch(/pai, mãe ou responsável legal/);
    const client = await findClientByPhone(prisma, maria.phone);
    const consentRow = await prisma.consent.findFirstOrThrow({ where: { clientId: client!.id } });
    const consentText = await prisma.consentText.findUniqueOrThrow({ where: { version: consentRow.textVersion } });
    expect(consentText.body).toMatch(/art\. 14/); // a prova aponta para o texto do responsável

    const [askGuardian] = await maria.tap(rowsOf(slots)[0]!.id);
    expect(bodyOf(askGuardian)).toMatch(/como responsável/);
    const [askPatient] = await maria.say('Maria Responsável');
    expect(bodyOf(askPatient)).toMatch(/criança ou do adolescente/);

    // No meio do funil, o nome do menor no estado da conversa está cifrado.
    const [confirm] = await maria.say('Ana Clara Paciente');
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { clientId: client!.id } });
    expect(JSON.stringify(conversation.context)).not.toContain('Ana');
    expect(bodyOf(confirm)).toMatch(/Paciente:\* Ana Clara Paciente \(menor de idade\)/);
    expect(bodyOf(confirm)).toMatch(/Responsável:\* Maria Responsável/);

    await maria.tap(buttonsOf(confirm)[0]!.id);
    const appt = await prisma.appointment.findFirstOrThrow({ where: { clientId: client!.id } });
    expect(appt.patientIsMinor).toBe(true);
    expect(appt.patientNameEncrypted).not.toContain('Ana');
    expect(decryptPatientName(appt)).toBe('Ana Clara Paciente');
    // Depois de agendar, o estado da conversa não guarda mais o nome do menor (nem cifrado).
    const stateAfter = await prisma.conversation.findUnique({ where: { clientId: client!.id } });
    expect(stateAfter?.context).not.toHaveProperty('patientNameEncrypted');
    expect(stateAfter?.context).not.toHaveProperty('audience');

    const [list] = await maria.say('meus agendamentos');
    expect(bodyOf(list)).toContain('Psicologia clínica (Ana)');

    // Fila: aviso à profissional com paciente e responsável; lembrete discreto ao responsável.
    const { whatsapp, sent } = recordingWhatsApp();
    const deps = { prisma, whatsapp, timeZone: SP, receptionPhone: ALERT_PHONE, profile: PSI };
    const drain = async (at: Date) => {
      while ((await processOutbox(deps, at)).claimed > 0);
    };
    await drain(now);
    const notice = sent.find((m) => m.to === ALERT_PHONE && JSON.stringify(m).includes('Ana Clara'))!;
    expect(params(notice)[1]).toBe('Ana Clara Paciente (menor; resp. Maria Responsável)');
    await drain(reminderTime(appt.startsAt, SP));
    const reminder = sent.find((m) => m.to === maria.phone)!;
    expect(params(reminder)[1]).toBe('atendimento'); // nada de "psicologia" na tela bloqueada
    expect(JSON.stringify(reminder)).not.toMatch(/psicolog/i);

    // Apagar os dados do responsável apaga também o nome do menor.
    await anonymizeClient(prisma, client!.id, now);
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.patientNameEncrypted).toBeNull();
  });

  it('para outro adulto: orienta e não grava nada', async () => {
    const zeca = person();
    await zeca.say('quero agendar');
    const [reply] = await zeca.tap(replyIds.who('PSYCHOTHERAPY', 'other'));
    expect(bodyOf(reply)).toMatch(/pela própria pessoa/);
    expect(await findClientByPhone(prisma, zeca.phone)).toBeNull();
  });

  it('crise: contatos de emergência, um alerta à profissional (sem o texto) e nada de "não entendi"', async () => {
    const pessoa = person();
    const first = await pessoa.say('não aguento mais, quero morrer');
    const toPerson = first.filter((m) => m.to === pessoa.phone);
    const alerts = first.filter((m) => m.to === ALERT_PHONE);
    expect(bodyOf(toPerson[0])).toMatch(/CVV: 188/);
    expect(bodyOf(toPerson[0])).not.toMatch(/não entendi/);
    expect(bodyOf(toPerson[1])).toMatch(/avisei a profissional/);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.template.name).toBe('alerta_risco');
    expect(params(alerts[0]!)[0]).toBe(`+${pessoa.phone}`);
    expect(JSON.stringify(alerts[0])).not.toContain('morrer'); // o texto não sai daqui

    // Logo depois, outra mensagem de risco: a pessoa é acolhida de novo; o alerta não repete.
    const second = await pessoa.say('quero acabar com tudo');
    expect(second.filter((m) => m.to === ALERT_PHONE)).toHaveLength(0);
    expect(bodyOf(second[0])).toMatch(/CVV: 188/);

    // Auditoria sem conteúdo, e nenhum cadastro criado (a pessoa não consentiu).
    const events = await prisma.auditEvent.findMany({
      where: { action: 'crisis.detected', entityId: phoneIndex(pessoa.phone) },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ entityType: 'contact', detail: { alerted: true } });
    expect(await findClientByPhone(prisma, pessoa.phone)).toBeNull();
  });

  it('crise tem prioridade mesmo quando o bot espera o nome; depois o funil continua', async () => {
    const rui = person();
    const { slots } = await toSlots(rui, 'self', 3);
    await rui.tap(rowsOf(slots)[0]!.id); // pede o nome
    const [support] = await rui.say('quero me matar');
    expect(bodyOf(support)).toMatch(/CVV: 188/);
    const [confirm] = await rui.say('Rui Fictício');
    expect(bodyOf(confirm)).toMatch(/Confira seu agendamento/);
  });

  it('fisioterapia: acolhe a crise também, mas não alerta ninguém', async () => {
    const fisio = person(PROFILES.fisioterapia);
    const replies = await fisio.say('quero morrer');
    expect(bodyOf(replies[0])).toMatch(/CVV: 188/);
    expect(replies.filter((m) => m.to === ALERT_PHONE)).toHaveLength(0);
  });

  it('botão de "para quem é" num perfil sem menores cai no menu', async () => {
    await ensureDefaultSchedule(prisma, PROFILES.fisioterapia);
    const fisio = person(PROFILES.fisioterapia);
    const [reply] = await fisio.tap(replyIds.who('PHYSIOTHERAPY', 'minor'));
    expect(bodyOf(reply)).toMatch(/não entendi/);
  });

  it('nada de nome, telefone ou texto da conversa no log', () => {
    const output = logs.lines.join('');
    for (const secret of ['Ana Clara', 'Maria Responsável', 'Lia Fictícia', 'quero morrer', 'acabar com tudo']) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toMatch(/55419\d{8}/);
  });
});
