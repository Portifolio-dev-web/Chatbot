import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  createFieldCipher,
  createPhoneIndexer,
  normalizePhone,
} from '../src/lib/crypto.js';

const NOME = 'Maria da Silva';
const TELEFONE = '5511987654321';

describe('criptografia de campos', () => {
  const key = randomBytes(32);
  const cipher = createFieldCipher(key);

  it('ida e volta preserva o texto, inclusive acentos', () => {
    const payload = cipher.encrypt('client.name', 'João Conceição');
    expect(cipher.decrypt('client.name', payload)).toBe('João Conceição');
  });

  it('o valor gravado não contém o texto nem pedaços dele', () => {
    const payload = cipher.encrypt('client.phone', TELEFONE);
    expect(payload).not.toContain(TELEFONE);
    expect(payload).not.toContain(TELEFONE.slice(-8));
    expect(payload.startsWith('v1.')).toBe(true);
  });

  it('o mesmo texto cifrado duas vezes dá resultados diferentes (IV aleatório)', () => {
    expect(cipher.encrypt('client.name', NOME)).not.toBe(cipher.encrypt('client.name', NOME));
  });

  it('conteúdo adulterado é recusado', () => {
    const payload = cipher.encrypt('client.name', NOME);
    const parts = payload.split('.');
    const body = Buffer.from(parts[3]!, 'base64url');
    body[0] = body[0]! ^ 0xff;
    parts[3] = body.toString('base64url');
    expect(() => cipher.decrypt('client.name', parts.join('.'))).toThrow(DecryptionError);
  });

  it('valor de um campo não pode ser lido como outro (telefone colado no nome)', () => {
    const phone = cipher.encrypt('client.phone', TELEFONE);
    expect(() => cipher.decrypt('client.name', phone)).toThrow(DecryptionError);
  });

  it('formato estranho é recusado sem expor o conteúdo na mensagem', () => {
    const lixo = `v1.abc.${NOME}`;
    try {
      cipher.decrypt('client.name', lixo);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptionError);
      expect((err as Error).message).not.toContain(NOME);
    }
  });

  it('rotação: chave antiga continua lendo, e o valor é marcado para regravação', () => {
    const antiga = createFieldCipher(key);
    const payload = antiga.encrypt('client.name', NOME);

    const nova = createFieldCipher(randomBytes(32), [key]);
    expect(nova.decrypt('client.name', payload)).toBe(NOME);
    expect(nova.needsReencrypt(payload)).toBe(true);
    expect(nova.needsReencrypt(nova.encrypt('client.name', NOME))).toBe(false);

    const semAntiga = createFieldCipher(randomBytes(32));
    expect(() => semAntiga.decrypt('client.name', payload)).toThrow(/chave desconhecida/);
  });
});

describe('índice cego do telefone', () => {
  const index = createPhoneIndexer(randomBytes(32));

  it('é determinístico e ignora a formatação', () => {
    expect(index('+55 (11) 98765-4321')).toBe(index(TELEFONE));
  });

  it('não contém o telefone e muda com a chave', () => {
    const hash = index(TELEFONE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(TELEFONE.slice(-8));
    expect(createPhoneIndexer(randomBytes(32))(TELEFONE)).not.toBe(hash);
  });

  it('recusa números impossíveis', () => {
    expect(() => normalizePhone('1234')).toThrow(RangeError);
    expect(() => normalizePhone('1'.repeat(16))).toThrow(RangeError);
  });
});
