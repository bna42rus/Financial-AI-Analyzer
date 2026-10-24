import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {continuedClassificationSettings,classificationFailure,syntheticClassificationArchive,syntheticClassificationFetch} from '../src/classification-smoke-support.ts';
import {classificationTariffDocumentSha256,verifyClassificationTariff} from '../src/classification-tariff.ts';
const now=new Date('2026-10-24T10:22:00Z');
const tariff={checkedAt:now.toISOString(),documentSha256:classificationTariffDocumentSha256};
const original=()=>({realm:'staging/finance',apiKey:'synthetic-key-for-tests-only',allowedEmails:['owner@example.test'],sourceSha256:'a'.repeat(64),modelMetadataSha256:'b'.repeat(64),
 admission:{budgetSha256:'c'.repeat(64),spentAtoms:'1000000000',calls:46,stageCapAtoms:'10000000000',stageMaximumCalls:60},maximumCalls:14,
 expiresAt:'2026-10-17T13:00:00Z',tariffCheckedAt:'2026-10-16T13:00:00Z',tariffSource:'https://cdn.cloud.ru/docs/legal/tariffs/evolution/current-version/foundation-models.pdf',
 cost:{projectId:'staging/assistant-test',projectPeriodStart:'2026-10-16T14:00:00Z',projectPeriodEnd:'2026-10-17T13:00:00Z',projectLimitRub:'9',price:{version:'test',currency:'RUB',inputRubPerMillion:'15.86',outputRubPerMillion:'61'}}});
const totals=()=>({calls:1,spentAtoms:'40000000',reservedAtoms:'0',blocked:false});
test('expired synthetic continuation carries all prior calls/cost, keeps the stricter original ceiling, and does not mutate active settings',()=>{
 const old=original(),before=structuredClone(old),next=continuedClassificationSettings(old,totals(),'d'.repeat(64),tariff,now);
 assert.deepEqual(old,before);assert.equal(next.apiKey,old.apiKey);assert.deepEqual(next.allowedEmails,old.allowedEmails);assert.equal(next.cost.projectId,old.cost.projectId);
 assert.equal(next.admission.calls,47);assert.equal(next.maximumCalls,13);assert.equal(next.admission.stageMaximumCalls,60);assert.equal(next.admission.stageCapAtoms,'10000000000');
 assert.equal(next.admission.spentAtoms,'1040000000');assert.equal(next.cost.projectLimitRub,'8.960000000');assert.equal(next.cost.projectPeriodStart,now.toISOString());assert.equal(next.expiresAt,'2026-10-24T12:22:00.000Z');
 const later=continuedClassificationSettings(old,{...totals(),calls:3,spentAtoms:'120000000'},'d'.repeat(64),tariff,now);
 assert.equal(later.maximumCalls,11);assert.equal(later.cost.projectLimitRub,'8.880000000');
});
test('unknown holds, blocked provider, exhausted calls/cost, invalid totals and stale tariffs cannot acquire a continuation',()=>{
 for(const change of [{reservedAtoms:'1'},{blocked:true},{calls:14},{spentAtoms:'9000000000'},{calls:-1},{calls:1.1},{spentAtoms:'not-an-integer'}])assert.throws(()=>continuedClassificationSettings(original(),{...totals(),...change},'d'.repeat(64),tariff,now));
 assert.throws(()=>continuedClassificationSettings(original(),totals(),'d'.repeat(64),tariff,new Date('2026-10-26T00:00:00Z')),/TARIFF_VERIFICATION_REQUIRED/);
 const early=new Date('2026-10-17T12:00:00Z');assert.throws(()=>continuedClassificationSettings(original(),totals(),'d'.repeat(64),{...tariff,checkedAt:early.toISOString()},early),/CONTINUATION_NOT_AVAILABLE/);
});
test('a fresh checked document works on later days and stale, future or foreign proofs do not renew the allowance',()=>{
 const later=new Date('2026-11-01T12:00:00Z'),fresh={...tariff,checkedAt:later.toISOString()};
 const value=continuedClassificationSettings(original(),totals(),'d'.repeat(64),fresh,later);
 assert.equal(value.tariffCheckedAt,later.toISOString());assert.equal(value.maximumCalls,13);
 for(const proof of [tariff,{...fresh,documentSha256:'a'.repeat(64)},{...fresh,checkedAt:'invalid'},{...fresh,checkedAt:'2026-11-02T00:00:00Z'}])assert.throws(()=>continuedClassificationSettings(original(),totals(),'d'.repeat(64),proof,later),/TARIFF_VERIFICATION_REQUIRED/);
});
test('tariff preflight makes only a fixed public GET, rejects changed documents and never follows an error into a completion',async()=>{
 let gets=0;
 const fetcher:typeof fetch=async(url,options)=>{gets++;assert.equal(String(url),'https://cdn.cloud.ru/docs/legal/tariffs/evolution/current-version/foundation-models.pdf');assert.equal(options?.method,'GET');assert.equal(options?.redirect,'error');assert.ok(!('authorization' in (options?.headers??{})));return new Response('%PDF-modified');};
 await assert.rejects(verifyClassificationTariff(fetcher),/TARIFF_DOCUMENT_CHANGED/);assert.equal(gets,1);
 await assert.rejects(verifyClassificationTariff(async()=>new Response('private provider text',{status:503})),/TARIFF_UNAVAILABLE/);
 await assert.rejects(verifyClassificationTariff(async()=>{throw Error('private network detail');}),/TARIFF_UNAVAILABLE/);
 await assert.rejects(verifyClassificationTariff(async()=>new Response('%PDF-'+ 'x'.repeat(2097152))),/TARIFF_DOCUMENT_INVALID/);
});
test('safe failure output preserves known transport phase and PostgreSQL code without arbitrary text or stack',()=>{
 assert.deepEqual(classificationFailure({code:'BENCH_RESPONSE_INVALID',responsePhase:'JSON',message:'secret'}),{code:'BENCH_RESPONSE_INVALID',responsePhase:'JSON'});
 assert.deepEqual(classificationFailure({code:'42501',message:'private database details'}),{code:'42501',responsePhase:undefined});
 assert.equal(classificationFailure(new Error('synthetic-secret-do-not-reflect')).code,'CLASSIFICATION_CHECK_FAILED');
});
test('synthetic answer survives schema rejection with private permissions; hidden reasoning and headers are omitted',async t=>{
 const parent=await mkdtemp(join(tmpdir(),'classification-smoke-test-'));t.after(()=>rm(parent,{recursive:true,force:true}));
 const archive=await syntheticClassificationArchive(parent,'synthetic-key-for-tests-only'),input={catalog:[],operations:[{ref:'r1',merchant:'DNS',kind:'purchase',role:'expense'}]};
 const content=JSON.stringify({wrong_decisions:[{ref:'r1',category:'foreign'}]}),hidden='HIDDEN_REASONING_MUST_NOT_BE_ARCHIVED';let posts=0;
 const fetcher=syntheticClassificationFetch(async()=>{posts++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content,reasoning_content:hidden}}],usage:{prompt_tokens:562,completion_tokens:534,total_tokens:1096}}),{headers:{'x-secret':'private'}});},archive.save,()=>({name:'known-merchants',input}));
 const response=await fetcher('https://foundation-models.api.cloud.ru/v1/chat/completions',{method:'POST',body:JSON.stringify({messages:[{role:'system',content:'synthetic'},{role:'user',content:JSON.stringify(input)}]})});
 assert.equal(posts,1);assert.equal((await response.json()).choices[0].message.content,content);
 const file=join(archive.directory,'known-merchants-answer.json'),text=await readFile(file,'utf8');assert.equal(JSON.parse(text).content,content);assert.ok(!text.includes(hidden));assert.ok(!text.includes('x-secret'));
 assert.equal((await stat(archive.directory)).mode&0o777,0o700);assert.equal((await stat(file)).mode&0o777,0o600);
 await assert.rejects(archive.save('secret.json',{text:'synthetic-key-for-tests-only'}),/REDACTION_REQUIRED/);
 assert.deepEqual(await readdir(archive.directory),['known-merchants-answer.json']);
});
test('capture rejects a different request or endpoint before any HTTP and does not retry malformed JSON',async()=>{
 let calls=0;const saved:unknown[]=[];const input={operations:[]},expected=()=>({name:'known-merchants',input});
 const fetcher=syntheticClassificationFetch(async()=>{calls++;return new Response('invalid body');},async(_name,value)=>{saved.push(value);},expected);
 await assert.rejects(fetcher('https://foreign.example',{method:'POST',body:'{}'}),/SYNTHETIC_ONLY/);
 await assert.rejects(fetcher('https://foundation-models.api.cloud.ru/v1/chat/completions',{method:'POST',body:JSON.stringify({messages:[{}, {content:'customer data'}]})}),/SYNTHETIC_ONLY/);assert.equal(calls,0);
 await fetcher('https://foundation-models.api.cloud.ru/v1/chat/completions',{method:'POST',body:JSON.stringify({messages:[{}, {content:JSON.stringify(input)}]})});
 assert.equal(calls,1);assert.deepEqual(saved,[{httpStatus:200,bodyIsJson:false}]);
});

 test('resume appends a new case without overwriting a previous answer',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'classification-resume-'));
 try{const first=await syntheticClassificationArchive(parent,'synthetic-key-not-in-data');await first.save('known-merchants-answer.json',{preserved:true});
 const before=await readFile(join(first.directory,'known-merchants-answer.json'),'utf8');
 const resumed=await syntheticClassificationArchive(parent,'synthetic-key-not-in-data',first.directory);await resumed.save('taxi-without-category-input.json',{newCase:true});
 assert.equal(await readFile(join(first.directory,'known-merchants-answer.json'),'utf8'),before);
 await assert.rejects(resumed.save('known-merchants-answer.json',{rewritten:true}));
 }finally{await rm(parent,{recursive:true,force:true});}
});
