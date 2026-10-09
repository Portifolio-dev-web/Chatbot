import { BOOKING_RULES, MESSAGE_RATE_LIMIT } from '../../config/business-rules.js';
import { currentConsentText, type Audience } from '../../content/consent.js';
import { TEMPLATE_LANGUAGE, TEMPLATES } from '../../content/templates.js';
import type { Client, PrismaClient } from '../../generated/prisma/client.js';
import { createKeyedMutex, createRateLimiter } from '../../lib/concurrency.js';
import { getFieldCipher, normalizePhone, phoneIndex } from '../../lib/crypto.js';
import { getLogger, safeError } from '../../lib/logger.js';
import {
  addDays,
  dateKey,
  formatDateTime,
  formatDayShort,
  formatShortDateTime,
  formatTime,
  localDateOf,
  parseDateKey,
  zonedToUtc,
  type LocalDate,
} from '../../lib/time.js';
import {
  serviceByCode,
  serviceLabel,
  type Profile,
  type ServiceDefinition,
} from '../../profiles/index.js';
import { audit } from '../audit.js';
import { bookingWindow, findFreeSlots, findSlotIfFree, type Interval } from '../availability.js';
import {
  BookingError,
  bookAppointment,
  cancelAppointment,
  findOwnUpcoming,
  upcomingAppointments,
  type BookingFailure,
} from '../booking.js';
import {
  anonymizeClient,
  decryptName,
  decryptPatientName,
  findClientByPhone,
  hasCurrentConsent,
  recordConsent,
  setClientName,
  touchClient,
} from '../clients.js';
import {
  clearState,
  loadState,
  saveState,
  type ConversationState,
  type Step,
} from '../conversation-state.js';
import type { MessageHandler } from '../inbound-dispatcher.js';
import type { InboundMessage } from '../webhook-parser.js';
import {
  WhatsAppApiError,
  type ListSection,
  type ReplyButton,
  type WhatsAppClient,
} from '../whatsapp-client.js';
import { interpret, type FaqTopic, type Intent } from './intents.js';
import { replyIds } from './reply-ids.js';
import { BUTTONS, TEXTS, buildMenu, contactButton, serviceButtons } from './texts.js';

/*
 * O atendimento: recebe uma mensagem, entende a intenção (intents.ts), responde e guarda a
 * etapa do funil (conversation-state.ts).
 *
 * Funil de agendamento: serviço -> [para quem é] -> consentimento (só na 1ª vez) -> dia ->
 * horário -> nome (só na 1ª vez) -> [nome do paciente menor] -> confirmação. Cada etapa
 * revalida o que importa (consentimento vigente, horário ainda livre, agendamento pertence a
 * quem pede), porque o cliente pode tocar num botão de uma mensagem antiga.
 *
 * Os serviços e as regras do tipo de atendimento (menores, alerta de crise, discrição) vêm do
 * PERFIL da instalação (CLINIC_PROFILE, src/profiles).
 */

/** Alerta de crise para o mesmo contato: no máximo 1 a cada 30 min (não inunda a profissional). */
const CRISIS_ALERT_INTERVAL_MS = 30 * 60_000;

export interface ChatbotDeps {
  prisma: PrismaClient;
  whatsapp: WhatsAppClient;
  timeZone: string;
  privacyPolicyUrl: string | undefined;
  /** Perfil da instalação: serviços, menu, triagem e regras do tipo de atendimento. */
  profile: Profile;
  /** Quem recebe o alerta de crise (RECEPTION_WHATSAPP). Sem ele, só a pessoa é orientada. */
  alertPhone: string | undefined;
  now?: () => Date;
}

/** Estado que vive enquanto o processo vive (não vai para o banco). */
interface Runtime {
  crisisAlerts: { allow(key: string): boolean };
}

/** Uma mensagem sendo atendida: quem é, onde parou e como responder. */
class Turn {
  /** Para quem é a sessão (perfis com menores). Persiste entre as etapas do funil. */
  audience: Audience | undefined;
  /** [CRIPTOGRAFADO] nome do paciente menor, entre a pergunta e a confirmação. */
  patientNameEncrypted: string | undefined;

  constructor(
    readonly deps: ChatbotDeps,
    readonly runtime: Runtime,
    readonly message: InboundMessage,
    public client: Client | null,
    readonly state: ConversationState | null,
    readonly now: Date,
  ) {
    this.audience = state?.audience;
    this.patientNameEncrypted = state?.patientNameEncrypted;
  }

  get prisma(): PrismaClient {
    return this.deps.prisma;
  }
  get tz(): string {
    return this.deps.timeZone;
  }
  get profile(): Profile {
    return this.deps.profile;
  }
  /** Nome do serviço de um agendamento (pode ser de um serviço que saiu do perfil). */
  label(code: string): string {
    return serviceLabel(this.deps.profile, code);
  }

  async text(body: string): Promise<void> {
    await this.deps.whatsapp.sendText(this.message.from, body);
  }

  /**
   * `typedChoice: false` = digitar o número NÃO vale como escolha. Usado onde a decisão
   * precisa ser um toque inequívoco: consentimento (prova, LGPD art. 8º) e apagar os dados
   * (irreversível).
   */
  async buttons(
    step: Step,
    body: string,
    buttons: ReplyButton[],
    { typedChoice = true }: { typedChoice?: boolean } = {},
  ): Promise<void> {
    await this.remember({
      step,
      options: typedChoice ? buttons.map(({ id, title }) => ({ id, title })) : [],
    });
    await this.deps.whatsapp.sendButtons(this.message.from, body, buttons);
  }

  async list(step: Step, body: string, buttonLabel: string, sections: ListSection[]): Promise<void> {
    const options = sections.flatMap((s) => s.rows.map(({ id, title }) => ({ id, title })));
    await this.remember({ step, options });
    await this.deps.whatsapp.sendList(this.message.from, body, buttonLabel, sections);
  }

  /**
   * Só quem já é cliente tem estado salvo (antes do consentimento, nada é gravado). O público
   * e o nome do paciente acompanham todas as etapas até a confirmação.
   */
  async remember(state: ConversationState): Promise<void> {
    if (!this.client) return;
    await saveState(
      this.prisma,
      this.client.id,
      {
        ...state,
        audience: state.audience ?? this.audience,
        patientNameEncrypted: state.patientNameEncrypted ?? this.patientNameEncrypted,
      },
      this.now,
    );
  }

  /** Início de um novo agendamento: esquece o público e o paciente do anterior. */
  resetFunnel(): void {
    this.audience = undefined;
    this.patientNameEncrypted = undefined;
  }

  async forget(): Promise<void> {
    this.resetFunnel();
    if (this.client) await clearState(this.prisma, this.client.id);
  }
}

export function createChatbot(deps: ChatbotDeps): MessageHandler {
  const now = deps.now ?? (() => new Date());
  const runExclusive = createKeyedMutex();
  const limiter = createRateLimiter(MESSAGE_RATE_LIMIT.max, MESSAGE_RATE_LIMIT.windowMs, () =>
    now().getTime(),
  );
  const runtime: Runtime = {
    crisisAlerts: createRateLimiter(1, CRISIS_ALERT_INTERVAL_MS, () => now().getTime()),
  };

  return {
    async handle(message) {
      // A chave é o índice cego do telefone: nem a memória do processo guarda o número em claro.
      const key = phoneIndex(message.from);
      if (!limiter.allow(key)) {
        getLogger().warn('limite de mensagens por minuto atingido; mensagem ignorada');
        return;
      }
      await runExclusive(key, () => handleTurn(deps, runtime, message, now()));
    },
  };
}

async function handleTurn(
  deps: ChatbotDeps,
  runtime: Runtime,
  message: InboundMessage,
  now: Date,
): Promise<void> {
  const logger = getLogger();
  // Os tiques azuis são cortesia: se falharem, o atendimento segue.
  await deps.whatsapp.markAsRead(message.id).catch((err: unknown) => {
    logger.warn({ err: safeError(err) }, 'não foi possível marcar como lida');
  });

  const client = await findClientByPhone(deps.prisma, message.from);
  if (client) await touchClient(deps.prisma, client.id, now);
  const state = client ? await loadState(deps.prisma, client.id, now) : null;
  const intent = interpret(message.content, state, deps.profile);

  // PRIVACIDADE: só a intenção e a etapa; nunca o texto, o nome ou o telefone.
  logger.info({ intent: intent.kind, step: state?.step ?? null, knownClient: client !== null }, 'atendimento');

  const turn = new Turn(deps, runtime, message, client, state, now);
  try {
    await respond(turn, intent);
  } catch (err) {
    await deps.whatsapp.sendText(message.from, TEXTS.technicalProblem).catch(() => undefined);
    throw err;
  }
}

type ServiceIntent = Extract<Intent, { service: string }>;

async function respond(turn: Turn, intent: Intent): Promise<void> {
  if ('service' in intent) {
    const service = serviceByCode(turn.profile, intent.service);
    // Serviço que não existe neste perfil: botão de outra instalação, de antes de uma troca
    // de perfil, ou id forjado. Nada é agendado; a pessoa volta ao menu.
    if (!service) return sendMenu(turn, TEXTS.didNotUnderstand);
    return respondForService(turn, intent, service);
  }
  switch (intent.kind) {
    case 'crisis':
      return crisis(turn);
    case 'menu':
      return sendMenu(turn, intent.greeting ? TEXTS.welcome(turn.profile) : TEXTS.howCanIHelp);
    case 'unknown':
      return sendMenu(turn, TEXTS.didNotUnderstand);
    case 'unsupported':
      return sendMenu(turn, TEXTS.unsupported(turn.profile));
    case 'thanks':
      return turn.buttons('info', TEXTS.thanks, [BUTTONS.menu]);
    case 'ask_service':
      return askService(turn);
    case 'faq':
      return sendFaq(turn, intent.topic);
    case 'reception':
      return turn.buttons('info', TEXTS.reception(turn.profile), [BUTTONS.menu]);
    case 'consent_declined':
      await turn.forget();
      return turn.buttons('info', TEXTS.consentDeclined(turn.profile), [BUTTONS.menu]);
    case 'consent_typed':
      return consentTyped(turn);
    case 'name':
      return saveName(turn, intent.name);
    case 'invalid_name':
      return retryName(turn);
    case 'my_appointments':
      return myAppointments(turn);
    case 'cancel_ask':
      return cancelAsk(turn, intent.appointmentId);
    case 'cancel_yes':
      return cancelYes(turn, intent.appointmentId);
    case 'privacy':
      return privacy(turn);
    case 'delete_ask':
      return deleteAsk(turn);
    case 'delete_yes':
      return deleteYes(turn);
    case 'reminder_confirm':
      return reminderConfirm(turn, intent.appointmentId);
    case 'reminder_change':
      return reminderChange(turn, intent.appointmentId);
    case 'reschedule':
      return reschedule(turn, intent.appointmentId);
  }
}

async function respondForService(
  turn: Turn,
  intent: ServiceIntent,
  service: ServiceDefinition,
): Promise<void> {
  switch (intent.kind) {
    case 'suggest':
      return suggestService(turn, service);
    case 'book':
      return startBooking(turn, service);
    case 'who':
      return chooseAudience(turn, service, intent.audience);
    case 'consent':
      return acceptConsent(turn, service, intent.version);
    case 'days':
      return withConsent(turn, service, () => sendDays(turn, service, intent.page));
    case 'day':
      return withConsent(turn, service, () => sendSlots(turn, service, intent.day, intent.page));
    case 'slot':
      return withConsent(turn, service, () => chooseSlot(turn, service, intent.startsAt));
    case 'confirm':
      return withConsent(turn, service, () => confirmBooking(turn, service, intent.startsAt));
  }
}

// ---------------------------------------------------------------------------
// Crise (ver crisis.ts): contatos de emergência sempre; alerta à profissional se o perfil pede
// ---------------------------------------------------------------------------

async function crisis(turn: Turn): Promise<void> {
  const logger = getLogger();
  // 1) Primeiro os contatos de emergência: é o que mais importa e não depende de mais nada.
  await turn.text(TEXTS.crisisSupport);

  // 2) Alerta (perfil com crisisAlert). Base legal: proteção da vida (LGPD art. 11, II, "e"),
  //    por isso vale mesmo para quem ainda não consentiu. Vai só o contato e a hora; o texto
  //    da mensagem não sai daqui.
  const key = phoneIndex(turn.message.from);
  let alerted = false;
  let alertErrorCode: string | undefined;
  if (turn.profile.crisisAlert && turn.deps.alertPhone && turn.runtime.crisisAlerts.allow(key)) {
    try {
      await turn.deps.whatsapp.sendTemplate(turn.deps.alertPhone, {
        name: TEMPLATES.crisisAlert,
        language: TEMPLATE_LANGUAGE,
        bodyParams: [`+${normalizePhone(turn.message.from)}`, formatDateTime(turn.now, turn.tz)],
      });
      alerted = true;
      await turn.text(TEXTS.crisisAlerted(turn.profile));
    } catch (err) {
      alertErrorCode = err instanceof WhatsAppApiError ? err.code : 'INVALID';
      logger.error({ err: safeError(err) }, 'crise: não foi possível alertar a profissional');
    }
  }
  logger.warn({ alerted }, 'mensagem com possível risco: contatos de emergência enviados');
  await audit(turn.prisma, {
    actor: 'SYSTEM',
    action: 'crisis.detected',
    entityType: turn.client ? 'client' : 'contact',
    entityId: turn.client?.id ?? key,
    detail: { alerted, ...(alertErrorCode ? { alertErrorCode } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Menu, triagem e dúvidas frequentes
// ---------------------------------------------------------------------------

function sendMenu(turn: Turn, body: string): Promise<void> {
  return turn.list('menu', body, 'Ver opções', buildMenu(turn.profile));
}

/** Com um serviço só no perfil, não há o que perguntar: vai direto para o agendamento. */
function askService(turn: Turn): Promise<void> {
  const [only, ...others] = turn.profile.services;
  if (only && others.length === 0) return startBooking(turn, only);
  return turn.buttons(
    'choosing_service',
    TEXTS.whichService(turn.profile),
    serviceButtons(turn.profile),
  );
}

/** Triagem: a pessoa descreveu o que procura ("dor no joelho"); sugerimos o serviço. */
function suggestService(turn: Turn, service: ServiceDefinition): Promise<void> {
  return turn.buttons('choosing_service', service.suggestion, [
    { id: replyIds.book(service.code), title: 'Agendar' },
    BUTTONS.menu,
  ]);
}

async function sendFaq(turn: Turn, topic: FaqTopic): Promise<void> {
  const body = {
    prices: TEXTS.prices,
    location: () => TEXTS.location(turn.profile),
    hours: TEXTS.hours,
  }[topic]();
  const buttons = [BUTTONS.book, BUTTONS.menu];
  // Mensagem com botões aceita até 1024 caracteres; tabela de preços maior vai em texto.
  if ([...body].length <= 1024) return turn.buttons('info', body, buttons);
  await turn.text(body);
  return turn.buttons('info', TEXTS.anythingElse, buttons);
}

// ---------------------------------------------------------------------------
// Início do agendamento: para quem é (perfis com menores) e consentimento (LGPD arts. 11 e 14)
// ---------------------------------------------------------------------------

/** Começo de um agendamento novo. Perfis com menores perguntam antes para quem é. */
function startBooking(turn: Turn, service: ServiceDefinition): Promise<void> {
  turn.resetFunnel();
  if (turn.profile.audience === 'adults_and_minors') return askAudience(turn, service);
  return withConsent(turn, service, () => sendDays(turn, service, 0));
}

function askAudience(turn: Turn, service: ServiceDefinition): Promise<void> {
  turn.resetFunnel();
  return turn.buttons('choosing_audience', TEXTS.whoIsPatient, [
    { id: replyIds.who(service.code, 'self'), title: 'Para mim' },
    { id: replyIds.who(service.code, 'minor'), title: 'Para menor de 18' },
    { id: replyIds.who(service.code, 'other'), title: 'Para outro adulto' },
  ]);
}

async function chooseAudience(
  turn: Turn,
  service: ServiceDefinition,
  answer: 'self' | 'minor' | 'other',
): Promise<void> {
  // Botão de "para quem é" num perfil que não atende menores (antigo ou forjado).
  if (turn.profile.audience !== 'adults_and_minors') return sendMenu(turn, TEXTS.didNotUnderstand);
  if (answer === 'other') {
    turn.resetFunnel();
    return turn.buttons('info', TEXTS.otherAdult(turn.profile), [BUTTONS.menu]);
  }
  turn.resetFunnel();
  turn.audience = answer;
  return withConsent(turn, service, () => sendDays(turn, service, 0));
}

/** Consentimentos possíveis neste perfil (o do próprio paciente e, se houver, o do responsável). */
function consentAudiences(profile: Profile): Audience[] {
  return profile.audience === 'adults_and_minors' ? ['self', 'minor'] : ['self'];
}

async function withConsent(
  turn: Turn,
  service: ServiceDefinition,
  next: () => Promise<void>,
): Promise<void> {
  // Perfis com menores precisam saber para quem é ANTES do consentimento (os textos são
  // diferentes). Estado vencido no meio do funil: pergunta de novo.
  if (turn.profile.audience === 'adults_and_minors' && !turn.audience) {
    return askAudience(turn, service);
  }
  const audience = turn.audience ?? 'self';
  const { version } = currentConsentText(turn.deps.privacyPolicyUrl, turn.profile, audience);
  if (turn.client && (await hasCurrentConsent(turn.prisma, turn.client.id, version))) return next();
  return sendConsentPrompt(turn, service, audience);
}

function sendConsentPrompt(
  turn: Turn,
  service: ServiceDefinition,
  audience: Audience,
): Promise<void> {
  const consent = currentConsentText(turn.deps.privacyPolicyUrl, turn.profile, audience);
  // A versão vai no id do botão: o toque prova QUAL texto a pessoa leu (e, por ele, se ela
  // consentiu como paciente ou como responsável).
  return turn.buttons(
    'choosing_service',
    consent.body,
    [
      { id: replyIds.consentYes(service.code, consent.version), title: 'Concordo' },
      { id: replyIds.consentNo, title: 'Não concordo' },
    ],
    { typedChoice: false },
  );
}

/** "concordo" digitado não vale como consentimento (precisa do toque no botão). */
async function consentTyped(turn: Turn): Promise<void> {
  const [only, ...others] = turn.profile.services;
  if (only && others.length === 0) {
    await turn.text(TEXTS.consentNeedsButton);
    return startBooking(turn, only);
  }
  return turn.buttons(
    'choosing_service',
    `${TEXTS.consentNeedsButton} ${TEXTS.whichServiceShort}`,
    serviceButtons(turn.profile),
  );
}

async function acceptConsent(
  turn: Turn,
  service: ServiceDefinition,
  version: string,
): Promise<void> {
  const match = consentAudiences(turn.profile)
    .map((audience) => ({
      audience,
      text: currentConsentText(turn.deps.privacyPolicyUrl, turn.profile, audience),
    }))
    .find((candidate) => candidate.text.version === version);
  if (!match) {
    // Tocou no "Concordo" de um aviso antigo: o texto mudou desde então.
    await turn.text(TEXTS.consentUpdated);
    return withConsent(turn, service, () => sendDays(turn, service, 0));
  }
  turn.audience = match.audience;
  turn.client = await recordConsent(turn.prisma, {
    phone: turn.message.from,
    version: match.text.version,
    body: match.text.body,
    evidenceMessageId: turn.message.id,
    now: turn.now,
  });
  return sendDays(turn, service, 0);
}

// ---------------------------------------------------------------------------
// Agendamento: dia -> horário -> nome -> [paciente] -> confirmação
// ---------------------------------------------------------------------------

/** Até 10 itens por lista; com mais, mostra 9 e um "Mais..." para a página seguinte. */
function paginate<T>(items: T[], page: number): { items: T[]; nextPage: number | undefined } {
  const start = page * 9 < items.length ? page * 9 : 0;
  const rest = items.slice(start);
  if (rest.length <= 10) return { items: rest, nextPage: undefined };
  return { items: rest.slice(0, 9), nextPage: start / 9 + 1 };
}

async function sendDays(turn: Turn, service: ServiceDefinition, page: number): Promise<void> {
  const slots = await findFreeSlots(turn.prisma, service.code, bookingWindow(turn.now), turn.tz);
  const days = new Map<string, { date: LocalDate; count: number }>();
  for (const slot of slots) {
    const date = localDateOf(slot.startsAt, turn.tz);
    const entry = days.get(dateKey(date)) ?? { date, count: 0 };
    entry.count++;
    days.set(dateKey(date), entry);
  }
  if (days.size === 0) {
    return turn.buttons('info', TEXTS.noSlots(service.label, turn.profile), [
      contactButton(turn.profile),
      BUTTONS.menu,
    ]);
  }

  const { items, nextPage } = paginate([...days.values()], page);
  const rows = items.map((d, i) => ({
    id: replyIds.day(service.code, dateKey(d.date)),
    title: `${i + 1}. ${formatDayShort(d.date)}`,
    description: TEXTS.freeSlots(d.count),
  }));
  if (nextPage !== undefined) {
    rows.push({
      id: replyIds.days(service.code, nextPage),
      title: `${rows.length + 1}. Mais datas`,
      description: 'Ver os dias seguintes',
    });
  }
  return turn.list('choosing_day', TEXTS.chooseDay(service.label), 'Ver datas', [{ rows }]);
}

function periodOf(date: Date, tz: string): 'Manhã' | 'Tarde' | 'Noite' {
  const hour = Number(formatTime(date, tz).slice(0, 2));
  return hour < 12 ? 'Manhã' : hour < 18 ? 'Tarde' : 'Noite';
}

async function sendSlots(
  turn: Turn,
  service: ServiceDefinition,
  key: string,
  page: number,
): Promise<void> {
  const day = parseDateKey(key);
  const window = bookingWindow(turn.now);
  let slots: Interval[] = [];
  if (day) {
    const dayStart = zonedToUtc(day, 0, turn.tz);
    const dayEnd = new Date(zonedToUtc(addDays(day, 1), 0, turn.tz).getTime() - 1);
    const from = dayStart > window.from ? dayStart : window.from;
    const to = dayEnd < window.to ? dayEnd : window.to;
    if (from <= to) slots = await findFreeSlots(turn.prisma, service.code, { from, to }, turn.tz);
  }
  if (!day || slots.length === 0) {
    await turn.text(TEXTS.dayFull);
    return sendDays(turn, service, 0);
  }

  const { items, nextPage } = paginate(slots, page);
  const sections: ListSection[] = [];
  items.forEach((slot, i) => {
    const title = periodOf(slot.startsAt, turn.tz);
    let section = sections.find((s) => s.title === title);
    if (!section) {
      section = { title, rows: [] };
      sections.push(section);
    }
    section.rows.push({
      id: replyIds.slot(service.code, slot.startsAt),
      title: `${i + 1}. ${formatTime(slot.startsAt, turn.tz)}`,
      description: `até ${formatTime(slot.endsAt, turn.tz)}`,
    });
  });
  if (nextPage !== undefined) {
    sections.at(-1)!.rows.push({
      id: replyIds.day(service.code, key, nextPage),
      title: `${items.length + 1}. Mais horários`,
      description: 'Ver os horários seguintes',
    });
  }
  return turn.list(
    'choosing_slot',
    TEXTS.chooseSlot(service.label, formatDayShort(day)),
    'Ver horários',
    sections,
  );
}

/** Nome do paciente menor guardado no funil (cifrado), já decifrado para mostrar. */
function patientName(turn: Turn): string | undefined {
  return turn.patientNameEncrypted
    ? getFieldCipher().decrypt('conversation.patient_name', turn.patientNameEncrypted)
    : undefined;
}

async function chooseSlot(turn: Turn, service: ServiceDefinition, startsAt: Date): Promise<void> {
  const slot = await findSlotIfFree(turn.prisma, service.code, startsAt, turn.now, turn.tz);
  if (!slot) {
    await turn.text(TEXTS.slotGone);
    return sendDays(turn, service, 0);
  }
  const minor = turn.audience === 'minor';
  const name = turn.client ? decryptName(turn.client) : undefined;
  if (!name) {
    const prompt = minor ? TEXTS.askGuardianName : TEXTS.askName;
    return askName(turn, 'awaiting_name', service, slot.startsAt, prompt);
  }
  if (minor && !turn.patientNameEncrypted) {
    return askName(turn, 'awaiting_patient_name', service, slot.startsAt, TEXTS.askPatientName);
  }
  return sendConfirmation(turn, service, slot, name);
}

async function askName(
  turn: Turn,
  step: 'awaiting_name' | 'awaiting_patient_name',
  service: ServiceDefinition,
  startsAt: Date,
  prompt: string,
): Promise<void> {
  await turn.remember({
    step,
    options: [],
    serviceType: service.code,
    startsAt: startsAt.toISOString(),
  });
  return turn.text(prompt);
}

/** Serviço e horário guardados enquanto o bot espera um nome. */
function pendingSlot(turn: Turn): { service: ServiceDefinition; startsAt: Date } | undefined {
  const { state } = turn;
  if (!state?.serviceType || !state.startsAt) return undefined;
  const service = serviceByCode(turn.profile, state.serviceType);
  return service ? { service, startsAt: new Date(state.startsAt) } : undefined;
}

async function saveName(turn: Turn, name: string): Promise<void> {
  const pending = pendingSlot(turn);
  if (!turn.client || !pending) return sendMenu(turn, TEXTS.howCanIHelp);
  if (turn.state?.step === 'awaiting_patient_name') {
    // PRIVACIDADE: o nome do menor fica cifrado até virar parte do agendamento.
    turn.patientNameEncrypted = getFieldCipher().encrypt('conversation.patient_name', name);
  } else {
    turn.client = await setClientName(turn.prisma, turn.client.id, name);
  }
  return chooseSlot(turn, pending.service, pending.startsAt);
}

function retryName(turn: Turn): Promise<void> {
  const pending = pendingSlot(turn);
  const step = turn.state?.step;
  if (!pending || (step !== 'awaiting_name' && step !== 'awaiting_patient_name')) {
    return sendMenu(turn, TEXTS.howCanIHelp);
  }
  return askName(turn, step, pending.service, pending.startsAt, TEXTS.invalidName);
}

function sendConfirmation(
  turn: Turn,
  service: ServiceDefinition,
  slot: Interval,
  name: string,
): Promise<void> {
  const body = TEXTS.confirm({
    label: service.label,
    when: formatDateTime(slot.startsAt, turn.tz),
    minutes: Math.round((slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000),
    name,
    patient: turn.audience === 'minor' ? patientName(turn) : undefined,
    modality: service.modality,
    profile: turn.profile,
  });
  return turn.buttons('confirming', body, [
    { id: replyIds.confirm(service.code, slot.startsAt), title: 'Confirmar' },
    { id: replyIds.days(service.code), title: 'Outro horário' },
    { id: replyIds.menu, title: 'Voltar ao menu' },
  ]);
}

async function confirmBooking(
  turn: Turn,
  service: ServiceDefinition,
  startsAt: Date,
): Promise<void> {
  const client = turn.client!; // withConsent garante
  const minor = turn.audience === 'minor';
  if (!decryptName(client)) {
    return askName(turn, 'awaiting_name', service, startsAt, minor ? TEXTS.askGuardianName : TEXTS.askName);
  }
  const patient = minor ? patientName(turn) : undefined;
  if (minor && !patient) {
    return askName(turn, 'awaiting_patient_name', service, startsAt, TEXTS.askPatientName);
  }
  try {
    await bookAppointment(turn.prisma, {
      clientId: client.id,
      serviceType: service.code,
      startsAt,
      now: turn.now,
      timeZone: turn.tz,
      maxFutureAppointments: turn.profile.maxFutureAppointments,
      ...(patient
        ? { minorPatientNameEncrypted: getFieldCipher().encrypt('appointment.patient_name', patient) }
        : {}),
    });
  } catch (err) {
    if (err instanceof BookingError) return bookingFailed(turn, service, err.reason);
    throw err;
  }
  await turn.forget(); // inclusive o nome do menor que estava no estado da conversa
  const when = formatDateTime(startsAt, turn.tz);
  const body = TEXTS.booked({ label: service.label, when, modality: service.modality, profile: turn.profile });
  return turn.buttons('info', body, [BUTTONS.myAppointments, BUTTONS.menu]);
}

async function bookingFailed(
  turn: Turn,
  service: ServiceDefinition,
  reason: BookingFailure,
): Promise<void> {
  switch (reason) {
    case 'slot_unavailable':
      await turn.text(TEXTS.slotTaken);
      return sendDays(turn, service, 0);
    case 'client_busy':
      await turn.text(TEXTS.clientBusy);
      return sendDays(turn, service, 0);
    case 'too_many_future':
      return turn.buttons('info', TEXTS.tooMany(turn.profile), [BUTTONS.myAppointments, BUTTONS.menu]);
    case 'not_found':
    case 'too_late':
      return sendMenu(turn, TEXTS.howCanIHelp);
  }
}

// ---------------------------------------------------------------------------
// Meus agendamentos e cancelamento
// ---------------------------------------------------------------------------

/** "Psicologia clínica (Ana)" para atendimento de menor; só o serviço nos demais. */
function appointmentLabel(
  turn: Turn,
  appointment: { serviceType: string; patientIsMinor: boolean; patientNameEncrypted: string | null },
): string {
  const label = turn.label(appointment.serviceType);
  if (!appointment.patientIsMinor) return label;
  const first = decryptPatientName(appointment)?.split(' ')[0];
  return `${label} (${first ?? 'menor'})`;
}

async function myAppointments(turn: Turn): Promise<void> {
  const list = turn.client ? await upcomingAppointments(turn.prisma, turn.client.id, turn.now) : [];
  if (list.length === 0) {
    return turn.buttons('info', TEXTS.noAppointments, [BUTTONS.book, BUTTONS.menu]);
  }
  const shown = list.slice(0, 3); // limite de 3 botões
  const body = TEXTS.appointmentsList(
    shown.map((a) => ({ label: appointmentLabel(turn, a), when: formatDateTime(a.startsAt, turn.tz) })),
    list.length - shown.length,
    turn.profile,
  );
  return turn.buttons(
    'my_appointments',
    body,
    shown.map((a) => ({
      id: replyIds.cancelAsk(a.id),
      title: `Cancelar ${formatShortDateTime(a.startsAt, turn.tz)}`,
    })),
  );
}

function tooLate(turn: Turn): Promise<void> {
  return turn.buttons('info', TEXTS.tooLateToCancel(turn.profile), [
    contactButton(turn.profile),
    BUTTONS.menu,
  ]);
}

function notFound(turn: Turn): Promise<void> {
  return turn.buttons('info', TEXTS.appointmentNotFound, [BUTTONS.myAppointments, BUTTONS.menu]);
}

async function cancelAsk(turn: Turn, appointmentId: string): Promise<void> {
  // SEGURANÇA: busca sempre filtrando pelo cliente de quem mandou a mensagem. Um id de
  // agendamento alheio (forjado ou não) dá "não encontrei", sem confirmar que existe.
  const appointment = turn.client
    ? await findOwnUpcoming(turn.prisma, turn.client.id, appointmentId, turn.now)
    : null;
  if (!appointment) return notFound(turn);
  if (appointment.startsAt.getTime() - turn.now.getTime() < BOOKING_RULES.cancelMinNoticeMs) {
    return tooLate(turn);
  }
  const details = {
    label: appointmentLabel(turn, appointment),
    when: formatDateTime(appointment.startsAt, turn.tz),
  };
  return turn.buttons('confirming_cancel', TEXTS.confirmCancel(details), [
    { id: replyIds.cancelYes(appointment.id), title: 'Sim, cancelar' },
    { id: replyIds.myAppointments, title: 'Não, manter' },
  ]);
}

async function cancelYes(turn: Turn, appointmentId: string): Promise<void> {
  if (!turn.client) return notFound(turn);
  let appointment;
  try {
    appointment = await cancelAppointment(turn.prisma, {
      clientId: turn.client.id,
      appointmentId,
      now: turn.now,
    });
  } catch (err) {
    if (err instanceof BookingError && err.reason === 'too_late') return tooLate(turn);
    if (err instanceof BookingError) return notFound(turn);
    throw err;
  }
  await turn.forget();
  const when = formatDateTime(appointment.startsAt, turn.tz);
  const label = appointmentLabel(turn, appointment);
  return turn.buttons('info', TEXTS.cancelled({ label, when, profile: turn.profile }), [
    { id: replyIds.book(appointment.serviceType), title: 'Marcar outro horário' },
    BUTTONS.menu,
  ]);
}

// ---------------------------------------------------------------------------
// Botões do lembrete (Passo 4B)
// ---------------------------------------------------------------------------

async function ownUpcoming(turn: Turn, appointmentId: string) {
  // SEGURANÇA: mesmo filtro por cliente do cancelamento (um id alheio dá "não encontrei").
  return turn.client
    ? findOwnUpcoming(turn.prisma, turn.client.id, appointmentId, turn.now)
    : null;
}

/** Modalidade do serviço do agendamento (presencial, se o serviço saiu do perfil). */
function modalityOf(turn: Turn, code: string): 'presencial' | 'online' {
  return serviceByCode(turn.profile, code)?.modality ?? 'presencial';
}

async function reminderConfirm(turn: Turn, appointmentId: string): Promise<void> {
  const appointment = await ownUpcoming(turn, appointmentId);
  if (!appointment) return notFound(turn);
  await audit(turn.prisma, {
    actor: 'CLIENT',
    action: 'appointment.attendance_confirmed',
    entityType: 'appointment',
    entityId: appointment.id,
  });
  const body = TEXTS.attendanceConfirmed({
    label: appointmentLabel(turn, appointment),
    when: formatDateTime(appointment.startsAt, turn.tz),
    modality: modalityOf(turn, appointment.serviceType),
    profile: turn.profile,
  });
  return turn.buttons('info', body, [BUTTONS.menu]);
}

async function reminderChange(turn: Turn, appointmentId: string): Promise<void> {
  const appointment = await ownUpcoming(turn, appointmentId);
  if (!appointment) return notFound(turn);
  const late =
    appointment.startsAt.getTime() - turn.now.getTime() < BOOKING_RULES.cancelMinNoticeMs;
  const body = TEXTS.confirmReschedule({
    label: appointmentLabel(turn, appointment),
    when: formatDateTime(appointment.startsAt, turn.tz),
    late,
    profile: turn.profile,
  });
  return turn.buttons('confirming_cancel', body, [
    { id: replyIds.reschedule(appointment.id), title: 'Sim, remarcar' },
    { id: replyIds.remindOk(appointment.id), title: 'Não, vou manter' },
  ]);
}

/** Opção (A): vindo do lembrete, cancela mesmo com menos de 24 h e já oferece novos horários. */
async function reschedule(turn: Turn, appointmentId: string): Promise<void> {
  if (!turn.client) return notFound(turn);
  let appointment;
  try {
    appointment = await cancelAppointment(turn.prisma, {
      clientId: turn.client.id,
      appointmentId,
      now: turn.now,
      allowLate: true,
    });
  } catch (err) {
    if (err instanceof BookingError) return notFound(turn);
    throw err;
  }
  const when = formatDateTime(appointment.startsAt, turn.tz);
  const label = appointmentLabel(turn, appointment);
  await turn.text(TEXTS.rescheduled({ label, when, profile: turn.profile }));
  const service = serviceByCode(turn.profile, appointment.serviceType);
  // Serviço que saiu do perfil: cancelado mesmo assim; a pessoa escolhe outro pelo menu.
  if (!service) return sendMenu(turn, TEXTS.howCanIHelp);
  // Novo agendamento: em perfis com menores, pergunta de novo para quem é.
  return startBooking(turn, service);
}

// ---------------------------------------------------------------------------
// Privacidade e "apagar meus dados" (LGPD art. 18)
// ---------------------------------------------------------------------------

function privacy(turn: Turn): Promise<void> {
  const isClient = turn.client !== null;
  const buttons = isClient
    ? [{ id: replyIds.deleteAsk, title: 'Apagar meus dados' }, BUTTONS.menu]
    : [BUTTONS.menu];
  return turn.buttons('privacy', TEXTS.privacy(turn.deps.privacyPolicyUrl, isClient), buttons);
}

function deleteAsk(turn: Turn): Promise<void> {
  if (!turn.client) return turn.buttons('info', TEXTS.noData, [BUTTONS.menu]);
  return turn.buttons(
    'confirming_delete',
    TEXTS.confirmDelete(turn.profile),
    [
      { id: replyIds.deleteYes, title: 'Sim, apagar' },
      { id: replyIds.menu, title: 'Não, voltar' },
    ],
    { typedChoice: false },
  );
}

async function deleteYes(turn: Turn): Promise<void> {
  if (!turn.client) return turn.buttons('info', TEXTS.noData, [BUTTONS.menu]);
  const { cancelledAppointments } = await anonymizeClient(turn.prisma, turn.client.id, turn.now);
  turn.client = null; // daqui em diante a pessoa é desconhecida: nada mais é gravado
  return turn.text(TEXTS.deleted(cancelledAppointments));
}
