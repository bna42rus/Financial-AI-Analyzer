import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dateFact,operationDay,initialSemantics} from '../src/model.ts';
import type {BankDate,Operation,Graph} from '../src/model.ts';
import {calendarKnown,mergeBankCalendar,resolveSourceCalendar} from '../src/bank-calendar.ts';
import {aggregate,reconcile} from '../src/graph.ts';
import {periodFilter,parseOperationsView,defaultColumns} from '../src/operations.ts';
const instant='2026-09-30T22:30:00.000Z';
function operation(date:BankDate):Operation{return {id:'o',source:{accountId:'a',operationDate:date,postedDate:null,amountMinor:'-100',currency:'RUB',sourceKind:'purchase',merchantText:'Магазин',description:'Покупка',bankCategory:'',bankRefHmac:null,versions:{}},corrections:{},semantics:initialSemantics('purchase'),comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};}
function graph(date:BankDate):Graph{return {accounts:[{id:'a',bankId:'synthetic',name:'Счёт',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories:[],components:[],links:[],loanMode:'cashflow',operations:[operation(date)]};}
for(const [offset,day]of [[-840,'2026-09-30'],[-600,'2026-09-30'],[0,'2026-09-30'],[180,'2026-10-01'],[540,'2026-10-01'],[840,'2026-10-01']] as const)test('FIN-T92/P10: source offset '+offset+' fixes calendar day independently of profile',()=>{
 const date=dateFact({precision:'instant',instant,sourceOffsetMinutes:offset});assert.equal(operationDay(date),day);assert.equal(calendarKnown(date),true);
 const g=graph(date),before=structuredClone(g),p=reconcile(g);assert.equal(aggregate(p.operations,{from:day,through:day}).netExpensesMinor,'100');assert.ok(!p.operations[0]!.reviewReasons.includes('source_timezone_unknown'));assert.deepEqual(g,before);
 const view=parseOperationsView({columns:defaultColumns,period:'current_month'});const east=periodFilter(view,new Date(instant),'Asia/Tokyo'),west=periodFilter(view,new Date(instant),'Pacific/Honolulu');assert.equal(east.from,'2026-10-01');assert.equal(west.from,'2026-09-01');assert.equal(operationDay(date),day);
});
test('FIN-T93: legacy and explicit unknown instants use a visible UTC reference, not a claimed Moscow date',()=>{
 for(const date of [{precision:'instant',instant},{precision:'instant',instant,sourceOffsetMinutes:null}] as const){assert.equal(operationDay(date),'2026-09-30');assert.equal(calendarKnown(date),false);assert.ok(reconcile(graph(date)).operations[0]!.reviewReasons.includes('source_timezone_unknown'));}
});
test('FIN-P10: day-only facts and explicit correction survive profile travel without manufacturing a timestamp',()=>{
 const g=graph({precision:'day',date:'2026-09-30'});assert.equal(operationDay(g.operations[0]!.source.operationDate),'2026-09-30');const p=reconcile(g);assert.ok(!p.operations[0]!.reviewReasons.includes('source_timezone_unknown'));
 g.operations[0]!.source.operationDate={precision:'instant',instant};g.operations[0]!.corrections.operationDate={precision:'day',date:'2026-10-02'};assert.ok(!reconcile(g).operations[0]!.reviewReasons.includes('source_timezone_unknown'));assert.equal(operationDay(reconcile(g).operations[0]!.date),'2026-10-02');
});
test('FIN-P09/P10: unknown observations do not erase known calendar, while conflicting known offsets remain unresolved',()=>{
 const unknown:BankDate={precision:'instant',instant},east:BankDate={...unknown,sourceOffsetMinutes:540},west:BankDate={...unknown,sourceOffsetMinutes:-600};
 assert.deepEqual(mergeBankCalendar(unknown,[east,unknown]).date,east);assert.equal(mergeBankCalendar(unknown,[east,west]).conflict,true);assert.equal(calendarKnown(mergeBankCalendar(east,[east,west]).date),false);
 const source=operation(unknown).source,a=resolveSourceCalendar(source,[{operationDate:east},{operationDate:west}]);assert.equal(a.versions.operationCalendarEvidence,'conflict');const g=graph(a.operationDate);g.operations[0]!.source=a;assert.ok(reconcile(g).operations[0]!.reviewReasons.includes('source_timezone_conflict'));
 const cancelled=resolveSourceCalendar(a,[{operationDate:east}]);assert.deepEqual(cancelled.operationDate,east);assert.equal(cancelled.versions.operationCalendarEvidence,undefined);
 assert.equal(mergeBankCalendar(unknown,[{precision:'instant',instant:'2026-09-29T22:30:00.000Z',sourceOffsetMinutes:540}]).date,unknown);
});
test('FIN-P10: operation and posted calendars are resolved independently',()=>{
 const source={...operation({precision:'instant',instant}).source,postedDate:{precision:'instant' as const,instant:'2026-10-01T22:30:00.000Z'}},resolved=resolveSourceCalendar(source,[{operationDate:{precision:'instant',instant,sourceOffsetMinutes:180},postedDate:{precision:'instant',instant:'2026-10-01T22:30:00.000Z',sourceOffsetMinutes:-600}}]);assert.equal(operationDay(resolved.operationDate),'2026-10-01');assert.equal(operationDay(resolved.postedDate!),'2026-10-01');
});
test('calendar wire rejects coercion, fractional/out-of-range offsets, unknown properties and metadata on day precision',()=>{
 for(const sourceOffsetMinutes of ['180',180.5,841,-841,Infinity,undefined])assert.throws(()=>dateFact({precision:'instant',instant,sourceOffsetMinutes}));
 assert.throws(()=>dateFact({precision:'day',date:'2026-09-30',sourceOffsetMinutes:180}));assert.throws(()=>dateFact({precision:'instant',instant,sourceOffsetMinutes:180,timezone:'Europe/Moscow'}));
});
