import { createApp } from './app.js';
import { ConfigError, getConfig, type AppConfig } from './config/env.js';
import { drainBackgroundTasks } from './lib/background.js';
import { getLogger, safeError } from './lib/logger.js';
import { disconnectPrisma, getPrisma } from './lib/prisma.js';
import {
  createInboundDispatcher,
  createPrismaDispatcherStore,
} from './services/inbound-dispatcher.js';
import { unfilledContentFields } from './content/clinic.js';
import { createChatbot } from './services/chatbot/chatbot.js';
import { startBackgroundJobs } from './services/jobs.js';
import { getWhatsAppClient } from './services/whatsapp-client.js';

function main(): void {
  let config: AppConfig;
  try {
    config = getConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Ainda sem logger (ele depende da configuração). A mensagem lista só os NOMES das
      // variáveis com problema, nunca os valores.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // Em produção, conteúdo da clínica com "PREENCHER" impede a subida: o bot não pode mandar
  // endereço ou preço de exemplo para um cliente de verdade.
  const unfilled = unfilledContentFields();
  if (config.isProduction && unfilled.length > 0) {
    console.error(
      'Conteúdo da clínica incompleto (src/content/clinic.ts). O servidor não vai subir.\n' +
        unfilled.map((field) => `  - CLINIC.${field}: ainda contém "PREENCHER"`).join('\n'),
    );
    process.exit(1);
  }

  const logger = getLogger();
  for (const warning of config.warnings) logger.warn(warning);
  if (unfilled.length > 0) {
    logger.warn({ fields: unfilled }, 'conteúdo da clínica com "PREENCHER" (permitido fora de produção)');
  }

  // PRIVACIDADE: por padrão o Node imprime a mensagem completa de erros não tratados, que pode
  // conter dados de clientes (ver safeError). Aqui registramos só tipo/código/pilha e saímos:
  // o Docker/plataforma reinicia o processo num estado limpo.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: safeError(reason) }, 'promessa rejeitada sem tratamento');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: safeError(err) }, 'exceção não tratada');
    process.exit(1);
  });

  const webhookSink = createInboundDispatcher({
    store: createPrismaDispatcherStore(getPrisma()),
    handler: createChatbot({
      prisma: getPrisma(),
      whatsapp: getWhatsAppClient(),
      timeZone: config.clinic.timezone,
      privacyPolicyUrl: config.privacyPolicyUrl,
      profile: config.profile,
    }),
  });

  const server = createApp({ webhookSink }).listen(config.port, (error) => {
    if (error) {
      logger.fatal({ err: safeError(error) }, 'não foi possível abrir a porta');
      process.exit(1);
    }
    // "clinicProfile", e não "profile": o logger apaga qualquer campo "profile" (no payload do
    // WhatsApp ele traz o nome da pessoa).
    logger.info(
      { port: config.port, env: config.env, clinicProfile: config.profileId },
      'servidor no ar',
    );
  });

  // Passo 4B: fila de lembretes/avisos à recepção e rotina de retenção.
  if (!config.clinic.receptionWhatsapp) {
    logger.warn('RECEPTION_WHATSAPP não definido: avisos à recepção ficam esperando na fila');
  }
  const jobs = startBackgroundJobs({
    prisma: getPrisma(),
    whatsapp: getWhatsAppClient(),
    timeZone: config.clinic.timezone,
    receptionPhone: config.clinic.receptionWhatsapp,
    profile: config.profile,
  });

  // Docker, Render e Railway mandam SIGTERM antes de parar o container: terminamos as
  // requisições em andamento (uma mensagem sendo respondida) em vez de cortá-las no meio.
  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'encerrando o servidor');
    server.close(() => {
      // Mensagens já aceitas (200 dado à Meta) ainda podem estar sendo respondidas, e a fila
      // pode estar no meio de um envio.
      Promise.all([drainBackgroundTasks(8_000), jobs.stop()])
        .then(([finished]) => {
          if (!finished) logger.warn('encerrando com tarefas de fundo ainda em andamento');
          return disconnectPrisma();
        })
        .catch((err: unknown) => logger.error({ err: safeError(err) }, 'falha ao encerrar'))
        .finally(() => process.exit(0));
    });
    // Se alguma conexão travar, não fica preso para sempre.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main();
