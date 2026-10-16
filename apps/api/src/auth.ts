import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/node-postgres';
import { fromNodeHeaders } from 'better-auth/node';
import { authSchema } from '@finance/database';
import type { PoolClient } from 'pg';
import type { FastifyRequest } from 'fastify';
import { hashPassword, verifyPassword } from './crypto.ts';
import {describeDevice} from './mail-templates.ts';
import { realm, HttpError, event, outbox } from './types.ts';
import type { Config, Sealer } from './types.ts';

export function makeAuth(config: Config, db: PoolClient, seal: Sealer) {
  const schema = realm(config.profile);
  return betterAuth({
    appName: 'Financial AI Analyzer', baseURL: config.baseURL, basePath: '/auth', secret: config.authSecret,
    database: drizzleAdapter(drizzle(db), { provider: 'pg', schema: authSchema(schema, seal.seal, seal.open), transaction: false }),
    trustedOrigins: [config.origin], logger: { disabled: true },
    emailAndPassword: { enabled: true, disableSignUp: true, requireEmailVerification: true, autoSignIn: false,
      minPasswordLength: 12, maxPasswordLength: 128, revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: ({ password, hash }) => verifyPassword(password, hash) } },
    session: { expiresIn: config.profile === 'control' ? 3600 : 86400 * 7, disableSessionRefresh: true, freshAge: 300, cookieCache: { enabled: false } },
    advanced: {
      useSecureCookies: config.baseURL.startsWith('https:'), cookiePrefix: 'pfa_' + config.profile,
      crossSubDomainCookies: { enabled: false }, defaultCookieAttributes: { httpOnly: true, sameSite: 'strict', path: '/' },
      disableCSRFCheck: false, disableOriginCheck: false,
    },
    rateLimit: { enabled: false }, // Durable IP/account limits outside request transaction; see server.ts.
    plugins: config.profile === 'control' ? [twoFactor({ issuer: 'Financial AI Analyzer Admin', skipVerificationOnEnable: false,
      backupCodeOptions: { amount: 1, length: 32 }, accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 300 } })] : [],
  });
}
export type Auth = ReturnType<typeof makeAuth>;
export async function current(auth: Auth, request: FastifyRequest) {
  return auth.api.getSession({ headers: fromNodeHeaders(request.headers), query: { disableCookieCache: true } });
}
export async function requireAdmin(auth: Auth, db: PoolClient, request: FastifyRequest, levels: string[] = ['admin']) {
  const s = await current(auth, request); if (!s || !s.user.emailVerified) throw new HttpError(401, 'AUTH_REQUIRED');
  const result = await db.query(`SELECT p.level,p.verified_at,st.status,st.bootstrap_pending
    FROM control.session_proof p JOIN control.security_state st ON st.user_id=p.user_id
    JOIN control.auth_user u ON u.id=st.user_id
    WHERE p.session_id=$1 AND p.user_id=$2 AND p.epoch=st.epoch
      AND (p.level!='admin' OR u.two_factor_enabled=true)`, [s.session.id, s.user.id]);
  const proof = result.rows[0];
  if (!proof || proof.status !== 'active' || !levels.includes(proof.level)) throw new HttpError(403, 'TOTP_REQUIRED');
  return { ...s, proof };
}

/** Apply capability proof only after the native endpoint has completed successfully. */
export async function recordAuthResult(auth: Auth, db: PoolClient, config: Config, request: FastifyRequest, response: Response, seal: Sealer, enrollment = false) {
  if (!response.ok || config.profile !== 'control') return response;
  const result = await response.clone().json() as Record<string, unknown>;
  const path = request.url.split('?')[0];
  if (path === '/auth/sign-in/email' && result.twoFactorRedirect) return response;
  const nextHeaders = fromNodeHeaders(request.headers);
  const cookies = response.headers.getSetCookie();
  const map = new Map((nextHeaders.get('cookie') ?? '').split(';').filter(Boolean).map(part => { const at = part.indexOf('='); return [part.slice(0, at).trim(), part.slice(at + 1)]; }));
  for (const line of cookies) { const pair = line.split(';')[0]!; const at = pair.indexOf('='); map.set(pair.slice(0, at), pair.slice(at + 1)); }
  // Ignore trusted-device cookies even if a stale/forged one is presented.
  for (const key of map.keys()) if (key.includes('trust_device')) map.delete(key);
  nextHeaders.set('cookie', [...map].map(([k, v]) => `${k}=${v}`).join('; '));
  const session = await auth.api.getSession({ headers: nextHeaders, query: { disableCookieCache: true } });
  if (!session) return response;
  const state = (await db.query('SELECT * FROM control.security_state WHERE user_id=$1 FOR UPDATE', [session.user.id])).rows[0];
  if (!state || state.status !== 'active') throw new HttpError(403, 'AUTH_REQUIRED');
  if (path === '/auth/sign-in/email') {
    // Password-only sessions have no administrative authority, including after a reset/recovery.
    if (state.bootstrap_pending && !('twoFactorEnabled' in session.user && session.user.twoFactorEnabled)) {
      await db.query(`INSERT INTO control.session_proof(session_id,user_id,epoch,level) VALUES($1,$2,$3,'enrollment')`, [session.session.id, session.user.id, state.epoch]);
    }
  } else if (path === '/auth/two-factor/enable') {
    const old = await current(auth, request);
    const oldProof = old && (await db.query('SELECT level FROM control.session_proof WHERE session_id=$1', [old.session.id])).rows[0];
    // The library normally preserves this session; a rotated session inherits only the restricted scope.
    const level = oldProof?.level ?? (state.bootstrap_pending ? 'enrollment' : 'recovery');
    await db.query(`INSERT INTO control.session_proof(session_id,user_id,epoch,level) VALUES($1,$2,$3,$4) ON CONFLICT(session_id) DO NOTHING`, [session.session.id, session.user.id, state.epoch, level]);
    // Native backup-code redemption grants a full session and conflicts with E-04. Never expose those codes.
    delete result.backupCodes;
    return new Response(JSON.stringify(result), { status: response.status, headers: response.headers });
  } else if (path === '/auth/two-factor/verify-totp') {
    const code = String((request.body as Record<string, unknown>).code);
    const used = await db.query(`INSERT INTO control.totp_replay(user_id,verifier,expires_at) VALUES($1,$2,clock_timestamp()+interval '90 seconds')
      ON CONFLICT(user_id,verifier) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE control.totp_replay.expires_at<=clock_timestamp() RETURNING user_id`, [session.user.id, seal.rateKey(code)]);
    if (!used.rowCount) throw new HttpError(409, 'TOTP_ALREADY_USED');
    const verified = (await db.query('SELECT two_factor_enabled FROM control.auth_user WHERE id=$1', [session.user.id])).rows[0];
    if (!verified?.two_factor_enabled) throw new HttpError(403, 'TOTP_REQUIRED');
    await db.query(`INSERT INTO control.session_proof(session_id,user_id,epoch,level,verified_at) VALUES($1,$2,$3,'admin',clock_timestamp())
      ON CONFLICT(session_id) DO UPDATE SET level='admin',epoch=EXCLUDED.epoch,verified_at=clock_timestamp()`, [session.session.id, session.user.id, state.epoch]);
    await db.query('UPDATE control.security_state SET bootstrap_pending=false WHERE user_id=$1', [session.user.id]);
    // Product recovery codes: returned once only after verified enrollment, hashed individually in storage.
    if (enrollment) await db.query('UPDATE control.recovery_code SET consumed_at=coalesce(consumed_at,clock_timestamp()) WHERE user_id=$1', [session.user.id]);
    const existing = await db.query('SELECT 1 FROM control.recovery_code WHERE user_id=$1 AND consumed_at IS NULL', [session.user.id]);
    if (!existing.rowCount) {
      const { token, digest } = await import('./crypto.ts'); const codes = Array.from({ length: 8 }, token);
      for (const c of codes) await db.query('INSERT INTO control.recovery_code(verifier,user_id) VALUES($1,$2)', [digest(c), session.user.id]);
      result.recoveryCodes = codes;
    }
    await event(db, 'control', session.user.id, 'totp_login');
    await outbox(db, 'control', seal, 'security_login', { email: session.user.email, at: new Date().toISOString(), profile: 'control',device:describeDevice(request.headers['user-agent']) },{subjectId:session.user.id});
    return new Response(JSON.stringify(result), { status: response.status, headers: response.headers });
  }
  return response;
}
