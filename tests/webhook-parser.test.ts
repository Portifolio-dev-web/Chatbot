import { describe, expect, it } from 'vitest';
import { parseWebhookPayload, type WebhookEvent } from '../src/services/webhook-parser.js';
import { PHONE, PROFILE_NAME, TEXT, contacts, textMessage, webhookPayload } from './fixtures.js';

const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!;

function parse(value: Record<string, unknown>, phoneNumberId?: string) {
  return parseWebhookPayload(webhookPayload(value, phoneNumberId), PHONE_ID);
}

function messages(events: WebhookEvent[]) {
  return events.flatMap((e) => (e.kind === 'message' ? [e.message] : []));
}

describe('parseWebhookPayload', () => {
  it('normaliza mensagem de texto com nome do perfil e data', () => {
    const ts = '1760000000';
    const result = parse({ contacts, messages: [textMessage({ timestamp: ts })] });
    expect(result.envelopeValid).toBe(true);
    expect(messages(result.events)).toEqual([
      {
        id: 'wamid.TEXTO1',
        from: PHONE,
        timestamp: new Date(Number(ts) * 1000),
        profileName: PROFILE_NAME,
        content: { type: 'text', text: TEXT },
      },
    ]);
  });

  it('botão, item de lista e botão de template viram "reply"', () => {
    const result = parse({
      messages: [
        textMessage({
          id: 'wamid.B',
          type: 'interactive',
          text: undefined,
          interactive: { type: 'button_reply', button_reply: { id: 'svc:physio', title: 'Fisio' } },
        }),
        textMessage({
          id: 'wamid.L',
          type: 'interactive',
          text: undefined,
          interactive: { type: 'list_reply', list_reply: { id: 'slot:1', title: 'Seg 08:00' } },
        }),
        textMessage({
          id: 'wamid.T',
          type: 'button',
          text: undefined,
          button: { payload: 'remind:confirm', text: 'Confirmar' },
        }),
      ],
    });
    expect(messages(result.events).map((m) => m.content)).toEqual([
      { type: 'reply', replyId: 'svc:physio', title: 'Fisio' },
      { type: 'reply', replyId: 'slot:1', title: 'Seg 08:00' },
      { type: 'reply', replyId: 'remind:confirm', title: 'Confirmar' },
    ]);
  });

  it('tipos que o bot não interpreta viram "unsupported" com o tipo original', () => {
    const result = parse({
      messages: [
        textMessage({ id: 'wamid.I', type: 'image', text: undefined, image: { id: 'MEDIA' } }),
        textMessage({
          id: 'wamid.F',
          type: 'interactive',
          text: undefined,
          interactive: { type: 'nfm_reply' },
        }),
      ],
    });
    expect(messages(result.events).map((m) => m.content)).toEqual([
      { type: 'unsupported', originalType: 'image' },
      { type: 'unsupported', originalType: 'interactive_nfm_reply' },
    ]);
  });

  it('uma mensagem fora do formato é descartada sem derrubar as outras', () => {
    const result = parse({
      messages: [
        textMessage({ id: 'wamid.RUIM', from: 'não é telefone' }),
        textMessage({ id: 'wamid.LONGA', text: { body: 'x'.repeat(4097) } }),
        textMessage({ id: 'wamid.BOA' }),
      ],
    });
    expect(messages(result.events).map((m) => m.id)).toEqual(['wamid.BOA']);
    expect(result.skipped).toBe(2);
  });

  it('ignora eventos de outro número do mesmo app', () => {
    const result = parse({ messages: [textMessage()] }, '999999999');
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('ignora campos que não são mensagens (ex.: status de template)', () => {
    const payload = webhookPayload({ messages: [textMessage()] }) as {
      entry: Array<{ changes: Array<{ field: string }> }>;
    };
    payload.entry[0]!.changes[0]!.field = 'message_template_status_update';
    expect(parseWebhookPayload(payload, PHONE_ID).events).toEqual([]);
  });

  it('envelope desconhecido é marcado como inválido', () => {
    expect(parseWebhookPayload({ object: 'page', entry: [] }, PHONE_ID).envelopeValid).toBe(false);
    expect(parseWebhookPayload('texto', PHONE_ID).envelopeValid).toBe(false);
  });

  it('lê avisos de entrega, com o código de erro quando falhou', () => {
    const result = parse({
      statuses: [
        { id: 'wamid.OUT1', status: 'failed', recipient_id: PHONE, errors: [{ code: 131047 }] },
        { id: 'wamid.OUT2', status: 'delivered', recipient_id: PHONE },
      ],
    });
    expect(result.events).toEqual([
      { kind: 'status', status: { messageId: 'wamid.OUT1', status: 'failed', errorCode: '131047' } },
      { kind: 'status', status: { messageId: 'wamid.OUT2', status: 'delivered', errorCode: undefined } },
    ]);
  });
});
