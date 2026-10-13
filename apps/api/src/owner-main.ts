import { Pool } from 'pg';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { privateJson, unlockKmsKey } from './kms.ts';
import type { UnlockedKmsKey } from './kms.ts';
import { beginOwnerBootstrap, completeOwnerBootstrap, OwnerBootstrapError } from './owner-bootstrap.ts';
import { ownerSettings } from './owner-config.ts';

async function hidden(label: string) {
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const prompt = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write(label);
  try { return await prompt.question(''); }
  finally { prompt.close(); process.stdout.write('\n'); }
}
let pool: Pool | undefined, key: UnlockedKmsKey | undefined;
try {
  // Privileged setup is a local root/TTY command. Secrets never come from argv/environment or HTTP.
  if (process.getuid?.() !== 0 || !process.stdin.isTTY || process.argv.length !== 4 ||
    !['begin', 'complete'].includes(process.argv[2] ?? '')) throw new OwnerBootstrapError('OWNER_LOCAL_ROOT_TERMINAL_REQUIRED');
  const settings = ownerSettings(await privateJson(process.argv[3]!));
  key = await unlockKmsKey('staging/control', settings.authorizedKeyPath, settings.wrappingKeyPath);
  const config = { environment: 'staging' as const, wrappingKey: key.bytes, kmsKey: key, allowedEmails: settings.allowedEmails };
  pool = new Pool({ connectionString: settings.databaseUrl, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  const db = await pool.connect();
  try {
    if (process.argv[2] === 'begin') {
      await beginOwnerBootstrap(db, config, { email: settings.ownerEmail, name: 'Владелец Staging' });
      process.stdout.write('Письмо с кодом поставлено в очередь. Код действует 15 минут. Затем выполните owner:complete.\n');
    } else {
      const code = (await hidden('Код из письма подтверждения владельца: ')).trim();
      const password = await hidden('Выберите пароль админки (12–128 символов): ');
      const repeated = await hidden('Повторите пароль админки: ');
      if (password !== repeated) throw new OwnerBootstrapError('OWNER_PASSWORD_MISMATCH');
      await completeOwnerBootstrap(db, config, { email: settings.ownerEmail, code, password });
      process.stdout.write('Первый администратор создан. Войдите в тестовую админку и настройте TOTP; до этого административный доступ закрыт.\n');
    }
  } finally { db.release(); }
} catch (error) {
  const code = error instanceof OwnerBootstrapError ? error.message :
    error instanceof Error && ['KMS_UNAVAILABLE', 'KMS_IDENTITY_DENIED', 'PRIVATE_FILE_REQUIRED'].includes(error.message) ? error.message : 'OWNER_BOOTSTRAP_FAILED';
  process.stderr.write(code + '\n'); process.exitCode = 1;
} finally { await pool?.end(); key?.destroy(); }
