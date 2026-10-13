import { Pool } from 'pg';
import { join } from 'node:path';
import { privateJson } from './kms.ts';
import { stagingDatabase } from './runtime-key.ts';
import { createYandexTransport, yandexSettings, YandexFailure } from './yandex-transport.ts';
import { createYandexAnalyzer } from './yandex-runtime.ts';

export async function loadYandexAnalyzer(environment: string, profile: string, databaseUrl: string) {
  if (process.env.AI_ENABLED === undefined || process.env.AI_ENABLED === '0') return undefined;
  if (process.env.AI_ENABLED !== '1' || environment !== 'staging' || profile !== 'finance' || !process.env.CREDENTIALS_DIRECTORY || process.env.AI_API_KEY || process.env.AI_ENDPOINT)
    throw new YandexFailure('AI_RUNTIME_CONFIGURATION_DENIED');
  stagingDatabase(environment, databaseUrl);
  const settings = yandexSettings(await privateJson(join(process.env.CREDENTIALS_DIRECTORY, 'ai-studio.json')));
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    const role = (await pool.query('SELECT current_user AS role,current_database() AS name')).rows[0];
    if (role.role !== 'finance_api' || role.name !== 'finance_staging') throw new YandexFailure('AI_METADATA_ROLE_DENIED');
    await pool.query('SELECT 1 FROM commerce.analyzer_request LIMIT 0');
    return createYandexAnalyzer(pool, createYandexTransport(settings));
  } catch { await pool.end(); throw new YandexFailure('AI_CONFIGURATION_DENIED'); }
}
