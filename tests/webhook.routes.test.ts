import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { setLoggerForTesting } from '../src/lib/logger.js';
import type { WebhookEvent } from '../src/services/webhook-parser.js';
import {
  PHONE,
  PROFILE_NAME,
  TEXT,
  captureLogs,
  contacts,
  textMessage,
  webhookPayload,
} from './fixtures.js';

const SECRET = process.env.WHATSAPP_APP_SECRET!;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN!;

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

let received: WebhookEvent[][];
let logs: string[];
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  received = [];
  const capture = captureLogs();
  logs = capture.lines;
  setLoggerForTesting(capture.logger);
  app = createApp({
    webhookSink: {
      handleEvents: async (events) => {
        received.push(events);
      },
    },
  });
});

afterEach(() => setLoggerForTesting(undefined));

describe('GET /webhook (verificação da Meta)', () => {
  const query = (overrides: Record<string, string> = {}) => ({
    'hub.mode': 'subscribe',
    'hub.verify_token': VERIFY_TOKEN,
    'hub.challenge': '1158201444',
    ...overrides,
  });

  it('devolve o challenge em texto puro quando o token confere', async () => {
    const res = await request(app).get('/webhook').query(query());
    expect(res.status).toBe(200);
    expect(res.text).toBe('1158201444');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('recusa token errado e não registra o token no log', async () => {
    const res = await request(app)
      .get('/webhook')
      .query(query({ 'hub.verify_token': 'token-de-quem-tenta-adivinhar' }));
    expect(res.status).toBe(403);
    const output = logs.join('');
    expect(output).not.toContain('token-de-quem-tenta-adivinhar');
    expect(output).not.toContain(VERIFY_TOKEN);
  });

  it('recusa modo diferente de subscribe', async () => {
    const res = await request(app).get('/webhook').query(query({ 'hub.mode': 'unsubscribe' }));
    expect(res.status).toBe(403);
  });

  it('não ecoa um challenge com conteúdo arbitrário', async () => {
    const res = await request(app)
      .get('/webhook')
      .query(query({ 'hub.challenge': '<script>alert(1)</script>' }));
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('<script>');
  });
});

describe('POST /webhook (mensagens)', () => {
  const body = JSON.stringify(webhookPayload({ contacts, messages: [textMessage()] }));

  function post(payload: string, signature?: string, contentType = 'application/json') {
    const req = request(app).post('/webhook').set('Content-Type', contentType);
    if (signature !== undefined) req.set('X-Hub-Signature-256', signature);
    return req.send(payload);
  }

  it('aceita entrega assinada e repassa os eventos normalizados', async () => {
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    const [event] = received[0]!;
    expect(event).toMatchObject({
      kind: 'message',
      message: { from: PHONE, profileName: PROFILE_NAME, content: { type: 'text', text: TEXT } },
    });
  });

  it('nada pessoal vai para o log', async () => {
    await post(body, sign(body));
    const output = logs.join('');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [PHONE, PHONE.slice(-8), PROFILE_NAME, TEXT, SECRET]) {
      expect(output).not.toContain(secret);
    }
  });

  it('recusa entrega sem assinatura', async () => {
    const res = await post(body);
    expect(res.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('recusa assinatura feita com outra chave', async () => {
    const res = await post(body, sign(body, 'chave-de-um-impostor'));
    expect(res.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('recusa corpo alterado depois de assinado', async () => {
    const forged = body.replace(TEXT, 'Cancelar todos os horários');
    const res = await post(forged, sign(body));
    expect(res.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('recusa assinatura em formato estranho', async () => {
    for (const signature of ['', 'sha1=abc', 'sha256=', `sha256=${'zz'.repeat(32)}`]) {
      const res = await post(body, signature);
      expect(res.status).toBe(401);
    }
    expect(received).toHaveLength(0);
  });

  it('recusa corpo acima de 1 MB', async () => {
    const huge = JSON.stringify({ data: 'x'.repeat(1_100_000) });
    const res = await post(huge, sign(huge));
    expect(res.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it('recusa tipo de conteúdo que não é JSON', async () => {
    const res = await post(body, sign(body), 'text/plain');
    expect(res.status).toBe(415);
  });

  it('JSON inválido com assinatura válida: 400', async () => {
    const res = await post('{nao-e-json', sign('{nao-e-json'));
    expect(res.status).toBe(400);
  });

  it('formato desconhecido com assinatura válida: 200 (a Meta não insiste) e nada é repassado', async () => {
    const other = JSON.stringify({ object: 'page', entry: [] });
    const res = await post(other, sign(other));
    expect(res.status).toBe(200);
    expect(received).toHaveLength(0);
  });

  it('respostas do webhook trazem os cabeçalhos de segurança', async () => {
    const res = await post(body, sign(body));
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
