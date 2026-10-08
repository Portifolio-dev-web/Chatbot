import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { defaultScheduleRows } from '../content/default-schedule.js';
import { PrismaClient } from '../generated/prisma/client.js';

/*
 * Cria a grade de horários de EXEMPLO (src/content/default-schedule.ts) se a tabela estiver
 * vazia. Rodar de novo não duplica nem sobrescreve o que a clínica já ajustou.
 *
 * Fica em src/ (e não em prisma/) para ser compilado junto: a imagem Docker de produção não
 * leva o tsx. Nunca roda sozinho no deploy, para a grade de EXEMPLO não entrar em produção
 * sem querer.
 *
 * Rodar: npm run db:seed                                   (desenvolvimento)
 *        docker compose run --rm app node dist/scripts/seed.js  (container)
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  try {
    const existing = await prisma.availabilityRule.count();
    if (existing > 0) {
      console.log(`Grade de horários já existe (${existing} regras): nada a fazer.`);
      return;
    }
    const data = defaultScheduleRows();
    await prisma.availabilityRule.createMany({ data });
    console.log(`Grade de horários de exemplo criada: ${data.length} regras.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  // Só o tipo do erro: mensagens do Prisma podem trazer dados da operação.
  console.error('Falha no seed:', err instanceof Error ? err.name : typeof err);
  process.exit(1);
});
