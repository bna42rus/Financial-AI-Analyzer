import { Pool } from 'pg';
import { createServer } from './server.ts';
import type { Profile } from './types.ts';
const profile = process.env.API_PROFILE as Profile;
if (!['finance', 'control'].includes(profile)) throw new Error('API_PROFILE must be finance or control');
if (process.env.APP_ENV !== 'development') throw new Error('This server foundation is Development only pending KMS/security acceptance');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const server = await createServer({ profile, pool, baseURL: process.env.API_BASE_URL!, origin: process.env.WEB_ORIGIN!, authSecret: process.env.AUTH_SECRET!,
  wrappingKey: Buffer.from(process.env.WRAPPING_KEY_BASE64 ?? '', 'base64'), environment: 'development' });
await server.app.listen(Number(process.env.PORT ?? (profile === 'control' ? 3001 : 3000)), '127.0.0.1');
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await server.close(); await pool.end(); });
