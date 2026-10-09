import { BOOKING_RULES } from '../../config/business-rules.js';
import { CLINIC } from '../../content/clinic.js';
import type { Modality, Profile } from '../../profiles/index.js';
import type { ListSection, ReplyButton } from '../whatsapp-client.js';
import { replyIds } from './reply-ids.js';

/*
 * Tudo o que o bot escreve. Formatação do WhatsApp: *negrito*, _itálico_.
 * Os dados da clínica (endereço, preços, contato) vêm de src/content/clinic.ts; os serviços,
 * quem atende ("a recepção" / "a profissional") e as regras do tipo de atendimento vêm do
 * perfil da instalação (src/profiles).
 */

const isOnlineOnly = (profile: Profile): boolean =>
  profile.services.every((service) => service.modality === 'online');

/** "a recepção" -> "A recepção" (início de frase). */
const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Menu principal, montado a partir do perfil: um item "Agendar" por serviço, depois as
 * informações e o atendimento. Os títulos levam número para quem prefere digitar.
 */
export function buildMenu(profile: Profile): ListSection[] {
  // A numeração segue a ordem em que os itens são montados: monte sempre de cima para baixo.
  let n = 0;
  const numbered = (title: string): string => `${++n}. ${title}`;
  const booking = profile.services.map((service) => ({
    id: replyIds.book(service.code),
    title: numbered(service.label),
    description: service.menuDescription,
  }));
  const prices = { id: replyIds.faq('prices'), title: numbered('Valores e pacotes') };
  const location = isOnlineOnly(profile)
    ? { id: replyIds.faq('location'), title: numbered('Atendimento online'), description: 'Como funcionam as sessões' }
    : { id: replyIds.faq('location'), title: numbered('Endereço') };
  const hours = { id: replyIds.faq('hours'), title: numbered('Horários'), description: 'Funcionamento da clínica' };
  return [
    { title: 'Agendar', rows: booking },
    { title: 'Informações', rows: [prices, location, hours] },
    {
      title: 'Atendimento',
      rows: [
        { id: replyIds.myAppointments, title: numbered('Meus agendamentos'), description: 'Ver ou cancelar' },
        { id: replyIds.reception, title: numbered(profile.staff.contactLabel) },
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
  myAppointments: { id: replyIds.myAppointments, title: 'Meus agendamentos' },
} satisfies Record<string, ReplyButton>;

/** Botão do contato humano ("Falar com a recepção" / "Contato direto"). */
export function contactButton(profile: Profile): ReplyButton {
  return { id: replyIds.reception, title: profile.staff.contactLabel };
}

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

/** Onde acontece: endereço (presencial) ou aviso do link (online). */
function whereLine(modality: Modality, profile: Profile): string {
  return modality === 'online'
    ? `💻 Sessão online: o link é enviado por ${profile.staff.noun} antes do horário.`
    : `📍 ${CLINIC.address}`;
}

/** Contatos de emergência (mensagem de crise e avisos dos perfis com alerta de crise). */
const EMERGENCY =
  '• *CVV: 188* (ligação gratuita, 24 h) ou chat em cvv.org.br\n' +
  '• *SAMU: 192*\n' +
  '• Em caso de violência: *190*\n' +
  '• Ou vá ao pronto-socorro ou à UPA mais próximos.';

export const TEXTS = {
  welcome: (profile: Profile): string =>
    `Olá! 👋 Sou o assistente virtual da *${CLINIC.name}*.\n` +
    `Posso ajudar você a agendar ${joinOr(profile.services.map((s) => `*${s.label.toLowerCase()}*`))} ` +
    'e a tirar dúvidas.' +
    (profile.welcomeNote ? `\n\n${profile.welcomeNote}` : '') +
    '\n\nToque em *Ver opções* (ou digite o número da opção).',
  howCanIHelp: 'Como posso ajudar? Toque em *Ver opções* (ou digite o número da opção).',
  didNotUnderstand:
    'Desculpe, não entendi. 😅 Toque em *Ver opções* ou escreva, por exemplo, *agendar*, ' +
    '*valores* ou *endereço*.',
  unsupported: (profile: Profile): string =>
    'Ainda não consigo ouvir áudios nem abrir fotos ou arquivos. 🙏 Toque em *Ver opções* ' +
    'ou escreva sua dúvida.' +
    // Num áudio pode haver um pedido de ajuda que o bot não tem como entender.
    (profile.crisisAlert ? '\n\nSe for uma emergência, ligue *188* (CVV) ou *192* (SAMU).' : ''),
  thanks: 'Por nada! 😊 Se precisar de algo, é só chamar.',
  technicalProblem:
    'Desculpe, tive um problema técnico agora. 😓 Pode tentar de novo em alguns minutos?',
  anythingElse: 'Posso ajudar em algo mais?',

  // Crise (ver crisis.ts). Acolhimento + contatos; nunca "não entendi".
  crisisSupport:
    '💙 Sinto muito que você esteja passando por isso. Você não está só.\n\n' +
    'Este WhatsApp é automático e *não atende emergências*. Se você está em risco agora:\n' +
    EMERGENCY,
  crisisAlerted: (profile: Profile): string =>
    `Também avisei ${profile.staff.noun}, que pode entrar em contato com você por aqui ou ` +
    'pelo seu telefone.',

  whichService: (profile: Profile): string =>
    'Qual atendimento você procura?\n\n' +
    profile.services.map((s) => `*${s.label}*: ${s.menuDescription.toLowerCase()}.`).join('\n'),

  // Perfis com menores (LGPD art. 14).
  whoIsPatient:
    'A sessão é para você ou para outra pessoa?\n\n' +
    'Para *criança ou adolescente*, o agendamento é feito por um dos pais ou pelo responsável legal.',
  otherAdult: (profile: Profile): string =>
    'Para outro adulto, o agendamento precisa ser feito pela própria pessoa: o consentimento para ' +
    'o uso dos dados é dela. Peça que ela escreva para este número. 🙂\n\n' +
    `Se precisar, fale com ${profile.staff.noun}: ${CLINIC.reception}`,

  consentNeedsButton:
    'Para registrar seu consentimento, toque no botão *Concordo* do aviso de privacidade.',
  whichServiceShort: 'Qual atendimento você quer agendar?',
  consentUpdated: 'Nosso aviso de privacidade foi atualizado. Por favor, leia a versão nova:',
  consentDeclined: (profile: Profile): string =>
    `Tudo bem! Sem o seu consentimento não consigo agendar por aqui, mas ${profile.staff.noun} ` +
    `pode ajudar: ${CLINIC.reception}\n\nPara valores e horários, toque em *Ver opções*.`,

  reception: (profile: Profile): string =>
    `👩‍⚕️ Para falar com ${profile.staff.noun}: ${CLINIC.reception}`,
  location: (profile: Profile): string =>
    isOnlineOnly(profile)
      ? '💻 *Atendimento online*\n' +
        'As sessões são por videochamada. O link é enviado por ' +
        `${profile.staff.noun} antes do horário. Escolha um lugar reservado e com boa internet.`
      : `📍 *Endereço*\n${CLINIC.address}${CLINIC.mapsUrl ? `\n${CLINIC.mapsUrl}` : ''}`,
  hours: (): string => `🕒 *Horário de funcionamento*\n${CLINIC.openingHours}`,
  prices: (): string => `💰 *Valores e pacotes*\n\n${CLINIC.prices}`,

  // `label` = nome do serviço para mostrar (vem do perfil).
  noSlots: (label: string, profile: Profile): string =>
    `No momento não há horários livres de *${label}* nos próximos ` +
    `${BOOKING_RULES.horizonDays} dias. 😕 ${capitalized(profile.staff.noun)} pode ajudar: ` +
    CLINIC.reception,
  chooseDay: (label: string): string =>
    `*${label}*: escolha o dia. 📅\n(Toque em *Ver datas* ou digite o número.)`,
  chooseSlot: (label: string, day: string): string =>
    `*${label}*, ${day}: escolha o horário. 🕒\n(Toque em *Ver horários* ou digite o número.)`,
  dayFull: 'Esse dia acabou de lotar. 😕 Escolha outro:',
  slotGone: 'Que pena, esse horário não está mais disponível. 😕 Escolha outro:',

  askName:
    'Para finalizar, qual é o seu *nome completo*?\n(Usamos só para identificar seu agendamento.)',
  askGuardianName:
    'Para finalizar, qual é o *seu nome completo*, como responsável?\n' +
    '(Usamos só para identificar o agendamento.)',
  askPatientName: 'E qual é o *nome completo da criança ou do adolescente* que será atendido(a)?',
  invalidName:
    'Não consegui entender o nome. Pode escrever só nome e sobrenome? (ex.: Maria Souza)\n' +
    'Ou escreva *menu* para voltar.',

  confirm: (p: {
    label: string;
    when: string;
    minutes: number;
    name: string;
    /** Preenchido quando o atendimento é de um menor (o cliente é o responsável). */
    patient?: string | undefined;
    modality: Modality;
    profile: Profile;
  }): string =>
    '*Confira seu agendamento:*\n\n' +
    `• *Serviço:* ${p.label}\n` +
    `• *Quando:* ${p.when} (${p.minutes} min)\n` +
    (p.patient
      ? `• *Paciente:* ${p.patient} (menor de idade)\n• *Responsável:* ${p.name}\n`
      : `• *Nome:* ${p.name}\n`) +
    (p.modality === 'online'
      ? `• *Onde:* online, por videochamada (o link é enviado por ${p.profile.staff.noun} antes do horário)\n\n`
      : `• *Local:* ${CLINIC.address}\n\n`) +
    'Está tudo certo?',
  booked: (p: { label: string; when: string; modality: Modality; profile: Profile }): string =>
    `✅ *Agendado!*\n${p.label}, ${p.when}.\n${whereLine(p.modality, p.profile)}\n\n` +
    'Você vai receber um lembrete um dia antes. Para cancelar ou remarcar, escreva ' +
    '*meus agendamentos* (até 24 h antes).',
  slotTaken: 'Que pena, esse horário acabou de ser reservado por outra pessoa. 😕 Escolha outro:',
  clientBusy: 'Você já tem um agendamento nesse horário. Escolha outro:',
  tooMany: (profile: Profile): string =>
    `Você já tem ${plural(profile.maxFutureAppointments, 'agendamento marcado', 'agendamentos marcados')}, ` +
    'o máximo pelo WhatsApp. Para marcar outro, cancele um deles ou fale com ' +
    `${profile.staff.noun}.`,

  noAppointments: 'Não encontrei agendamentos futuros para este número. Quer marcar um?',
  appointmentsList: (
    items: Array<{ label: string; when: string }>,
    hidden: number,
    profile: Profile,
  ): string =>
    '*Seus próximos agendamentos:*\n' +
    items.map((a, i) => `${i + 1}. ${a.label}: ${a.when}`).join('\n') +
    (hidden > 0 ? `\n(e mais ${hidden}; ${profile.staff.noun} pode mostrar todos)` : '') +
    '\n\nPara cancelar, toque no horário. Pelo WhatsApp, só até 24 h antes.',
  appointmentNotFound:
    'Não encontrei esse agendamento (talvez já tenha sido cancelado ou já passou).',
  tooLateToCancel: (profile: Profile): string =>
    'Faltam menos de 24 horas para esse horário, então o cancelamento precisa ser feito com ' +
    `${profile.staff.noun}: ${CLINIC.reception}`,
  confirmCancel: (p: { label: string; when: string }): string => `Cancelar *${p.label}*, ${p.when}?`,
  cancelled: (p: { label: string; when: string; profile: Profile }): string =>
    `Pronto, cancelamos *${p.label}*, ${p.when}. Avisamos ${p.profile.staff.noun}. 👍`,

  privacy: (policyUrl: string | undefined, isClient: boolean): string =>
    '🔒 *Privacidade e seus dados*\n\n' +
    (isClient
      ? 'Guardamos seu nome, seu WhatsApp e seus agendamentos, criptografados, só para ' +
        'organizar seu atendimento.'
      : 'Não temos nenhum dado seu guardado: você ainda não agendou por aqui.') +
    `\n\nPolítica de privacidade: ${policyUrl ?? '(em preparação)'}` +
    (isClient ? '\n\nSe quiser, você pode apagar seus dados agora.' : ''),
  confirmDelete: (profile: Profile): string =>
    '⚠️ *Tem certeza?*\n\n' +
    `Vamos *cancelar seus agendamentos futuros* (${profile.staff.noun} será avisada) e *apagar ` +
    'seu nome e telefone*' +
    (profile.audience === 'adults_and_minors'
      ? ', além do nome de quem você agendou como responsável'
      : '') +
    '. O histórico de atendimentos fica sem identificação, e o registro de que você consentiu ' +
    'até hoje é mantido como prova legal.\n\nIsso não pode ser desfeito.',
  deleted: (cancelled: number): string =>
    'Pronto, seus dados foram apagados' +
    (cancelled > 0 ? ` e ${plural(cancelled, 'agendamento futuro foi cancelado', 'agendamentos futuros foram cancelados')}` : '') +
    '. Se quiser voltar a agendar, é só mandar um oi. 💙',
  noData: 'Não temos nenhum dado seu guardado. 🙂',

  freeSlots: (n: number): string => plural(n, 'horário livre', 'horários livres'),

  // Passo 4B: respostas aos botões do lembrete.
  attendanceConfirmed: (p: { label: string; when: string; modality: Modality; profile: Profile }): string =>
    `Obrigado por confirmar! 💙 Esperamos você para *${p.label}*, ${p.when}.\n` +
    whereLine(p.modality, p.profile),
  confirmReschedule: (p: { label: string; when: string; late: boolean; profile: Profile }): string =>
    `Vamos cancelar *${p.label}*, ${p.when}, e mostrar novos horários.` +
    (p.late
      ? `\n\nComo faltam menos de 24 horas, ${p.profile.staff.noun} será avisada do cancelamento ` +
        'em cima da hora.'
      : '') +
    '\n\nConfirma?',
  rescheduled: (p: { label: string; when: string; profile: Profile }): string =>
    `Pronto, cancelamos *${p.label}*, ${p.when}, e avisamos ${p.profile.staff.noun}. ` +
    'Agora escolha o novo horário:',
};
