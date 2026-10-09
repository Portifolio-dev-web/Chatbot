import type { ScheduleTemplate } from '../profiles/index.js';

/*
 * Converte a grade de EXEMPLO de um perfil (src/profiles) em linhas de availability_rules.
 * Usado pelo seed e pelos testes. Depois do primeiro seed, a grade vive no banco e é lá que a
 * clínica a ajusta.
 */

/** "08:30" -> 510 (minutos desde 00:00, no fuso da clínica). */
export function minutes(hhmm: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new Error(`horário inválido na grade: ${hhmm}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Linhas prontas para `availabilityRule.createMany`. */
export function scheduleRows(templates: readonly ScheduleTemplate[]): Array<{
  serviceType: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
  sessionMinutes: number | null;
}> {
  return templates.flatMap((template) =>
    template.weekdays.flatMap((weekday) =>
      template.windows.map(([start, end]) => ({
        serviceType: template.serviceCode,
        weekday,
        startMinute: minutes(start),
        endMinute: minutes(end),
        slotMinutes: template.slotMinutes,
        sessionMinutes: template.sessionMinutes ?? null,
      })),
    ),
  );
}
