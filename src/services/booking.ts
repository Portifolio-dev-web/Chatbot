import { BOOKING_RULES, REMINDER_SEND_WINDOW } from '../config/business-rules.js';
import { addDays, localDateOf, minutesOfDay, zonedToUtc } from '../lib/time.js';
import type {
  Actor,
  Appointment,
  Prisma,
  PrismaClient,
} from '../generated/prisma/client.js';
import { audit, type Db } from './audit.js';
import { findSlotIfFree } from './availability.js';

export type BookingFailure =
  /** Horário fora da grade/janela ou ocupado (inclusive por quem confirmou no mesmo instante). */
  | 'slot_unavailable'
  | 'too_many_future'
  /** O próprio cliente já tem outro horário que se sobrepõe. */
  | 'client_busy'
  /** Agendamento inexistente, de outro cliente, cancelado ou já passado. */
  | 'not_found'
  /** Cancelar pelo bot só até 24 h antes. */
  | 'too_late';

export class BookingError extends Error {
  override name = 'BookingError';
  constructor(readonly reason: BookingFailure) {
    super(reason);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

/**
 * Quando o lembrete sai: 24 h antes, mas nunca de madrugada. Fora da janela 8h–20h (fuso da
 * clínica), é adiantado para as 20h anteriores. Ex.: consulta às 07:00 de terça -> lembrete
 * às 20:00 de domingo, e não às 07:00 de segunda (horário em que muita gente ainda dorme).
 */
export function reminderTime(startsAt: Date, timeZone: string): Date {
  const ideal = new Date(startsAt.getTime() - BOOKING_RULES.reminderBeforeMs);
  const minute = minutesOfDay(ideal, timeZone);
  const day = localDateOf(ideal, timeZone);
  if (minute > REMINDER_SEND_WINDOW.toMinute) {
    return zonedToUtc(day, REMINDER_SEND_WINDOW.toMinute, timeZone);
  }
  if (minute < REMINDER_SEND_WINDOW.fromMinute) {
    return zonedToUtc(addDays(day, -1), REMINDER_SEND_WINDOW.toMinute, timeZone);
  }
  return ideal;
}

/**
 * Marca um horário. Tudo numa transação: o agendamento, os avisos na fila (recepção agora,
 * lembrete 24 h antes) e a auditoria; ou nada.
 *
 * Concorrência: a trava por serviço (pg_advisory_xact_lock) faz confirmações simultâneas do
 * mesmo serviço esperarem a vez, e a conferência de vaga acontece já com a trava. O índice
 * único appointments_slot_taken é a última barreira, se algo escapar.
 */
export async function bookAppointment(
  prisma: PrismaClient,
  input: { clientId: string; serviceType: string; startsAt: Date; now: Date; timeZone: string },
): Promise<Appointment> {
  const { clientId, serviceType, startsAt, now, timeZone } = input;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${serviceType}`}))`;

      const slot = await findSlotIfFree(tx, serviceType, startsAt, now, timeZone);
      if (!slot) throw new BookingError('slot_unavailable');

      const future = await tx.appointment.findMany({
        where: { clientId, status: 'CONFIRMED', startsAt: { gt: now } },
        select: { startsAt: true, endsAt: true },
      });
      if (future.length >= BOOKING_RULES.maxFutureAppointments) {
        throw new BookingError('too_many_future');
      }
      if (future.some((f) => f.startsAt < slot.endsAt && slot.startsAt < f.endsAt)) {
        throw new BookingError('client_busy');
      }

      const appointment = await tx.appointment.create({
        data: { clientId, serviceType, startsAt: slot.startsAt, endsAt: slot.endsAt },
      });

      const outbound: Prisma.OutboundMessageCreateManyInput[] = [
        { kind: 'RECEPTION_NEW_BOOKING', appointmentId: appointment.id, sendAfter: now },
      ];
      // Quem marca para daqui a poucas horas não precisa de lembrete "de 24 h".
      const remindAt = reminderTime(slot.startsAt, timeZone);
      if (remindAt.getTime() > now.getTime() + 30 * 60_000) {
        outbound.push({ kind: 'CLIENT_REMINDER', appointmentId: appointment.id, sendAfter: remindAt });
      }
      await tx.outboundMessage.createMany({ data: outbound });

      await audit(tx, {
        actor: 'CLIENT',
        action: 'appointment.created',
        entityType: 'appointment',
        entityId: appointment.id,
        detail: { serviceType, startsAt: startsAt.toISOString() },
      });
      return appointment;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new BookingError('slot_unavailable');
    throw err;
  }
}

/**
 * Cancelamento feito com menos de 24 h de antecedência? Calculado a partir das datas
 * gravadas, para o aviso à recepção (Passo 4B) dizer "cancelamento com menos de 24 h".
 */
export function isLateCancellation(appointment: Pick<Appointment, 'startsAt' | 'cancelledAt'>): boolean {
  return (
    appointment.cancelledAt !== null &&
    appointment.startsAt.getTime() - appointment.cancelledAt.getTime() <
      BOOKING_RULES.cancelMinNoticeMs
  );
}

/** Cancela dentro de uma transação já aberta (usado também pela anonimização). */
export async function cancelWithinTransaction(
  tx: Db,
  appointment: Pick<Appointment, 'id' | 'serviceType' | 'startsAt'>,
  actor: Actor,
  now: Date,
): Promise<void> {
  await tx.appointment.update({
    where: { id: appointment.id },
    data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: actor },
  });
  await tx.outboundMessage.updateMany({
    where: { appointmentId: appointment.id, kind: 'CLIENT_REMINDER', status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });
  // Se a recepção ainda nem recebeu o aviso do agendamento, não manda nenhum dos dois.
  const unsent = await tx.outboundMessage.updateMany({
    where: { appointmentId: appointment.id, kind: 'RECEPTION_NEW_BOOKING', status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });
  if (unsent.count === 0) {
    await tx.outboundMessage.createMany({
      data: [{ kind: 'RECEPTION_CANCELLATION', appointmentId: appointment.id, sendAfter: now }],
      skipDuplicates: true,
    });
  }
  await audit(tx, {
    actor,
    action: 'appointment.cancelled',
    entityType: 'appointment',
    entityId: appointment.id,
    detail: {
      serviceType: appointment.serviceType,
      late: isLateCancellation({ startsAt: appointment.startsAt, cancelledAt: now }),
    },
  });
}

/** Busca um agendamento futuro e confirmado DESTE cliente (nunca de outro: ver `clientId`). */
export async function findOwnUpcoming(
  db: Db,
  clientId: string,
  appointmentId: string,
  now: Date,
): Promise<Appointment | null> {
  return db.appointment.findFirst({
    where: { id: appointmentId, clientId, status: 'CONFIRMED', startsAt: { gt: now } },
  });
}

export async function cancelAppointment(
  prisma: PrismaClient,
  input: {
    clientId: string;
    appointmentId: string;
    now: Date;
    /**
     * Passo 4B, opção (A): o botão "Preciso remarcar" do lembrete cancela mesmo com menos
     * de 24 h. A recepção é avisada como "cancelamento com menos de 24 h" e decide se cobra.
     * Melhor saber e recuperar a vaga do que ter um "furo".
     */
    allowLate?: boolean;
  },
): Promise<Appointment> {
  return prisma.$transaction(async (tx) => {
    const appointment = await findOwnUpcoming(tx, input.clientId, input.appointmentId, input.now);
    if (!appointment) throw new BookingError('not_found');
    const late =
      appointment.startsAt.getTime() - input.now.getTime() < BOOKING_RULES.cancelMinNoticeMs;
    if (late && !input.allowLate) {
      throw new BookingError('too_late');
    }
    await cancelWithinTransaction(tx, appointment, 'CLIENT', input.now);
    return appointment;
  });
}

export async function upcomingAppointments(
  db: Db,
  clientId: string,
  now: Date,
): Promise<Appointment[]> {
  return db.appointment.findMany({
    where: { clientId, status: 'CONFIRMED', startsAt: { gt: now } },
    orderBy: { startsAt: 'asc' },
  });
}
