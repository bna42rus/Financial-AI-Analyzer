import {validNewPassword} from '../../../packages/access/src/password.ts';
import type { PoolClient, Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import type { envelope } from './crypto.ts';
export type Profile = 'finance' | 'control';
export type Config = { profile: Profile; pool: Pool; baseURL: string; origin: string; authSecret: string; wrappingKey: Buffer; environment: 'development' | 'test' | 'staging'; kmsKey?: import('./kms.ts').UnlockedKmsKey; analyzerAdapter?: import('../../../packages/analyzer/src/registry.ts').AnalyzerAdapter; yandexAnalyzer?: import('./yandex-runtime.ts').YandexAnalyzer; taskProvider?: import('./analyzer-task-provider.ts').CloudTaskProvider; classificationEnabled?: boolean; launchLegal?:boolean; accessPayments?:import('./access-payment-provider.ts').AccessPaymentProvider; testPayments?: import('./yookassa-topups.ts').TestPayments; assistantProvider?: import('./analyzer-assistant-provider.ts').AssistantProvider };
export type Sealer = ReturnType<typeof envelope>;
export type DB = Pick<PoolClient, 'query'>;
export class HttpError extends Error { constructor(public status: number, public code: string) { super(code); } }
export class LinkEditError extends HttpError { constructor(status:number,code:string,public linkIndex:number){super(status,code);} }
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
  if (!validNewPassword(value)) throw new HttpError(400, 'PASSWORD_POLICY'); return value;
}
export const realm = (profile: Profile) => profile === 'control' ? 'control' : 'identity';
export async function clock(db: DB): Promise<string> { return (await db.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString(); }
export type MailMeta={subjectId?:string;expiresAt?:string;dedupeKey?:string};
export async function outbox(db: DB, schema: 'identity' | 'control' | 'access', seal: Sealer, kind: string, payload: Record<string, unknown>,meta:MailMeta={}) {
  const source=schema==='control'||['invitation','payment_decision','renewal_decision','manual_access_changed','account_deletion_completed'].includes(kind)?'control':'finance';
  const id=crypto.randomUUID();
  // Untargeted DO NOTHING needs no SELECT on the encrypted access outbox.
  await db.query(`INSERT INTO ${schema}.outbox(id,kind,sealed_payload,source_scope,subject_id,expires_at,dedupe_key,recipient) VALUES($7,$1,$2,$3,$4,$5,$6,$8) ON CONFLICT DO NOTHING`, [kind, seal.seal(JSON.stringify(payload)),source,meta.subjectId??null,meta.expiresAt??null,meta.dedupeKey??null,id,['payment_claim','renewal_claim','account_deletion_completed'].includes(kind)?null:typeof payload.email==='string'?payload.email:null]);
  return id;
}
export async function event(db: DB, schema: 'identity' | 'control', userId: string, action: string) {
  await db.query(`INSERT INTO ${schema}.security_event(id,user_id,action) VALUES(gen_random_uuid(),$1,$2)`, [userId, action]);
}
