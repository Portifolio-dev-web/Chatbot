import { randomBytes } from 'node:crypto';
import { AxiosError, type AxiosAdapter } from 'axios';
import type { DestinationStream } from 'pino';
import { scheduleRows } from '../src/content/default-schedule.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createLogger } from '../src/lib/logger.js';
import { PROFILES } from '../src/profiles/index.js';
import { createWhatsAppClient, type WhatsAppClient } from '../src/services/whatsapp-client.js';

/** Corpo de uma mensagem enviada à Graph API (como a Meta recebe). */
export type SentMessage = Record<string, any>;

/**
 * Cliente do WhatsApp REAL (com todas as validações de limite) cuja rede foi trocada por
 * uma lista: nada sai da máquina, e o teste lê exatamente o que a Meta receberia.
 */
export function recordingWhatsApp(
  options: {
    /** Simula falha da Meta para as mensagens escolhidas (status HTTP + código de erro). */
    fail?: (body: SentMessage) => { status: number; code: number } | undefined;
    /** Força o wamid devolvido (para simular colisão ao registrar o envio). */
    messageId?: string;
  } = {},
): { whatsapp: WhatsAppClient; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const adapter: AxiosAdapter = async (config) => {
    const body = JSON.parse(config.data as string) as SentMessage;
    const failure = options.fail?.(body);
    if (failure) {
      throw new AxiosError('falha simulada', 'ERR_BAD_RESPONSE', config, null, {
        status: failure.status,
        statusText: 'erro simulado',
        headers: {},
        config,
        data: { error: { code: failure.code, message: 'erro simulado' } },
      });
    }
    if (body.status !== 'read') sent.push(body);
    return {
      // Único entre instâncias: a coluna wa_message_id é única no banco, como os ids da Meta.
      data: { messages: [{ id: options.messageId ?? `wamid.ENVIADA_${randomBytes(8).toString('hex')}` }] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
  const whatsapp = createWhatsAppClient({
    accessToken: 'token-ficticio',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
    apiVersion: 'v25.0',
    adapter,
  });
  return { whatsapp, sent };
}

// Dados FICTÍCIOS. Os testes de log procuram exatamente estes valores na saída.
export const PHONE = '5511987654321';
export const PROFILE_NAME = 'Maria Fictícia';
export const TEXT = 'Quero marcar fisioterapia para o joelho';

export function epochSeconds(offsetMs = 0): string {
  return String(Math.floor((Date.now() + offsetMs) / 1000));
}

/** Envelope de webhook como a Meta envia, para o número configurado nos testes. */
export function webhookPayload(
  value: Record<string, unknown>,
  phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!,
): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

export const contacts = [{ wa_id: PHONE, profile: { name: PROFILE_NAME } }];

export function textMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: PHONE,
    id: 'wamid.TEXTO1',
    timestamp: epochSeconds(),
    type: 'text',
    text: { body: TEXT },
    ...overrides,
  };
}

/**
 * Garante a grade de exemplo do perfil fisio-personal no banco de teste, criando só as
 * regras que faltam. Antes, os testes só criavam a grade se a tabela estivesse VAZIA: uma
 * regra solta deixada por outro teste (ou à mão) bastava para faltar horário.
 */
export async function ensureDefaultSchedule(prisma: PrismaClient): Promise<void> {
  for (const row of scheduleRows(PROFILES['fisio-personal'].defaultSchedule)) {
    if (!(await prisma.availabilityRule.findFirst({ where: { ...row, active: true } }))) {
      await prisma.availabilityRule.create({ data: row });
    }
  }
}

/** Logger real (com o mesmo redact de produção) escrevendo numa lista, para inspeção. */
export function captureLogs(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const destination: DestinationStream = { write: (chunk: string) => void lines.push(chunk) };
  return { lines, logger: createLogger({ env: 'test', logLevel: 'debug' }, destination) };
}
