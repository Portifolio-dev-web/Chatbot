import type { Actor, Prisma, PrismaClient } from '../generated/prisma/client.js';

export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Registra um evento na trilha de auditoria (tabela só de inclusão).
 * PRIVACIDADE: `detail` NUNCA leva dado pessoal (nome, telefone, texto): a tabela não é
 * criptografada. Identifique pelo ID da entidade; detalhes só técnicos (serviço, versão).
 */
export async function audit(
  db: Db,
  event: {
    actor: Actor;
    action: string;
    entityType: 'client' | 'appointment' | 'consent';
    entityId: string;
    detail?: Prisma.InputJsonObject;
  },
): Promise<void> {
  await db.auditEvent.create({
    data: {
      actor: event.actor,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      ...(event.detail ? { detail: event.detail } : {}),
    },
  });
}
