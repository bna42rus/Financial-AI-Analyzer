import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

/** Dedicated disposable cluster only. CI provisions official PostgreSQL 18 as a service. */
export async function postgresFixture() {
  const connectionString = process.env.SECURITY_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('SECURITY_TEST_DATABASE_URL must point to an isolated PostgreSQL 18 test cluster');
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost'].includes(url.hostname)) throw new Error('Security tests require a local disposable database');
  const operator = new Pool({ connectionString });
  const existing = await operator.query("SELECT 1 FROM pg_roles WHERE rolname IN ('finance_api','control_api','mail_finance','mail_control')");
  if (existing.rowCount) { await operator.end(); throw new Error('Runtime roles already exist: use a fresh isolated test cluster'); }
  const name = 'finance_security_test_' + randomBytes(8).toString('hex');
  await operator.query(`CREATE DATABASE ${name}`); url.pathname = '/' + name;
  const owner = new Pool({ connectionString: url.toString() });
  const migration = await readFile(new URL('../../../packages/database/migrations/0001_access_security.sql', import.meta.url), 'utf8');
  await owner.query(migration);
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0002_invitation_registration.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0003_access_renewal.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0004_manual_access.sql',import.meta.url),'utf8'));
  const mailOwner=await owner.connect();await mailOwner.query('BEGIN');
  try{
    await mailOwner.query(await readFile(new URL('../../../packages/database/migrations/0005_mail_notifications.sql',import.meta.url),'utf8'));
    await (await import('../src/mail-install.ts')).installMailQueues(mailOwner);
    await mailOwner.query('COMMIT');
  }catch(error){await mailOwner.query('ROLLBACK');throw error;}finally{mailOwner.release();}
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0006_finance_foundation.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0007_account_structure_deletion.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0008_category_counterparty_structure.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0009_exclusions_history.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0010_financial_reset.sql',import.meta.url),'utf8'));
  const financePassword = randomBytes(32).toString('hex'), controlPassword = randomBytes(32).toString('hex');
  await owner.query(`ALTER ROLE finance_api LOGIN PASSWORD '${financePassword}'`);
  await owner.query(`ALTER ROLE control_api LOGIN PASSWORD '${controlPassword}'`);
  const connection = { host: url.hostname, port: Number(url.port || 5432), database: name, max: 10 };
  const finance = new Pool({ ...connection, user: 'finance_api', password: financePassword });
  const control = new Pool({ ...connection, user: 'control_api', password: controlPassword });
  const mfPassword=randomBytes(32).toString('hex'),mcPassword=randomBytes(32).toString('hex');
  await owner.query(`ALTER ROLE mail_finance LOGIN PASSWORD '${mfPassword}'`);await owner.query(`ALTER ROLE mail_control LOGIN PASSWORD '${mcPassword}'`);
  const mailFinance=new Pool({...connection,user:'mail_finance',password:mfPassword}),mailControl=new Pool({...connection,user:'mail_control',password:mcPassword});
  return { owner, finance, control,mailFinance,mailControl, async close() {
    await Promise.all([finance.end(), control.end(),mailFinance.end(),mailControl.end(), owner.end()]);
    await operator.query(`DROP DATABASE ${name}`); await operator.query('DROP ROLE finance_api, control_api, mail_finance, mail_control'); await operator.end();
  } };
}
