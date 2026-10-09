import { normalize } from '../../lib/text.js';

/*
 * Mensagem com possível RISCO: ideação suicida, autolesão, violência sofrida.
 *
 * Por que existe: um bot que responde "Desculpe, não entendi 😅" a "não aguento mais, quero
 * morrer" causa dano real. Com esta checagem, ANTES de qualquer outra interpretação, a pessoa
 * recebe na hora os contatos de emergência (CVV 188, SAMU 192, 190); no perfil de psicologia, a
 * profissional também recebe um alerta.
 *
 * Limites (precisam constar no contrato com o cliente): é detecção por palavras. Deixa passar
 * frases sem estas palavras e às vezes dispara à toa ("morrer de rir"). Na dúvida, dispara: a
 * resposta é acolhedora e inofensiva mesmo num falso positivo. Não substitui avaliação de risco,
 * que o CFP considera atribuição do psicólogo e indelegável a algoritmos.
 *
 * PRIVACIDADE: o texto é lido aqui e descartado; não vai para o banco nem para o log.
 */

/** Frases (já normalizadas: minúsculas, sem acento), procuradas como palavras inteiras. */
const PHRASES = [
  // ideação suicida
  'quero morrer',
  'queria morrer',
  'vontade de morrer',
  'prefiro morrer',
  'melhor morrer',
  'me matar',
  'vou me matar',
  'tirar minha vida',
  'tirar a minha vida',
  'tirar a vida',
  'acabar com minha vida',
  'acabar com a minha vida',
  'acabar com tudo',
  'nao quero mais viver',
  'nao quero viver',
  'nao aguento mais',
  'nao vejo saida',
  'sem saida',
  'desistir de viver',
  'desistir da vida',
  'melhor sem mim',
  'sumir para sempre',
  // autolesão
  'me cortar',
  'me corto',
  'me cortando',
  'me machucar',
  'me machuco',
  'me ferir',
  'me jogar',
  'me enforcar',
  'tomar todos os remedios',
  'tomei todos os remedios',
  // violência sofrida
  'estou sendo agredida',
  'estou sendo agredido',
  'me bate', // "meu marido me bate", "ele me bate"
  'me batem',
  'me bateu',
  'me agride',
  'me agrediu',
  'me espanca',
  'me espancou',
  'violencia domestica',
  'abuso sexual',
];

/** Começos de palavra (suicidio, suicidar; automutilacao; estupro...). */
const PREFIXES = ['suicid', 'automutil', 'autolesa', 'overdose', 'estupr', 'abusad', 'violentad'];

export function isCrisisMessage(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  const padded = ` ${normalized} `;
  if (PHRASES.some((phrase) => padded.includes(` ${phrase} `))) return true;
  return normalized.split(' ').some((word) => PREFIXES.some((prefix) => word.startsWith(prefix)));
}
