import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { postgresFixture } from './postgres.ts';
import { createServer } from '../src/server.ts';
import { hashPassword, envelope, digest, token } from '../src/crypto.ts';
import type { Config } from '../src/types.ts';
import type { FastifyInstance } from 'fastify';
import {extensionAt} from '../src/entitlement.ts';

let pg: Awaited<ReturnType<typeof postgresFixture>>;
let finance: Awaited<ReturnType<typeof createServer>>, control: Awaited<ReturnType<typeof createServer>>;
let fc: Config, cc: Config;
const testPassword = 'Synthetic test password 123!';
const tariff = { id: 'development-month', name: 'Synthetic tariff', duration: { kind: 'calendar_months', count: 1 }, priceMinor: '119000', aiQuota: 150, active: true, publicVisible: true, availableForNew: true, availableForRenewal: true };
before(async () => {
  pg = await postgresFixture();
  fc = { profile: 'finance', pool: pg.finance, baseURL: 'https://api.example.test', origin: 'https://app.example.test', authSecret: token(), wrappingKey: randomBytes(32), environment: 'test' };
  cc = { profile: 'control', pool: pg.control, baseURL: 'https://control.example.test', origin: 'https://admin.example.test', authSecret: token(), wrappingKey: randomBytes(32), environment: 'test' };
  finance = await createServer(fc); control = await createServer(cc);
});
after(async () => { await finance?.close(); await control?.close(); await pg?.close(); });
beforeEach(async () => {
  await pg.owner.query(`TRUNCATE identity.auth_user,control.auth_user,identity.auth_verification,control.auth_verification,identity.outbox,control.outbox,access.outbox,
    identity.security_event,control.security_event,identity.rate_limit,control.rate_limit,access.rate_limit,access.request,access.tariff,finance.isolation_canary,commerce.action,commerce.renewal_request,commerce.access_cycle CASCADE`);
  await pg.owner.query('INSERT INTO access.tariff(id,snapshot) VALUES($1,$2)', [tariff.id, tariff]);
});
class Browser {
  jar = new Map<string,string>();
  constructor(public api: FastifyInstance, public origin: string, public ip='127.0.0.1') {}
  async post(url: string, payload: Record<string, unknown>, origin = this.origin) { return this.request('POST', url, payload, origin); }
  async get(url: string) { return this.request('GET', url); }
  async request(method: 'GET'|'POST', url: string, payload?: Record<string, unknown>, origin = this.origin) {
    const r = await this.api.inject({ method, url, remoteAddress:this.ip, ...(payload ? { payload } : {}), headers: { origin, ...(payload ? { 'content-type': 'application/json' } : {}), cookie: [...this.jar].map(([k,v]) => `${k}=${v}`).join('; ') } });
    for (const c of r.cookies) { if (c.maxAge === 0) this.jar.delete(c.name); else this.jar.set(c.name,c.value); }
    return r;
  }
  clone(api = this.api, origin = this.origin) { const b = new Browser(api,origin,this.ip); b.jar = new Map(this.jar); return b; }
}
const userBrowser = () => new Browser(finance.fastify,fc.origin);
const adminBrowser = () => new Browser(control.fastify,cc.origin);
async function seedUser(schema: 'identity'|'control', id = 'owner', verified = true) {
  await pg.owner.query(`INSERT INTO ${schema}.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Synthetic user',$2,$3,now(),now())`, [id, `${id}@example.test`, verified]);
  await pg.owner.query(`INSERT INTO ${schema}.auth_account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES($1,$2,'credential',$2,$3,now(),now())`, ['account-'+id,id,await hashPassword(testPassword)]);
  await pg.owner.query(`INSERT INTO ${schema}.security_state(user_id${schema==='control'?',bootstrap_pending':''}) VALUES($1${schema==='control'?',true':''})`, [id]);
}
async function mail(schema: 'access'|'identity'|'control', kind: string, config = schema==='control'?cc:fc) {
  const row = (await pg.owner.query(`SELECT sealed_payload FROM ${schema}.outbox WHERE kind=$1 ORDER BY created_at DESC LIMIT 1`, [kind])).rows[0];
  assert.ok(row, 'Expected transactional email queued'); return JSON.parse(envelope(config.wrappingKey).open(row.sealed_payload));
}
function otp(uri: string, now=Date.now()) {
  const secret = new URL(uri).searchParams.get('secret')!, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret.toUpperCase().replace(/=+$/,'')) bits += alphabet.indexOf(c).toString(2).padStart(5,'0');
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map(b => parseInt(b,2))), counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now/30000)));
  const h = createHmac('sha1',bytes).update(counter).digest(), offset = h.at(-1)! & 15;
  return ((h.readUInt32BE(offset)&0x7fffffff)%1000000).toString().padStart(6,'0');
}
function invalidOTP(uri: string) {
  const accepted=new Set([-30000,0,30000].map(offset=>otp(uri,Date.now()+offset)));
  let n=0;while(accepted.has(n.toString().padStart(6,'0')))n++;return n.toString().padStart(6,'0');
}
async function enrolledAdmin() {
  await seedUser('control'); const b = adminBrowser();
  assert.equal((await b.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword})).statusCode,200);
  const enabled = await b.post('/auth/two-factor/enable',{password:testPassword}); assert.equal(enabled.statusCode,200, 'TOTP enrollment starts');
  assert.equal(enabled.json().backupCodes,undefined); const uri = enabled.json().totpURI;
  const code=otp(uri), verified = await b.post('/auth/two-factor/verify-totp',{code}); assert.equal(verified.statusCode,200, 'Enrollment requires valid authenticator code');
  return { b, uri, code, codes: verified.json().recoveryCodes as string[] };
}
async function application(address='visitor@example.test') {
  const b = userBrowser(); assert.equal((await b.post('/access/requests',{name:'Synthetic visitor',email:address,tariffId:tariff.id})).statusCode,202);
  const sent = await mail('access','application_verification'); assert.equal((await b.post('/access/verify',{token:sent.token})).statusCode,200);
  return { b, sent, row: (await b.get('/access/request')).json().request };
}

test('real PostgreSQL 18, non-owner runtime roles and database isolation', async () => {
  const version = Number((await pg.owner.query('SHOW server_version_num')).rows[0].server_version_num); assert.ok(version>=180000&&version<190000);
  for (const sql of ['SELECT * FROM finance.isolation_canary','SELECT * FROM protected_keys.isolation_canary','SELECT * FROM identity.auth_account','SELECT * FROM access.outbox']) await assert.rejects(pg.control.query(sql),{code:'42501'});
  await assert.rejects(pg.finance.query('SELECT * FROM control.auth_account'),{code:'42501'});
  await assert.rejects(createServer({...fc,pool:pg.owner}), /scoped application role/);
  await assert.rejects(createServer({...fc,origin:undefined as unknown as string}), /explicit valid origins/);
  await assert.rejects(createServer({...cc,baseURL:'https://control.example.test/unexpected-path'}), /explicit valid origins/);
  await pg.owner.query('GRANT CREATE ON SCHEMA control TO control_api');
  try {
    await pg.control.query('CREATE TABLE control.ownership_canary(marker text)');
    await assert.rejects(createServer(cc), /must not own/);
  } finally { await pg.owner.query('DROP TABLE IF EXISTS control.ownership_canary'); await pg.owner.query('REVOKE CREATE ON SCHEMA control FROM control_api'); }
});
test('transaction-local tenant context and FORCE RLS do not cross pool requests', async () => {
  await pg.owner.query(`INSERT INTO finance.isolation_canary VALUES('first','synthetic A'),('second','synthetic B')`);
  const db = await pg.finance.connect(); try {
    await db.query('BEGIN'); await db.query("SELECT set_config('app.user_id',$1,true)",['first']);
    assert.equal((await db.query('SELECT * FROM finance.isolation_canary')).rowCount,1);
    await assert.rejects(db.query("INSERT INTO finance.isolation_canary VALUES('third','synthetic C')"),{code:'42501'});
    await db.query('ROLLBACK'); assert.equal((await db.query('SELECT * FROM finance.isolation_canary')).rowCount,0);
  } finally { db.release(); }
});
test('public signup and all alternate 2FA bypass endpoints are closed', async () => {
  const b = adminBrowser();
  for (const url of ['/auth/sign-up/email','/auth/two-factor/disable','/auth/two-factor/verify-backup-code','/auth/two-factor/send-otp','/auth/two-factor/verify-otp','/auth/two-factor/generate-backup-codes','/auth/reset-password','/auth/sign-in/social']) assert.equal((await b.post(url,{})).statusCode,404);
  assert.equal((await userBrowser().post('/auth/sign-up/email',{})).statusCode,404);
});
test('same generic login/reset responses for unknown and unverified email', async () => {
  await seedUser('identity','unverified',false); const b = userBrowser();
  const missing = await b.post('/auth/sign-in/email',{email:'missing@example.test',password:testPassword});
  const unverified = await b.post('/auth/sign-in/email',{email:'unverified@example.test',password:testPassword});
  assert.equal(missing.statusCode,401); assert.equal(missing.body,unverified.body); assert.equal((await b.get('/session')).statusCode,401);
  assert.equal((await b.post('/security/reset-request',{email:'missing@example.test'})).body,(await b.post('/security/reset-request',{email:'unverified@example.test'})).body);
  assert.equal((await pg.owner.query('SELECT * FROM identity.outbox')).rowCount,0);
});
test('request snapshot comes from database, no authority from client tariff/actor fields', async () => {
  const b=userBrowser(); assert.equal((await b.post('/access/requests',{name:'Visitor',email:'v@example.test',tariffId:tariff.id,priceMinor:'1'})).statusCode,400);
  const {row}=await application(); assert.equal(row.tariff.priceMinor,'119000');
  await pg.owner.query("UPDATE access.tariff SET snapshot=jsonb_set(snapshot,'{priceMinor}','999000')");
  assert.equal((await b.get('/access/request')).statusCode,401);
  assert.equal((await pg.owner.query('SELECT data FROM access.request')).rows[0].data.tariff.priceMinor,'119000');
});
test('verification is single-use under concurrency and stored tokens/outbox reveal no raw secrets', async () => {
  const b=userBrowser(); await b.post('/access/requests',{name:'Visitor',email:'visitor@example.test',tariffId:tariff.id}); const sent=await mail('access','application_verification');
  const responses=await Promise.all([b.clone().post('/access/verify',{token:sent.token}),b.clone().post('/access/verify',{token:sent.token})]);
  assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,400]);
  const row=(await pg.owner.query('SELECT verifier FROM access.email_token')).rows[0]; assert.equal(row.verifier,digest(sent.token));
  const sealed=(await pg.owner.query('SELECT sealed_payload FROM access.outbox')).rows[0].sealed_payload; assert.ok(!sealed.includes(sent.token)&&!sealed.includes(sent.email));
});
test('expired verification/request cannot authorize payment, token in URL is not accepted', async () => {
  const b=userBrowser();await b.post('/access/requests',{name:'Visitor',email:'visitor@example.test',tariffId:tariff.id});const sent=await mail('access','application_verification');
  await pg.owner.query("UPDATE access.email_token SET expires_at=now()-interval '1 second'");
  assert.equal((await b.post('/access/verify',{token:sent.token})).statusCode,400);
  assert.equal((await b.post('/access/payment-claim',{senderName:'Visitor',senderBank:'Bank'})).statusCode,401);
  assert.equal((await b.get('/access/verify?token='+sent.token)).statusCode,404);
});
test('owned application ignores client identifiers and payment claim never grants access', async () => {
  const a=await application('first@example.test'), b=await application('second@example.test');
  assert.equal((await a.b.get('/access/request?requestId='+b.row.id)).statusCode,400);
  assert.equal((await a.b.post('/access/payment-claim',{senderName:'First',senderBank:'Bank',requestId:b.row.id})).statusCode,400);
  const claim=await a.b.post('/access/payment-claim',{senderName:'First',senderBank:'Bank'});assert.equal(claim.statusCode,200);assert.equal(claim.json().request.status,'under_review');
  assert.equal((await b.b.get('/access/request')).json().request.status,'awaiting_payment');assert.equal((await a.b.get('/session')).statusCode,401);
});
test('duplicate requests remain one snapshot and response does not disclose existing account', async () => {
  const b=userBrowser(), body={name:'Visitor',email:'visitor@example.test',tariffId:tariff.id};
  const first=await b.post('/access/requests',body), repeat=await b.post('/access/requests',body);assert.equal(first.body,repeat.body);
  assert.equal((await pg.owner.query('SELECT * FROM access.request')).rowCount,1);
  await seedUser('identity','existing');assert.equal((await b.post('/access/requests',{...body,email:'existing@example.test'})).body,first.body);
});
test('mandatory TOTP: password/enrollment have no admin capabilities; codes returned only after proof', async () => {
  await seedUser('control');const b=adminBrowser();await b.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword});
  assert.equal((await b.get('/control/requests')).statusCode,403);assert.equal((await b.get('/session')).json().scope,'enrollment');
  assert.equal((await b.post('/auth/two-factor/enable',{password:testPassword,method:'otp'})).statusCode,400);
  const enabled=await b.post('/auth/two-factor/enable',{password:testPassword});assert.equal(enabled.json().backupCodes,undefined);
  assert.equal((await b.post('/auth/two-factor/verify-totp',{code:invalidOTP(enabled.json().totpURI)})).statusCode,401);
  assert.equal((await b.get('/control/requests')).statusCode,403);
  const valid=await b.post('/auth/two-factor/verify-totp',{code:otp(enabled.json().totpURI)});assert.equal(valid.statusCode,200);assert.equal(valid.json().recoveryCodes.length,8);
  assert.equal((await b.get('/control/requests')).statusCode,200);assert.equal((await b.get('/session')).json().scope,'admin');
  const stored=(await pg.owner.query('SELECT verifier FROM control.recovery_code')).rows;assert.ok(stored.every(r=>!valid.json().recoveryCodes.includes(r.verifier)));
});
test('each admin login challenges TOTP; trusted devices and repeated code are refused', async () => {
  const {b,uri,code}=await enrolledAdmin();const another=adminBrowser();
  const challenge=await another.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword});assert.equal(challenge.json().status,'totp_required');
  assert.equal((await another.get('/control/requests')).statusCode,401);
  assert.equal((await another.post('/auth/two-factor/verify-totp',{code:otp(uri),trustDevice:true})).statusCode,400);
  assert.ok([401,409].includes((await another.post('/auth/two-factor/verify-totp',{code})).statusCode));
  assert.equal((await another.get('/control/requests')).statusCode,401);
  assert.equal((await b.get('/control/requests')).statusCode,200);
});
test('recovery verifies fresh password and atomically consumes code, revokes sessions/old TOTP/challenges', async () => {
  const {b,codes,uri}=await enrolledAdmin(); const old=b.clone(), pending=adminBrowser();await pending.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword});
  assert.equal((await adminBrowser().post('/control/recovery',{email:'owner@example.test',password:'wrong password',recoveryCode:codes[0]})).statusCode,401);
  const a=adminBrowser(), c=adminBrowser();const recovered=await Promise.all([a.post('/control/recovery',{email:'owner@example.test',password:testPassword,recoveryCode:codes[0]}),c.post('/control/recovery',{email:'owner@example.test',password:testPassword,recoveryCode:codes[0]})]);
  assert.deepEqual(recovered.map(r=>r.statusCode).sort(),[200,401]); const active=recovered[0]!.statusCode===200?a:c;
  assert.equal((await old.get('/control/requests')).statusCode,401);assert.equal((await active.get('/control/requests')).statusCode,403);assert.equal((await active.get('/session')).json().scope,'recovery');
  assert.equal((await pending.post('/auth/two-factor/verify-totp',{code:otp(uri)})).statusCode,401);
  assert.equal((await pg.owner.query('SELECT * FROM control.auth_two_factor')).rowCount,0);
  const newEnrollment=await active.post('/auth/two-factor/enable',{password:testPassword});assert.equal(newEnrollment.statusCode,200);
  assert.equal((await active.get('/control/requests')).statusCode,403);
  assert.equal((await active.post('/auth/two-factor/verify-totp',{code:otp(newEnrollment.json().totpURI)})).statusCode,200);
  assert.equal((await active.get('/control/requests')).statusCode,200);
  assert.equal((await adminBrowser().post('/control/recovery',{email:'owner@example.test',password:testPassword,recoveryCode:codes[1]})).statusCode,401);
});
test('password reset invalidates old password, every reset token and every old session, requires new login', async () => {
  await seedUser('identity');const b=userBrowser();await b.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword});const old=b.clone();
  await b.post('/security/reset-request',{email:'owner@example.test'});const first=await mail('identity','password_reset');
  await b.post('/security/reset-request',{email:'owner@example.test'});const second=await mail('identity','password_reset');
  const newPassword='Another synthetic password 456!';assert.equal((await b.post('/security/reset',{token:first.token,newPassword})).statusCode,200);
  assert.equal((await old.get('/session')).statusCode,401);assert.equal((await b.get('/session')).statusCode,401);
  assert.equal((await b.post('/security/reset',{token:second.token,newPassword:testPassword})).statusCode,400);
  assert.equal((await b.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword})).statusCode,401);
  assert.equal((await b.post('/auth/sign-in/email',{email:'owner@example.test',password:newPassword})).statusCode,200);
  assert.equal((await mail('identity','security_password_changed')).email,'owner@example.test');
});
test('admin password reset never bypasses TOTP and invalidates recovery-only context', async () => {
  const {b,codes}=await enrolledAdmin();const r=adminBrowser();await r.post('/control/recovery',{email:'owner@example.test',password:testPassword,recoveryCode:codes[0]});
  await r.post('/security/reset-request',{email:'owner@example.test'});const reset=await mail('control','password_reset');const next='Synthetic replaced password 789!';
  assert.equal((await r.post('/security/reset',{token:reset.token,newPassword:next})).statusCode,200);
  assert.equal((await r.post('/auth/two-factor/enable',{password:next})).statusCode,401);
  const fresh=adminBrowser();await fresh.post('/auth/sign-in/email',{email:'owner@example.test',password:next});
  assert.equal((await fresh.get('/control/requests')).statusCode,403);assert.equal((await fresh.post('/auth/two-factor/enable',{password:next})).statusCode,403);
  assert.equal((await b.get('/control/requests')).statusCode,401);
  // Reset invalidates the recovery context, but an unused separately stored code can restart recovery with the new password.
  const restart=adminBrowser();assert.equal((await restart.post('/control/recovery',{email:'owner@example.test',password:next,recoveryCode:codes[1]})).statusCode,200);
  assert.equal((await restart.get('/control/requests')).statusCode,403);
  const enabled=await restart.post('/auth/two-factor/enable',{password:next});assert.equal(enabled.statusCode,200);
  assert.equal((await restart.post('/auth/two-factor/verify-totp',{code:otp(enabled.json().totpURI)})).statusCode,200);
});
test('user and admin cookies cannot cross realms; suspended/expired users are restricted', async () => {
  await seedUser('identity');const b=userBrowser();await b.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword});
  assert.equal((await b.get('/session')).json().scope,'restricted');await pg.owner.query("UPDATE identity.security_state SET access_end=now()+interval '1 day'");
  assert.equal((await b.get('/session')).json().scope,'active');await pg.owner.query("UPDATE identity.security_state SET status='suspended'");
  assert.equal((await b.get('/session')).json().scope,'restricted');assert.equal((await b.clone(control.fastify,cc.origin).get('/control/requests')).statusCode,401);
  const {b:admin}=await enrolledAdmin();assert.equal((await admin.clone(finance.fastify,fc.origin).get('/session')).statusCode,401);
});
test('CSRF/origin and JSON requirements; secure HttpOnly host-only cookies and no-store', async () => {
  const b=userBrowser();const rejected=await b.post('/access/requests',{name:'Visitor',email:'v@example.test',tariffId:tariff.id},'https://evil.example.test');assert.equal(rejected.statusCode,403);
  assert.equal((await finance.fastify.inject({method:'POST',url:'/security/reset-request',payload:{email:'v@example.test'},headers:{'content-type':'application/json'}})).statusCode,403);
  const a=await application();const cookie=await a.b.post('/access/verify',{token:a.sent.token});assert.equal(cookie.statusCode,400);
  const fresh=userBrowser();await seedUser('identity');const login=await fresh.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword});
  const sessionCookie=login.cookies.find(c=>c.name.includes('session_token'));assert.ok(sessionCookie?.secure&&sessionCookie.httpOnly);assert.equal(sessionCookie.domain,undefined);assert.equal(sessionCookie.sameSite,'Strict');
  assert.equal(login.headers['cache-control'],'no-store');assert.equal(login.json().token,undefined);
  const raw=token(), malformed=await finance.fastify.inject({method:'POST',url:'/security/reset',payload:'{"token":"'+raw+'",',headers:{origin:fc.origin,'content-type':'application/json'}});
  assert.equal(malformed.statusCode,400);assert.ok(!malformed.body.includes(raw));assert.equal(malformed.headers['cache-control'],'no-store');
});
test('durable rate limits survive failed transactions and a new server instance', async () => {
  const b=adminBrowser();for(let i=0;i<5;i++)assert.equal((await b.post('/control/recovery',{email:'absent@example.test',password:testPassword,recoveryCode:token()})).statusCode,401);
  assert.equal((await b.post('/control/recovery',{email:'absent@example.test',password:testPassword,recoveryCode:token()})).statusCode,429);
  const second=await createServer(cc);try{assert.equal((await new Browser(second.fastify,cc.origin).post('/control/recovery',{email:'absent@example.test',password:testPassword,recoveryCode:token()})).statusCode,429);}finally{await second.close();}
});
test('session list exposes no tokens and revocation cannot target another user', async () => {
  await seedUser('identity','first');await seedUser('identity','second');const a=userBrowser(),b=userBrowser();await a.post('/auth/sign-in/email',{email:'first@example.test',password:testPassword});await b.post('/auth/sign-in/email',{email:'second@example.test',password:testPassword});
  const own=await a.get('/security/sessions'), other=await b.get('/security/sessions');assert.equal(own.json().sessions[0].token,undefined);
  assert.equal((await a.post('/security/revoke-session',{sessionId:other.json().sessions[0].id})).statusCode,404);
  assert.equal((await b.get('/session')).statusCode,200);assert.equal((await a.post('/security/revoke-session',{sessionId:own.json().sessions[0].id})).statusCode,200);assert.equal((await a.get('/session')).statusCode,401);
});
test('TOTP secret uses envelope encryption and no administrative read reveals factors/codes', async () => {
  const {b,uri,codes}=await enrolledAdmin(), raw=(await pg.owner.query('SELECT secret,backup_codes FROM control.auth_two_factor')).rows[0];
  assert.equal(JSON.parse(raw.secret).v,1);assert.ok(!raw.secret.includes(new URL(uri).searchParams.get('secret')));assert.ok(!raw.backup_codes.includes(codes[0]));
  const state=await b.get('/session');assert.equal(state.json().secret,undefined);assert.equal(state.json().recoveryCodes,undefined);
  await assert.rejects(pg.control.query('SELECT * FROM protected_keys.isolation_canary'),{code:'42501'});
});
test('password reset is atomic when security email cannot be queued', async () => {
  await seedUser('identity'); const b=userBrowser(); await b.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword});
  await b.post('/security/reset-request',{email:'owner@example.test'}); const reset=await mail('identity','password_reset');
  await pg.owner.query('REVOKE INSERT ON identity.outbox FROM finance_api');
  try {
    assert.equal((await b.post('/security/reset',{token:reset.token,newPassword:'Synthetic new password 456!'})).statusCode,400);
    assert.equal((await b.get('/session')).statusCode,200);
    assert.equal((await pg.owner.query('SELECT epoch FROM identity.security_state')).rows[0].epoch,0);
  } finally { await pg.owner.query('GRANT INSERT ON identity.outbox TO finance_api'); }
  assert.equal((await b.post('/security/reset',{token:reset.token,newPassword:'Synthetic new password 456!'})).statusCode,200);
});
test('enrollment guessing is limited per account across separate browser sessions', async () => {
  await seedUser('control'); const b=adminBrowser();await b.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword});
  const enabled=await b.post('/auth/two-factor/enable',{password:testPassword});
  for(let i=0;i<4;i++)assert.equal((await b.clone().post('/auth/two-factor/verify-totp',{code:invalidOTP(enabled.json().totpURI)})).statusCode,401);
  assert.equal((await b.clone().post('/auth/two-factor/verify-totp',{code:invalidOTP(enabled.json().totpURI)})).statusCode,429);
  assert.equal((await b.get('/control/requests')).statusCode,403);
});
test('ordinary TOTP login succeeds with a fresh period and no recovery code', async () => {
  const {uri,code}=await enrolledAdmin(), b=adminBrowser();await b.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword});
  const original=Date.now; let offset=31000;Date.now=()=>original()+offset;while(otp(uri)===code)offset+=30000;
  try {
    const verified=await b.post('/auth/two-factor/verify-totp',{code:otp(uri)});assert.equal(verified.statusCode,200);assert.equal(verified.json().recoveryCodes,undefined);
    assert.equal((await b.get('/control/requests')).statusCode,200);
  } finally { Date.now=original; }
});
test('failed TOTP counter persists across challenges and different IP addresses', async () => {
  const {uri}=await enrolledAdmin();
  for(let n=0;n<2;n++) {
    const b=adminBrowser();b.ip='192.0.2.'+(n+1);await b.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword});
    for(let i=0;i<(n===0?3:2);i++)assert.equal((await b.post('/auth/two-factor/verify-totp',{code:invalidOTP(uri)})).statusCode,401);
  }
  const next=adminBrowser();next.ip='192.0.2.3';await next.post('/auth/sign-in/email',{email:'owner@example.test',password:testPassword});
  assert.equal((await next.post('/auth/two-factor/verify-totp',{code:invalidOTP(uri)})).statusCode,429);
});
test('parallel enrollment limits do not deadlock a saturated database pool', {timeout:10000}, async () => {
  const {b,uri}=await enrolledAdmin();
  const responses=await Promise.all(Array.from({length:15},()=>b.clone().post('/auth/two-factor/verify-totp',{code:invalidOTP(uri)})));
  assert.ok(responses.every(r=>[401,429].includes(r.statusCode)));assert.ok(responses.some(r=>r.statusCode===429));
  assert.equal((await b.get('/control/requests')).statusCode,200);
});

async function claimedApplication(address='visitor@example.test') {
  const a=await application(address);
  const claim=await a.b.post('/access/payment-claim',{senderName:'Synthetic sender',senderBank:'Synthetic bank'});
  assert.equal(claim.statusCode,200);return {...a,row:claim.json().request};
}
function reviewCommand(row: {id:string;revision:number;tariff:{priceMinor:string}}) {
  return {actionId:crypto.randomUUID(),requestId:row.id,expectedRevision:row.revision,actualMinor:row.tariff.priceMinor,receivedAt:new Date().toISOString(),decision:'confirm',reason:'',inviteHours:72};
}
async function paidApplication(address='visitor@example.test') {
  const admin=await enrolledAdmin(),a=await claimedApplication(address),cmd=reviewCommand(a.row);
  const r=await admin.b.post('/control/review',cmd);assert.equal(r.statusCode,200);
  const invitation=r.json().invitations.at(-1),sent=await mail('access','invitation',cc);
  return {...a,admin,cmd,invitation,invitationToken:sent.token as string};
}
async function registrationProof(a:Awaited<ReturnType<typeof paidApplication>>) {
  assert.equal((await a.b.post('/access/registration-proof',{invitationToken:a.invitationToken})).statusCode,202);
  return (await mail('access','registration_verification')).proofToken as string;
}
const registrationBody=(invitationToken:string,proofToken:string)=>({invitationToken,proofToken,name:'Registered example',password:testPassword});

test('review preview is read-only; commit is TOTP-gated, revision-checked and idempotent',async()=>{
  const {b}=await enrolledAdmin(),a=await claimedApplication(),cmd=reviewCommand(a.row);
  assert.equal((await adminBrowser().post('/control/review',cmd)).statusCode,401);
  assert.equal((await a.b.post('/control/review',cmd)).statusCode,404);
  assert.equal((await b.post('/control/review-preview',cmd)).json().purchase.state,'paid_not_activated');
  assert.equal((await pg.owner.query('SELECT * FROM commerce.purchase')).rowCount,0);
  assert.equal((await b.post('/control/review',{...cmd,expectedRevision:0})).statusCode,409);
  assert.equal((await b.post('/control/review',{...cmd,actorId:'injected'})).statusCode,400);
  const committed=await b.post('/control/review',cmd);assert.equal(committed.statusCode,200);
  assert.equal((await b.post('/control/review',cmd)).json().status,'already_committed');
  assert.equal((await b.post('/control/review',{...cmd,inviteHours:24})).statusCode,409);
  assert.equal((await pg.owner.query('SELECT * FROM commerce.purchase')).rowCount,1);
  assert.equal((await pg.owner.query('SELECT * FROM commerce.invitation')).rowCount,1);
  assert.equal((await pg.owner.query('SELECT * FROM identity.auth_user')).rowCount,0);
  assert.equal((await pg.owner.query('SELECT activated_at FROM commerce.purchase')).rows[0].activated_at,null);
});
test('copied invitation alone never verifies email; proof is scoped, secret and independently mailed',async()=>{
  const a=await paidApplication(),attacker=userBrowser();
  const sent=await attacker.post('/access/registration-proof',{invitationToken:a.invitationToken});assert.equal(sent.statusCode,202);
  assert.equal(sent.json().proofToken,undefined);
  const proofMail=await mail('access','registration_verification');assert.equal(proofMail.email,'visitor@example.test');
  const failure=await attacker.post('/access/register',registrationBody(a.invitationToken,a.invitationToken));assert.equal(failure.statusCode,400);
  assert.equal((await pg.owner.query('SELECT * FROM identity.auth_user')).rowCount,0);
  assert.equal((await attacker.post('/access/register',{...registrationBody(a.invitationToken,proofMail.proofToken),email:'attacker@example.test'})).statusCode,400);
  assert.equal((await a.admin.b.post('/access/register',registrationBody(a.invitationToken,proofMail.proofToken))).statusCode,404);
  assert.equal((await pg.owner.query('SELECT verifier FROM access.registration_proof')).rows[0].verifier,digest(proofMail.proofToken));
});
test('successful registration atomically activates exactly once, retains snapshot and requires fresh login',async()=>{
  const a=await paidApplication(),proof=await registrationProof(a);
  const body=registrationBody(a.invitationToken,proof),results=await Promise.all([a.b.post('/access/register',body),userBrowser().post('/access/register',body)]);
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[201,400]);
  assert.equal((await pg.owner.query('SELECT * FROM identity.auth_user')).rowCount,1);
  const purchase=(await pg.owner.query('SELECT * FROM commerce.purchase')).rows[0];assert.equal(purchase.state,'active');assert.equal(purchase.data.tariff.priceMinor,'119000');
  assert.equal(purchase.timezone,'Europe/Moscow');assert.ok(purchase.access_end>purchase.activated_at);
  assert.equal((await a.b.get('/session')).statusCode,401);
  assert.equal((await a.b.get('/access/request')).statusCode,401);
  assert.equal((await a.b.post('/auth/sign-in/email',{email:'visitor@example.test',password:testPassword})).statusCode,200);
  assert.equal((await a.b.get('/session')).json().scope,'active');
  const user=(await pg.owner.query('SELECT * FROM identity.auth_user')).rows[0];assert.equal(user.email_verified,true);
  const account=(await pg.owner.query('SELECT password FROM identity.auth_account')).rows[0];assert.notEqual(account.password,testPassword);
  assert.equal((await a.admin.b.get('/control/requests')).json().invitations[0].state,'used');
  assert.equal((await a.admin.b.post('/control/invitation-action',{actionId:crypto.randomUUID(),invitationId:a.invitation.id,decision:'reissue',reason:'Synthetic test'})).statusCode,409);
});
test('cancel and reissue retain payment, use independent lifetime and invalidate prior link/proofs',async()=>{
  const a=await paidApplication(),proof=await registrationProof(a);
  const result=await a.admin.b.post('/control/invitation-action',{actionId:crypto.randomUUID(),invitationId:a.invitation.id,decision:'reissue',reason:'Synthetic replacement',inviteHours:24});assert.equal(result.statusCode,200);
  assert.equal(result.json().invitations[0].state,'superseded');
  assert.equal((await a.b.post('/access/register',registrationBody(a.invitationToken,proof))).statusCode,400);
  const newMail=await mail('access','invitation',cc), latest=result.json().invitations.at(-1);
  assert.equal((await a.b.post('/access/register',registrationBody(newMail.token,proof))).statusCode,400);
  assert.equal(Math.round((Date.parse(latest.expiresAt)-Date.parse(latest.createdAt))/3600000),24);
  assert.equal((await a.admin.b.post('/control/invitation-action',{actionId:crypto.randomUUID(),invitationId:latest.id,decision:'cancel',reason:'Synthetic cancellation'})).statusCode,200);
  assert.equal((await a.b.post('/access/registration-proof',{invitationToken:newMail.token})).statusCode,400);
  assert.equal((await pg.owner.query('SELECT * FROM commerce.purchase')).rowCount,1);
  assert.equal((await pg.owner.query('SELECT activated_at FROM commerce.purchase')).rows[0].activated_at,null);
});
test('expired invitation can be replaced without another payment or an earlier period start',async()=>{
  const a=await paidApplication();
  await pg.owner.query("UPDATE commerce.invitation SET expires_at=now()-interval '1 second'");
  // Keep domain metadata in sync with the real historical deadline for this expiry fixture.
  await pg.owner.query("UPDATE commerce.review_state SET data=jsonb_set(data,'{invitations,0,expiresAt}',to_jsonb(to_char(now()-interval '1 second','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')))");
  assert.equal((await a.b.post('/access/registration-proof',{invitationToken:a.invitationToken})).statusCode,400);
  assert.equal((await a.admin.b.post('/control/invitation-action',{actionId:crypto.randomUUID(),invitationId:a.invitation.id,decision:'reissue',reason:'Expired link'})).statusCode,200);
  assert.equal((await pg.owner.query('SELECT * FROM commerce.purchase')).rowCount,1);
  assert.equal((await pg.owner.query('SELECT activated_at FROM commerce.purchase')).rows[0].activated_at,null);
});
test('registration proof expiry, password rules and closed public signup prevent activation',async()=>{
  const a=await paidApplication(),proof=await registrationProof(a);
  assert.equal((await a.b.post('/access/register',{...registrationBody(a.invitationToken,proof),password:'short'})).statusCode,400);
  await pg.owner.query("UPDATE access.registration_proof SET expires_at=now()-interval '1 second'");
  assert.equal((await a.b.post('/access/register',registrationBody(a.invitationToken,proof))).statusCode,400);
  assert.equal((await a.b.post('/auth/sign-up/email',{name:'Bypass',email:'bypass@example.test',password:testPassword})).statusCode,404);
  assert.equal((await pg.owner.query('SELECT * FROM identity.auth_user')).rowCount,0);
});
test('payment mismatch requires explicit reason/decision and top-up accumulates separate actual records',async()=>{
  const admin=await enrolledAdmin(),a=await claimedApplication(),cmd=reviewCommand(a.row);
  assert.equal((await admin.b.post('/control/review',{...cmd,actualMinor:'50000'})).statusCode,409);
  assert.equal((await admin.b.post('/control/review',{...cmd,actualMinor:'50000',decision:'accept_full'})).statusCode,409);
  const topup=await admin.b.post('/control/review',{...cmd,actualMinor:'50000',decision:'topup',reason:'Need remaining transfer'});assert.equal(topup.statusCode,200);assert.equal(topup.json().purchases.length,0);
  const publicRow=(await a.b.get('/access/request')).json().request;assert.equal(publicRow.remainingMinor,'69000');assert.equal(publicRow.decisionNote,'');
  const secondClaim=await a.b.post('/access/payment-claim',{senderName:'Synthetic sender',senderBank:'Synthetic bank'});assert.equal(secondClaim.statusCode,200);
  const updated=secondClaim.json().request;assert.equal(updated.claimedAt,a.row.claimedAt);
  const completed=await admin.b.post('/control/review',{...reviewCommand(updated),actualMinor:'69000'});assert.equal(completed.statusCode,200);
  assert.equal(completed.json().payments.length,2);assert.equal(completed.json().purchases[0].actualMinor,'119000');
});
test('outbox failure rolls back review ledger/invitation and registration identity/activation together',async()=>{
  const admin=await enrolledAdmin(),a=await claimedApplication(),cmd=reviewCommand(a.row);
  await pg.owner.query('REVOKE INSERT ON access.outbox FROM control_api');
  try {assert.equal((await admin.b.post('/control/review',cmd)).statusCode,400);assert.equal((await pg.owner.query('SELECT * FROM commerce.purchase')).rowCount,0);}finally{await pg.owner.query('GRANT INSERT ON access.outbox TO control_api');}
  assert.equal((await admin.b.post('/control/review',cmd)).statusCode,200);
  const invitationToken=(await mail('access','invitation',cc)).token;
  assert.equal((await a.b.post('/access/registration-proof',{invitationToken})).statusCode,202);const proof=(await mail('access','registration_verification')).proofToken;
  await pg.owner.query('REVOKE INSERT ON identity.outbox FROM finance_api');
  try {
    assert.equal((await a.b.post('/access/register',registrationBody(invitationToken,proof))).statusCode,400);
    assert.equal((await pg.owner.query('SELECT * FROM identity.auth_user')).rowCount,0);
    assert.equal((await pg.owner.query('SELECT state FROM commerce.invitation')).rows[0].state,'active');
  }finally{await pg.owner.query('GRANT INSERT ON identity.outbox TO finance_api');}
  assert.equal((await a.b.post('/access/register',registrationBody(invitationToken,proof))).statusCode,201);
});
test('runtime grants expose neither invitation plaintext to finance nor identity/financial data to control',async()=>{
  const a=await paidApplication();
  await assert.rejects(pg.finance.query('SELECT sealed_token FROM commerce.invitation'),{code:'42501'});
  await assert.rejects(pg.finance.query('SELECT * FROM commerce.review_state'),{code:'42501'});
  await assert.rejects(pg.control.query('SELECT * FROM identity.auth_account'),{code:'42501'});
  await assert.rejects(pg.control.query('SELECT * FROM finance.isolation_canary'),{code:'42501'});
  const link=await a.admin.b.post('/control/invitation-link',{invitationId:a.invitation.id});assert.equal(link.json().token,a.invitationToken);
  const queue=await a.admin.b.get('/control/requests');assert.equal(queue.body.includes(a.invitationToken),false);assert.equal(queue.body.includes('sealed_token'),false);
  assert.equal((await adminBrowser().post('/control/invitation-link',{invitationId:a.invitation.id})).statusCode,401);
});
test('month-end clamping preserves Moscow wall time for leap years and original activation anchor',async()=>{
  for(const [start,count,expected] of [
    ['2027-01-31T08:15:00Z',1,'2027-02-28T08:15:00.000Z'],
    ['2028-01-31T08:15:00Z',1,'2028-02-29T08:15:00.000Z'],
    ['2027-01-31T08:15:00Z',2,'2027-03-31T08:15:00.000Z'],
    ['2027-12-31T08:15:00Z',3,'2028-03-31T08:15:00.000Z']
  ] as const) {
    const result=(await pg.owner.query("SELECT (($1::timestamptz AT TIME ZONE 'Europe/Moscow')+make_interval(months=>$2)) AT TIME ZONE 'Europe/Moscow' AS finish",[start,count])).rows[0].finish;assert.equal(result.toISOString(),expected);
  }
});

test('a proof expiring while registration waits for the mutation lock cannot activate an account',async()=>{
  const a=await paidApplication(),proof=await registrationProof(a),blocker=await pg.finance.connect();
  let pending:ReturnType<Browser['post']>|undefined;
  try{
    await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(92042)');
    pending=a.b.post('/access/register',registrationBody(a.invitationToken,proof));
    let waiting=false;
    for(let i=0;i<100;i++){
      waiting=Boolean((await pg.owner.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")).rowCount);
      if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'Registration is waiting after BEGIN');
    // This deadline is later than transaction start but earlier than lock release.
    await pg.owner.query('UPDATE access.registration_proof SET expires_at=clock_timestamp()');
    await blocker.query('COMMIT');
    const result=await pending;assert.equal(result.statusCode,400);assert.equal(result.json().code,'INVALID_REGISTRATION_PROOF');
    assert.equal((await pg.owner.query('SELECT * FROM identity.auth_user')).rowCount,0);
    assert.equal((await pg.owner.query('SELECT state FROM commerce.purchase')).rows[0].state,'paid_not_activated');
  }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
});

async function registeredUser(){
 const a=await paidApplication(),proof=await registrationProof(a);
 assert.equal((await a.b.post('/access/register',registrationBody(a.invitationToken,proof))).statusCode,201);
 assert.equal((await a.b.post('/auth/sign-in/email',{email:'visitor@example.test',password:testPassword})).statusCode,200);
 const user=(await pg.owner.query('SELECT id FROM identity.auth_user')).rows[0];return {...a,userId:user.id};
}
async function renewal(a:Awaited<ReturnType<typeof registeredUser>>,claim=true){
 const created=await a.b.post('/access/renewal-create',{tariffId:tariff.id});assert.equal(created.statusCode,200);let row=created.json().request;
 if(claim){const r=await a.b.post('/access/renewal-claim',{requestId:row.id,expectedRevision:row.revision,senderName:'Synthetic renewal sender',senderBank:'Synthetic renewal bank'});assert.equal(r.statusCode,200);row=r.json().request;}
 return row;
}
async function renewalCommand(a:Awaited<ReturnType<typeof registeredUser>>,row:Parameters<typeof reviewCommand>[0],overrides:Record<string,unknown>={}){
 const {inviteHours,...base}=reviewCommand(row),cmd={...base,...overrides};
 const preview=await a.admin.b.post('/control/renewal-preview',cmd);assert.equal(preview.statusCode,200,preview.body);
 return {...cmd,expectedCycleRevision:preview.json().cycleRevision,expectedMode:preview.json().mode};
}
test('renewal requires verified identity, owns rows in API and RLS, and restores no tenant context to the pool',async()=>{
 const a=await registeredUser(),row=await renewal(a,false);
 assert.equal((await userBrowser().get('/access/renewal')).statusCode,401);
 await seedUser('identity','other');await pg.owner.query("INSERT INTO commerce.access_cycle VALUES('other',now(),now()+interval '1 month','Europe/Moscow',0,1,0)");
 const other=userBrowser();assert.equal((await other.post('/auth/sign-in/email',{email:'other@example.test',password:testPassword})).statusCode,200);
 assert.equal((await other.get('/access/renewal')).json().request,null);
 assert.equal((await other.post('/access/renewal-cancel',{requestId:row.id,expectedRevision:row.revision})).statusCode,409);
 assert.equal((await a.b.post('/access/renewal-create',{tariffId:tariff.id,userId:'other'})).statusCode,400);
 assert.equal((await pg.finance.query('SELECT * FROM commerce.access_cycle')).rowCount,0);
 assert.equal((await pg.finance.query('SELECT * FROM commerce.renewal_request')).rowCount,0);
 const db=await pg.finance.connect();try{await db.query('BEGIN');await db.query("SELECT set_config('app.user_id',$1,true)",[a.userId]);assert.equal((await db.query('SELECT * FROM commerce.renewal_request')).rowCount,1);await db.query('COMMIT');assert.equal((await db.query('SELECT * FROM commerce.renewal_request')).rowCount,0);}finally{db.release();}
 await assert.rejects(pg.finance.query("UPDATE commerce.access_cycle SET access_end=clock_timestamp()+interval '1 year'"),{code:'42501'});
 await assert.rejects(pg.control.query('SELECT * FROM identity.security_state'),{code:'42501'});
});
test('one unfinished renewal survives concurrent creation; only unclaimed revision can change or cancel',async()=>{
 const a=await registeredUser();const results=await Promise.all([a.b.post('/access/renewal-create',{tariffId:tariff.id}),a.b.clone().post('/access/renewal-create',{tariffId:tariff.id})]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
 const row=results.find(r=>r.statusCode===200)!.json().request;
 await pg.owner.query("UPDATE access.tariff SET snapshot=jsonb_set(snapshot,'{priceMinor}','129000')");
 assert.equal((await a.b.get('/access/renewal')).json().request.tariff.priceMinor,'119000');
 assert.equal((await a.b.get('/access/renewal')).json().tariffs.length,0,'Invalid money must not reach the tariff UI');
 assert.equal((await a.b.post('/access/renewal-change',{requestId:row.id,expectedRevision:row.revision,tariffId:tariff.id})).json().code,'TARIFF_UNAVAILABLE','Reject a numeric JSON money value instead of accepting unsafe float authority');
 await pg.owner.query("UPDATE access.tariff SET snapshot=jsonb_set(jsonb_set(jsonb_set(snapshot,'{priceMinor}',to_jsonb('129000'::text)),'{publicVisible}','false'),'{availableForNew}','false')");
 assert.equal((await a.b.get('/access/tariffs')).json().tariffs.length,0);
 assert.equal((await a.b.get('/access/renewal')).json().tariffs.length,1,'Renewal availability is independent of public/new-user visibility');
 const changed=await a.b.post('/access/renewal-change',{requestId:row.id,expectedRevision:row.revision,tariffId:tariff.id});assert.equal(changed.statusCode,200);assert.equal(changed.json().request.tariff.priceMinor,'129000');
 assert.equal((await a.b.post('/access/renewal-cancel',{requestId:row.id,expectedRevision:row.revision})).statusCode,409);
 assert.equal((await a.b.post('/access/renewal-cancel',{requestId:row.id,expectedRevision:changed.json().request.revision})).json().request.renewalState,'cancelled');
 const next=await renewal(a);assert.notEqual(next.id,row.id);
 for(const action of ['change','cancel'])assert.equal((await a.b.post('/access/renewal-'+action,{requestId:next.id,expectedRevision:next.revision,...(action==='change'?{tariffId:tariff.id}:{})})).json().code,'RENEWAL_FROZEN');
});
test('renewal preview is read-only, commit extends once across concurrent retries and creates no invitation',async()=>{
 const a=await registeredUser(),row=await renewal(a),before=(await a.b.get('/access/renewal')).json().cycle,cmd=await renewalCommand(a,row);
 assert.equal((await pg.owner.query('SELECT * FROM commerce.access_extension')).rowCount,0);assert.deepEqual((await a.b.get('/access/renewal')).json().cycle,before);
 assert.equal((await adminBrowser().post('/control/renewal-review',cmd)).statusCode,401);
 assert.equal((await a.admin.b.post('/control/renewal-review',{...cmd,actorId:'forged'})).statusCode,400);
 const results=await Promise.all([a.admin.b.post('/control/renewal-review',cmd),a.admin.b.clone().post('/control/renewal-review',cmd)]);assert.ok(results.every(r=>r.statusCode===200));assert.deepEqual(results.map(r=>r.json().status).sort(),['already_committed','committed']);
 const own=(await a.b.get('/access/renewal')).json();assert.equal(own.cycle.anchorAt,before.anchorAt);assert.equal(own.cycle.calendarMonths,2);assert.equal(own.request.renewalState,'completed');
 assert.equal((await pg.owner.query('SELECT * FROM commerce.access_extension')).rowCount,1);assert.equal((await pg.owner.query('SELECT * FROM commerce.purchase')).rowCount,1);assert.equal((await pg.owner.query('SELECT * FROM commerce.invitation')).rowCount,1);
 assert.equal((await a.admin.b.post('/control/renewal-review',{...cmd,reason:'changed'})).statusCode,409);
 assert.equal((await a.b.get('/session')).json().accessEnd,own.cycle.accessEnd);
 const another={...cmd,actionId:crypto.randomUUID()};assert.equal((await a.admin.b.post('/control/renewal-review',another)).statusCode,409);
});
test('claim before expiry gives no grace; delayed confirmation starts a new cycle from real confirmation',async()=>{
 const a=await registeredUser(),row=await renewal(a);assert.equal((await a.b.get('/session')).json().scope,'active');
 await pg.owner.query("UPDATE commerce.access_cycle SET anchor_at=clock_timestamp()-interval '1 month',access_end=clock_timestamp()-interval '1 second'");
 assert.equal((await a.b.get('/session')).json().scope,'restricted');const cmd=await renewalCommand(a,row);assert.equal(cmd.expectedMode,'restored');
 const before=Date.now(),r=await a.admin.b.post('/control/renewal-review',cmd);assert.equal(r.statusCode,200);const after=Date.now(),own=(await a.b.get('/access/renewal')).json();
 assert.ok(Date.parse(own.cycle.anchorAt)>=before&&Date.parse(own.cycle.anchorAt)<=after);assert.equal(own.cycle.calendarMonths,1);assert.equal(own.cycle.extraDays,0);assert.equal((await a.b.get('/session')).json().scope,'active');
 assert.equal(r.json().extensions[0].at,own.cycle.anchorAt);
});
test('payment extends paid period of suspended identity without unsuspending or replacing status',async()=>{
 const a=await registeredUser();await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id=$1",[a.userId]);
 const row=await renewal(a),before=(await a.b.get('/access/renewal')).json().cycle.accessEnd,cmd=await renewalCommand(a,row);assert.equal((await a.admin.b.post('/control/renewal-review',cmd)).statusCode,200);
 const s=(await a.b.get('/session')).json();assert.equal(s.scope,'restricted');assert.equal(s.blocked,true);assert.ok(Date.parse(s.accessEnd)>Date.parse(before));assert.ok(!s.capabilities.includes('finance'));
 assert.equal((await pg.owner.query('SELECT status FROM identity.security_state')).rows[0].status,'suspended');
});
test('renewal mismatch and top-up keep snapshot, first claim and separate transfers, with no note leakage',async()=>{
 const a=await registeredUser(),row=await renewal(a);
 const {inviteHours,...bad}=reviewCommand(row);assert.equal((await a.admin.b.post('/control/renewal-preview',{...bad,actualMinor:'60000'})).statusCode,409);
 const first=await renewalCommand(a,row,{actualMinor:'60000',decision:'topup',reason:'Internal synthetic note'});assert.equal((await a.admin.b.post('/control/renewal-review',first)).statusCode,200);
 const pending=(await a.b.get('/access/renewal')).json().request;assert.equal(pending.remainingMinor,'59000');assert.equal(JSON.stringify(pending).includes('Internal synthetic note'),false);assert.equal((await pg.owner.query('SELECT * FROM commerce.access_extension')).rowCount,0);
 const claim=await a.b.post('/access/renewal-claim',{requestId:row.id,expectedRevision:pending.revision,senderName:'Top up sender',senderBank:'Top up bank'});assert.equal(claim.statusCode,200);assert.equal(claim.json().request.claimedAt,row.claimedAt);
 const final=await renewalCommand(a,claim.json().request,{actualMinor:'59000'}),committed=await a.admin.b.post('/control/renewal-review',final);assert.equal(committed.statusCode,200);assert.deepEqual(committed.json().payments.map((p:any)=>p.actualMinor),['60000','59000']);assert.equal(committed.json().extensions.length,1);
 const notice=await mail('access','renewal_decision',cc);assert.equal(JSON.stringify(notice).includes('Internal synthetic note'),false);
});
test('rejected renewal records manual return separately, does not change access, and permits new request',async()=>{
 const a=await registeredUser(),row=await renewal(a),before=(await a.b.get('/access/renewal')).json().cycle;
 const cmd=await renewalCommand(a,row,{actualMinor:'130000',decision:'reject',reason:'Internal rejection reason'});const r=await a.admin.b.post('/control/renewal-review',cmd);assert.equal(r.statusCode,200);assert.equal(r.json().payments[0].disposition,'return_required');assert.equal(r.json().extensions.length,0);
 const own=(await a.b.get('/access/renewal')).json();assert.deepEqual(own.cycle,before);assert.equal(own.request.renewalState,'rejected');assert.equal(JSON.stringify(own).includes('Internal rejection reason'),false);
 assert.equal((await a.b.post('/access/renewal-create',{tariffId:tariff.id})).statusCode,200);
});
test('continuous calendar grid restores 31st after February, preserves time and explicit day offsets',async()=>{
 const db=await pg.owner.connect();try{
 for(const [anchor,firstEnd,nextEnd] of [['2027-01-31T08:15:00.000Z','2027-02-28T08:15:00.000Z','2027-03-31T08:15:00.000Z'],['2028-01-31T08:15:00.000Z','2028-02-29T08:15:00.000Z','2028-03-31T08:15:00.000Z']] as const){
   const cycle={anchorAt:anchor,accessEnd:firstEnd,timezone:'Europe/Moscow',revision:0,calendarMonths:1,extraDays:0};const next=await extensionAt(db,cycle,{kind:'calendar_months',count:1},anchor,'synthetic-request','synthetic-action');assert.equal(next.extension.accessEnd,nextEnd);assert.equal(next.extension.anchorAt,anchor);
   const third=await extensionAt(db,{...cycle,accessEnd:nextEnd,calendarMonths:2},{kind:'calendar_months',count:1},anchor,'r','a');assert.equal(third.extension.accessEnd,anchor.replace('01-31','04-30'));
   const days=await extensionAt(db,cycle,{kind:'days',count:7},anchor,'r','a');assert.equal(Date.parse(days.extension.accessEnd)-Date.parse(firstEnd),7*86400000);assert.equal(days.extension.anchorAt,anchor);
   const monthAfterDays=await extensionAt(db,{...cycle,accessEnd:days.extension.accessEnd,extraDays:7},{kind:'calendar_months',count:1},anchor,'r','a');assert.equal(Date.parse(monthAfterDays.extension.accessEnd)-Date.parse(nextEnd),7*86400000);
 }
 }finally{db.release();}
});
test('outbox failure rolls back extension, payment, revision and action ID atomically',async()=>{
 const a=await registeredUser(),row=await renewal(a),before=(await a.b.get('/access/renewal')).json(),cmd=await renewalCommand(a,row);
 await pg.owner.query('REVOKE INSERT ON access.outbox FROM control_api');try{assert.equal((await a.admin.b.post('/control/renewal-review',cmd)).statusCode,400);}finally{await pg.owner.query('GRANT INSERT ON access.outbox TO control_api');}
 assert.deepEqual((await a.b.get('/access/renewal')).json(),before);assert.equal((await pg.owner.query('SELECT * FROM commerce.action WHERE id=$1',[cmd.actionId])).rowCount,0);assert.equal((await pg.owner.query('SELECT * FROM commerce.access_extension')).rowCount,0);
 assert.equal((await a.admin.b.post('/control/renewal-review',cmd)).statusCode,200);
});
test('expiry while confirmation waits after BEGIN invalidates preview rather than using stale transaction time',async()=>{
 const a=await registeredUser(),row=await renewal(a),cmd=await renewalCommand(a,row),blocker=await pg.control.connect();let pending:ReturnType<Browser['post']>|undefined;
 try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(92041)');pending=a.admin.b.post('/control/renewal-review',cmd);let waiting=false;for(let i=0;i<100;i++){waiting=Boolean((await pg.owner.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")).rowCount);if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(waiting,true);
 await pg.owner.query("UPDATE commerce.access_cycle SET anchor_at=clock_timestamp()-interval '1 month',access_end=clock_timestamp()");await blocker.query('COMMIT');const result=await pending;assert.equal(result.statusCode,409);assert.equal(result.json().code,'PREVIEW_CHANGED');assert.equal((await pg.owner.query('SELECT * FROM commerce.access_extension')).rowCount,0);assert.equal((await pg.owner.query('SELECT * FROM commerce.action WHERE id=$1',[cmd.actionId])).rowCount,0);
 }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
 const fresh=await renewalCommand(a,row);assert.equal(fresh.expectedMode,'restored');assert.equal((await a.admin.b.post('/control/renewal-review',fresh)).statusCode,200);
});
