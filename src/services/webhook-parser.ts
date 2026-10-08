import { z } from 'zod';

/*
 * Lê o payload do webhook da Meta e devolve eventos já normalizados para o resto do sistema.
 *
 * Tolerante de propósito: a Meta acrescenta campos e tipos novos sem aviso. Por isso cada
 * mensagem é validada separadamente (uma esquisita não derruba o lote) e tipos desconhecidos
 * viram "unsupported" em vez de erro. Todo texto e lista tem limite de tamanho.
 */

/** Mensagem recebida. `from`, `profileName` e o conteúdo são DADOS PESSOAIS: nunca logar. */
export interface InboundMessage {
  /** ID da Meta (wamid...). */
  id: string;
  /** Telefone de quem mandou (wa_id): DDI + DDD + número, só dígitos. */
  from: string;
  timestamp: Date;
  /** Nome do perfil no WhatsApp (escolhido pela pessoa; pode ser apelido). */
  profileName: string | undefined;
  content: MessageContent;
}

export type MessageContent =
  | { type: 'text'; text: string }
  /** Toque num botão ou item de lista (nosso), ou num botão de resposta rápida de template. */
  | { type: 'reply'; replyId: string; title: string }
  /** Áudio, imagem, localização, figurinha...: o bot não interpreta. `originalType` é seguro para log. */
  | { type: 'unsupported'; originalType: string };

/** Aviso de entrega de uma mensagem que NÓS enviamos. */
export interface StatusUpdate {
  messageId: string;
  /** sent | delivered | read | failed | ... */
  status: string;
  /** Código de erro da Meta quando status = failed (ex.: 131047). */
  errorCode: string | undefined;
}

export type WebhookEvent =
  | { kind: 'message'; message: InboundMessage }
  | { kind: 'status'; status: StatusUpdate };

export interface ParseResult {
  events: WebhookEvent[];
  /** Itens descartados (formato inesperado ou de outro número). Para o log, sem conteúdo. */
  skipped: number;
  /** false = não é um webhook do WhatsApp que entendemos. */
  envelopeValid: boolean;
}

// Tipos vindos da Meta vão para o log: só letras minúsculas e "_", nada que carregue dado.
const typeName = z.string().regex(/^[a-z_]{1,40}$/);
const waId = z.string().regex(/^\d{8,15}$/);
const metaId = z.string().min(1).max(256);

const envelopeSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string().max(64),
              value: z.object({
                metadata: z.object({ phone_number_id: z.string().max(64) }).optional(),
                contacts: z
                  .array(
                    z.object({
                      wa_id: z.string().max(20),
                      profile: z.object({ name: z.string().max(256) }).optional(),
                    }),
                  )
                  .max(100)
                  .optional(),
                // Validados um a um mais abaixo.
                messages: z.array(z.unknown()).max(100).optional(),
                statuses: z.array(z.unknown()).max(100).optional(),
              }),
            }),
          )
          .max(50),
      }),
    )
    .max(50),
});

const messageSchema = z.object({
  from: waId,
  id: metaId,
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: typeName,
  text: z.object({ body: z.string().max(4096) }).optional(),
  interactive: z
    .object({
      type: typeName,
      button_reply: z.object({ id: z.string().max(256), title: z.string().max(100) }).optional(),
      list_reply: z.object({ id: z.string().max(256), title: z.string().max(100) }).optional(),
    })
    .optional(),
  button: z.object({ payload: z.string().max(1000), text: z.string().max(100) }).optional(),
});

const statusSchema = z.object({
  id: metaId,
  status: typeName,
  errors: z
    .array(z.object({ code: z.union([z.number().int(), z.string().regex(/^\d{1,10}$/)]) }))
    .max(10)
    .optional(),
});

function toContent(m: z.infer<typeof messageSchema>): MessageContent {
  switch (m.type) {
    case 'text':
      if (m.text) return { type: 'text', text: m.text.body };
      break;
    case 'interactive': {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      if (reply) return { type: 'reply', replyId: reply.id, title: reply.title };
      return { type: 'unsupported', originalType: `interactive_${m.interactive?.type ?? 'unknown'}` };
    }
    case 'button':
      if (m.button) return { type: 'reply', replyId: m.button.payload, title: m.button.text };
      break;
  }
  return { type: 'unsupported', originalType: m.type };
}

export function parseWebhookPayload(payload: unknown, expectedPhoneNumberId: string): ParseResult {
  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success) return { events: [], skipped: 0, envelopeValid: false };

  const events: WebhookEvent[] = [];
  let skipped = 0;

  for (const entry of envelope.data.entry) {
    for (const change of entry.changes) {
      // Outros campos (status de template, qualidade do número...) não interessam ao bot.
      if (change.field !== 'messages') continue;
      const { value } = change;

      // O mesmo app da Meta pode ter vários números (ex.: o de teste e o oficial). Só
      // atendemos o número configurado; o resto é ignorado, não respondido por engano.
      if (value.metadata?.phone_number_id !== expectedPhoneNumberId) {
        skipped += (value.messages?.length ?? 0) + (value.statuses?.length ?? 0);
        continue;
      }

      const names = new Map(value.contacts?.map((c) => [c.wa_id, c.profile?.name]) ?? []);

      for (const raw of value.messages ?? []) {
        const parsed = messageSchema.safeParse(raw);
        if (!parsed.success) {
          skipped++;
          continue;
        }
        const m = parsed.data;
        events.push({
          kind: 'message',
          message: {
            id: m.id,
            from: m.from,
            timestamp: new Date(Number(m.timestamp) * 1000),
            profileName: names.get(m.from)?.trim() || undefined,
            content: toContent(m),
          },
        });
      }

      for (const raw of value.statuses ?? []) {
        const parsed = statusSchema.safeParse(raw);
        if (!parsed.success) {
          skipped++;
          continue;
        }
        const s = parsed.data;
        const code = s.errors?.[0]?.code;
        events.push({
          kind: 'status',
          status: {
            messageId: s.id,
            status: s.status,
            errorCode: code === undefined ? undefined : String(code),
          },
        });
      }
    }
  }

  return { events, skipped, envelopeValid: true };
}
