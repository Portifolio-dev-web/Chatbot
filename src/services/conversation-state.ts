import { z } from 'zod';
import { BOOKING_RULES } from '../config/business-rules.js';
import type { Prisma } from '../generated/prisma/client.js';
import { SERVICE_CODE } from '../profiles/types.js';
import type { Db } from './audit.js';

/*
 * Estado do funil (Saudação -> Serviço -> Data -> Horário -> Nome -> Confirmação) de cada
 * cliente, no banco (tabela conversations), para sobreviver a reinícios e deploys.
 *
 * Guarda a ETAPA e as OPÇÕES da última pergunta (id + título de cada botão/item). Assim quem
 * digita "2" ou "8h" em vez de tocar no botão também é entendido.
 * PRIVACIDADE: nunca guarda texto livre do cliente; só ids e títulos que o próprio bot gerou.
 *
 * Só existe para quem já é cliente (consentiu). Antes disso, as respostas não dependem de
 * estado: o id de cada botão já diz o que fazer.
 */

export const STEPS = [
  'menu',
  'choosing_service',
  'choosing_audience',
  'choosing_day',
  'choosing_slot',
  'awaiting_name',
  'awaiting_patient_name',
  'confirming',
  'my_appointments',
  'confirming_cancel',
  'privacy',
  'confirming_delete',
  'info',
] as const;

export type Step = (typeof STEPS)[number];

const optionSchema = z.object({ id: z.string().max(200), title: z.string().max(30) });
export type Option = z.infer<typeof optionSchema>;

const contextSchema = z.object({
  options: z.array(optionSchema).max(10).default([]),
  /**
   * Nas etapas awaiting_name e awaiting_patient_name: o serviço (código) e o horário
   * escolhidos, à espera do nome para confirmar. O atendimento confere se o serviço existe no perfil desta instalação.
   */
  serviceType: z.string().regex(SERVICE_CODE).optional(),
  startsAt: z.iso.datetime().optional(),
  /** Perfis com menores: para quem é a sessão, escolhido no início do funil. */
  audience: z.enum(['self', 'minor']).optional(),
  /**
   * [CRIPTOGRAFADO] Nome do(a) paciente menor, entre a pergunta e a confirmação. Cifrado
   * como os demais nomes: o estado da conversa fica no banco e não pode guardar nome em claro.
   */
  patientNameEncrypted: z.string().max(1000).optional(),
});

export interface ConversationState extends z.infer<typeof contextSchema> {
  step: Step;
}

export async function loadState(db: Db, clientId: string, now: Date): Promise<ConversationState | null> {
  const row = await db.conversation.findUnique({ where: { clientId } });
  if (!row || row.expiresAt <= now) return null;
  const step = STEPS.find((s) => s === row.step);
  const context = contextSchema.safeParse(row.context);
  // Estado corrompido ou de uma versão antiga do bot: recomeça do menu em vez de travar.
  if (!step || !context.success) return null;
  return { step, ...context.data };
}

export async function saveState(
  db: Db,
  clientId: string,
  state: ConversationState,
  now: Date,
): Promise<void> {
  const context: Prisma.InputJsonObject = {
    options: state.options,
    ...(state.serviceType ? { serviceType: state.serviceType } : {}),
    ...(state.startsAt ? { startsAt: state.startsAt } : {}),
    ...(state.audience ? { audience: state.audience } : {}),
    ...(state.patientNameEncrypted ? { patientNameEncrypted: state.patientNameEncrypted } : {}),
  };
  const data = {
    step: state.step,
    context,
    lastInboundAt: now,
    expiresAt: new Date(now.getTime() + BOOKING_RULES.conversationTtlMs),
  };
  await db.conversation.upsert({ where: { clientId }, create: { clientId, ...data }, update: data });
}

export async function clearState(db: Db, clientId: string): Promise<void> {
  await db.conversation.deleteMany({ where: { clientId } });
}
