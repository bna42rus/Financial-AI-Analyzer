import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareTask,emptyState} from '../src/next/tasks.ts';
import {intentVersion} from '../src/next/intent.ts';
import {scope,catalog,id,account} from './fixtures/next-finances.ts';
// Parameter fields transcribed from the operator's diagnostic screenshot.
// Presentation was not printed there; both supported forms are tested.
const question='За октябрь 2025 выведи траты по категориям со счёта «Учебный счёт». Сумма каждой операции строго больше 100 рублей.';
const raw=(amount='>=100',name='Учебный счет',format='auto')=>({version:intentVersion,action:'read',binding:{mode:'new'},parameters:{metric:'expenses',grouping:'category',comparison:null,conditions:[{field:'period',op:'set',expression:'2025-10-01/2025-10-31'},{field:'accounts',op:'set',expression:name},{field:'amount',op:'set',expression:amount}],options:{}},presentation:{format,detail:'normal'}});
const env=(text=question)=>({scope,requestId:id(930),question:text,date:'2026-11-25',global:{revision:0,filter:{accountIds:[account]},touched:{}},accessRevision:'synthetic/1',dataRevision:'synthetic/1',catalog});
test('observed canonical dates and ё spelling never hide a wrong inclusive money bound',()=>{
 for(const format of ['auto','table'])for(const name of ['Учебный счёт','Учебный счет'])assert.throws(()=>prepareTask(emptyState(scope),env(),raw('>=100',name,format)),/TASK_AMOUNT_LITERAL_REQUIRED/);
});
test('source literal keeps the strict one-cent boundary while equivalent account spelling binds the same owned account',()=>{
 const p=prepareTask(emptyState(scope),env(),raw('строго больше 100 рублей'));
 assert.equal(p.status,'ready');if(p.status!=='ready'||p.task.kind!=='read')throw Error('read');
 assert.deepEqual(p.task.node.query.filter,{accountIds:[account],from:'2025-10-01',through:'2025-10-31',amountBasis:'absolute_operation',amountFrom:'10001'});
});
test('name normalization accepts only whole catalog names, not fragments, foreign names or a shorter overlapping name',()=>{
 for(const name of ['Учебный','счет','Чужой счёт'])assert.throws(()=>prepareTask(emptyState(scope),env(),raw('строго больше 100 рублей',name)),/TASK_(?:ENTITY|EVIDENCE)/);
 const e=env(question.replaceAll('Учебный счёт','Учебный счёт Плюс'));e.catalog=structuredClone(catalog);e.catalog.accounts.push({...catalog.accounts[0]!,id:id(932),name:'Учебный счёт Плюс'});
 assert.throws(()=>prepareTask(emptyState(scope),e,{...raw('строго больше 100 рублей'),parameters:{...raw().parameters,conditions:[{field:'accounts',op:'set',expression:'Учебный счет'}]}}),/TASK_EVIDENCE_MISSING|TASK_ENTITY/);
});
test('duplicate normalized names and a changed year are rejected; a literal negation retains its inclusive upper bound',()=>{
 const e=env();e.catalog=structuredClone(catalog);e.catalog.accounts.push({...catalog.accounts[0]!,id:id(931),name:'Учебный счет'});
 assert.throws(()=>prepareTask(emptyState(scope),e,raw('строго больше 100 рублей')),/TASK_ENTITY_AMBIGUOUS/);
 assert.throws(()=>prepareTask(emptyState(scope),env(question.replace('октябрь 2025','октябрь 2024')),raw('строго больше 100 рублей')),/TASK_PERIOD/);
 const p=prepareTask(emptyState(scope),env(question.replace('строго больше','не больше')),raw('не больше 100 рублей'));if(p.status!=='ready'||p.task.kind!=='read')throw Error('read');assert.equal(p.task.node.query.filter.amountFrom,undefined);assert.equal(p.task.node.query.filter.amountThrough,'10000');
});
