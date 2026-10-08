import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { getConfig, type AppConfig } from '../config/env.js';

/*
 * PRIVACIDADE (LGPD arts. 6º, III e 46): o log nunca leva dado pessoal.
 * Telefone, nome e texto das mensagens identificam o cliente, e a queixa ("dor no joelho")
 * é dado de saúde (art. 11). O log é copiado para painéis da plataforma, terminais e suporte,
 * sem o controle de acesso do banco. Regra: identifique pelo ID interno (clientId,
 * appointmentId); nunca registre o corpo do webhook nem o texto de uma mensagem.
 *
 * O `redact` abaixo é a segunda barreira: se um objeto com esses campos for logado por
 * engano, o valor sai como "[removido]".
 */
const REDACT_PATHS = [
  // Credenciais em cabeçalhos
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature-256"]',
  // Erros do axios carregam a requisição inteira: token no cabeçalho, mensagem no corpo.
  'err.config',
  'err.request',
  'err.response',
  '*.config',
  // Campos pessoais do payload do WhatsApp e dos nossos modelos
  'phone',
  '*.phone',
  'name',
  '*.name',
  'from',
  '*.from',
  'to',
  '*.to',
  'wa_id',
  '*.wa_id',
  'profile',
  '*.profile',
  'contacts',
  '*.contacts',
  'messages',
  '*.messages',
  'text',
  '*.text',
  'body',
  '*.body',
];

/**
 * pino-pretty é dependência só de desenvolvimento: não existe na imagem Docker. Se o
 * container rodar com NODE_ENV=development, o log sai em JSON em vez de derrubar o servidor.
 */
function prettyAvailable(): boolean {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/** `destination` serve aos testes, que capturam as linhas para conferir que não há dado pessoal. */
export function createLogger(
  cfg: Pick<AppConfig, 'env' | 'logLevel'>,
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level: cfg.logLevel,
    base: { service: 'chatbot' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[removido]' },
    // Desenvolvimento: log colorido e legível. Produção: JSON, uma linha por evento, que os
    // painéis das plataformas sabem filtrar. (pino-pretty é dependência só de desenvolvimento.)
    ...(cfg.env === 'development' && !destination && prettyAvailable()
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'service' },
          },
        }
      : {}),
  };
  return destination ? pino(options, destination) : pino(options);
}

let instance: Logger | undefined;

export function getLogger(): Logger {
  instance ??= createLogger(getConfig());
  return instance;
}

/** Só para testes: troca o logger global (undefined volta ao padrão). */
export function setLoggerForTesting(logger: Logger | undefined): void {
  instance = logger;
}

/**
 * Versão do erro segura para o log: tipo, código e pilha de chamadas, SEM a mensagem.
 * Motivo: mensagens de erro de bibliotecas costumam carregar os dados da operação (o Prisma,
 * por exemplo, imprime os argumentos da consulta, com nome e telefone do cliente).
 * O tipo e o código (ex.: P2002, EADDRINUSE) bastam para diagnosticar a maioria dos casos.
 */
export function safeError(err: unknown): { type: string; code?: string; stack?: string } {
  if (!(err instanceof Error)) return { type: typeof err };
  const code = (err as { code?: unknown }).code;
  const frames = err.stack
    ?.split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .join('\n');
  return {
    type: err.name,
    ...(typeof code === 'string' ? { code } : {}),
    ...(frames ? { stack: frames } : {}),
  };
}
