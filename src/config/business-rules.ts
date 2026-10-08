/*
 * Regras de agendamento da clínica. Valores aprovados no Passo 4A; ajuste aqui se a clínica
 * mudar a política (não precisa mexer em mais nada).
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const BOOKING_RULES = {
  /** Antecedência mínima para marcar pelo bot. */
  minNoticeMs: 2 * HOUR,
  /** Até quantos dias à frente o bot oferece horários. */
  horizonDays: 14,
  /** Cancelar pelo bot só até este tempo antes; depois, com a recepção. */
  cancelMinNoticeMs: 24 * HOUR,
  /**
   * Máximo de agendamentos futuros por cliente. Evita que uma pessoa (ou alguém mal-
   * intencionado) lote a agenda, e cabe nos 3 botões da tela "meus agendamentos".
   */
  maxFutureAppointments: 3,
  /** Lembrete por template (Passo 4B). */
  reminderBeforeMs: 24 * HOUR,
  /** Conversa parada por mais que isso recomeça do menu. */
  conversationTtlMs: 2 * HOUR,
} as const;

/**
 * Mensagens por número por minuto. Acima disso o bot para de responder àquele número até a
 * janela virar: protege a cota de envio do número da clínica e o banco contra robôs.
 */
export const MESSAGE_RATE_LIMIT = { max: 15, windowMs: MINUTE } as const;

/**
 * Lembrete ao cliente não sai de madrugada: fora das 8h–20h (fuso da clínica), é ADIANTADO
 * para as 20h anteriores. Sempre adiantado, nunca atrasado: assim continua saindo com pelo
 * menos 24 h de antecedência.
 */
export const REMINDER_SEND_WINDOW = { fromMinute: 8 * 60, toMinute: 20 * 60 } as const;

/** Fila de mensagens ativas (lembretes e avisos à recepção). */
export const OUTBOX = {
  /** De quanto em quanto tempo a fila é conferida. */
  pollIntervalMs: 30_000,
  batchSize: 20,
  /**
   * Quem pega uma mensagem tem este tempo para enviá-la. Se o processo cair no meio, ela
   * volta para a fila sozinha quando o prazo vence.
   */
  leaseMs: 2 * MINUTE,
  maxAttempts: 5,
  /** Espera antes da 2ª, 3ª, 4ª e 5ª tentativas. */
  retryDelaysMs: [1 * MINUTE, 5 * MINUTE, 15 * MINUTE, 60 * MINUTE],
} as const;

/** Retenção (LGPD art. 15 e 16: guardar só enquanto houver finalidade). */
export const RETENTION = {
  /** IDs de mensagens já processadas (só servem contra reentregas da Meta). */
  processedMessagesDays: 7,
  /** Cliente sem conversa nem agendamento há mais que isso é anonimizado. */
  inactiveClientDays: 365,
  maintenanceIntervalMs: HOUR,
} as const;
