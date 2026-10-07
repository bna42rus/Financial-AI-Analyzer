import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const hashPassword = (password: string) => hash(password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = async (password: string, encoded: string) => { try { return await verify(encoded, password); } catch { return false; } };

/** Development KEK adapter. Production must supply an audited KMS implementation. */
export function envelope(key: Buffer) {
  if (key.length !== 32) throw new Error('A 32-byte wrapping key is required');
  const encrypt = (data: Buffer, k: Buffer, aad: string) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', k, iv);
    cipher.setAAD(Buffer.from(aad));
    return Buffer.concat([iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  };
  const decrypt = (value: string, k: Buffer, aad: string) => {
    const data = Buffer.from(value, 'base64url'), cipher = createDecipheriv('aes-256-gcm', k, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]);
  };
  return {
    seal(value: string) {
      const dek = randomBytes(32);
      return JSON.stringify({ v: 1, key: encrypt(dek, key, 'finance/dek/v1'), data: encrypt(Buffer.from(value), dek, 'finance/payload/v1') });
    },
    open(value: string) {
      const parsed = JSON.parse(value) as { v: number; key: string; data: string };
      if (parsed.v !== 1) throw new Error('Unsupported sealed payload');
      return decrypt(parsed.data, decrypt(parsed.key, key, 'finance/dek/v1'), 'finance/payload/v1').toString('utf8');
    },
    rateKey(value: string) { return createHmac('sha256', key).update('rate/v1/' + value).digest('hex'); },
  };
}
