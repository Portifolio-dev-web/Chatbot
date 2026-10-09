-- Perfil de psicologia (src/profiles): atendimento de menores marcado pelo responsável e
-- sessões mais curtas que o intervalo da grade (50 min, de hora em hora). Só acrescenta
-- colunas com valor padrão: nada existente muda.

-- Menor de idade: o cliente (quem conversa com o bot) é o responsável; o nome do paciente
-- fica CRIPTOGRAFADO na aplicação (AES-256-GCM, campo 'appointment.patient_name') e é
-- apagado junto na anonimização do responsável. LGPD art. 14.
ALTER TABLE "appointments" ADD COLUMN     "patient_is_minor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "patient_name_encrypted" TEXT;

-- Duração do atendimento quando é menor que o intervalo entre horários. Nulo = igual.
ALTER TABLE "availability_rules" ADD COLUMN     "session_minutes" SMALLINT;

-- A sessão cabe no intervalo (senão dois horários seguidos da mesma grade se sobreporiam).
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_session_check" CHECK (
  "session_minutes" IS NULL OR "session_minutes" BETWEEN 5 AND "slot_minutes"
);
