import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateWidget,parseWidget} from '../../finance-core/src/overview.ts';
import {PrototypeSession} from '../src/next/workflow.ts';
import type {Provider,ProviderInput,Services,AccessContext} from '../src/next/workflow.ts';
import type {Environment} from '../src/next/tasks.ts';
import {intentVersion} from '../src/next/intent.ts';
import {id,scope,account,food,catalog,rows} from './fixtures/next-finances.ts';
const base=(action:string,parameters:unknown,binding:unknown={mode:'new'},format='auto')=>({version:intentVersion,action,parameters,binding,presentation:{format,detail:'normal'}});
const keep={mode:'continue',conditions:'merge_ui'};
const read=(month:string|null,metric:string|null='expenses',binding:unknown={mode:'new'},grouping:string|null=null)=>base('read',{metric,grouping,comparison:null,conditions:month?[{field:'period',op:'set',expression:month}]:[],options:{}},binding);
const loan=(edits:unknown[],binding:unknown={mode:'new'},format='auto')=>base('calculate',{calculator:'loan',edits},binding,format);
const set=(field:string,value:unknown,quote:string)=>({field,op:'set',value,quote});
const financial=(intent:unknown)=>({relevance:'financial',intent});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function harness(){
 const session=new PrototypeSession(scope),context:AccessContext={scope:structuredClone(scope),accessRevision:'a1',dataRevision:'r1'};
 let serial=300,calls=0,reads=0,allowed=true,approved=true;
 const inputs:ProviderInput[]=[],data=structuredClone(rows);
 const services:Services={current:()=>structuredClone(context),async authorize(){if(!allowed)throw Error('private access exception');},async review(){return approved;},tools:{async guard(){if(!allowed)throw Error('private access exception');},async read(query){reads++;return calculateWidget(parseWidget({id:id(900),name:'Учебная выборка',metrics:[query.metric],grouping:query.grouping,filter:query.filter,comparison:query.comparison==='custom'?{kind:'custom',...query.options?.comparisonPeriod}:{kind:query.comparison},chart:'table',topN:50}),data,catalog,{},new Date('2026-11-25T12:00:00Z'),'Europe/Moscow',true);}}};
 const h={session,context,services,inputs,data,get calls(){return calls;},get reads(){return reads;},set allowed(value:boolean){allowed=value;},set approved(value:boolean){approved=value;},
  reply:async (_input:ProviderInput):Promise<unknown>=>financial(read('октябрь 2025')),
  env(question:string):Environment{return {scope:structuredClone(scope),requestId:id(++serial),question,date:'2026-11-25',global:{revision:0,filter:{accountIds:[account]},touched:{}},dataRevision:context.dataRevision,accessRevision:context.accessRevision,catalog};},
  async turn(question:string,intent:unknown){this.reply=async()=>financial(intent);return session.run(this.env(question),provider,services);},
  provider:null as unknown as Provider};
 const provider:Provider={async understand(input){calls++;inputs.push(structuredClone(input));return h.reply(input);}};h.provider=provider;return h;
}
test('provider boundary drives the full month chain; only minimal context crosses it',async()=>{
 const h=harness();assert.equal((await h.turn('октябрь 2025',read('октябрь 2025'))).status,'completed');
 await h.turn('А по категориям?',read(null,null,keep,'category'));await h.turn('А сентябрь?',read('сентябрь',null,keep));
 const r=await h.turn('Сравни эти месяцы',base('compare',{scenarios:['t3','t2'],criterion:'value',objective:'max'},keep));
 assert.equal(r.status,'completed');if(r.status!=='completed'||r.outcome.kind!=='read')return;
 assert.equal(r.outcome.result.totals.expenses,'16800');assert.equal(r.outcome.result.previousTotals.expenses,'12000');assert.equal(h.reads,4);assert.equal(h.calls,4);
 const input=h.inputs.at(-1)!;assert.equal(input.context.active,'t3');assert.equal(input.context.tasks.length,3);
 const serialized=JSON.stringify(h.inputs);for(const hidden of [scope.ownerId,scope.chatId,account,food,rows[0]!.id,'row-expected-result','principalMinor'])assert.ok(!serialized.includes(hidden));
 assert.deepEqual(Object.keys(input).sort(),['context','date','question','version']);
});
test('provider boundary drives missing loan, explanation, typo choice, comparison and all payment rows',async()=>{
 const h=harness();let r=await h.turn('120000, 12 месяцев',loan([set('principalRubles','120000','120000'),set('months',12,'12 месяцев')]));assert.equal(r.status,'waiting');
 assert.ok(r.status==='waiting'&&!('state' in r.preparation));const before=h.session.snapshot();
 await h.turn('Что такое ставка?',base('explain',{subject:{kind:'concept',question:'Что такое ставка?'}},keep));assert.deepEqual(h.session.snapshot(),before);
 const pending=h.session.snapshot().pending!;
 r=await h.turn('12%',loan([set('annualRatePercent','12','12%')],{mode:'answer',clarification:pending.handle,option:null}));assert.equal(r.status,'completed');
 await h.turn('дифференцированный',loan([set('payment','differentiated','дифференцированный')],keep));
 await h.turn('а ануитентный',loan([set('payment','annuity','ануитентный')],keep));
 await h.turn('25% для обоих',loan([set('annualRatePercent','25','25%'),{field:'payment',op:'clear'}],keep));
 const active=h.session.snapshot().active!;
 r=await h.turn('Что выгоднее?',base('compare',{scenarios:[active+'_v1',active+'_v2'],criterion:'interest',objective:'min'},keep));
 assert.equal(r.status,'completed');if(r.status!=='completed'||r.outcome.kind!=='loan_comparison')return;assert.deepEqual(r.outcome.winnerIndexes,[1]);
 r=await h.turn('График платежей и процентов',loan([],keep,'chart'));assert.equal(r.status,'completed');if(r.status!=='completed'||r.outcome.kind!=='loan')return;
 assert.ok(r.outcome.results.every(v=>v.rows.length===12));assert.equal(h.reads,0);
});
test('concurrent repeat shares one provider call and one financial read',async()=>{
 const h=harness(),gate=deferred<unknown>(),started=deferred<void>();h.reply=async()=>{started.resolve();return gate.promise;};
 const env=h.env('октябрь 2025'),first=h.session.run(env,h.provider,h.services);await started.promise;
 const second=h.session.run(structuredClone(env),h.provider,h.services);gate.resolve(financial(read('октябрь 2025')));
 const [a,b]=await Promise.all([first,second]);assert.equal(a.status,'completed');assert.equal(b.status,'completed');assert.equal(b.replayed,true);assert.equal(b.understandingCalls,0);assert.equal(h.calls,1);assert.equal(h.reads,1);assert.equal(h.session.snapshot().history.length,1);
});
test('request ID reuse with different text or UI conditions fails without another call',async()=>{
 const h=harness(),env=h.env('октябрь 2025');await h.session.run(env,h.provider,h.services);
 for(const altered of [{...env,question:'сентябрь 2025'},{...env,global:{revision:1,filter:{},touched:{}}}]){
  const r=await h.session.run(altered,h.provider,h.services);assert.equal(r.status,'failed');if(r.status==='failed')assert.equal(r.code,'REQUEST_ID_CONFLICT');
 }assert.equal(h.calls,1);assert.equal(h.reads,1);
});
test('cached result rechecks access and marks an older snapshot without changing active state',async()=>{
 const h=harness(),env=h.env('октябрь 2025');const original=await h.session.run(env,h.provider,h.services);assert.equal(original.status,'completed');
 h.context.dataRevision='r2';const before=h.session.snapshot(),cached=await h.session.run(env,h.provider,h.services);assert.equal(cached.replayed,true);assert.equal(cached.historical,true);assert.deepEqual(h.session.snapshot(),before);
 h.allowed=false;const denied=await h.session.run(env,h.provider,h.services);assert.equal(denied.status,'failed');assert.ok(!JSON.stringify(denied).includes('totals'));assert.equal(h.calls,1);
});
test('provider exceptions and malformed replies expose only fixed codes; neither is retried automatically',async()=>{
 for(const value of ['throw','malformed','conflict']){
  const h=harness();h.reply=async()=>{if(value==='throw')throw Error('private-provider-dump');if(value==='conflict')return {relevance:'unrelated',intent:read('октябрь 2025')};return {relevance:'financial',intent:{sql:'private-sql-dump'}};};
  const env=h.env('октябрь 2025'),r=await h.session.run(env,h.provider,h.services);assert.equal(r.status,'failed');assert.equal(h.reads,0);assert.ok(!JSON.stringify(r).includes('private-'));await h.session.run(env,h.provider,h.services);assert.equal(h.calls,1);assert.equal(h.session.snapshot().history.length,0);
 }
});
test('semantic rejection blocks structurally valid intent before financial reads',async()=>{
 const h=harness();h.approved=false;const r=await h.session.run(h.env('октябрь 2025'),h.provider,h.services);assert.equal(r.status,'failed');if(r.status==='failed')assert.equal(r.code,'SEMANTIC_REVIEW_REJECTED');assert.equal(h.reads,0);assert.equal(h.calls,1);
});
test('unrelated and ambiguous replies perform no financial read or new task transition',async()=>{
 for(const relevance of ['unrelated','ambiguous']){const h=harness();h.reply=async()=>({relevance,intent:null});const before=h.session.snapshot();const r=await h.session.run(h.env('Вопрос без финансовой задачи'),h.provider,h.services);assert.equal(r.status,relevance);assert.deepEqual(h.session.snapshot(),before);assert.equal(h.reads,0);}
});
test('late understanding is discarded before preparation and does not run a financial tool',async()=>{
 const h=harness(),gate=deferred<unknown>(),started=deferred<void>();h.reply=async()=>{started.resolve();return gate.promise;};
 const old=h.session.run(h.env('октябрь 2025'),h.provider,h.services);await started.promise;
 const newer=await h.turn('сентябрь 2025',read('сентябрь 2025'));assert.equal(newer.status,'completed');gate.resolve(financial(read('октябрь 2025')));
 const r=await old;assert.equal(r.status,'discarded');assert.equal(h.reads,1);const stored=h.session.snapshot().history[0]!;if(stored.kind!=='read')return;assert.equal(stored.node.query.filter.from,'2025-09-01');
});
test('late tool completion cannot replace a newer independent task',async()=>{
 const h=harness(),gate=deferred<void>(),started=deferred<void>(),original=h.services.tools.read;
 h.services.tools.read=async(q,t)=>{started.resolve();await gate.promise;return original(q,t);};
 const old=h.session.run(h.env('октябрь 2025'),h.provider,h.services);await started.promise;
 await h.turn('120000, 12%, 12 месяцев',loan([set('principalRubles','120000','120000'),set('annualRatePercent','12','12%'),set('months',12,'12 месяцев')]));
 gate.resolve();const r=await old;assert.equal(r.status,'discarded');assert.equal(h.session.snapshot().history.length,1);assert.equal(h.session.snapshot().history[0]?.kind,'loan');
});
test('revocation or generation change during understanding blocks private data access',async()=>{
 for(const change of ['access','generation']){const h=harness(),gate=deferred<unknown>(),started=deferred<void>();h.reply=async()=>{started.resolve();return gate.promise;};const pending=h.session.run(h.env('октябрь 2025'),h.provider,h.services);await started.promise;
  if(change==='access')h.allowed=false;else h.context.scope={...scope,generation:id(999)};gate.resolve(financial(read('октябрь 2025')));const r=await pending;assert.equal(r.status,'failed');assert.equal(h.reads,0);assert.equal(h.session.snapshot().history.length,0);
 }
});
test('data revision changed during understanding is freshly read, never copied from an old result',async()=>{
 const h=harness(),gate=deferred<unknown>(),started=deferred<void>();h.reply=async()=>{started.resolve();return gate.promise;};const pending=h.session.run(h.env('сентябрь 2025'),h.provider,h.services);await started.promise;
 h.context.dataRevision='r2';h.data[0]!.amountMinor='-30000';h.data[0]!.parts[0]!.amountMinor='-30000';gate.resolve(financial(read('сентябрь 2025')));
 const r=await pending;assert.equal(r.status,'completed');if(r.status!=='completed'||r.outcome.kind!=='read')return;assert.equal(r.asOfRevision,'r2');assert.equal(r.outcome.result.totals.expenses,'32000');
});
test('tool failure clears running state, preserves error code, and does not create a successful task',async()=>{
 const h=harness();h.services.tools.read=async()=>{throw Error('private database detail');};const r=await h.session.run(h.env('октябрь 2025'),h.provider,h.services);assert.equal(r.status,'failed');if(r.status==='failed')assert.equal(r.code,'TOOL_FAILED');assert.equal(h.session.snapshot().running,null);assert.equal(h.session.snapshot().history.length,0);
});
test('unsanitized input and unauthorized or foreign sessions fail before provider invocation',async()=>{
 const h=harness();await h.session.run(h.env('contact@example.invalid'),h.provider,h.services);h.allowed=false;await h.session.run(h.env('октябрь 2025'),h.provider,h.services);h.allowed=true;
 await h.session.run({...h.env('октябрь 2025'),scope:{...scope,ownerId:'another-owner'}},h.provider,h.services);assert.equal(h.calls,0);assert.equal(h.reads,0);
});
test('provider and caller mutations cannot poison server state or cached outcomes',async()=>{
 const h=harness();h.reply=async input=>{input.context.active='forged';return financial(read('октябрь 2025'));};const env=h.env('октябрь 2025');const r=await h.session.run(env,h.provider,h.services);assert.equal(r.status,'completed');if(r.status!=='completed'||r.outcome.kind!=='read')return;
 r.outcome.result.totals.expenses='999999';const cached=await h.session.run(env,h.provider,h.services);if(cached.status!=='completed'||cached.outcome.kind!=='read')return;assert.equal(cached.outcome.result.totals.expenses,'16800');assert.equal(h.session.snapshot().active,'t1');
});
test('in-memory request journal is bounded and refuses new calls at capacity',async()=>{
 const h=harness();h.reply=async()=>({relevance:'ambiguous',intent:null});for(let i=0;i<100;i++)await h.session.run(h.env('Что уточнить?'),h.provider,h.services);
 const r=await h.session.run(h.env('Ещё вопрос'),h.provider,h.services);assert.equal(r.status,'failed');if(r.status==='failed')assert.equal(r.code,'SESSION_REQUEST_LIMIT');assert.equal(h.calls,100);assert.equal(h.reads,0);
});
test('an explanation preserves an already running financial task',async()=>{
 const h=harness(),gate=deferred<void>(),started=deferred<void>(),original=h.services.tools.read;
 h.services.tools.read=async(q,t)=>{started.resolve();await gate.promise;return original(q,t);};
 const pending=h.session.run(h.env('октябрь 2025'),h.provider,h.services);await started.promise;
 const explanation=await h.turn('Что такое расходы?',base('explain',{subject:{kind:'concept',question:'Что такое расходы?'}},keep));assert.equal(explanation.status,'explanation');
 gate.resolve();assert.equal((await pending).status,'completed');assert.equal(h.session.snapshot().history.length,1);
});
test('a late semantic review cannot launch a superseded task',async()=>{
 const h=harness(),gate=deferred<boolean>(),started=deferred<void>();let reviews=0;
 h.services.review=async()=>{if(++reviews===1){started.resolve();return gate.promise;}return true;};
 const pending=h.session.run(h.env('октябрь 2025'),h.provider,h.services);await started.promise;
 await h.turn('сентябрь 2025',read('сентябрь 2025'));gate.resolve(true);assert.equal((await pending).status,'discarded');assert.equal(h.reads,1);
});
