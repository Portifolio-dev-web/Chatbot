import { parseDateKey } from '../../lib/time.js';
import { SERVICE_CODE } from '../../profiles/types.js';
import type { FaqTopic, Intent } from './intents.js';

/*
 * IDs dos botões e itens de lista. Cada id carrega a ação inteira ("slot:PHYSIOTHERAPY:<horário>"),
 * então tocar num botão funciona mesmo sem estado salvo, ou numa mensagem antiga.
 *
 * SEGURANÇA: o id volta pelo webhook como ENTRADA DO USUÁRIO. Tudo é validado aqui (formato) e
 * de novo no serviço (o horário ainda está livre? o agendamento é deste cliente?). Um id forjado
 * só consegue o mesmo que um toque legítimo.
 */

/**
 * O serviço vai no id pelo CÓDIGO (ex.: PHYSIOTHERAPY). Aqui só se confere o formato; se o
 * serviço existe no perfil desta instalação é o atendimento que confere (um botão antigo ou
 * forjado com serviço de outro perfil cai no menu).
 */
function parseService(code: string | undefined): string | undefined {
  return code && SERVICE_CODE.test(code) ? code : undefined;
}

/** Horário em minutos desde 1970, base 36: curto e sem caracteres especiais. */
const encodeTime = (date: Date): string => Math.floor(date.getTime() / 60_000).toString(36);

function decodeTime(text: string | undefined): Date | undefined {
  if (!text || !/^[0-9a-z]{1,10}$/.test(text)) return undefined;
  const date = new Date(parseInt(text, 36) * 60_000);
  const year = date.getUTCFullYear();
  return year >= 2020 && year <= 2200 ? date : undefined;
}

function parsePage(text: string | undefined): number | undefined {
  if (!text || !/^\d{1,2}$/.test(text)) return undefined;
  return Number(text);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[\w.-]{1,40}$/;
const FAQ_TOPICS: readonly FaqTopic[] = ['prices', 'location', 'hours'];

export const replyIds = {
  menu: 'menu',
  askService: 'book',
  book: (s: string) => `book:${s}`,
  faq: (topic: FaqTopic) => `faq:${topic}`,
  reception: 'reception',
  myAppointments: 'mine',
  privacy: 'privacy',
  consentYes: (s: string, version: string) => `consent:${s}:${version}`,
  consentNo: 'consent:no',
  days: (s: string, page = 0) => `days:${s}:${page}`,
  day: (s: string, key: string, page = 0) => `day:${s}:${key}:${page}`,
  slot: (s: string, startsAt: Date) => `slot:${s}:${encodeTime(startsAt)}`,
  confirm: (s: string, startsAt: Date) => `confirm:${s}:${encodeTime(startsAt)}`,
  cancelAsk: (appointmentId: string) => `cancel:${appointmentId}`,
  cancelYes: (appointmentId: string) => `cancelyes:${appointmentId}`,
  deleteAsk: 'delete',
  deleteYes: 'deleteyes',
  // Passo 4B: botões do template de lembrete ("Confirmo" / "Preciso remarcar").
  remindOk: (appointmentId: string) => `remind:ok:${appointmentId}`,
  remindChange: (appointmentId: string) => `remind:change:${appointmentId}`,
  reschedule: (appointmentId: string) => `resched:${appointmentId}`,
  // Perfis com menores: "para quem é a sessão?".
  who: (s: string, audience: WhoAnswer) => `who:${s}:${audience}`,
} as const;

export type WhoAnswer = 'self' | 'minor' | 'other';
const WHO_ANSWERS: readonly WhoAnswer[] = ['self', 'minor', 'other'];

/** Lê um id de botão/item. undefined = id desconhecido ou adulterado. */
export function decodeReplyId(id: string): Intent | undefined {
  const [head, a, b, c, ...extra] = id.split(':');
  if (extra.length > 0) return undefined;
  const none = a === undefined;

  switch (head) {
    case 'menu':
      return none ? { kind: 'menu', greeting: false } : undefined;
    case 'reception':
      return none ? { kind: 'reception' } : undefined;
    case 'mine':
      return none ? { kind: 'my_appointments' } : undefined;
    case 'privacy':
      return none ? { kind: 'privacy' } : undefined;
    case 'delete':
      return none ? { kind: 'delete_ask' } : undefined;
    case 'deleteyes':
      return none ? { kind: 'delete_yes' } : undefined;
    case 'book': {
      if (none) return { kind: 'ask_service' };
      const service = parseService(a);
      return service && b === undefined ? { kind: 'book', service } : undefined;
    }
    case 'faq': {
      const topic = FAQ_TOPICS.find((t) => t === a);
      return topic && b === undefined ? { kind: 'faq', topic } : undefined;
    }
    case 'consent': {
      if (a === 'no' && b === undefined) return { kind: 'consent_declined' };
      const service = parseService(a);
      return service && b && VERSION.test(b) && c === undefined
        ? { kind: 'consent', service, version: b }
        : undefined;
    }
    case 'days': {
      const service = parseService(a);
      const page = parsePage(b);
      return service && page !== undefined && c === undefined
        ? { kind: 'days', service, page }
        : undefined;
    }
    case 'day': {
      const service = parseService(a);
      const page = parsePage(c);
      return service && b && parseDateKey(b) && page !== undefined
        ? { kind: 'day', service, day: b, page }
        : undefined;
    }
    case 'slot':
    case 'confirm': {
      const service = parseService(a);
      const startsAt = decodeTime(b);
      if (!service || !startsAt || c !== undefined) return undefined;
      return { kind: head, service, startsAt };
    }
    case 'cancel':
    case 'cancelyes':
      return a && UUID.test(a) && b === undefined
        ? { kind: head === 'cancel' ? 'cancel_ask' : 'cancel_yes', appointmentId: a }
        : undefined;
    case 'remind':
      if (!b || !UUID.test(b) || c !== undefined) return undefined;
      if (a === 'ok') return { kind: 'reminder_confirm', appointmentId: b };
      if (a === 'change') return { kind: 'reminder_change', appointmentId: b };
      return undefined;
    case 'resched':
      return a && UUID.test(a) && b === undefined
        ? { kind: 'reschedule', appointmentId: a }
        : undefined;
    case 'who': {
      const service = parseService(a);
      const audience = WHO_ANSWERS.find((w) => w === b);
      return service && audience && c === undefined
        ? { kind: 'who', service, audience }
        : undefined;
    }
    default:
      return undefined;
  }
}
