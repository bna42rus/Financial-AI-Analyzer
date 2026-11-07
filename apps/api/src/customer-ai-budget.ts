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
 ), current_slot AS (
  SELECT p.starts_at,p.ends_at,COALESCE(w.quota,$2::int) AS quota
  FROM context c LEFT JOIN LATERAL (
    SELECT * FROM commerce.access_paid_window WHERE user_id=$1 AND starts_at<=c.now AND ends_at>c.now
    ORDER BY starts_at DESC LIMIT 1
  ) w ON true
  CROSS JOIN LATERAL commerce.billing_period(
   COALESCE(w.starts_at,CASE WHEN c.anchor<=c.now THEN c.anchor END,date_trunc('month',c.now AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'),
   COALESCE(w.ends_at,CASE WHEN c.access_end>c.now THEN c.access_end END),COALESCE(w.kind,'calendar_months'),c.now) p
 ), amounts AS (
  SELECT p.starts_at,COALESCE(w.quota,$2::int) AS quota,
   sum(CASE WHEN r.state IN ('settled','released') THEN r.settled_atoms ELSE r.reserved_atoms END) AS occupied
  FROM commerce.ai_cost_reservation r CROSS JOIN context c LEFT JOIN LATERAL (
    SELECT * FROM commerce.access_paid_window WHERE user_id=$1 AND starts_at<=r.created_at AND ends_at>r.created_at
    ORDER BY starts_at DESC LIMIT 1
  ) w ON true
  CROSS JOIN LATERAL commerce.billing_period(
   COALESCE(w.starts_at,CASE WHEN c.anchor<=r.created_at THEN c.anchor END,date_trunc('month',r.created_at AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'),
   w.ends_at,COALESCE(w.kind,'calendar_months'),r.created_at) p
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
