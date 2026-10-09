import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { getConfig } from '../config/env.js';

/*
 * PRIVACIDADE (LGPD art. 46; dado de saúde, art. 11): nome e telefone do cliente são
 * criptografados NA APLICAÇÃO antes de ir ao banco (AES-256-GCM). Quem obtiver uma cópia do
 * banco ou de um backup, sem a chave, não descobre quem marcou fisioterapia.
 * A chave fica fora do banco e do backup (variável de ambiente + cofre + cópia offline):
 * perder a chave = perder esses dados.
 *
 * Formato gravado: v1.<id da chave>.<iv>.<cifrado+tag>, em base64url. O id da chave permite
 * trocá-la (rotação) sem reescrever tudo de uma vez: as antigas, em ENCRYPTION_KEYS_PREVIOUS,
 * continuam lendo o que ainda não foi regravado.
 */

/** Lista oficial dos campos criptografados. O schema marca cada um com [CRIPTOGRAFADO]. */
export type EncryptedField =
  | 'client.name'
  | 'client.phone'
  // Nome do(a) paciente menor: no agendamento e, durante o funil, no estado da conversa.
  | 'appointment.patient_name'
  | 'conversation.patient_name';

const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Só identifica qual chave cifrou; o hash de uma chave aleatória de 32 bytes não a revela. */
function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/** Erro de leitura. As mensagens nunca incluem o conteúdo (vão para o log). */
export class DecryptionError extends Error {
  override name = 'DecryptionError';
}

export interface FieldCipher {
  encrypt(field: EncryptedField, plaintext: string): string;
  decrypt(field: EncryptedField, payload: string): string;
  /** true se o valor foi cifrado com uma chave antiga e deve ser regravado (rotação). */
  needsReencrypt(payload: string): boolean;
}

export function createFieldCipher(current: Buffer, previous: readonly Buffer[] = []): FieldCipher {
  const currentId = keyId(current);
  const keys = new Map<string, Buffer>(previous.map((key) => [keyId(key), key]));
  keys.set(currentId, current);

  // AAD amarra o texto cifrado ao campo: copiar o "telefone cifrado" para a coluna do nome
  // faz a leitura falhar, em vez de mostrar um dado trocado.
  const aad = (field: EncryptedField): Buffer => Buffer.from(`${FORMAT_VERSION}|${field}`, 'utf8');

  return {
    encrypt(field, plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', current, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad(field));
      const body = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return [FORMAT_VERSION, currentId, iv.toString('base64url'), body.toString('base64url')].join(
        '.',
      );
    },

    decrypt(field, payload) {
      const parts = payload.split('.');
      const [version, kid, ivPart, bodyPart] = parts;
      if (parts.length !== 4 || version !== FORMAT_VERSION || !kid || !ivPart || !bodyPart) {
        throw new DecryptionError('formato inválido');
      }
      const key = keys.get(kid);
      if (!key) {
        throw new DecryptionError(
          'chave desconhecida (uma chave antiga saiu de ENCRYPTION_KEYS_PREVIOUS antes da rotação terminar?)',
        );
      }
      const iv = Buffer.from(ivPart, 'base64url');
      const body = Buffer.from(bodyPart, 'base64url');
      if (iv.length !== IV_BYTES || body.length < TAG_BYTES) {
        throw new DecryptionError('formato inválido');
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(aad(field));
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
        return Buffer.concat([
          decipher.update(body.subarray(0, body.length - TAG_BYTES)),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new DecryptionError('conteúdo adulterado ou de outro campo');
      }
    },

    needsReencrypt(payload) {
      return payload.split('.')[1] !== currentId;
    },
  };
}

/**
 * Só dígitos, como o WhatsApp entrega no `wa_id` (DDI + DDD + número, ex.: 5511999998888).
 * E.164 permite no máximo 15 dígitos.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) throw new RangeError('telefone inválido');
  return digits;
}

/**
 * Índice cego do telefone: HMAC-SHA256 com chave própria (BLIND_INDEX_KEY, separada da de
 * criptografia). Acha o cliente pelo número do webhook sem guardar o número em claro.
 * Limite conhecido: com a chave em mãos, um telefone pode ser testado por força bruta (são
 * poucos bilhões de combinações), por isso esta chave é tão secreta quanto a outra.
 * O prefixo "tel:" separa o espaço do telefone de qualquer outro índice futuro.
 */
export function createPhoneIndexer(key: Buffer): (phone: string) => string {
  return (phone) => createHmac('sha256', key).update(`tel:${normalizePhone(phone)}`).digest('hex');
}

/**
 * Compara segredos em tempo constante. Com `===`, o tempo de resposta denuncia quantos
 * caracteres iniciais estão certos, e um atacante descobre o token aos poucos.
 * Os dois lados passam por SHA-256 antes, porque timingSafeEqual exige tamanhos iguais.
 */
export function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

let cipher: FieldCipher | undefined;
let indexer: ((phone: string) => string) | undefined;

export function getFieldCipher(): FieldCipher {
  const { crypto } = getConfig();
  cipher ??= createFieldCipher(crypto.encryptionKey, crypto.previousEncryptionKeys);
  return cipher;
}

export function phoneIndex(phone: string): string {
  indexer ??= createPhoneIndexer(getConfig().crypto.blindIndexKey);
  return indexer(phone);
}
