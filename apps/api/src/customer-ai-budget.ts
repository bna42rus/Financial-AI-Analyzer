import type {PoolClient} from 'pg';
import {baseMonthlyCost,CostError} from '../../../packages/analyzer/src/cost.ts';
const unitsPerMonth=10_000;
const atomsPerUnit=baseMonthlyCost/BigInt(unitsPerMonth);

/** Customer-funded usage is isolated from statement classification and the
 * owner's separate provider limit. Unsettled paid calls reserve their quote. */
async function monthlyUsage(db:PoolClient,userId:string){
 return (await db.query(`WITH period AS (
  SELECT date_trunc('month',clock_timestamp() AT TIME ZONE 'Europe/Moscow') AS local_start
 ), amounts AS (
  SELECT date_trunc('month',created_at AT TIME ZONE 'Europe/Moscow') AS local_month,
   sum(CASE WHEN state IN ('settled','released') THEN settled_atoms ELSE reserved_atoms END) AS occupied
  FROM commerce.ai_cost_reservation WHERE user_id=$1 AND step<>'classification' GROUP BY 1
 ), paid AS (
  SELECT COALESCE(sum(units),0)::numeric*$3::numeric AS credits FROM commerce.ai_topup_order WHERE user_id=$1 AND status='paid'
 )
 SELECT (local_start+interval '1 month') AT TIME ZONE 'Europe/Moscow' AS ends_at,
  COALESCE((SELECT occupied FROM amounts WHERE local_month=local_start),0)::text AS occupied,
  GREATEST(0,credits-COALESCE((SELECT sum(GREATEST(0,occupied-$2::numeric)) FROM amounts WHERE local_month<local_start),0))::text AS purchased
 FROM period CROSS JOIN paid`,[userId,baseMonthlyCost.toString(),atomsPerUnit.toString()])).rows[0] as {ends_at:Date;occupied:string;purchased:string};
}
export async function customerAiBudget(db:PoolClient,userId:string){
 const row=await monthlyUsage(db,userId),usage=BigInt(row.occupied),base=baseMonthlyCost-usage,extra=BigInt(row.purchased)+(base<0n?base:0n);
 const toUnits=(atoms:bigint)=>atoms>0n?Number(atoms/atomsPerUnit):0;
 return {limit:unitsPerMonth,remaining:toUnits(base),extra:toUnits(extra),resetAt:row.ends_at};
}
export async function assertCustomerAiBudget(db:PoolClient,userId:string,quote:bigint){
 const row=await monthlyUsage(db,userId);
 if(BigInt(row.occupied)+quote>baseMonthlyCost+BigInt(row.purchased))throw new CostError('AI_USER_COST_EXHAUSTED');
}
