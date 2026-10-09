import { BOOKING_RULES } from '../config/business-rules.js';
import { addDays, compareDates, localDateOf, weekdayOf, zonedToUtc } from '../lib/time.js';
import type { Db } from './audit.js';

/*
 * Horários livres = grade semanal (availability_rules)
 *                   - bloqueios (schedule_blocks: feriados, férias)
 *                   - agendamentos que ocupam a vaga (não cancelados)
 *                   - o que estiver antes da antecedência mínima ou além do horizonte.
 */

export interface Interval {
  startsAt: Date;
  endsAt: Date;
}

export interface RuleInput {
  weekday: number;
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

/** Cálculo puro (sem banco), para ser testado à parte. Devolve em ordem, sem repetidos. */
export function computeFreeSlots(input: {
  rules: RuleInput[];
  busy: Interval[];
  from: Date;
  to: Date;
  timeZone: string;
}): Interval[] {
  const { rules, busy, from, to, timeZone } = input;
  const slots = new Map<number, Interval>();
  const last = localDateOf(to, timeZone);

  for (let day = localDateOf(from, timeZone); compareDates(day, last) <= 0; day = addDays(day, 1)) {
    const weekday = weekdayOf(day);
    for (const rule of rules) {
      if (rule.weekday !== weekday) continue;
      for (let m = rule.startMinute; m + rule.slotMinutes <= rule.endMinute; m += rule.slotMinutes) {
        const startsAt = zonedToUtc(day, m, timeZone);
        if (startsAt < from || startsAt > to) continue;
        const slot = { startsAt, endsAt: new Date(startsAt.getTime() + rule.slotMinutes * 60_000) };
        if (busy.some((b) => overlaps(slot, b))) continue;
        slots.set(startsAt.getTime(), slot);
      }
    }
  }
  return [...slots.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Janela em que o bot aceita marcar: de agora + antecedência mínima até o horizonte. */
export function bookingWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() + BOOKING_RULES.minNoticeMs),
    to: new Date(now.getTime() + BOOKING_RULES.horizonDays * 24 * 60 * 60_000),
  };
}

export async function findFreeSlots(
  db: Db,
  serviceType: string,
  window: { from: Date; to: Date },
  timeZone: string,
): Promise<Interval[]> {
  // Margem de um dia para pegar ocupações que começam antes da janela e invadem o horário.
  const margin = 24 * 60 * 60_000;
  const rangeStart = new Date(window.from.getTime() - margin);
  const rangeEnd = new Date(window.to.getTime() + margin);

  const rules = await db.availabilityRule.findMany({ where: { serviceType, active: true } });
  const blocks = await db.scheduleBlock.findMany({
    where: {
      OR: [{ serviceType }, { serviceType: null }],
      startsAt: { lt: rangeEnd },
      endsAt: { gt: rangeStart },
    },
    select: { startsAt: true, endsAt: true },
  });
  const taken = await db.appointment.findMany({
    where: {
      serviceType,
      status: { not: 'CANCELLED' },
      startsAt: { lt: rangeEnd },
      endsAt: { gt: rangeStart },
    },
    select: { startsAt: true, endsAt: true },
  });

  return computeFreeSlots({ rules, busy: [...blocks, ...taken], ...window, timeZone });
}

/** O horário exato ainda está livre e dentro da janela? Devolve o horário (com o fim) ou undefined. */
export async function findSlotIfFree(
  db: Db,
  serviceType: string,
  startsAt: Date,
  now: Date,
  timeZone: string,
): Promise<Interval | undefined> {
  const window = bookingWindow(now);
  if (startsAt < window.from || startsAt > window.to) return undefined;
  const slots = await findFreeSlots(db, serviceType, { from: startsAt, to: startsAt }, timeZone);
  return slots.find((s) => s.startsAt.getTime() === startsAt.getTime());
}
