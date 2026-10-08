import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { getLogger, safeError } from './lib/logger.js';
import { requestLog } from './middlewares/request-log.js';
import { createWebhookRouter } from './routes/webhook.routes.js';
import type { WebhookEventSink } from './services/inbound-dispatcher.js';

export interface AppDeps {
  /** Quem trata os eventos do webhook (o server liga o real; os testes, um falso). */
  webhookSink: WebhookEventSink;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();

  app.use(requestLog);

  // SEGURANÇA: esta API não serve páginas, só JSON para a Meta e o /health. Cabeçalhos
  // restritivos: nada pode ser embutido em iframe, reinterpretado como outro tipo ou executado.
  // O helmet também remove o "X-Powered-By: Express", que anuncia a tecnologia a quem sonda.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      // O padrão do helmet é SAMEORIGIN; aqui nem o próprio site embute a API.
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // Respostas podem conter dado pessoal: nenhum proxy ou navegador deve guardar cópia.
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Vivacidade para Docker/Render/Railway: responde se o processo está de pé.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(createWebhookRouter(deps.webhookSink));

  // 404 sem ecoar a URL pedida (ela pode conter dados).
  app.use((_req, res) => {
    res.status(404).json({ error: 'Não encontrado.' });
  });

  // Erros: 4xx de entrada malformada (ex.: JSON inválido) viram resposta genérica; o resto é
  // 500 sem detalhes internos. O log leva só tipo/código/pilha (ver safeError).
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const status: unknown = err?.status ?? err?.statusCode;
    const isClientError = typeof status === 'number' && status >= 400 && status < 500;
    const logger = getLogger();
    const entry = { err: safeError(err), requestId: res.locals.requestId };

    if (isClientError) logger.warn(entry, 'requisição recusada');
    else logger.error(entry, 'erro não tratado');

    if (res.headersSent) return;
    if (isClientError) res.status(status).json({ error: 'Requisição inválida.' });
    else res.status(500).json({ error: 'Erro interno.' });
  };
  app.use(errorHandler);

  return app;
}
