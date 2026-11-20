import type {PoolClient} from 'pg';
import {baseMonthlyCost,CostError} from '../../../packages/analyzer/src/cost.ts';
export const unitsPerMonth=10_000;
// Historical development snapshots called request count a quota. Keep any other
// purchased allowance intact, even when an operator selected the same number.
export function paidAnalyzerUnits(tariffId:string,kind:string,quota:number){
 return tariffId==='development-month'&&kind==='calendar_months'&&quota===150?unitsPerMonth:quota;
}
const atomsPerUnit=baseMonthlyCost/BigInt(unitsPerMonth);

async function accessUsage(db:PoolClient,userId:string){
 const row=(await db.query(`SELECT *,commerce.finance_purchased_used() AS purchased_used FROM commerce.finance_customer_allowance()
  WHERE current_setting('app.user_id',true)=$1`,[userId])).rows[0] as {period_end:Date;quota:number;base_remaining:string;purchased_remaining:string;purchased_used:string;manual:boolean}|undefined;
 if(!row)throw new CostError('AI_BUDGET_PERIOD_REQUIRED');
 return row;
}
export async function customerAiBudget(db:PoolClient,userId:string){
 const row=await accessUsage(db,userId);
 const toUnits=(atoms:string)=>Math.min(Number(BigInt(atoms)/atomsPerUnit),Number.MAX_SAFE_INTEGER);
 return {totalLimit:row.quota+toUnits(row.purchased_remaining)+toUnits(row.purchased_used),limit:row.quota,remaining:toUnits(row.base_remaining),extra:toUnits(row.purchased_remaining),resetAt:row.period_end,manual:row.manual};
}
export async function assertCustomerAiBudget(db:PoolClient,userId:string,quote:bigint){
 const row=await accessUsage(db,userId);
 if(quote>BigInt(row.base_remaining)+BigInt(row.purchased_remaining))throw new CostError('AI_USER_COST_EXHAUSTED');
}
