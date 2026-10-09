-- Perfis (src/profiles): os serviços deixam de ser um enum fixo do banco e passam a ser
-- códigos definidos pelo perfil da instalação (CLINIC_PROFILE). Um perfil novo não exige
-- migração.
--
-- ATENÇÃO: migração ESCRITA À MÃO. O Prisma geraria "apagar e recriar a coluna", perdendo
-- todos os agendamentos, a grade e os bloqueios. Aqui a coluna muda de tipo NO LUGAR: os
-- valores existentes ('PHYSIOTHERAPY', 'PERSONAL_TRAINING') viram o mesmo texto, e os índices
-- (inclusive o único parcial appointments_slot_taken) são reconstruídos pelo PostgreSQL.

ALTER TABLE "appointments"
  ALTER COLUMN "service_type" SET DATA TYPE VARCHAR(40) USING "service_type"::text;
ALTER TABLE "availability_rules"
  ALTER COLUMN "service_type" SET DATA TYPE VARCHAR(40) USING "service_type"::text;
ALTER TABLE "schedule_blocks"
  ALTER COLUMN "service_type" SET DATA TYPE VARCHAR(40) USING "service_type"::text;

DROP TYPE "service_type";

-- O banco não sabe quais serviços cada perfil tem (isso é da aplicação), mas garante o
-- FORMATO do código, o mesmo de src/profiles/types.ts (SERVICE_CODE). Em schedule_blocks,
-- NULL continua valendo "todos os serviços".
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_type_format"
  CHECK ("service_type" ~ '^[A-Z][A-Z_]{1,39}$');
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_service_type_format"
  CHECK ("service_type" ~ '^[A-Z][A-Z_]{1,39}$');
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_service_type_format"
  CHECK ("service_type" ~ '^[A-Z][A-Z_]{1,39}$');
