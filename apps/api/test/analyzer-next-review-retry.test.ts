import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {validateFirstReviewRetry,firstReviewRetry} from '../src/analyzer-next-review-retry.ts';
import {assistantRequestFingerprint,assistantWorkflowVersion} from '../src/assistant-workflow.ts';
import {emptyConversation} from '../../../packages/analyzer/src/assistant-conversation.ts';
import {intentVersion} from '../../../packages/analyzer/src/next/intent.ts';
import {scope,catalog,id} from '../../../packages/analyzer/test/fixtures/next-finances.ts';
import {createPilotSuite} from '../src/analyzer-next-pilot-suite.ts';
import {pilotPrompt} from '../../../packages/analyzer/src/next/pilot.ts';
import {understandingPrompt,legacyUnderstandingPrompt} from '../../../packages/analyzer/src/next/understanding.ts';

const suite=createPilotSuite('review',catalog),c=suite.cases[0]!,requestId=id(950),global=suite.global(c);
const env={scope,requestId,question:c.question,date:'2026-11-25',global,dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog};
const request={requestId,scope,question:c.question,global,conversation:emptyConversation(scope),dataRevision:env.dataRevision,timezone:'Europe/Moscow',now:new Date('2026-11-25T12:00:00Z')};
function observed(amount='>=100'){
 return {version:assistantWorkflowVersion,receipt:{fingerprint:assistantRequestFingerprint(request),calls:[{fingerprint:'f'.repeat(64),phase:'understand',state:'received',usage:{modelVersion:'synthetic-model',inputTokens:100,outputTokens:50},value:{relevance:'financial',intent:{version:intentVersion,action:'read',binding:{mode:'new'},parameters:{metric:'expenses',grouping:'category',comparison:null,conditions:[{field:'period',op:'set',expression:'2025-10-01/2025-10-31'},{field:'accounts',op:'set',expression:'Учебный счет'},{field:'amount',op:'set',expression:amount}],options:{}},presentation:{format:'auto',detail:'normal'}}}}]}};
}
test('retry requires the actually rejected first response with known usage and no other received cases',()=>{
 assert.doesNotThrow(()=>validateFirstReviewRetry(observed(),request,env,false));
 for(const amount of ['>100','строго больше 100 рублей'])assert.throws(()=>validateFirstReviewRetry(observed(amount),request,env,false),/PILOT_RETRY_DENIED/);
 assert.throws(()=>validateFirstReviewRetry(observed(),request,env,true),/PILOT_RETRY_DENIED/);
 const unknown=observed();unknown.receipt.calls[0]!.state='unknown';assert.throws(()=>validateFirstReviewRetry(unknown,request,env,false),/PILOT_RETRY_DENIED/);
 const reviewed=observed();reviewed.receipt.calls.push({...reviewed.receipt.calls[0]!,phase:'check_changes'});assert.throws(()=>validateFirstReviewRetry(reviewed,request,env,false),/PILOT_RETRY_DENIED/);
});
test('one durable retry ID preserves the original receipt and cumulative budget IDs; reruns never create another attempt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'next-review-retry-'));await mkdir(join(dir,'journal'),{mode:0o700});
 const ids=[requestId,id(951),id(952),id(953),id(954)],manifest={version:suite.version,caseSignature:suite.caseSignature!,accountBinding:'b'.repeat(64),ids};
 const path=join(dir,'journal',requestId+'.json'),original=JSON.stringify(observed());await writeFile(path,original,{mode:0o600});
 try{
  const first=await firstReviewRetry(dir,manifest,request,env);assert.equal(first.ids.length,5);assert.notEqual(first.ids[0],requestId);assert.deepEqual(first.ids.slice(1),ids.slice(1));assert.deepEqual(first.budgetIds,[...ids,first.ids[0]]);assert.equal(new Set(first.budgetIds).size,6);
  await writeFile(join(dir,'journal',ids[1]+'.json'),'{}',{mode:0o600});assert.deepEqual(await firstReviewRetry(dir,manifest,request,env),first);assert.equal(await readFile(path,'utf8'),original);assert.deepEqual(manifest.ids,ids);
  assert.equal((await stat(join(dir,'review-first-retry.json'))).mode&0o777,0o600);
  const marker=JSON.parse(await readFile(join(dir,'review-first-retry.json'),'utf8'));marker.promptSha256='0'.repeat(64);await writeFile(join(dir,'review-first-retry.json'),JSON.stringify(marker));await assert.rejects(firstReviewRetry(dir,manifest,request,env),/PILOT_RETRY_DENIED/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('runtime literal guidance does not change the frozen legacy pilot prompt',()=>{
 assert.equal(pilotPrompt,legacyUnderstandingPrompt);assert.ok(understandingPrompt.startsWith(pilotPrompt));assert.notEqual(understandingPrompt,pilotPrompt);
 assert.equal(createHash('sha256').update(understandingPrompt).digest('hex'),'de59fbac4e1ebb9bb481293c311950cd694bbe4f17289d976ecef27856ec9847');
 assert.equal(createHash('sha256').update(pilotPrompt).digest('hex'),'1083a42dbf127c6201130cc71dcdc4be21c6f198975524e978b61a4bf0cc386f');
});
