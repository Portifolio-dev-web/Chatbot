import type { RequestHandler } from 'express';
import { getConfig } from '../config/env.js';
import { runInBackground } from '../lib/background.js';
import { safeEqual } from '../lib/crypto.js';
import { getLogger } from '../lib/logger.js';
import type { WebhookEventSink } from '../services/inbound-dispatcher.js';
import { parseWebhookPayload } from '../services/webhook-parser.js';

// O "challenge" da Meta é um número. Só devolvemos texto neste formato: ecoar qualquer
// coisa que veio na URL abriria espaço para injetar conteúdo na resposta.
const CHALLENGE = /^[\w.-]{1,256}$/;

/**
 * GET /webhook: verificação feita pela Meta ao cadastrar o webhook no painel. Ela manda
 * hub.mode=subscribe, o token que você cadastrou e um número (challenge) que devemos devolver.
 */
export const verifyWebhook: RequestHandler = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (
    mode === 'subscribe' &&
    typeof token === 'string' &&
    safeEqual(token, getConfig().whatsapp.verifyToken) &&
    typeof challenge === 'string' &&
    CHALLENGE.test(challenge)
  ) {
    getLogger().info('webhook verificado pela Meta');
    res.type('text/plain').send(challenge);
    return;
  }
  getLogger().warn('verificação do webhook recusada');
  res.status(403).json({ error: 'Verificação recusada.' });
};

/**
 * POST /webhook: mensagens e avisos de entrega. A assinatura já foi conferida
 * (requireMetaSignature).
 *
 * Responde 200 LOGO e processa depois (em segundo plano): a Meta espera resposta rápida e,
 * sem ela, reentrega o mesmo evento repetidas vezes. Pelo mesmo motivo, um payload com
 * assinatura válida mas formato que não entendemos também recebe 200 (e vai para o log):
 * recusar faria a Meta insistir por dias.
 */
export function receiveWebhook(sink: WebhookEventSink): RequestHandler {
  return (req, res) => {
    let payload: unknown;
    try {
      payload = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      res.status(400).json({ error: 'JSON inválido.' });
      return;
    }

    const result = parseWebhookPayload(payload, getConfig().whatsapp.phoneNumberId);
    res.sendStatus(200);

    const logger = getLogger();
    if (!result.envelopeValid) logger.warn('webhook com formato desconhecido ignorado');
    if (result.skipped > 0) logger.warn({ skipped: result.skipped }, 'itens do webhook ignorados');
    if (result.events.length > 0) {
      runInBackground('webhook', () => sink.handleEvents(result.events));
    }
  };
}
