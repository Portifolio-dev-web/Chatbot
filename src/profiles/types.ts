/*
 * Perfil = o "tipo de negócio" de uma instalação do bot (fisioterapia, personal...). Cada
 * cliente roda com UM perfil, escolhido em CLINIC_PROFILE. O perfil define quais serviços
 * existem, como aparecem no menu, como a triagem os reconhece e a grade de horários de exemplo.
 * Os dados do negócio em si (nome, endereço, preços) continuam em src/content/clinic.ts.
 */

/** Código de serviço: gravado no banco (service_type) e nos ids dos botões. */
export const SERVICE_CODE = /^[A-Z][A-Z_]{1,39}$/;

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
}

/** Bloco da grade semanal de EXEMPLO (o seed grava em availability_rules). */
export interface ScheduleTemplate {
  serviceCode: string;
  /** 0 = domingo ... 6 = sábado. */
  weekdays: readonly number[];
  /** Turnos "HH:MM" -> "HH:MM", no fuso da clínica. */
  windows: ReadonlyArray<readonly [start: string, end: string]>;
  slotMinutes: number;
}

export interface Profile {
  id: string;
  /** Para quem serve (aparece na documentação e nos erros de configuração). */
  description: string;
  /** De 1 a 3 serviços (3 é o limite de botões do WhatsApp na escolha de serviço). */
  services: readonly ServiceDefinition[];
  defaultSchedule: readonly ScheduleTemplate[];
}
