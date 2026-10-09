import { describe, expect, it } from 'vitest';
import { CLINIC, unfilledContentFields } from '../src/content/clinic.js';
import { CONSENT_REVISION, currentConsentText } from '../src/content/consent.js';
import { createKeyedMutex, createRateLimiter } from '../src/lib/concurrency.js';
import { PROFILE_IDS, PROFILES, validateProfile } from '../src/profiles/index.js';
import { TEXTS, buildMenu, serviceButtons } from '../src/services/chatbot/texts.js';

const chars = (s: string): number => [...s].length;

describe('aviso de consentimento', () => {
  const url = 'https://exemplo.com/privacidade';
  const clinic = PROFILES['fisio-personal'];
  const psi = PROFILES.psicologia;

  it('cabe numa mensagem com botões e informa o essencial (LGPD arts. 9º e 11)', () => {
    for (const { body } of [
      currentConsentText(url, clinic),
      currentConsentText(url, psi, 'self'),
      currentConsentText(url, psi, 'minor'),
    ]) {
      expect(chars(body)).toBeLessThanOrEqual(1024);
      expect(body).toContain(CLINIC.legalName); // quem é o responsável
      expect(body).toContain(url);
      expect(body).toMatch(/consentimento específico/);
      expect(body).toMatch(/apagar (seus|os) dados/);
    }
  });

  it('o do responsável por menor cita a LGPD art. 14 e pede a declaração', () => {
    const { body } = currentConsentText(url, psi, 'minor');
    expect(body).toMatch(/art. 14/);
    expect(body).toMatch(/pai, mãe ou responsável legal/);
    expect(body).toMatch(/avisar a profissional/);
  });

  it('qualquer mudança no texto gera versão nova; paciente e responsável têm versões próprias', () => {
    const a = currentConsentText(url, clinic);
    const b = currentConsentText('https://exemplo.com/outra-politica', clinic);
    expect(a.version.startsWith(`${CONSENT_REVISION}.`)).toBe(true);
    expect(a.version).not.toBe(b.version);
    expect(currentConsentText(url, clinic).version).toBe(a.version); // estável
    expect(currentConsentText(url, psi, 'self').version).not.toBe(
      currentConsentText(url, psi, 'minor').version,
    );
  });
});

describe('conteúdo da clínica', () => {
  it('lista os campos ainda com PREENCHER (o servidor recusa subir em produção)', () => {
    // Enquanto o conteúdo de exemplo estiver no arquivo, estes campos aparecem.
    expect(unfilledContentFields(PROFILES['fisio-personal'])).toEqual(
      expect.arrayContaining(['name', 'legalName', 'address', 'reception', 'prices']),
    );
  });

  it('perfil só online não exige endereço', () => {
    const fields = unfilledContentFields(PROFILES.psicologia);
    expect(fields).not.toContain('address');
    expect(fields).toContain('legalName');
  });

  it('textos com botões cabem no limite de 1024 caracteres', () => {
    for (const body of [
      ...PROFILE_IDS.map((id) => TEXTS.welcome(PROFILES[id])),
      ...PROFILE_IDS.map((id) => TEXTS.whichService(PROFILES[id])),
      ...PROFILE_IDS.map((id) => TEXTS.confirmDelete(PROFILES[id])),
      ...PROFILE_IDS.map((id) => TEXTS.tooLateToCancel(PROFILES[id])),
      ...PROFILE_IDS.map((id) => TEXTS.consentDeclined(PROFILES[id])),
      ...PROFILE_IDS.map((id) => TEXTS.unsupported(PROFILES[id])),
      TEXTS.crisisSupport,
      TEXTS.privacy('https://exemplo.com/p', true),
    ]) {
      expect(chars(body)).toBeLessThanOrEqual(1024);
    }
  });
});

describe.each(PROFILE_IDS)('perfil %s', (id) => {
  const profile = PROFILES[id];

  it('passa na validação (códigos, limites do WhatsApp, palavras-chave, grade)', () => {
    expect(validateProfile(profile)).toEqual([]);
  });

  it('menu: no máximo 10 itens e títulos de até 24 caracteres', () => {
    const rows = buildMenu(profile).flatMap((s) => s.rows);
    expect(rows.length).toBeLessThanOrEqual(10);
    for (const row of rows) expect(chars(row.title), row.title).toBeLessThanOrEqual(24);
    // Um item de agendamento por serviço, numerado a partir de 1.
    expect(rows.slice(0, profile.services.length).map((r) => r.title)).toEqual(
      profile.services.map((s, i) => `${i + 1}. ${s.label}`),
    );
  });

  it('escolha de serviço: no máximo 3 botões', () => {
    expect(serviceButtons(profile).length).toBeLessThanOrEqual(3);
  });
});

describe('perfil fisio-personal: mesmo comportamento de antes dos perfis', () => {
  const profile = PROFILES['fisio-personal'];

  it('menu e boas-vindas idênticos aos originais', () => {
    expect(buildMenu(profile).flatMap((s) => s.rows.map((r) => r.title))).toEqual([
      '1. Fisioterapia',
      '2. Personal trainer',
      '3. Valores e pacotes',
      '4. Endereço',
      '5. Horários',
      '6. Meus agendamentos',
      '7. Falar com a recepção',
      '8. Privacidade e dados',
    ]);
    expect(TEXTS.welcome(profile)).toContain('agendar *fisioterapia* ou *personal trainer* e a tirar dúvidas');
  });

  it('validação pega perfil malformado', () => {
    const broken = {
      ...profile,
      services: [{ ...profile.services[0]!, code: 'fisio', label: 'Um nome comprido demais aqui' }],
    };
    expect(validateProfile(broken).join(' | ')).toMatch(/fora do formato.*20 caracteres/);
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
