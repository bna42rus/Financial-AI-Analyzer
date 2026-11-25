import {test} from 'node:test';
import assert from 'node:assert/strict';
import {facet} from '../../finance-core/src/model.ts';
import {calculateWidget,parseWidget} from '../../finance-core/src/overview.ts';
import type {OperationRow} from '../../finance-core/src/operations.ts';
import {emptyState,prepareTask,executeTask,finishTask,taskProjection} from '../src/next/tasks.ts';
import type {State,Environment,Prepared,Preparation} from '../src/next/tasks.ts';
import {intentVersion} from '../src/next/intent.ts';

const id=(n:number)=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
const scope={ownerId:'synthetic-owner',chatId:id(1),chatEpoch:id(2),generation:id(3)};
const account=id(4),food=id(5),taxi=id(6);
const catalog={accounts:[{id:account,name:'Учебный счёт',bankId:'tbank',type:'bank_account' as const,analyticsEnabled:true,defaultVisible:true,loanMode:null}],
 categories:[{id:food,name:'Продукты',parentId:null,role:'expense' as const,hidden:false},{id:taxi,name:'Такси',parentId:null,role:'expense' as const,hidden:false}],counterparties:[]};
function row(n:number,date:string,categoryId:string,amountMinor:string):OperationRow{
 return {id:id(n),date:{precision:'day',date},accountId:account,amountMinor,analyticsRole:'expense',decompositionActive:false,reviewReasons:[],unresolvedMinor:'0',neutralMinor:'0',excludedMinor:'0',
  parts:[{id:id(n+100),componentId:null,allocationId:null,amountMinor,role:'expense',categoryId,subcategoryId:null,basis:[],included:true}],
  classification:{kind:facet('purchase'),role:facet('expense'),category:facet(categoryId),subcategory:facet(null),merchant:facet('Учебный магазин'),counterparty:facet(null)},comment:''};
}
const rows=[row(10,'2025-09-10',food,'-10000'),row(11,'2025-09-11',taxi,'-2000'),row(12,'2025-10-10',food,'-15000'),row(13,'2025-10-11',taxi,'-1800')];
const envelope=(action:string,parameters:unknown,binding:unknown={mode:'new'},format='auto')=>({version:intentVersion,action,binding,parameters,presentation:{format,detail:'normal'}});
const keep={mode:'continue',conditions:'merge_ui'},pin={mode:'continue',conditions:'pin'};
const read=(metric:string|null='expenses',conditions:unknown[]=[],binding:unknown={mode:'new'},grouping:string|null=null)=>envelope('read',{metric,grouping,comparison:null,conditions,options:{}},binding);
const loan=(edits:unknown[],binding:unknown={mode:'new'},format='auto')=>envelope('calculate',{calculator:'loan',edits},binding,format);
const set=(field:string,value:unknown,quote:string)=>({field,op:'set',value,quote});
const initial=()=>loan([set('principalRubles','120000','120000'),set('annualRatePercent','12','12%'),set('months',12,'12 месяцев')]);
function harness(){
 let state=emptyState(scope),sequence=200,readCount=0,guardCount=0;
 const env:Environment={scope,requestId:id(sequence),question:'условия',date:'2026-11-25',global:{revision:0,filter:{accountIds:[account]},touched:{}},dataRevision:'r1',accessRevision:'a1',catalog};
 const services={async guard(){guardCount++;},async read(query:any){readCount++;return calculateWidget(parseWidget({id:id(900),name:'Учебная выборка',metrics:[query.metric],grouping:query.grouping,filter:query.filter,comparison:query.comparison==='custom'?{kind:'custom',...query.options?.comparisonPeriod}:{kind:query.comparison},chart:'table',topN:50}),rows,catalog,{},new Date(env.date+'T12:00:00Z'),'Europe/Moscow',true);}};
 return {env,services,get state(){return state;},get reads(){return readCount;},get guards(){return guardCount;},
  prepare(question:string,intent:unknown):Preparation{env.question=question;env.requestId=id(++sequence);const p=prepareTask(state,env,intent);state=p.state;return p;},
  finish(task:Prepared,outcome:any){const result=finishTask(state,env,task,outcome);state=result.state;return result;},
  async turn(question:string,intent:unknown){const p=this.prepare(question,intent);if(p.status!=='ready')return {preparation:p,outcome:null};const outcome=await executeTask(p.task,services);this.finish(p.task,outcome);return {preparation:p,outcome};}
 };
}
function ready(p:Preparation):Prepared{assert.equal(p.status,'ready');if(p.status!=='ready')throw Error(p.status);return p.task;}

test('expense chain preserves prior year, grouping and accounts; comparison rereads current data',async()=>{
 const h=harness();await h.turn('Расходы за октябрь 2025',read('expenses',[{field:'period',op:'set',expression:'октябрь 2025'}]));
 await h.turn('А по категориям?',read(null,[],keep,'category'));
 await h.turn('А сентябрь?',read(null,[{field:'period',op:'set',expression:'сентябрь'}],keep));
 const task=h.state.history.at(-1)!;assert.equal(task.kind,'read');if(task.kind!=='read')return;
 assert.deepEqual(task.node.query.filter,{accountIds:[account],from:'2025-09-01',through:'2025-09-30'});assert.equal(task.node.query.grouping,'category');
 assert.equal(h.reads,3);h.env.dataRevision='r2';
 const result=await h.turn('Сравни эти месяцы. Где расходы выросли сильнее?',envelope('compare',{scenarios:['t3','t2'],criterion:'value',objective:'max'},keep));
 assert.equal(h.reads,4);assert.equal(result.outcome?.kind,'read');if(result.outcome?.kind!=='read')return;
 assert.equal(result.outcome.result.totals.expenses,'16800');assert.equal(result.outcome.result.previousTotals.expenses,'12000');
 const differences=result.outcome.result.points.map(p=>({label:p.label,delta:BigInt(p.values.expenses??'0')-BigInt(p.previous.expenses??'0')}));
 assert.equal(differences.sort((a,b)=>a.delta>b.delta?-1:1)[0]?.label,'Продукты');
 assert.equal(h.state.history.at(-1)?.dataRevision,'r2');
});
test('explanation keeps pending loan; a short answer resumes exactly that clarification',async()=>{
 const h=harness();const first=await h.turn('120000 на 12 месяцев',loan([set('principalRubles','120000','120000'),set('months',12,'12 месяцев')]));
 assert.equal(first.preparation.status,'waiting');assert.equal(h.state.history.length,0);const before=structuredClone(h.state);
 await h.turn('Что такое ставка?',envelope('explain',{subject:{kind:'concept',question:'Что такое ставка?'}},keep));assert.deepEqual(h.state,before);
 const result=await h.turn('12%',loan([set('annualRatePercent','12','12%')],{mode:'answer',clarification:h.state.pending!.handle,option:null}));
 assert.equal(result.outcome?.kind,'loan');if(result.outcome?.kind!=='loan')return;
 assert.equal(result.outcome.results.length,2);assert.equal(result.outcome.results[1]?.interestMinor,'780000');assert.equal(h.reads,0);
});
test('loan chain: explain, typo choice, switch, both at new rate, cheaper and complete payment chart',async()=>{
 const h=harness();await h.turn('120000, 12%, 12 месяцев',initial());
 const original=structuredClone(h.state);await h.turn('В чём разница и как узнать свой тип?',envelope('explain',{subject:{kind:'concept',question:'В чём разница и как узнать свой тип?'}},keep));assert.deepEqual(h.state,original);
 await h.turn('дифференцированный',loan([set('payment','differentiated','дифференцированный')],keep));
 await h.turn('а ануитентный',loan([set('payment','annuity','ануитентный')],keep));
 await h.turn('А 25% для обоих?',loan([set('annualRatePercent','25','25%'),{field:'payment',op:'clear'}],keep));
 const latest=h.state.history.at(-1)!;assert.equal(latest.kind,'loan');if(latest.kind!=='loan')return;
 assert.equal(latest.results.length,2);for(const r of latest.results){assert.equal(r.input.principalRubles,'120000');assert.equal(r.input.months,12);assert.equal(r.input.annualRatePercent,'25');}
 const comparison=await h.turn('Что выгоднее в итоге?',envelope('compare',{scenarios:[latest.handle+'_v1',latest.handle+'_v2'],criterion:'interest',objective:'min'},keep));
 assert.equal(comparison.outcome?.kind,'loan_comparison');if(comparison.outcome?.kind!=='loan_comparison')return;
 assert.deepEqual(comparison.outcome.winnerIndexes,[1]);assert.ok(BigInt(comparison.outcome.deltasFromFirstMinor[1]!)<0n);
 const chart=await h.turn('Покажи платежи вместе с основным долгом и процентами',loan([],pin,'chart'));
 assert.equal(chart.preparation.status,'ready');if(chart.preparation.status!=='ready'||chart.outcome?.kind!=='loan')return;
 assert.equal(chart.preparation.task.presentation.format,'chart');
 for(const r of chart.outcome.results){assert.equal(r.rows.length,12);for(const row of r.rows)assert.equal(BigInt(row.paymentMinor),BigInt(row.principalMinor)+BigInt(row.interestMinor));}
 assert.equal(h.reads,0);
});
test('UI fields merge individually; explicit message beats UI; pinned conditions remain pinned',async()=>{
 const h=harness();await h.turn('Октябрь 2025, Продукты',read('expenses',[{field:'period',op:'set',expression:'Октябрь 2025'},{field:'categories',op:'set',expression:'Продукты'}]));
 h.env.global={revision:1,filter:{from:'2026-11-01',through:'2026-11-25',accountIds:[account]},touched:{period:1}};
 await h.turn('С теми же условиями',read(null,[],pin));
 let t=h.state.history.at(-1)!;assert.equal(t.kind,'read');if(t.kind!=='read')return;
 assert.equal(t.node.query.filter.from,'2025-10-01');assert.deepEqual(t.node.query.filter.categoryIds,[food]);
 h.env.global={...h.env.global,revision:2,filter:{...h.env.global.filter,from:'2026-09-01',through:'2026-09-30'},touched:{period:2}};
 await h.turn('Но октябрь 2024',read(null,[{field:'period',op:'set',expression:'октябрь 2024'}],keep));
 t=h.state.history.at(-1)!;if(t.kind!=='read')return;assert.equal(t.node.query.filter.from,'2024-10-01');assert.deepEqual(t.node.query.filter.categoryIds,[food]);
});
test('touched UI returning to its old value still replaces an explicit historical condition',async()=>{
 const h=harness();h.env.global={revision:0,filter:{from:'2026-11-01',through:'2026-11-25'},touched:{}};
 await h.turn('Октябрь 2025',read('expenses',[{field:'period',op:'set',expression:'Октябрь 2025'}]));
 h.env.global={...h.env.global,revision:2,touched:{period:2}};
 const p=h.prepare('По категориям',read(null,[],keep,'category')),t=ready(p);if(t.kind!=='read')return;
 assert.equal(t.node.query.filter.from,'2026-11-01');
});
test('new income task resets loan context; unrelated UI filters never enter a hypothetical loan',async()=>{
 const h=harness();h.env.global={revision:1,filter:{from:'2026-10-01',through:'2026-10-31',categoryIds:[taxi]},touched:{period:1,categories:1}};
 await h.turn('120000, 12%, 12 месяцев',initial());
 const loanTask=h.state.history[0]!;assert.equal(loanTask.kind,'loan');assert.ok(!JSON.stringify(loanTask).includes(taxi));
 const p=h.prepare('Новая тема, доходы за сентябрь 2025',read('income',[{field:'period',op:'set',expression:'сентябрь 2025'}]));const t=ready(p);
 assert.equal(t.kind,'read');if(t.kind!=='read')return;assert.equal(t.node.query.metric,'income');assert.equal(t.node.parent,null);assert.equal(t.node.query.filter.from,'2025-09-01');
});
test('missing metric preserves explicit period and grouping across clarification',async()=>{
 const h=harness();const p=h.prepare('Октябрь 2025 по категориям',read(null,[{field:'period',op:'set',expression:'Октябрь 2025'}],{mode:'new'},'category'));
 assert.equal(p.status,'waiting');const next=h.prepare('Расходы',read('expenses',[],{mode:'answer',clarification:h.state.pending!.handle,option:null}));
 const t=ready(next);if(t.kind!=='read')return;assert.equal(t.node.query.filter.from,'2025-10-01');assert.equal(t.node.query.grouping,'category');
});
test('unknown or duplicate entity and unsupported condition never disappear silently',()=>{
 const h=harness();h.env.catalog={...catalog,categories:[...catalog.categories,{...catalog.categories[0]!,id:id(99)}]};
 assert.throws(()=>h.prepare('Продукты',read('expenses',[{field:'categories',op:'set',expression:'Продукты'}])),/TASK_ENTITY_AMBIGUOUS/);
 assert.throws(()=>h.prepare('несуществующий',read('expenses',[{field:'categories',op:'set',expression:'несуществующий'}])),/TASK_ENTITY_MISSING/);
 assert.throws(()=>h.prepare('Правило',read('expenses',[{field:'rule',op:'set',expression:'Правило'}])),/TASK_CONDITION_ADAPTER_MISSING/);
 assert.equal(h.state.history.length,0);assert.equal(h.reads,0);
});
test('invalid term does not silently remove prepayments; zero rate stays a real value',async()=>{
 const h=harness();await h.turn('120000, 12%, 12 месяцев',initial());
 await h.turn('10000 в шестом месяце',loan([set('prepayments',[{month:6,amountRubles:'10000',strategy:'reduce_term'}],'10000 в шестом месяце')],keep));
 const p=h.prepare('На 3 месяца',loan([set('months',3,'3 месяца')],keep));assert.equal(p.status,'waiting');assert.equal(h.state.pending?.draft.kind,'loan');
 const pending=h.state.pending!;if(pending.draft.kind!=='loan')return;assert.equal(pending.draft.input.prepayments?.[0]?.month,6);
 const fixed=await h.turn('Без досрочки, ставка 0%',loan([{field:'prepayments',op:'clear'},set('annualRatePercent','0','0%')],{mode:'answer',clarification:pending.handle,option:null}));
 assert.equal(fixed.outcome?.kind,'loan');if(fixed.outcome?.kind!=='loan')return;assert.equal(fixed.outcome.results[0]?.interestMinor,'0');
});
test('foreign scope, unknown alias, forged quote and reused request fail before tools',async()=>{
 const h=harness();await h.turn('120000, 12%, 12 месяцев',initial());
 for(const key of ['ownerId','chatId','chatEpoch','generation'] as const){const altered={...scope,[key]:key==='ownerId'?'another-owner':id(999)};assert.throws(()=>prepareTask(h.state,{...h.env,scope:altered,requestId:id(700)},initial()),/TASK_SCOPE_MISMATCH/);}
 assert.throws(()=>h.prepare('То же',loan([],{mode:'reference',handle:'t999',conditions:'pin'})),/TASK_REFERENCE_INVALID/);
 assert.throws(()=>h.prepare('Другая сумма',loan([set('principalRubles','500000','Не было в вопросе')],keep)),/TASK_EVIDENCE_MISSING/);
 assert.throws(()=>prepareTask(h.state,{...h.env,requestId:h.state.history[0]!.requestId},initial()),/TASK_REQUEST_REUSED/);assert.equal(h.reads,0);
});
test('late completion and data/access revision changes cannot become a successful active result',async()=>{
 const h=harness();const old=ready(h.prepare('120000, 12%, 12 месяцев',initial()));const oldResult=await executeTask(old,h.services);
 const newer=ready(h.prepare('Сентябрь 2025',read('expenses',[{field:'period',op:'set',expression:'Сентябрь 2025'}])));
 const current=structuredClone(h.state);assert.equal(h.finish(old,oldResult).applied,false);assert.deepEqual(h.state,current);
 const result=await executeTask(newer,h.services);h.env.dataRevision='r2';h.finish(newer,result);assert.equal(h.state.failure,'TASK_RESULT_STALE');assert.equal(h.state.history.length,0);
 const next=ready(h.prepare('120000, 12%, 12 месяцев',initial()));const nextResult=await executeTask(next,h.services);h.env.accessRevision='a2';h.finish(next,nextResult);assert.equal(h.state.history.length,0);
});
test('guard failure makes no read; failed result never registers a successful task',async()=>{
 const h=harness();const p=ready(h.prepare('Октябрь 2025',read('expenses',[{field:'period',op:'set',expression:'Октябрь 2025'}])));
 await assert.rejects(executeTask(p,{...h.services,async guard(){throw Error('ACCESS_DENIED');}}),/ACCESS_DENIED/);assert.equal(h.reads,0);
 h.finish(p,{kind:'failed',code:'ACCESS_DENIED'});assert.equal(h.state.history.length,0);assert.equal(h.state.pending,null);
});
test('model projection contains no owner, account, operation or category identifiers',async()=>{
 const h=harness();await h.turn('Октябрь 2025 Продукты',read('expenses',[{field:'period',op:'set',expression:'Октябрь 2025'},{field:'categories',op:'set',expression:'Продукты'}]));
 const projection=JSON.stringify(taskProjection(h.state));for(const secret of [scope.ownerId,scope.chatId,account,food,rows[0]!.id])assert.ok(!projection.includes(secret));
});

test('comparison remains explainable; differing scenarios require an explicit field or variant choice',async()=>{
 const h=harness();await h.turn('120000, 12%, 12 месяцев',initial());
 await h.turn('24 месяца',loan([set('months',24,'24 месяца')],keep));
 await h.turn('Сравни переплату',envelope('compare',{scenarios:['t1_v1','t2_v1'],criterion:'interest',objective:'min'},keep));
 const handle=h.state.active!;const explained=await h.turn('Объясни сравнение',envelope('explain',{subject:{kind:'result',handle}},keep));
 assert.equal(explained.preparation.status,'explanation');if(explained.preparation.status!=='explanation')return;
 assert.equal(explained.preparation.historical?.kind,'loan');
 const ambiguous=h.prepare('Аннуитетный',loan([set('payment','annuity','Аннуитетный')],keep));assert.equal(ambiguous.status,'waiting');if(ambiguous.status!=='waiting')return;assert.deepEqual(ambiguous.missing,['months']);
 const chosen=h.prepare('Второй вариант',loan([],{mode:'reference',handle:handle+'_v2',conditions:'pin'}));
 const task=ready(chosen);if(task.kind!=='loan')return;assert.equal(task.inputs[0]?.months,24);
});
test('fixed operation boundary cannot expand to newly selected unrelated operations',async()=>{
 const h=harness();h.env.global={revision:0,filter:{operationIds:[rows[0]!.id,rows[1]!.id]},touched:{}};
 await h.turn('Сентябрь 2025',read('expenses',[{field:'period',op:'set',expression:'Сентябрь 2025'}]));
 h.env.global={revision:1,filter:{operationIds:[rows[0]!.id,rows[2]!.id]},touched:{}};
 await h.turn('Те же условия',read(null,[],pin));const stored=h.state.history.at(-1)!;if(stored.kind!=='read')return;
 assert.deepEqual(stored.node.query.filter.operationIds,[rows[0]!.id]);assert.deepEqual(stored.node.fixedOperationIds,[rows[0]!.id,rows[1]!.id]);
});
test('stale UI revision is rejected even when conditions are pinned',async()=>{
 const h=harness();h.env.global={revision:3,filter:{},touched:{}};await h.turn('Октябрь 2025',read('expenses',[{field:'period',op:'set',expression:'Октябрь 2025'}]));
 h.env.global={revision:2,filter:{},touched:{}};assert.throws(()=>h.prepare('Те же условия',read(null,[],pin)),/TASK_GLOBAL_VERSION_INVALID/);
});
test('invalid comparison and unsupported action stop before a financial tool call',()=>{
 const h=harness();const intent=read('expenses',[{field:'period',op:'set',expression:'октябрь 2025'}]);
 (intent.parameters as any).comparison='custom';assert.throws(()=>h.prepare('октябрь 2025',intent),/TASK_COMPARISON_PERIOD_REQUIRED/);
 const unsupported=h.prepare('Создай категорию',envelope('propose',{kind:'create_category',name:'Учебная категория',role:'expense'}));assert.equal(unsupported.status,'unsupported');assert.equal(h.reads,0);
});
