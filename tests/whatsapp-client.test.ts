import { inspect } from 'node:util';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { safeError } from '../src/lib/logger.js';
import { WhatsAppApiError, createWhatsAppClient } from '../src/services/whatsapp-client.js';
import { PHONE, TEXT } from './fixtures.js';

const TOKEN = 'EAAG-token-ficticio-de-teste-0000000000';

/** Camada de rede falsa: grava cada requisição e devolve uma resposta pronta. */
function setup(respond?: (config: InternalAxiosRequestConfig) => never) {
  const calls: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (config) => {
    calls.push(config);
    if (respond) respond(config);
    return {
      data: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.ENVIADA' }] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
  const client = createWhatsAppClient({
    accessToken: TOKEN,
    phoneNumberId: '123456789012345',
    apiVersion: 'v25.0',
    adapter,
  });
  const body = (i = 0) => JSON.parse(calls[i]!.data as string) as Record<string, unknown>;
  return { client, calls, body };
}

describe('cliente da WhatsApp Cloud API', () => {
  it('envia texto para a URL certa, com o token no cabeçalho', async () => {
    const { client, calls, body } = setup();
    const result = await client.sendText('+55 (11) 98765-4321', TEXT);
    expect(result.messageId).toBe('wamid.ENVIADA');
    expect(calls[0]!.baseURL).toBe('https://graph.facebook.com/v25.0/123456789012345');
    expect(calls[0]!.url).toBe('/messages');
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.maxRedirects).toBe(0);
    expect(body()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: PHONE,
      type: 'text',
      text: { body: TEXT, preview_url: false },
    });
  });

  it('monta botões, lista e template no formato da Meta', async () => {
    const { client, body } = setup();
    await client.sendButtons(PHONE, 'Qual serviço?', [
      { id: 'svc:physio', title: 'Fisioterapia' },
      { id: 'svc:personal', title: 'Personal trainer' },
    ]);
    expect(body(0)).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'button',
        action: { buttons: [{ type: 'reply', reply: { id: 'svc:physio', title: 'Fisioterapia' } }, {}] },
      },
    });

    await client.sendList(PHONE, 'Escolha o horário', 'Ver horários', [
      { title: 'Segunda', rows: [{ id: 'slot:1', title: '08:00', description: '60 min' }] },
    ]);
    expect(body(1)).toMatchObject({
      interactive: {
        type: 'list',
        action: { button: 'Ver horários', sections: [{ title: 'Segunda', rows: [{ id: 'slot:1' }] }] },
      },
    });

    await client.sendTemplate(PHONE, {
      name: 'lembrete_consulta',
      language: 'pt_BR',
      bodyParams: ['Maria\nda Silva', 'amanhã às 08:00'],
      quickReplyPayloads: ['remind:confirm'],
    });
    expect(body(2)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: PHONE,
      type: 'template',
      template: {
        name: 'lembrete_consulta',
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            // Quebra de linha vira espaço (a Meta recusa parâmetro com \n).
            parameters: [
              { type: 'text', text: 'Maria da Silva' },
              { type: 'text', text: 'amanhã às 08:00' },
            ],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '0',
            parameters: [{ type: 'payload', payload: 'remind:confirm' }],
          },
        ],
      },
    });
  });

  it('marca como lida', async () => {
    const { client, body } = setup();
    await client.markAsRead('wamid.RECEBIDA');
    expect(body()).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.RECEBIDA',
    });
  });

  it('confere os limites do WhatsApp antes de enviar', async () => {
    const { client, calls } = setup();
    const b = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, title: `Opção ${i}` }));
    await expect(client.sendButtons(PHONE, 'x', b(4))).rejects.toThrow(RangeError);
    await expect(
      client.sendButtons(PHONE, 'x', [{ id: 'a', title: 'Um título comprido demais' }]),
    ).rejects.toThrow(/20 caracteres/);
    await expect(
      client.sendButtons(PHONE, 'x', [
        { id: 'a', title: 'Um' },
        { id: 'a', title: 'Dois' },
      ]),
    ).rejects.toThrow(/repetidos/);
    await expect(
      client.sendList(PHONE, 'x', 'Ver', [
        { rows: Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `${i}` })) },
      ]),
    ).rejects.toThrow(/10 itens/);
    await expect(client.sendText(PHONE, 'x'.repeat(4097))).rejects.toThrow(/4096/);
    await expect(client.sendText('123', 'oi')).rejects.toThrow(/telefone inválido/);
    await expect(
      client.sendTemplate(PHONE, { name: 'Nome Inválido', language: 'pt_BR' }),
    ).rejects.toThrow(/template/);
    expect(calls).toHaveLength(0);
  });

  it('erro da Meta vira WhatsAppApiError sem token, telefone nem texto', async () => {
    const { client } = setup((config) => {
      throw new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', config, null, {
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config,
        data: {
          error: {
            message: `(#131030) Recipient phone number ${PHONE} not in allowed list`,
            type: 'OAuthException',
            code: 131030,
            fbtrace_id: 'AbCdEf123',
          },
        },
      });
    });

    const err = await client.sendText(PHONE, TEXT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhatsAppApiError);
    expect(err).toMatchObject({ httpStatus: 400, code: '131030', fbtraceId: 'AbCdEf123' });

    const everything = [
      (err as Error).message,
      JSON.stringify(err),
      inspect(err, { depth: 10 }),
      JSON.stringify(safeError(err)),
    ].join('\n');
    for (const secret of [TOKEN, PHONE, TEXT, 'Recipient']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('falha de rede vira WhatsAppApiError com o código do axios', async () => {
    const { client } = setup((config) => {
      throw new AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED', config);
    });
    await expect(client.sendText(PHONE, TEXT)).rejects.toMatchObject({
      name: 'WhatsAppApiError',
      code: 'ECONNABORTED',
      httpStatus: undefined,
    });
  });
});
