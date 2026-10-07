import type { PoolClient } from 'pg';
import type { FastifyRequest } from 'fastify';
import { createAccessRequest, recordVerifiedEmail, claimPayment, emptyAccessStore, requestStatus } from '@finance/access';
import type { AccessRequest, Tariff } from '@finance/access';
import { token, digest } from './crypto.ts';
import { fields, string, email, HttpError, clock, outbox } from './types.ts';
import type { Config, Sealer } from './types.ts';

export const appCookieName = (config: Config) => config.baseURL.startsWith('https:') ? '__Host-pfa_application' : 'pfa_application';
export function appCookie(config: Config, value: string) {
  return `${appCookieName(config)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=259200${config.baseURL.startsWith('https:') ? '; Secure' : ''}`;
}
function one(r: AccessRequest) { return { ...emptyAccessStore(), requests: [r] }; }
export async function createApplication(db: PoolClient, request: FastifyRequest, seal: Sealer) {
  const input = fields(request, ['name', 'email', 'tariffId']), address = email(input.email), name = string(input.name, 100).trim(), tariffId = string(input.tariffId, 100);
  const now = await clock(db);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['access-email:'+address]);
  const tariff = (await db.query('SELECT snapshot FROM access.tariff WHERE id=$1', [tariffId])).rows[0]?.snapshot as Tariff | undefined;
  if (!tariff) throw new HttpError(400, 'TARIFF_UNAVAILABLE');
  // An existing account receives its own route via email; the public response does not disclose it.
  const user = (await db.query('SELECT id FROM identity.auth_user WHERE email=$1', [address])).rows[0];
  if (user) { await outbox(db, 'access', seal, 'existing_account', { email: address }); return { status: 'accepted' }; }
  if((await db.query("SELECT 1 FROM commerce.manual_grant WHERE email=$1 AND state='pending'",[address])).rowCount){await outbox(db,'access',seal,'existing_invitation',{email:address});return {status:'accepted'};}
  const previous = (await db.query('SELECT data FROM access.request WHERE email=$1 ORDER BY created_at DESC FOR UPDATE', [address])).rows.map(x => x.data as AccessRequest);
  let row = previous.find(r => !['expired', 'rejected'].includes(requestStatus(r, now)));
  if (!row) {
    row = createAccessRequest(emptyAccessStore(), { id: crypto.randomUUID(), name, email: address, tariff }, now).requests[0]!;
    await db.query('INSERT INTO access.request(id,email,data) VALUES($1,$2,$3)', [row.id, address, row]);
  }
  const secret = token();
  await db.query(`INSERT INTO access.email_token(verifier,request_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '30 minutes')`, [digest(secret), row.id]);
  await outbox(db, 'access', seal, 'application_verification', { email: address, token: secret });
  return { status: 'accepted' };
}
export async function verifyApplication(db: PoolClient, request: FastifyRequest) {
  const input = fields(request, ['token']), secret = string(input.token, 100);
  const entry = (await db.query(`SELECT t.request_id,r.data FROM access.email_token t JOIN access.request r ON r.id=t.request_id
    WHERE verifier=$1 AND consumed_at IS NULL AND t.expires_at>clock_timestamp() FOR UPDATE OF t,r`, [digest(secret)])).rows[0];
  if (!entry) throw new HttpError(400, 'INVALID_TOKEN');
  const now = await clock(db); let row = entry.data as AccessRequest;
  if (['expired', 'rejected'].includes(requestStatus(row, now))) throw new HttpError(400, 'INVALID_TOKEN');
  if (!row.verifiedAt) {
    row = recordVerifiedEmail(one(row), row.id, now).requests[0]!;
    await db.query('UPDATE access.request SET data=$1 WHERE id=$2', [row, row.id]);
  }
  await db.query('UPDATE access.email_token SET consumed_at=clock_timestamp() WHERE request_id=$1', [row.id]);
  const session = token();
  await db.query(`INSERT INTO access.application_session(verifier,request_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '72 hours')`, [digest(session), row.id]);
  return { row, session };
}
export async function ownedApplication(db: PoolClient, config: Config, request: FastifyRequest) {
  const cookie = (request.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(appCookieName(config) + '='));
  if (!cookie) throw new HttpError(401, 'APPLICATION_SESSION_REQUIRED');
  const session = cookie.slice(cookie.indexOf('=') + 1);
  const entry = (await db.query(`SELECT r.data FROM access.application_session s JOIN access.request r ON r.id=s.request_id
    WHERE s.verifier=$1 AND s.expires_at>clock_timestamp() FOR UPDATE OF r`, [digest(session)])).rows[0];
  if (!entry || !entry.data.verifiedAt) throw new HttpError(401, 'APPLICATION_SESSION_REQUIRED');
  return entry.data as AccessRequest;
}
export async function applicationClaim(db: PoolClient, config: Config, request: FastifyRequest) {
  const input = fields(request, ['senderName', 'senderBank']), row = await ownedApplication(db, config, request);
  const changed = claimPayment(one(row), row.id, { name: string(input.senderName, 100), bank: string(input.senderBank, 100) }, await clock(db)).requests[0]!;
  await db.query('UPDATE access.request SET data=$1 WHERE id=$2', [changed, row.id]);
  return publicRequest(changed);
}

/** Public application projection does not expose internal admin reasons/notes. */
export function publicRequest(row:AccessRequest):AccessRequest {return {...row,decisionNote:row.status==='rejected'?'Заявка отклонена. Обратитесь к владельцу проекта для уточнения.':''};}
