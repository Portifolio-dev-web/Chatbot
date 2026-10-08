import { describe, expect, it } from 'vitest';
import { interpret, parseName, type Intent } from '../src/services/chatbot/intents.js';
import { decodeReplyId, replyIds } from '../src/services/chatbot/reply-ids.js';
import type { ConversationState } from '../src/services/conversation-state.js';

const text = (t: string, state: ConversationState | null = null): Intent =>
  interpret({ type: 'text', text: t }, state);
const tap = (id: string): Intent => interpret({ type: 'reply', replyId: id, title: 'x' }, null);

describe('ids de botão', () => {
  it('ida e volta de cada tipo de id', () => {
    const startsAt = new Date('2026-10-09T11:00:00Z');
    const uuid = '0199c0de-1234-7abc-8def-0123456789ab';
    expect(tap(replyIds.book('PHYSIOTHERAPY'))).toEqual({ kind: 'book', service: 'PHYSIOTHERAPY' });
    expect(tap(replyIds.slot('PERSONAL_TRAINING', startsAt))).toEqual({
      kind: 'slot',
      service: 'PERSONAL_TRAINING',
      startsAt,
    });
    expect(tap(replyIds.day('PHYSIOTHERAPY', '2026-10-09', 1))).toEqual({
      kind: 'day',
      service: 'PHYSIOTHERAPY',
      day: '2026-10-09',
      page: 1,
    });
    expect(tap(replyIds.consentYes('PHYSIOTHERAPY', '2026-10-08.ab12cd34'))).toEqual({
      kind: 'consent',
      service: 'PHYSIOTHERAPY',
      version: '2026-10-08.ab12cd34',
    });
    expect(tap(replyIds.cancelYes(uuid))).toEqual({ kind: 'cancel_yes', appointmentId: uuid });
  });

  it('ids adulterados ou desconhecidos são recusados', () => {
    for (const id of [
      'book:dentista',
      'slot:fisio:zzzzzzzzzzzz',
      'slot:fisio:1', // ano 1970
      'day:fisio:2026-02-30:0',
      "cancel:1' OR '1'='1",
      'cancel:0199c0de',
      'consent:fisio:<script>',
      'menu:extra',
      'deleteyes:agora',
      'faq:senhas',
      '',
    ]) {
      expect(decodeReplyId(id), id).toBeUndefined();
    }
    expect(tap('qualquer:coisa')).toEqual({ kind: 'unknown' });
  });
});

describe('texto livre', () => {
  it('saudações abrem o menu', () => {
    for (const t of ['Oi', 'olá!', 'Bom dia', 'boa noite, tudo bem?', 'MENU']) {
      expect(text(t), t).toEqual({ kind: 'menu', greeting: true });
    }
  });

  it('triagem: descrever a queixa sugere o serviço certo', () => {
    expect(text('Estou com dor no joelho')).toEqual({ kind: 'suggest', service: 'PHYSIOTHERAPY' });
    expect(text('quero hipertrofia')).toEqual({ kind: 'suggest', service: 'PERSONAL_TRAINING' });
  });

  it('pedido de horário vai direto para o agendamento', () => {
    expect(text('Quero marcar fisioterapia')).toEqual({ kind: 'book', service: 'PHYSIOTHERAPY' });
    expect(text('tem horário amanhã pro treino?')).toEqual({
      kind: 'book',
      service: 'PERSONAL_TRAINING',
    });
    expect(text('quero agendar')).toEqual({ kind: 'ask_service' });
  });

  it('dúvidas frequentes', () => {
    expect(text('Quanto custa?')).toEqual({ kind: 'faq', topic: 'prices' });
    expect(text('qual o endereço')).toEqual({ kind: 'faq', topic: 'location' });
    expect(text('que horas vocês abrem')).toEqual({ kind: 'faq', topic: 'hours' });
    expect(text('qual o horário de funcionamento?')).toEqual({ kind: 'faq', topic: 'hours' });
    expect(text('quero falar com uma pessoa')).toEqual({ kind: 'reception' });
  });

  it('agendamentos, privacidade e consentimento digitado', () => {
    expect(text('preciso cancelar')).toEqual({ kind: 'my_appointments' });
    expect(text('quero apagar meus dados')).toEqual({ kind: 'privacy' });
    expect(text('PARAR')).toEqual({ kind: 'privacy' });
    expect(text('concordo')).toEqual({ kind: 'consent_typed' });
  });

  it('número solto escolhe item do menu', () => {
    expect(text('3')).toEqual({ kind: 'faq', topic: 'prices' });
    expect(text('1')).toEqual({ kind: 'book', service: 'PHYSIOTHERAPY' });
    expect(text('99')).toEqual({ kind: 'unknown' });
  });

  it('com opções na tela, número, horário ou data digitados escolhem a opção', () => {
    const startsAt = new Date('2026-10-09T12:00:00Z');
    const state: ConversationState = {
      step: 'choosing_slot',
      options: [
        { id: replyIds.slot('PHYSIOTHERAPY', new Date('2026-10-09T11:00:00Z')), title: '1. 08:00' },
        { id: replyIds.slot('PHYSIOTHERAPY', startsAt), title: '2. 09:00' },
      ],
    };
    const expected = { kind: 'slot', service: 'PHYSIOTHERAPY', startsAt };
    for (const t of ['2', '9h', '09:00', '9:00', '9 h']) expect(text(t, state), t).toEqual(expected);

    const days: ConversationState = {
      step: 'choosing_day',
      options: [{ id: replyIds.day('PHYSIOTHERAPY', '2026-10-09'), title: '1. Sex, 09/10' }],
    };
    expect(text('09/10', days)).toMatchObject({ kind: 'day', day: '2026-10-09' });
  });

  it('esperando o nome: o texto vira nome, ou pede de novo', () => {
    const state: ConversationState = {
      step: 'awaiting_name',
      options: [],
      serviceType: 'PHYSIOTHERAPY',
      startsAt: '2026-10-09T11:00:00.000Z',
    };
    expect(text('  Maria   da Conceição ', state)).toEqual({ kind: 'name', name: 'Maria da Conceição' });
    expect(text("D'Ávila-Souza", state)).toEqual({ kind: 'name', name: "D'Ávila-Souza" });
    expect(text('11 98765-4321', state)).toEqual({ kind: 'invalid_name' });
    expect(text('menu', state)).toEqual({ kind: 'menu', greeting: false });
  });

  it('áudio, imagem etc.', () => {
    expect(interpret({ type: 'unsupported', originalType: 'audio' }, null)).toEqual({
      kind: 'unsupported',
    });
  });
});

describe('parseName', () => {
  it('recusa o que não parece nome', () => {
    for (const t of ['a', '123', 'ok!', '@maria', 'x'.repeat(81), '   ']) {
      expect(parseName(t), t).toBeUndefined();
    }
  });
});
