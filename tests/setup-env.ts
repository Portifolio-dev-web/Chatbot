// Configuração FICTÍCIA para os testes (nenhum valor aqui é credencial real). Atribuída à
// força, para os testes nunca usarem por acaso o .env ou o ambiente de quem os roda.
// O banco de integração é outro: TEST_DATABASE_URL (ver tests/db.integration.test.ts).
const fake: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://teste:teste@localhost:5432/teste',
  WHATSAPP_VERIFY_TOKEN: 'v'.repeat(32),
  WHATSAPP_APP_SECRET: 'a'.repeat(32),
  WHATSAPP_ACCESS_TOKEN: 't'.repeat(40),
  WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BLIND_INDEX_KEY: Buffer.alloc(32, 2).toString('base64'),
  CLINIC_PROFILE: 'fisio-personal',
};

for (const [key, value] of Object.entries(fake)) process.env[key] = value;
