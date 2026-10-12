import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

// Explicit additive migration. This entry point cannot target the Production port.
if (process.env.APP_ENV !== 'staging') throw new Error('STAGING_OPERATOR_REQUIRED');
const url = new URL(process.env.SERVICE_MIGRATION_DATABASE_URL ?? '');
if (!['127.0.0.1','localhost'].includes(url.hostname) || url.port !== '5411') throw new Error('STAGING_DATABASE_REQUIRED');
const pool = new Pool({ connectionString: url.toString(), max: 1 }), db = await pool.connect();
try {
  await db.query('BEGIN');
  const role = (await db.query('SELECT current_user AS name')).rows[0].name;
  if (['finance_api','control_api','mail_finance','mail_control'].includes(role)) throw new Error();
  await db.query(await readFile(new URL('../../../packages/database/migrations/0023_postbox_acceptance.sql',import.meta.url),'utf8'));
  await db.query('COMMIT'); console.log('Staging: Postbox migration completed.');
} catch { await db.query('ROLLBACK'); console.error('STAGING_MIGRATION_FAILED: no changes committed.'); process.exitCode=1; }
finally { db.release(); await pool.end(); }
