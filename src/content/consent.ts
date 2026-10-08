import { createHash } from 'node:crypto';
import { CLINIC } from './clinic.js';

/*
 * Aviso de consentimento mostrado antes do primeiro agendamento (LGPD art. 11, I: dado de
 * saúde exige consentimento específico e destacado; art. 9º: informar finalidade, quem é o
 * responsável e os direitos). PEÇA A UM ADVOGADO PARA REVISAR ESTE TEXTO.
 *
 * Versão = data da revisão + resumo (hash) do texto final. Qualquer mudança no texto (inclusive
 * nome da clínica ou link da política) gera versão nova automaticamente: quem consentiu antes
 * é convidado a ler e concordar de novo, e cada consentimento aponta para o texto exato lido
 * (tabela consent_texts, imutável).
 */
export const CONSENT_REVISION = '2026-10-08';

export interface ConsentText {
  version: string;
  body: string;
}

export function currentConsentText(policyUrl: string | undefined): ConsentText {
  const body = [
    '🔒 *Antes de agendar: seus dados*',
    '',
    `Para marcar seu horário, *${CLINIC.legalName}* (responsável pelos seus dados) vai guardar ` +
      'seu *nome*, seu *WhatsApp* e o *serviço e horário* escolhidos. Como isso pode indicar ' +
      'informação de saúde, pedimos seu consentimento específico.',
    '',
    'Usamos esses dados só para: agendar, lembrar você do horário e avisar nossa recepção. ' +
      'Eles ficam criptografados e não são vendidos nem usados para propaganda. As mensagens ' +
      'passam pelo WhatsApp (Meta).',
    '',
    'Você pode pedir para apagar seus dados quando quiser, escrevendo *privacidade*.',
    `Política completa: ${policyUrl ?? '(em preparação)'}`,
    '',
    'Você concorda?',
  ].join('\n');
  const digest = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 8);
  return { version: `${CONSENT_REVISION}.${digest}`, body };
}
