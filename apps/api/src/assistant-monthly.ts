import type { PoolClient } from 'pg';
import type { CostPolicy } from './analyzer-cost.ts';
import { AssistantError } from '../../../packages/analyzer/src/assistant-plan.ts';
import { rubAmount } from '../../../packages/analyzer/src/cost.ts';

/** Operating cap for the one explicitly authorized Staging account. Customer
 * task quotas and system-funded classification remain separate (PDF 29). */
export type MonthlyAuthorization = { version: 'cashneuro-staging-monthly/1'; limitRub: '100'; activatedAt: string };
export function monthlyPeriod(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new AssistantError('ASSISTANT_MONTHLY_CONFIGURATION_DENIED');
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Moscow', year: 'numeric', month: 'numeric' }).formatToParts(now);
  const year = Number(parts.find(p => p.type === 'year')!.value), month = Number(parts.find(p => p.type === 'month')!.value);
  // Moscow is UTC+03:00 throughout the supported operating dates (2026+).
  if (year < 2026 || year > 9998) throw new AssistantError('ASSISTANT_MONTHLY_CONFIGURATION_DENIED');
  return { projectPeriodStart: new Date(Date.UTC(year, month - 1, 1) - 10800000).toISOString(),
    projectPeriodEnd: new Date(Date.UTC(year, month, 1) - 10800000).toISOString() };
}
export function monthlyPolicy(original: CostPolicy, authorization: MonthlyAuthorization, now: Date): CostPolicy {
  return { ...original, ...monthlyPeriod(now), projectLimitRub: authorization.limitRub };
}
export function monthlyTariffGuard(checkedAt: string, verify: () => Promise<{ checkedAt: string }>, now: () => Date) {
  let checked = Date.parse(checkedAt), pending: Promise<void> | undefined;
  return async () => {
    const at = now().getTime();
    if (Number.isFinite(checked) && at >= checked && at - checked < 86400000) return;
    pending ??= verify().then(value => {
      const stamp = Date.parse(value.checkedAt), current = now().getTime();
      if (!Number.isFinite(stamp) || stamp > current || current - stamp >= 86400000) throw new AssistantError('ASSISTANT_TARIFF_STALE');
      checked = stamp;
    }).finally(() => { pending = undefined; });
    await pending;
  };
}
/** Acquire before reserveCost, and retain through its committed reservation.
 * This serializes the same project's dispatches even across a month boundary. */
export async function prepareMonthlyDispatch(db: PoolClient, policy: CostPolicy) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['assistant-monthly:' + policy.projectId]);
  const blocked = (await db.query(`SELECT 1 FROM commerce.ai_project_budget WHERE project_id=$1 AND blocked LIMIT 1`, [policy.projectId])).rowCount;
  const unresolved = (await db.query(`SELECT 1 FROM commerce.ai_cost_reservation WHERE project_id=$1 AND state IN ('reserved','unknown') LIMIT 1`, [policy.projectId])).rowCount;
  if (blocked || unresolved) throw new AssistantError('ASSISTANT_RECONCILIATION_REQUIRED');
}
export async function authorizeMonthlyDispatch(db: PoolClient, policy: CostPolicy, now: Date) {
  if (Date.parse(policy.projectPeriodStart) > now.getTime() || Date.parse(policy.projectPeriodEnd) <= now.getTime()) throw new AssistantError('ASSISTANT_MONTHLY_PERIOD_CHANGED');
  // Charge by dispatch month, including earlier short-lived pilot buckets.
  // Only the authorized account is visible through RLS. No ledger is rewritten.
  const result = (await db.query(`SELECT COALESCE(sum(CASE WHEN state IN ('settled','released') THEN settled_atoms ELSE reserved_atoms END),0)::text AS total,
    count(*) FILTER (WHERE state IN ('settled','released') AND settled_atoms IS NULL)::int AS invalid
    FROM commerce.ai_cost_reservation WHERE project_id=$1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
    [policy.projectId, policy.projectPeriodStart, policy.projectPeriodEnd])).rows[0];
  if (result.invalid) throw new AssistantError('ASSISTANT_RECONCILIATION_REQUIRED');
  if (BigInt(result.total) > rubAmount(policy.projectLimitRub)) throw new AssistantError('ASSISTANT_BUDGET_EXHAUSTED');
}

export type MonthlyBudgetState = { limitAtoms: string; spentAtoms: string; heldAtoms: string; remainingAtoms: string; resetAt: string; warning: 80 | 95 | 100 | null };
export async function monthlyBudgetState(db: PoolClient, policy: CostPolicy): Promise<MonthlyBudgetState> {
  const row = (await db.query(`SELECT COALESCE(sum(settled_atoms) FILTER (WHERE state IN ('settled','released')),0)::text AS spent,
    COALESCE(sum(reserved_atoms) FILTER (WHERE state IN ('reserved','unknown')),0)::text AS held
    FROM commerce.ai_cost_reservation WHERE project_id=$1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
    [policy.projectId, policy.projectPeriodStart, policy.projectPeriodEnd])).rows[0];
  const limit = rubAmount(policy.projectLimitRub), occupied = BigInt(row.spent) + BigInt(row.held);
  return { limitAtoms: limit.toString(), spentAtoms: row.spent, heldAtoms: row.held, remainingAtoms: (occupied >= limit ? 0n : limit - occupied).toString(),
    resetAt: policy.projectPeriodEnd, warning: occupied >= limit ? 100 : occupied * 100n >= limit * 95n ? 95 : occupied * 100n >= limit * 80n ? 80 : null };
}
