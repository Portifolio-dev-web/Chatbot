import { describe, expect, it } from 'vitest';
import { formatDateTime, zonedToUtc } from '../src/lib/time.js';
import { isLateCancellation, reminderTime } from '../src/services/booking.js';
import { decodeReplyId, replyIds } from '../src/services/chatbot/reply-ids.js';
import { isPermanentFailure } from '../src/services/outbox.js';
import { WhatsAppApiError } from '../src/services/whatsapp-client.js';

const SP = 'America/Sao_Paulo';
const at = (day: number, hour: number, minute = 0) =>
  zonedToUtc({ year: 2026, month: 10, day }, hour * 60 + minute, SP);
const when = (d: Date) => formatDateTime(d, SP);

describe('horário do lembrete', () => {
  it('de dia: exatamente 24 h antes', () => {
    expect(when(reminderTime(at(14, 10), SP))).toBe(when(at(13, 10)));
    expect(when(reminderTime(at(14, 20), SP))).toBe(when(at(13, 20))); // 20:00 ainda vale
  });

  it('cairia de madrugada cedo: adiantado para as 20h da véspera', () => {
    // Consulta quarta 07:00 -> lembrete segunda 20:00 (não terça 07:00).
    expect(when(reminderTime(at(14, 7), SP))).toBe(when(at(12, 20)));
  });

  it('cairia tarde da noite: adiantado para as 20h do mesmo dia', () => {
    expect(when(reminderTime(at(14, 21), SP))).toBe(when(at(13, 20)));
  });

  it('sempre com pelo menos 24 h de antecedência', () => {
    for (let hour = 0; hour < 24; hour++) {
      const startsAt = at(14, hour);
      expect(startsAt.getTime() - reminderTime(startsAt, SP).getTime()).toBeGreaterThanOrEqual(24 * 3600_000);
    }
  });
});

describe('cancelamento em cima da hora', () => {
  it('menos de 24 h entre cancelar e o horário', () => {
    expect(isLateCancellation({ startsAt: at(14, 10), cancelledAt: at(13, 11) })).toBe(true);
    expect(isLateCancellation({ startsAt: at(14, 10), cancelledAt: at(13, 9) })).toBe(false);
    expect(isLateCancellation({ startsAt: at(14, 10), cancelledAt: null })).toBe(false);
  });
});

describe('falha definitiva x temporária no envio', () => {
  const meta = (httpStatus: number | undefined, code: string) =>
    new WhatsAppApiError({ ...(httpStatus ? { httpStatus } : {}), code });

  it('vale tentar de novo: rede, 5xx, limite de envio, token', () => {
    expect(isPermanentFailure(meta(undefined, 'ECONNABORTED'))).toBe(false);
    expect(isPermanentFailure(meta(503, '131016'))).toBe(false);
    expect(isPermanentFailure(meta(400, '130429'))).toBe(false);
    expect(isPermanentFailure(meta(401, '190'))).toBe(false);
  });

  it('não adianta insistir: template inexistente, parâmetro errado, erro nosso', () => {
    expect(isPermanentFailure(meta(404, '132001'))).toBe(true);
    expect(isPermanentFailure(meta(400, '132000'))).toBe(true);
    expect(isPermanentFailure(new RangeError('limite'))).toBe(true);
  });
});

describe('ids dos botões do lembrete', () => {
  const id = '0199c0de-1234-7abc-8def-0123456789ab';
  it('ida e volta, e recusa adulterados', () => {
    expect(decodeReplyId(replyIds.remindOk(id))).toEqual({ kind: 'reminder_confirm', appointmentId: id });
    expect(decodeReplyId(replyIds.remindChange(id))).toEqual({ kind: 'reminder_change', appointmentId: id });
    expect(decodeReplyId(replyIds.reschedule(id))).toEqual({ kind: 'reschedule', appointmentId: id });
    expect(decodeReplyId(`remind:talvez:${id}`)).toBeUndefined();
    expect(decodeReplyId('remind:ok:123')).toBeUndefined();
  });
});
