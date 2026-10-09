import type { Actor, Client, PrismaClient } from '../generated/prisma/client.js';
import { getFieldCipher, normalizePhone, phoneIndex } from '../lib/crypto.js';
import { audit, type Db } from './audit.js';
import { cancelWithinTransaction } from './booking.js';

/*
 * Clientes. Regras de privacidade:
 * - O cliente só passa a existir no banco quando CONSENTE (antes disso o bot responde dúvidas
 *   sem gravar nada sobre a pessoa: minimização, LGPD art. 6º, III).
 * - Nome e telefone sempre criptografados; a busca é pelo índice cego do telefone.
 */

export async function findClientByPhone(db: Db, phone: string): Promise<Client | null> {
  return db.client.findUnique({ where: { phoneHash: phoneIndex(phone) } });
}

export function decryptName(client: Pick<Client, 'nameEncrypted'>): string | undefined {
  return client.nameEncrypted
    ? getFieldCipher().decrypt('client.name', client.nameEncrypted)
    : undefined;
}

export function decryptPhone(client: Pick<Client, 'phoneEncrypted'>): string | undefined {
  return client.phoneEncrypted
    ? getFieldCipher().decrypt('client.phone', client.phoneEncrypted)
    : undefined;
}

/** Atualiza a data da última interação (base da rotina de retenção do Passo 4B). */
export async function touchClient(db: Db, clientId: string, now: Date): Promise<void> {
  await db.client.update({ where: { id: clientId }, data: { lastInteractionAt: now } });
}

export async function setClientName(db: Db, clientId: string, name: string): Promise<Client> {
  const client = await db.client.update({
    where: { id: clientId },
    data: { nameEncrypted: getFieldCipher().encrypt('client.name', name) },
  });
  await audit(db, { actor: 'CLIENT', action: 'client.name_set', entityType: 'client', entityId: clientId });
  return client;
}

export async function hasCurrentConsent(db: Db, clientId: string, version: string): Promise<boolean> {
  const consent = await db.consent.findFirst({
    where: { clientId, textVersion: version, revokedAt: null },
    select: { id: true },
  });
  return consent !== null;
}

/**
 * Registra o consentimento (e cria o cliente, se for o primeiro). Guarda a versão exata do
 * texto lido e o ID da mensagem em que a pessoa tocou "Concordo" (prova: LGPD art. 8º, §2º).
 */
export async function recordConsent(
  prisma: PrismaClient,
  input: { phone: string; version: string; body: string; evidenceMessageId: string; now: Date },
): Promise<Client> {
  return prisma.$transaction(async (tx) => {
    // Texto imutável: grava na primeira vez; nas seguintes, a versão já existe.
    await tx.consentText.createMany({
      data: [{ version: input.version, body: input.body }],
      skipDuplicates: true,
    });

    let client = await findClientByPhone(tx, input.phone);
    if (!client) {
      client = await tx.client.create({
        data: {
          phoneHash: phoneIndex(input.phone),
          phoneEncrypted: getFieldCipher().encrypt('client.phone', normalizePhone(input.phone)),
          lastInteractionAt: input.now,
        },
      });
      await audit(tx, { actor: 'CLIENT', action: 'client.created', entityType: 'client', entityId: client.id });
    }

    if (!(await hasCurrentConsent(tx, client.id, input.version))) {
      const consent = await tx.consent.create({
        data: {
          clientId: client.id,
          textVersion: input.version,
          givenAt: input.now,
          evidenceMessageId: input.evidenceMessageId,
        },
      });
      await audit(tx, {
        actor: 'CLIENT',
        action: 'consent.given',
        entityType: 'consent',
        entityId: consent.id,
        detail: { clientId: client.id, version: input.version },
      });
    }
    return client;
  });
}

/**
 * "Apagar meus dados" (LGPD art. 18, IV e VI; revogação, art. 8º, §5º): cancela os horários
 * futuros (a recepção é avisada), revoga o consentimento e apaga nome e telefone. Ficam só
 * registros sem identificação: agendamentos passados (estatística da agenda) e a prova de
 * que houve consentimento até hoje. O CHECK clients_identity_check garante que não sobra
 * dado de identificação pela metade.
 *
 * Também usada pela rotina de retenção (actor SYSTEM, Passo 4B). Trava a linha do cliente:
 * se a pessoa pedir para apagar no mesmo instante em que a rotina roda, só um dos dois faz.
 */
export async function anonymizeClient(
  prisma: PrismaClient,
  clientId: string,
  now: Date,
  actor: Actor = 'CLIENT',
): Promise<{ cancelledAppointments: number; done: boolean }> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM clients WHERE id = ${clientId}::uuid AND anonymized_at IS NULL FOR UPDATE`;
    if (locked.length === 0) return { cancelledAppointments: 0, done: false };

    const future = await tx.appointment.findMany({
      where: { clientId, status: 'CONFIRMED', startsAt: { gt: now } },
      select: { id: true, serviceType: true, startsAt: true },
    });
    for (const appointment of future) {
      await cancelWithinTransaction(tx, appointment, actor, now);
    }
    // Nome de criança/adolescente que este responsável agendou: sai junto. Sem isso, apagar
    // o responsável deixaria o nome do menor no histórico.
    const minorNames = await tx.appointment.updateMany({
      where: { clientId, patientNameEncrypted: { not: null } },
      data: { patientNameEncrypted: null },
    });
    const revoked = await tx.consent.updateMany({
      where: { clientId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.conversation.deleteMany({ where: { clientId } });
    await tx.client.update({
      where: { id: clientId },
      data: { anonymizedAt: now, phoneHash: null, phoneEncrypted: null, nameEncrypted: null },
    });
    await audit(tx, {
      actor,
      action: 'client.anonymized',
      entityType: 'client',
      entityId: clientId,
      detail: {
        cancelledAppointments: future.length,
        revokedConsents: revoked.count,
        minorNamesErased: minorNames.count,
      },
    });
    return { cancelledAppointments: future.length, done: true };
  });
}

export function decryptPatientName(
  appointment: { patientNameEncrypted: string | null },
): string | undefined {
  return appointment.patientNameEncrypted
    ? getFieldCipher().decrypt('appointment.patient_name', appointment.patientNameEncrypted)
    : undefined;
}
