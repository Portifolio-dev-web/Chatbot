import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLoggerForTesting } from '../src/lib/logger.js';
import {
  MAX_MESSAGE_AGE_MS,
  createInboundDispatcher,
  type DispatcherStore,
} from '../src/services/inbound-dispatcher.js';
import type { InboundMessage, WebhookEvent } from '../src/services/webhook-parser.js';
import { PHONE, PROFILE_NAME, TEXT, captureLogs } from './fixtures.js';

const NOW = new Date('2026-10-08T12:00:00Z');

function message(id: string, ageMs = 0): WebhookEvent {
  return {
    kind: 'message',
    message: {
      id,
      from: PHONE,
      timestamp: new Date(NOW.getTime() - ageMs),
      profileName: PROFILE_NAME,
      content: { type: 'text', text: TEXT },
    },
  };
}

function fakeStore() {
  const processed = new Set<string>();
  const failed: Array<[string, string | undefined]> = [];
  const store: DispatcherStore = {
    async markProcessed(id) {
      if (processed.has(id)) return false;
      processed.add(id);
      return true;
    },
    async markOutboundFailed(id, code) {
      failed.push([id, code]);
      return 1;
    },
  };
  return { store, processed, failed };
}

let logs: string[];

beforeEach(() => {
  const capture = captureLogs();
  logs = capture.lines;
  setLoggerForTesting(capture.logger);
});
afterEach(() => setLoggerForTesting(undefined));

function setup(handle: (m: InboundMessage) => Promise<void> = async () => {}) {
  const handled: string[] = [];
  const { store, processed, failed } = fakeStore();
  const dispatcher = createInboundDispatcher({
    store,
    now: () => NOW,
    handler: {
      handle: async (m) => {
        handled.push(m.id);
        await handle(m);
      },
    },
  });
  return { dispatcher, handled, processed, failed };
}

describe('inbound dispatcher', () => {
  it('atende mensagem nova uma única vez, mesmo se a Meta reentregar', async () => {
    const { dispatcher, handled } = setup();
    await dispatcher.handleEvents([message('wamid.A')]);
    await dispatcher.handleEvents([message('wamid.A')]);
    expect(handled).toEqual(['wamid.A']);
  });

  it('ignora (mas registra) mensagem com mais de 24 h', async () => {
    const { dispatcher, handled, processed } = setup();
    await dispatcher.handleEvents([message('wamid.VELHA', MAX_MESSAGE_AGE_MS + 60_000)]);
    expect(handled).toEqual([]);
    expect(processed.has('wamid.VELHA')).toBe(true);
  });

  it('uma falha no atendimento não impede as outras mensagens do lote', async () => {
    const { dispatcher, handled } = setup(async (m) => {
      if (m.id === 'wamid.FALHA') throw new Error(`erro com dado pessoal: ${PHONE} ${TEXT}`);
    });
    await dispatcher.handleEvents([message('wamid.FALHA'), message('wamid.OK')]);
    expect(handled).toEqual(['wamid.FALHA', 'wamid.OK']);
    // A mensagem do erro (com dado pessoal) não vai para o log.
    const output = logs.join('');
    expect(output).toContain('falha ao tratar evento');
    expect(output).not.toContain(PHONE);
    expect(output).not.toContain(TEXT);
  });

  it('registra falha de entrega na fila; outros status são ignorados', async () => {
    const { dispatcher, failed } = setup();
    await dispatcher.handleEvents([
      { kind: 'status', status: { messageId: 'wamid.X', status: 'failed', errorCode: '131047' } },
      { kind: 'status', status: { messageId: 'wamid.Y', status: 'read', errorCode: undefined } },
    ]);
    expect(failed).toEqual([['wamid.X', '131047']]);
  });

  it('o log de mensagem recebida não tem telefone, nome nem texto', async () => {
    const { dispatcher } = setup();
    await dispatcher.handleEvents([message('wamid.LOG')]);
    const output = logs.join('');
    expect(output).toContain('mensagem recebida');
    for (const secret of [PHONE, PROFILE_NAME, TEXT]) expect(output).not.toContain(secret);
  });
});
