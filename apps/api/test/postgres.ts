import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

/** Dedicated disposable cluster only. CI provisions official PostgreSQL 18 as a service. */
export async function postgresFixture(options: { name?: 'finance_staging' } = {}) {
  const connectionString = process.env.SECURITY_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('SECURITY_TEST_DATABASE_URL must point to an isolated PostgreSQL 18 test cluster');
  const url = new URL(connectionString);
  if (!['127.0.0.1','localhost'].includes(url.hostname)) throw new Error('Security tests require a local disposable database');
  const operator = new Pool({ connectionString });
  const existing = await operator.query("SELECT 1 FROM pg_roles WHERE rolname IN ('finance_api','control_api','mail_finance','mail_control')");
  if (existing.rowCount) { await operator.end(); throw new Error('Runtime roles already exist: use a fresh isolated test cluster'); }
  const name = options.name ?? 'finance_security_test_' + randomBytes(8).toString('hex');
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
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0011_derived_allocations.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0012_import_ingestion.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0013_bank_contract_alias.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0014_import_cancellation_dedupe.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0015_duplicate_merge.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0016_review_sessions.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0017_import_description_identity.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0018_local_bank_classification.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0019_operations_views.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0020_budgets.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0021_overview_views.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0022_analyzer_foundation.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0023_postbox_acceptance.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0024_yandex_analyzer.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0025_analyzer_cost.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0026_analyzer_tasks.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0027_assistant_runtime.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0028_ai_classification.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0029_bank_description.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0030_marketplace_catalog.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0031_merchant_source.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../../../packages/database/migrations/0032_category_bindings.sql',import.meta.url),'utf8'));
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
