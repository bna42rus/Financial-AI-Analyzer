import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { hashPassword } from './crypto.ts';

/** Development operator only. Never loaded by an API process or exposed over HTTP. */
if (process.env.APP_ENV !== 'development') throw new Error('Development operator command only');
const url = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Local Development database required');
const pool = new Pool({ connectionString: url.toString() }), db = await pool.connect();
try {
  await db.query('BEGIN');
  const mode = process.argv[2];
  if (mode === 'migrate') {
    const sql = await readFile(new URL('../../../packages/database/migrations/0001_access_security.sql', import.meta.url), 'utf8');
    await db.query(sql);
  } else if(mode==='migrate-invitations') {
    await db.query(await readFile(new URL('../../../packages/database/migrations/0002_invitation_registration.sql',import.meta.url),'utf8'));
  } else if(mode==='migrate-renewal') {
    await db.query(await readFile(new URL('../../../packages/database/migrations/0003_access_renewal.sql',import.meta.url),'utf8'));
  } else if(mode==='migrate-manual') {
    await db.query(await readFile(new URL('../../../packages/database/migrations/0004_manual_access.sql',import.meta.url),'utf8'));
  } else if(mode==='migrate-mail') {
    await db.query(await readFile(new URL('../../../packages/database/migrations/0005_mail_notifications.sql',import.meta.url),'utf8'));
    await (await import('./mail-install.ts')).installMailQueues(db);
  } else if(mode==='migrate-finance') {
    await db.query(await readFile(new URL('../../../packages/database/migrations/0006_finance_foundation.sql',import.meta.url),'utf8'));
  } else if(mode==='migrate-account-structure') {
    await db.query(await readFile(new URL('../../../packages/database/migrations/0007_account_structure_deletion.sql',import.meta.url),'utf8'));
  } else if(mode==='seed-tariff-example') {
    const tariff={id:'development-month',name:'Тестовый месяц',duration:{kind:'calendar_months',count:1},priceMinor:'119000',aiQuota:150,active:true,publicVisible:true,availableForNew:true,availableForRenewal:true};
    await db.query('INSERT INTO access.tariff(id,snapshot) VALUES($1,$2)',[tariff.id,tariff]);
  } else if (mode === 'seed-admin-example') {
    // Only synthetic address and data. Real owner provisioning is a separate verified-email bootstrap flow.
    if ((await db.query('SELECT 1 FROM control.auth_user')).rowCount) throw new Error('Example admin already exists');
    if (!process.stdin.isTTY) throw new Error('Interactive terminal required; passwords must not be command arguments');
    // Hide password entry using an independent readline output writer instead of echoing it to process logs.
    const { Writable } = await import('node:stream');
    const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const prompt = createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write('Choose password for owner@example.test (12–128 characters): ');
    const chosen = await prompt.question(''); prompt.close(); process.stdout.write('\n');
    if (chosen.length < 12 || chosen.length > 128) throw new Error('Password must be 12–128 characters');
    const id = randomUUID();
    await db.query(`INSERT INTO control.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Development example','owner@example.test',true,now(),now())`, [id]);
    await db.query(`INSERT INTO control.auth_account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES($1,$2,'credential',$2,$3,now(),now())`, [randomUUID(), id, await hashPassword(chosen)]);
    await db.query('INSERT INTO control.security_state(user_id,bootstrap_pending) VALUES($1,true)', [id]);
  } else throw new Error('Use migrate, migrate-invitations, migrate-renewal, migrate-manual, migrate-mail, migrate-finance, migrate-account-structure, seed-tariff-example or seed-admin-example');
  await db.query('COMMIT'); process.stdout.write('Development operation completed.\n');
} catch (error) { await db.query('ROLLBACK'); throw new Error('Development operation failed; no changes committed'); }
finally { db.release(); await pool.end(); }
