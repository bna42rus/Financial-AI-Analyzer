import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { createServer } from './server.ts';
import type { Profile } from './types.ts';
import { runtimeKey, stagingDatabase } from './runtime-key.ts';
import { loadAssistantProvider } from './analyzer-assistant-config.ts';
import { testYooKassa } from './yookassa-topups.ts';
import {createAccessPaymentProvider} from './access-payment-provider.ts';
import {runAutoRenewals} from './access-checkout.ts';
import {envelope} from './crypto.ts';
import { loadYandexAnalyzer } from './yandex-config.ts';
const profile = process.env.API_PROFILE as Profile;
if (!['finance', 'control'].includes(profile)) throw new Error('API_PROFILE must be finance or control');
const environment = process.env.APP_ENV;
if (environment !== 'development' && environment !== 'staging') throw new Error('Production requires security and release acceptance');
stagingDatabase(environment, process.env.DATABASE_URL);
const key = await runtimeKey(environment, profile, process.env.WRAPPING_KEY_BASE64, 'base64');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
if (process.env.ASSISTANT_ENABLED === '1' && process.env.AI_ENABLED === '1') throw new Error('ASSISTANT_STAGING_CONFIGURATION_DENIED');
const yandexAnalyzer = await loadYandexAnalyzer(environment, profile, process.env.DATABASE_URL!);
const assistantProvider = await loadAssistantProvider(environment, profile, process.env.DATABASE_URL!, pool);
if(![undefined,'0','1'].includes(process.env.CLASSIFICATION_ENABLED))throw new Error('CLASSIFICATION_CONFIGURATION_DENIED');
const classificationEnabled=process.env.CLASSIFICATION_ENABLED==='1';
if(classificationEnabled&&!assistantProvider)throw new Error('CLASSIFICATION_PROVIDER_REQUIRED');
const testPayments=environment==='staging'&&profile==='finance'&&process.env.YOOKASSA_TEST_ENABLED==='1'
 ?testYooKassa(process.env.YOOKASSA_TEST_SHOP_ID??'',process.env.YOOKASSA_TEST_SECRET??'',process.env.WEB_ORIGIN!):undefined;
const accessPayments=environment==='staging'&&profile==='finance'&&process.env.YOOKASSA_ACCESS_TEST_ENABLED==='1'
 ?createAccessPaymentProvider({shopId:process.env.YOOKASSA_TEST_SHOP_ID??'',secret:process.env.YOOKASSA_TEST_SECRET??'',origin:process.env.WEB_ORIGIN!,test:true}):undefined;
const server = await createServer({ profile, pool, baseURL: process.env.API_BASE_URL!, origin: process.env.WEB_ORIGIN!, authSecret: process.env.AUTH_SECRET!,
  wrappingKey: key.bytes, kmsKey: key.kmsKey, environment, yandexAnalyzer, assistantProvider, classificationEnabled,testPayments,accessPayments,launchLegal:process.env.CASHNEURO_LEGAL_REQUIRED==='1' });
await server.app.listen(Number(process.env.PORT ?? (profile === 'control' ? 3001 : 3000)), '127.0.0.1');
const classification=classificationEnabled?await import('./classification-store.ts'):undefined;
let stopping=false;
const classificationLoop=classificationEnabled?(async()=>{while(!stopping){try{await classification!.runClassificationStage(pool,assistantProvider!);}catch{/* No financial or provider text in logs. */}if(!stopping)await setTimeout(1000);}})():Promise.resolve();
const paymentSeal=accessPayments?envelope(key.bytes):undefined;
const billingLoop=accessPayments&&paymentSeal?(async()=>{while(!stopping){try{await runAutoRenewals(pool,accessPayments,paymentSeal);}catch{/* Reconcile via durable checkout state, never log payment credentials. */}if(!stopping)await setTimeout(5000);}})():Promise.resolve();
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { try { stopping=true; await server.close(); await Promise.all([classificationLoop,billingLoop]); await pool.end(); await yandexAnalyzer?.pool.end(); } finally { key.destroy(); } });
