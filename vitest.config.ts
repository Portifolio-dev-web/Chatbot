import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    // Os testes de integração compartilham um banco (TEST_DATABASE_URL), e a fila de envio
    // processa tudo o que estiver vencido. Em paralelo, um arquivo enviaria as mensagens que
    // outro ainda está conferindo. Um arquivo por vez: a suíte inteira leva poucos segundos.
    fileParallelism: false,
  },
});
