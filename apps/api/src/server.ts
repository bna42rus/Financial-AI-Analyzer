import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PoolClient } from 'pg';
import type { FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { envelope } from './crypto.ts';
import { makeAuth, current, requireAdmin, recordAuthResult } from './auth.ts';
import { resetRequest, resetPassword, recoverAdmin } from './security.ts';
import { realm, HttpError, fields, string, email, event, outbox } from './types.ts';
import type { Config } from './types.ts';

export async function createServer(config: Config) {
  if (!['development', 'test'].includes(config.environment)) throw new Error('Production requires a KMS adapter and separate security acceptance');
  const expectedRole = config.profile === 'control' ? 'control_api' : 'finance_api';
  const role = (await config.pool.query(`SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (role.name !== expectedRole || role.rolsuper || role.rolbypassrls) throw new Error('Runtime database credentials must use the scoped application role');
  if (config.authSecret.length < 32 || config.wrappingKey.length !== 32) throw new Error('Independent runtime secrets are required');
  const seal = envelope(config.wrappingKey), schema = realm(config.profile);
  // Finance repositories are never loaded by the control deployment profile.
  const application = config.profile === 'finance' ? await import('./application.ts') : null;
  class RootModule {} Module({})(RootModule);
  const app = await NestFactory.create<NestFastifyApplication>(RootModule, new FastifyAdapter({ logger: false, trustProxy: false, bodyLimit: 8192 }), { logger: false });
  const fastify = app.getHttpAdapter().getInstance();
  async function rate(request: FastifyRequest) {
    if (request.method !== 'POST') return;
    const route = request.url.split('?')[0]!;
    const address = typeof (request.body as Record<string, unknown> | undefined)?.email === 'string' ? String((request.body as Record<string, unknown>).email).trim().toLowerCase() : '';
    const budgets: [string, number, number][] = [['ip:' + request.ip, 30, 60]];
    if (address) budgets.push(['account:' + route + ':' + address, route.endsWith('reset-request') ? 3 : 5, 300]);
    else budgets.push(['action:' + route + ':' + request.ip, 10, 60]);
    for (const [key, max, seconds] of budgets) {
      const entry = (await config.pool.query(`INSERT INTO ${schema}.rate_limit(key,hits,expires_at) VALUES($1,1,now()+$2*interval '1 second')
        ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN ${schema}.rate_limit.expires_at<=now() THEN 1 ELSE ${schema}.rate_limit.hits+1 END,
        expires_at=CASE WHEN ${schema}.rate_limit.expires_at<=now() THEN EXCLUDED.expires_at ELSE ${schema}.rate_limit.expires_at END RETURNING hits`, [seal.rateKey(key), seconds])).rows[0];
      if (entry.hits > max) throw new HttpError(429, 'RATE_LIMITED');
    }
  }
  fastify.route({ method: ['GET', 'POST', 'OPTIONS'], url: '/*', handler: async (request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-content-type-options', 'nosniff');
    const origin = request.headers.origin;
    if (origin === config.origin) reply.header('access-control-allow-origin', origin).header('access-control-allow-credentials', 'true').header('vary', 'Origin');
    if (request.method === 'OPTIONS') {
      if (origin !== config.origin) return reply.code(403).send({ code: 'ORIGIN_DENIED' });
      return reply.header('access-control-allow-methods', 'GET, POST').header('access-control-allow-headers', 'Content-Type').code(204).send();
    }
    if (request.method === 'POST' && (origin !== config.origin || request.headers['content-type']?.split(';')[0] !== 'application/json')) return reply.code(403).send({ code: 'ORIGIN_DENIED' });
    const path = request.url.split('?')[0]!;
    if (path === '/health' && request.method === 'GET') return { status: 'ok', profile: config.profile };
    let db: PoolClient | undefined;
    try {
      await rate(request);
      db = await config.pool.connect(); await db.query('BEGIN');
      // Serialize authentication mutations across instances. This foundation favors correctness over login throughput.
      await db.query('SELECT pg_advisory_xact_lock($1)', [config.profile === 'control' ? 92041 : 92042]);
      const auth = makeAuth(config, db, seal);
      let result: unknown, cookies: string[] = [], status = 200;
      if (path.startsWith('/auth/')) {
        const allowed = ['/auth/sign-in/email', '/auth/sign-out', ...(config.profile === 'control' ? ['/auth/two-factor/enable', '/auth/two-factor/verify-totp'] : [])];
        if (request.method !== 'POST' || !allowed.includes(path)) throw new HttpError(404, 'NOT_FOUND');
        if (path === '/auth/sign-in/email') {
          const input = fields(request, ['email', 'password']); email(input.email); string(input.password, 128);
        } else if (path === '/auth/two-factor/enable') {
          fields(request, ['password', 'method']);
          if ((request.body as Record<string, unknown>).method && (request.body as Record<string, unknown>).method !== 'totp') throw new HttpError(400, 'TOTP_ONLY');
          await requireAdmin(auth, db, request, ['enrollment', 'recovery']);
        } else if (path === '/auth/two-factor/verify-totp') {
          const input = fields(request, ['code']); if (!/^\d{6}$/.test(string(input.code, 6))) throw new HttpError(400, 'INVALID_INPUT');
          // A password-only session without the bootstrap/recovery proof cannot use enrollment verification as a bypass.
          const session = await current(auth, request);
          if (session) await requireAdmin(auth, db, request, ['enrollment', 'recovery', 'admin']);
        } else fields(request, []);
        const headers = fromNodeHeaders(request.headers);
        headers.set('cookie', (headers.get('cookie') ?? '').split(';').filter(part => !part.includes('trust_device')).join(';'));
        let response = await auth.handler(new Request(new URL(path, config.baseURL), { method: 'POST', headers, body: JSON.stringify(request.body) }));
        response = await recordAuthResult(auth, db, config, request, response, seal);
        status = response.status; cookies = response.headers.getSetCookie();
        result = await response.json();
        if (!response.ok) {
          // Native failed verification writes roll back; durable product rate limits above remain committed.
          await db.query('ROLLBACK'); db.release(); db = undefined;
          return reply.code(status === 429 ? 429 : 401).send({ code: 'INVALID_CREDENTIALS' });
        }
        if (path === '/auth/sign-in/email') {
          if (!(result as Record<string, unknown>).twoFactorRedirect) {
            const newSession = await auth.api.getSession({ headers: new Headers({ ...Object.fromEntries(headers), cookie: cookies.map(c => c.split(';')[0]).join('; ') }), query: { disableCookieCache: true } });
            if (newSession && config.profile === 'finance') {
              await event(db, schema, newSession.user.id, 'password_login');
              await outbox(db, schema, seal, 'security_login', { email: newSession.user.email, at: newSession.session.createdAt, profile: 'finance' });
            }
          }
          // Do not expose native user/session tokens in JSON. Cookies carry the opaque session.
          result = (result as Record<string, unknown>).twoFactorRedirect ? { status: 'totp_required' } : { status: config.profile === 'control' ? 'enrollment_or_recovery_required' : 'authenticated' };
        } else if (path === '/auth/two-factor/verify-totp') {
          result = { status: 'authenticated', ...((result as Record<string, unknown>).recoveryCodes ? { recoveryCodes: (result as Record<string, unknown>).recoveryCodes } : {}) };
        }
      } else if (path === '/security/reset-request' && request.method === 'POST') {
        result = await resetRequest(db, config, request, seal); status = 202;
      } else if (path === '/security/reset' && request.method === 'POST') {
        result = await resetPassword(db, config, request, seal);
      } else if (path === '/control/recovery' && config.profile === 'control' && request.method === 'POST') {
        const recovered = await recoverAdmin(auth, db, config, request, seal); result = recovered.result; cookies = [recovered.cookie];
      } else if (path === '/session' && request.method === 'GET') {
        if (config.profile === 'control') {
          const s = await requireAdmin(auth, db, request, ['enrollment', 'recovery', 'admin']);
          result = { name: s.user.name, scope: s.proof.level, capabilities: s.proof.level === 'admin' ? ['review_requests'] : ['enroll_totp'] };
        } else {
          const s = await current(auth, request); if (!s || !s.user.emailVerified) throw new HttpError(401, 'AUTH_REQUIRED');
          const state = (await db.query('SELECT status,indefinite,access_end FROM identity.security_state WHERE user_id=$1', [s.user.id])).rows[0];
          if (!state) throw new HttpError(403, 'AUTH_REQUIRED');
          const now = (await db.query('SELECT now() AS now')).rows[0].now;
          const active = state.status === 'active' && (state.indefinite || state.access_end && state.access_end > now);
          result = { name: s.user.name, scope: active ? 'active' : 'restricted', capabilities: active ? ['account','security','access','support','privacy','delete_own_data','finance'] : ['account','security','access','support','privacy','delete_own_data'] };
        }
      } else if (path === '/control/requests' && config.profile === 'control' && request.method === 'GET') {
        await requireAdmin(auth, db, request);
        result = { requests: (await db.query('SELECT data FROM access.request ORDER BY created_at DESC LIMIT 100')).rows.map(r => r.data) };
      } else if (path === '/security/sessions' && request.method === 'GET') {
        const s = config.profile === 'control' ? await requireAdmin(auth, db, request) : await current(auth, request);
        if (!s || !s.user.emailVerified) throw new HttpError(401, 'AUTH_REQUIRED');
        result = { sessions: (await db.query(`SELECT id,created_at,expires_at FROM ${schema}.auth_session WHERE user_id=$1 AND expires_at>now()`, [s.user.id])).rows.map(r => ({ id: r.id, createdAt: r.created_at, expiresAt: r.expires_at, current: r.id === s.session.id })) };
      } else if (path === '/security/revoke-session' && request.method === 'POST') {
        const input = fields(request, ['sessionId']), s = config.profile === 'control' ? await requireAdmin(auth, db, request) : await current(auth, request);
        if (!s || !s.user.emailVerified) throw new HttpError(401, 'AUTH_REQUIRED');
        const revoked = await db.query(`DELETE FROM ${schema}.auth_session WHERE id=$1 AND user_id=$2 RETURNING id`, [string(input.sessionId, 100), s.user.id]);
        if (!revoked.rowCount) throw new HttpError(404, 'NOT_FOUND');
        await event(db, schema, s.user.id, 'session_revoked'); result = { status: 'revoked' };
      } else if (application && path === '/access/requests' && request.method === 'POST') {
        result = await application.createApplication(db, request, seal); status = 202;
      } else if (application && path === '/access/verify' && request.method === 'POST') {
        const verified = await application.verifyApplication(db, request); result = { status: 'verified' }; cookies = [application.appCookie(config, verified.session)];
      } else if (application && path === '/access/request' && request.method === 'GET') {
        if (request.url.includes('?')) throw new HttpError(400, 'INVALID_INPUT');
        result = { request: await application.ownedApplication(db, config, request) };
      } else if (application && path === '/access/payment-claim' && request.method === 'POST') {
        result = { request: await application.applicationClaim(db, config, request) };
      } else throw new HttpError(404, 'NOT_FOUND');
      await db.query('COMMIT'); db.release(); db = undefined;
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.code(status).send(result);
    } catch (error) {
      if (db) { await db.query('ROLLBACK'); db.release(); }
      // No raw credentials, identifiers, payloads, SQL errors or reset links in responses/logs.
      return reply.code(error instanceof HttpError ? error.status : 400).send({ code: error instanceof HttpError ? error.code : 'REQUEST_FAILED' });
    }
  } });
  await app.init(); await fastify.ready();
  return { app, fastify, close: () => app.close() };
}
