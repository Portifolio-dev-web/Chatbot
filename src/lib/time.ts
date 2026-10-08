/*
 * Datas no fuso da clínica (CLINIC_TIMEZONE), sem biblioteca externa.
 * O banco guarda instantes em UTC; a grade de horários é "hora de parede" no fuso da clínica
 * ("08:00 de segunda em São Paulo"). Estas funções convertem entre os dois, e funcionam também
 * em fusos com horário de verão.
 *
 * Os nomes de dia em português são nossos (não do Intl): imagens Docker enxutas às vezes vêm
 * sem os dados de idioma, e o bot escreveria "Thursday".
 */

/** Data de calendário, sem hora. `month` vai de 1 a 12. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

interface ZonedParts extends LocalDate {
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

/** Diferença (ms) entre a hora de parede no fuso e o UTC, naquele instante. */
function offsetMs(instant: number, timeZone: string): number {
  const p = zonedParts(new Date(instant), timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return wall - Math.floor(instant / 60_000) * 60_000;
}

/** Instante (UTC) de uma data + minutos do dia, no fuso dado. */
export function zonedToUtc(date: LocalDate, minutesOfDay: number, timeZone: string): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minutesOfDay);
  // Duas passadas: a segunda corrige quando o palpite cai do outro lado de uma troca de fuso.
  const guess = wall - offsetMs(wall, timeZone);
  return new Date(wall - offsetMs(guess, timeZone));
}

export function localDateOf(date: Date, timeZone: string): LocalDate {
  const { year, month, day } = zonedParts(date, timeZone);
  return { year, month, day };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** 0 = domingo ... 6 = sábado (mesma convenção de availability_rules.weekday). */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "2026-10-09" */
export function dateKey(date: LocalDate): string {
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/** Lê "2026-10-09"; undefined se não for uma data real (ex.: 2026-02-30). */
export function parseDateKey(key: string): LocalDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return undefined;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return compareDates(addDays(date, 0), date) === 0 ? date : undefined;
}

const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const WEEKDAY_LONG = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
];

/** "Qui, 09/10" */
export function formatDayShort(date: LocalDate): string {
  return `${WEEKDAY_SHORT[weekdayOf(date)]}, ${pad(date.day)}/${pad(date.month)}`;
}

/** "08:00" */
export function formatTime(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "quinta-feira, 09/10 às 08:00" */
export function formatDateTime(date: Date, timeZone: string): string {
  const day = localDateOf(date, timeZone);
  return `${WEEKDAY_LONG[weekdayOf(day)]}, ${pad(day.day)}/${pad(day.month)} às ${formatTime(date, timeZone)}`;
}

/** Minutos desde 00:00 no fuso dado (08:30 -> 510). */
export function minutesOfDay(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

/** "09/10 08:00" (cabe num botão de 20 caracteres com "Cancelar "). */
export function formatShortDateTime(date: Date, timeZone: string): string {
  const day = localDateOf(date, timeZone);
  return `${pad(day.day)}/${pad(day.month)} ${formatTime(date, timeZone)}`;
}
