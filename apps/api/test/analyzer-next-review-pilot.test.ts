import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewPilotCases,reviewPilotCandidate,runReviewPilotTurn,reviewPilotVersion,reviewPilotSignature,reviewPilotDiagnostic} from '../src/analyzer-next-review-pilot.ts';
import {createPilotSuite} from '../src/analyzer-next-pilot-suite.ts';
import {nextReviewVersion} from '../src/analyzer-next-review.ts';
import {PrototypeSession} from '../../../packages/analyzer/src/next/workflow.ts';
import {intentVersion} from '../../../packages/analyzer/src/next/intent.ts';
import type {AssistantModel,AssistantJournal,RunReceipt,CompletionInput} from '../src/assistant-workflow.ts';
import {scope,catalog,id} from '../../../packages/analyzer/test/fixtures/next-finances.ts';
import {createCloudAssistantModel} from '../src/assistant-transport.ts';
import {nextCallFingerprint} from '../src/analyzer-next-model-call.ts';
import {workflowPrototypeVersion} from '../../../packages/analyzer/src/next/workflow.ts';
import {taskProjection} from '../../../packages/analyzer/src/next/tasks.ts';
import {understandingPrompt,understandingSchema} from '../../../packages/analyzer/src/next/understanding.ts';

const binding={mode:'continue',conditions:'pin'};
const intent=(action:string,parameters:unknown,bind:unknown={mode:'new'},format='auto')=>({relevance:'financial',intent:{version:intentVersion,action,parameters,binding:bind,presentation:{format,detail:'normal'}}});
const read=(month:string,bind:unknown={mode:'new'},strict=true)=>intent('read',{metric:'expenses',grouping:'category',comparison:null,conditions:[{field:'period',op:'set',expression:month},...(strict?[{field:'amount',op:'set',expression:'строго больше 100 рублей'}]:[])],options:{}},bind);
const loan=()=>intent('calculate',{calculator:'loan',edits:[{field:'principalRubles',op:'set',value:'120000',quote:'120 тысяч рублей'},{field:'annualRatePercent',op:'set',value:'12',quote:'12%'},{field:'months',op:'set',value:24,quote:'два года'}]});
function payload(index:number){return [read('октябрь 2025'),intent('read',{metric:null,grouping:null,comparison:null,conditions:[{field:'period',op:'set',expression:'сентябрь'}],options:{}},binding),loan(),intent('calculate',{calculator:'loan',edits:[{field:'payment',op:'clear'}]},binding,'chart'),read('октябрь 2025')][index]!;}
function harness(receipts=new Map<number,RunReceipt>(),mode:'normal'|'accept-all'|'reject-all'|'ignore-chart'='normal'){
 let posts=0,reserves=0,settlements=0;
 const inputs:unknown[]=[],suite=createPilotSuite('review',catalog),sessions=new Map(reviewPilotCases.map(c=>[c.chain,new PrototypeSession(scope)]));
 async function run(index:number,dispatch:'allow'|'replay_only'='allow'){
  const c=reviewPilotCases[index]!,session=sessions.get(c.chain)!,receipt=receipts.get(index)??{fingerprint:'e'.repeat(64),calls:[]};receipts.set(index,receipt);
  const journal:AssistantJournal={receipt,async persist(){},async reserve(){reserves++;},async settle(){settlements++;}};
  const model:AssistantModel={bound:{modelVersion:'synthetic-review-model',inputTokens:10000,outputTokens:1000},async complete(input,before){
   await before();posts++;inputs.push(structuredClone(input.input));let value:unknown;
   if(input.phase==='understand'){value=payload(index);if(mode==='ignore-chart'&&index===3)(value as any).intent.presentation.format='auto';}
   else{const reject=mode==='reject-all'||mode!=='accept-all'&&index===4;value={version:nextReviewVersion,decision:reject?'reject':'accept',conditions:[{quote:c.question,covered:!reject}]};}
   return {value,usage:{modelVersion:'synthetic-review-model',inputTokens:100,outputTokens:50}};
  }};
  return runReviewPilotTurn(c,session,{scope,requestId:id(800+index),question:c.question,date:'2026-11-25',global:suite.global(c),accessRevision:'synthetic/1',dataRevision:'synthetic/1',catalog},model,journal,async()=>{},dispatch);
 }
 return {run,inputs,receipts,sessions,get posts(){return posts;},get reserves(){return reserves;},get settlements(){return settlements;}};
}
test('five review cases use both real call slots; strict source scope and the negative control have independent acceptance',async()=>{
 const h=harness();for(let i=0;i<reviewPilotCases.length;i++){const r=await h.run(i);assert.equal(r.matches,true,reviewPilotCases[i]!.id+': '+JSON.stringify(r.result));if(i===4){assert.equal(r.result.status,'failed');assert.equal(r.reads,0);assert.equal(r.accepted,false);}}
 assert.equal(h.posts,10);assert.equal(h.reserves,10);assert.equal(h.settlements,10);
 for(const input of h.inputs){const text=JSON.stringify(input);for(const forbidden of ['expected','negativeControl','review-negative',scope.ownerId,scope.chatId,scope.generation])assert.equal(text.includes(forbidden),false);}
 const suite=createPilotSuite('review',catalog);assert.equal(suite.version,reviewPilotVersion);assert.equal(suite.limitRub,'5');assert.equal(suite.caseSignature,reviewPilotSignature);assert.equal(suite.cases.length,5);
});
test('oracle cannot authorize execution: a permissive reviewer executes the controlled wrong scope but the pilot fails',async()=>{
 const h=harness(undefined,'accept-all'),r=await h.run(4);assert.equal(r.accepted,true);assert.equal(r.result.status,'completed');assert.equal(r.reads,1);assert.equal(r.matches,false);
});
test('a reviewer rejection cannot be bypassed by correct numerical expectations; correct totals cannot hide a missing chart',async()=>{
 const rejected=harness(undefined,'reject-all'),r=await rejected.run(0);assert.equal(r.matches,false);assert.equal(r.reads,0);assert.equal(r.result.status,'failed');
 const ignored=harness(undefined,'ignore-chart');assert.equal((await ignored.run(2)).matches,true);const chart=await ignored.run(3);assert.equal(chart.result.status,'completed');assert.equal(chart.matches,false);
});
test('replay after fresh sessions uses all ten saved replies without reserve or model calls; a missing review stays free',async()=>{
 const first=harness();for(let i=0;i<5;i++)assert.equal((await first.run(i)).matches,true);
 const replay=harness(structuredClone(first.receipts));for(let i=0;i<5;i++)assert.equal((await replay.run(i,'replay_only')).matches,true);assert.equal(replay.posts,0);assert.equal(replay.reserves,0);
 const missing=harness(structuredClone(first.receipts));missing.receipts.get(0)!.calls.pop();const r=await missing.run(0,'replay_only');assert.equal(r.matches,false);assert.equal(r.diagnostic,'PILOT_REPLAY_MISSING');assert.equal(missing.posts,0);assert.equal(missing.reserves,0);assert.equal(r.reads,0);
});
test('control substitution is explicit and isolated from other cases and from the saved understanding value',()=>{
 const raw=payload(0),copy=structuredClone(raw);assert.equal(reviewPilotCandidate('review-read-start',raw),raw);const wrong:any=reviewPilotCandidate('review-rejects-lost-filter',raw);assert.deepEqual(raw,copy);assert.equal(wrong.intent.parameters.conditions.length,1);assert.equal(wrong.intent.parameters.conditions[0].field,'period');
 const basic=createPilotSuite('basic',catalog),additional=createPilotSuite('additional',catalog);assert.equal(basic.version,'analyzer-next-pilot/1');assert.equal(basic.cases.length,8);assert.equal(additional.version,'analyzer-next-additional/1');assert.equal(additional.cases.length,25);
});
test('review uses its own closed wire protocol and cannot select it on legacy or classification transports',async()=>{
 let posted=0,system='';const fetcher:typeof fetch=async(_url,options)=>{posted++;system=JSON.parse(String(options?.body)).messages[0].content;throw Error('synthetic transport stop');};
 const request:CompletionInput={phase:'check_changes',protocol:nextReviewVersion,prompt:'Synthetic review',input:{},schema:{type:'object'}};
 const next=createCloudAssistantModel({apiKey:'synthetic-only-key-never-live'},fetcher,'assistant','cashneuro-intent-prototype/1');await assert.rejects(next.complete(request,async()=>{}));assert.equal(posted,1);assert.ok(system.startsWith('Protocol '+nextReviewVersion+'\n'));
 for(const purpose of ['assistant','classification'] as const)await assert.rejects(createCloudAssistantModel({apiKey:'synthetic-only-key-never-live'},fetcher,purpose).complete(request,async()=>{}),/ASSISTANT_TRANSPORT_CHANGED/);
 await assert.rejects(next.complete({...request,phase:'understand'},async()=>{}),/ASSISTANT_TRANSPORT_CHANGED/);assert.equal(posted,1);
});
test('terminal diagnostics expose only schema facts and source-backed missing conditions, never arbitrary response data',()=>{
 const question=reviewPilotCases[0]!.question,d=reviewPilotDiagnostic({version:'private-value',decision:'private-value',conditions:[{quote:'строго больше 100 рублей',covered:false},{quote:'private-value',covered:false}],'private-key':'private-value'},question);
 assert.equal(d.schemaValid,false);assert.equal(d.versionMatches,false);assert.equal(d.invalidEvidenceCount,1);assert.deepEqual(d.uncoveredSourceConditions,['строго больше 100 рублей']);assert.ok(!JSON.stringify(d).includes('private-'));assert.equal(reviewPilotDiagnostic(undefined,question).received,false);
});
test('the second observed reply reuses its received understanding and pays only the missing review; a second replay pays nothing',async()=>{
 const c=reviewPilotCases[0]!,suite=createPilotSuite('review',catalog),env={scope,requestId:id(970),question:c.question,date:'2026-11-25',global:suite.global(c),accessRevision:'synthetic/1',dataRevision:'synthetic/1',catalog};
 const session=new PrototypeSession(scope),understand={phase:'understand' as const,prompt:understandingPrompt,input:{version:workflowPrototypeVersion,question:env.question,date:env.date,context:taskProjection(session.snapshot())},schema:understandingSchema};
 const value=intent('read',{metric:'expenses',grouping:'category',comparison:null,conditions:[{field:'period',op:'set',expression:'за октябрь 2025'},{field:'accounts',op:'set',expression:'со счёта «Учебный счёт»'},{field:'amount',op:'set',expression:'строго больше 100 рублей'}],options:{}});
 let posts=0,reserves=0;const usage={modelVersion:'synthetic-review-model',inputTokens:100,outputTokens:50};
 const receipt:RunReceipt={fingerprint:'e'.repeat(64),calls:[{phase:'understand',state:'received',fingerprint:nextCallFingerprint(understand),value:structuredClone(value),usage}]};
 const original=structuredClone(receipt.calls[0]),journal:AssistantJournal={receipt,async persist(){},async reserve(index){assert.equal(index,1);reserves++;},async settle(){}};
 const model:AssistantModel={bound:{modelVersion:usage.modelVersion,inputTokens:10000,outputTokens:1000},async complete(input,before){assert.equal(input.phase,'check_changes');await before();posts++;return {value:{version:nextReviewVersion,decision:'accept',conditions:[{quote:c.question,covered:true}]},usage};}};
 const checked=await runReviewPilotTurn(c,session,env,model,journal,async()=>{});assert.equal(checked.matches,true);assert.equal(checked.replayed,true);assert.equal(posts,1);assert.equal(reserves,1);assert.equal(checked.reads,1);assert.deepEqual(receipt.calls[0],original);
 model.complete=async()=>{throw Error('No model call on replay');};const replay=await runReviewPilotTurn(c,new PrototypeSession(scope),env,model,journal,async()=>{},'replay_only');assert.equal(replay.matches,true);assert.equal(reserves,1);assert.equal(posts,1);
});
test('the observed month qualifier replays received understanding, preserves the strict scope and calls only its missing reviewer',async()=>{
 const h=harness();assert.equal((await h.run(0)).matches,true);
 const c=reviewPilotCases[1]!,session=h.sessions.get(c.chain)!;
 const value=intent('read',{metric:null,grouping:null,comparison:null,conditions:[{field:'period',op:'set',expression:'сентябрь того же года'}],options:{}},{mode:'continue',conditions:'merge_ui'});
 const call={phase:'understand' as const,prompt:understandingPrompt,input:{version:workflowPrototypeVersion,question:c.question,date:'2026-11-25',context:taskProjection(session.snapshot())},schema:understandingSchema};
 const receipt:RunReceipt={fingerprint:'e'.repeat(64),calls:[{phase:'understand',state:'received',fingerprint:nextCallFingerprint(call),value,usage:{modelVersion:'synthetic-review-model',inputTokens:100,outputTokens:50}}]};
 h.receipts.set(1,receipt);const saved=structuredClone(receipt.calls[0]),before=h.posts;
 const result=await h.run(1);assert.equal(result.matches,true);assert.equal(result.replayed,true);assert.equal(result.accepted,true);assert.equal(result.reads,1);assert.equal(h.posts-before,1);assert.equal(h.reserves,3);assert.deepEqual(receipt.calls[0],saved);
 const state=session.snapshot(),task=state.history.find(t=>t.handle===state.active);if(task?.kind!=='read')throw Error('read');
 assert.equal(task.node.query.filter.from,'2025-09-01');assert.equal(task.node.query.filter.through,'2025-09-30');assert.equal(task.node.query.filter.amountFrom,'10001');assert.deepEqual(task.node.query.filter.accountIds,[catalog.accounts[0]!.id]);
 const replay=harness(structuredClone(h.receipts));assert.equal((await replay.run(0,'replay_only')).matches,true);assert.equal((await replay.run(1,'replay_only')).matches,true);assert.equal(replay.posts,0);assert.equal(replay.reserves,0);
});
