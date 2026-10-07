import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { postgresFixture } from './postgres.ts';
import { createServer } from '../src/server.ts';
import { hashPassword, envelope, digest, token } from '../src/crypto.ts';
import type { Config } from '../src/types.ts';
import type { FastifyInstance } from 'fastify';

let pg: Awaited<ReturnType<typeof postgresFixture>>;
let finance: Awaited<ReturnType<typeof createServer>>, control: Awaited<ReturnType<typeof createServer>>;
let fc: Config, cc: Config;
const testPassword = 'Synthetic test password 123!';
const tariff = { id: 'development-month', name: 'Synthetic tariff', duration: { kind: 'calendar_months', count: 1 }, priceMinor: '119000', aiQuota: 150, active: true, publicVisible: true, availableForNew: true };
before(async () => {
  pg = await postgresFixture();
  fc = { profile: 'finance', pool: pg.finance, baseURL: 'https://api.example.test', origin: 'https://app.example.test', authSecret: token(), wrappingKey: randomBytes(32), environment: 'test' };
  cc = { profile: 'control', pool: pg.control, baseURL: 'https://control.example.test', origin: 'https://admin.example.test', authSecret: token(), wrappingKey: randomBytes(32), environment: 'test' };
  finance = await createServer(fc); control = await createServer(cc);
});
after(async () => { await finance?.close(); await control?.close(); await pg?.close(); });
beforeEach(async () => {
  await pg.owner.query(`TRUNCATE identity.auth_user,control.auth_user,identity.auth_verification,control.auth_verification,identity.outbox,control.outbox,access.outbox,
    identity.security_event,control.security_event,identity.rate_limit,control.rate_limit,access.rate_limit,access.request,access.tariff,finance.isolation_canary CASCADE`);
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
