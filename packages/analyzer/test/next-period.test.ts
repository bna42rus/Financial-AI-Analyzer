import {test} from 'node:test';
import assert from 'node:assert/strict';
import {periodExpression} from '../src/next/period.ts';
import {intentVersion} from '../src/next/intent.ts';
import {prepareTask,emptyState} from '../src/next/tasks.ts';
import {pilotPreparationMatches,pilotCases} from '../src/next/pilot.ts';
import {PrototypeSession} from '../src/next/workflow.ts';
import {calculateWidget,parseWidget} from '../../finance-core/src/overview.ts';
import {id,scope,account,catalog,rows} from './fixtures/next-finances.ts';
const date='2026-11-25';
const interval=(from:string,through:string)=>({from,through});
test('canonical month, day and interval are accepted only when actual question evidence resolves identically',()=>{
 for(const [expression,question,from,through] of [
  ['2025-10','Покажи расходы за октябрь 2025 по категориям.','2025-10-01','2025-10-31'],
  ['2024-02','Расходы за февраль 2024 года','2024-02-01','2024-02-29'],
  ['2025-02','Расходы за февраль 2025','2025-02-01','2025-02-28'],
  ['2025-10','Расходы за октябрь (2025)','2025-10-01','2025-10-31'],
  ['2025-10','За октябрь—2025','2025-10-01','2025-10-31'],
  ['2025-10','За октябрь, 2025','2025-10-01','2025-10-31'],
  ['2025-10','Покажи за 2025-10','2025-10-01','2025-10-31'],
  ['2026-11-24','Что было вчера?','2026-11-24','2026-11-24'],
  ['2025-10-03/2025-10-17','С 3 по 17 октября 2025 включительно','2025-10-03','2025-10-17'],
  ['2025-10-01 по 2025-10-31','За октябрь 2025','2025-10-01','2025-10-31'],
  ['2025-10-01 .. 2025-10-31','За октябрь 2025','2025-10-01','2025-10-31'],
  ['2025-10-01/2025-10-31','За октябрь 2025','2025-10-01','2025-10-31'],
 ])assert.deepEqual(periodExpression(expression!,question!,date),interval(from!,through!));
});
test('format normalization cannot invent a month, omit an explicit year, expand a day or narrow a range',()=>{
 for(const [expression,question] of [
  ['2026-10','октябрь 2025'],['2025-09','октябрь 2025'],['2025-10','октябрь 2024'],
  ['2025-10','2025-10-31'],['2025-10-31','с 2025-10-01 по 2025-10-31'],
  ['2025-10','Покажи мои расходы'],['2025-10','с 3 по 17 октября 2025'],
 ])assert.throws(()=>periodExpression(expression!,question!,date),/TASK_(?:PERIOD|EVIDENCE)/);
});
test('invalid dates and ambiguous periods remain rejected',()=>{
 for(const expression of ['2025-13','2025-02-30','2025-10-31/2025-10-01'])assert.throws(()=>periodExpression(expression,expression,date));
 assert.throws(()=>periodExpression('2025-10','Октябрь 2025 или сентябрь 2025',date),/EVIDENCE_AMBIGUOUS/);
 assert.throws(()=>periodExpression('2025-10','x'.repeat(2001),date),/UNSUPPORTED/);
});
test('bare month inherits only an unambiguous previous year; relative dates still use today',()=>{
 const previous=interval('2025-10-01','2025-10-31');
 assert.deepEqual(periodExpression('2025-09','А сентябрь?',date,previous),interval('2025-09-01','2025-09-30'));
 assert.deepEqual(periodExpression('За сентябрь','За сентябрь',date,previous),interval('2025-09-01','2025-09-30'));
 assert.deepEqual(periodExpression('2026-11-24','вчера',date,previous),interval('2026-11-24','2026-11-24'));
 assert.throws(()=>periodExpression('2026-09','сентябрь',date,previous),/EVIDENCE_MISMATCH/);
 assert.throws(()=>periodExpression('2025-09','сентябрь',date,interval('2024-10-01','2025-10-31')));
});
test('contextual year qualifiers use the selected task for every month, spelling and bounded interval',()=>{
 const previous=interval('2024-10-01','2024-10-31');
 for(const [month,index] of ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'].map((m,i)=>[m,i+1] as const)){
  const prefix=`2024-${String(index).padStart(2,'0')}-`,end=new Date(prefix+'01T00:00:00Z');end.setUTCMonth(end.getUTCMonth()+1,0);
  for(const expression of [`${month} того же года`,`в том же году ${month}`])assert.deepEqual(periodExpression(expression,expression,date,previous),interval(prefix+'01',end.toISOString().slice(0,10)));
 }
 assert.deepEqual(periodExpression('2024-09','Теперь сентябрь того же года. Прочие условия оставь прежними.',date,previous),interval('2024-09-01','2024-09-30'));
 assert.deepEqual(periodExpression('С 3 по 17 сентября того же года включительно','С 3 по 17 сентября того же года включительно',date,previous),interval('2024-09-03','2024-09-17'));
 assert.deepEqual(periodExpression('за сент. того же года','За сент. того же года',date,previous),interval('2024-09-01','2024-09-30'));
 assert.deepEqual(periodExpression('октябярь того же года','За октябярь того же года',date,previous),interval('2024-10-01','2024-10-31'));
});
test('calendar-relative years use today and do not inherit a historical task year',()=>{
 const previous=interval('2020-10-01','2020-10-31');
 for(const [phrase,year] of [['прошлого',2025],['предыдущего',2025],['текущего',2026],['этого',2026],['следующего',2027],['будущего',2027]] as const){
  const question=`За сентябрь ${phrase} года`;
  assert.deepEqual(periodExpression(`${year}-09`,question,date,previous),interval(`${year}-09-01`,`${year}-09-30`));
 }
});
test('missing, ambiguous, conflicting or unsupported year qualifiers cannot leave a smaller bare-month fallback',()=>{
 const question='Сентябрь того же года';
 for(const previous of [{},{from:'2025-01-01'},{through:'2025-12-31'},interval('2024-12-01','2025-01-31')]){
  assert.throws(()=>periodExpression(question,question,date,previous),/TASK_PERIOD_YEAR_/);
  assert.throws(()=>periodExpression('2026-09',question,date,previous),/TASK_(?:PERIOD|EVIDENCE)/);
 }
 const previous=interval('2025-10-01','2025-10-31');
 for(const [expression,source] of [
  ['2026-09',question],['сентябрь 2024 того же года','сентябрь 2024 того же года'],
  ['2025-09','сентябрь непонятного года'],['2025-09','с 19 по 3 сентября того же года'],
 ] as const)assert.throws(()=>periodExpression(expression,source,date,previous),/TASK_(?:PERIOD|EVIDENCE)/);
});
// Exact synthetic read-new reply retained by the live pilot (no private data).
const retained={relevance:'financial',intent:{version:intentVersion,action:'read',binding:{mode:'new'},parameters:{metric:'expenses',grouping:'category',comparison:null,conditions:[{field:'period',op:'set',expression:'2025-10'}],options:{}},presentation:{format:'auto',detail:'normal'}}};
const env={scope,requestId:id(800),question:pilotCases.find(c=>c.id==='read-new')!.question,date,global:{revision:0,filter:{accountIds:[account]},touched:{}},dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog};
test('retained read-new payload now prepares the correct scope and passes the unchanged semantic oracle',()=>{
 const p=prepareTask(emptyState(scope),env,retained.intent);assert.equal(pilotPreparationMatches('read-new',p),true);
 if(p.status!=='ready'||p.task.kind!=='read')throw Error('Expected read');
 assert.deepEqual(p.task.node.query.filter,{accountIds:[account],from:'2025-10-01',through:'2025-10-31'});
 const original=structuredClone(retained);prepareTask(emptyState(scope),env,retained.intent);assert.deepEqual(retained,original);
});
test('retained payload traverses the workflow and calculates real fixture totals without a repair call',async()=>{
 let calls=0;const session=new PrototypeSession(scope);
 const result=await session.run(env,{async understand(){calls++;return retained;}},{current:()=>({scope,dataRevision:env.dataRevision,accessRevision:env.accessRevision}),async authorize(){},async review(_input,reply){return reply.intent!==null&&pilotPreparationMatches('read-new',prepareTask(session.snapshot(),env,reply.intent));},tools:{async guard(){},async read(query){return calculateWidget(parseWidget({id:id(900),name:'Синтетическая выборка',metrics:[query.metric],grouping:query.grouping,filter:query.filter,chart:'table'}),rows,catalog,{},new Date(date+'T12:00:00Z'),'Europe/Moscow',true);}}});
 assert.equal(result.status,'completed');if(result.status!=='completed'||result.outcome.kind!=='read')return;
 assert.equal(result.outcome.result.totals.expenses,'16800');assert.equal(calls,1);
});
