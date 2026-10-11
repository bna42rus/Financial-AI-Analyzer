import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PoolClient } from 'pg';
import type { FastifyRequest,FastifyReply } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import {accessWarning,describeDevice} from './mail-templates.ts';
import {mailQueue,retryMail,resendInvitation} from './mail-admin.ts';
import { envelope } from './crypto.ts';
import { makeAuth, current, requireAdmin, recordAuthResult } from './auth.ts';
import { resetRequest, resetPassword, recoverAdmin } from './security.ts';
import { realm, HttpError, fields, string, email, event, outbox } from './types.ts';
import type { Config } from './types.ts';

export async function createServer(config: Config) {
  if (!['development', 'test'].includes(config.environment)) throw new Error('Production requires a KMS adapter and separate security acceptance');
  try {
    const base=new URL(config.baseURL), origin=new URL(config.origin);
    if (base.origin!==config.baseURL || origin.origin!==config.origin || !['http:','https:'].includes(base.protocol) || !['http:','https:'].includes(origin.protocol)) throw new Error();
  } catch { throw new Error('API and frontend must have explicit valid origins'); }
  const expectedRole = config.profile === 'control' ? 'control_api' : 'finance_api';
  const role = (await config.pool.query(`SELECT oid,current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (role.name !== expectedRole || role.rolsuper || role.rolbypassrls) throw new Error('Runtime database credentials must use the scoped application role');
  const owned = await config.pool.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE (c.relowner=$1 OR n.nspowner=$1) AND n.nspname IN ('identity','control','access','commerce','finance','protected_keys') LIMIT 1`, [role.oid]);
  if (owned.rowCount) throw new Error('Runtime database credentials must not own application objects');
  if (config.authSecret.length < 32 || config.wrappingKey.length !== 32) throw new Error('Independent runtime secrets are required');
  const seal = envelope(config.wrappingKey), schema = realm(config.profile);
  // Finance repositories are never loaded by the control deployment profile.
  const application = config.profile === 'finance' ? await import('./application.ts') : null;
  const finance = config.profile === 'finance' ? await import('./finance.ts') : null;
  const budgets = config.profile === 'finance' ? await import('./budgets.ts') : null;
  const operations = config.profile === 'finance' ? await import('./operations.ts') : null;
  const review = config.profile === 'finance' ? await import('./finance-review.ts') : null;
  const importValidation = config.profile === 'finance' ? await import('./import-validation.ts') : null;
  const importIngestion = config.profile === 'finance' ? await import('./import-ingestion.ts') : null;
  const registration = config.profile === 'finance' ? await import('./registration.ts') : null;
  const renewalApplication = config.profile === 'finance' ? await import('./renewal-application.ts') : null;
  const renewalCommerce = config.profile === 'control' ? await import('./renewal-commerce.ts') : null;
  const manual = config.profile === 'control' ? await import('./manual-access.ts') : null;
  const commerce = config.profile === 'control' ? await import('./commerce.ts') : null;
  class RootModule {} Module({})(RootModule);
  const app = await NestFactory.create<NestFastifyApplication>(RootModule, new FastifyAdapter({ logger: false, trustProxy: false, bodyLimit: 8192 }), { logger: false });
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control','no-store').header('referrer-policy','no-referrer').header('x-content-type-options','nosniff');
    return payload;
  });
  async function subjectRate(userId: string,purpose='enrollment') {
    const result = await config.pool.query(`INSERT INTO ${schema}.rate_limit(key,hits,expires_at) VALUES($1,1,now()+interval '5 minutes')
      ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN ${schema}.rate_limit.expires_at<=now() THEN 1 ELSE ${schema}.rate_limit.hits+1 END,
      expires_at=CASE WHEN ${schema}.rate_limit.expires_at<=now() THEN EXCLUDED.expires_at ELSE ${schema}.rate_limit.expires_at END RETURNING hits`, [seal.rateKey(purpose+':'+userId)]);
    if (result.rows[0].hits>5) throw new HttpError(429,'RATE_LIMITED');
  }
  const financeReads=new Set(['/finance/budgets','/finance/operations-page','/finance/operations-selection','/finance/operations-views','/finance/operation','/finance/summary','/finance/history-query','/finance/imports','/finance/import-status','/finance/review-sessions']);
  const financeWrites=new Set(['/finance/preview','/finance/commit','/finance/edit','/finance/import-context','/finance/import-validation','/finance/import-accept','/finance/review-command']);
  async function rate(request: FastifyRequest) {
    if (request.method !== 'POST') return;
    const route = request.url.split('?')[0]!;
    const address = typeof (request.body as Record<string, unknown> | undefined)?.email === 'string' ? String((request.body as Record<string, unknown>).email).trim().toLowerCase() : '';
    // Interactive finance snapshots and field edits must not consume authentication budgets.
    // These closed route budgets remain durable, bounded and subject to the normal server authority checks.
    const financial=config.profile==='finance'&&(financeReads.has(route)||financeWrites.has(route)),scope=financial?'finance:':'';
    const budgets: [string, number, number][] = [[scope+'ip:' + request.ip, financial?120:30, 60]];
    const invitationSecret = (request.body as Record<string, unknown> | undefined)?.invitationToken;
    if(typeof invitationSecret==='string') budgets.push(['invitation:'+route+':'+invitationSecret,5,300]);
    if (address) budgets.push(['account:' + route + ':' + address, route.endsWith('reset-request') ? 3 : 5, 300]);
    else budgets.push([scope+'action:' + route + ':' + request.ip, financial?(financeReads.has(route)?120:60):10, 60]);
    for (const [key, max, seconds] of budgets) {
      const entry = (await config.pool.query(`INSERT INTO ${schema}.rate_limit(key,hits,expires_at) VALUES($1,1,now()+$2*interval '1 second')
        ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN ${schema}.rate_limit.expires_at<=now() THEN 1 ELSE ${schema}.rate_limit.hits+1 END,
        expires_at=CASE WHEN ${schema}.rate_limit.expires_at<=now() THEN EXCLUDED.expires_at ELSE ${schema}.rate_limit.expires_at END RETURNING hits`, [seal.rateKey(key), seconds])).rows[0];
      if (entry.hits > max) throw new HttpError(429, 'RATE_LIMITED');
    }
  }
  const requestHandler=async (request:FastifyRequest,reply:FastifyReply) => {
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
      const resetPasswordProof=config.profile==='finance'&&path==='/finance/commit'&&typeof request.body==='object'&&request.body!==null&&'password'in request.body;
      if (config.profile==='control' && ['/auth/two-factor/enable','/auth/two-factor/verify-totp'].includes(path)||resetPasswordProof) {
        // Read the candidate before acquiring the mutation lock, release its connection,
        // then persist the limit. Re-check all authority inside the locked transaction below.
        // A second pool checkout while holding that lock can deadlock a saturated pool.
        const candidate=await config.pool.connect();let userId:string|undefined;
        try { userId=(await current(makeAuth(config,candidate,seal),request))?.user.id; }
        finally { candidate.release(); }
        if(userId)await subjectRate(userId,resetPasswordProof?'financial-reset':'enrollment');
      }
      db = await config.pool.connect(); await db.query('BEGIN');
      // Serialize authentication mutations across instances. This foundation favors correctness over login throughput.
      await db.query('SELECT pg_advisory_xact_lock($1)', [config.profile === 'control' ? 92041 : 92042]);
      const auth = makeAuth(config, db, seal);
      let result: unknown, cookies: string[] = [], status = 200;
      if (path.startsWith('/auth/')) {
        const allowed = ['/auth/sign-in/email', '/auth/sign-out', ...(config.profile === 'control' ? ['/auth/two-factor/enable', '/auth/two-factor/verify-totp'] : [])];
        if (request.method !== 'POST' || !allowed.includes(path)) throw new HttpError(404, 'NOT_FOUND');
        let enrollment = false;
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
          if (session) { const proof = await requireAdmin(auth, db, request, ['enrollment', 'recovery', 'admin']); enrollment = proof.proof.level !== 'admin'; }
        } else fields(request, []);
        const headers = fromNodeHeaders(request.headers);
        headers.set('cookie', (headers.get('cookie') ?? '').split(';').filter(part => !part.includes('trust_device')).join(';'));
        let response = await auth.handler(new Request(new URL(path, config.baseURL), { method: 'POST', headers, body: JSON.stringify(request.body) }));
        response = await recordAuthResult(auth, db, config, request, response, seal, enrollment);
        status = response.status; cookies = response.headers.getSetCookie();
        result = await response.json();
        if (!response.ok) {
          // Preserve the library's account-wide failed-TOTP/challenge counters across challenges and IPs.
          // Unexpected library failures roll back. Capability proof is issued only after a successful response.
          await db.query(path==='/auth/two-factor/verify-totp' && response.status<500 ? 'COMMIT' : 'ROLLBACK'); db.release(); db = undefined;
          return reply.code(status === 429 ? 429 : 401).send({ code: 'INVALID_CREDENTIALS' });
        }
        if (path === '/auth/sign-in/email') {
          if (!(result as Record<string, unknown>).twoFactorRedirect) {
            const newSession = await auth.api.getSession({ headers: new Headers({ ...Object.fromEntries(headers), cookie: cookies.map(c => c.split(';')[0]).join('; ') }), query: { disableCookieCache: true } });
            if (newSession && config.profile === 'finance') {
              await event(db, schema, newSession.user.id, 'password_login');
              await outbox(db, schema, seal, 'security_login', { email: newSession.user.email, at: newSession.session.createdAt, profile: 'finance',device:describeDevice(request.headers['user-agent']) },{subjectId:newSession.user.id});
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
          result = { name: s.user.name, scope: s.proof.level, capabilities: s.proof.level === 'admin' ? ['review_requests','manual_access'] : ['enroll_totp'] };
        } else {
          const s = await current(auth, request); if (!s || !s.user.emailVerified) throw new HttpError(401, 'AUTH_REQUIRED');
          await db.query("SELECT set_config('app.user_id',$1,true)",[s.user.id]);
          const state = (await db.query('SELECT s.status,CASE WHEN c.user_id IS NOT NULL THEN c.indefinite ELSE s.indefinite END AS indefinite,CASE WHEN c.user_id IS NOT NULL THEN c.access_end ELSE s.access_end END AS access_end,c.timezone FROM identity.security_state s LEFT JOIN commerce.access_cycle c USING(user_id) WHERE s.user_id=$1', [s.user.id])).rows[0];
          if (!state) throw new HttpError(403, 'AUTH_REQUIRED');
          const now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
          const active = state.status === 'active' && (state.indefinite || state.access_end && state.access_end > now);
          result = { name: s.user.name,accessWarning:accessWarning(state.access_end?.toISOString(),state.indefinite,now), accessEnd:state.access_end,timezone:state.timezone,indefinite:state.indefinite,blocked:state.status==='suspended', scope: active ? 'active' : 'restricted', capabilities: active ? ['account','security','access','support','privacy','delete_own_data','finance'] : ['account','security','access','support','privacy','delete_own_data'] };
        }
      } else if (config.profile==='control'&&path==='/control/deliveries'&&request.method==='GET'){
        await requireAdmin(auth,db,request);result=await mailQueue(db);
      } else if (config.profile==='control'&&path==='/control/delivery-retry'&&request.method==='POST'){
        const s=await requireAdmin(auth,db,request);result=await retryMail(db,request,s.user.id);
      } else if (config.profile==='control'&&path==='/control/invitation-resend'&&request.method==='POST'){
        const s=await requireAdmin(auth,db,request);result=await resendInvitation(db,request,s.user.id,seal);
      } else if (manual && path==='/control/accesses' && request.method==='GET') {
        await requireAdmin(auth,db,request);result=await manual.manualQueue(db);
      } else if (manual && ['/control/manual-preview','/control/manual-access'].includes(path) && request.method==='POST') {
        const s=await requireAdmin(auth,db,request);result=await manual.manualAccess(db,request,s.user.id,seal,path==='/control/manual-preview');
      } else if (manual && path==='/control/manual-invitation-action' && request.method==='POST') {
        const s=await requireAdmin(auth,db,request);result=await manual.manualInvitationAction(db,request,s.user.id,seal);
      } else if (renewalCommerce && path==='/control/renewals' && request.method==='GET') {
        await requireAdmin(auth,db,request); result=await renewalCommerce.renewalQueue(db);
      } else if (renewalCommerce && ['/control/renewal-preview','/control/renewal-review'].includes(path) && request.method==='POST') {
        const s=await requireAdmin(auth,db,request);result=await renewalCommerce.reviewRenewal(db,request,s.user.id,seal,path==='/control/renewal-preview');
      } else if (renewalApplication && ['/access/renewal','/access/renewal-create','/access/renewal-change','/access/renewal-cancel','/access/renewal-claim'].includes(path)) {
        if(request.url.includes('?')||(path==='/access/renewal'?request.method!=='GET':request.method!=='POST'))throw new HttpError(404,'NOT_FOUND');
        const s=await current(auth,request);if(!s||!s.user.emailVerified)throw new HttpError(401,'AUTH_REQUIRED');
        await db.query("SELECT set_config('app.user_id',$1,true)",[s.user.id]);
        const state=(await db.query('SELECT CASE WHEN c.user_id IS NOT NULL THEN c.indefinite ELSE s.indefinite END AS indefinite FROM identity.security_state s LEFT JOIN commerce.access_cycle c USING(user_id) WHERE s.user_id=$1',[s.user.id])).rows[0];
        if(!state||state.indefinite&&path!=='/access/renewal')throw new HttpError(409,'CYCLE_UNAVAILABLE');
        result=path==='/access/renewal'?await renewalApplication.ownRenewal(db,s.user.id):await renewalApplication.renewalApplication(db,request,s.user,seal,path.slice('/access/renewal-'.length) as 'create'|'change'|'cancel'|'claim');
      } else if (finance && ['/finance/budgets','/finance/operations-page','/finance/operations-selection','/finance/operations-views','/finance/state','/finance/epoch','/finance/summary','/finance/operation','/finance/preview','/finance/commit','/finance/edit','/finance/history','/finance/history-query','/finance/import-context','/finance/import-validation','/finance/import-accept','/finance/import-status','/finance/imports','/finance/review-sessions','/finance/review-command'].includes(path)) {
        const methodAllowed=path==='/finance/imports'?['GET','POST'].includes(request.method):['/finance/state','/finance/history','/finance/epoch'].includes(path)?request.method==='GET':request.method==='POST';
        if(request.url.includes('?')||!methodAllowed)throw new HttpError(404,'NOT_FOUND');
        const s=await current(auth,request);if(!s||!s.user.emailVerified)throw new HttpError(401,'AUTH_REQUIRED');
        await finance.prepareFinance(db,s.user.id);
        if(path==='/finance/budgets')result=await budgets!.queryBudgets(db,s.user.id,request.body);
        else if(path==='/finance/state')result=await finance.financeView(db,s.user.id);
        else if(path==='/finance/epoch'){const w=await finance.prepareFinance(db,s.user.id);result={generation:w.generation,revision:w.revision,keyVersion:w.key_version,interfaceEpoch:w.interface_epoch,recentAuthenticationRequired:!(await db.query("SELECT created_at>clock_timestamp()-interval '5 minutes' AS fresh FROM identity.auth_session WHERE user_id=$1 AND id=$2",[s.user.id,s.session.id])).rows[0]?.fresh};}
        else if(path==='/finance/operations-page')result=await operations!.operationsPage(db,s.user.id,request.body);
        else if(path==='/finance/operations-selection')result=await operations!.operationsSelection(db,s.user.id,request.body);
        else if(path==='/finance/operations-views')result=await operations!.operationsViews(db,s.user.id);
        else if(path==='/finance/summary')result=await finance.financeView(db,s.user.id,finance.parseFilter(request.body),(request.body as {compact?:boolean}).compact===true);
        else if(path==='/finance/operation')result=await finance.operationView(db,s.user.id,fields(request,['id']).id);
        else if(path==='/finance/review-sessions')result=await review!.reviewSessions(db,s.user.id,request.body);
        else if(path==='/finance/review-command')result=await review!.reviewCommand(db,s.user.id,request.body);
        else if(path==='/finance/preview')result=await finance.previewFinance(db,s.user.id,request.body);
        else if(path==='/finance/commit')result=await finance.commitFinance(db,s.user.id,request.body,seal,s.session.id);
        else if(path==='/finance/import-context')result=await finance.prepareImportContext(db,s.user.id,await finance.prepareFinance(db,s.user.id),request.body,seal);
        else if(path==='/finance/import-validation')result=await importValidation!.validateImport(db,s.user.id,request.body);
        else if(path==='/finance/import-accept'){result=await importIngestion!.acceptImport(db,s.user.id,request.body);status=202;}
        else if(path==='/finance/import-status')result=await importIngestion!.importStatus(db,s.user.id,request.body);
        else if(path==='/finance/imports')result=await importIngestion!.importHistory(db,s.user.id,request.method==='GET'?{}:request.body);
        else if(path==='/finance/edit')result=await finance.editFinance(db,s.user.id,request.body);
        else result=await finance.queryHistory(db,s.user.id,(await finance.prepareFinance(db,s.user.id)).generation,path==='/finance/history'?{}:request.body);
      } else if (path === '/control/requests' && config.profile === 'control' && request.method === 'GET') {
        await requireAdmin(auth, db, request);
        result = await commerce!.queue(db);
      } else if (commerce && ['/control/review-preview','/control/review'].includes(path) && request.method === 'POST') {
        const s=await requireAdmin(auth,db,request);
        result=await commerce.review(db,request,s.user.id,seal,path==='/control/review-preview');
      } else if (commerce && path==='/control/invitation-action' && request.method==='POST') {
        const s=await requireAdmin(auth,db,request);result=await commerce.invitationAction(db,request,s.user.id,seal);
      } else if (commerce && path==='/control/invitation-link' && request.method==='POST') {
        const s=await requireAdmin(auth,db,request);result=await commerce.copyInvitation(db,request,s.user.id,seal);
      } else if (registration && path==='/access/registration-proof' && request.method==='POST') {
        result=await registration.requestRegistrationProof(db,request,seal);status=202;
      } else if (registration && path==='/access/register' && request.method==='POST') {
        result=await registration.register(db,request,seal);status=201;
      } else if (application && path==='/access/tariffs' && request.method==='GET') {
        result={tariffs:(await db.query("SELECT snapshot FROM access.tariff WHERE snapshot->>'active'='true' AND snapshot->>'publicVisible'='true' AND snapshot->>'availableForNew'='true' ORDER BY id")).rows.map(r=>r.snapshot)};
      } else if (path === '/security/sessions' && request.method === 'GET') {
        const s = config.profile === 'control' ? await requireAdmin(auth, db, request) : await current(auth, request);
        if (!s || !s.user.emailVerified) throw new HttpError(401, 'AUTH_REQUIRED');
        result = { sessions: (await db.query(`SELECT id,created_at,expires_at FROM ${schema}.auth_session WHERE user_id=$1 AND expires_at>clock_timestamp()`, [s.user.id])).rows.map(r => ({ id: r.id, createdAt: r.created_at, expiresAt: r.expires_at, current: r.id === s.session.id })) };
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
        result = { request: application.publicRequest(await application.ownedApplication(db, config, request)) };
      } else if (application && path === '/access/payment-claim' && request.method === 'POST') {
        result = { request: await application.applicationClaim(db, config, request, seal) };
      } else throw new HttpError(404, 'NOT_FOUND');
      await db.query('COMMIT'); db.release(); db = undefined;
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.code(status).send(result);
    } catch (error) {
      if (db) { await db.query('ROLLBACK'); db.release(); }
      // No raw credentials, identifiers, payloads, SQL errors or reset links in responses/logs.
      const code=error instanceof HttpError ? error.code : 'REQUEST_FAILED';
      const recovery=code==='IMPORT_CONTEXT_CHANGED'?'Данные были сброшены на другом устройстве. Загрузите файл заново.':code==='IMPORT_CONTEXT_EXPIRED'?'Срок подготовки загрузки истёк. Загрузите файл заново.':undefined;
      return reply.code(error instanceof HttpError ? error.status : 400).send({code,...(recovery?{message:recovery}:{})});
    }
  };
  fastify.route({method:['GET','POST','OPTIONS'],url:'/*',handler:requestHandler});
  if(finance)for(const url of ['/finance/preview','/finance/review-command'])fastify.route({method:['GET','POST','OPTIONS'],url,bodyLimit:64*1024,handler:requestHandler});
  // Isolated normalized-contract budget; password/auth routes retain the 8 KiB default.
  // A closed 1000-row profile with instants and all HMAC fields exceeds 512 KiB.
  // Keep this allowance scoped to imports; schema limits still bound every field.
  if(finance)for(const url of ['/finance/operations-page','/finance/operations-selection'])fastify.route({method:['GET','POST','OPTIONS'],url,bodyLimit:128*1024,handler:requestHandler});
  if(importValidation)fastify.route({method:['GET','POST','OPTIONS'],url:'/finance/import-validation',bodyLimit:1024*1024,handler:requestHandler});
  if(importIngestion)fastify.route({method:['GET','POST','OPTIONS'],url:'/finance/import-accept',bodyLimit:1024*1024,handler:requestHandler});
  await app.init();
  fastify.setErrorHandler((error, _request, reply) => {
    // Parser/oversize failures must never reflect raw request fragments or tokens.
    const oversized=error && typeof error==='object' && 'statusCode' in error && error.statusCode===413;
    return reply.code(oversized ? 413 : 400).send({code:'INVALID_REQUEST'});
  });
  await fastify.ready();
  return { app, fastify, close: () => app.close() };
}
