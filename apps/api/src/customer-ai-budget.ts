import type {PoolClient} from 'pg';
import {baseMonthlyCost,CostError} from '../../../packages/analyzer/src/cost.ts';
export const unitsPerMonth=10_000;
// Historical development snapshots called request count a quota. Keep any other
// purchased allowance intact, even when an operator selected the same number.
export function paidAnalyzerUnits(tariffId:string,kind:string,quota:number){
 return tariffId==='development-month'&&kind==='calendar_months'&&quota===150?unitsPerMonth:quota;
}
const atomsPerUnit=baseMonthlyCost/BigInt(unitsPerMonth);

/** Customer usage is isolated from statement classification and from the
 * separate provider limit. Each paid period keeps its purchased terms. */
async function accessUsage(db:PoolClient,userId:string){
 return (await db.query(`WITH context AS MATERIALIZED (
  SELECT clock_timestamp() AS now,(SELECT anchor_at FROM commerce.access_cycle WHERE user_id=$1) AS anchor,
    (SELECT access_end FROM commerce.access_cycle WHERE user_id=$1) AS access_end
 ), restoration AS (
  SELECT window_start,period_start,restored_at FROM commerce.ai_allowance_restoration WHERE user_id=$1
 ), current_slot AS (
  SELECT p.starts_at,p.ends_at,CASE WHEN p.starts_at>=a.period_start THEN $2::int ELSE COALESCE(w.quota,$2::int) END AS quota
  FROM context c LEFT JOIN LATERAL (
    SELECT * FROM commerce.analyzer_allowance_window($1,c.now)
  ) w ON true
  CROSS JOIN LATERAL commerce.billing_period(
   COALESCE(w.starts_at,CASE WHEN c.anchor<=c.now THEN c.anchor END,date_trunc('month',c.now AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'),
   least(w.ends_at,CASE WHEN c.access_end>c.now THEN c.access_end END),COALESCE(w.kind,'calendar_months'),c.now) p
  LEFT JOIN restoration a ON a.window_start=w.starts_at AND NOT w.manual
 ), amounts AS (
  SELECT p.starts_at,CASE WHEN p.starts_at>=a.period_start THEN $2::int ELSE COALESCE(w.quota,$2::int) END AS quota,
   sum(CASE WHEN p.starts_at=a.period_start AND r.created_at<a.restored_at THEN 0
    WHEN r.state IN ('settled','released') THEN r.settled_atoms ELSE r.reserved_atoms END) AS occupied
  FROM commerce.ai_cost_reservation r CROSS JOIN context c LEFT JOIN LATERAL (
    SELECT * FROM commerce.analyzer_allowance_window($1,r.created_at)
  ) w ON true
  CROSS JOIN LATERAL commerce.billing_period(
   COALESCE(w.starts_at,CASE WHEN c.anchor<=r.created_at THEN c.anchor END,date_trunc('month',r.created_at AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'),
   w.ends_at,COALESCE(w.kind,'calendar_months'),r.created_at) p
  LEFT JOIN restoration a ON a.window_start=w.starts_at AND NOT w.manual
  WHERE r.user_id=$1 AND r.step<>'classification' GROUP BY 1,2
 ), paid AS (
  SELECT COALESCE(sum(units),0)::numeric*$3::numeric AS credits FROM commerce.ai_topup_order WHERE user_id=$1 AND status='paid'
 )
 SELECT current_slot.ends_at,current_slot.quota,
  COALESCE((SELECT sum(occupied) FROM amounts WHERE amounts.starts_at=current_slot.starts_at),0)::text AS occupied,
  GREATEST(0,credits-COALESCE((SELECT sum(GREATEST(0,occupied-quota*$3::numeric)) FROM amounts WHERE amounts.starts_at<current_slot.starts_at),0))::text AS purchased
 FROM current_slot CROSS JOIN paid`,[userId,unitsPerMonth,atomsPerUnit.toString()])).rows[0] as {ends_at:Date;quota:number;occupied:string;purchased:string};
}
export async function customerAiBudget(db:PoolClient,userId:string){
 const row=await accessUsage(db,userId),usage=BigInt(row.occupied),base=BigInt(row.quota)*atomsPerUnit-usage,extra=BigInt(row.purchased)+(base<0n?base:0n);
 const toUnits=(atoms:bigint)=>atoms>0n?Number(atoms/atomsPerUnit):0;
 return {limit:row.quota,remaining:toUnits(base),extra:toUnits(extra),resetAt:row.ends_at};
}
export async function assertCustomerAiBudget(db:PoolClient,userId:string,quote:bigint){
 const row=await accessUsage(db,userId);
 if(BigInt(row.occupied)+quote>BigInt(row.quota)*atomsPerUnit+BigInt(row.purchased))throw new CostError('AI_USER_COST_EXHAUSTED');
}
