import { join } from 'node:path';
import { unlockKmsKey } from './kms.ts';
import type { Profile } from './types.ts';

export function stagingDatabase(environment: string | undefined, value: string | undefined) {
  if (environment !== 'staging') return;
  try {
    const url = new URL(value ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost'].includes(url.hostname) || url.port !== '5411' || url.search || url.hash) throw new Error();
  } catch { throw new Error('STAGING_DATABASE_REQUIRED'); }
}

export async function runtimeKey(environment: string | undefined, profile: Profile, developmentValue: string | undefined, encoding: BufferEncoding) {
  if (environment === 'development') return { bytes: Buffer.from(developmentValue ?? '', encoding), kmsKey: undefined, destroy() { this.bytes.fill(0); } };
  if (environment !== 'staging' || developmentValue) throw new Error('RUNTIME_KEY_CONFIGURATION_DENIED');
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory) throw new Error('SYSTEMD_CREDENTIALS_REQUIRED');
  const kmsKey = await unlockKmsKey(`staging/${profile}`, join(directory, 'authorized-key.json'), join(directory, 'wrapping-key.json'));
  return { bytes: kmsKey.bytes, kmsKey, destroy() { kmsKey.destroy(); } };
}
