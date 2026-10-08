/**
 * Executa tarefas da MESMA chave uma de cada vez, na ordem de chegada. Usado por número de
 * cliente: duas mensagens enviadas em sequência ("oi" + "quero marcar") chegam em webhooks
 * separados, quase juntos; sem a fila, as duas leriam o mesmo estado da conversa e uma
 * resposta atropelaria a outra.
 *
 * Vale dentro de um processo. Com mais de uma instância do servidor, seria preciso uma trava
 * no banco (pg_advisory_lock por cliente); o agendamento em si já é protegido pelo banco.
 */
export function createKeyedMutex(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();

  return async function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    tails.set(key, tail);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

/** Limite simples por chave e janela fixa (em memória). */
export function createRateLimiter(
  max: number,
  windowMs: number,
  now: () => number = Date.now,
): { allow(key: string): boolean } {
  const windows = new Map<string, { start: number; count: number }>();

  return {
    allow(key) {
      const t = now();
      let entry = windows.get(key);
      if (!entry || t - entry.start >= windowMs) {
        entry = { start: t, count: 0 };
        windows.set(key, entry);
      }
      entry.count++;
      // Não deixa o mapa crescer sem fim: descarta janelas vencidas de vez em quando.
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
      }
      return entry.count <= max;
    },
  };
}
