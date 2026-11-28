import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,taskProjection} from '../../../packages/analyzer/src/next/tasks.ts';
import {workflowPrototypeVersion} from '../../../packages/analyzer/src/next/workflow.ts';
import type {ProviderInput,Understanding} from '../../../packages/analyzer/src/next/workflow.ts';
import {parseIntent,intentVersion} from '../../../packages/analyzer/src/next/intent.ts';
import {scope,catalog,account} from '../../../packages/analyzer/test/fixtures/next-finances.ts';
import {nextReviewInput,reviewNextUnderstanding,nextReviewVersion} from '../src/analyzer-next-review.ts';
import {nextModelCall} from '../src/analyzer-next-model-call.ts';
import type {AssistantModel,AssistantJournal} from '../src/assistant-workflow.ts';
const question='Расходы за октябрь 2025 по категориям, только больше 120 рублей';
const state=emptyState(scope),env={scope,requestId:scope.chatId,question,date:'2026-11-28',global:{revision:0,filter:{accountIds:[account]},touched:{}},dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog};
const input:ProviderInput={version:workflowPrototypeVersion,question,date:env.date,context:taskProjection(state)};
const reply:Understanding={relevance:'financial',intent:parseIntent({version:intentVersion,action:'read',binding:{mode:'new'},parameters:{metric:'expenses',grouping:'category',comparison:null,conditions:[{field:'period',op:'set',expression:'октябрь 2025'},{field:'amount',op:'set',expression:'больше 120 рублей'}],options:{}},presentation:{format:'table',detail:'normal'}})};
async function harness(value:unknown){
 let calls=0,reserves=0;const bound={modelVersion:'synthetic-review',inputTokens:1000,outputTokens:500};
 const journal:AssistantJournal={receipt:{fingerprint:'f'.repeat(64),calls:[]},async persist(){},async reserve(){reserves++;},async settle(){}};
 const model:AssistantModel={bound,async complete(_i,before){await before();calls++;return {value,usage:{modelVersion:bound.modelVersion,inputTokens:100,outputTokens:50}};}};
 await nextModelCall(model,journal,{phase:'understand',prompt:'synthetic',input:{question},schema:{type:'object'}});
 return {model,journal,get calls(){return calls;},get reserves(){return reserves;}};
}
test('review sees resolved dates, strict money and presentation without any real scope or object identifiers',()=>{
 const projected:any=nextReviewInput(input,reply,state,env),text=JSON.stringify(projected);
 for(const hidden of [scope.ownerId,scope.chatId,scope.chatEpoch,scope.generation,account])assert.ok(!text.includes(hidden),hidden);
 assert.equal(projected.effect.query.filter.from,'2025-10-01');assert.equal(projected.effect.query.filter.through,'2025-10-31');assert.equal(projected.effect.query.filter.amountFrom,'12001');assert.deepEqual(projected.effect.query.filter.accountSelection,{selectedCount:1});assert.equal(projected.effect.presentation.format,'table');
 assert.equal(Object.hasOwn(projected,'expected'),false);assert.equal(Object.hasOwn(projected,'result'),false);assert.equal(state.history.length,0);
});
test('acceptance requires every cited source condition to be covered; rejection cannot silently repair the candidate',async()=>{
 const verdict={version:nextReviewVersion,decision:'accept',conditions:[{quote:'октябрь 2025',covered:true},{quote:'больше 120 рублей',covered:true}]},h=await harness(verdict),original=structuredClone(reply);
 assert.equal(await reviewNextUnderstanding(input,reply,state,env,h.model,h.journal),true);assert.deepEqual(reply,original);assert.equal(h.calls,2);
 const missing=await harness({...verdict,conditions:[{quote:'октябрь 2025',covered:true},{quote:'больше 120 рублей',covered:false}]});assert.equal(await reviewNextUnderstanding(input,reply,state,env,missing.model,missing.journal),false);
 const rejected=await harness({...verdict,decision:'reject'});assert.equal(await reviewNextUnderstanding(input,reply,state,env,rejected.model,rejected.journal),false);
});
test('empty, invented, duplicate or extended verdicts fail closed',async()=>{
 for(const value of [{version:nextReviewVersion,decision:'accept',conditions:[]},{version:nextReviewVersion,decision:'accept',conditions:[{quote:'ноябрь 2026',covered:true}]},{version:nextReviewVersion,decision:'accept',conditions:[{quote:'октябрь 2025',covered:true},{quote:'октябрь 2025',covered:true}]},{version:nextReviewVersion,decision:'accept',conditions:[{quote:'октябрь 2025',covered:true}],sql:'private-provider-value'}]){
  const h=await harness(value);await assert.rejects(reviewNextUnderstanding(input,reply,state,env,h.model,h.journal));assert.equal(h.calls,2);
 }
});
test('changed question or context is rejected before a review call or additional reserve',async()=>{
 for(const changed of [{...input,version:'foreign' as typeof input.version},{...input,question:question+' ещё'}, {...input,context:{...input.context,active:'t99'}}]){
  const h=await harness({});await assert.rejects(reviewNextUnderstanding(changed,reply,state,env,h.model,h.journal),/NEXT_REVIEW_CONTEXT_CHANGED/);assert.equal(h.calls,1);assert.equal(h.reserves,1);
 }
});
