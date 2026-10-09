import { normalize } from '../lib/text.js';
import { SERVICE_CODE, type Profile, type ScheduleTemplate, type ServiceDefinition } from './types.js';

export type { Profile, ScheduleTemplate, ServiceDefinition } from './types.js';

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

export const PROFILES = {
  'fisio-personal': {
    id: 'fisio-personal',
    description: 'Clínica com fisioterapia e personal trainer',
    services: [PHYSIOTHERAPY, PERSONAL_TRAINING],
    defaultSchedule: [PHYSIOTHERAPY_SCHEDULE, ...PERSONAL_SCHEDULE],
  },
  fisioterapia: {
    id: 'fisioterapia',
    description: 'Clínica ou fisioterapeuta (só fisioterapia)',
    services: [PHYSIOTHERAPY],
    defaultSchedule: [PHYSIOTHERAPY_SCHEDULE],
  },
  personal: {
    id: 'personal',
    description: 'Personal trainer ou estúdio (só treino)',
    services: [PERSONAL_TRAINING],
    defaultSchedule: PERSONAL_SCHEDULE,
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
