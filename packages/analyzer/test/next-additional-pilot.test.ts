import {test} from 'node:test';
import assert from 'node:assert/strict';
import {additionalCases,additionalFilter,additionalPreparationMatches,additionalOutcomeMatches} from '../src/next/additional-pilot.ts';
import {PrototypeSession} from '../src/next/workflow.ts';
import type {Understanding,TurnResult,ProviderInput} from '../src/next/workflow.ts';
import {prepareTask} from '../src/next/tasks.ts';
import type {Preparation} from '../src/next/tasks.ts';
import {intentVersion,parseIntent} from '../src/next/intent.ts';
import {recoverLoanGraphFrame,paymentChoice,isLoanChartResume,sourcePeriodEdit} from '../src/next/source-intent.ts';
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
async function run(overrides:Record<string,unknown>={}){
 const sessions=new Map(additionalCases.map(c=>[c.chain,new PrototypeSession(scope)])),prepared=new Map<string,Preparation>(),results=new Map<string,TurnResult>(),states=new Map<string,ReturnType<PrototypeSession['snapshot']>>(),inputs:ProviderInput[]=[];let reads=0;
 for(const [n,c]of additionalCases.entries()){
  const session=sessions.get(c.chain)!,before=session.snapshot(),environment={scope,requestId:id(1100+n),question:c.question,date:'2026-11-25',global:{revision:c.ui?.revision??0,filter:additionalFilter(c.ui?.filter??{},catalog),touched:c.ui?.revision?{period:c.ui.revision,categories:c.ui.revision}:{}},dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog};
  states.set(c.id,before);
  const terminal=c.expected.kind==='unrelated'||c.expected.kind==='ambiguous',reply=terminal?{relevance:c.expected.kind as 'unrelated'|'ambiguous',intent:null}:{relevance:'financial',intent:overrides[c.id]??scripts[c.id]};
  const result=await session.run(environment,{async understand(input){inputs.push(input);return reply;}},{current:()=>environment,async authorize(){},async review(_input,r){const p=r.intent?prepareTask(session.snapshot(),environment,r.intent):null;if(p)prepared.set(c.id,p);return additionalPreparationMatches(c,p,r,catalog);},tools:{async guard(){},async read(q){reads++;return calculateWidget(parseWidget({id:scope.chatId,name:'Синтетическая выборка',metrics:[q.metric],grouping:q.grouping,filter:q.filter,comparison:q.comparison==='custom'?{kind:'custom',...q.options?.comparisonPeriod}:{kind:q.comparison},chart:'table',topN:50}),rows,catalog,{},new Date('2026-11-25T12:00:00Z'),'Europe/Moscow',true);}}});
  assert.equal(additionalOutcomeMatches(c,result),true,c.id+' '+JSON.stringify(result));results.set(c.id,result);
  if(terminal||c.expected.kind==='explanation')assert.deepEqual(session.snapshot(),before,c.id);
 }
 return {sessions,prepared,results,states,inputs,reads};
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
const retained:Record<string,unknown>={
 'months-explicit-base':envelope('read',{metric:'expenses',grouping:'category',comparison:'previous_month',conditions:[condition('period','2025-10-01/2025-10-31')],options:{}}),
 'filters-new-scope':read([],fresh,'category'),
 'loan-switch-typo':envelope('explain',{subject:{kind:'concept',question:'А дифиренцированный?'}}),
 'mixed-back-to-loan':envelope('read',{metric:'loan_payments',grouping:'time',comparison:'none',conditions:[],options:{chart:'line',format:'chart',detail:'normal'}},keep,'chart'),
};
test('all four retained model failures now traverse the full 25-turn chain without changing the oracle or schema',async()=>{
 const h=await run(retained);assert.equal(h.results.size,25);assert.equal(h.reads,12);
 const q=h.prepared.get('months-explicit-base');if(q?.status!=='ready'||q.task.kind!=='read')throw Error('read');assert.equal(q.task.node.query.filter.from,'2025-09-01');assert.equal(q.task.node.query.options?.comparisonPeriod?.from,'2025-10-01');
 const loan=h.prepared.get('mixed-back-to-loan');if(loan?.status!=='ready'||loan.task.kind!=='loan')throw Error('loan');assert.equal(loan.task.parent,'t2');assert.equal(loan.task.presentation.format,'chart');
});
test('the same plot-family recovery covers both variants of the active loan, including an explanatory misclassification',async()=>{
 for(const value of [retained['mixed-back-to-loan'],envelope('explain',{subject:{kind:'concept',question:'Покажи оба графика платежей, не меняя условий.'}})]){
  const h=await run({...retained,'loan-both-charts':value});assert.equal(h.results.size,25);
  const p=h.prepared.get('loan-both-charts');if(p?.status!=='ready'||p.task.kind!=='loan')throw Error('loan');assert.equal(p.task.inputs.length,2);assert.equal(p.task.presentation.format,'chart');
 }
});
test('the retained both-chart clear with an extra source quote completes all 25 turns',async()=>{
 const c=additionalCases.find(v=>v.id==='loan-both-charts')!,bad=loan([{field:'payment',op:'clear',quote:c.question}],keep,'chart');
 assert.throws(()=>parseIntent(bad),/INTENT_PROTOTYPE_INVALID/);
 const h=await run({...retained,[c.id]:bad}),p=h.prepared.get(c.id);assert.equal(h.results.size,25);
 if(p?.status!=='ready'||p.task.kind!=='loan')throw Error('loan');assert.equal(p.task.inputs.length,2);assert.ok(p.task.inputs.every(v=>v.annualRatePercent==='0'&&v.months===12));
});
test('clear quote metadata is canonicalized across fields only with exact source evidence and a fully valid frame',async()=>{
 const h=await run(),state=h.states.get('loan-both-charts')!,question='Сними ограничение';
 for(const field of ['amount','period','categories']){
  const raw=read([{field,op:'clear',quote:question}],keep);assert.throws(()=>parseIntent(raw),/INTENT_PROTOTYPE_INVALID/);
  const canonical=parseIntent(recoverLoanGraphFrame(raw,question,state));if(canonical.action!=='read')throw Error('read');assert.deepEqual(canonical.parameters.conditions,[{field,op:'clear'}]);
 }
 for(const edit of [{field:'payment',op:'clear',quote:'не из вопроса'},{field:'payment',op:'clear',quote:''},{field:'payment',op:'clear',quote:question,value:null},{field:'payment',op:'clear',quote:question,admin:true},{field:'payment',op:'set',value:'both',quote:question}])assert.throws(()=>parseIntent(recoverLoanGraphFrame(loan([edit],keep,'chart'),question,state)),/INTENT_PROTOTYPE_INVALID/);
});
test('two principal/interest plots do not switch a selected payment type to both variants',async()=>{
 const h=await run(),state=h.states.get('loan-both-charts')!,environment={scope,requestId:id(1888),question:'Покажи оба графика основного долга и процентов',date:'2026-11-25',global:{revision:0,filter:{accountIds:[account]},touched:{}},dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog};
 const p=prepareTask(state,environment,loan([],keep,'chart'));if(p.status!=='ready'||p.task.kind!=='loan')throw Error('loan');assert.equal(p.task.inputs.length,1);assert.equal(p.task.inputs[0]!.payment,'differentiated');
});
test('comparison roles survive alternative date spelling and model defaults, while conflicting years and scopes remain rejected',async()=>{
 const h=await run(),state=h.states.get('months-explicit-base')!,environment={scope,requestId:id(1900),question:'',date:'2026-11-25',global:{revision:0,filter:{accountIds:[account]},touched:{}},dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog};
 for(const question of ['Сопоставь 2025-09 относительно 2025-10','Сравни сентябрь 2025 по сравнению с октябрём 2025'])for(const comparison of ['none','previous_month','previous_year']){
  const intent=envelope('read',{metric:'expenses',grouping:'category',comparison,conditions:[],options:{}}),p=prepareTask(state,{...environment,question},intent);
  if(p.status!=='ready'||p.task.kind!=='read')throw Error('read');assert.equal(p.task.node.query.filter.from,'2025-09-01');assert.equal(p.task.node.query.options?.comparisonPeriod?.from,'2025-10-01');
 }
 assert.throws(()=>prepareTask(state,{...environment,question:'Сравни сентябрь 2024 относительно октября 2024'},retained['months-explicit-base']),/TASK_COMPARISON_CONTEXT_AMBIGUOUS/);
 const ambiguous=structuredClone(state);
 for(const [n,task]of state.history.filter(t=>t.kind==='read'&&t.node.query.comparison==='none').entries()){
  const copy=structuredClone(task);if(copy.kind!=='read')throw Error('read');copy.handle='t'+(10+n);copy.node.query.filter.categoryIds=[catalog.categories[0]!.id];ambiguous.history.push(copy);
 }
 assert.throws(()=>prepareTask(ambiguous,{...environment,question:additionalCases.find(c=>c.id==='months-explicit-base')!.question},retained['months-explicit-base']),/TASK_COMPARISON_CONTEXT_AMBIGUOUS/);
});
test('payment typo matching is bounded to a whole choice, not explanations, negations, arbitrary labels or numbers',()=>{
 for(const q of ['А дифиренцированный?','дифференцированный','тогда диференцированный'])assert.equal(paymentChoice(q)?.payment,'differentiated',q);
 for(const q of ['ануитентный','аннуитетный','Выбери ануитетный.'])assert.equal(paymentChoice(q)?.payment,'annuity',q);
 for(const q of ['Что значит дифиренцированный?','не аннуитетный','аннуитетный под 25%','вклад','дифференцированный или аннуитетный','анн','удали операции'])assert.equal(paymentChoice(q),null,q);
});
test('graph recovery requires a saved calculation, preserves the closed frame, and refuses real-data or changing requests',async()=>{
 const h=await run(),state=h.states.get('mixed-back-to-loan')!,c=additionalCases.find(v=>v.id==='mixed-back-to-loan')!,raw=retained[c.id];
 assert.equal(parseIntent(recoverLoanGraphFrame(raw,c.question,state)).action,'calculate');
 for(const question of ['Покажи реальные платежи по кредиту','Покажи график операций счёта','Вернись к расчёту кредита и покажи график платежей под 25%','Вернись к расчёту кредита и покажи график платежей под ２５％','Не показывай график расчёта кредита']){
  assert.equal(isLoanChartResume(question),false,question);assert.throws(()=>parseIntent(recoverLoanGraphFrame(raw,question,state)),/INTENT_PROTOTYPE_INVALID/);
 }
 for(const mutate of [(r:any)=>r.sql='select anything',(r:any)=>r.parameters.options.admin=true,(r:any)=>r.parameters.conditions=[condition('amount','>100')],(r:any)=>r.parameters.options.format='operations',(r:any)=>r.binding.handle='t999']){
  const bad=structuredClone(raw) as any;mutate(bad);assert.throws(()=>parseIntent(recoverLoanGraphFrame(bad,c.question,state)),/INTENT_PROTOTYPE_INVALID/);
 }
 assert.throws(()=>parseIntent(recoverLoanGraphFrame(raw,c.question,{...state,history:[]})),/INTENT_PROTOTYPE_INVALID/);
});
test('source date completion does not treat category or merchant month names as a time condition',()=>{
 const base={name:'query_finances',metric:'expenses',grouping:'none',comparison:'none',filter:{accountIds:[account]}} as const;
 assert.equal(sourcePeriodEdit('Расходы в категории Май','2026-11-25',base),null);
 assert.equal(sourcePeriodEdit('Расходы в магазине Март','2026-11-25',base),null);
 assert.equal(sourcePeriodEdit('Новая задача: расходы за октябрь 2025','2026-11-25',base)?.op,'set');
 assert.throws(()=>sourcePeriodEdit('Расходы за сентябрь 2025 и за октябрь 2025','2026-11-25',base),/TASK_PERIOD_EVIDENCE_AMBIGUOUS/);
});
