import { describe, expect, it } from 'vitest';
import { CLINIC, unfilledContentFields } from '../src/content/clinic.js';
import { CONSENT_REVISION, currentConsentText } from '../src/content/consent.js';
import { createKeyedMutex, createRateLimiter } from '../src/lib/concurrency.js';
import { MENU_SECTIONS, TEXTS } from '../src/services/chatbot/texts.js';

const chars = (s: string): number => [...s].length;

describe('aviso de consentimento', () => {
  const url = 'https://exemplo.com/privacidade';

  it('cabe numa mensagem com botões e informa o essencial (LGPD arts. 9º e 11)', () => {
    const { body } = currentConsentText(url);
    expect(chars(body)).toBeLessThanOrEqual(1024);
    expect(body).toContain(CLINIC.legalName); // quem é o responsável
    expect(body).toContain(url);
    expect(body).toMatch(/consentimento específico/);
    expect(body).toMatch(/apagar seus dados/);
  });

  it('qualquer mudança no texto gera versão nova', () => {
    const a = currentConsentText(url);
    const b = currentConsentText('https://exemplo.com/outra-politica');
    expect(a.version.startsWith(`${CONSENT_REVISION}.`)).toBe(true);
    expect(a.version).not.toBe(b.version);
    expect(currentConsentText(url).version).toBe(a.version); // estável
  });
});

describe('conteúdo da clínica', () => {
  it('lista os campos ainda com PREENCHER (o servidor recusa subir em produção)', () => {
    // Enquanto o conteúdo de exemplo estiver no arquivo, estes campos aparecem.
    expect(unfilledContentFields()).toEqual(
      expect.arrayContaining(['name', 'legalName', 'address', 'reception', 'prices']),
    );
  });

  it('textos com botões cabem no limite de 1024 caracteres', () => {
    for (const body of [
      TEXTS.welcome(),
      TEXTS.confirmDelete,
      TEXTS.privacy('https://exemplo.com/p', true),
      TEXTS.tooLateToCancel(),
      TEXTS.consentDeclined(),
    ]) {
      expect(chars(body)).toBeLessThanOrEqual(1024);
    }
  });

  it('menu: no máximo 10 itens e títulos de até 24 caracteres', () => {
    const rows = MENU_SECTIONS.flatMap((s) => s.rows);
    expect(rows.length).toBeLessThanOrEqual(10);
    for (const row of rows) expect(chars(row.title), row.title).toBeLessThanOrEqual(24);
  });
});

describe('concorrência', () => {
  it('tarefas da mesma chave rodam uma de cada vez, em ordem', async () => {
    const run = createKeyedMutex();
    const log: string[] = [];
    const slow = (label: string, ms: number) =>
      run('cliente-1', async () => {
        log.push(`início ${label}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`fim ${label}`);
      });
    await Promise.all([slow('A', 30), slow('B', 1), run('cliente-2', async () => void log.push('outro'))]);
    expect(log.indexOf('fim A')).toBeLessThan(log.indexOf('início B'));
    expect(log.indexOf('outro')).toBeLessThan(log.indexOf('fim A')); // outra chave não espera
  });

  it('uma tarefa com erro não trava a fila da chave', async () => {
    const run = createKeyedMutex();
    await expect(run('k', async () => Promise.reject(new Error('falhou')))).rejects.toThrow();
    await expect(run('k', async () => 'ok')).resolves.toBe('ok');
  });

  it('limite por janela de tempo', () => {
    let t = 0;
    const limiter = createRateLimiter(2, 60_000, () => t);
    expect([limiter.allow('x'), limiter.allow('x'), limiter.allow('x')]).toEqual([true, true, false]);
    expect(limiter.allow('y')).toBe(true);
    t = 60_000;
    expect(limiter.allow('x')).toBe(true);
  });
});
