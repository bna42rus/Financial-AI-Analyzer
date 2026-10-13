import type { PoolClient } from 'pg';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { digest, envelope, hashPassword, token } from './crypto.ts';
import { isKmsKey } from './kms.ts';
import type { UnlockedKmsKey } from './kms.ts';
import { email, outbox, password, string } from './types.ts';

const identifier = 'cashneuro/staging-first-owner/v1';
const recordId = 'cashneuro-staging-first-owner-v1';
export class OwnerBootstrapError extends Error {
  constructor(code: string) { super(code); }
}
export type OwnerBootstrapConfig = {
  environment: 'staging' | 'test'; wrappingKey: Buffer; kmsKey?: UnlockedKmsKey;
  allowedEmails: string[];
};
type Proof = { purpose: string; nonce: string; email: string; name: string; verifier: string; failures: number };
function recipient(config: OwnerBootstrapConfig, value: string) {
  if (!['staging', 'test'].includes(config.environment) || config.wrappingKey.length !== 32 ||
    config.environment === 'staging' && !isKmsKey(config.kmsKey, 'staging/control', config.wrappingKey) ||
    config.allowedEmails.length < 1 || config.allowedEmails.length > 5) throw new OwnerBootstrapError('OWNER_CONFIGURATION_DENIED');
  const address = email(value);
  if (!config.allowedEmails.some(e => email(e) === address)) throw new OwnerBootstrapError('OWNER_RECIPIENT_DENIED');
  return address;
}
async function operator(db: PoolClient) {
  const role = (await db.query(`SELECT current_user AS name, r.rolsuper,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='control' AND c.relname='auth_user' AND c.relowner=r.oid) AS owns
    FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  if (!role || ['finance_api', 'control_api', 'mail_finance', 'mail_control'].includes(role.name) ||
    !role.rolsuper && !role.owns) throw new OwnerBootstrapError('OWNER_OPERATOR_REQUIRED');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [identifier]);
  if ((await db.query('SELECT 1 FROM control.auth_user LIMIT 1')).rowCount) throw new OwnerBootstrapError('OWNER_ALREADY_EXISTS');
}
async function transaction<T>(db: PoolClient, action: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try { const result = await action(); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
}
function proof(value: unknown): Proof {
  try {
    const p = JSON.parse(String(value)) as Proof;
    if (p.purpose !== identifier || !/^[0-9a-f-]{36}$/.test(p.nonce) || email(p.email) !== p.email ||
      !p.name.trim() || p.name.length > 100 || !/^[0-9a-f]{64}$/.test(p.verifier) ||
      !Number.isInteger(p.failures) || p.failures < 0 || p.failures > 5) throw new Error();
    return p;
  } catch { throw new OwnerBootstrapError('OWNER_PROOF_INVALID'); }
}
const verifier = (nonce: string, address: string, code: string) => digest(identifier + ':' + nonce + ':' + address + ':' + code);

/** Privileged local operator only; never imported by the HTTP API. */
export async function beginOwnerBootstrap(db: PoolClient, config: OwnerBootstrapConfig, input: { email: string; name: string }) {
  const address = recipient(config, input.email), name = string(input.name, 100).trim();
  if (!name) throw new OwnerBootstrapError('OWNER_CONFIGURATION_DENIED');
  return transaction(db, async () => {
    await operator(db);
    const previous = (await db.query(`SELECT value,expires_at,clock_timestamp() AS now FROM control.auth_verification
      WHERE id=$1 AND identifier=$2 FOR UPDATE`, [recordId, identifier])).rows[0];
    if (previous) {
      const old = proof(previous.value);
      if (previous.expires_at > previous.now && old.failures < 5) throw new OwnerBootstrapError('OWNER_CHALLENGE_ACTIVE');
      await db.query(`UPDATE control.outbox SET state='failed',last_error='STALE',lease_id=NULL,lease_until=NULL
        WHERE kind='owner_email_verification' AND subject_id=$1 AND state='queued'`, [old.nonce]);
    }
    const nonce = randomUUID(), code = token();
    const value: Proof = { purpose: identifier, nonce, email: address, name, verifier: verifier(nonce, address, code), failures: 0 };
    const row = (await db.query(`INSERT INTO control.auth_verification(id,identifier,value,expires_at,created_at,updated_at)
      VALUES($1,$2,$3,clock_timestamp()+interval '15 minutes',clock_timestamp(),clock_timestamp())
      ON CONFLICT(id) DO UPDATE SET identifier=EXCLUDED.identifier,value=EXCLUDED.value,
        expires_at=EXCLUDED.expires_at,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at
      RETURNING expires_at`, [recordId, identifier, JSON.stringify(value)])).rows[0];
    await outbox(db, 'control', envelope(config.wrappingKey), 'owner_email_verification',
      { email: address, code, profile: 'control' },
      { subjectId: nonce, expiresAt: row.expires_at.toISOString(), dedupeKey: 'staging-first-owner:' + nonce });
    return { status: 'email_queued' as const };
  });
}

/** Only the supplied owner may choose the password; email proof grants no session or admin capability. */
export async function completeOwnerBootstrap(db: PoolClient, config: OwnerBootstrapConfig, input: { email: string; code: string; password: string }) {
  const address = recipient(config, input.email), chosen = password(input.password);
  const result = await transaction(db, async () => {
    await operator(db);
    const row = (await db.query(`SELECT value,expires_at,clock_timestamp() AS now FROM control.auth_verification
      WHERE id=$1 AND identifier=$2 FOR UPDATE`, [recordId, identifier])).rows[0];
    if (!row) throw new OwnerBootstrapError('OWNER_PROOF_INVALID');
    const p = proof(row.value);
    if (row.expires_at <= row.now || p.failures >= 5) throw new OwnerBootstrapError('OWNER_PROOF_INVALID');
    const valid = typeof input.code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.code) && p.email === address &&
      timingSafeEqual(Buffer.from(p.verifier, 'hex'), Buffer.from(verifier(p.nonce, address, input.code), 'hex'));
    if (!valid) {
      p.failures++;
      await db.query('UPDATE control.auth_verification SET value=$2,updated_at=clock_timestamp() WHERE id=$1', [recordId, JSON.stringify(p)]);
      return false;
    }
    const id = randomUUID();
    await db.query(`INSERT INTO control.auth_user(id,name,email,email_verified,created_at,updated_at)
      VALUES($1,$2,$3,true,clock_timestamp(),clock_timestamp())`, [id, p.name, address]);
    await db.query(`INSERT INTO control.auth_account(id,account_id,provider_id,user_id,password,created_at,updated_at)
      VALUES($1,$2,'credential',$2,$3,clock_timestamp(),clock_timestamp())`, [randomUUID(), id, await hashPassword(chosen)]);
    await db.query('INSERT INTO control.security_state(user_id,bootstrap_pending) VALUES($1,true)', [id]);
    await db.query(`INSERT INTO control.security_event(id,user_id,action) VALUES(gen_random_uuid(),$1,'owner_bootstrap_verified')`, [id]);
    await db.query('DELETE FROM control.auth_verification WHERE id=$1 AND identifier=$2', [recordId, identifier]);
    return true;
  });
  // Wrong attempts must remain committed, rather than being erased by error rollback.
  if (!result) throw new OwnerBootstrapError('OWNER_PROOF_INVALID');
  return { status: 'totp_enrollment_required' as const };
}
