import {test} from 'node:test';
import assert from 'node:assert/strict';
import {comparisonPeriodOrder} from '../src/next/comparison-periods.ts';
import {PrototypeSession} from '../src/next/workflow.ts';
import type {Services} from '../src/next/workflow.ts';
import {emptyState,prepareTask,executeTask,finishTask} from '../src/next/tasks.ts';
import {intentVersion} from '../src/next/intent.ts';
import {pilotCases,pilotPreparationMatches,pilotOutcomeMatches} from '../src/next/pilot.ts';
import {calculateWidget,parseWidget} from '../../finance-core/src/overview.ts';
import {scope,id,account,taxi,catalog,rows} from './fixtures/next-finances.ts';
const date='2026-11-25',keep={mode:'continue',conditions:'merge_ui'};
const envelope=(action:string,parameters:unknown,binding:unknown={mode:'new'})=>({version:intentVersion,action,parameters,binding,presentation:{format:'auto',detail:'normal'}});
const read=(expression:string,binding:unknown={mode:'new'})=>envelope('read',{metric:'expenses',grouping:'category',comparison:'none',conditions:[{field:'period',op:'set',expression}],options:{}},binding);
const compare=(scenarios:string[])=>envelope('compare',{scenarios,criterion:'value',objective:'max'},keep);
const period=(month:string)=>({from:month+'-01',through:month+'-'+(['04','06','09','11'].includes(month.slice(-2))?'30':month.slice(-2)==='02'?(Number(month.slice(0,4))%4===0?'29':'28'):'31')});
const env=(n:number,question:string)=>({scope,requestId:id(n),question,date,global:{revision:0,filter:{accountIds:[account]},touched:{}},dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog});
const tools={async guard(){},async read(query:any){return calculateWidget(parseWidget({id:scope.chatId,name:'Синтетическая выборка',metrics:[query.metric],grouping:query.grouping,filter:query.filter,comparison:query.comparison==='custom'?{kind:'custom',...query.options?.comparisonPeriod}:{kind:query.comparison},chart:'table',topN:50}),rows,catalog,{},new Date(date+'T12:00:00Z'),'Europe/Moscow',true);}};

test('period roles do not depend on alias order, month names, year boundaries or interval length',()=>{
 for(const [earlier,later]of [['2025-09','2025-10'],['2025-12','2026-01'],['2024-02','2024-03'],['2023-02','2023-03']]){
  const a=period(earlier!),b=period(later!);
  for(const question of ['Сопоставь эти месяцы: в какой категории прибавилось больше всего?','Где было самое большое снижение?','Сравнение двух периодов','Сравни октябрь и сентябрь']){
   assert.deepEqual(comparisonPeriodOrder([a,b],question,date),[0,1]);assert.deepEqual(comparisonPeriodOrder([b,a],question,date),[1,0]);
  }
 }
 const a={from:'2025-01-01',through:'2025-01-02'},b={from:'2025-03-10',through:'2025-03-20'};
 assert.deepEqual(comparisonPeriodOrder([b,a],'Сопоставь интервалы',date),[1,0]);
});
test('an explicit baseline overrides chronology with source-backed dates, independently of aliases',()=>{
 const a=period('2025-09'),b=period('2025-10');
 for(const question of ['Сравни сентябрь относительно октября.','Сентябрь по сравнению с октябрём 2025','Сентябрь по отношению к октябрю 2025','База: 2025-10; сравни с сентябрём','За базу возьми октябрь 2025, сравни сентябрь','Сентябрь к октябрю 2025','Насколько сентябрь меньше октября?','Сентябрь больше чем октябрь 2025?']){
  assert.deepEqual(comparisonPeriodOrder([a,b],question,date),[1,0],question);assert.deepEqual(comparisonPeriodOrder([b,a],question,date),[0,1],question);
 }
 assert.deepEqual(comparisonPeriodOrder([a,b],'Октябрь относительно сентября 2025',date),[0,1]);
});
test('missing, overlapping, identical or unresolved directed periods never become a silent inverted comparison',()=>{
 const a=period('2025-09'),b=period('2025-10');
 for(const question of ['Сравни наоборот','В обратном порядке','Сентябрь не относительно октября','Относительно августа 2025','Относительно октября 2024','Базой считай тот месяц','Относительно сентября и относительно октября'])assert.throws(()=>comparisonPeriodOrder([a,b],question,date),/TASK_COMPARISON_DIRECTION/);
 assert.throws(()=>comparisonPeriodOrder([period('2024-09'),a],'Относительно сентября',date),/TASK_COMPARISON_DIRECTION/);
 for(const other of [a,{from:'2025-09-15',through:'2025-10-15'}])assert.throws(()=>comparisonPeriodOrder([a,other],'Сравни',date),/TASK_COMPARISON_PERIOD_OVERLAP/);
 assert.throws(()=>comparisonPeriodOrder([a,{}],'Сравни',date),/TASK_COMPARISON_PERIOD_REQUIRED/);
});

// The three read replies reproduce the retained pilot payloads. Loan replies
// exercise the same five-step flow; they are scripted, not a model benchmark.
function responses(reverse=false){
 const set=(field:string,value:unknown,quote:string)=>({field,op:'set',value,quote});
 return [
  envelope('calculate',{calculator:'loan',edits:[set('principalRubles','300000','300 тысяч'),set('annualRatePercent','19','19%'),set('months',36,'три года')]}),
  envelope('explain',{subject:{kind:'concept',question:pilotCases[1].question}}),
  envelope('calculate',{calculator:'loan',edits:[]},{mode:'reference',handle:'t1_v2',conditions:'pin'}),
  envelope('calculate',{calculator:'loan',edits:[set('payment','annuity','ануитентный')]},keep),
  envelope('compare',{scenarios:reverse?['t2','t3']:['t3','t2'],criterion:'interest',objective:'min'}),
  read('2025-10'),read('2025-09-01/2025-09-30'),compare(reverse?['t2','t1']:['t1','t2']),
 ];
}
for(const reverse of [false,true])test('all eight pilot turns preserve numerical meaning with '+(reverse?'permuted':'retained')+' comparison aliases',async()=>{
 const sessions={loan:new PrototypeSession(scope),read:new PrototypeSession(scope)},replies=responses(reverse);let reads=0;
 for(const [n,c]of pilotCases.entries()){
  const session=sessions[c.chain],environment=env(800+n,c.question);
  const services:Services={current:()=>environment,async authorize(){},async review(_input,reply){return reply.intent!==null&&pilotPreparationMatches(c.id,prepareTask(session.snapshot(),environment,reply.intent));},tools:{...tools,async read(q,t){reads++;return tools.read(q);}}};
  const result=await session.run(environment,{async understand(){return {relevance:'financial',intent:replies[n]};}},services);
  assert.equal(result.status,c.id==='loan-concept'?'explanation':'completed',c.id);
  if(result.status==='completed')assert.equal(pilotOutcomeMatches(c.id,result.outcome),true,c.id);
 }
 assert.equal(reads,3);assert.equal(sessions.loan.snapshot().history.length,4);assert.equal(sessions.read.snapshot().history.length,3);
});
test('comparison execution gets the same positive and negative category deltas for either alias order',async()=>{
 for(const order of [['t1','t2'],['t2','t1']]){
  let state=emptyState(scope),sequence=900;
  for(const [question,intent]of [['октябрь 2025',read('2025-10')],['А сентябрь?',read('2025-09')],['Сравни эти месяцы',compare(order)]] as const){
   const environment=env(++sequence,question),prepared=prepareTask(state,environment,intent);assert.equal(prepared.status,'ready');if(prepared.status!=='ready')throw Error('ready');
   const outcome=await executeTask(prepared.task,tools);state=finishTask(prepared.state,environment,prepared.task,outcome).state;
   if(sequence===903){assert.equal(pilotOutcomeMatches('read-compare',outcome),true);assert.equal(prepared.task.kind,'read');if(prepared.task.kind==='read')assert.equal(prepared.task.parent,'t1');}
  }
 }
});
test('incompatible category scopes, metrics and unknown aliases fail before a financial tool',async()=>{
 let state=emptyState(scope);
 for(const [n,month]of ['2025-10','2025-09'].entries()){
  const environment=env(950+n,month),p=prepareTask(state,environment,read(month));if(p.status!=='ready')throw Error('ready');state=finishTask(p.state,environment,p.task,await executeTask(p.task,tools)).state;
 }
 const environment=env(960,'Сравни эти месяцы'),before=structuredClone(state);
 assert.throws(()=>prepareTask(state,environment,compare(['t1','t999'])),/TASK_REFERENCE_INVALID/);
 assert.throws(()=>prepareTask({...state,active:null},environment,compare(['t1','t2'])),/TASK_CONTEXT_MISSING/);
 const wrongClarification=compare(['t1','t2']) as any;wrongClarification.binding={mode:'answer',clarification:'q999',option:null};assert.throws(()=>prepareTask(state,environment,wrongClarification),/TASK_CLARIFICATION_REFERENCE_INVALID/);
 for(const field of ['category','metric','amount']){
  const changed=structuredClone(state),task=changed.history[1]!;if(task.kind!=='read')throw Error('read');
  if(field==='category')task.node.query.filter.categoryIds=[taxi];else if(field==='metric')task.node.query.metric='income';else {task.node.query.filter.amountFrom='100';task.node.query.filter.amountBasis='absolute_operation';}
  assert.throws(()=>prepareTask(changed,environment,compare(['t1','t2'])),/TASK_COMPARISON_SCOPE_MISMATCH/);
 }assert.deepEqual(state,before);
});
test('a correct total cannot hide an inverted or incorrect category breakdown',()=>{
 const outcome:any={kind:'read',result:{totals:{expenses:'16800'},previousTotals:{expenses:'12000'},points:[{label:'Продукты',values:{expenses:'15000'},previous:{expenses:'10000'}},{label:'Такси',values:{expenses:'1800'},previous:{expenses:'2000'}}]}};
 assert.equal(pilotOutcomeMatches('read-compare',outcome),true);
 for(const corrupt of [(v:any)=>v.result.points.reverse().forEach((p:any)=>[p.values,p.previous]=[p.previous,p.values]),(v:any)=>v.result.points[0].values.expenses='14999',(v:any)=>v.result.points.pop()]){const bad=structuredClone(outcome);corrupt(bad);assert.equal(pilotOutcomeMatches('read-compare',bad),false);}
});
