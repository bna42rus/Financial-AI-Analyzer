import {object,choice,dateFact} from './model.ts';
import {parsePersistedMinor} from './money.ts';
import {parseOperationsFilter,queryOperations} from './operations.ts';
import type {OperationsFilter,OperationsCatalog,OperationRow} from './operations.ts';

export type BudgetPeriod={kind:'week'|'month'|'quarter'|'year'}|{kind:'fixed';from:string;through:string}|{kind:'custom_month';anchorDay:number;everyMonths:number;anchorMonth:string}|{kind:'custom_days';anchor:string;days:number};
export type BudgetDefinition={filter:OperationsFilter;basis:'net'|'gross';period:BudgetPeriod;timezone:string};
export type LimitVersion={from:string;limitMinor:string};
export type Budget={id:string;name:string;enabled:boolean;definition:BudgetDefinition;limits:LimitVersion[];dependencyStatus:'ready'|'needs_setup';revision:string};
export const budgetDay=(v:unknown)=>(dateFact({precision:'day',date:v}) as {date:string}).date;
const iso=(d:Date)=>{const s=d.toISOString().slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s))throw new RangeError('PERIOD_OUT_OF_RANGE');return s;};
const date=(s:string)=>new Date(s+'T00:00:00Z');
const addDays=(s:string,n:number)=>{const d=date(s);d.setUTCDate(d.getUTCDate()+n);return iso(d);};
function monthStart(index:number,anchor=1){const d=new Date(0);d.setUTCFullYear(Math.floor(index/12),index%12+1,0);const last=d.getUTCDate();d.setUTCDate(Math.min(anchor,last));return iso(d);}
const monthIndex=(s:string)=>Number(s.slice(0,4))*12+Number(s.slice(5,7))-1;
function integer(v:unknown,min:number,max:number){if(typeof v!=='number'||!Number.isInteger(v)||v<min||v>max)throw new TypeError('INVALID_PERIOD');return v;}
export function parseBudgetPeriod(value:unknown):BudgetPeriod{
 const r=object(value,['kind','from','through','anchorDay','everyMonths','anchorMonth','anchor','days']);
 const kind=choice(r.kind,['week','month','quarter','year','fixed','custom_month','custom_days']);
 if(kind==='fixed'){object(value,['kind','from','through']);const from=budgetDay(r.from),through=budgetDay(r.through);if(from>through)throw new TypeError('INVALID_RANGE');return {kind,from,through};}
 if(kind==='custom_month'){object(value,['kind','anchorDay','everyMonths','anchorMonth']);const anchorMonth=budgetDay(r.anchorMonth);if(!anchorMonth.endsWith('-01'))throw new TypeError('INVALID_ANCHOR');return {kind,anchorDay:integer(r.anchorDay,1,31),everyMonths:integer(r.everyMonths,1,12),anchorMonth};}
 if(kind==='custom_days'){object(value,['kind','anchor','days']);return {kind,anchor:budgetDay(r.anchor),days:integer(r.days,1,366)};}
 object(value,['kind']);return {kind};
}
export function parseBudgetDefinition(value:unknown):BudgetDefinition{
 const r=object(value,['filter','basis','period','timezone']),filter=parseOperationsFilter(r.filter??{});
 // Budget owns its calendar; transaction-date bounds belong to the period.
 if(filter.from||filter.through)throw new TypeError('BUDGET_PERIOD_REQUIRED');
 if(typeof r.timezone!=='string'||r.timezone.length>80)throw new TypeError('INVALID_TIMEZONE');
 try{new Intl.DateTimeFormat('en',{timeZone:r.timezone}).format();}catch{throw new TypeError('INVALID_TIMEZONE');}
 return {filter,basis:choice(r.basis??'net',['net','gross']),period:parseBudgetPeriod(r.period),timezone:r.timezone};
}
export function calendarDay(now:Date,timezone:string){return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export function budgetWindow(period:BudgetPeriod,at:string):{from:string;through:string;next:string|null}{
 budgetDay(at);
 if(period.kind==='fixed')return {from:period.from,through:period.through,next:null};
 let from:string,next:string;
 if(period.kind==='custom_days'){const offset=Math.floor((date(at).getTime()-date(period.anchor).getTime())/86400000/period.days);from=addDays(period.anchor,offset*period.days);next=addDays(from,period.days);}
 else if(period.kind==='week'){const d=date(at),weekday=(d.getUTCDay()+6)%7;from=addDays(at,-weekday);next=addDays(from,7);}
 else{const m=monthIndex(at);let index:number,step:number,anchor=1;
  if(period.kind==='custom_month'){step=period.everyMonths;anchor=period.anchorDay;const base=monthIndex(period.anchorMonth);index=base+Math.floor((m-base)/step)*step;if(monthStart(index,anchor)>at)index-=step;}
  else{step=period.kind==='month'?1:period.kind==='quarter'?3:12;index=m-m%step;}
  from=monthStart(index,anchor);next=monthStart(index+step,anchor);
 }
 return {from,through:addDays(next,-1),next};
}
export function limitMinor(value:unknown){const n=parsePersistedMinor(value);if(n<0n)throw new TypeError('INVALID_LIMIT');return n.toString();}
export function limitAt(versions:LimitVersion[],from:string){return [...versions].sort((a,b)=>b.from.localeCompare(a.from)).find(v=>v.from<=from)?.limitMinor??null;}
/** Exact display percentage as decimal text, never floating point money. */
export function budgetIndicator(factMinor:string,limit:string){const fact=BigInt(factMinor),ceiling=BigInt(limit),used=fact<0n?0n:fact,remaining=ceiling-used,bps=ceiling===0n?null:(used*10000n+ceiling/2n)/ceiling;
 return {factMinor,limitMinor:limit,usedMinor:used.toString(),remainingMinor:remaining.toString(),excessRefundMinor:(fact<0n?-fact:0n).toString(),overMinor:(remaining<0n?-remaining:0n).toString(),exceeded:used>ceiling,percentage:bps===null?null:`${bps/100n}.${(bps%100n).toString().padStart(2,'0')}`};}
export function budgetFilter(definition:BudgetDefinition,window:{from:string;through:string}):OperationsFilter{return {...definition.filter,from:window.from,through:window.through,role:definition.filter.role??'expense',inclusion:definition.filter.inclusion??(definition.filter.includeExcluded?'any':'included')};}
export function calculateBudget(budget:Budget,rows:OperationRow[],catalog:OperationsCatalog,at:string){
 const period=budgetWindow(budget.definition.period,at),limit=limitAt(budget.limits,period.from),filter=budgetFilter(budget.definition,period),result=queryOperations(rows,catalog,{filter,sort:'date',direction:'desc',group:'none'});
 return {period,filter,operationCount:result.total,summary:{grossExpensesMinor:result.summary.grossExpensesMinor,expenseReductionsMinor:result.summary.expenseReductionsMinor,netExpensesMinor:result.summary.netExpensesMinor,excludedMinor:result.summary.excludedMinor,unresolvedMinor:result.summary.unresolvedMinor},indicator:limit===null||budget.dependencyStatus!=='ready'?null:budgetIndicator(budget.definition.basis==='gross'?result.summary.grossExpensesMinor:result.summary.netExpensesMinor,limit)};
}
