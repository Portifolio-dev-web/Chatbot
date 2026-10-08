/*
 * Templates (modelos de mensagem) aprovados no painel da Meta. Mensagens que o bot inicia
 * (fora da janela de 24 h após a última mensagem do cliente) SÓ podem usar template.
 * Os nomes e a ordem das variáveis aqui precisam bater EXATAMENTE com o cadastro na Meta.
 *
 * Cadastre em: Gerenciador do WhatsApp > Modelos de mensagem. Categoria: Utilidade.
 * Idioma: Português (BR).
 */
export const TEMPLATE_LANGUAGE = 'pt_BR';

export const TEMPLATES = {
  /**
   * lembrete_atendimento
   * Corpo: "Olá, {{1}}! Passando para lembrar do seu horário de {{2}} em {{3}}.
   *         Podemos contar com você?"
   * Botões de resposta rápida (nesta ordem): "Confirmo" | "Preciso remarcar"
   * {{1}} primeiro nome, {{2}} serviço ("fisioterapia"), {{3}} "quinta-feira, 09/10 às 08:00"
   */
  reminder: 'lembrete_atendimento',
  /**
   * aviso_agenda_recepcao (enviado ao WhatsApp da recepção, RECEPTION_WHATSAPP)
   * Corpo: "Aviso automático da agenda do WhatsApp: {{1}}. Cliente: {{2}}. Serviço: {{3}}.
   *         Data e horário: {{4}}. Confira na sua agenda."
   * {{1}} "novo agendamento" | "cancelamento" | "cancelamento com menos de 24 h"
   */
  receptionNotice: 'aviso_agenda_recepcao',
} as const;
