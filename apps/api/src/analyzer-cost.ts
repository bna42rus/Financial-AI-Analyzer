import type { PoolClient } from 'pg';
import { object } from '../../../packages/finance-core/src/model.ts';
import { baseMonthlyCost, rubAmount, tokenPrice, tokenCost, CostError } from '../../../packages/analyzer/src/cost.ts';
import type { TokenPrice, DispatchBound, Usage } from '../../../packages/analyzer/src/cost.ts';

export type CostPolicy = { projectId: string; projectPeriodStart: string; projectPeriodEnd: string; projectLimitRub: string; price: TokenPrice };
export type CostIdentity = { userId: string; requestId: string; step: 'gate' | 'plan' | 'assistant_0' | 'assistant_1' | 'assistant_2'; anchorAt: string; periodStart: string };
export function costPolicy(value: unknown): CostPolicy {
  const r = object(value, ['projectId', 'projectPeriodStart', 'projectPeriodEnd', 'projectLimitRub', 'price']);
  if (typeof r.projectId !== 'string' || !/^[a-z0-9._/-]{1,80}$/.test(r.projectId) || typeof r.projectPeriodStart !== 'string' || typeof r.projectPeriodEnd !== 'string') throw new CostError('AI_BUDGET_CONFIGURATION_DENIED');
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
  for (const stamp of [r.projectPeriodStart, r.projectPeriodEnd]) if (!iso.test(stamp) || !Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString().slice(0,19) !== stamp.slice(0,19)) throw new CostError('AI_BUDGET_CONFIGURATION_DENIED');
  if (Date.parse(r.projectPeriodEnd) <= Date.parse(r.projectPeriodStart)) throw new CostError('AI_BUDGET_CONFIGURATION_DENIED');
  const limit = rubAmount(r.projectLimitRub);
  if (limit <= 0n || limit > 1_000n * 1_000_000_000n) throw new CostError('AI_BUDGET_CONFIGURATION_DENIED');
  return { ...r, price: tokenPrice(r.price) } as CostPolicy;
}

/** Called inside a short metadata transaction, committed before dispatch.
 * Lock ordering is always project then user; no financial workspace locks. */
export async function reserveCost(db: PoolClient, identity: CostIdentity, policy: CostPolicy, bound: DispatchBound): Promise<void> {
  const p = costPolicy(policy), amount = tokenCost(p.price, bound.inputTokens, bound.outputTokens);
  if (amount <= 0n || !/^[A-Za-z0-9._/-]{1,160}$/.test(bound.modelVersion)) throw new CostError('AI_USAGE_INVALID');
  await db.query(`INSERT INTO commerce.ai_project_budget(project_id,period_start,period_end,limit_atoms) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [p.projectId, p.projectPeriodStart, p.projectPeriodEnd, rubAmount(p.projectLimitRub).toString()]);
  const project = (await db.query(`SELECT *,period_start<=clock_timestamp() AND period_end>clock_timestamp() AS active,period_end=$3::timestamptz AS matches_end FROM commerce.ai_project_budget WHERE project_id=$1 AND period_start=$2 FOR UPDATE`, [p.projectId, p.projectPeriodStart, p.projectPeriodEnd])).rows[0];
  if (!project.active || !project.matches_end || BigInt(project.limit_atoms) !== rubAmount(p.projectLimitRub)) throw new CostError('AI_PROJECT_BUDGET_CHANGED');
  if (project.blocked) throw new CostError('AI_PROVIDER_CONTRACT_CHANGED');
  // Earlier runtime releases stored this calendar-period key through JS Date,
  // truncating microseconds. Reuse that budget instead of granting a fresh 100
  // RUB bucket. Conflicting aliases require reconciliation, never summing twice.
  const aliases = (await db.query(`SELECT period_start::text AS period FROM commerce.ai_user_budget WHERE user_id=$1 AND anchor_at=$2
    AND period_start IN ($3::timestamptz,date_trunc('milliseconds',$3::timestamptz)) ORDER BY period_start FOR UPDATE`, [identity.userId, identity.anchorAt, identity.periodStart])).rows;
  if (aliases.length > 1) throw new CostError('AI_COST_RECONCILIATION_REQUIRED');
  const budgetPeriod: string = aliases[0]?.period ?? identity.periodStart;
  await db.query(`INSERT INTO commerce.ai_user_budget(user_id,anchor_at,period_start,limit_atoms) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [identity.userId, identity.anchorAt, budgetPeriod, baseMonthlyCost.toString()]);
  const user = (await db.query(`SELECT * FROM commerce.ai_user_budget WHERE user_id=$1 AND anchor_at=$2 AND period_start=$3 FOR UPDATE`, [identity.userId, identity.anchorAt, budgetPeriod])).rows[0];
  const old = (await db.query(`SELECT * FROM commerce.ai_cost_reservation WHERE user_id=$1 AND request_id=$2 AND step=$3`, [identity.userId, identity.requestId, identity.step])).rows[0];
  if (old) throw new CostError('AI_REQUEST_CHANGED');
  // Historical paid attempts cannot silently disappear when a ledger is added.
  const legacy = (await db.query(`SELECT 1 FROM commerce.analyzer_request r WHERE r.user_id=$1 AND r.created_at>=$2 AND r.request_id<>$3 AND r.usage_state<>'not_sent'
    AND NOT EXISTS(SELECT 1 FROM commerce.ai_cost_reservation c WHERE (c.user_id,c.request_id,c.step)=(r.user_id,r.request_id,r.step)) LIMIT 1`, [identity.userId, identity.periodStart, identity.requestId])).rowCount;
  if (legacy) throw new CostError('AI_COST_RECONCILIATION_REQUIRED');
  for (const row of [project, user]) if (BigInt(row.spent_atoms) + BigInt(row.reserved_atoms) + amount > BigInt(row.limit_atoms)) throw new CostError(row === user ? 'AI_USER_COST_EXHAUSTED' : 'AI_PROJECT_COST_EXHAUSTED');
  await db.query(`INSERT INTO commerce.ai_cost_reservation(user_id,request_id,step,project_id,project_period_start,anchor_at,period_start,price,quoted_input_tokens,quoted_output_tokens,quoted_model_version,reserved_atoms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [identity.userId, identity.requestId, identity.step, p.projectId, p.projectPeriodStart, identity.anchorAt, budgetPeriod, JSON.stringify(p.price), bound.inputTokens, bound.outputTokens, bound.modelVersion, amount.toString()]);
  await db.query(`UPDATE commerce.ai_project_budget SET reserved_atoms=reserved_atoms+$3 WHERE project_id=$1 AND period_start=$2`, [p.projectId, p.projectPeriodStart, amount.toString()]);
  await db.query(`UPDATE commerce.ai_user_budget SET reserved_atoms=reserved_atoms+$4 WHERE user_id=$1 AND anchor_at=$2 AND period_start=$3`, [identity.userId, identity.anchorAt, budgetPeriod, amount.toString()]);
  await db.query(`UPDATE commerce.analyzer_request SET dispatched_at=clock_timestamp(),usage_state='unknown' WHERE user_id=$1 AND request_id=$2 AND step=$3`, [identity.userId, identity.requestId, identity.step]);
}

export async function settleCost(db: PoolClient, userId: string, requestId: string, step: string, usage?: Usage, notSent = false): Promise<boolean> {
  if (usage && notSent) throw new CostError('AI_USAGE_INVALID');
  // pg Date objects truncate timestamp microseconds. Preserve exact DB keys;
  // otherwise a settlement silently updates zero user-budget rows.
  const found = (await db.query(`SELECT *,anchor_at::text AS anchor_at,period_start::text AS period_start,project_period_start::text AS project_period_start FROM commerce.ai_cost_reservation WHERE user_id=$1 AND request_id=$2 AND step=$3`, [userId, requestId, step])).rows[0];
  if (!found) return false;
  await db.query(`SELECT 1 FROM commerce.ai_project_budget WHERE project_id=$1 AND period_start=$2 FOR UPDATE`, [found.project_id, found.project_period_start]);
  await db.query(`SELECT 1 FROM commerce.ai_user_budget WHERE user_id=$1 AND anchor_at=$2 AND period_start=$3 FOR UPDATE`, [userId, found.anchor_at, found.period_start]);
  const r = (await db.query(`SELECT *,anchor_at::text AS anchor_at,period_start::text AS period_start,project_period_start::text AS project_period_start FROM commerce.ai_cost_reservation WHERE user_id=$1 AND request_id=$2 AND step=$3 FOR UPDATE`, [userId, requestId, step])).rows[0];
  if (['settled', 'released'].includes(r.state)) {
    if (usage && (r.reported_input_tokens !== usage.inputTokens || r.reported_output_tokens !== usage.outputTokens || r.reported_model_version !== usage.modelVersion)) throw new CostError('AI_RECEIPT_CHANGED');
    return false;
  }
  if (!usage && !notSent) { await db.query(`UPDATE commerce.ai_cost_reservation SET state='unknown' WHERE user_id=$1 AND request_id=$2 AND step=$3`, [userId, requestId, step]); return false; }
  const actual = usage ? tokenCost(r.price, usage.inputTokens, usage.outputTokens) : 0n;
  // A provider contract violation must still record actual paid cost. Never
  // clamp the accounting amount to the quote; the exhausted budget blocks calls.
  await db.query(`UPDATE commerce.ai_project_budget SET reserved_atoms=reserved_atoms-$3,spent_atoms=spent_atoms+$4 WHERE project_id=$1 AND period_start=$2`, [r.project_id, r.project_period_start, r.reserved_atoms, actual.toString()]);
  await db.query(`UPDATE commerce.ai_user_budget SET reserved_atoms=reserved_atoms-$4,spent_atoms=spent_atoms+$5 WHERE user_id=$1 AND anchor_at=$2 AND period_start=$3`, [userId, r.anchor_at, r.period_start, r.reserved_atoms, actual.toString()]);
  await db.query(`UPDATE commerce.ai_cost_reservation SET state=$4,settled_atoms=$5,reported_input_tokens=$6,reported_output_tokens=$7,reported_model_version=$8 WHERE user_id=$1 AND request_id=$2 AND step=$3`, [userId, requestId, step, notSent ? 'released' : 'settled', actual.toString(), usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.modelVersion ?? null]);
  if (usage) await db.query(`UPDATE commerce.analyzer_request SET input_tokens=$4,output_tokens=$5,model_version=$6,usage_state='reported' WHERE user_id=$1 AND request_id=$2 AND step=$3`, [userId, requestId, step, usage.inputTokens, usage.outputTokens, usage.modelVersion]);
  const violation = !!usage && (usage.inputTokens > r.quoted_input_tokens || usage.outputTokens > r.quoted_output_tokens || usage.modelVersion !== r.quoted_model_version);
  if (violation) await db.query(`UPDATE commerce.ai_project_budget SET blocked=true WHERE project_id=$1 AND period_start=$2`, [r.project_id, r.project_period_start]);
  return violation;
}
