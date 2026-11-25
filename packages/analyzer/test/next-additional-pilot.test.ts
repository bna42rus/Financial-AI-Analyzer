import {test} from 'node:test';
import assert from 'node:assert/strict';
import {additionalCases,additionalFilter,additionalPreparationMatches,additionalOutcomeMatches} from '../src/next/additional-pilot.ts';
import {PrototypeSession} from '../src/next/workflow.ts';
import type {Understanding,TurnResult,ProviderInput} from '../src/next/workflow.ts';
import {prepareTask} from '../src/next/tasks.ts';
import type {Preparation} from '../src/next/tasks.ts';
import {intentVersion,parseIntent} from '../src/next/intent.ts';
import {calculateWidget,parseWidget} from '../../finance-core/src/overview.ts';
import {scope,id,account,catalog,rows} from './fixtures/next-finances.ts';
const keep={mode:'continue',conditions:'merge_ui'},fresh={mode:'new'},ref=(handle:string)=>({mode:'reference',handle,conditions:'pin'});
const envelope=(action:string,parameters:unknown,binding:unknown=fresh,format='auto')=>({version:intentVersion,action,parameters,binding,presentation:{format,detail:'normal'}});
const set=(field:string,value:unknown,quote:string)=>({field,op:'set',value,quote});
const condition=(field:string,expression:string)=>({field,op:'set',expression});
const read=(conditions:unknown[],binding:unknown=fresh,grouping:string|null=null,metric:string|null='expenses')=>envelope('read',{metric,grouping,comparison:null,conditions,options:{}},binding);
const month=(expression:string,binding:unknown=fresh,grouping:string|null=null)=>read([condition('period',expression)],binding,grouping);
const loan=(edits:unknown[],binding:unknown=fresh,format='auto')=>envelope('calculate',{calculator:'loan',edits},binding,format);
const compare=(scenarios:string[],criterion='value')=>envelope('compare',{scenarios,criterion,objective:criterion==='value'?'max':'min'},keep);
// Scripted replies test the harness and tool path. No provider is called here;
// real understanding quality is measured separately by --suite additional.
const scripts:Record<string,unknown>={
 'months-start':month('2025-10',fresh,'category'),
 'months-short':month('2025-09',fresh,'category'),
 'months-growth':compare(['t1','t2']),
 'months-explicit-base':compare(['t2','t1']),
 'months-current-ui':read([],fresh,'category'),
 'filters-start':read([condition('period','октябрь 2025'),condition('categories','Продукты')]),
 'filters-month':month('сентябрь',keep),
 'filters-strict-money':read([condition('amount','больше 120 рублей')],keep),
 'filters-clear-money':read([{field:'amount',op:'clear'}],keep),
 'filters-new-scope':month('2025-10',fresh,'category'),
 'loan-two-variants':loan([set('principalRubles','240000','240 тысяч'),set('annualRatePercent','12','12%'),set('months',24,'24 месяца')]),
 'loan-change-term':loan([set('months',12,'12 месяцев')],keep),
 'loan-zero-rate':loan([set('annualRatePercent','0','0%')],keep),
 'loan-choice-short':loan([set('payment','annuity','аннуитетный')],keep),
 'loan-switch-typo':loan([set('payment','differentiated','дифиренцированный')],keep),
 'loan-both-charts':loan([{field:'payment',op:'clear'}],keep,'chart'),
 'loan-tied-comparison':compare(['t6_v2','t6_v1'],'interest'),
 'mixed-read':month('2025-10',fresh,'category'),
 'mixed-new-loan':loan([set('principalRubles','100000','100000 рублей'),set('annualRatePercent','10','10%'),set('months',10,'10 месяцев'),set('payment','annuity','аннуитетный')]),
 'mixed-back-to-read':month('сентябрь',ref('t1')),
 'mixed-back-to-loan':loan([],ref('t2'),'chart'),
 'mixed-concept':envelope('explain',{subject:{kind:'concept',question:'Что означает аннуитетный?'}}),
 'mixed-rate-after-concept':loan([set('annualRatePercent','0','0%')],keep),
};
async function run(){
 const sessions=new Map(additionalCases.map(c=>[c.chain,new PrototypeSession(scope)])),prepared=new Map<string,Preparation>(),results=new Map<string,TurnResult>(),inputs:ProviderInput[]=[];let reads=0;
 for(const [n,c]of additionalCases.entries()){
  const session=sessions.get(c.chain)!,before=session.snapshot(),environment={scope,requestId:id(1100+n),question:c.question,date:'2026-11-25',global:{revision:c.ui?.revision??0,filter:additionalFilter(c.ui?.filter??{},catalog),touched:c.ui?.revision?{period:c.ui.revision,categories:c.ui.revision}:{}},dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog};
  const terminal=c.expected.kind==='unrelated'||c.expected.kind==='ambiguous',reply:Understanding=terminal?{relevance:c.expected.kind as 'unrelated'|'ambiguous',intent:null}:{relevance:'financial',intent:parseIntent(scripts[c.id])};
  const result=await session.run(environment,{async understand(input){inputs.push(input);return reply;}},{current:()=>environment,async authorize(){},async review(_input,r){const p=r.intent?prepareTask(session.snapshot(),environment,r.intent):null;if(p)prepared.set(c.id,p);return additionalPreparationMatches(c,p,r,catalog);},tools:{async guard(){},async read(q){reads++;return calculateWidget(parseWidget({id:scope.chatId,name:'Синтетическая выборка',metrics:[q.metric],grouping:q.grouping,filter:q.filter,comparison:q.comparison==='custom'?{kind:'custom',...q.options?.comparisonPeriod}:{kind:q.comparison},chart:'table',topN:50}),rows,catalog,{},new Date('2026-11-25T12:00:00Z'),'Europe/Moscow',true);}}});
  assert.equal(additionalOutcomeMatches(c,result),true,c.id+' '+JSON.stringify(result));results.set(c.id,result);
  if(terminal||c.expected.kind==='explanation')assert.deepEqual(session.snapshot(),before,c.id);
 }
 return {sessions,prepared,results,inputs,reads};
}
test('all 25 additional turns pass through understanding, mandatory review, preparation and the real financial tools',async()=>{
 const h=await run();assert.equal(h.results.size,25);assert.equal(h.inputs.length,25);assert.equal(h.reads,12);assert.equal(h.sessions.get('mixed')!.snapshot().history.length,5);
 const text=JSON.stringify(h.inputs);for(const hidden of ['expected','16800',scope.ownerId,scope.chatId,account,rows[0]!.id])assert.ok(!text.includes(hidden),hidden);
 assert.ok(h.inputs.every(v=>Object.keys(v).sort().join(',')==='context,date,question,version'));
});
test('read oracle rejects wrong accounts, categories, strictness, grouping, copied dates and statistics',async()=>{
 const h=await run(),c=additionalCases.find(v=>v.id==='filters-strict-money')!,original=h.prepared.get(c.id)!;if(original.status!=='ready'||original.task.kind!=='read')throw Error('read');
 for(const change of [(q:any)=>q.filter.accountIds=[id(999)],(q:any)=>q.filter.categoryIds=[],(q:any)=>q.filter.amountFrom='12000',(q:any)=>q.filter.from='2026-09-01',(q:any)=>q.grouping='category',(q:any)=>q.options={statistic:'mean'}]){
  const p=structuredClone(original);if(p.status!=='ready'||p.task.kind!=='read')throw Error('read');change(p.task.node.query);assert.equal(additionalPreparationMatches(c,p,{relevance:'financial',intent:parseIntent(scripts[c.id])},catalog),false);
 }
 const growth=additionalCases.find(v=>v.id==='months-growth')!,reply=parseIntent(scripts[growth.id]);if(reply.action!=='compare')throw Error('compare');reply.parameters.objective='min';assert.equal(additionalPreparationMatches(growth,h.prepared.get(growth.id)!,{relevance:'financial',intent:reply},catalog),false);
});
test('loan oracle rejects missing variants, changed terms, invented extras, a missing requested chart and false zero-rate charges',async()=>{
 const h=await run(),c=additionalCases.find(v=>v.id==='loan-both-charts')!,original=h.prepared.get(c.id)!;if(original.status!=='ready'||original.task.kind!=='loan')throw Error('loan');
 for(const change of [(p:any)=>p.task.inputs.pop(),(p:any)=>p.task.inputs[0].months=13,(p:any)=>p.task.inputs[0].prepayments=[{month:1,amountRubles:'1',strategy:'reduce_term'}],(p:any)=>p.task.presentation.format='auto']){
  const p=structuredClone(original);change(p);assert.equal(additionalPreparationMatches(c,p,{relevance:'financial',intent:parseIntent(scripts[c.id])},catalog),false);
 }
 const bad=structuredClone(h.results.get(c.id)!);if(bad.status!=='completed'||bad.outcome.kind!=='loan')throw Error('loan');bad.outcome.results[0]!.rows[0]!.interestMinor='1';assert.equal(additionalOutcomeMatches(c,bad),false);
});
test('financial boundary and explanation have their own assertions and never pass as an arbitrary successful result',async()=>{
 const h=await run(),unrelated=additionalCases.find(c=>c.id==='boundary-unrelated')!,concept=additionalCases.find(c=>c.id==='mixed-concept')!;
 assert.equal(additionalOutcomeMatches(unrelated,h.results.get('months-start')!),false);
 assert.equal(additionalPreparationMatches(unrelated,null,{relevance:'ambiguous',intent:null},catalog),false);
 const p=structuredClone(h.prepared.get(concept.id)!);if(p.status!=='explanation'||p.subject.kind!=='concept')throw Error('explain');p.subject.question='Что такое вклад?';assert.equal(additionalPreparationMatches(concept,p,{relevance:'financial',intent:parseIntent(scripts[concept.id])},catalog),false);
 const tied=additionalCases.find(c=>c.id==='loan-tied-comparison')!,bad=structuredClone(h.results.get(tied.id)!);if(bad.status!=='completed'||bad.outcome.kind!=='loan_comparison')throw Error('compare');for(const winners of [[0],[0,0],[],[0,2]]){bad.outcome.winnerIndexes=winners;assert.equal(additionalOutcomeMatches(tied,bad),false);}
});
