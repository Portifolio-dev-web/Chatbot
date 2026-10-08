import { getLogger, safeError } from './logger.js';

/*
 * Tarefas que rodam depois da resposta HTTP (ex.: processar a mensagem depois de devolver 200
 * à Meta). Ficam registradas aqui para o encerramento do servidor esperar por elas: sem isso,
 * um deploy no meio do atendimento cortaria a resposta ao cliente pela metade.
 */
const pending = new Set<Promise<void>>();

export function runInBackground(label: string, task: () => Promise<void>): void {
  const promise: Promise<void> = task()
    .catch((err: unknown) => {
      getLogger().error({ err: safeError(err), task: label }, 'falha em tarefa de fundo');
    })
    .finally(() => pending.delete(promise));
  pending.add(promise);
}

/** Espera as tarefas em andamento, até `timeoutMs`. Devolve false se alguma ficou para trás. */
export async function drainBackgroundTasks(timeoutMs: number): Promise<boolean> {
  if (pending.size === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const done = Promise.allSettled([...pending]).then(() => true as const);
  const result = await Promise.race([done, timeout]);
  clearTimeout(timer);
  return result;
}
