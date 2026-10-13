import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ownerSettings } from '../src/owner-config.ts';
import { renderMail } from '../src/mail-templates.ts';
const good = { environment: 'staging', databaseUrl: 'postgresql://staging_bootstrap_owner:synthetic@127.0.0.1:5411/finance_staging',
  ownerEmail: 'owner@example.test', allowedEmails: ['owner@example.test'],
  authorizedKeyPath: '/etc/cashneuro/kms/staging/control/authorized-key.json',
  wrappingKeyPath: '/etc/cashneuro/kms/staging/control/wrapping-key.json' };
test('owner configuration binds the operator to the exact staging database, identity and key realm', () => {
  assert.equal(ownerSettings(good).ownerEmail, 'owner@example.test');
  for (const change of [
    { environment: 'production' }, { environment: 'development' },
    { databaseUrl: good.databaseUrl.replace('5411', '5412') },
    { databaseUrl: good.databaseUrl.replace('127.0.0.1', 'database.example.test') },
    { databaseUrl: good.databaseUrl.replace('finance_staging', 'finance_production') },
    { databaseUrl: good.databaseUrl.replace('staging_bootstrap_owner', 'control_api') },
    { databaseUrl: good.databaseUrl + '?host=database.example.test' },
    { databaseUrl: good.databaseUrl + '#routing' },
    { databaseUrl: good.databaseUrl.replace(':synthetic@', '@') },
    { ownerEmail: 'other@example.test' }, { allowedEmails: [] },
    { allowedEmails: ['owner@example.test', 'owner@example.test'] },
    { allowedEmails: Array.from({ length: 6 }, (_, i) => `owner${i}@example.test`) },
    { authorizedKeyPath: good.authorizedKeyPath.replace('/control/', '/finance/') },
    { wrappingKeyPath: good.wrappingKeyPath.replace('/staging/', '/production/') },
    { WRAPPING_KEY_BASE64: 'synthetic-plaintext-override' },
  ]) assert.throws(() => ownerSettings({ ...good, ...change }), /OWNER_CONFIGURATION_DENIED/);
});
test('owner proof mail names its exact privileged setup purpose and never pretends to be a login', () => {
  const code = 'S'.repeat(43);
  const message = renderMail('owner_email_verification', { email: 'owner@example.test', profile: 'control', code },
    { financeOrigin: 'https://test.cashneuro.ru', controlOrigin: 'https://admin.test.cashneuro.ru', adminRecipient: 'owner@example.test' }, new Date().toISOString());
  assert.equal(message.to, 'owner@example.test');
  assert.match(message.subject, /первого администратора Staging/);
  assert.match(message.text, /owner:complete/); assert.match(message.text, /15 минут/);
  assert.match(message.text, /TOTP/); assert.match(message.text, /Пароль вы выбираете самостоятельно/);
  assert.ok(message.text.includes(code));
  assert.throws(() => renderMail('owner_email_verification', { email: 'owner@example.test', profile: 'finance', code },
    { financeOrigin: 'https://test.cashneuro.ru', controlOrigin: 'https://admin.test.cashneuro.ru', adminRecipient: 'owner@example.test' }, new Date().toISOString()), /INVALID_PAYLOAD/);
});
test('CLI refuses piped secret/config input and prints no stack, credentials or code', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/owner-main.ts', 'complete', '/does-not-exist.json'],
    { cwd: new URL('..', import.meta.url), input: 'synthetic-secret-code\nsynthetic-password\n', encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'OWNER_LOCAL_ROOT_TERMINAL_REQUIRED');
  assert.equal(result.stdout, '');
  assert.ok(!result.stderr.includes('synthetic-secret-code')); assert.ok(!result.stderr.includes(' at '));
});
