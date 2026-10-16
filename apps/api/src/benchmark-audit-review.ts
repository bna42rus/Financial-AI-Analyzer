import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runSmoke } from './benchmark-engine.ts';
import type { SmokeRevision, SmokeCheck } from './benchmark-engine.ts';
import type { BenchmarkLedger } from './benchmark-ledger.ts';
import { candidates, replayOnlyBenchmarkTransport, BenchmarkFailure } from './benchmark-transport.ts';
import type { Candidate, ResponseContract } from './benchmark-transport.ts';
import { tokenCost } from '../../../packages/analyzer/src/cost.ts';
import { analyzeSavedChecks, historicalAuditBatches, paidTrialStatus } from './benchmark-audit.ts';

const fail = () => { throw new Error('BENCH_AUDIT_EXPORT_INCONSISTENT'); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) return fail(); return Number(value); }
function atoms(value: unknown): bigint { if (typeof value !== 'string' || !/^\d+$/.test(value)) return fail(); return BigInt(value); }

/** Reconstruct inputs and historical request IDs in a memory-only replay view.
 * It has no file, credentials, network or mutation methods. The caller keeps
 * the uploaded source unchanged; this verifies consistency, not authenticity. */
export async function reviewSavedAudit(source: unknown) {
  const audit = source as any;
  if (audit?.audit !== 'cashneuro-saved-audit/1' || audit.paidCalls !== 0 || audit.paidTrialStatus !== paidTrialStatus || !Array.isArray(audit.batches) || !Array.isArray(audit.coverage?.unmatchedRecords)) return fail();
  // Require the whole inventory, including unstarted and incomplete namespaces.
  const descriptor = ({ candidate, revision, contract, phase, corpus }: any) => ({ candidate, revision, contract, phase, corpus });
  if (!isDeepStrictEqual(audit.batches.map(descriptor), historicalAuditBatches)) return fail();
  const records = new Map<string, any>();
  const insert = (row: any) => {
    if (!row || typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.id) || !Object.hasOwn(candidates, row.candidate)) return fail();
    const record = Object.fromEntries(Object.entries(row).filter(([key]) => !['turnId', 'step', 'validatedStoredValue'].includes(key)));
    if (records.has(row.id) && !isDeepStrictEqual(records.get(row.id), record)) return fail();
    records.set(row.id, record);
  };
  for (const batch of audit.batches) {
    if (!Array.isArray(batch.requests) || !Array.isArray(batch.turns)) return fail();
    for (const row of batch.requests) { if (row.candidate !== batch.candidate) return fail(); insert(row); }
  }
  for (const row of audit.coverage.unmatchedRecords) insert(row);
  let spent = 0n, held = 0n, inputTokens = 0, outputTokens = 0, reportedCalls = 0, failedCalls = 0;
  for (const row of records.values()) {
    held += atoms(row.heldAtoms);
    if (row.code && row.code !== 'BENCH_RECEIPT_MISSING') failedCalls++;
    const spec = candidates[row.candidate as Candidate];
    if (row.fingerprintHash !== null && (typeof row.fingerprintHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprintHash))) return fail();
    if (!row.usage) {
      if (row.atoms !== null || row.heldAtoms !== tokenCost(spec.price, spec.contextTokens, 1200).toString()) return fail();
      continue;
    }
    reportedCalls++; const input = integer(row.usage.inputTokens), output = integer(row.usage.outputTokens);
    if (row.usage.modelVersion !== null && row.usage.modelVersion !== spec.model || row.cachedTokens !== null && integer(row.cachedTokens) > input || row.reasoningTokens !== null && integer(row.reasoningTokens) > output) return fail();
    inputTokens += input; outputTokens += output;
    if (row.heldAtoms !== '0' || row.atoms !== tokenCost(candidates[row.candidate as Candidate].price, input, output).toString()) return fail();
    spent += atoms(row.atoms);
  }
  if (records.size !== audit.coverage.ledgerRecords || reportedCalls !== audit.cost?.reportedCalls || failedCalls !== audit.cost.failedCalls || records.size !== audit.cost.calls || inputTokens !== audit.cost.inputTokens || outputTokens !== audit.cost.outputTokens || spent !== atoms(audit.cost.spentAtoms) || held !== atoms(audit.cost.heldAtoms) || spent + held !== atoms(audit.cost.budgetUsedUpperBoundAtoms)) return fail();

  const values = new Map<string, unknown>();
  for (const batch of audit.batches) for (const row of batch.requests) {
    if (values.has(row.id) && !isDeepStrictEqual(values.get(row.id), row.validatedStoredValue)) return fail();
    values.set(row.id, row.validatedStoredValue);
  }
  const replayRecords = new Map([...records].map(([id, row]) => [id, { receipt: { usage: row.usage, atoms: row.atoms,
    value: values.get(id) ?? null, code: row.code, latencyMs: 0, fingerprint: null, cachedTokens: row.cachedTokens, reasoningTokens: row.reasoningTokens } }]));
  // Deliberately no reserve(), receipt(), continuation(), close() or file.
  const view = { records: replayRecords, totals: () => ({ spent, held, blocked: true }) } as unknown as BenchmarkLedger;
  const matched = new Set<string>(), wireGroups = new Map<string, any[]>(), batchReviews = [];
  for (const batch of audit.batches) {
    if (!Object.hasOwn(candidates, batch.candidate) || !['legacy', 'empty-tools'].includes(batch.contract) || !['initial', 'after-funding'].includes(batch.phase) || !['smoke', 'transfer'].includes(batch.corpus) || !['original', 'revised', 'resolved', 'delta', 'explicit', 'literal', 'context'].includes(batch.revision)) return fail();
    const checks: { check: SmokeCheck; scenarioId: string }[] = [], refs: any[] = []; let result: Awaited<ReturnType<typeof runSmoke>> | undefined, stoppedBy: string | null = null;
    try {
      result = await runSmoke(replayOnlyBenchmarkTransport(batch.candidate, batch.contract as ResponseContract), view, 'task', batch.phase, true, batch.revision as SmokeRevision, batch.corpus, {
        receipt(id, turnId, step, wireBodyHash) {
          matched.add(id); refs.push({ id, turnId, step, wireBodyHash });
          const row = records.get(id)!;
          const group = wireGroups.get(wireBodyHash) ?? [];
          group.push({ candidate: batch.candidate, revision: batch.revision, corpus: batch.corpus, phase: batch.phase, contract: batch.contract,
            turnId, step, id, code: row.code, fingerprintHash: row.fingerprintHash,
            // Only gate values are complete pre-merge model decisions. Comparing
            // final plans across different hidden server scopes would be false.
            gate: step === 'gate' && row.code === null ? values.get(id) : null });
          wireGroups.set(wireBodyHash, group);
        },
        turn(check, scenarioId) { checks.push({ scenarioId, check }); },
      });
    } catch (error) {
      if (!(error instanceof BenchmarkFailure) || !['BENCH_REPLAY_ONLY', 'BENCH_RECONCILIATION_REQUIRED'].includes(error.code)) throw error;
      stoppedBy = error.code;
    }
    const status = result ? 'complete' : refs.length ? 'incomplete' : 'not_started';
    if (status !== batch.status || stoppedBy !== batch.stoppedBy || refs.length !== batch.requests.length || checks.length !== batch.turns.length) return fail();
    if (batch.benchmarkPromptVersion !== (result?.benchmarkPromptVersion ?? null) || !isDeepStrictEqual(batch.costPerTurnAtoms, result?.costPerTurnAtoms ?? null)) return fail();
    for (let i = 0; i < refs.length; i++) if (refs[i].id !== batch.requests[i].id || refs[i].turnId !== batch.requests[i].turnId || refs[i].step !== batch.requests[i].step) return fail();
    for (let i = 0; i < checks.length; i++) {
      const observed = batch.turns[i], current = checks[i]!;
      for (const key of ['id', 'gate', 'plan', 'calls', 'inputTokens', 'outputTokens', 'costAtoms', 'diagnostics'] as const) if (!isDeepStrictEqual(current.check[key], observed[key])) return fail();
      if (current.scenarioId !== observed.scenarioId) return fail();
    }
    const strictPassed = checks.filter(({ check }) => check.gate && check.plan !== false).length;
    const analysis = analyzeSavedChecks(checks);
    if (!isDeepStrictEqual(analysis.metrics, batch.metrics) || analysis.turns.some((turn, i) => !isDeepStrictEqual(turn.analysis, batch.turns[i].analysis))) return fail();
    const requestRows = batch.requests.filter((r: any) => r.usage);
    const reasoning = requestRows.reduce((n: number, r: any) => n + (r.reasoningTokens ?? 0), 0);
    batchReviews.push({ candidate: batch.candidate, revision: batch.revision, corpus: batch.corpus, contract: batch.contract, phase: batch.phase,
      status, reconstructedRequests: refs.length, evaluatedTurns: checks.length, strictPassed,
      inputTokens: requestRows.reduce((n: number, r: any) => n + r.usage.inputTokens, 0),
      outputTokens: requestRows.reduce((n: number, r: any) => n + r.usage.outputTokens, 0), reasoningTokens: reasoning,
      // These are provider-reported subsets, not additional billable tokens.
      cachedTokens: requestRows.reduce((n: number, r: any) => n + (r.cachedTokens ?? 0), 0),
      spentAtoms: requestRows.reduce((n: bigint, r: any) => n + BigInt(r.atoms), 0n).toString(),
      gateRequests: batch.requests.filter((r: any) => r.step === 'gate').length,
      plannerRequests: batch.requests.filter((r: any) => r.step === 'plan').length,
      turns: analysis.turns.map((t, i) => ({ id: t.id, scenarioId: t.scenarioId, strictPassed: t.gate && t.plan !== false,
        ...t.analysis, errors: checks[i]!.check.diagnostics!.errors })) });
  }
  if (matched.size !== audit.coverage.matchedRecords) return fail();
  const repeated = [...wireGroups].filter(([, members]) => new Set(members.map(m => m.id)).size > 1);
  const conflicts = repeated.flatMap(([wireBodyHash, members]) => {
    const valid = members.filter(m => m.gate !== null);
    if (new Set(valid.map(m => hash(m.gate))).size <= 1) return [];
    return [{ wireBodyHash, observations: valid }];
  });
  return { review: 'cashneuro-saved-review/1', paidCalls: 0,
    verified: { ledgerRecords: records.size, reconstructedRequests: matched.size, unmatchedRecords: audit.coverage.unmatchedRecords.length,
      reportedCalls, failedCalls, unknownCalls: records.size - reportedCalls, inputTokens, outputTokens, spentAtoms: spent.toString(), heldAtoms: held.toString(),
      upperBoundAtoms: (spent + held).toString(), billingReconciled: false, immutableModelVersionVerified: false,
      evaluatedTurns: batchReviews.reduce((n, b) => n + b.evaluatedTurns, 0),
      exactHistoricalScoresAndGoldens: true, exactRecordedCosts: true },
    batches: batchReviews, repeatedWireBodies: repeated.length,
    repeatedGateWireBodies: repeated.filter(([, members]) => members[0].step === 'gate').length,
    repeatedPlannerWireBodies: repeated.filter(([, members]) => members[0].step === 'plan').length,
    divergentGateWireGroups: conflicts,
    limitations: ['Wire bodies reconstructed from frozen source and checked against recorded request IDs; headers/provider hidden state were not captured.',
      'Gate values are compared before any server merge. Final planner objects are not used as proof of model variability.',
      'Incidental repeats are not randomized independent trials and do not estimate a production error rate.',
      'This verifies consistency of the supplied export, not a signature or provider invoice.'] };
}
