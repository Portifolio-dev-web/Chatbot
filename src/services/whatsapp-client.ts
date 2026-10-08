import axios, { isAxiosError, type AxiosAdapter } from 'axios';
import { getConfig } from '../config/env.js';
import { normalizePhone } from '../lib/crypto.js';

/*
 * Cliente da WhatsApp Cloud API (Graph API da Meta): envia mensagens em nome do número da
 * clínica.
 *
 * SEGURANÇA/PRIVACIDADE: o erro do axios carrega a requisição inteira (token no cabeçalho
 * Authorization, telefone e texto no corpo) e a resposta da Meta, cuja mensagem às vezes
 * repete o número. Por isso todo erro é trocado por um WhatsAppApiError só com status HTTP e
 * códigos, seguro para log. Não há nova tentativa automática: se a Meta recebeu e só a
 * resposta se perdeu, repetir mandaria a mesma mensagem duas vezes ao cliente. Quem precisa
 * de reenvio garantido (lembretes) usa a fila outbound_messages, que controla as tentativas.
 */

export class WhatsAppApiError extends Error {
  override name = 'WhatsAppApiError';
  readonly httpStatus: number | undefined;
  /** Código da Meta (ex.: "131047") ou do axios (ex.: "ECONNABORTED"). Lido pelo safeError. */
  readonly code: string;
  readonly subcode: string | undefined;
  /** Identificador que o suporte da Meta pede para investigar uma falha. */
  readonly fbtraceId: string | undefined;

  constructor(info: { httpStatus?: number; code?: string; subcode?: string; fbtraceId?: string }) {
    const code = info.code ?? 'UNKNOWN';
    super(`a Graph API recusou a chamada (HTTP ${info.httpStatus ?? 'sem resposta'}, código ${code})`);
    this.httpStatus = info.httpStatus;
    this.code = code;
    this.subcode = info.subcode;
    this.fbtraceId = info.fbtraceId;
  }
}

/** Só aceita códigos com cara de código; qualquer outra coisa poderia ser texto da Meta. */
function safeCode(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return /^[\w.-]{1,40}$/.test(text) ? text : undefined;
}

function toSafeError(err: unknown): WhatsAppApiError {
  if (!isAxiosError(err)) return new WhatsAppApiError({});
  const data = err.response?.data as
    | { error?: { code?: unknown; error_subcode?: unknown; fbtrace_id?: unknown } }
    | undefined;
  const info: ConstructorParameters<typeof WhatsAppApiError>[0] = {};
  if (err.response?.status !== undefined) info.httpStatus = err.response.status;
  const code = safeCode(data?.error?.code) ?? safeCode(err.code);
  if (code) info.code = code;
  const subcode = safeCode(data?.error?.error_subcode);
  if (subcode) info.subcode = subcode;
  const trace = safeCode(data?.error?.fbtrace_id);
  if (trace) info.fbtraceId = trace;
  return new WhatsAppApiError(info);
}

// Limites da Cloud API. Conferidos ANTES de enviar: o erro aparece no teste, não para o cliente.
const LIMITS = {
  text: 4096,
  interactiveBody: 1024,
  buttons: 3,
  buttonTitle: 20,
  listButton: 20,
  listRows: 10,
  listSections: 10,
  rowTitle: 24,
  rowDescription: 72,
  sectionTitle: 24,
  id: 200,
  templateParam: 1024,
} as const;

/** Conta caracteres como o WhatsApp (um emoji = 1), não unidades UTF-16. */
function length(text: string): number {
  return [...text].length;
}

function check(condition: boolean, rule: string): asserts condition {
  // A mensagem diz a regra, nunca o conteúdo (que pode ter dado pessoal).
  if (!condition) throw new RangeError(`limite do WhatsApp: ${rule}`);
}

function checkText(text: string, max: number, what: string): void {
  check(text.trim().length > 0, `${what} vazio`);
  check(length(text) <= max, `${what} passa de ${max} caracteres`);
}

function checkIds(ids: string[]): void {
  for (const id of ids) checkText(id, LIMITS.id, 'id de opção');
  check(new Set(ids).size === ids.length, 'ids de opção repetidos');
}

/**
 * Parâmetro de template: a Meta recusa quebra de linha, tabulação e mais de 4 espaços
 * seguidos (erro 132018). Normalizamos em vez de falhar.
 */
function templateParam(text: string): string {
  const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
  checkText(clean, LIMITS.templateParam, 'parâmetro de template');
  return clean;
}

export interface SendResult {
  /** wamid da mensagem enviada (casa com os avisos de entrega do webhook). */
  messageId: string | undefined;
}

export interface ReplyButton {
  id: string;
  title: string;
}

export interface ListSection {
  /** Obrigatório quando houver mais de uma seção. */
  title?: string;
  rows: Array<{ id: string; title: string; description?: string }>;
}

export interface TemplateMessage {
  /** Nome exato do template aprovado no painel da Meta. */
  name: string;
  /** Idioma do template, ex.: "pt_BR". */
  language: string;
  /** Valores de {{1}}, {{2}}... do corpo, na ordem. */
  bodyParams?: string[];
  /** Payload de cada botão de resposta rápida, na ordem dos botões. */
  quickReplyPayloads?: string[];
}

export interface WhatsAppClient {
  sendText(to: string, text: string): Promise<SendResult>;
  /** Até 3 botões de resposta. */
  sendButtons(to: string, body: string, buttons: ReplyButton[]): Promise<SendResult>;
  /** Lista de opções (até 10 itens no total), aberta por um botão. */
  sendList(
    to: string,
    body: string,
    buttonLabel: string,
    sections: ListSection[],
  ): Promise<SendResult>;
  /** Mensagem ativa (fora da janela de 24 h): só com template aprovado. */
  sendTemplate(to: string, template: TemplateMessage): Promise<SendResult>;
  /** Marca como lida (os dois tiques azuis para o cliente). */
  markAsRead(messageId: string): Promise<void>;
}

export interface WhatsAppClientOptions {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  timeoutMs?: number;
  /** Só para testes: troca a camada de rede do axios. */
  adapter?: AxiosAdapter;
}

export function createWhatsAppClient(options: WhatsAppClientOptions): WhatsAppClient {
  const http = axios.create({
    baseURL: `https://graph.facebook.com/${options.apiVersion}/${options.phoneNumberId}`,
    timeout: options.timeoutMs ?? 10_000,
    // A Graph API não redireciona; seguir um redirecionamento levaria o token junto.
    maxRedirects: 0,
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json',
    },
    ...(options.adapter ? { adapter: options.adapter } : {}),
  });

  async function post(body: Record<string, unknown>): Promise<SendResult> {
    try {
      const response = await http.post<{ messages?: Array<{ id?: unknown }> }>('/messages', {
        messaging_product: 'whatsapp',
        ...body,
      });
      const id = response.data?.messages?.[0]?.id;
      return { messageId: typeof id === 'string' ? id : undefined };
    } catch (err) {
      throw toSafeError(err);
    }
  }

  function message(to: string, payload: Record<string, unknown>): Promise<SendResult> {
    return post({ recipient_type: 'individual', to: normalizePhone(to), ...payload });
  }

  // Métodos `async`: um limite violado vira Promise rejeitada, como qualquer falha de envio.
  // Sem isso, o erro seria síncrono e escaparia de quem trata com `.catch()`.
  return {
    async sendText(to, text) {
      checkText(text, LIMITS.text, 'texto');
      return message(to, { type: 'text', text: { body: text, preview_url: false } });
    },

    async sendButtons(to, body, buttons) {
      checkText(body, LIMITS.interactiveBody, 'texto da mensagem');
      check(buttons.length >= 1 && buttons.length <= LIMITS.buttons, 'de 1 a 3 botões');
      for (const b of buttons) checkText(b.title, LIMITS.buttonTitle, 'título do botão');
      checkIds(buttons.map((b) => b.id));
      return message(to, {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: {
            buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
          },
        },
      });
    },

    async sendList(to, body, buttonLabel, sections) {
      checkText(body, LIMITS.interactiveBody, 'texto da mensagem');
      checkText(buttonLabel, LIMITS.listButton, 'botão da lista');
      check(sections.length >= 1 && sections.length <= LIMITS.listSections, 'de 1 a 10 seções');
      const rows = sections.flatMap((s) => s.rows);
      check(rows.length >= 1 && rows.length <= LIMITS.listRows, 'de 1 a 10 itens na lista');
      for (const s of sections) {
        if (sections.length > 1 || s.title !== undefined) {
          checkText(s.title ?? '', LIMITS.sectionTitle, 'título da seção');
        }
      }
      for (const r of rows) {
        checkText(r.title, LIMITS.rowTitle, 'título do item');
        if (r.description !== undefined) {
          checkText(r.description, LIMITS.rowDescription, 'descrição do item');
        }
      }
      checkIds(rows.map((r) => r.id));
      return message(to, {
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: body },
          action: {
            button: buttonLabel,
            sections: sections.map((s) => ({
              ...(s.title !== undefined ? { title: s.title } : {}),
              rows: s.rows.map((r) => ({
                id: r.id,
                title: r.title,
                ...(r.description !== undefined ? { description: r.description } : {}),
              })),
            })),
          },
        },
      });
    },

    async sendTemplate(to, template) {
      check(/^[a-z0-9_]{1,512}$/.test(template.name), 'nome de template inválido');
      check(/^[a-z]{2,3}(_[A-Z]{2})?$/.test(template.language), 'idioma inválido (ex.: pt_BR)');
      const components: unknown[] = [];
      if (template.bodyParams?.length) {
        components.push({
          type: 'body',
          parameters: template.bodyParams.map((p) => ({ type: 'text', text: templateParam(p) })),
        });
      }
      template.quickReplyPayloads?.forEach((payload, index) => {
        checkText(payload, LIMITS.id, 'payload do botão');
        components.push({
          type: 'button',
          sub_type: 'quick_reply',
          index: String(index),
          parameters: [{ type: 'payload', payload }],
        });
      });
      return message(to, {
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language },
          ...(components.length ? { components } : {}),
        },
      });
    },

    async markAsRead(messageId) {
      await post({ status: 'read', message_id: messageId });
    },
  };
}

let instance: WhatsAppClient | undefined;

export function getWhatsAppClient(): WhatsAppClient {
  const { whatsapp } = getConfig();
  instance ??= createWhatsAppClient({
    accessToken: whatsapp.accessToken,
    phoneNumberId: whatsapp.phoneNumberId,
    apiVersion: whatsapp.apiVersion,
  });
  return instance;
}
