import { createHmac, randomBytes, randomInt } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { drainBackgroundTasks } from '../src/lib/background.js';
import { createFieldCipher, createPhoneIndexer } from '../src/lib/crypto.js';
import { createPrismaClient } from '../src/lib/prisma.js';
import {
  createInboundDispatcher,
  createPrismaDispatcherStore,
} from '../src/services/inbound-dispatcher.js';
import { PROFILES } from '../src/profiles/index.js';
import { createChatbot } from '../src/services/chatbot/chatbot.js';
import { findClientByPhone } from '../src/services/clients.js';
import { recordingWhatsApp, textMessage, webhookPayload } from './fixtures.js';

/*
 * Testes contra um PostgreSQL de verdade, com as migrações aplicadas. Só rodam se
 * TEST_DATABASE_URL estiver definida, e devem apontar para um banco DESCARTÁVEL:
 * eles gravam dados de teste e nunca limpam (a trilha de auditoria nem deixaria).
 *
 *   TEST_DATABASE_URL=postgresql://... npm test
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('banco de dados (integração)', () => {
  let prisma: PrismaClient;
  const cipher = createFieldCipher(randomBytes(32));
  const index = createPhoneIndexer(randomBytes(32));

  beforeAll(() => {
    prisma = createPrismaClient(url!);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  function randomPhone(): string {
    return `55119${randomInt(10_000_000, 99_999_999)}`;
  }

  async function newClient(name = 'Cliente Teste') {
    const phone = randomPhone();
    return prisma.client.create({
      data: {
        phoneHash: index(phone),
        phoneEncrypted: cipher.encrypt('client.phone', phone),
        nameEncrypted: cipher.encrypt('client.name', name),
      },
    });
  }

  /** Horário aleatório num futuro distante, para execuções repetidas não colidirem. */
  function randomSlot(): { startsAt: Date; endsAt: Date } {
    const startsAt = new Date(
      Date.UTC(2100 + randomInt(0, 500), randomInt(0, 12), randomInt(1, 29), randomInt(0, 24)),
    );
    return { startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000) };
  }

  it('nome e telefone ficam ilegíveis numa leitura direta do banco', async () => {
    const phone = randomPhone();
    const client = await prisma.client.create({
      data: {
        phoneHash: index(phone),
        phoneEncrypted: cipher.encrypt('client.phone', phone),
        nameEncrypted: cipher.encrypt('client.name', 'Maria Aparecida'),
      },
    });
    const rows = await prisma.$queryRaw<Array<{ name_encrypted: string }>>`
      SELECT * FROM clients WHERE id = ${client.id}::uuid`;
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('Maria');
    expect(dump).not.toContain(phone.slice(-8));
    expect(cipher.decrypt('client.name', rows[0]!.name_encrypted)).toBe('Maria Aparecida');
  });

  it('o banco recusa dois agendamentos no mesmo horário e serviço', async () => {
    const [a, b] = [await newClient(), await newClient()];
    const slot = randomSlot();
    await prisma.appointment.create({
      data: { clientId: a.id, serviceType: 'PHYSIOTHERAPY', ...slot },
    });
    await expect(
      prisma.appointment.create({ data: { clientId: b.id, serviceType: 'PHYSIOTHERAPY', ...slot } }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // Outro serviço, mesmo horário: são agendas diferentes.
    await prisma.appointment.create({
      data: { clientId: b.id, serviceType: 'PERSONAL_TRAINING', ...slot },
    });
  });

  it('agendamento cancelado libera a vaga para outra pessoa', async () => {
    const [a, b] = [await newClient(), await newClient()];
    const slot = randomSlot();
    const first = await prisma.appointment.create({
      data: { clientId: a.id, serviceType: 'PHYSIOTHERAPY', ...slot },
    });
    await prisma.appointment.update({
      where: { id: first.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'CLIENT' },
    });
    const second = await prisma.appointment.create({
      data: { clientId: b.id, serviceType: 'PHYSIOTHERAPY', ...slot },
    });
    expect(second.status).toBe('CONFIRMED');
  });

  it('cancelamento sem data e autor é recusado (CHECK)', async () => {
    const a = await newClient();
    const appt = await prisma.appointment.create({
      data: { clientId: a.id, serviceType: 'PHYSIOTHERAPY', ...randomSlot() },
    });
    await expect(
      prisma.appointment.update({ where: { id: appt.id }, data: { status: 'CANCELLED' } }),
    ).rejects.toThrow(/appointments_cancel_check/);
  });

  it('anonimização pela metade é recusada (CHECK)', async () => {
    const a = await newClient();
    // Marca como anonimizado mas esquece o telefone cifrado: o banco não aceita.
    await expect(
      prisma.client.update({
        where: { id: a.id },
        data: { anonymizedAt: new Date(), phoneHash: null, nameEncrypted: null },
      }),
    ).rejects.toThrow(/clients_identity_check/);
    // Completa: aceita.
    const done = await prisma.client.update({
      where: { id: a.id },
      data: { anonymizedAt: new Date(), phoneHash: null, phoneEncrypted: null, nameEncrypted: null },
    });
    expect(done.anonymizedAt).not.toBeNull();
  });

  it('trilha de auditoria só aceita inclusão; expurgo só com a flag da transação', async () => {
    const appendOnly = /somente inclusão/;
    const event = await prisma.auditEvent.create({
      data: { actor: 'SYSTEM', action: 'test.event', entityType: 'test', entityId: '1' },
    });
    await expect(
      prisma.auditEvent.update({ where: { id: event.id }, data: { action: 'test.changed' } }),
    ).rejects.toThrow(appendOnly);
    await expect(prisma.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(appendOnly);
    await expect(prisma.$executeRawUnsafe('TRUNCATE audit_events')).rejects.toThrow(appendOnly);

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.audit_purge', 'on', true)`;
      await tx.auditEvent.delete({ where: { id: event.id } });
    });
    expect(await prisma.auditEvent.findUnique({ where: { id: event.id } })).toBeNull();

    // A flag não vaza para fora da transação.
    const other = await prisma.auditEvent.create({
      data: { actor: 'SYSTEM', action: 'test.event', entityType: 'test', entityId: '2' },
    });
    await expect(prisma.auditEvent.delete({ where: { id: other.id } })).rejects.toThrow(appendOnly);
  });

  it('texto de consentimento é imutável', async () => {
    const version = `teste-${randomBytes(4).toString('hex')}`;
    await prisma.consentText.create({ data: { version, body: 'Texto original' } });
    await expect(
      prisma.consentText.update({ where: { version }, data: { body: 'Texto trocado' } }),
    ).rejects.toThrow(/imutável/);
    await expect(prisma.consentText.delete({ where: { version } })).rejects.toThrow(/imutável/);
  });

  it('deduplicação de mensagens resiste a entregas simultâneas', async () => {
    const store = createPrismaDispatcherStore(prisma);
    const id = `wamid.TESTE_${randomBytes(6).toString('hex')}`;
    const results = await Promise.all([store.markProcessed(id), store.markProcessed(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.markProcessed(id)).toBe(false);
  });

  it('falha de entrega marca a mensagem da fila', async () => {
    const a = await newClient();
    const appt = await prisma.appointment.create({
      data: { clientId: a.id, serviceType: 'PHYSIOTHERAPY', ...randomSlot() },
    });
    const waMessageId = `wamid.OUT_${randomBytes(6).toString('hex')}`;
    await prisma.outboundMessage.create({
      data: {
        kind: 'CLIENT_REMINDER',
        appointmentId: appt.id,
        sendAfter: new Date(),
        status: 'SENT',
        waMessageId,
      },
    });
    const store = createPrismaDispatcherStore(prisma);
    expect(await store.markOutboundFailed(waMessageId, '131047')).toBe(1);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { waMessageId } });
    expect(row).toMatchObject({ status: 'FAILED', lastErrorCode: '131047' });
  });

  it('webhook de ponta a ponta: assinado -> 200 -> uma resposta, mesmo com reentrega', async () => {
    const { whatsapp, sent } = recordingWhatsApp();
    const app = createApp({
      webhookSink: createInboundDispatcher({
        store: createPrismaDispatcherStore(prisma),
        handler: createChatbot({
          prisma,
          whatsapp,
          timeZone: 'America/Sao_Paulo',
          privacyPolicyUrl: 'https://exemplo.com/privacidade',
          profile: PROFILES['fisio-personal'],
        }),
      }),
    });

    const phone = randomPhone();
    const body = JSON.stringify(
      webhookPayload({
        messages: [textMessage({ from: phone, id: `wamid.E2E_${randomBytes(6).toString('hex')}` })],
      }),
    );
    const signature = `sha256=${createHmac('sha256', process.env.WHATSAPP_APP_SECRET!)
      .update(body)
      .digest('hex')}`;

    for (let delivery = 0; delivery < 2; delivery++) {
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .send(body);
      expect(res.status).toBe(200);
      await drainBackgroundTasks(5_000);
    }

    // "Quero marcar fisioterapia..." -> aviso de consentimento, uma vez só.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(phone);
    expect(sent[0]!.interactive.action.buttons[0].reply.title).toBe('Concordo');
    // Antes do consentimento, nada sobre a pessoa é gravado.
    expect(await findClientByPhone(prisma, phone)).toBeNull();
  });

  it('a grade de horários recusa intervalos impossíveis (CHECK)', async () => {
    await expect(
      prisma.availabilityRule.create({
        data: {
          serviceType: 'PHYSIOTHERAPY',
          weekday: 7,
          startMinute: 600,
          endMinute: 540,
          slotMinutes: 60,
        },
      }),
    ).rejects.toThrow(/availability_rules_check/);
  });
});
