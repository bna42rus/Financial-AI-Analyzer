import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPilotSuite} from '../src/analyzer-next-pilot-suite.ts';
import {runReviewPilotTurn} from '../src/analyzer-next-review-pilot.ts';
import {nextReviewVersion} from '../src/analyzer-next-review.ts';
import {PrototypeSession} from '../../../packages/analyzer/src/next/workflow.ts';
import {scriptedAdditionalReplies} from '../../../packages/analyzer/test/fixtures/next-additional-replies.ts';
import {intentVersion} from '../../../packages/analyzer/src/next/intent.ts';
import {scope,catalog,id} from '../../../packages/analyzer/test/fixtures/next-finances.ts';
import type {AdditionalCase} from '../../../packages/analyzer/src/next/additional-pilot.ts';
import type {AssistantJournal,AssistantModel,RunReceipt} from '../src/assistant-workflow.ts';

const read=(period:string,binding:unknown={mode:'new'},inherit=false)=>({relevance:'financial',intent:{version:intentVersion,action:'read',binding,parameters:{metric:inherit?null:'expenses',grouping:inherit?null:'category',comparison:null,conditions:[{field:'period',op:'set',expression:period},...(!inherit?[{field:'accounts',op:'set',expression:'Учебный счёт'},{field:'amount',op:'set',expression:'строго больше 100 рублей'}]:[])],options:{}},presentation:{format:'auto',detail:'normal'}}});
const loan=(chart=false)=>({relevance:'financial',intent:{version:intentVersion,action:'calculate',binding:chart?{mode:'continue',conditions:'pin'}:{mode:'new'},parameters:{calculator:'loan',edits:chart?[{field:'payment',op:'clear'}]:[{field:'principalRubles',op:'set',value:'120000',quote:'120 тысяч рублей'},{field:'annualRatePercent',op:'set',value:'12',quote:'12%'},{field:'months',op:'set',value:24,quote:'два года'}]},presentation:{format:chart?'chart':'auto',detail:'normal'}}});
const replies:Record<string,unknown>={...scriptedAdditionalReplies,'review-read-start':read('октябрь 2025'),'review-read-month':read('сентябрь того же года',{mode:'continue',conditions:'pin'},true),'review-loan-start':loan(),'review-loan-chart':loan(true),'review-rejects-lost-filter':read('октябрь 2025'),'boundary-unrelated':{relevance:'unrelated',intent:null},'boundary-ambiguous':{relevance:'ambiguous',intent:null}};
async function run(saved=new Map<string,RunReceipt>(),replay=false,overrides:Record<string,unknown>={}){
 const suite=createPilotSuite('acceptance',catalog),sessions=new Map(suite.cases.map(c=>[c.chain,new PrototypeSession(scope)]));let calls=0,reserves=0;
 for(const [index,item]of suite.cases.entries()){
  const c=item as AdditionalCase,session=sessions.get(c.chain)!,receipt=saved.get(c.id)??{fingerprint:'f'.repeat(64),calls:[]};saved.set(c.id,receipt);
  const journal:AssistantJournal={receipt,async persist(){},async reserve(){reserves++;},async settle(){}};
  const model:AssistantModel={bound:{modelVersion:'synthetic-acceptance',inputTokens:20000,outputTokens:2000},async complete(input,before){assert.equal(replay,false);await before();calls++;
   const value=input.phase==='understand'?(overrides[c.id]??replies[c.id]):{version:nextReviewVersion,decision:c.id==='review-rejects-lost-filter'?'reject':'accept',conditions:[{quote:c.question,covered:c.id!=='review-rejects-lost-filter'}]};
   assert.ok(value,c.id);return {value:input.phase==='understand'&&!(value as any).relevance?{relevance:'financial',intent:value}:value,usage:{modelVersion:'synthetic-acceptance',inputTokens:100,outputTokens:50}};}};
  const result=await runReviewPilotTurn(c,session,{scope,requestId:id(2300+index),question:c.question,date:'2026-11-25',global:suite.global(c),dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog},model,journal,async()=>{},replay?'replay_only':'allow');
  assert.equal(result.matches,true,c.id+': '+JSON.stringify(result));assert.equal(receipt.calls.length,2);if(c.id==='review-rejects-lost-filter')assert.equal(result.reads,0);
 }
 return {saved,calls,reserves};
}
test('offline scripted 30-case harness traverses mandatory review and independent oracles; replay dispatches nothing',async()=>{
 const suite=createPilotSuite('acceptance',catalog);assert.equal(suite.cases.length,30);assert.equal(suite.limitRub,'10');assert.equal(new Set(suite.cases.map(c=>c.id)).size,30);assert.notEqual(suite.caseSignature,createPilotSuite('additional',catalog).caseSignature);assert.notEqual(suite.caseSignature,createPilotSuite('review',catalog).caseSignature);
 const first=await run();assert.equal(first.calls,60);assert.equal(first.reserves,60);const replay=await run(structuredClone(first.saved),true);assert.equal(replay.calls,0);assert.equal(replay.reserves,0);
});
test('retained current-comparison selection and named report return cross all 30 cases and replay both calls for free',async()=>{
 const overrides={
  'loan-tied-comparison':{version:intentVersion,action:'compare',binding:{mode:'new'},parameters:{scenarios:['t1_v1','t1_v2','t2_v1','t2_v2','t3_v1','t3_v2'],criterion:'interest',objective:'min'},presentation:{format:'auto',detail:'normal'}},
  'mixed-back-to-read':{version:intentVersion,action:'read',binding:{mode:'continue',conditions:'merge_ui'},parameters:{metric:null,grouping:null,comparison:null,conditions:[{field:'period',op:'set',expression:'сентябрь'}],options:{}},presentation:{format:'auto',detail:'normal'}},
 };
 const first=await run(new Map(),false,overrides),again=await run(structuredClone(first.saved),true,overrides);
 assert.equal(first.calls,60);assert.equal(again.calls,0);assert.equal(again.reserves,0);
});
