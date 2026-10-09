import { BOOKING_RULES } from '../../config/business-rules.js';
import { CLINIC } from '../../content/clinic.js';
import type { Profile } from '../../profiles/index.js';
import type { ListSection, ReplyButton } from '../whatsapp-client.js';
import { replyIds } from './reply-ids.js';

/*
 * Tudo o que o bot escreve. Formatação do WhatsApp: *negrito*, _itálico_.
 * Os dados da clínica (endereço, preços, recepção) vêm de src/content/clinic.ts; os serviços
 * (nome, descrição) vêm do perfil da instalação (src/profiles).
 */

/**
 * Menu principal, montado a partir do perfil: um item "Agendar" por serviço, depois as
 * informações e o atendimento. Os títulos levam número para quem prefere digitar.
 */
export function buildMenu(profile: Profile): ListSection[] {
  let n = 0;
  const numbered = (title: string): string => `${++n}. ${title}`;
  return [
    {
      title: 'Agendar',
      rows: profile.services.map((service) => ({
        id: replyIds.book(service.code),
        title: numbered(service.label),
        description: service.menuDescription,
      })),
    },
    {
      title: 'Informações',
      rows: [
        { id: replyIds.faq('prices'), title: numbered('Valores e pacotes') },
        { id: replyIds.faq('location'), title: numbered('Endereço') },
        { id: replyIds.faq('hours'), title: numbered('Horários'), description: 'Funcionamento da clínica' },
      ],
    },
    {
      title: 'Atendimento',
      rows: [
        { id: replyIds.myAppointments, title: numbered('Meus agendamentos'), description: 'Ver ou cancelar' },
        { id: replyIds.reception, title: numbered('Falar com a recepção') },
        { id: replyIds.privacy, title: numbered('Privacidade e dados'), description: 'Seus dados e como apagá-los' },
      ],
    },
  ];
}

/** Itens do menu na ordem dos números (quem digita "3" escolhe o 3º). */
export function menuOptions(profile: Profile): ListSection['rows'] {
  return buildMenu(profile).flatMap((section) => section.rows);
}

export const BUTTONS = {
  menu: { id: replyIds.menu, title: 'Ver opções' },
  book: { id: replyIds.askService, title: 'Agendar' },
  reception: { id: replyIds.reception, title: 'Falar com a recepção' },
  myAppointments: { id: replyIds.myAppointments, title: 'Meus agendamentos' },
} satisfies Record<string, ReplyButton>;

/** Um botão por serviço; sobrando espaço (máx. 3), também "Ver opções". */
export function serviceButtons(profile: Profile): ReplyButton[] {
  const buttons = profile.services.map((s) => ({ id: replyIds.book(s.code), title: s.label }));
  return buttons.length < 3 ? [...buttons, BUTTONS.menu] : buttons;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** ["a"] -> "a"; ["a","b"] -> "a ou b"; ["a","b","c"] -> "a, b ou c". */
function joinOr(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ou ${items.at(-1)}`;
}

export const TEXTS = {
  welcome: (profile: Profile): string =>
    `Olá! 👋 Sou o assistente virtual da *${CLINIC.name}*.\n` +
    `Posso ajudar você a agendar ${joinOr(profile.services.map((s) => `*${s.label.toLowerCase()}*`))} ` +
    'e a tirar dúvidas.\n\n' +
    'Toque em *Ver opções* (ou digite o número da opção).',
  howCanIHelp: 'Como posso ajudar? Toque em *Ver opções* (ou digite o número da opção).',
  didNotUnderstand:
    'Desculpe, não entendi. 😅 Toque em *Ver opções* ou escreva, por exemplo, *agendar*, ' +
    '*valores* ou *endereço*.',
  unsupported:
    'Ainda não consigo ouvir áudios nem abrir fotos ou arquivos. 🙏 Toque em *Ver opções* ' +
    'ou escreva sua dúvida.',
  thanks: 'Por nada! 😊 Se precisar de algo, é só chamar.',
  technicalProblem:
    'Desculpe, tive um problema técnico agora. 😓 Pode tentar de novo em alguns minutos?',
  anythingElse: 'Posso ajudar em algo mais?',

  whichService: (profile: Profile): string =>
    'Qual atendimento você procura?\n\n' +
    profile.services.map((s) => `*${s.label}*: ${s.menuDescription.toLowerCase()}.`).join('\n'),

  consentNeedsButton:
    'Para registrar seu consentimento, toque no botão *Concordo* do aviso de privacidade.',
  whichServiceShort: 'Qual atendimento você quer agendar?',
  consentUpdated: 'Nosso aviso de privacidade foi atualizado. Por favor, leia a versão nova:',
  consentDeclined: (): string =>
    'Tudo bem! Sem o seu consentimento não consigo agendar por aqui, mas nossa recepção pode ' +
    `ajudar: ${CLINIC.reception}\n\nPara valores, endereço e horários, toque em *Ver opções*.`,

  reception: (): string => `👩‍⚕️ Para falar com nossa equipe: ${CLINIC.reception}`,
  location: (): string =>
    `📍 *Endereço*\n${CLINIC.address}${CLINIC.mapsUrl ? `\n${CLINIC.mapsUrl}` : ''}`,
  hours: (): string => `🕒 *Horário de funcionamento*\n${CLINIC.openingHours}`,
  prices: (): string => `💰 *Valores e pacotes*\n\n${CLINIC.prices}`,

  // `label` = nome do serviço para mostrar (vem do perfil).
  noSlots: (label: string): string =>
    `No momento não há horários livres de *${label}* nos próximos ` +
    `${BOOKING_RULES.horizonDays} dias. 😕 Nossa recepção pode ajudar: ${CLINIC.reception}`,
  chooseDay: (label: string): string =>
    `*${label}*: escolha o dia. 📅\n(Toque em *Ver datas* ou digite o número.)`,
  chooseSlot: (label: string, day: string): string =>
    `*${label}*, ${day}: escolha o horário. 🕒\n(Toque em *Ver horários* ou digite o número.)`,
  dayFull: 'Esse dia acabou de lotar. 😕 Escolha outro:',
  slotGone: 'Que pena, esse horário não está mais disponível. 😕 Escolha outro:',

  askName:
    'Para finalizar, qual é o seu *nome completo*?\n(Usamos só para identificar seu agendamento.)',
  invalidName:
    'Não consegui entender o nome. Pode escrever só seu nome e sobrenome? (ex.: Maria Souza)\n' +
    'Ou escreva *menu* para voltar.',

  confirm: (p: { label: string; when: string; minutes: number; name: string }): string =>
    '*Confira seu agendamento:*\n\n' +
    `• *Serviço:* ${p.label}\n` +
    `• *Quando:* ${p.when} (${p.minutes} min)\n` +
    `• *Nome:* ${p.name}\n` +
    `• *Local:* ${CLINIC.address}\n\n` +
    'Está tudo certo?',
  booked: (p: { label: string; when: string }): string =>
    `✅ *Agendado!*\n${p.label}, ${p.when}.\n📍 ${CLINIC.address}\n\n` +
    'Você vai receber um lembrete um dia antes. Para cancelar ou remarcar, escreva ' +
    '*meus agendamentos* (até 24 h antes).',
  slotTaken: 'Que pena, esse horário acabou de ser reservado por outra pessoa. 😕 Escolha outro:',
  clientBusy: 'Você já tem um agendamento nesse horário. Escolha outro:',
  tooMany: (): string =>
    `Você já tem ${BOOKING_RULES.maxFutureAppointments} agendamentos marcados, o máximo pelo ` +
    'WhatsApp. Para marcar outro, cancele um deles ou fale com a recepção.',

  noAppointments: 'Não encontrei agendamentos futuros para este número. Quer marcar um?',
  appointmentsList: (items: Array<{ label: string; when: string }>, hidden: number): string =>
    '*Seus próximos agendamentos:*\n' +
    items.map((a, i) => `${i + 1}. ${a.label}: ${a.when}`).join('\n') +
    (hidden > 0 ? `\n(e mais ${hidden}; a recepção pode mostrar todos)` : '') +
    '\n\nPara cancelar, toque no horário. Pelo WhatsApp, só até 24 h antes.',
  appointmentNotFound:
    'Não encontrei esse agendamento (talvez já tenha sido cancelado ou já passou).',
  tooLateToCancel: (): string =>
    'Faltam menos de 24 horas para esse horário, então o cancelamento precisa ser feito com ' +
    `a recepção: ${CLINIC.reception}`,
  confirmCancel: (p: { label: string; when: string }): string => `Cancelar *${p.label}*, ${p.when}?`,
  cancelled: (p: { label: string; when: string }): string =>
    `Pronto, cancelamos *${p.label}*, ${p.when}. Avisamos a recepção. 👍`,

  privacy: (policyUrl: string | undefined, isClient: boolean): string =>
    '🔒 *Privacidade e seus dados*\n\n' +
    (isClient
      ? 'Guardamos seu nome, seu WhatsApp e seus agendamentos, criptografados, só para ' +
        'organizar seu atendimento.'
      : 'Não temos nenhum dado seu guardado: você ainda não agendou por aqui.') +
    `\n\nPolítica de privacidade: ${policyUrl ?? '(em preparação)'}` +
    (isClient ? '\n\nSe quiser, você pode apagar seus dados agora.' : ''),
  confirmDelete:
    '⚠️ *Tem certeza?*\n\n' +
    'Vamos *cancelar seus agendamentos futuros* (a recepção será avisada) e *apagar seu nome ' +
    'e telefone*. O histórico de atendimentos fica sem identificação, e o registro de que você ' +
    'consentiu até hoje é mantido como prova legal.\n\nIsso não pode ser desfeito.',
  deleted: (cancelled: number): string =>
    'Pronto, seus dados foram apagados' +
    (cancelled > 0 ? ` e ${plural(cancelled, 'agendamento futuro foi cancelado', 'agendamentos futuros foram cancelados')}` : '') +
    '. Se quiser voltar a agendar, é só mandar um oi. 💙',
  noData: 'Não temos nenhum dado seu guardado. 🙂',

  freeSlots: (n: number): string => plural(n, 'horário livre', 'horários livres'),

  // Passo 4B: respostas aos botões do lembrete.
  attendanceConfirmed: (p: { label: string; when: string }): string =>
    `Obrigado por confirmar! 💙 Esperamos você para *${p.label}*, ${p.when}.\n📍 ${CLINIC.address}`,
  confirmReschedule: (p: { label: string; when: string; late: boolean }): string =>
    `Vamos cancelar *${p.label}*, ${p.when}, e mostrar novos horários.` +
    (p.late
      ? '\n\nComo faltam menos de 24 horas, a recepção será avisada do cancelamento em cima da hora.'
      : '') +
    '\n\nConfirma?',
  rescheduled: (p: { label: string; when: string }): string =>
    `Pronto, cancelamos *${p.label}*, ${p.when}, e avisamos a recepção. Agora escolha o novo horário:`,
};
