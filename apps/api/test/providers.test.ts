import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, constants, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, chmod, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kmsClient, kmsRealms, privateJson, isKmsKey, unlockKmsKey, initializeKmsKey } from '../src/kms.ts';
import { postboxTransport, smtpBridge } from '../src/postbox.ts';
import { createServer } from '../src/server.ts';
import { assertMailRole, DeliveryFailure } from '../src/mail-worker.ts';
import { runtimeKey, stagingDatabase } from '../src/runtime-key.ts';
import { envelope } from '../src/crypto.ts';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const realm = 'staging/finance' as const;
const identity = { id: 'synthetic-key-id', service_account_id: kmsRealms[realm].accountId,
  private_key: 'PLEASE DO NOT REMOVE THIS LINE\n' + rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('KMS signs PS256, uses exact hosts, binds AAD/realm/version and shares token refresh', async () => {
  let iamCalls = 0, encrypted = ''; const plaintext = randomBytes(32);
  const request: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body));
    if (String(url).includes('/iam/v1/tokens')) {
      iamCalls++; const parts = body.jwt.split('.');
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      assert.equal(header.alg, 'PS256'); assert.equal(header.kid, identity.id);
      assert.equal(claims.iss, identity.service_account_id);
      assert.equal(claims.aud, 'https://iam.api.cloud.yandex.net/iam/v1/tokens');
      assert.equal(claims.exp - claims.iat, 600);
      assert.ok(verify('sha256', Buffer.from(parts[0]+'.'+parts[1]), { key: rsa.publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(parts[2], 'base64url')));
      return json({ iamToken: 'synthetic-token', expiresAt: new Date(Date.now()+3600000).toISOString() });
    }
    assert.match(String(url), /^https:\/\/kms\.yandex\/kms\/v1\/keys\/abjfcob2h16qkbulqnpe:(encrypt|decrypt)$/);
    assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer synthetic-token');
    assert.equal(Buffer.from(body.aadContext, 'base64').toString(), 'cashneuro/runtime-wrapping/v1/'+realm);
    if (String(url).endsWith(':encrypt')) { assert.equal(body.plaintext, plaintext.toString('base64')); encrypted ||= randomBytes(64).toString('base64');
      return json({ keyId: kmsRealms[realm].keyId, versionId: 'version-1', ciphertext: encrypted }); }
    assert.equal(body.ciphertext, encrypted);
    return json({ keyId: kmsRealms[realm].keyId, versionId: 'version-1', plaintext: plaintext.toString('base64') });
  };
  const client = kmsClient(realm, identity, request);
  const [first] = await Promise.all([client.wrap(plaintext), client.wrap(plaintext)]);
  assert.equal(iamCalls, 1); assert.deepEqual(await client.unwrap(first!), plaintext);
  await assert.rejects(client.unwrap({ ...first, realm: 'staging/control' }), /KMS_UNAVAILABLE/);
  await assert.rejects(client.unwrap({ ...first, keyId: 'other' }), /KMS_UNAVAILABLE/);
  await assert.rejects(client.unwrap({ ...first, versionId: 'other' }), /KMS_UNAVAILABLE/);
  assert.throws(() => kmsClient(realm, { ...identity, service_account_id: 'other' }, request), /KMS_IDENTITY_DENIED/);
});

test('KMS permission/network/malformed failures are sanitized and never fall back', async () => {
  const variants: typeof fetch[] = [async () => json({ error: 'SECRET' }, 403),
    async () => { throw new Error('SECRET'); }, async () => new Response('SECRET'),
    async () => json({ iamToken: 'SECRET', expiresAt: 'bad' })];
  for (const request of variants) await assert.rejects(kmsClient(realm, identity, request).wrap(randomBytes(32)), { message: 'KMS_UNAVAILABLE' });
  const request: typeof fetch = async url => String(url).includes('/iam/') ?
    json({ iamToken: 'synthetic-token', expiresAt: new Date(Date.now()+3600000).toISOString() }) :
    json({ keyId: kmsRealms[realm].keyId, versionId: 'v1', plaintext: Buffer.alloc(31).toString('base64') });
  await assert.rejects(kmsClient(realm, identity, request).unwrap({v:1,realm,keyId:kmsRealms[realm].keyId,versionId:'v1',ciphertext:'YQ=='}), /KMS_UNAVAILABLE/);
});

test('private credentials reject exposed files/symlinks; initialization persists only ciphertext and never overwrites', async t => {
  const dir = await mkdtemp(join(tmpdir(),'cashneuro-kms-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const auth = join(dir,'authorized.json'), wrapped = join(dir,'wrapped.json');
  await writeFile(auth, JSON.stringify(identity), {mode:0o600});
  await chmod(auth,0o644); await assert.rejects(privateJson(auth), /PRIVATE_FILE_REQUIRED/); await chmod(auth,0o600);
  await symlink(auth,join(dir,'symlink')); await assert.rejects(privateJson(join(dir,'symlink')));
  const ciphertext = randomBytes(64).toString('base64'); let bytes: string = '';
  t.mock.method(globalThis,'fetch',async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.includes('/iam/')) return json({iamToken:'synthetic-token',expiresAt:new Date(Date.now()+3600000).toISOString()});
    if (url.endsWith(':encrypt')) { bytes=body.plaintext; return json({keyId:kmsRealms[realm].keyId,versionId:'v1',ciphertext}); }
    return json({keyId:kmsRealms[realm].keyId,versionId:'v1',plaintext:bytes});
  });
  await initializeKmsKey(realm,auth,wrapped);
  const before = await readFile(wrapped,'utf8'); assert.ok(!before.includes(bytes));
  await assert.rejects(initializeKmsKey(realm,auth,wrapped)); assert.equal(await readFile(wrapped,'utf8'),before);
  // The duplicate initialization generated new test data: restore the provider's original plaintext.
  const original = randomBytes(32); bytes=original.toString('base64');
  const key = await unlockKmsKey(realm,auth,wrapped);
  assert.ok(isKmsKey(key,realm,key.bytes)); assert.equal(isKmsKey(key,'staging/control',key.bytes),false);
  const sealer=envelope(key.bytes),sealed=sealer.seal('synthetic'); assert.equal(sealer.open(sealed),'synthetic');
  assert.equal(isKmsKey({...key},realm,key.bytes),false);
  key.destroy(); assert.deepEqual(key.bytes,Buffer.alloc(32)); assert.equal(isKmsKey(key,realm,key.bytes),false);
});

test('Staging/Production cannot start with a local key or forged KMS marker; production gate remains', async () => {
  const config = { profile:'finance' as const, wrappingKey:randomBytes(32), environment:'staging' as const };
  await assert.rejects(createServer(config as never), /Staging requires/);
  await assert.rejects(assertMailRole(config as never), /MAIL_CONFIGURATION_DENIED/);
  await assert.rejects(createServer({...config,environment:'production'} as never), /Production requires/);
  await assert.rejects(runtimeKey('production','finance',undefined,'base64'), /RUNTIME_KEY_CONFIGURATION_DENIED/);
  await assert.rejects(runtimeKey('staging','finance','plaintext-secret','base64'), /RUNTIME_KEY_CONFIGURATION_DENIED/);
  for(const url of ['postgresql://user@127.0.0.1:5412/production','postgresql://user@remote.example:5411/staging','postgresql://user@127.0.0.1:5411/staging?host=remote.example','postgresql://user@127.0.0.1:5411/staging?port=5412','postgresql://user@127.0.0.1:5411/staging#override','invalid']) assert.throws(()=>stagingDatabase('staging',url), /STAGING_DATABASE_REQUIRED/);
  assert.doesNotThrow(()=>stagingDatabase('staging','postgresql://user@127.0.0.1:5411/staging'));
});

const config = { sender:'notifications@cashneuro.ru', username:'synthetic-api-id', password:'synthetic-secret',
  environment:'staging' as const, recipients:['inbox@example.org'] };
const message = { to:'inbox@example.org',subject:'Проверка',text:'Синтетическое письмо' };
const id = '01234567-1234-1234-1234-123456789abc';

test('Postbox enforces test inboxes and blocks header injection before invoking SMTP', async () => {
  let calls=0;
  const transport=postboxTransport(config,async payload => { calls++; assert.equal(payload.username,config.username);
    assert.equal(payload.to,message.to); assert.equal(payload.id,id); return {acceptance:'postbox'}; });
  assert.equal(transport.idempotent,false); assert.deepEqual(await transport.deliver(id,message),{acceptance:'postbox'});
  for(const invalid of [{...message,to:'customer@example.org'},{...message,subject:'a\r\nBcc: victim@example.org'},
    {...message,to:'inbox@example.org\nX'},{...message,text:'x'.repeat(65537)}])
    await assert.rejects(transport.deliver(id,invalid),{message:'REJECTED'});
  assert.equal(calls,1);
  assert.throws(()=>postboxTransport({...config,recipients:[]}),/POSTBOX_CONFIGURATION_DENIED/);
  assert.throws(()=>postboxTransport({...config,environment:'production'} as never),/POSTBOX_CONFIGURATION_DENIED/);
});

test('Postbox retries only explicit transient refusal; unknown SMTP outcome stays unknown', async () => {
  for(const code of ['TEMPORARY','REJECTED','DELIVERY_UNKNOWN','garbage']) {
    const transport=postboxTransport(config,async()=>({error:code}));
    await assert.rejects(transport.deliver(id,message),(error: unknown)=>error instanceof DeliveryFailure &&
      error.code===(code==='garbage'?'DELIVERY_UNKNOWN':code) && error.retryable===(code==='TEMPORARY'));
  }
  // Execute the actual isolated Python bridge with invalid input: no SMTP/network operation.
  assert.deepEqual(await smtpBridge({id:'invalid'}),{error:'REJECTED'});
});

test('Python SMTP bridge tests acceptance, TLS verification, transient refusal and lost DATA reply', () => {
  const result=spawnSync('/usr/bin/python3',['-I',fileURLToPath(new URL('./postbox_smtp_test.py',import.meta.url))],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
