import dotenv from 'dotenv';
import { z } from 'zod';

// Carrega o .env se ele existir (desenvolvimento). Em produção as variáveis vêm da plataforma
// (Render, Railway, docker compose) e o .env nem entra na imagem. Não sobrescreve o que já
// estiver definido no ambiente. `quiet`: sem a linha de propaganda do dotenv no log.
dotenv.config({ quiet: true });

export type AppEnvironment = 'development' | 'test' | 'production';

/**
 * SEGURANÇA (fail-closed): só os valores exatos "development" e "test" desligam as travas de
 * produção. NODE_ENV ausente, vazio ou digitado errado ("prod", "producao") = produção.
 * Risco evitado: o deploy que esquece a variável e sobe "funcionando" em modo de desenvolvimento.
 */
export function resolveEnvironment(raw: string | undefined): AppEnvironment {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'development' || value === 'test' ? value : 'production';
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KEY_HINT = '32 bytes em base64 (gere com o comando do .env.example)';

function isKey32(value: string): boolean {
  return BASE64.test(value) && Buffer.from(value, 'base64').length === 32;
}

function splitKeys(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

// Mensagens de erro em português e SEM ecoar o valor recebido: o erro vai para o log da
// plataforma, e o valor pode ser um segredo digitado no campo errado.
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z
    .string({ error: 'obrigatória' })
    .regex(/^postgres(ql)?:\/\//, 'deve começar com postgresql://'),
  DATABASE_TLS_DISABLED: z.stringbool({ error: 'use true ou false' }).default(false),

  WHATSAPP_VERIFY_TOKEN: z
    .string({ error: 'obrigatório' })
    .min(32, 'mínimo de 32 caracteres aleatórios (veja o comando no .env.example)'),
  WHATSAPP_APP_SECRET: z.string({ error: 'obrigatória' }).min(16, 'parece incompleta'),
  WHATSAPP_ACCESS_TOKEN: z.string({ error: 'obrigatório' }).min(20, 'parece incompleto'),
  WHATSAPP_PHONE_NUMBER_ID: z
    .string({ error: 'obrigatório' })
    .regex(/^\d{5,25}$/, 'só dígitos: é o ID do número no painel da Meta, não o telefone'),
  WHATSAPP_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'formato vNN.N, ex.: v25.0')
    .default('v25.0'),

  // PRIVACIDADE (Passo 2): chaves da criptografia de nome/telefone e do índice cego do
  // telefone. Obrigatórias em TODOS os ambientes: sem elas não há como gravar cliente.
  ENCRYPTION_KEY: z.string({ error: 'obrigatória' }).refine(isKey32, KEY_HINT),
  ENCRYPTION_KEYS_PREVIOUS: z
    .string()
    .optional()
    .refine((v) => splitKeys(v).every(isKey32), `cada chave antiga: ${KEY_HINT}`),
  BLIND_INDEX_KEY: z.string({ error: 'obrigatória' }).refine(isKey32, KEY_HINT),

  CLINIC_TIMEZONE: z
    .string()
    .default('America/Sao_Paulo')
    .refine(isValidTimeZone, 'fuso horário inválido (use o formato IANA, ex.: America/Sao_Paulo)'),
  PRIVACY_POLICY_URL: z.url({ error: 'endereço inválido' }).optional(),
  // Passo 4B: WhatsApp da recepção, que recebe os avisos de agendamento e cancelamento.
  RECEPTION_WHATSAPP: z
    .string()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v.length >= 10 && v.length <= 15, 'use DDI + DDD + número, ex.: 5511900000000')
    .optional(),
});

type RawConfig = z.infer<typeof schema>;

// TLS no banco: o pg aceita sslmode=require | verify-ca | verify-full na URL.
const DB_TLS_PATTERN = /[?&]sslmode=(require|verify-ca|verify-full)(&|$)/;

/**
 * Regras que só valem em produção. Configuração obrigatória ausente aqui = o servidor
 * se recusa a subir (melhor um deploy que falha na hora do que um que vaza depois).
 */
function productionRules(cfg: RawConfig, ctx: z.RefinementCtx): void {
  // Sem TLS, senha do banco e dados dos clientes trafegam legíveis pela rede do provedor.
  if (!cfg.DATABASE_TLS_DISABLED && !DB_TLS_PATTERN.test(cfg.DATABASE_URL)) {
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message:
        'em produção, inclua ?sslmode=require (ou DATABASE_TLS_DISABLED=true se o banco ' +
        'estiver na mesma máquina/rede privada, como no docker compose)',
    });
  }
  // LGPD art. 9º: o titular precisa ter acesso à política antes de informar seus dados.
  if (!cfg.PRIVACY_POLICY_URL?.startsWith('https://')) {
    ctx.addIssue({
      code: 'custom',
      path: ['PRIVACY_POLICY_URL'],
      message: 'obrigatória em produção, com https:// (o bot envia o link no primeiro contato)',
    });
  }
  // Sem ele, a recepção não fica sabendo de agendamentos e cancelamentos feitos pelo bot.
  if (!cfg.RECEPTION_WHATSAPP) {
    ctx.addIssue({
      code: 'custom',
      path: ['RECEPTION_WHATSAPP'],
      message: 'obrigatório em produção (a recepção recebe os avisos da agenda)',
    });
  }
}

export interface AppConfig {
  env: AppEnvironment;
  isProduction: boolean;
  port: number;
  logLevel: RawConfig['LOG_LEVEL'];
  databaseUrl: string;
  whatsapp: {
    verifyToken: string;
    appSecret: string;
    accessToken: string;
    phoneNumberId: string;
    apiVersion: string;
  };
  crypto: {
    encryptionKey: Buffer;
    /** Chaves antigas, só para LER dados ainda não regravados após uma troca de chave. */
    previousEncryptionKeys: Buffer[];
    blindIndexKey: Buffer;
  };
  clinic: {
    timezone: string;
    /** Só dígitos. Fora de produção pode faltar: os avisos à recepção ficam esperando na fila. */
    receptionWhatsapp: string | undefined;
  };
  privacyPolicyUrl: string | undefined;
  /** Avisos de inicialização para o servidor registrar no log (sem valores de segredos). */
  warnings: string[];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Lê e valida a configuração. Recebe o ambiente como parâmetro para os testes poderem
 * simular produção sem mexer no process.env.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = resolveEnvironment(source.NODE_ENV);

  // Variável vazia no .env (`PRIVACY_POLICY_URL=`) conta como ausente: assim o padrão e a
  // mensagem "obrigatória" funcionam, em vez de um erro confuso de "endereço inválido".
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const trimmed = value?.trim();
    if (trimmed) cleaned[key] = trimmed;
  }

  const result = schema
    .superRefine((cfg, ctx) => {
      // Chaves separadas por função: vazar (ou trocar) uma não compromete a outra.
      if (cfg.ENCRYPTION_KEY === cfg.BLIND_INDEX_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['BLIND_INDEX_KEY'],
          message: 'deve ser diferente da ENCRYPTION_KEY',
        });
      }
      if (env === 'production') productionRules(cfg, ctx);
    })
    .safeParse(cleaned);

  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(geral)'}: ${issue.message}`,
    );
    throw new ConfigError(
      `Configuração inválida (ambiente: ${env}). O servidor não vai subir.\n${lines.join('\n')}`,
    );
  }

  const cfg = result.data;
  const warnings: string[] = [];
  const rawEnv = source.NODE_ENV?.trim();
  if (rawEnv !== 'development' && rawEnv !== 'test' && rawEnv !== 'production') {
    warnings.push('NODE_ENV ausente ou desconhecido: tratando como produção (todas as travas ligadas).');
  }

  return {
    env,
    isProduction: env === 'production',
    port: cfg.PORT,
    logLevel: cfg.LOG_LEVEL,
    databaseUrl: cfg.DATABASE_URL,
    whatsapp: {
      verifyToken: cfg.WHATSAPP_VERIFY_TOKEN,
      appSecret: cfg.WHATSAPP_APP_SECRET,
      accessToken: cfg.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: cfg.WHATSAPP_PHONE_NUMBER_ID,
      apiVersion: cfg.WHATSAPP_API_VERSION,
    },
    crypto: {
      encryptionKey: Buffer.from(cfg.ENCRYPTION_KEY, 'base64'),
      previousEncryptionKeys: splitKeys(cfg.ENCRYPTION_KEYS_PREVIOUS).map((k) =>
        Buffer.from(k, 'base64'),
      ),
      blindIndexKey: Buffer.from(cfg.BLIND_INDEX_KEY, 'base64'),
    },
    clinic: { timezone: cfg.CLINIC_TIMEZONE, receptionWhatsapp: cfg.RECEPTION_WHATSAPP },
    privacyPolicyUrl: cfg.PRIVACY_POLICY_URL,
    warnings,
  };
}

let cached: AppConfig | undefined;

/**
 * Configuração da aplicação, lida uma vez. É uma função (e não uma constante exportada) para
 * que o erro de configuração aconteça dentro do `main()` do servidor, que mostra a mensagem
 * limpa e encerra, em vez de estourar durante os imports.
 */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}
