import { RETENTION } from '../config/business-rules.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { getLogger } from '../lib/logger.js';
import { anonymizeClient } from './clients.js';

const DAY = 24 * 60 * 60_000;

export interface MaintenanceRun {
  processedMessagesDeleted: number;
  conversationsDeleted: number;
  clientsAnonymized: number;
}

/**
 * Rotina de retenção (LGPD arts. 15 e 16: dado guardado só enquanto houver finalidade).
 * - IDs de mensagens processadas: só servem contra reentrega da Meta -> 7 dias.
 * - Conversas paradas além do prazo: o estado do funil não serve mais.
 * - Cliente sem conversa nem agendamento (passado recente ou futuro) há 1 ano: anonimizado,
 *   como no "apagar meus dados" (actor SYSTEM na auditoria).
 * Tudo idempotente: rodar duas vezes, ou em duas instâncias, não causa dano.
 */
export async function runMaintenance(prisma: PrismaClient, now: Date): Promise<MaintenanceRun> {
  const processed = await prisma.processedMessage.deleteMany({
    where: { receivedAt: { lt: new Date(now.getTime() - RETENTION.processedMessagesDays * DAY) } },
  });
  const conversations = await prisma.conversation.deleteMany({ where: { expiresAt: { lt: now } } });

  const cutoff = new Date(now.getTime() - RETENTION.inactiveClientDays * DAY);
  const inactive = await prisma.client.findMany({
    where: {
      anonymizedAt: null,
      lastInteractionAt: { lt: cutoff },
      appointments: { none: { startsAt: { gte: cutoff } } },
    },
    select: { id: true },
    take: 100, // o resto fica para a próxima rodada
  });
  let anonymized = 0;
  for (const { id } of inactive) {
    if ((await anonymizeClient(prisma, id, now, 'SYSTEM')).done) anonymized++;
  }

  const run = {
    processedMessagesDeleted: processed.count,
    conversationsDeleted: conversations.count,
    clientsAnonymized: anonymized,
  };
  getLogger().info(run, 'rotina de retenção concluída');
  return run;
}
