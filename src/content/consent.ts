import { createHash } from 'node:crypto';
import type { Profile } from '../profiles/index.js';
import { CLINIC } from './clinic.js';

/*
 * Aviso de consentimento mostrado antes do primeiro agendamento (LGPD art. 11, I: dado de
 * saúde exige consentimento específico e destacado; art. 9º: informar finalidade, quem é o
 * responsável e os direitos). PEÇA A UM ADVOGADO PARA REVISAR ESTE TEXTO.
 *
 * Duas versões: para o próprio paciente ('self') e para o responsável por uma criança ou
 * adolescente ('minor'; LGPD art. 14: consentimento específico de ao menos um dos pais ou do
 * responsável legal). Como os textos são diferentes, as versões também: concordar com um não
 * vale pelo outro.
 *
 * Versão = data da revisão + resumo (hash) do texto final. Qualquer mudança no texto (inclusive
 * nome da clínica ou link da política) gera versão nova automaticamente: quem consentiu antes
 * é convidado a ler e concordar de novo, e cada consentimento aponta para o texto exato lido
 * (tabela consent_texts, imutável).
 */
export const CONSENT_REVISION = '2026-10-09';

export type Audience = 'self' | 'minor';

export interface ConsentText {
  version: string;
  body: string;
}

export function currentConsentText(
  policyUrl: string | undefined,
  profile: Profile,
  audience: Audience = 'self',
): ConsentText {
  const policy = `Política completa: ${policyUrl ?? '(em preparação)'}`;
  const notify = profile.staff.noun;
  const body = (
    audience === 'self'
      ? [
          '🔒 *Antes de agendar: seus dados*',
          '',
          `Para marcar seu horário, *${CLINIC.legalName}* (responsável pelos seus dados) vai ` +
            'guardar seu *nome*, seu *WhatsApp* e o *serviço e horário* escolhidos. Como isso pode ' +
            'indicar informação de saúde, pedimos seu consentimento específico.',
          '',
          `Usamos esses dados só para: agendar, lembrar você do horário e avisar ${notify}. ` +
            'Eles ficam criptografados e não são vendidos nem usados para propaganda. As mensagens ' +
            'passam pelo WhatsApp (Meta).',
          '',
          'Você pode pedir para apagar seus dados quando quiser, escrevendo *privacidade*.',
          policy,
          '',
          'Você concorda?',
        ]
      : [
          '🔒 *Antes de agendar: dados da criança ou adolescente*',
          '',
          `Para marcar a sessão, *${CLINIC.legalName}* (responsável pelos dados) vai guardar o ` +
            '*nome do(a) paciente*, o *seu nome* e o *seu WhatsApp* (como responsável) e o ' +
            '*horário* escolhido. Como envolve informação de saúde de uma criança ou adolescente, ' +
            'a lei exige o consentimento específico de um dos pais ou do responsável legal ' +
            '(LGPD, art. 14).',
          '',
          'Ao tocar em *Concordo*, você declara ser *pai, mãe ou responsável legal* e autoriza o ' +
            `uso desses dados só para agendar, lembrar do horário e avisar ${notify}. Eles ficam ` +
            'criptografados e não são vendidos nem usados para propaganda. As mensagens passam ' +
            'pelo WhatsApp (Meta).',
          '',
          'Você pode pedir para apagar os dados quando quiser, escrevendo *privacidade*.',
          policy,
          '',
          'Você concorda?',
        ]
  ).join('\n');
  const digest = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 8);
  return { version: `${CONSENT_REVISION}.${digest}`, body };
}
