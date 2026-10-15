import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { BenchmarkFailure, replayOnlyBenchmarkTransport, candidates } from './benchmark-transport.ts';
import type { Candidate, ResponseContract } from './benchmark-transport.ts';
import type { BenchmarkLedger } from './benchmark-ledger.ts';
import { runSmoke, smokeCostReport } from './benchmark-engine.ts';
import type { SmokeCheck, SmokeRevision } from './benchmark-engine.ts';

// Resume only through a reviewed, frozen experiment after the cross-version
// audit. No flag, environment variable or old CLI action resumes paid trials.
export const paidTrialStatus = 'paused-for-cross-version-audit' as const;
const freeActions = new Set(['--dry-run', '--inspect', '--audit-saved', '--report', '--report-revised', '--report-resolved', '--report-fixed', '--report-delta', '--report-transfer', '--report-explicit', '--report-transfer-explicit', '--report-regression', '--report-context']);
export function assertBenchmarkActionAllowed(action: string) {
  if (freeActions.has(action)) return;
  throw new BenchmarkFailure('BENCH_PAID_TRIALS_PAUSED_FOR_AUDIT');
}

type Batch = { candidate: Candidate; revision: SmokeRevision; contract: ResponseContract; phase: 'initial' | 'after-funding'; corpus: 'smoke' | 'transfer' };
const batches: Batch[] = [
  { candidate: 'cloud-oss', revision: 'original', contract: 'legacy', phase: 'initial', corpus: 'smoke' },
  ...(['original', 'revised', 'resolved'] as const).map(revision => ({ candidate: 'cloud-oss' as const, revision, contract: 'legacy' as const, phase: 'after-funding' as const, corpus: 'smoke' as const })),
  ...(['delta', 'explicit', 'literal', 'context'] as const).flatMap(revision => (['smoke', 'transfer'] as const).map(corpus =>
    ({ candidate: 'cloud-oss' as const, revision, contract: 'empty-tools' as const, phase: 'after-funding' as const, corpus }))),
  ...(['legacy', 'empty-tools'] as const).map(contract => ({ candidate: 'cloud-giga' as const, revision: 'resolved' as const, contract, phase: 'after-funding' as const, corpus: 'smoke' as const })),
];

// Receipt values already passed a closed parser. Text-valued filters could
// nevertheless contain reflected strings: exclude their contents from export.
function sanitized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    ['merchant', 'bankId', 'search', 'comment', 'reason'].includes(key) && typeof entry === 'string' ? '[TEXT_REDACTED]' : sanitized(entry)]));
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export function analyzeSavedChecks(rows: { check: SmokeCheck; scenarioId: string }[]) {
  const seenFailure = new Set<string>();
  const turns = rows.map(({ check, scenarioId }) => {
    const d = check.diagnostics!;
    const earlierFailureInScenario = seenFailure.has(scenarioId);
    if (!check.gate || check.plan === false) seenFailure.add(scenarioId);
    const expected = d.expectedPlan, actual = d.actualPlan;
    const planDifferences: string[] = [];
    if (expected) {
      if (!actual) planDifferences.push('missing_plan');
      else {
        if (actual.status !== expected.status) planDifferences.push('status');
        if (Boolean(actual.query) !== Boolean(expected.query)) planDifferences.push('query_presence');
        if (actual.query && expected.query) {
          for (const key of ['name', 'metric', 'grouping', 'comparison'] as const)
            if (actual.query[key] !== expected.query[key]) planDifferences.push(key);
          const fields = new Set([...Object.keys(expected.query.filter), ...Object.keys(actual.query.filter)]);
          for (const key of [...fields].sort()) if (!isDeepStrictEqual((expected.query.filter as Record<string, unknown>)[key], (actual.query.filter as Record<string, unknown>)[key])) planDifferences.push('filter.' + key);
        }
      }
    }
    return { scenarioId, ...check, diagnostics: sanitized(d),
      analysis: { relevanceCorrect: d.actualGate?.relevance === d.expectedGate.relevance,
        followUpCorrect: d.actualGate?.followUp === d.expectedGate.followUp,
        planDifferences, earlierFailureInScenario } };
  });
  return { turns, metrics: { evaluatedTurns: turns.length,
    strictPassed: rows.filter(r => r.check.gate && r.check.plan !== false).length,
    relevanceCorrect: turns.filter(t => t.analysis.relevanceCorrect).length,
    followUpCorrect: turns.filter(t => t.analysis.followUpCorrect).length,
    expectedPlans: rows.filter(r => r.check.plan !== null).length,
    exactPlans: rows.filter(r => r.check.plan === true).length,
    failuresAfterEarlierFailure: turns.filter(t => (!t.gate || t.plan === false) && t.analysis.earlierFailureInScenario).length,
    // These are accounting facts, not a semantic-equivalence regrade.
    normalizedTurns: rows.filter(r => r.check.diagnostics?.normalizations?.length).length } };
}

/** No credentials, fetch, reserve, receipt or continuation writes. Missing
 * namespaces stay missing, and a blocked ledger stays blocked after export. */
export async function auditSavedBenchmark(ledger: BenchmarkLedger) {
  const matched = new Set<string>();
  const reports = [];
  const receiptInfo = (id: string) => {
    const record = ledger.records.get(id)!;
    const model = Object.entries(candidates).find(([, spec]) => spec.model === record.reserve.bound.modelVersion)?.[0] ?? 'other';
    return { id, candidate: model, code: record.receipt?.code ?? (record.receipt ? null : 'BENCH_RECEIPT_MISSING'),
      usage: record.receipt?.usage ? { inputTokens: record.receipt.usage.inputTokens, outputTokens: record.receipt.usage.outputTokens,
        modelVersion: record.receipt.usage.modelVersion === null ? null : model === 'other' ? '[MODEL_REDACTED]' : candidates[model as Candidate].model } : null,
      atoms: record.receipt?.atoms ?? null,
      heldAtoms: record.receipt?.usage ? '0' : record.reserve.atoms,
      fingerprintHash: record.receipt?.fingerprint ? digest(record.receipt.fingerprint) : null,
      cachedTokens: record.receipt?.cachedTokens ?? null, reasoningTokens: record.receipt?.reasoningTokens ?? null };
  };
  for (const batch of batches) {
    const rows: { check: SmokeCheck; scenarioId: string }[] = [];
    const requests: { id: string; turnId: string; step: 'gate' | 'plan' }[] = [];
    let result: Awaited<ReturnType<typeof runSmoke>> | undefined, stoppedBy: string | null = null;
    try {
      result = await runSmoke(replayOnlyBenchmarkTransport(batch.candidate, batch.contract), ledger, 'task', batch.phase, true, batch.revision, batch.corpus, {
        receipt(id, turnId, step) { matched.add(id); requests.push({ id, turnId, step }); },
        turn(check, scenarioId) { rows.push({ check, scenarioId }); },
      });
    } catch (error) {
      if (!(error instanceof BenchmarkFailure) || !['BENCH_REPLAY_ONLY', 'BENCH_RECONCILIATION_REQUIRED'].includes(error.code)) throw error;
      stoppedBy = error.code;
    }
    const analysis = analyzeSavedChecks(rows);
    reports.push({ ...batch, status: result ? 'complete' : requests.length ? 'incomplete' : 'not_started', stoppedBy,
      benchmarkPromptVersion: result?.benchmarkPromptVersion ?? null, costPerTurnAtoms: result?.costPerTurnAtoms ?? null,
      ...analysis, requests: requests.map(ref => ({ ...receiptInfo(ref.id), turnId: ref.turnId, step: ref.step,
        // Only batch receipts: probes/unmatched values are deliberately omitted.
        validatedStoredValue: sanitized(ledger.records.get(ref.id)!.receipt?.value ?? null) })) });
  }
  return { audit: 'cashneuro-saved-audit/1', paidCalls: 0, paidTrialStatus,
    coverage: { ledgerRecords: ledger.records.size, matchedRecords: matched.size,
      unmatchedRecords: [...ledger.records.keys()].filter(id => !matched.has(id)).map(receiptInfo),
      limitations: ['Validated stored gate/planner results, not discarded raw provider bodies or private reasoning.',
        'Only historical task-mode namespaces are reconstructed; other/probe records remain explicitly unmatched.',
        'Earlier failure is a cascade risk indicator, not proof of causation.',
        'No final natural-language answer, database computation or user-facing acceptance was tested.'] },
    batches: reports, cost: smokeCostReport(ledger) };
}
