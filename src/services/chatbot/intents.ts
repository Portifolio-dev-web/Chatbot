import type { ServiceType } from '../../generated/prisma/client.js';
import type { ConversationState, Option } from '../conversation-state.js';
import type { MessageContent } from '../webhook-parser.js';
import { decodeReplyId } from './reply-ids.js';
import { MENU_OPTIONS } from './texts.js';

/*
 * Traduz a mensagem recebida numa intenção. Ordem de prioridade:
 * 1. toque em botão/lista: o id diz exatamente o que fazer;
 * 2. esperando o nome: o texto é o nome;
 * 3. texto que corresponde a uma opção da última pergunta ("2", "8h", "qui 09/10");
 * 4. número solto: item do menu;
 * 5. palavras-chave ("valores", "endereço", "dor no joelho" -> triagem para fisioterapia).
 *
 * PRIVACIDADE: o texto livre é lido aqui e descartado. Nada do que a pessoa escreve (por
 * exemplo, a queixa de saúde) é gravado nem vai para o log; só a intenção resultante.
 */

export type FaqTopic = 'prices' | 'location' | 'hours';

export type Intent =
  | { kind: 'menu'; greeting: boolean }
  | { kind: 'ask_service' }
  | { kind: 'suggest'; service: ServiceType }
  | { kind: 'book'; service: ServiceType }
  | { kind: 'faq'; topic: FaqTopic }
  | { kind: 'reception' }
  | { kind: 'my_appointments' }
  | { kind: 'privacy' }
  | { kind: 'consent'; service: ServiceType; version: string }
  | { kind: 'consent_declined' }
  | { kind: 'consent_typed' }
  | { kind: 'days'; service: ServiceType; page: number }
  | { kind: 'day'; service: ServiceType; day: string; page: number }
  | { kind: 'slot'; service: ServiceType; startsAt: Date }
  | { kind: 'confirm'; service: ServiceType; startsAt: Date }
  | { kind: 'cancel_ask'; appointmentId: string }
  | { kind: 'cancel_yes'; appointmentId: string }
  | { kind: 'delete_ask' }
  | { kind: 'delete_yes' }
  | { kind: 'reminder_confirm'; appointmentId: string }
  | { kind: 'reminder_change'; appointmentId: string }
  | { kind: 'reschedule'; appointmentId: string }
  | { kind: 'name'; name: string }
  | { kind: 'invalid_name' }
  | { kind: 'thanks' }
  | { kind: 'unsupported' }
  | { kind: 'unknown' };

/** minúsculas, sem acento, só letras/números/":" separados por um espaço. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, ' ')
    .trim();
}

/** "8h", "8:00", "08h00", "8 h" -> "08:00". */
function typedTime(normalized: string): string | undefined {
  const match = /^(\d{1,2})\s*(?:h|:)\s*(\d{2})?\s*h?$/.exec(normalized);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const stripNumber = (title: string): string => title.replace(/^\d{1,2}\.\s*/, '');

function matchOption(text: string, options: Option[]): Option | undefined {
  const t = normalize(text);
  if (/^\d{1,2}$/.test(t)) return options[Number(t) - 1];
  const time = typedTime(t);
  return options.find((option) => {
    const title = stripNumber(option.title);
    if (time && title === time) return true;
    const normalizedTitle = normalize(title);
    return normalizedTitle === t || (t.length >= 4 && normalizedTitle.endsWith(t));
  });
}

/**
 * Nome digitado: 2 a 80 caracteres, letras (com acento), espaço, apóstrofo, ponto e hífen.
 * Recusa números e símbolos (provável engano: "11 98765-4321", "ok").
 */
export function parseName(text: string): string | undefined {
  const name = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  const length = [...name].length;
  if (length < 2 || length > 80) return undefined;
  if (!/^\p{L}[\p{L}\p{M}' .-]*$/u.test(name)) return undefined;
  if ((name.match(/\p{L}/gu) ?? []).length < 2) return undefined;
  return name;
}

const words = (list: string): Set<string> => new Set(list.split(' '));

const EXIT = words('menu voltar inicio cancelar sair parar');
const GREETING = words('oi ola opa ei menu inicio comecar ajuda voltar');
const GREETING_PHRASES = ['bom dia', 'boa tarde', 'boa noite'];
const THANKS = words('obrigado obrigada valeu grato grata agradeco');
const MINE = words('cancelar desmarcar remarcar meus agendamentos');
const PRIVACY = words('privacidade lgpd apagar excluir deletar parar');
const CONSENT = words('concordo aceito');
const BOOKING = words('agendar marcar agendamento agenda consulta sessao vaga vagas avaliacao');
const SLOT_HINTS = words('disponivel disponiveis livre livres vaga vagas amanha hoje tem');
const PHYSIO = words(
  'fisio fisioterapia fisioterapeuta dor dores reabilitacao lesao lesoes coluna joelho ombro ' +
    'tendinite postura cirurgia operatorio',
);
const PERSONAL = words(
  'personal treino treinar treinador academia hipertrofia emagrecer emagrecimento ' +
    'condicionamento musculacao',
);
const PRICES = words('valor valores preco precos quanto custa custo pacote pacotes plano planos mensalidade');
const LOCATION = words('endereco onde localizacao local fica chegar mapa estacionamento');
const HOURS = words('horario horarios funcionamento abre abrem fecha fecham aberto atendem expediente');
const RECEPTION = words('recepcao atendente humano pessoa falar ligar telefone secretaria');

function hasAny(tokens: Set<string>, list: Set<string>): boolean {
  for (const token of tokens) if (list.has(token)) return true;
  return false;
}

function interpretText(text: string, state: ConversationState | null): Intent {
  const t = normalize(text);
  const tokens = new Set(t.split(' ').filter(Boolean));

  if (state?.step === 'awaiting_name') {
    if (tokens.size <= 2 && hasAny(tokens, EXIT)) return { kind: 'menu', greeting: false };
    const name = parseName(text);
    return name ? { kind: 'name', name } : { kind: 'invalid_name' };
  }

  if (state?.options.length) {
    const option = matchOption(text, state.options);
    const intent = option && decodeReplyId(option.id);
    if (intent) return intent;
  }

  if (/^\d{1,2}$/.test(t)) {
    const item = MENU_OPTIONS[Number(t) - 1];
    return (item && decodeReplyId(item.id)) || { kind: 'unknown' };
  }
  if (!t) return { kind: 'unknown' };

  if (t.includes('meus dados') || hasAny(tokens, PRIVACY)) return { kind: 'privacy' };
  if (hasAny(tokens, MINE)) return { kind: 'my_appointments' };
  if (hasAny(tokens, CONSENT)) return { kind: 'consent_typed' };

  const physio = hasAny(tokens, PHYSIO);
  const personal = hasAny(tokens, PERSONAL);
  const wantsSlot =
    hasAny(tokens, BOOKING) || (hasAny(tokens, HOURS) && hasAny(tokens, SLOT_HINTS));
  if (wantsSlot) {
    if (physio && !personal) return { kind: 'book', service: 'PHYSIOTHERAPY' };
    if (personal && !physio) return { kind: 'book', service: 'PERSONAL_TRAINING' };
    return { kind: 'ask_service' };
  }
  // Triagem: a pessoa descreveu o que procura, sem pedir horário.
  if (physio && !personal) return { kind: 'suggest', service: 'PHYSIOTHERAPY' };
  if (personal && !physio) return { kind: 'suggest', service: 'PERSONAL_TRAINING' };

  if (hasAny(tokens, PRICES)) return { kind: 'faq', topic: 'prices' };
  if (hasAny(tokens, LOCATION)) return { kind: 'faq', topic: 'location' };
  if (hasAny(tokens, HOURS)) return { kind: 'faq', topic: 'hours' };
  if (hasAny(tokens, RECEPTION)) return { kind: 'reception' };
  if (hasAny(tokens, GREETING) || GREETING_PHRASES.some((p) => t.includes(p))) {
    return { kind: 'menu', greeting: true };
  }
  if (hasAny(tokens, THANKS)) return { kind: 'thanks' };
  return { kind: 'unknown' };
}

export function interpret(content: MessageContent, state: ConversationState | null): Intent {
  switch (content.type) {
    case 'reply':
      return decodeReplyId(content.replyId) ?? { kind: 'unknown' };
    case 'unsupported':
      return { kind: 'unsupported' };
    case 'text':
      return interpretText(content.text, state);
  }
}
