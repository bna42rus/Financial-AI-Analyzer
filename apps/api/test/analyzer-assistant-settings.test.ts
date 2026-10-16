import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { checkAssistantStagingSettings, assistantTariffSource } from '../src/analyzer-assistant-settings.ts';
import { createStagingAssistantProvider } from '../src/analyzer-assistant-provider.ts';
import { assistantRuntimeManifest } from '../src/analyzer-assistant-manifest.ts';
const now=new Date('2026-10-16T16:00:00Z');
const settings=()=>({realm:'staging/finance',apiKey:'synthetic-private-key-1234567890',allowedEmails:['owner@example.test'],sourceSha256:'a'.repeat(64),modelMetadataSha256:'b'.repeat(64),maximumCalls:10,
 admission:{budgetSha256:'c'.repeat(64),spentAtoms:'1000000000',calls:50,stageCapAtoms:'10000000000',stageMaximumCalls:60},
 expiresAt:'2026-10-17T15:00:00Z',tariffCheckedAt:'2026-10-16T15:00:00Z',tariffSource:assistantTariffSource,
 cost:{projectId:'test/staging-settings',projectPeriodStart:'2026-10-16T15:00:00Z',projectPeriodEnd:'2026-10-17T15:00:00Z',projectLimitRub:'9',price:{version:'test',currency:'RUB',inputRubPerMillion:'15.86',outputRubPerMillion:'61'}}});
test('staging settings preserve remaining calls and exact integer cost after previous spend',()=>{
 assert.equal(checkAssistantStagingSettings(settings(),now).maximumCalls,10);
 for(const change of [{maximumCalls:11},{maximumCalls:71},{realm:'production/finance'},{apiKey:'short'},{allowedEmails:[]},{allowedEmails:['OWNER@example.test']},{endpoint:'https://elsewhere.test'},{sourceSha256:'wrong'},{expiresAt:'2026-10-16T15:59:59Z'},{tariffCheckedAt:'2026-10-16T17:00:00Z'}])assert.throws(()=>checkAssistantStagingSettings({...settings(),...change},now));
 const expanded=settings();expanded.cost.projectLimitRub='10';assert.throws(()=>checkAssistantStagingSettings(expanded,now));
 const wrongPrice=settings();wrongPrice.cost.price.inputRubPerMillion='1';assert.throws(()=>checkAssistantStagingSettings(wrongPrice,now));
});
test('wrong release, role or database stops Staging startup before any HTTP',async()=>{
 let http=0;const fetcher=async()=>{http++;throw Error('NO_HTTP');};
 const pool=(role:string,name:string)=>({async query(){return {rows:[{role,name}]};}} as unknown as Pool);
 await assert.rejects(createStagingAssistantProvider(pool('finance_api','finance_staging'),settings(),fetcher,'d'.repeat(64),()=>now),/RELEASE_CHANGED/);
 for(const [role,name] of [['control_api','finance_staging'],['finance_api','finance_production'],['postgres','finance_staging']])await assert.rejects(createStagingAssistantProvider(pool(role!,name!),settings(),fetcher,'a'.repeat(64),()=>now),/DATABASE_DENIED/);
 assert.equal(http,0);
});
test('the release fingerprint closes over the server and its literal dynamic imports without credentials',async()=>{
 const result=await assistantRuntimeManifest();assert.match(result.sourceSha256,/^[a-f0-9]{64}$/);assert.ok(result.files>80);assert.equal(result.paidCalls,0);
});

test('a changed catalog snapshot stops provider construction after a GET and before any completion',async()=>{
 let gets=0,posts=0;
 const pool={async query(sql:string){return {rows:sql.includes('current_user')?[{role:'finance_api',name:'finance_staging'}]:[]};}} as unknown as Pool;
 await assert.rejects(createStagingAssistantProvider(pool,settings(),async(_url,options)=>{if(options?.method==='GET')gets++;else posts++;return new Response(JSON.stringify({data:[{id:'openai/gpt-oss-120b',context_length:131072,max_model_len:131072,revision:'changed'}]}));},'a'.repeat(64),()=>now),/MODEL_CHANGED/);
 assert.equal(gets,1);assert.equal(posts,0);
});
