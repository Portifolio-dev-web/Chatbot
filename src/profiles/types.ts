/*
 * Perfil = o "tipo de negócio" de uma instalação do bot (fisioterapia, personal, psicologia...).
 * Cada cliente roda com UM perfil, escolhido em CLINIC_PROFILE. O perfil define quais serviços
 * existem, como aparecem no menu, como a triagem os reconhece, a grade de horários de exemplo
 * e regras próprias do tipo de atendimento (crise, menores, discrição).
 * Os dados do negócio em si (nome, endereço, preços) continuam em src/content/clinic.ts.
 */

/** Código de serviço: gravado no banco (service_type) e nos ids dos botões. */
export const SERVICE_CODE = /^[A-Z][A-Z_]{1,39}$/;

/** presencial: mostra endereço. online: explica que o link chega antes do horário. */
export type Modality = 'presencial' | 'online';

export interface ServiceDefinition {
  /**
   * Ex.: "PHYSIOTHERAPY". NUNCA mude o código de um serviço que já tem agendamentos: os
   * registros antigos guardam este valor.
   */
  code: string;
  /** Nome curto (vira título de botão: até 20 caracteres). */
  label: string;
  /** Linha de apoio no menu (até 72 caracteres). */
  menuDescription: string;
  /** Resposta da triagem quando a pessoa descreve o que procura ("dor no joelho"). */
  suggestion: string;
  /**
   * Palavras que apontam para este serviço na triagem, já normalizadas (minúsculas, sem
   * acento). A triagem só sugere quando exatamente UM serviço do perfil bate.
   */
  keywords: readonly string[];
  modality: Modality;
}

/** Bloco da grade semanal de EXEMPLO (o seed grava em availability_rules). */
export interface ScheduleTemplate {
  serviceCode: string;
  /** 0 = domingo ... 6 = sábado. */
  weekdays: readonly number[];
  /** Turnos "HH:MM" -> "HH:MM", no fuso da clínica. */
  windows: ReadonlyArray<readonly [start: string, end: string]>;
  /** De quanto em quanto tempo começa um horário (ex.: 60 = de hora em hora). */
  slotMinutes: number;
  /** Duração do atendimento, se menor que o intervalo (ex.: sessão de 50 min). */
  sessionMinutes?: number;
}

export interface Profile {
  id: string;
  /** Para quem serve (aparece na documentação e nos erros de configuração). */
  description: string;
  /** De 1 a 3 serviços (3 é o limite de botões do WhatsApp na escolha de serviço). */
  services: readonly ServiceDefinition[];
  defaultSchedule: readonly ScheduleTemplate[];
  /** Quem atende o contato humano: muda o texto do botão e das mensagens. */
  staff: {
    /** Botão/item de menu (até 20 caracteres). Ex.: "Falar com a recepção". */
    contactLabel: string;
    /** Como o bot se refere a essa pessoa no meio da frase. Ex.: "a recepção". */
    noun: string;
  };
  /** Máximo de agendamentos futuros por pessoa pelo bot (psicologia: só a 1ª sessão). */
  maxFutureAppointments: number;
  /**
   * Quem pode ser atendido:
   * - 'adults': não pergunta (o consentimento é da própria pessoa);
   * - 'adults_and_minors': pergunta "para mim / para menor de 18 / para outro adulto" e,
   *   para menor, pede consentimento do responsável legal (LGPD art. 14) e o nome do paciente.
   */
  audience: 'adults' | 'adults_and_minors';
  /**
   * Mensagem com palavras de risco (suicídio, autolesão, violência): a pessoa SEMPRE recebe
   * os contatos de emergência. Com `crisisAlert`, o WhatsApp de RECEPTION_WHATSAPP também
   * recebe um alerta (template alerta_risco).
   */
  crisisAlert: boolean;
  /** Lembretes sem o nome do serviço ("seu horário de atendimento"), para a tela bloqueada. */
  discreetReminders: boolean;
  /** Parágrafo extra nas boas-vindas (avisos próprios do tipo de atendimento). */
  welcomeNote?: string;
}
