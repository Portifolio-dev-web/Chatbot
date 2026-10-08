import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatDateTime,
  formatDayShort,
  formatShortDateTime,
  localDateOf,
  parseDateKey,
  weekdayOf,
  zonedToUtc,
} from '../src/lib/time.js';
import { computeFreeSlots } from '../src/services/availability.js';

const SP = 'America/Sao_Paulo';

describe('datas no fuso da clínica', () => {
  it('08:00 em São Paulo = 11:00 UTC (sem horário de verão desde 2019)', () => {
    const d = zonedToUtc({ year: 2026, month: 10, day: 9 }, 8 * 60, SP);
    expect(d.toISOString()).toBe('2026-10-09T11:00:00.000Z');
  });

  it('acerta nos dois lados de uma troca de horário de verão (Nova York)', () => {
    const ny = 'America/New_York';
    // 8/mar/2026: os relógios pulam de 02:00 para 03:00.
    expect(zonedToUtc({ year: 2026, month: 3, day: 7 }, 9 * 60, ny).toISOString()).toBe(
      '2026-03-07T14:00:00.000Z',
    );
    expect(zonedToUtc({ year: 2026, month: 3, day: 9 }, 9 * 60, ny).toISOString()).toBe(
      '2026-03-09T13:00:00.000Z',
    );
  });

  it('a data local de um instante perto da meia-noite UTC', () => {
    // 01:30 UTC do dia 10 ainda é dia 9 em São Paulo.
    expect(localDateOf(new Date('2026-10-10T01:30:00Z'), SP)).toEqual({ year: 2026, month: 10, day: 9 });
  });

  it('dias da semana, virada de mês e ano bissexto', () => {
    expect(weekdayOf({ year: 2026, month: 10, day: 9 })).toBe(5); // sexta
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(parseDateKey('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseDateKey('2026-02-29')).toBeUndefined();
    expect(parseDateKey('2026-13-01')).toBeUndefined();
    expect(parseDateKey('ontem')).toBeUndefined();
  });

  it('formata em português, sem depender dos dados de idioma do sistema', () => {
    const d = new Date('2026-10-09T11:00:00Z');
    expect(formatDayShort({ year: 2026, month: 10, day: 9 })).toBe('Sex, 09/10');
    expect(formatDateTime(d, SP)).toBe('sexta-feira, 09/10 às 08:00');
    expect(formatShortDateTime(d, SP)).toBe('09/10 08:00');
  });
});

describe('computeFreeSlots', () => {
  // Sexta-feira, 9/out/2026, das 08:00 às 12:00, sessões de 60 min.
  const rules = [{ weekday: 5, startMinute: 8 * 60, endMinute: 12 * 60, slotMinutes: 60 }];
  const day = { year: 2026, month: 10, day: 9 };
  const at = (h: number, m = 0) => zonedToUtc(day, h * 60 + m, SP);
  const times = (slots: Array<{ startsAt: Date }>) =>
    slots.map((s) => formatShortDateTime(s.startsAt, SP).slice(6));
  const base = { rules, busy: [], from: at(0), to: at(23, 59), timeZone: SP };

  it('gera os horários da grade, sem passar do fim do turno', () => {
    expect(times(computeFreeSlots(base))).toEqual(['08:00', '09:00', '10:00', '11:00']);
  });

  it('respeita o início da janela (antecedência mínima)', () => {
    expect(times(computeFreeSlots({ ...base, from: at(9, 30) }))).toEqual(['10:00', '11:00']);
  });

  it('tira horários ocupados e os que encostam num bloqueio', () => {
    const busy = [
      { startsAt: at(9), endsAt: at(10) }, // agendamento
      { startsAt: at(10, 30), endsAt: at(10, 45) }, // bloqueio no meio da sessão das 10h
    ];
    expect(times(computeFreeSlots({ ...base, busy }))).toEqual(['08:00', '11:00']);
  });

  it('não oferece horário em dia sem grade', () => {
    const saturday = { year: 2026, month: 10, day: 10 };
    const slots = computeFreeSlots({
      ...base,
      from: zonedToUtc(saturday, 0, SP),
      to: zonedToUtc(saturday, 23 * 60, SP),
    });
    expect(slots).toEqual([]);
  });

  it('regras sobrepostas não geram horário repetido', () => {
    const slots = computeFreeSlots({ ...base, rules: [...rules, ...rules] });
    expect(times(slots)).toEqual(['08:00', '09:00', '10:00', '11:00']);
  });
});
