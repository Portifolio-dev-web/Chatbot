import { describe, expect, it } from 'vitest';
import { formatShortDateTime, zonedToUtc } from '../src/lib/time.js';
import { PROFILES } from '../src/profiles/index.js';
import { computeFreeSlots } from '../src/services/availability.js';
import { isCrisisMessage } from '../src/services/chatbot/crisis.js';
import { interpret } from '../src/services/chatbot/intents.js';
import { decodeReplyId, replyIds } from '../src/services/chatbot/reply-ids.js';
import { TEXTS, buildMenu } from '../src/services/chatbot/texts.js';
import type { ConversationState } from '../src/services/conversation-state.js';

const PSI = PROFILES.psicologia;
const SP = 'America/Sao_Paulo';

describe('detecção de crise', () => {
  it.each([
    'Não aguento mais, quero morrer',
    'às vezes penso em suicídio',
    'tô pensando em me matar',
    'quero acabar com tudo',
    'eu me corto quando fico nervosa',
    'NÃO QUERO MAIS VIVER!!!',
    'tomei todos os remédios',
    'meu marido me bate',
    'estou sendo agredida em casa',
    'sofri abuso sexual',
  ])('reconhece: %s', (text) => {
    expect(isCrisisMessage(text)).toBe(true);
  });

  it.each([
    'Quero marcar uma sessão',
    'quanto custa?',
    'estou com ansiedade',
    'boa tarde',
    'matar a saudade da família',
    'morreu meu cachorro, estou triste', // luto: triagem, não crise
  ])('não dispara à toa: %s', (text) => {
    expect(isCrisisMessage(text)).toBe(false);
  });

  it('tem prioridade sobre tudo, inclusive quando o bot espera um nome', () => {
    const awaiting: ConversationState = {
      step: 'awaiting_name',
      options: [],
      serviceType: 'PSYCHOTHERAPY',
      startsAt: '2026-10-09T12:00:00.000Z',
    };
    expect(interpret({ type: 'text', text: 'quero morrer' }, awaiting, PSI)).toEqual({ kind: 'crisis' });
    // E em qualquer perfil (fisioterapia também responde com os contatos de emergência).
    expect(interpret({ type: 'text', text: 'quero morrer' }, null, PROFILES.fisioterapia)).toEqual({
      kind: 'crisis',
    });
  });

  it('a resposta traz CVV, SAMU e 190, e nunca "não entendi"', () => {
    expect(TEXTS.crisisSupport).toMatch(/188/);
    expect(TEXTS.crisisSupport).toMatch(/192/);
    expect(TEXTS.crisisSupport).toMatch(/190/);
    expect(TEXTS.crisisSupport).not.toMatch(/não entendi/i);
  });
});

describe('perfil psicologia', () => {
  it('triagem por palavras do perfil e nome no estado do paciente', () => {
    expect(interpret({ type: 'text', text: 'procuro terapia para ansiedade' }, null, PSI)).toEqual({
      kind: 'suggest',
      service: 'PSYCHOTHERAPY',
    });
    const awaitingPatient: ConversationState = {
      step: 'awaiting_patient_name',
      options: [],
      serviceType: 'PSYCHOTHERAPY',
      startsAt: '2026-10-09T12:00:00.000Z',
      audience: 'minor',
    };
    expect(interpret({ type: 'text', text: 'Ana Clara' }, awaitingPatient, PSI)).toEqual({
      kind: 'name',
      name: 'Ana Clara',
    });
  });

  it('ids de "para quem é a sessão"', () => {
    expect(decodeReplyId(replyIds.who('PSYCHOTHERAPY', 'minor'))).toEqual({
      kind: 'who',
      service: 'PSYCHOTHERAPY',
      audience: 'minor',
    });
    expect(decodeReplyId('who:PSYCHOTHERAPY:todos')).toBeUndefined();
  });

  it('menu: atendimento online no lugar do endereço, e contato direto no lugar da recepção', () => {
    const titles = buildMenu(PSI).flatMap((s) => s.rows.map((r) => r.title));
    expect(titles).toEqual([
      '1. Psicologia clínica',
      '2. Valores e pacotes',
      '3. Atendimento online',
      '4. Horários',
      '5. Meus agendamentos',
      '6. Contato direto',
      '7. Privacidade e dados',
    ]);
  });

  it('boas-vindas avisam que não é canal de emergência e pedem para não contar detalhes', () => {
    const welcome = TEXTS.welcome(PSI);
    expect(welcome).toMatch(/não atende emergências/);
    expect(welcome).toMatch(/188/);
    expect(welcome).toMatch(/não conte aqui detalhes/);
    expect(TEXTS.unsupported(PSI)).toMatch(/188/); // áudio pode ser um pedido de ajuda
    expect(TEXTS.unsupported(PROFILES.fisioterapia)).not.toMatch(/188/);
  });

  it('sessão de 50 min começando de hora em hora', () => {
    const day = { year: 2026, month: 10, day: 9 };
    const slots = computeFreeSlots({
      rules: [{ weekday: 5, startMinute: 9 * 60, endMinute: 12 * 60, slotMinutes: 60, sessionMinutes: 50 }],
      busy: [],
      from: zonedToUtc(day, 0, SP),
      to: zonedToUtc(day, 23 * 60, SP),
      timeZone: SP,
    });
    expect(slots.map((s) => formatShortDateTime(s.startsAt, SP).slice(6))).toEqual(['09:00', '10:00', '11:00']);
    expect(slots.map((s) => (s.endsAt.getTime() - s.startsAt.getTime()) / 60_000)).toEqual([50, 50, 50]);
  });
});
