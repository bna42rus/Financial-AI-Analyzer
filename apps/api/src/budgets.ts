import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {object,uuid,choice} from '../../../packages/finance-core/src/model.ts';
import {parseBudgetDefinition,budgetWindow,calendarDay,limitMinor,budgetDay,calculateBudget} from '../../../packages/finance-core/src/budgets.ts';
import type {Budget,BudgetDefinition,LimitVersion} from '../../../packages/finance-core/src/budgets.ts';
import {safeText} from '../../../packages/privacy/src/text.ts';
import {operationsDataset,assertReferences} from './operations.ts';
import {stableJSON} from './finance-history.ts';
import {HttpError} from './types.ts';
export type BudgetIntent={kind:'save_budget';id:string;name:string;definition:BudgetDefinition;enabled:boolean;create:boolean;limitMinor?:string;effectiveFrom?:string}|{kind:'set_budget_limit';id:string;limitMinor:string;applyFrom:'current'|'next';effectiveFrom?:string}|{kind:'delete_budget';id:string};
export function parseBudgetIntent(value:unknown):BudgetIntent{
 const r=object(value,['kind','id','name','definition','enabled','create','limitMinor','applyFrom']),kind=choice(r.kind,['save_budget','set_budget_limit','delete_budget']),id=r.id===undefined?randomUUID():uuid(r.id);
 if(kind==='delete_budget'){object(value,['kind','id']);if(r.id===undefined)throw new TypeError('MISSING_ID');return {kind,id};}
 if(kind==='set_budget_limit'){object(value,['kind','id','limitMinor','applyFrom']);if(r.id===undefined)throw new TypeError('MISSING_ID');return {kind,id,limitMinor:limitMinor(r.limitMinor),applyFrom:choice(r.applyFrom,['current','next'])};}
 object(value,['kind','id','name','definition','enabled','create','limitMinor']);
 if(typeof r.create!=='boolean'||typeof r.enabled!=='boolean'||!r.create&&r.id===undefined||!r.create&&r.limitMinor!==undefined)throw new TypeError('INVALID_BUDGET');
 const name=safeText(r.name,160).trim();if(!name)throw new TypeError('EMPTY_NAME');
 return {kind,id,name,definition:parseBudgetDefinition(r.definition),enabled:r.enabled,create:r.create,...(r.create?{limitMinor:limitMinor(r.limitMinor)}:{})};
}
export async function budgetRows(db:PoolClient,userId:string):Promise<Budget[]>{return (await db.query('SELECT id,name,definition,limits,enabled,dependency_status AS "dependencyStatus",revision FROM finance.budget WHERE user_id=$1 ORDER BY name,id',[userId])).rows;}
async function today(db:PoolClient,timezone:string){return calendarDay((await db.query('SELECT clock_timestamp() AS now')).rows[0].now,timezone);}
export async function applyBudgetIntent(db:PoolClient,userId:string,intent:BudgetIntent){
 const old=(await budgetRows(db,userId)).find(b=>b.id===intent.id);
 if(intent.kind==='delete_budget'){if(!old)throw new HttpError(404,'NOT_FOUND');await db.query('DELETE FROM finance.budget WHERE user_id=$1 AND id=$2',[userId,intent.id]);return {table:'batch' as const,id:intent.id,before:null,details:{kind:intent.kind,budgetId:intent.id,name:old.name,operationsDeleted:0,widgetReferences:0}};}
 if(intent.kind==='save_budget'){
  if(!intent.create&&!old)throw new HttpError(404,'NOT_FOUND');if(intent.create&&old)throw new HttpError(409,'BUDGET_EXISTS');
  if(intent.create&&Number((await db.query('SELECT count(*) AS n FROM finance.budget WHERE user_id=$1',[userId])).rows[0].n)>=100)throw new HttpError(409,'BUDGET_LIMIT');
  await assertReferences(db,userId,intent.definition.filter);
  if(old&&(stableJSON(old.definition.period)!==stableJSON(intent.definition.period)||old.definition.timezone!==intent.definition.timezone))throw new HttpError(409,'BUDGET_ANCHOR_IMMUTABLE');
  let limits=old?.limits;
  if(intent.create){const from=budgetWindow(intent.definition.period,await today(db,intent.definition.timezone)).from;if(intent.effectiveFrom&&intent.effectiveFrom!==from)throw new HttpError(409,'BUDGET_PERIOD_CHANGED');intent.effectiveFrom=from;limits=[{from,limitMinor:intent.limitMinor!}];}
  if(intent.create)await db.query('INSERT INTO finance.budget(user_id,id,name,definition,limits,enabled) VALUES($1,$2,$3,$4,$5,$6)',[userId,intent.id,intent.name,JSON.stringify(intent.definition),JSON.stringify(limits),intent.enabled]);
  else await db.query("UPDATE finance.budget SET name=$3,definition=$4,enabled=$5,dependency_status='ready' WHERE user_id=$1 AND id=$2",[userId,intent.id,intent.name,JSON.stringify(intent.definition),intent.enabled]);
  return {table:'batch' as const,id:intent.id,before:null,details:{kind:intent.kind,budgetId:intent.id,name:intent.name,definition:intent.definition,enabled:intent.enabled,limits,operationsChanged:0}};
 }
 if(!old)throw new HttpError(404,'NOT_FOUND');const period=budgetWindow(old.definition.period,await today(db,old.definition.timezone)),from=intent.applyFrom==='next'?period.next:period.from;
 if(!from)throw new HttpError(409,'BUDGET_HAS_NO_NEXT_PERIOD');
 if(old.definition.period.kind==='fixed'&&period.through<await today(db,old.definition.timezone))throw new HttpError(409,'BUDGET_PERIOD_ENDED');
 if(intent.effectiveFrom&&intent.effectiveFrom!==from)throw new HttpError(409,'BUDGET_PERIOD_CHANGED');intent.effectiveFrom=from;
 const limits:LimitVersion[]=[...old.limits.filter(v=>v.from!==from),{from,limitMinor:intent.limitMinor}].sort((a,b)=>a.from.localeCompare(b.from));
 await db.query('UPDATE finance.budget SET limits=$3 WHERE user_id=$1 AND id=$2',[userId,intent.id,JSON.stringify(limits)]);
 return {table:'batch' as const,id:intent.id,before:null,details:{kind:intent.kind,budgetId:intent.id,name:old.name,effectiveFrom:from,limitMinor:intent.limitMinor,previousLimits:old.limits,limits,operationsChanged:0}};
}
export async function queryBudgets(db:PoolClient,userId:string,value:unknown){
 const r=object(value??{},['at']),at=r.at===undefined?null:budgetDay(r.at),{state,operations}=await operationsDataset(db,userId),budgets=await budgetRows(db,userId),now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
 return {generation:state.generation,revision:state.revision,budgets:budgets.map(b=>({...b,at:at??calendarDay(now,b.definition.timezone),calculation:calculateBudget(b,operations,state,at??calendarDay(now,b.definition.timezone))}))};
}
