import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { scheduleRows } from '../content/default-schedule.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { PROFILE_IDS, PROFILES, type ProfileId } from '../profiles/index.js';

/*
 * Cria a grade de horários de EXEMPLO do perfil da instalação (CLINIC_PROFILE, ver
 * src/profiles) se a tabela estiver vazia. Rodar de novo não duplica nem sobrescreve o que
 * a clínica já ajustou.
 *
 * Fica em src/ (e não em prisma/) para ser compilado junto: a imagem Docker de produção não
 * leva o tsx. Nunca roda sozinho no deploy, para a grade de EXEMPLO não entrar em produção
 * sem querer.
 *
 * Rodar: npm run db:seed                                   (desenvolvimento)
 *        docker compose run --rm app node dist/scripts/seed.js  (container)
 */

/** Erro de configuração do próprio seed: a mensagem é nossa e não tem dados. */
class SeedConfigError extends Error {}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new SeedConfigError('DATABASE_URL não definida');
  const profileId = process.env.CLINIC_PROFILE?.trim();
  if (!profileId || !(PROFILE_IDS as string[]).includes(profileId)) {
    throw new SeedConfigError(`CLINIC_PROFILE inválido; use um destes: ${PROFILE_IDS.join(', ')}`);
  }
  const profile = PROFILES[profileId as ProfileId];
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  try {
    const existing = await prisma.availabilityRule.count();
    if (existing > 0) {
      console.log(`Grade de horários já existe (${existing} regras): nada a fazer.`);
      return;
    }
    const data = scheduleRows(profile.defaultSchedule);
    await prisma.availabilityRule.createMany({ data });
    console.log(`Grade de horários de exemplo (perfil ${profile.id}) criada: ${data.length} regras.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  // Mensagem só para erros nossos (sem dados); dos demais, só o tipo: mensagens do Prisma
  // podem trazer dados da operação.
  const detail = err instanceof SeedConfigError ? err.message : err instanceof Error ? err.name : typeof err;
  console.error('Falha no seed:', detail);
  process.exit(1);
});
