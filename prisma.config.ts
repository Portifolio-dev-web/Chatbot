import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7: a URL do banco sai do schema e vem para cá. Lida do ambiente (ou do .env no
// desenvolvimento), nunca escrita no código.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/scripts/seed.ts',
  },
  datasource: {
    // `prisma generate` (no build da imagem) não precisa de banco; migrar precisa, e o
    // próprio Prisma acusa a falta da URL nesse caso.
    url: process.env.DATABASE_URL ?? '',
  },
});
