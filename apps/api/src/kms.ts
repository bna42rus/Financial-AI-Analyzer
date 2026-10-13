import { constants, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export type KmsRealm = `${'staging' | 'production'}/${'finance' | 'control'}`;
export const kmsRealms: Record<KmsRealm, { keyId: string; accountId: string }> = {
  'production/finance': { keyId: 'abjo6m4lpi6npmg4jvmt', accountId: 'aje88cdn0ksnt6egi44d' },
  'production/control': { keyId: 'abjbnp9ofpccphho9k9c', accountId: 'aje7d9fa36uut18hl7li' },
  'staging/finance': { keyId: 'abjfcob2h16qkbulqnpe', accountId: 'ajej7kobt6o99jq35uhb' },
  'staging/control': { keyId: 'abj440rgdvttcfrcfm97', accountId: 'aje0e5uqf7mko47hq4no' },
};
const IAM = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';
const KMS = 'https://kms.yandex/kms/v1/keys/';
export class KmsUnavailable extends Error { constructor() { super('KMS_UNAVAILABLE'); } }

/** Secrets must be private regular files; systemd credentials are supported. */
export async function privateJson(path: string): Promise<Record<string, unknown>> {
  if (!isAbsolute(path)) throw new Error('PRIVATE_FILE_REQUIRED');
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) ||
      ![0, process.getuid?.()].includes(stat.uid)) throw new Error('PRIVATE_FILE_REQUIRED');
    const value: unknown = JSON.parse(await file.readFile('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PRIVATE_FILE_REQUIRED');
    return value as Record<string, unknown>;
  } catch { throw new Error('PRIVATE_FILE_REQUIRED'); } finally { await file.close(); }
}

function encoded(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 16384) throw new KmsUnavailable();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value) throw new KmsUnavailable();
  return bytes;
}

export function kmsClient(realm: KmsRealm, auth: Record<string, unknown>, request: typeof fetch = fetch) {
  const expected = kmsRealms[realm];
  if (!expected || auth.service_account_id !== expected.accountId ||
    typeof auth.id !== 'string' || typeof auth.private_key !== 'string') throw new Error('KMS_IDENTITY_DENIED');
  const pem = auth.private_key.slice(auth.private_key.indexOf('-----BEGIN'));
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('KMS_IDENTITY_DENIED');
  let token = '', expiry = 0, pending: Promise<string> | undefined;
  async function post(url: string, body: unknown, bearer?: string) {
    try {
      const response = await request(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) }, body: JSON.stringify(body) });
      if (!response.ok) { await response.body?.cancel(); throw new KmsUnavailable(); }
      // Bound the response before parsing; provider errors/payloads never reach logs.
      const reader = response.body?.getReader(); if (!reader) throw new KmsUnavailable();
      let text = '', size = 0; const decoder = new TextDecoder();
      try { for (;;) { const part = await reader.read(); if (part.done) break;
        size += part.value.length; if (size > 65536) throw new KmsUnavailable(); text += decoder.decode(part.value, { stream: true });
      } text += decoder.decode(); } finally { await reader.cancel(); }
      const result: unknown = JSON.parse(text);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new KmsUnavailable();
      return result as Record<string, unknown>;
    } catch { throw new KmsUnavailable(); }
  }
  async function refresh() {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'PS256', typ: 'JWT', kid: auth.id })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: expected.accountId, aud: IAM, iat: now, exp: now + 600 })).toString('base64url');
    const content = header + '.' + payload;
    const signature = sign('sha256', Buffer.from(content), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url');
    const result = await post(IAM, { jwt: content + '.' + signature });
    if (typeof result.iamToken !== 'string' || result.iamToken.length < 10 || result.iamToken.length > 16384 ||
      typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now() + 60000) throw new KmsUnavailable();
    token = result.iamToken; expiry = Math.min(Date.parse(result.expiresAt) - 60000, Date.now() + 300000);
    return token;
  }
  async function iamToken() {
    if (token && Date.now() < expiry) return token;
    if (!pending) pending = refresh().finally(() => { pending = undefined; });
    return pending;
  }
  const aad = Buffer.from('cashneuro/runtime-wrapping/v1/' + realm).toString('base64');
  return {
    async wrap(plaintext: Buffer) {
      if (plaintext.length !== 32) throw new KmsUnavailable();
      const result = await post(KMS + expected.keyId + ':encrypt', { plaintext: plaintext.toString('base64'), aadContext: aad }, await iamToken());
      if (result.keyId !== expected.keyId || typeof result.versionId !== 'string' || !result.versionId) throw new KmsUnavailable();
      encoded(result.ciphertext);
      return { v: 1, realm, keyId: expected.keyId, versionId: result.versionId, ciphertext: result.ciphertext };
    },
    async unwrap(record: Record<string, unknown>) {
      if (record.v !== 1 || record.realm !== realm || record.keyId !== expected.keyId ||
        typeof record.versionId !== 'string' || !record.versionId) throw new KmsUnavailable();
      encoded(record.ciphertext);
      const result = await post(KMS + expected.keyId + ':decrypt', { ciphertext: record.ciphertext, aadContext: aad }, await iamToken());
      if (result.keyId !== expected.keyId || result.versionId !== record.versionId) throw new KmsUnavailable();
      const bytes = encoded(result.plaintext);
      if (bytes.length !== 32) { bytes.fill(0); throw new KmsUnavailable(); }
      return bytes;
    },
  };
}

export type UnlockedKmsKey = { realm: KmsRealm; bytes: Buffer; destroy(): void };
const unlocked = new WeakSet<UnlockedKmsKey>();
export function isKmsKey(key: UnlockedKmsKey | undefined, realm: string, bytes: Buffer) {
  return !!key && unlocked.has(key) && key.realm === realm && key.bytes === bytes && bytes.length === 32;
}
export async function unlockKmsKey(realm: KmsRealm, authPath: string, wrappedPath: string): Promise<UnlockedKmsKey> {
  const client = kmsClient(realm, await privateJson(authPath));
  const bytes = await client.unwrap(await privateJson(wrappedPath));
  const result = { realm, bytes, destroy() { unlocked.delete(result); bytes.fill(0); } };
  unlocked.add(result); return result;
}

/** Explicit initialization only; runtime never invents a key if a file is missing. */
export async function initializeKmsKey(realm: KmsRealm, authPath: string, outputPath: string) {
  if (!isAbsolute(outputPath)) throw new Error('PRIVATE_FILE_REQUIRED');
  const client = kmsClient(realm, await privateJson(authPath)), bytes = randomBytes(32);
  try {
    const record = await client.wrap(bytes), recovered = await client.unwrap(record);
    try { if (!bytes.equals(recovered)) throw new KmsUnavailable(); } finally { recovered.fill(0); }
    const file = await open(outputPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync(); } finally { await file.close(); }
  } finally { bytes.fill(0); }
}
