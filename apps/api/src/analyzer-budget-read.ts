import type {PoolClient} from 'pg';
import {assertClosedSchema} from '../../../packages/analyzer/src/closed-schema.ts';
import {budgetReadSchema} from '../../../packages/analyzer/src/budget-read.ts';
import type {BudgetReadRequest,BudgetReadExecution} from '../../../packages/analyzer/src/budget-read.ts';
import {calculateBudget,calendarDay} from '../../../packages/finance-core/src/budgets.ts';
import {dateFact} from '../../../packages/finance-core/src/model.ts';
import {queryOperations} from '../../../packages/finance-core/src/operations.ts';
import {operationsDataset} from './operations.ts';
import {budgetRows} from './budgets.ts';
import {ChangeError} from '../../../packages/analyzer/src/assistant-changes.ts';
export async function readAnalyzerBudgets(db:PoolClient,userId:string,request:BudgetReadRequest,now:Date):Promise<BudgetReadExecution>{
 assertClosedSchema(request,budgetReadSchema);if(request.date)dateFact({precision:'day',date:request.date});
 const data=await operationsDataset(db,userId),all=await budgetRows(db,userId),fold=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru').trim();
 if(all.length>500)throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');
 const chosen=request.names?request.names.map(name=>{const matches=all.filter(b=>fold(b.name)===fold(name));if(matches.length!==1)throw new ChangeError('ASSISTANT_CHANGE_NEEDS_CHOICE');return matches[0]!;}):all;
 const dependencies=new Set<string>(),items=[];
 for(const b of chosen){const today=calendarDay(now,b.definition.timezone),date=request.date??today;if(date>today)throw new TypeError('BUDGET_FUTURE_ACTUAL_REQUIRES_SCENARIO');const result=calculateBudget(b,data.operations,data.state,date);if(request.overrunOnly&&!result.indicator?.exceeded)continue;
  for(const o of queryOperations(data.operations,data.state,{filter:result.filter,sort:'date',direction:'asc',group:'none'}).operations)dependencies.add(o.id);
  const upcomingLimit=[...b.limits].filter(v=>v.from>result.period.from).sort((a,b)=>a.from.localeCompare(b.from))[0];items.push({id:b.id,name:b.name,enabled:b.enabled,dependencyStatus:b.dependencyStatus,...(upcomingLimit?{upcomingLimit}:{}),...result});
 }
 return {value:{version:'cashneuro-budget-read/1',generation:data.state.generation,revision:data.state.revision,items,notice:'Каждый бюджет использует свой период, часовой пояс и фильтры. Общие фильтры экрана не заменяют условия бюджета. Расходы пересекающихся бюджетов не складываются. Показан факт из сохранённых операций, а не прогноз.'},dependencyIds:[...dependencies]};
}
