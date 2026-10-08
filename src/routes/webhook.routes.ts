import express, { Router } from 'express';
import { receiveWebhook, verifyWebhook } from '../controllers/webhook.controller.js';
import { requireMetaSignature } from '../middlewares/meta-signature.js';
import type { WebhookEventSink } from '../services/inbound-dispatcher.js';

export function createWebhookRouter(sink: WebhookEventSink): Router {
  const router = Router();

  router.get('/webhook', verifyWebhook);
  router.post(
    '/webhook',
    // Corpo BRUTO (Buffer), necessário para conferir a assinatura. Limite de 1 MB: os
    // webhooks da Meta têm poucos KB (mídia chega só como ID); mais que isso é abuso.
    express.raw({ type: 'application/json', limit: '1mb' }),
    requireMetaSignature,
    receiveWebhook(sink),
  );

  return router;
}
