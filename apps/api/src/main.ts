import { Pool } from 'pg';
import { createServer } from './server.ts';
import type { Profile } from './types.ts';
import { runtimeKey, stagingDatabase } from './runtime-key.ts';
import { loadYandexAnalyzer } from './yandex-config.ts';
const profile = process.env.API_PROFILE as Profile;
if (!['finance', 'control'].includes(profile)) throw new Error('API_PROFILE must be finance or control');
const environment = process.env.APP_ENV;
if (environment !== 'development' && environment !== 'staging') throw new Error('Production requires security and release acceptance');
stagingDatabase(environment, process.env.DATABASE_URL);
const key = await runtimeKey(environment, profile, process.env.WRAPPING_KEY_BASE64, 'base64');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const yandexAnalyzer = await loadYandexAnalyzer(environment, profile, process.env.DATABASE_URL!);
const server = await createServer({ profile, pool, baseURL: process.env.API_BASE_URL!, origin: process.env.WEB_ORIGIN!, authSecret: process.env.AUTH_SECRET!,
  wrappingKey: key.bytes, kmsKey: key.kmsKey, environment, yandexAnalyzer });
await server.app.listen(Number(process.env.PORT ?? (profile === 'control' ? 3001 : 3000)), '127.0.0.1');
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { try { await server.close(); await pool.end(); await yandexAnalyzer?.pool.end(); } finally { key.destroy(); } });
