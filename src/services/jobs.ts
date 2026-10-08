import { OUTBOX, RETENTION } from '../config/business-rules.js';
import { getLogger, safeError } from '../lib/logger.js';
import { runMaintenance } from './maintenance.js';
import { processOutbox, type OutboxDeps } from './outbox.js';

/**
 * Agendador das rotinas de fundo, dentro do próprio servidor: a fila a cada 30 s e a retenção
 * a cada hora. Uma rodada nunca começa antes de a anterior terminar. A fila é segura com mais
 * de uma instância (SKIP LOCKED), então dá para escalar sem mudar nada aqui.
 */
export function startBackgroundJobs(deps: OutboxDeps): { stop(): Promise<void> } {
  const logger = getLogger();
  let running: Promise<void> | undefined;
  let lastMaintenance = 0;
  let stopped = false;

  const tick = (): void => {
    if (running || stopped) return;
    running = (async () => {
      const now = new Date();
      // Esvazia o que estiver vencido (lotes de OUTBOX.batchSize) antes de dormir de novo.
      let claimed: number;
      do {
        claimed = (await processOutbox(deps, now)).claimed;
      } while (!stopped && claimed === OUTBOX.batchSize);
      if (!stopped && now.getTime() - lastMaintenance >= RETENTION.maintenanceIntervalMs) {
        lastMaintenance = now.getTime();
        await runMaintenance(deps.prisma, now);
      }
    })()
      .catch((err: unknown) => logger.error({ err: safeError(err) }, 'falha numa rotina de fundo'))
      .finally(() => {
        running = undefined;
      });
  };

  const interval = setInterval(tick, OUTBOX.pollIntervalMs);
  const first = setTimeout(tick, 2_000); // primeira rodada logo depois de subir
  interval.unref();
  first.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
      clearTimeout(first);
      await running;
    },
  };
}
