import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { getConfig } from '../config/env.js';
import { getLogger } from '../lib/logger.js';

/**
 * SEGURANÇA: a URL do webhook é pública. Sem esta conferência, qualquer pessoa poderia
 * "fingir ser a Meta" e mandar mensagens falsas em nome de qualquer telefone (marcar e
 * cancelar horários alheios, encher a agenda).
 *
 * A Meta assina cada entrega com HMAC-SHA256 do corpo BRUTO, usando a chave secreta do app
 * (WHATSAPP_APP_SECRET), no cabeçalho `X-Hub-Signature-256: sha256=<hex>`. Recalculamos e
 * comparamos em tempo constante. Por isso a rota recebe o corpo como Buffer (express.raw):
 * reserializar o JSON mudaria os bytes e a assinatura nunca bateria.
 */
export function isValidMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export const requireMetaSignature: RequestHandler = (req, res, next) => {
  if (!Buffer.isBuffer(req.body)) {
    // express.raw só preenche o corpo para application/json.
    res.status(415).json({ error: 'Use Content-Type: application/json.' });
    return;
  }
  if (!isValidMetaSignature(req.body, req.get('x-hub-signature-256'), getConfig().whatsapp.appSecret)) {
    getLogger().warn('webhook recusado: assinatura ausente ou inválida');
    res.status(401).json({ error: 'Assinatura inválida.' });
    return;
  }
  next();
};
