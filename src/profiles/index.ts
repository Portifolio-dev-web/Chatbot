import { BOOKING_RULES } from '../config/business-rules.js';
import { normalize } from '../lib/text.js';
import { SERVICE_CODE, type Profile, type ScheduleTemplate, type ServiceDefinition } from './types.js';

export type { Modality, Profile, ScheduleTemplate, ServiceDefinition } from './types.js';

/*
 * Catálogo de perfis. Para criar um perfil novo:
 *   1. defina (ou reaproveite) os serviços abaixo;
 *   2. acrescente o perfil em PROFILES;
 *   3. rode `npm test`: o teste de perfis confere limites do WhatsApp e palavras-chave.
 * Este arquivo não depende de configuração nem de banco (é lido por env.ts na subida).
 */

const PHYSIOTHERAPY: ServiceDefinition = {
  code: 'PHYSIOTHERAPY',
  label: 'Fisioterapia',
  menuDescription: 'Reabilitação, dores, pós-operatório',
  suggestion:
    'Para dores, lesões e reabilitação, o indicado é a *Fisioterapia*. ' +
    'Quer agendar uma avaliação?',
  keywords: [
    'fisio',
    'fisioterapia',
    'fisioterapeuta',
    'dor',
    'dores',
    'reabilitacao',
    'lesao',
    'lesoes',
    'coluna',
    'joelho',
    'ombro',
    'tendinite',
    'postura',
    'cirurgia',
    'operatorio',
  ],
  modality: 'presencial',
};

const PERSONAL_TRAINING: ServiceDefinition = {
  code: 'PERSONAL_TRAINING',
  label: 'Personal trainer',
  menuDescription: 'Condicionamento, hipertrofia',
  suggestion:
    'Para condicionamento físico, hipertrofia e emagrecimento, o indicado é o ' +
    '*Personal trainer*. Quer agendar um treino?',
  keywords: [
    'personal',
    'treino',
    'treinar',
    'treinador',
    'academia',
    'hipertrofia',
    'emagrecer',
    'emagrecimento',
    'condicionamento',
    'musculacao',
  ],
  modality: 'presencial',
};

/**
 * Psicologia clínica, só online. O bot marca apenas a PRIMEIRA sessão: as seguintes a
 * profissional combina direto com o paciente. A triagem nunca pergunta a queixa.
 */
const PSYCHOTHERAPY: ServiceDefinition = {
  code: 'PSYCHOTHERAPY',
  label: 'Psicologia clínica',
  menuDescription: 'Primeira sessão online, 50 min',
  suggestion:
    'Para cuidar da saúde emocional, o caminho é a *psicologia clínica*. ' +
    'Quer agendar a primeira sessão (online, 50 min)?',
  keywords: [
    'psicologa',
    'psicologo',
    'psicologia',
    'psicoterapia',
    'terapia',
    'terapeuta',
    'ansiedade',
    'ansioso',
    'ansiosa',
    'depressao',
    'emocional',
    'tristeza',
    'estresse',
    'luto',
    'autoestima',
  ],
  modality: 'online',
};

const MON_FRI = [1, 2, 3, 4, 5];

// Grades de EXEMPLO: ajuste para a realidade de cada cliente antes de colocar no ar.
const PHYSIOTHERAPY_SCHEDULE: ScheduleTemplate = {
  serviceCode: PHYSIOTHERAPY.code,
  weekdays: MON_FRI,
  windows: [
    ['08:00', '12:00'],
    ['14:00', '18:00'],
  ],
  slotMinutes: 60,
};

const PERSONAL_SCHEDULE: ScheduleTemplate[] = [
  {
    serviceCode: PERSONAL_TRAINING.code,
    weekdays: MON_FRI,
    windows: [
      ['06:00', '10:00'],
      ['17:00', '21:00'],
    ],
    slotMinutes: 60,
  },
  {
    serviceCode: PERSONAL_TRAINING.code,
    weekdays: [6],
    windows: [['08:00', '12:00']],
    slotMinutes: 60,
  },
];

const PSYCHOTHERAPY_SCHEDULE: ScheduleTemplate = {
  serviceCode: PSYCHOTHERAPY.code,
  weekdays: MON_FRI,
  windows: [
    ['09:00', '12:00'],
    ['14:00', '20:00'],
  ],
  slotMinutes: 60,
  sessionMinutes: 50,
};

/** Clínicas de fisioterapia/treino: recepção, até 3 horários futuros, só adultos. */
const CLINIC_DEFAULTS = {
  staff: { contactLabel: 'Falar com a recepção', noun: 'a recepção' },
  maxFutureAppointments: BOOKING_RULES.maxFutureAppointments,
  audience: 'adults',
  crisisAlert: false,
  discreetReminders: false,
} as const;

export const PROFILES = {
  'fisio-personal': {
    id: 'fisio-personal',
    description: 'Clínica com fisioterapia e personal trainer',
    services: [PHYSIOTHERAPY, PERSONAL_TRAINING],
    defaultSchedule: [PHYSIOTHERAPY_SCHEDULE, ...PERSONAL_SCHEDULE],
    ...CLINIC_DEFAULTS,
  },
  fisioterapia: {
    id: 'fisioterapia',
    description: 'Clínica ou fisioterapeuta (só fisioterapia)',
    services: [PHYSIOTHERAPY],
    defaultSchedule: [PHYSIOTHERAPY_SCHEDULE],
    ...CLINIC_DEFAULTS,
  },
  personal: {
    id: 'personal',
    description: 'Personal trainer ou estúdio (só treino)',
    services: [PERSONAL_TRAINING],
    defaultSchedule: PERSONAL_SCHEDULE,
    ...CLINIC_DEFAULTS,
  },
  psicologia: {
    id: 'psicologia',
    description: 'Psicologia clínica online (o bot marca só a primeira sessão)',
    services: [PSYCHOTHERAPY],
    defaultSchedule: [PSYCHOTHERAPY_SCHEDULE],
    // Sem recepção: quem atende o contato humano é a própria profissional.
    staff: { contactLabel: 'Contato direto', noun: 'a profissional' },
    // Só a 1ª sessão pelo bot; as seguintes são combinadas direto com a profissional.
    maxFutureAppointments: 1,
    audience: 'adults_and_minors',
    crisisAlert: true,
    // O lembrete aparece na tela bloqueada: "seu horário de atendimento", sem "psicologia".
    discreetReminders: true,
    welcomeNote:
      '⚠️ Este canal é automático e *não atende emergências*. Em crise, ligue *188* (CVV, ' +
      '24 h) ou *192* (SAMU).\n' +
      'Por privacidade, não conte aqui detalhes do que está sentindo: isso fica para a sessão.\n' +
      'Já é paciente? Combine os próximos horários diretamente com a profissional.',
  },
} as const satisfies Record<string, Profile>;

export type ProfileId = keyof typeof PROFILES;

export const PROFILE_IDS = Object.keys(PROFILES) as [ProfileId, ...ProfileId[]];

export function serviceByCode(profile: Profile, code: string): ServiceDefinition | undefined {
  return profile.services.find((service) => service.code === code);
}

/**
 * Nome para mostrar. Um agendamento antigo pode ter um serviço que saiu do perfil (o
 * cliente trocou de perfil): nesse caso mostra o próprio código, em vez de falhar.
 */
export function serviceLabel(profile: Profile, code: string): string {
  return serviceByCode(profile, code)?.label ?? code;
}

/** Problemas de um perfil (vazio = ok). Conferido nos testes para todos os perfis. */
export function validateProfile(profile: Profile): string[] {
  const problems: string[] = [];
  const count = profile.services.length;
  if (count < 1 || count > 3) problems.push(`${profile.id}: precisa de 1 a 3 serviços`);
  const codes = new Set<string>();
  for (const s of profile.services) {
    if (!SERVICE_CODE.test(s.code)) problems.push(`${s.code}: código fora do formato`);
    if (codes.has(s.code)) problems.push(`${s.code}: código repetido`);
    codes.add(s.code);
    if ([...s.label].length > 20) problems.push(`${s.code}: label passa de 20 caracteres`);
    if ([...s.menuDescription].length > 72) problems.push(`${s.code}: descrição passa de 72`);
    for (const k of s.keywords) {
      if (normalize(k) !== k) problems.push(`${s.code}: palavra-chave não normalizada (${k})`);
    }
  }
  for (const t of profile.defaultSchedule) {
    if (!codes.has(t.serviceCode)) problems.push(`grade usa serviço fora do perfil: ${t.serviceCode}`);
    if (t.sessionMinutes !== undefined && t.sessionMinutes > t.slotMinutes) {
      problems.push(`${t.serviceCode}: sessão maior que o intervalo entre horários`);
    }
  }
  if ([...profile.staff.contactLabel].length > 20) problems.push('contactLabel passa de 20 caracteres');
  // "Meus agendamentos" mostra um botão de cancelar por horário: no máximo 3.
  if (profile.maxFutureAppointments < 1 || profile.maxFutureAppointments > 3) {
    problems.push('maxFutureAppointments precisa ficar entre 1 e 3');
  }
  // A mesma palavra em dois serviços do perfil deixaria a triagem sempre em dúvida.
  const seen = new Map<string, string>();
  for (const s of profile.services) {
    for (const k of s.keywords) {
      const other = seen.get(k);
      if (other && other !== s.code) problems.push(`palavra "${k}" em ${other} e ${s.code}`);
      seen.set(k, s.code);
    }
  }
  return problems;
}
