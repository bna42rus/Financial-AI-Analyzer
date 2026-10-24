import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {classificationSmokeCase,classificationSmokeNames} from '../src/classification-smoke-cases.ts';
import {classificationRuntimeAdmission,validateClassificationEvidence} from '../src/classification-admission.ts';
import {classificationTariffDocumentSha256} from '../src/classification-tariff.ts';
import {checkAssistantStagingSettings} from '../src/analyzer-assistant-settings.ts';

const now=new Date('2026-10-24T10:30:00Z'),tariff={checkedAt:now.toISOString(),documentSha256:classificationTariffDocumentSha256};
const original=()=>({realm:'staging/finance' as const,apiKey:'synthetic-key-for-tests-only',allowedEmails:['owner@example.test'],sourceSha256:'a'.repeat(64),modelMetadataSha256:'b'.repeat(64),
 admission:{budgetSha256:'c'.repeat(64),spentAtoms:'1000000000',calls:46,stageCapAtoms:'10000000000',stageMaximumCalls:60},maximumCalls:14,
 expiresAt:'2026-10-17T13:00:00Z',tariffCheckedAt:'2026-10-16T13:00:00Z',tariffSource:'https://cdn.cloud.ru/docs/legal/tariffs/evolution/current-version/foundation-models.pdf',
 cost:{projectId:'staging/assistant-test',projectPeriodStart:'2026-10-16T14:00:00Z',projectPeriodEnd:'2026-10-17T13:00:00Z',projectLimitRub:'9',price:{version:'test',currency:'RUB' as const,inputRubPerMillion:'15.86',outputRubPerMillion:'61'}}});
test('runtime admission carries every previous paid call, preserves original ceilings, and prepares a valid old-source rollback for 24 hours',()=>{
 const old=original(),before=structuredClone(old),next=classificationRuntimeAdmission(old,{calls:4,spentAtoms:'200000000',reservedAtoms:'0',blocked:false},'d'.repeat(64),tariff,now);
 assert.deepEqual(old,before);assert.equal(next.maximumCalls,10);assert.equal(next.admission.calls,50);assert.equal(next.admission.spentAtoms,'1200000000');assert.equal(next.cost.projectLimitRub,'8.800000000');
 assert.equal(next.cost.projectId,old.cost.projectId);assert.deepEqual(next.allowedEmails,old.allowedEmails);assert.equal(next.apiKey,old.apiKey);assert.equal(next.expiresAt,'2026-10-25T10:30:00.000Z');
 assert.equal(checkAssistantStagingSettings({...next,sourceSha256:old.sourceSha256},now).sourceSha256,old.sourceSha256);
 const afterExpiry=new Date('2026-10-26T10:00:00Z'),later=classificationRuntimeAdmission(next,{calls:2,spentAtoms:'100000000',reservedAtoms:'0',blocked:false},'e'.repeat(64),{...tariff,checkedAt:afterExpiry.toISOString()},afterExpiry);
 assert.equal(later.admission.calls,52);assert.equal(later.maximumCalls,8);assert.equal(later.admission.spentAtoms,'1300000000');
 const unexpired=classificationRuntimeAdmission(next,{calls:1,spentAtoms:'1000',reservedAtoms:'0',blocked:false},'e'.repeat(64),tariff,now);
 assert.deepEqual({...unexpired,sourceSha256:next.sourceSha256},next);
 assert.throws(()=>classificationRuntimeAdmission(old,{calls:1,spentAtoms:'0',reservedAtoms:'1',blocked:false},'d'.repeat(64),tariff,now),/RECONCILIATION_REQUIRED/);
});
async function archive(t:any){
 const directory=await mkdtemp(join(tmpdir(),'classification-admission-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const name of classificationSmokeNames){
  const sample=classificationSmokeCase(name),decisions=sample.plan.groups.map((g,i)=>{
   const id=name==='taxi-without-category'?null:({'DNS':'electronics','Пятёрочка':'food',Ozon:null} as Record<string,string|null>)[g.signal.merchant!];
   return {ref:'r'+(i+1),category:id?sample.plan.catalog[sample.plan.categories.findIndex(c=>c.id===id)]!.ref:null,subcategory:null,confidence:id?95:0};
  });
  const values={input:sample.input,answer:{httpStatus:200,modelMatches:true,finishReason:'stop',role:'assistant',content:JSON.stringify({decisions}),usage:{input:668,output:395,total:1063}},usage:{inputTokens:668,outputTokens:395,modelVersion:'openai/gpt-oss-120b'}};
  for(const [kind,value]of Object.entries(values))await writeFile(join(directory,name+'-'+kind+'.json'),JSON.stringify(value),{mode:0o600});
 }
 return directory;
}
test('two saved cases replay unchanged and must each have a settled, complete paid receipt',async t=>{
 const directory=await archive(t),before=await readFile(join(directory,'known-merchants-answer.json'),'utf8');let receipts=0;
 const result=await validateClassificationEvidence(directory,async(fingerprint,usage,from,through)=>{assert.match(fingerprint,/^[a-f0-9]{64}$/);assert.equal(usage.modelVersion,'openai/gpt-oss-120b');assert.ok(from<=through);receipts++;return true;});
 assert.equal(result.paidCalls,0);assert.equal(result.cases,2);assert.equal(receipts,2);assert.equal(await readFile(join(directory,'known-merchants-answer.json'),'utf8'),before);
 await assert.rejects(validateClassificationEvidence(directory,async()=>false),/LEDGER_REQUIRED/);
});
test('foreign inputs and wrong category meaning cannot be used as deployment evidence even if a ledger callback approves',async t=>{
 const directory=await archive(t),path=join(directory,'known-merchants-input.json'),saved=await readFile(path,'utf8');
 await writeFile(path,JSON.stringify({...JSON.parse(saved),operations:[]}));await assert.rejects(validateClassificationEvidence(directory,async()=>true),/EVIDENCE_CHANGED/);await writeFile(path,saved);
 const answerPath=join(directory,'known-merchants-answer.json'),wire=JSON.parse(await readFile(answerPath,'utf8'));wire.content=JSON.stringify({decisions:classificationSmokeCase('known-merchants').plan.groups.map((_g,i)=>({ref:'r'+(i+1),category:null,subcategory:null,confidence:0}))});
 await writeFile(answerPath,JSON.stringify(wire));await assert.rejects(validateClassificationEvidence(directory,async()=>true),/EVIDENCE_FAILED/);
});
