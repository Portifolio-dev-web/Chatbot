import { BOOKING_RULES, MESSAGE_RATE_LIMIT } from '../../config/business-rules.js';
import { currentConsentText } from '../../content/consent.js';
import type { Client, PrismaClient } from '../../generated/prisma/client.js';
import { createKeyedMutex, createRateLimiter } from '../../lib/concurrency.js';
import { phoneIndex } from '../../lib/crypto.js';
import { getLogger, safeError } from '../../lib/logger.js';
import {
  serviceByCode,
  serviceLabel,
  type Profile,
  type ServiceDefinition,
} from '../../profiles/index.js';
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
import type { ListSection, ReplyButton, WhatsAppClient } from '../whatsapp-client.js';
import { interpret, type FaqTopic, type Intent } from './intents.js';
import { replyIds } from './reply-ids.js';
import { BUTTONS, TEXTS, buildMenu, serviceButtons } from './texts.js';

/*
 * O atendimento: recebe uma mensagem, entende a intenção (intents.ts), responde e guarda a
 * etapa do funil (conversation-state.ts).
 *
 * Funil de agendamento: serviço -> consentimento (só na 1ª vez) -> dia -> horário -> nome
 * (só na 1ª vez) -> confirmação. Cada etapa revalida o que importa (consentimento vigente,
 * horário ainda livre, agendamento pertence a quem pede), porque o cliente pode tocar num
 * botão de uma mensagem antiga.
 *
 * Os serviços oferecidos vêm do PERFIL da instalação (CLINIC_PROFILE, src/profiles).
 */

export interface ChatbotDeps {
  prisma: PrismaClient;
  whatsapp: WhatsAppClient;
  timeZone: string;
  privacyPolicyUrl: string | undefined;
  /** Perfil da instalação: serviços, menu e triagem. */
  profile: Profile;
  now?: () => Date;
}

/** Uma mensagem sendo atendida: quem é, onde parou e como responder. */
class Turn {
  constructor(
    readonly deps: ChatbotDeps,
    readonly message: InboundMessage,
    public client: Client | null,
    readonly state: ConversationState | null,
    readonly now: Date,
  ) {}

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

  /** Só quem já é cliente tem estado salvo (antes do consentimento, nada é gravado). */
  async remember(state: ConversationState): Promise<void> {
    if (this.client) await saveState(this.prisma, this.client.id, state, this.now);
  }

  async forget(): Promise<void> {
    if (this.client) await clearState(this.prisma, this.client.id);
  }
}

export function createChatbot(deps: ChatbotDeps): MessageHandler {
  const now = deps.now ?? (() => new Date());
  const runExclusive = createKeyedMutex();
  const limiter = createRateLimiter(MESSAGE_RATE_LIMIT.max, MESSAGE_RATE_LIMIT.windowMs, () =>
    now().getTime(),
  );

  return {
    async handle(message) {
      // A chave é o índice cego do telefone: nem a memória do processo guarda o número em claro.
      const key = phoneIndex(message.from);
      if (!limiter.allow(key)) {
        getLogger().warn('limite de mensagens por minuto atingido; mensagem ignorada');
        return;
      }
      await runExclusive(key, () => handleTurn(deps, message, now()));
    },
  };
}

async function handleTurn(deps: ChatbotDeps, message: InboundMessage, now: Date): Promise<void> {
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

  const turn = new Turn(deps, message, client, state, now);
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
    case 'menu':
      return sendMenu(turn, intent.greeting ? TEXTS.welcome(turn.profile) : TEXTS.howCanIHelp);
    case 'unknown':
      return sendMenu(turn, TEXTS.didNotUnderstand);
    case 'unsupported':
      return sendMenu(turn, TEXTS.unsupported);
    case 'thanks':
      return turn.buttons('info', TEXTS.thanks, [BUTTONS.menu]);
    case 'ask_service':
      return askService(turn);
    case 'faq':
      return sendFaq(turn, intent.topic);
    case 'reception':
      return turn.buttons('info', TEXTS.reception(), [BUTTONS.menu]);
    case 'consent_declined':
      await turn.forget();
      return turn.buttons('info', TEXTS.consentDeclined(), [BUTTONS.menu]);
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
      return withConsent(turn, service, () => sendDays(turn, service, 0));
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
// Menu, triagem e dúvidas frequentes
// ---------------------------------------------------------------------------

function sendMenu(turn: Turn, body: string): Promise<void> {
  return turn.list('menu', body, 'Ver opções', buildMenu(turn.profile));
}

/** Com um serviço só no perfil, não há o que perguntar: vai direto para o agendamento. */
function askService(turn: Turn): Promise<void> {
  const [only, ...others] = turn.profile.services;
  if (only && others.length === 0) return withConsent(turn, only, () => sendDays(turn, only, 0));
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
  const body = { prices: TEXTS.prices, location: TEXTS.location, hours: TEXTS.hours }[topic]();
  const buttons = [BUTTONS.book, BUTTONS.menu];
  // Mensagem com botões aceita até 1024 caracteres; tabela de preços maior vai em texto.
  if ([...body].length <= 1024) return turn.buttons('info', body, buttons);
  await turn.text(body);
  return turn.buttons('info', TEXTS.anythingElse, buttons);
}

// ---------------------------------------------------------------------------
// Consentimento (LGPD art. 11, I)
// ---------------------------------------------------------------------------

async function withConsent(
  turn: Turn,
  service: ServiceDefinition,
  next: () => Promise<void>,
): Promise<void> {
  const { version } = currentConsentText(turn.deps.privacyPolicyUrl);
  if (turn.client && (await hasCurrentConsent(turn.prisma, turn.client.id, version))) return next();
  return sendConsentPrompt(turn, service);
}

function sendConsentPrompt(turn: Turn, service: ServiceDefinition): Promise<void> {
  const consent = currentConsentText(turn.deps.privacyPolicyUrl);
  // A versão vai no id do botão: o toque prova QUAL texto a pessoa leu.
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
    return sendConsentPrompt(turn, only);
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
  const consent = currentConsentText(turn.deps.privacyPolicyUrl);
  if (version !== consent.version) {
    // Tocou no "Concordo" de um aviso antigo: o texto mudou desde então.
    await turn.text(TEXTS.consentUpdated);
    return sendConsentPrompt(turn, service);
  }
  turn.client = await recordConsent(turn.prisma, {
    phone: turn.message.from,
    version: consent.version,
    body: consent.body,
    evidenceMessageId: turn.message.id,
    now: turn.now,
  });
  return sendDays(turn, service, 0);
}

// ---------------------------------------------------------------------------
// Agendamento: dia -> horário -> nome -> confirmação
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
    return turn.buttons('info', TEXTS.noSlots(service.label), [BUTTONS.reception, BUTTONS.menu]);
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

async function chooseSlot(turn: Turn, service: ServiceDefinition, startsAt: Date): Promise<void> {
  const slot = await findSlotIfFree(turn.prisma, service.code, startsAt, turn.now, turn.tz);
  if (!slot) {
    await turn.text(TEXTS.slotGone);
    return sendDays(turn, service, 0);
  }
  const name = turn.client ? decryptName(turn.client) : undefined;
  if (!name) return askName(turn, service, slot.startsAt, TEXTS.askName);
  return sendConfirmation(turn, service, slot, name);
}

async function askName(
  turn: Turn,
  service: ServiceDefinition,
  startsAt: Date,
  prompt: string,
): Promise<void> {
  await turn.remember({
    step: 'awaiting_name',
    options: [],
    serviceType: service.code,
    startsAt: startsAt.toISOString(),
  });
  return turn.text(prompt);
}

async function saveName(turn: Turn, name: string): Promise<void> {
  const { state } = turn;
  if (!turn.client || state?.step !== 'awaiting_name' || !state.serviceType || !state.startsAt) {
    return sendMenu(turn, TEXTS.howCanIHelp);
  }
  turn.client = await setClientName(turn.prisma, turn.client.id, name);
  const service = serviceByCode(turn.profile, state.serviceType);
  if (!service) return sendMenu(turn, TEXTS.howCanIHelp);
  return chooseSlot(turn, service, new Date(state.startsAt));
}

function retryName(turn: Turn): Promise<void> {
  const { state } = turn;
  if (state?.step !== 'awaiting_name' || !state.serviceType || !state.startsAt) {
    return sendMenu(turn, TEXTS.howCanIHelp);
  }
  const service = serviceByCode(turn.profile, state.serviceType);
  if (!service) return sendMenu(turn, TEXTS.howCanIHelp);
  return askName(turn, service, new Date(state.startsAt), TEXTS.invalidName);
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
  if (!decryptName(client)) return askName(turn, service, startsAt, TEXTS.askName);
  try {
    await bookAppointment(turn.prisma, {
      clientId: client.id,
      serviceType: service.code,
      startsAt,
      now: turn.now,
      timeZone: turn.tz,
    });
  } catch (err) {
    if (err instanceof BookingError) return bookingFailed(turn, service, err.reason);
    throw err;
  }
  await turn.forget();
  const when = formatDateTime(startsAt, turn.tz);
  return turn.buttons('info', TEXTS.booked({ label: service.label, when }), [
    BUTTONS.myAppointments,
    BUTTONS.menu,
  ]);
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
      return turn.buttons('info', TEXTS.tooMany(), [BUTTONS.myAppointments, BUTTONS.menu]);
    case 'not_found':
    case 'too_late':
      return sendMenu(turn, TEXTS.howCanIHelp);
  }
}

// ---------------------------------------------------------------------------
// Meus agendamentos e cancelamento
// ---------------------------------------------------------------------------

async function myAppointments(turn: Turn): Promise<void> {
  const list = turn.client ? await upcomingAppointments(turn.prisma, turn.client.id, turn.now) : [];
  if (list.length === 0) {
    return turn.buttons('info', TEXTS.noAppointments, [BUTTONS.book, BUTTONS.menu]);
  }
  const shown = list.slice(0, 3); // limite de 3 botões
  const body = TEXTS.appointmentsList(
    shown.map((a) => ({ label: turn.label(a.serviceType), when: formatDateTime(a.startsAt, turn.tz) })),
    list.length - shown.length,
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
  return turn.buttons('info', TEXTS.tooLateToCancel(), [BUTTONS.reception, BUTTONS.menu]);
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
    label: turn.label(appointment.serviceType),
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
  const code = appointment.serviceType;
  const when = formatDateTime(appointment.startsAt, turn.tz);
  return turn.buttons('info', TEXTS.cancelled({ label: turn.label(code), when }), [
    { id: replyIds.book(code), title: 'Marcar outro horário' },
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

async function reminderConfirm(turn: Turn, appointmentId: string): Promise<void> {
  const appointment = await ownUpcoming(turn, appointmentId);
  if (!appointment) return notFound(turn);
  await audit(turn.prisma, {
    actor: 'CLIENT',
    action: 'appointment.attendance_confirmed',
    entityType: 'appointment',
    entityId: appointment.id,
  });
  const when = formatDateTime(appointment.startsAt, turn.tz);
  const label = turn.label(appointment.serviceType);
  return turn.buttons('info', TEXTS.attendanceConfirmed({ label, when }), [
    BUTTONS.menu,
  ]);
}

async function reminderChange(turn: Turn, appointmentId: string): Promise<void> {
  const appointment = await ownUpcoming(turn, appointmentId);
  if (!appointment) return notFound(turn);
  const late =
    appointment.startsAt.getTime() - turn.now.getTime() < BOOKING_RULES.cancelMinNoticeMs;
  const body = TEXTS.confirmReschedule({
    label: turn.label(appointment.serviceType),
    when: formatDateTime(appointment.startsAt, turn.tz),
    late,
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
  await turn.text(TEXTS.rescheduled({ label: turn.label(appointment.serviceType), when }));
  const service = serviceByCode(turn.profile, appointment.serviceType);
  // Serviço que saiu do perfil: cancelado mesmo assim; a pessoa escolhe outro pelo menu.
  if (!service) return sendMenu(turn, TEXTS.howCanIHelp);
  return withConsent(turn, service, () => sendDays(turn, service, 0));
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
    TEXTS.confirmDelete,
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
