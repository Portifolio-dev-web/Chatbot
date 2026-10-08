import type { ServiceType } from '../generated/prisma/client.js';

/*
 * Grade de horários de EXEMPLO (usada pelo seed e pelos testes). Ajuste para a realidade da
 * clínica antes de colocar no ar; depois do primeiro seed, a grade vive no banco
 * (tabela availability_rules) e este arquivo não é mais lido.
 */

/** "08:30" -> 510 (minutos desde 00:00, no fuso da clínica). */
export function minutes(hhmm: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new Error(`horário inválido na grade: ${hhmm}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

const MON_FRI = [1, 2, 3, 4, 5];
const SATURDAY = [6];

const GRID: Array<{
  serviceType: ServiceType;
  weekdays: number[];
  windows: Array<[start: string, end: string]>;
  slotMinutes: number;
}> = [
  {
    serviceType: 'PHYSIOTHERAPY',
    weekdays: MON_FRI,
    windows: [
      ['08:00', '12:00'],
      ['14:00', '18:00'],
    ],
    slotMinutes: 60,
  },
  {
    serviceType: 'PERSONAL_TRAINING',
    weekdays: MON_FRI,
    windows: [
      ['06:00', '10:00'],
      ['17:00', '21:00'],
    ],
    slotMinutes: 60,
  },
  {
    serviceType: 'PERSONAL_TRAINING',
    weekdays: SATURDAY,
    windows: [['08:00', '12:00']],
    slotMinutes: 60,
  },
];

/** Linhas prontas para `availabilityRule.createMany`. */
export function defaultScheduleRows(): Array<{
  serviceType: ServiceType;
  weekday: number;
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
}> {
  return GRID.flatMap((group) =>
    group.weekdays.flatMap((weekday) =>
      group.windows.map(([start, end]) => ({
        serviceType: group.serviceType,
        weekday,
        startMinute: minutes(start),
        endMinute: minutes(end),
        slotMinutes: group.slotMinutes,
      })),
    ),
  );
}
