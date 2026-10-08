import type { PoolClient, Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import type { envelope } from './crypto.ts';
export type Profile = 'finance' | 'control';
export type Config = { profile: Profile; pool: Pool; baseURL: string; origin: string; authSecret: string; wrappingKey: Buffer; environment: 'development' | 'test' };
export type Sealer = ReturnType<typeof envelope>;
export type DB = Pick<PoolClient, 'query'>;
export class HttpError extends Error { constructor(public status: number, public code: string) { super(code); } }
export function fields(request: FastifyRequest, allowed: string[]): Record<string, unknown> {
  const b = request.body;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !allowed.includes(k))) throw new HttpError(400, 'INVALID_INPUT');
  return b as Record<string, unknown>;
}
export function string(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, 'INVALID_INPUT');
  return value;
}
export function email(value: unknown): string {
  const v = string(value, 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, 'INVALID_INPUT');
  return v;
}
export function password(value: unknown): string {
  const v = string(value, 128); if (v.length < 12) throw new HttpError(400, 'PASSWORD_TOO_SHORT'); return v;
}
export const realm = (profile: Profile) => profile === 'control' ? 'control' : 'identity';
export async function clock(db: DB): Promise<string> { return (await db.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString(); }
export type MailMeta={subjectId?:string;expiresAt?:string;dedupeKey?:string};
export async function outbox(db: DB, schema: 'identity' | 'control' | 'access', seal: Sealer, kind: string, payload: Record<string, unknown>,meta:MailMeta={}) {
  const source=schema==='control'||['invitation','payment_decision','renewal_decision','manual_access_changed'].includes(kind)?'control':'finance';
  // Untargeted DO NOTHING needs no SELECT on the encrypted access outbox.
  await db.query(`INSERT INTO ${schema}.outbox(id,kind,sealed_payload,source_scope,subject_id,expires_at,dedupe_key) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [kind, seal.seal(JSON.stringify(payload)),source,meta.subjectId??null,meta.expiresAt??null,meta.dedupeKey??null]);
}
export async function event(db: DB, schema: 'identity' | 'control', userId: string, action: string) {
  await db.query(`INSERT INTO ${schema}.security_event(id,user_id,action) VALUES(gen_random_uuid(),$1,$2)`, [userId, action]);
}
