import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import { postgresFixture } from './postgres.ts';
import { beginOwnerBootstrap, completeOwnerBootstrap } from '../src/owner-bootstrap.ts';
import type { OwnerBootstrapConfig } from '../src/owner-bootstrap.ts';
import { envelope, verifyPassword } from '../src/crypto.ts';
import { deliverBatch, sandboxTransport } from '../src/mail-worker.ts';
import { createServer } from '../src/server.ts';

describe('first staging owner: real operator/queue/email proof and existing TOTP authorization', { concurrency: false }, () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  const key = randomBytes(32), seal = envelope(key), address = 'owner@example.test';
  const chosen = 'Synthetic-owner-password-2026';
  const config: OwnerBootstrapConfig = { environment: 'test', wrappingKey: key, allowedEmails: [address, 'other@example.test'] };
  before(async () => { fixture = await postgresFixture(); });
  beforeEach(async () => {
    await fixture.owner.query(`TRUNCATE control.auth_user,control.auth_account,control.auth_session,control.auth_two_factor CASCADE;
      TRUNCATE control.auth_verification,control.outbox,control.security_event,control.rate_limit,mail.sandbox_inbox;`);
  });
  after(async () => { await fixture?.close(); });
  async function owner<T>(action: (db: PoolClient) => Promise<T>) {
    const db = await fixture.owner.connect(); try { return await action(db); } finally { db.release(); }
  }
  async function begin() {
    assert.deepEqual(await owner(db => beginOwnerBootstrap(db, config, { email: address, name: 'Synthetic Staging owner' })), { status: 'email_queued' });
    const row = (await fixture.owner.query('SELECT * FROM control.outbox ORDER BY created_at DESC LIMIT 1')).rows[0];
    const message = JSON.parse(seal.open(row.sealed_payload));
    return { row, code: message.code as string };
  }
  const complete = (code: string, email = address, password = chosen) => owner(db => completeOwnerBootstrap(db, config, { email, code, password }));
  async function noOwner() { assert.equal((await fixture.owner.query('SELECT count(*)::int AS n FROM control.auth_user')).rows[0].n, 0); }

  test('begin stores only a purpose-bound verifier, queues encrypted Control mail and creates no account/session', async () => {
    const { row, code } = await begin();
    assert.equal(row.source_scope, 'control'); assert.equal(row.kind, 'owner_email_verification');
    assert.match(code, /^[A-Za-z0-9_-]{43}$/); assert.ok(!row.sealed_payload.includes(code));
    assert.ok(row.expires_at > new Date()); assert.ok(row.expires_at.getTime() < Date.now() + 16 * 60000);
    const proof = (await fixture.owner.query('SELECT value FROM control.auth_verification')).rows[0].value;
    assert.ok(!proof.includes(code)); await noOwner();
    assert.equal((await fixture.owner.query('SELECT count(*)::int AS n FROM control.auth_session')).rows[0].n, 0);
    await assert.rejects(begin(), /OWNER_CHALLENGE_ACTIVE/);
    assert.equal((await fixture.owner.query('SELECT count(*)::int AS n FROM control.outbox')).rows[0].n, 1);
  });
  test('real scoped Control worker delivers the code; Finance worker cannot process the owner proof', async () => {
    const { row, code } = await begin();
    const mail = { profile: 'control' as const, pool: fixture.mailControl, wrappingKey: key, environment: 'test' as const,
      financeOrigin: 'https://test.cashneuro.ru', controlOrigin: 'https://admin.test.cashneuro.ru', adminRecipient: address };
    const financeMail = { ...mail, profile: 'finance' as const, pool: fixture.mailFinance };
    assert.equal((await deliverBatch(financeMail, sandboxTransport(financeMail))).processed, 0);
    assert.equal((await deliverBatch(mail, sandboxTransport(mail))).processed, 1);
    const inbox = (await fixture.owner.query('SELECT sealed_message FROM mail.sandbox_inbox WHERE id=$1', [row.id])).rows[0];
    const message = JSON.parse(seal.open(inbox.sealed_message));
    assert.equal(message.to, address); assert.ok(message.text.includes(code)); assert.match(message.subject, /первого администратора Staging/);
  });
  test('wrong code attempts survive rollback and five attempts lock even the correct code', async () => {
    const { code } = await begin();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await assert.rejects(complete('wrong'), /OWNER_PROOF_INVALID/);
      const value = JSON.parse((await fixture.owner.query('SELECT value FROM control.auth_verification')).rows[0].value);
      assert.equal(value.failures, attempt); await noOwner();
    }
    await assert.rejects(complete(code), /OWNER_PROOF_INVALID/); await noOwner();
  });
  test('code cannot transfer ownership to another allowed address', async () => {
    const { code } = await begin();
    await assert.rejects(complete(code, 'other@example.test'), /OWNER_PROOF_INVALID/); await noOwner();
    assert.deepEqual(await complete(code), { status: 'totp_enrollment_required' });
    assert.equal((await fixture.owner.query('SELECT email FROM control.auth_user')).rows[0].email, address);
  });
  test('expired or absent proof creates no owner; invalid password does not consume valid proof', async () => {
    await assert.rejects(complete('A'.repeat(43)), /OWNER_PROOF_INVALID/);
    const { code } = await begin();
    await assert.rejects(complete(code, address, 'short')); await noOwner();
    assert.equal(JSON.parse((await fixture.owner.query('SELECT value FROM control.auth_verification')).rows[0].value).failures, 0);
    await fixture.owner.query("UPDATE control.auth_verification SET expires_at=clock_timestamp()-interval '1 second'");
    await assert.rejects(complete(code), /OWNER_PROOF_INVALID/); await noOwner();
  });
  test('reissuing an expired proof invalidates old queued code and binds the new challenge', async () => {
    const old = await begin();
    await fixture.owner.query("UPDATE control.auth_verification SET expires_at=clock_timestamp()-interval '1 second'");
    const next = await begin(); assert.notEqual(next.code, old.code);
    assert.equal((await fixture.owner.query('SELECT state,last_error FROM control.outbox WHERE id=$1', [old.row.id])).rows[0].last_error, 'STALE');
    await assert.rejects(complete(old.code), /OWNER_PROOF_INVALID/); await noOwner();
    await complete(next.code);
  });
  test('runtime roles and non-genuine Staging KMS cannot provision an owner', async () => {
    for (const pool of [fixture.finance, fixture.control, fixture.mailFinance, fixture.mailControl]) {
      const db = await pool.connect();
      try { await assert.rejects(beginOwnerBootstrap(db, config, { email: address, name: 'Synthetic owner' }), /OWNER_OPERATOR_REQUIRED/); }
      finally { db.release(); }
    }
    await assert.rejects(owner(db => beginOwnerBootstrap(db, { ...config, environment: 'staging' }, { email: address, name: 'Synthetic owner' })), /OWNER_CONFIGURATION_DENIED/);
    await assert.rejects(owner(db => beginOwnerBootstrap(db, config, { email: 'unlisted@example.test', name: 'Synthetic owner' })), /OWNER_RECIPIENT_DENIED/);
    await noOwner();
  });
  test('parallel completions create exactly one owner, hash the chosen password, consume proof and grant no session', async () => {
    const { code } = await begin();
    const outcomes = await Promise.allSettled([complete(code), complete(code)]);
    assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(o => o.status === 'rejected').length, 1);
    const row = (await fixture.owner.query(`SELECT u.email,u.email_verified,u.two_factor_enabled,a.password,s.bootstrap_pending
      FROM control.auth_user u JOIN control.auth_account a ON a.user_id=u.id JOIN control.security_state s ON s.user_id=u.id`)).rows[0];
    assert.equal(row.email, address); assert.equal(row.email_verified, true); assert.equal(row.two_factor_enabled, false); assert.equal(row.bootstrap_pending, true);
    assert.notEqual(row.password, chosen); assert.ok(await verifyPassword(chosen, row.password));
    assert.equal((await fixture.owner.query('SELECT count(*)::int AS n FROM control.auth_user')).rows[0].n, 1);
    assert.equal((await fixture.owner.query('SELECT count(*)::int AS n FROM control.auth_verification')).rows[0].n, 0);
    assert.equal((await fixture.owner.query('SELECT count(*)::int AS n FROM control.session_proof')).rows[0].n, 0);
    await assert.rejects(complete(code), /OWNER_ALREADY_EXISTS/);
    await assert.rejects(begin(), /OWNER_ALREADY_EXISTS/);
  });
  test('new owner must enroll verified TOTP before reading admin data; public owner setup remains closed', async () => {
    const { code } = await begin(); await complete(code);
    const origin = 'http://127.0.0.1:49101';
    const server = await createServer({ profile: 'control', pool: fixture.control, baseURL: origin, origin,
      authSecret: 'synthetic-independent-owner-control-secret', wrappingKey: key, environment: 'test' });
    const cookie = (headers: Record<string, unknown>) => {
      const value = headers['set-cookie']; const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      return list.map(s => String(s).split(';')[0]).join('; ');
    };
    try {
      const publicSetup = await server.app.inject({ method: 'POST', url: '/control/owner-bootstrap', headers: { origin }, payload: {} });
      assert.equal(publicSetup.statusCode, 404);
      const login = await server.app.inject({ method: 'POST', url: '/auth/sign-in/email', headers: { origin }, payload: { email: address, password: chosen } });
      assert.equal(login.statusCode, 200, login.body); let sessionCookie = cookie(login.headers);
      const scope = await server.app.inject({ method: 'GET', url: '/session', headers: { cookie: sessionCookie } });
      assert.equal(scope.json().scope, 'enrollment');
      assert.equal((await server.app.inject({ method: 'GET', url: '/control/requests', headers: { cookie: sessionCookie } })).statusCode, 403);
      const enabled = await server.app.inject({ method: 'POST', url: '/auth/two-factor/enable', headers: { origin, cookie: sessionCookie }, payload: { password: chosen } });
      assert.equal(enabled.statusCode, 200, enabled.body);
      const secret = new URL(enabled.json().totpURI).searchParams.get('secret')!;
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
      for (const char of secret.toUpperCase().replace(/=/g, '')) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
      const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map(b => parseInt(b, 2)));
      const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
      const hash = createHmac('sha1', bytes).update(counter).digest(), offset = hash[hash.length - 1]! & 15;
      const totp = ((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
      const verified = await server.app.inject({ method: 'POST', url: '/auth/two-factor/verify-totp', headers: { origin, cookie: sessionCookie }, payload: { code: totp } });
      assert.equal(verified.statusCode, 200, verified.body); assert.equal(verified.json().recoveryCodes.length, 8);
      sessionCookie = cookie(verified.headers) || sessionCookie;
      assert.equal((await server.app.inject({ method: 'GET', url: '/session', headers: { cookie: sessionCookie } })).json().scope, 'admin');
      assert.equal((await server.app.inject({ method: 'GET', url: '/control/requests', headers: { cookie: sessionCookie } })).statusCode, 200);
    } finally { await server.close(); }
  });
});
