import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { getLogger } from '../lib/logger.js';

/**
 * Log de acesso sem dado pessoal: método, MODELO da rota (ex.: "/webhook", nunca a URL real),
 * status e duração. A URL real fica de fora porque a verificação da Meta manda o token na
 * query string (?hub.verify_token=...), e log não é lugar de segredo.
 * O X-Request-ID devolvido permite achar a requisição no log sem expor nada.
 */
export const requestLog: RequestHandler = (req, res, next) => {
  const requestId = randomUUID();
  const started = process.hrtime.bigint();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : '(sem rota)';
    const entry = {
      requestId,
      method: req.method,
      route,
      status: res.statusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
    };
    // O healthcheck do Docker bate a cada poucos segundos: só aparece com LOG_LEVEL=debug.
    if (route === '/health') getLogger().debug(entry, 'requisição');
    else getLogger().info(entry, 'requisição');
  });

  next();
};
