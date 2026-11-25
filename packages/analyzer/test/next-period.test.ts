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
