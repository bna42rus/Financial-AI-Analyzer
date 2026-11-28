import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {refreshedReviewEvidence,prepareReviewRefresh,reviewRefreshBudgetIds,seedRefreshedUnderstanding} from '../src/analyzer-next-review-refresh.ts';
import {withAssistantJournal} from '../src/assistant-journal.ts';
import {assistantRequestFingerprint,assistantWorkflowVersion} from '../src/assistant-workflow.ts';
import {nextCallFingerprint} from '../src/analyzer-next-model-call.ts';
import {nextReviewInput,nextReviewVersion,nextReviewPrompt,nextReviewSchema} from '../src/analyzer-next-review.ts';
import {runReviewPilotTurn,reviewPilotCases} from '../src/analyzer-next-review-pilot.ts';
import {createPilotSuite} from '../src/analyzer-next-pilot-suite.ts';
import type {ProviderInput} from '../../../packages/analyzer/src/next/workflow.ts';
import {PrototypeSession,workflowPrototypeVersion,parseUnderstanding} from '../../../packages/analyzer/src/next/workflow.ts';
import {taskProjection} from '../../../packages/analyzer/src/next/tasks.ts';
import {understandingPrompt,understandingSchema} from '../../../packages/analyzer/src/next/understanding.ts';
import {intentVersion} from '../../../packages/analyzer/src/next/intent.ts';
import {emptyConversation} from '../../../packages/analyzer/src/assistant-conversation.ts';
import {scope,catalog,id} from '../../../packages/analyzer/test/fixtures/next-finances.ts';
const usage={modelVersion:'synthetic-model',inputTokens:100,outputTokens:20};
async function fixture(){
 const suite=createPilotSuite('review',catalog),session=new PrototypeSession(scope),start=reviewPilotCases[2]!,c=reviewPilotCases[3]!;
 const env={scope,requestId:id(2100),question:start.question,date:'2026-11-25',global:suite.global(start),dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog};
 const loan={relevance:'financial',intent:{version:intentVersion,action:'calculate',binding:{mode:'new'},parameters:{calculator:'loan',edits:[{field:'principalRubles',op:'set',value:'120000',quote:'120 тысяч рублей'},{field:'annualRatePercent',op:'set',value:'12',quote:'12%'},{field:'months',op:'set',value:24,quote:'два года'}]},presentation:{format:'auto',detail:'normal'}}};
 assert.equal((await session.run(env,{async understand(){return loan;}},{current:()=>env,async authorize(){},async review(){return true;},tools:{async guard(){},async read(){throw Error('No financial read');}}})).status,'completed');
 const environment={...env,requestId:id(2101),question:c.question,global:suite.global(c)},state=session.snapshot();
 const request={requestId:environment.requestId,scope,question:c.question,global:environment.global,conversation:emptyConversation(scope),dataRevision:environment.dataRevision,timezone:'Europe/Moscow',now:new Date('2026-11-25T12:00:00Z')};
 const value={relevance:'financial',intent:{version:intentVersion,action:'read',binding:{mode:'new'},parameters:{metric:'loan_payments',grouping:'time',comparison:null,conditions:[],options:{chart:'line'}},presentation:{format:'auto',detail:'normal'}}};
 const input:ProviderInput={version:workflowPrototypeVersion,question:c.question,date:environment.date,context:taskProjection(state)};
 const raw={version:assistantWorkflowVersion,receipt:{fingerprint:assistantRequestFingerprint(request),calls:[{phase:'understand',state:'received',fingerprint:nextCallFingerprint({phase:'understand',prompt:understandingPrompt,input,schema:understandingSchema}),value,usage},{phase:'check_changes',state:'received',fingerprint:'e'.repeat(64),value:{version:nextReviewVersion,decision:'reject',conditions:[{quote:c.question,covered:false}]},usage}]}};
 const manifest={accountBinding:'b'.repeat(64),caseSignature:suite.caseSignature!,ids:[id(2110),id(2111),id(2112),request.requestId,id(2114)]};
 return {session,c,environment,state,request,value,input,raw,manifest};
}
test('canonical chart interpretation reaches review; unchanged inputs, acceptance, unknown delivery and changed context cannot authorize a refresh',async()=>{
 const h=await fixture(),reply=parseUnderstanding(h.value,h.state,h.c.question),input=nextReviewInput(h.input,reply,h.state,h.environment) as any;
 assert.equal(input.candidate.intent.action,'calculate');assert.equal(input.effect.kind,'loan');assert.equal(input.effect.presentation.format,'chart');assert.equal(input.effect.inputs.length,2);
 assert.ok(refreshedReviewEvidence(h.raw,h.request,h.state,h.environment));
 const unchanged=structuredClone(h.raw);unchanged.receipt.calls[1]!.fingerprint=nextCallFingerprint({phase:'check_changes',protocol:nextReviewVersion,prompt:nextReviewPrompt,input,schema:nextReviewSchema});assert.equal(refreshedReviewEvidence(unchanged,h.request,h.state,h.environment),null);
 for(const mutate of [(r:any)=>r.receipt.calls[1].value.decision='accept',(r:any)=>r.receipt.calls[1].state='unknown',(r:any)=>r.receipt.calls[0].state='unknown']){const r=structuredClone(h.raw);mutate(r);assert.equal(refreshedReviewEvidence(r,h.request,h.state,h.environment),null);}
 assert.throws(()=>refreshedReviewEvidence(h.raw,h.request,h.state,{...h.environment,question:'Другой вопрос'}));
});
test('one durable refresh keeps the original rejection, charges only review, includes both IDs and fully replays after restart',async()=>{
 const h=await fixture(),dir=await mkdtemp(join(tmpdir(),'next-review-refresh-'));await mkdir(join(dir,'journal'),{mode:0o700});
 await writeFile(join(dir,'journal','assistant-version.json'),JSON.stringify({version:assistantWorkflowVersion}),{mode:0o600});
 const file=join(dir,'journal',h.request.requestId+'.json'),original=JSON.stringify(h.raw);await writeFile(file,original,{mode:0o600});
 try{
  const refresh=await prepareReviewRefresh(dir,h.manifest,h.request,h.state,h.environment);assert.ok(refresh);const same=await prepareReviewRefresh(dir,h.manifest,h.request,h.state,h.environment);assert.equal(same!.request.requestId,refresh.request.requestId);
  assert.deepEqual(await reviewRefreshBudgetIds(dir,h.manifest,true),[refresh.request.requestId]);await assert.rejects(reviewRefreshBudgetIds(dir,h.manifest,false),/FLAG_REQUIRED/);
  let reserves=0,posts=0;const accounting={async reserve(requestId:string,index:number){assert.equal(requestId,refresh.request.requestId);assert.equal(index,1);reserves++;},async settle(){}};
  const model={bound:{modelVersion:usage.modelVersion,inputTokens:10000,outputTokens:1000},async complete(call:any,before:()=>Promise<void>){assert.equal(call.phase,'check_changes');assert.equal(call.input.effect.kind,'loan');assert.equal(call.input.candidate.intent.action,'calculate');await before();posts++;return {value:{version:nextReviewVersion,decision:'accept',conditions:[{quote:h.c.question,covered:true}]},usage};}};
  await withAssistantJournal(join(dir,'journal'),refresh.request,accounting,async journal=>{await seedRefreshedUnderstanding(journal,refresh.seed);assert.equal((await runReviewPilotTurn(h.c,h.session,h.environment,model,journal,async()=>{})).matches,true);});
  assert.equal(reserves,1);assert.equal(posts,1);assert.equal(await readFile(file,'utf8'),original);
  await withAssistantJournal(join(dir,'journal'),refresh.request,accounting,async journal=>{await seedRefreshedUnderstanding(journal,refresh.seed);const session=PrototypeSession.fromTrustedCheckpoint(scope,h.state);assert.equal((await runReviewPilotTurn(h.c,session,h.environment,model,journal,async()=>{},'replay_only')).matches,true);});
  assert.equal(reserves,1);assert.equal(posts,1);
  const changed:any=structuredClone(h.raw);changed.receipt.calls[1]!.value.conditions[0]!.covered=true;await writeFile(file,JSON.stringify(changed));await assert.rejects(prepareReviewRefresh(dir,h.manifest,h.request,h.state,h.environment),/REFRESH_DENIED/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
