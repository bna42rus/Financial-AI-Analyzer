import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { envelope, hashPassword, verifyPassword, digest, token } from '../src/crypto.ts';

test('envelope encryption uses a fresh DEK/nonce and rejects tampering/wrong wrapping key', () => {
  const seal=envelope(randomBytes(32)), secret=token(), first=seal.seal(secret), second=seal.seal(secret);
  assert.notEqual(first,second);assert.equal(seal.open(first),secret);assert.ok(!first.includes(secret));
  const modified=JSON.parse(first);const bytes=Buffer.from(modified.data,'base64url');bytes[13]=bytes[13]!^1;modified.data=bytes.toString('base64url');
  assert.throws(()=>seal.open(JSON.stringify(modified)));assert.throws(()=>envelope(randomBytes(32)).open(first));
});
test('Argon2id password verification and token verifiers do not retain plaintext', async () => {
  const chosen=token(), hashed=await hashPassword(chosen);assert.match(hashed,/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await verifyPassword(chosen,hashed),true);assert.equal(await verifyPassword(token(),hashed),false);assert.equal(await verifyPassword(chosen,'invalid hash'),false);
  const secret=token();assert.equal(Buffer.from(secret,'base64url').length,32);assert.equal(digest(secret).length,64);assert.notEqual(digest(secret),secret);
});
