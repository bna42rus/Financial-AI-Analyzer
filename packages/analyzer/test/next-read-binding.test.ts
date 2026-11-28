import {assistantAmountLiteral} from '../src/assistant-money.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReadBinding} from '../src/next/read-binding.ts';
import {intentVersion} from '../src/next/intent.ts';
import type {Intent} from '../src/next/intent.ts';
import type {Query} from '../src/registry.ts';
import {emptyState,prepareTask,executeTask,finishTask} from '../src/next/tasks.ts';
import type {Environment,Preparation} from '../src/next/tasks.ts';
import {pilotPreparationMatches,pilotCases} from '../src/next/pilot.ts';
import {calculateWidget,parseWidget} from '../../finance-core/src/overview.ts';
import {scope,id,account,food,taxi,catalog,rows} from './fixtures/next-finances.ts';
const date='2026-11-25',query:Query={name:'query_finances',metric:'expenses',grouping:'category',comparison:'none',filter:{from:'2025-10-01',through:'2025-10-31',accountIds:[account],categoryIds:[food]},options:{statistic:'sum'}};
function intent(field='period',expression='2025-09-01/2025-09-30'):Extract<Intent,{action:'read'}>{return {version:intentVersion,action:'read',binding:{mode:'new'},parameters:{metric:'expenses',grouping:'category',comparison:'none',conditions:[{field:field as any,op:'set',expression}],options:{}},presentation:{format:'auto',detail:'normal'}};}
function ready(p:Preparation){assert.equal(p.status,'ready');if(p.status!=='ready')throw Error(p.status);return p;}
async function setup(){
 const env:Environment={scope,requestId:id(820),question:pilotCases.find(c=>c.id==='read-new')!.question,date,global:{revision:0,filter:{accountIds:[account]},touched:{}},dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog};
 const first=ready(prepareTask(emptyState(scope),env,intent('period','2025-10')));
 const services={async guard(){},async read(q:Query){return calculateWidget(parseWidget({id:id(900),name:'Синтетическая выборка',metrics:[q.metric],grouping:q.grouping,filter:q.filter,chart:'table'}),rows,catalog,{},new Date(date+'T12:00:00Z'),'Europe/Moscow',true);}};
 const outcome=await executeTask(first.task,services),state=finishTask(first.state,env,first.task,outcome).state;
 return {env:{...env,requestId:id(821),question:'А сентябрь?'},state,services};
}
test('retained read-month with mode=new binds to the active read and passes the unchanged oracle',async()=>{
 const h=await setup(),raw=intent(),copy=structuredClone(raw),p=ready(prepareTask(h.state,h.env,raw));assert.equal(pilotPreparationMatches('read-month',p),true);
 if(p.task.kind!=='read')return;assert.equal(p.task.node.parent,id(820));assert.deepEqual(p.task.node.query.filter,{accountIds:[account],from:'2025-09-01',through:'2025-09-30'});
 const result=await executeTask(p.task,h.services);if(result.kind!=='read')return;assert.equal(result.result.totals.expenses,'12000');assert.deepEqual(raw,copy);
});
test('recovery covers arbitrary literal periods, amount thresholds and exact names',()=>{
 for(const [question,field,expression]of [
  ['А январь?','period','2025-01'],['Теперь вчера','period','2026-11-24'],['А последние 7 дней?','period','последние 7 дней'],
  ['А больше 1 тыс.?','amount','>1000'],['Тогда Продукты?','categories','продукты'],['А Учебный счёт?','accounts','Учебный счёт'],
  ['И получатель?','counterparties','получатель'],['А магазин?','merchant','магазин'],
 ]){const result=normalizeReadBinding(intent(field,expression),query,question!,date,false,{accounts:['Учебный счёт'],categories:['Продукты'],counterparties:['получатель'],merchant:['магазин']});assert.deepEqual(result.binding,{mode:'continue',conditions:'merge_ui'},question);if(result.action==='read'){assert.equal(result.parameters.metric,null);assert.equal(result.parameters.grouping,null);assert.equal(result.parameters.comparison,null);}}
});
test('model-carried defaults cannot overwrite unrequested metric, comparison or statistics',()=>{
 const input=intent();input.parameters.metric='income';input.parameters.grouping='none';input.parameters.options={statistic:'mean'};
 const result=normalizeReadBinding(input,{...query,comparison:'previous_month'},'А сентябрь?',date);
 if(result.action!=='read')throw Error('read');assert.deepEqual(result.parameters.options,{});assert.equal(result.parameters.metric,null);assert.equal(result.parameters.comparison,null);
});
test('independent financial questions, new-topic markers and negations are not rebound',()=>{
 for(const question of ['Покажи расходы за сентябрь','А мои доходы за сентябрь?','Новый вопрос: сентябрь','Новая тема: сентябрь','Сравни октябрь и сентябрь','А сентябрь без такси?','Нет, не сентябрь'])assert.deepEqual(normalizeReadBinding(intent(),query,question,date),intent(),question);
});
test('unknown names and arbitrary merchant prose cannot manufacture condition-only evidence',()=>{
 for(const question of ['Покажи расходы за сентябрь','Новая тема: доходы','Не такси'])assert.deepEqual(normalizeReadBinding(intent('merchant',question),query,question,date),intent('merchant',question));
 assert.deepEqual(normalizeReadBinding(intent('categories','Неизвестная'),query,'А Неизвестная?',date),intent('categories','Неизвестная'));
});
test('explicit binding, missing/incompatible context and pending/running work are preserved',()=>{
 const raw=intent();assert.deepEqual(normalizeReadBinding(raw,null,'А сентябрь?',date),raw);assert.deepEqual(normalizeReadBinding(raw,query,'А сентябрь?',date,true),raw);
 for(const binding of [{mode:'reference',handle:'t1',conditions:'pin'},{mode:'answer',clarification:'q1',option:null},{mode:'continue',conditions:'pin'}]){
  const explicit={...raw,binding} as Intent;assert.deepEqual(normalizeReadBinding(explicit,query,'А сентябрь?',date),explicit);
 }
 const multi=intent();multi.parameters.conditions.push({field:'categories',op:'clear'});assert.deepEqual(normalizeReadBinding(multi,query,'А сентябрь?',date),multi);
});
test('wrong month/year, amount inequality and ambiguous year cannot fall back to a fresh task',()=>{
 assert.throws(()=>normalizeReadBinding(intent('period','2026-09'),query,'А сентябрь?',date),/MISMATCH/);
 assert.throws(()=>normalizeReadBinding(intent('period','2025-08'),query,'А сентябрь?',date),/MISMATCH/);
 assert.throws(()=>normalizeReadBinding(intent('amount','>=1000'),query,'А больше 1000?',date),/CONFLICT/);
 assert.throws(()=>normalizeReadBinding(intent(),{...query,filter:{from:'2024-01-01',through:'2025-12-31'}},'А сентябрь?',date));
});
test('only the requested filter changes; current UI fields are merged before the explicit period',async()=>{
 const h=await setup();h.env.global={revision:1,filter:{from:'2024-10-01',through:'2024-10-31',accountIds:[account],categoryIds:[taxi]},touched:{period:1,categories:1}};
 const p=ready(prepareTask(h.state,h.env,intent()));if(p.task.kind!=='read')return;
 assert.equal(p.task.node.query.filter.from,'2024-09-01');assert.deepEqual(p.task.node.query.filter.categoryIds,[taxi]);assert.equal(p.task.node.query.grouping,'category');
});
test('an explicit same-year reference keeps the chosen task year even after the UI period changes',async()=>{
 const h=await setup();h.env.question='Теперь сентябрь того же года.';
 h.env.global={revision:1,filter:{from:'2024-10-01',through:'2024-10-31',accountIds:[account],categoryIds:[taxi]},touched:{period:1,categories:1}};
 const raw=intent('period','сентябрь того же года');raw.binding={mode:'continue',conditions:'merge_ui'};raw.parameters.metric=null;raw.parameters.grouping=null;
 const p=ready(prepareTask(h.state,h.env,raw));if(p.task.kind!=='read')throw Error('read');
 assert.equal(p.task.node.query.filter.from,'2025-09-01');assert.equal(p.task.node.query.filter.through,'2025-09-30');assert.deepEqual(p.task.node.query.filter.categoryIds,[taxi]);assert.equal(p.task.node.query.grouping,'category');
 const fresh={...raw,binding:{mode:'new'} as const};assert.throws(()=>prepareTask(emptyState(scope),h.env,fresh),/TASK_PERIOD_YEAR_CONTEXT_REQUIRED/);
 const short=normalizeReadBinding(intent('period','сентябрь того же года'),query,'А сентябрь того же года?',date);assert.equal(short.binding.mode,'continue');
});

test('explicit strict wording preserves one-cent boundaries and never removes a negation',()=>{
 assert.equal(assistantAmountLiteral('строго больше 100 рублей','absolute_operation').amountFrom,'10001');
 assert.equal(assistantAmountLiteral('строго меньше 100 рублей','absolute_operation').amountThrough,'9999');
 assert.equal(assistantAmountLiteral('строго больше 0,01 рубля','absolute_operation').amountFrom,'2');
 for(const text of ['строго не меньше 100 рублей','не строго больше 100 рублей','строго больше 100 рублей включительно'])assert.throws(()=>assistantAmountLiteral(text,'absolute_operation'));
});
