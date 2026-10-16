import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { configureAssistantStaging, assistantTariffCheckedAt } from '../src/analyzer-assistant-setup.ts';
import { remainingAssistantTrialBudget } from '../src/assistant-budget.ts';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const now=new Date(Date.parse(assistantTariffCheckedAt)+60000);
async function fixture(t:any,unknown=false){
 const dir=await mkdtemp(join(tmpdir(),'assistant-setup-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bound={inputTokens:131072,outputTokens:1200,modelVersion:'openai/gpt-oss-120b'};
 const permit={version:'cashneuro-assistant-budget/2',sourceSha256:'a'.repeat(64),metadataSha256:'b'.repeat(64),tariffCheckedAt:assistantTariffCheckedAt,tariffSource:'https://cloud.ru/products/evolution-ai-factory/catalog-foundation-models',price:{version:'test',currency:'RUB',inputRubPerMillion:'15.86',outputRubPerMillion:'61'},bound,capAtoms:'10000000000',maximumCalls:60};
 const entries=[{requestId:'50000000-0000-4000-8000-000000009000',index:0,bound,...(unknown?{unknown:true}:{usage:{inputTokens:100,outputTokens:50,modelVersion:bound.modelVersion}})}];
 const budget={permit,entries,sha256:hash({permit,entries})},budgetFile=join(dir,'budget.json'),keyFile=join(dir,'key.json'),outputFile=join(dir,'assistant.json');
 await writeFile(budgetFile,JSON.stringify(budget),{mode:0o600});await writeFile(keyFile,JSON.stringify({cloud:{apiKey:'synthetic-api-key-for-tests-only'},yandex:null}),{mode:0o600});
 return {dir,budget,input:{keyFile,budgetFiles:[budgetFile],allowedEmails:['owner@example.test'],outputFile}};
}
test('Staging setup carries prior usage into a private pilot, performs no POST and cannot reset an existing pilot',async t=>{
 const f=await fixture(t),before=await readFile(f.input.budgetFiles[0]!,'utf8');let gets=0;
 const fetcher:typeof fetch=async(url,options)=>{assert.equal(options?.method,'GET');assert.equal(String(url),'https://foundation-models.api.cloud.ru/v1/models');gets++;return new Response(JSON.stringify({data:[{id:'openai/gpt-oss-120b',context_length:131072,max_model_len:131072}]}));};
 const result=await configureAssistantStaging(f.input,fetcher,now),remaining=remainingAssistantTrialBudget(f.budget);
 assert.equal(result.maximumCalls,59);assert.equal(gets,1);assert.equal(result.paidCalls,0);
 const stored=JSON.parse(await readFile(f.input.outputFile,'utf8'));assert.equal(stored.admission.spentAtoms,remaining.spentAtoms);assert.equal(stored.admission.calls,1);assert.equal(stored.admission.budgetSha256,remaining.previousBudgetSha256);assert.equal(stored.apiKey,'synthetic-api-key-for-tests-only');
 assert.equal((await stat(f.input.outputFile)).mode&0o777,0o600);assert.equal(await readFile(f.input.budgetFiles[0]!,'utf8'),before);
 const repeated=await configureAssistantStaging(f.input,fetcher,now);assert.equal(repeated.existing,true);assert.equal(gets,1);assert.equal(repeated.maximumCalls,59);
 await assert.rejects(configureAssistantStaging({...f.input,allowedEmails:['different@example.test']},fetcher,now),/EXISTING_PILOT_CHANGED/);assert.equal(gets,1);
});
test('unknown usage, writable output directories and expired quotes stop setup before catalog HTTP or key output',async t=>{
 let gets=0;const fetcher:typeof fetch=async()=>{gets++;throw Error('NO_HTTP');};
 const f=await fixture(t,true);await assert.rejects(configureAssistantStaging(f.input,fetcher,now),/RECONCILIATION_REQUIRED/);
 const unsafe=await fixture(t);await chmod(unsafe.dir,0o777);await assert.rejects(configureAssistantStaging(unsafe.input,fetcher,now),/DIRECTORY_INVALID/);
 await assert.rejects(configureAssistantStaging(f.input,fetcher,new Date(Date.parse(assistantTariffCheckedAt)+86400001)),/TARIFF_STALE/);assert.equal(gets,0);
});
