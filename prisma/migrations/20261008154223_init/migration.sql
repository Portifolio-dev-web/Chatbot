-- CreateEnum
CREATE TYPE "service_type" AS ENUM ('PHYSIOTHERAPY', 'PERSONAL_TRAINING');

-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "actor" AS ENUM ('CLIENT', 'STAFF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "outbound_kind" AS ENUM ('CLIENT_REMINDER', 'RECEPTION_NEW_BOOKING', 'RECEPTION_CANCELLATION');

-- CreateEnum
CREATE TYPE "outbound_status" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "phone_hash" CHAR(64),
    "phone_encrypted" TEXT,
    "name_encrypted" TEXT,
    "last_interaction_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anonymized_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "service_type" "service_type" NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "appointment_status" NOT NULL DEFAULT 'CONFIRMED',
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" "actor",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_rules" (
    "id" SERIAL NOT NULL,
    "service_type" "service_type" NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "end_minute" SMALLINT NOT NULL,
    "slot_minutes" SMALLINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "availability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_blocks" (
    "id" SERIAL NOT NULL,
    "service_type" "service_type",
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" VARCHAR(120),

    CONSTRAINT "schedule_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "client_id" UUID NOT NULL,
    "step" VARCHAR(40) NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "last_inbound_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("client_id")
);

-- CreateTable
CREATE TABLE "processed_messages" (
    "wa_message_id" VARCHAR(255) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("wa_message_id")
);

-- CreateTable
CREATE TABLE "outbound_messages" (
    "id" UUID NOT NULL,
    "kind" "outbound_kind" NOT NULL,
    "appointment_id" UUID NOT NULL,
    "send_after" TIMESTAMPTZ(3) NOT NULL,
    "status" "outbound_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(40),
    "wa_message_id" VARCHAR(255),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_texts" (
    "version" VARCHAR(40) NOT NULL,
    "body" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_texts_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "text_version" VARCHAR(40) NOT NULL,
    "given_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evidence_message_id" VARCHAR(255),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" "actor" NOT NULL,
    "action" VARCHAR(60) NOT NULL,
    "entity_type" VARCHAR(40) NOT NULL,
    "entity_id" VARCHAR(64) NOT NULL,
    "detail" JSONB,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clients_phone_hash_key" ON "clients"("phone_hash");

-- CreateIndex
CREATE INDEX "appointments_starts_at_idx" ON "appointments"("starts_at");

-- CreateIndex
CREATE INDEX "appointments_client_id_starts_at_idx" ON "appointments"("client_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_slot_taken" ON "appointments"("service_type", "starts_at") WHERE ("status" != 'CANCELLED');

-- CreateIndex
CREATE INDEX "availability_rules_service_type_weekday_idx" ON "availability_rules"("service_type", "weekday");

-- CreateIndex
CREATE INDEX "schedule_blocks_starts_at_ends_at_idx" ON "schedule_blocks"("starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "conversations_expires_at_idx" ON "conversations"("expires_at");

-- CreateIndex
CREATE INDEX "processed_messages_received_at_idx" ON "processed_messages"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_messages_wa_message_id_key" ON "outbound_messages"("wa_message_id");

-- CreateIndex
CREATE INDEX "outbound_messages_status_send_after_idx" ON "outbound_messages"("status", "send_after");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_messages_appointment_id_kind_key" ON "outbound_messages"("appointment_id", "kind");

-- CreateIndex
CREATE INDEX "consents_client_id_given_at_idx" ON "consents"("client_id", "given_at");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_idx" ON "audit_events"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events"("occurred_at");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_text_version_fkey" FOREIGN KEY ("text_version") REFERENCES "consent_texts"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Regras que o schema do Prisma não expressa. O banco é a última barreira: elas valem
-- mesmo para quem mexer direto pelo console do banco ou para um bug na aplicação.
-- ===========================================================================

-- Cliente ativo sempre tem telefone (índice + cifrado); cliente anonimizado não tem NENHUM
-- dado de identificação. Impede a "anonimização pela metade" (apagar o nome e esquecer o
-- telefone).
ALTER TABLE "clients" ADD CONSTRAINT "clients_identity_check" CHECK (
  ("anonymized_at" IS NULL AND "phone_hash" IS NOT NULL AND "phone_encrypted" IS NOT NULL)
  OR ("anonymized_at" IS NOT NULL AND "phone_hash" IS NULL AND "phone_encrypted" IS NULL
      AND "name_encrypted" IS NULL)
);

ALTER TABLE "appointments" ADD CONSTRAINT "appointments_time_check"
  CHECK ("ends_at" > "starts_at");
-- Cancelado <=> tem data e autor do cancelamento.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancel_check" CHECK (
  ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancelled_by" IS NOT NULL)
);

ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_check" CHECK (
  "weekday" BETWEEN 0 AND 6
  AND "start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute"
  AND "slot_minutes" BETWEEN 5 AND 480
  AND "end_minute" - "start_minute" >= "slot_minutes"
);

ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_time_check"
  CHECK ("ends_at" > "starts_at");

ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_attempts_check"
  CHECK ("attempts" >= 0);

-- SEGURANÇA/LGPD (arts. 37 e 46): trilha de auditoria SÓ ACEITA INCLUSÃO.
-- Exceção única: expurgo legal no fim do prazo de guarda, feito pela rotina de manutenção
-- dentro de uma transação com  SELECT set_config('app.audit_purge', 'on', true);
-- (vale só para aquela transação). UPDATE e TRUNCATE nunca.
CREATE FUNCTION "audit_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events aceita somente inclusão (% recusado)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "audit_events_no_change" BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();
CREATE TRIGGER "audit_events_no_truncate" BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_append_only"();

-- LGPD (art. 8º, §2º): o texto de consentimento de cada versão é IMUTÁVEL. Mudar o texto =
-- inserir nova versão; os consentimentos antigos continuam apontando para o que foi lido.
CREATE FUNCTION "consent_texts_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consent_texts é imutável: crie uma nova versão (% recusado)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "consent_texts_no_change" BEFORE UPDATE OR DELETE ON "consent_texts"
  FOR EACH ROW EXECUTE FUNCTION "consent_texts_immutable"();
CREATE TRIGGER "consent_texts_no_truncate" BEFORE TRUNCATE ON "consent_texts"
  FOR EACH STATEMENT EXECUTE FUNCTION "consent_texts_immutable"();
