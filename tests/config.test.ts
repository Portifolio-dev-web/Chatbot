import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resolveEnvironment } from '../src/config/env.js';

// Valores fictícios só para teste (nenhum é credencial real).
const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  WHATSAPP_VERIFY_TOKEN: 'v'.repeat(32),
  WHATSAPP_APP_SECRET: 'a'.repeat(32),
  WHATSAPP_ACCESS_TOKEN: 't'.repeat(40),
  WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BLIND_INDEX_KEY: Buffer.alloc(32, 2).toString('base64'),
  CLINIC_PROFILE: 'fisio-personal',
};

function configError(source: NodeJS.ProcessEnv): string {
  try {
    loadConfig(source);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('era esperado ConfigError');
}

describe('resolveEnvironment (fail-closed)', () => {
  it.each([undefined, '', 'prod', 'producao', 'dev', 'staging'])(
    'trata %j como produção',
    (raw) => expect(resolveEnvironment(raw)).toBe('production'),
  );

  it('só development e test desligam as travas', () => {
    expect(resolveEnvironment('development')).toBe('development');
    expect(resolveEnvironment('test')).toBe('test');
  });
});

describe('loadConfig', () => {
  it('aceita a configuração mínima de desenvolvimento e aplica os padrões', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(cfg.isProduction).toBe(false);
    expect(cfg.port).toBe(3000);
    expect(cfg.whatsapp.apiVersion).toBe('v25.0');
    expect(cfg.clinic.timezone).toBe('America/Sao_Paulo');
    expect(cfg.warnings).toEqual([]);
  });

  it('sem NODE_ENV aplica as regras de produção e avisa', () => {
    const msg = configError({ ...base });
    expect(msg).toContain('ambiente: production');
    expect(msg).toContain('DATABASE_URL');
    expect(msg).toContain('PRIVACY_POLICY_URL');
  });

  it('produção exige TLS no banco, salvo dispensa explícita', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      PRIVACY_POLICY_URL: 'https://exemplo.com/p',
      RECEPTION_WHATSAPP: '5511900000000',
    };
    expect(configError(prod)).toContain('sslmode=require');

    const comTls = loadConfig({ ...prod, DATABASE_URL: `${base.DATABASE_URL}?sslmode=require` });
    expect(comTls.isProduction).toBe(true);

    const dispensa = loadConfig({ ...prod, DATABASE_TLS_DISABLED: 'true' });
    expect(dispensa.isProduction).toBe(true);
  });

  it('produção exige política de privacidade em https', () => {
    const prod = { ...base, NODE_ENV: 'production', DATABASE_TLS_DISABLED: 'true' };
    expect(configError(prod)).toContain('PRIVACY_POLICY_URL');
    expect(configError({ ...prod, PRIVACY_POLICY_URL: 'http://exemplo.com/p' })).toContain(
      'PRIVACY_POLICY_URL',
    );
  });

  it('sem NODE_ENV mas com tudo certo, sobe como produção e registra o aviso', () => {
    const cfg = loadConfig({
      ...base,
      DATABASE_TLS_DISABLED: 'true',
      PRIVACY_POLICY_URL: 'https://exemplo.com/p',
      RECEPTION_WHATSAPP: '5511900000000',
    });
    expect(cfg.isProduction).toBe(true);
    expect(cfg.warnings).toHaveLength(1);
  });

  it('WhatsApp da recepção: obrigatório em produção, opcional fora, e só com dígitos', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      DATABASE_TLS_DISABLED: 'true',
      PRIVACY_POLICY_URL: 'https://exemplo.com/p',
    };
    expect(configError(prod)).toContain('RECEPTION_WHATSAPP');
    expect(configError({ ...prod, RECEPTION_WHATSAPP: '1234' })).toContain('RECEPTION_WHATSAPP');
    const cfg = loadConfig({ ...prod, RECEPTION_WHATSAPP: '+55 (11) 90000-0000' });
    expect(cfg.clinic.receptionWhatsapp).toBe('5511900000000');
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).clinic.receptionWhatsapp).toBeUndefined();
  });

  it('variável vazia conta como ausente', () => {
    const msg = configError({ ...base, NODE_ENV: 'development', WHATSAPP_APP_SECRET: '   ' });
    expect(msg).toContain('WHATSAPP_APP_SECRET');
  });

  it('exige token de verificação longo', () => {
    const msg = configError({ ...base, NODE_ENV: 'development', WHATSAPP_VERIFY_TOKEN: 'curto' });
    expect(msg).toContain('WHATSAPP_VERIFY_TOKEN');
  });

  it('chaves de criptografia: 32 bytes em base64, e diferentes entre si', () => {
    const dev = { ...base, NODE_ENV: 'development' };
    expect(configError({ ...dev, ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toContain(
      'ENCRYPTION_KEY',
    );
    expect(configError({ ...dev, BLIND_INDEX_KEY: 'não é base64!' })).toContain('BLIND_INDEX_KEY');
    expect(configError({ ...dev, BLIND_INDEX_KEY: base.ENCRYPTION_KEY })).toContain(
      'diferente da ENCRYPTION_KEY',
    );

    const antigas = [Buffer.alloc(32, 3), Buffer.alloc(32, 4)].map((k) => k.toString('base64'));
    const cfg = loadConfig({ ...dev, ENCRYPTION_KEYS_PREVIOUS: antigas.join(', ') });
    expect(cfg.crypto.previousEncryptionKeys).toHaveLength(2);
    expect(cfg.crypto.encryptionKey).toHaveLength(32);
  });

  it('perfil obrigatório em todos os ambientes, e só os do catálogo', () => {
    const dev = { ...base, NODE_ENV: 'development' };
    const { CLINIC_PROFILE: _omit, ...withoutProfile } = dev;
    expect(configError(withoutProfile)).toMatch(/CLINIC_PROFILE: obrigatório; use um destes perfis: .*fisioterapia/);
    const msg = configError({ ...dev, CLINIC_PROFILE: 'perfil-inventado' });
    expect(msg).toContain('CLINIC_PROFILE');
    expect(msg).not.toContain('perfil-inventado');

    const cfg = loadConfig({ ...dev, CLINIC_PROFILE: 'personal' });
    expect(cfg.profileId).toBe('personal');
    expect(cfg.profile.services.map((s) => s.code)).toEqual(['PERSONAL_TRAINING']);
  });

  it('a mensagem de erro nunca ecoa o valor recebido', () => {
    const segredo = 'segredo-que-nao-pode-vazar';
    const msg = configError({
      ...base,
      NODE_ENV: 'development',
      WHATSAPP_PHONE_NUMBER_ID: segredo,
      DATABASE_URL: segredo,
    });
    expect(msg).not.toContain(segredo);
  });
});
