import { isDeepStrictEqual } from 'node:util';
import { benchmarkDigest } from './benchmark-ledger.ts';
import { BenchmarkFailure } from './benchmark-transport.ts';
import { loadTrialCorpus, evaluateTrialScenario, trialRequestId, trialResult } from './task-trial.ts';
import type { TrialScore, TrialTurn } from './task-trial.ts';
import type { TaskModel } from './analyzer-task-workflow.ts';
import { replayOnlyTaskJsonTransport, taskJsonRequestBody } from './task-json-transport.ts';
import { taskRelevancePrompt, taskProposalPrompt, taskRelevanceSchema, taskProposalSchema, parseTaskRelevance, parseTaskProposalWire } from '../../../packages/analyzer/src/task-protocol.ts';
import { object } from '../../../packages/finance-core/src/model.ts';

export const observedJsonRun = {
  bindingSha256: '852762c202aa874604736a9406ccf134e8de90fe7485aadc15972eb5e77a362b',
  frozenSha256: 'e3a80d6cc2696b376e043fee6ccf318481796be0c2ee0246168453165e945379',
  exportSha256: '17ba8bd3edb17fd11b558573ba121c1b5e56630c3d4b97c1de197a0a173e398b',
  codeCommit: '8105e713d9045bae0182dbb7aabeeb8dcf354fec',
} as const;
const fail = (code: string): never => { throw new BenchmarkFailure('TASK_JSON_AUDIT_' + code); };
type Cached = { id: string; wireSha256: string; value: unknown; code: string | null };
type Trace = { id: string; occurrence: number; question: string; expected: TrialTurn['expected']; hasFinancialTasks?: boolean;
  tasks?: Parameters<TaskModel['proposal']>[0]['tasks']; gate?: unknown; plan?: unknown; gateCode?: string | null; planCode?: string | null;
  gateReused?: boolean; gateWire?: string; planWire?: string; score?: TrialScore };

/** Offline forensic replay of ONE observed artifact. No key, ledger, fetch,
 * reservation or model adapter is accepted here. Invalid lost payloads stay lost. */
export async function auditObservedJsonCache(value: unknown) {
  const root = object(value, ['audit', 'bindingSha256', 'frozenSha256', 'paidCalls', 'records']);
  if (root.audit !== 'cashneuro-json-cached-decisions/1' || root.bindingSha256 !== observedJsonRun.bindingSha256 || root.frozenSha256 !== observedJsonRun.frozenSha256 || root.paidCalls !== 0 ||
      !Array.isArray(root.records) || root.records.length !== 170) return fail('EXPORT_INVALID');
  const records = new Map<string, Cached>();
  for (const raw of root.records) {
    const r = object(raw, ['id', 'wireSha256', 'value', 'code']);
    if (typeof r.id !== 'string' || !/^[a-f0-9]{64}$/.test(r.id) || typeof r.wireSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.wireSha256) || records.has(r.id) ||
        r.code !== null && r.code !== 'TASK_PILOT_PAYLOAD_INVALID' || r.code === 'TASK_PILOT_PAYLOAD_INVALID' && r.value !== null) return fail('EXPORT_INVALID');
    records.set(r.id, r as Cached);
  }
  if (benchmarkDigest(value) !== observedJsonRun.exportSha256) return fail('EXPORT_CHANGED');
  const { corpus } = await loadTrialCorpus(), bound = replayOnlyTaskJsonTransport().bound, consumed = new Set<string>(), rows: Trace[] = [];
  const modelForTurn = (turn: TrialTurn, occurrence: number): TaskModel => {
    const trace: Trace = { id: turn.id, occurrence, question: turn.question, expected: turn.expected }; rows.push(trace);
    const call = (phase: 'gate' | 'plan', input: Parameters<TaskModel['relevance']>[0] | Parameters<TaskModel['proposal']>[0]) => {
      if (phase === 'gate') trace.hasFinancialTasks = (input as Parameters<TaskModel['relevance']>[0]).hasFinancialTasks;
      else trace.tasks = (input as Parameters<TaskModel['proposal']>[0]).tasks;
      if (phase === 'gate' && turn.id === 'single-01' && occurrence === 0) { trace.gateReused = true; return trace.gate = { relevance: 'financial' }; }
      const id = trialRequestId(observedJsonRun.bindingSha256, turn.id, phase, occurrence), old = records.get(id);
      if (!old) return fail('CACHE_MISSING');
      const prompt = phase === 'gate' ? taskRelevancePrompt : taskProposalPrompt, schema = phase === 'gate' ? taskRelevanceSchema : taskProposalSchema;
      if (benchmarkDigest(taskJsonRequestBody('cloud-oss', bound, prompt, input, schema)) !== old.wireSha256) return fail('WIRE_CHANGED');
      consumed.add(id); trace[phase] = old.value; trace[phase + 'Code' as 'gateCode' | 'planCode'] = old.code; trace[phase + 'Wire' as 'gateWire' | 'planWire'] = old.wireSha256;
      if (old.code) return {};
      return phase === 'gate' ? parseTaskRelevance(old.value) : parseTaskProposalWire(old.value, turn.question);
    };
    return { relevance: async input => call('gate', input), proposal: async input => call('plan', input) };
  };
  const evaluate = async (turns: TrialTurn[], occurrence = 0) => {
    const scores = await evaluateTrialScenario(turns, modelForTurn, occurrence);
    for (const score of scores) rows.findLast(r => r.id === score.id && r.occurrence === score.occurrence)!.score = score;
  };
  for (const turn of corpus.singles.filter(t => t.split === 'development')) await evaluate([turn]);
  for (const dialog of corpus.dialogs.filter(d => d.split === 'development')) await evaluate(dialog.turns);
  for (const repeat of corpus.repetitions) for (let copy = 1; copy <= repeat.additionalIndependentCopies; copy++) await evaluate([corpus.singles.find(t => t.id === repeat.caseId)!], copy);
  if (consumed.size !== records.size) return fail('UNUSED_RECORDS');
  const failures = rows.filter(r => !r.score!.passed), repeatGroups = corpus.repetitions.map(repeat => {
    const copies = rows.filter(r => r.id === repeat.caseId), outcomes = copies.map(r => ({ passed: r.score!.passed, status: r.score!.actualStatus, query: r.score!.actualQuery ?? null, reason: r.score!.reason ?? null }));
    return { id: repeat.caseId, occurrences: copies.map(r => r.occurrence), passed: copies.map(r => r.score!.passed),
      planWireIdentical: new Set(copies.map(r => r.planWire).filter(Boolean)).size === 1, semanticOutcomeVaries: outcomes.some(v => !isDeepStrictEqual(v, outcomes[0])) };
  });
  const representationOnly = rows.filter(r => !r.score!.passed && r.score!.actualQuery?.metric === 'attention' && r.expected.query?.metric === 'attention' &&
    Object.entries(r.score!.planFields).filter(([, correct]) => !correct).map(([field]) => field).join(',') === 'filter.attention').map(r => {
    const actual = trialResult(r.score!.actualQuery!), expected = trialResult(r.expected.query!);
    const points = (v: typeof actual) => v.points.map(p => ({ key: p.key, values: p.values, previous: p.previous }));
    return { id: r.id, occurrence: r.occurrence, currentTotalsEqual: isDeepStrictEqual(actual.totals, expected.totals),
      currentPointsEqual: isDeepStrictEqual(points(actual), points(expected)), currentOperationCountsEqual: actual.operationCount === expected.operationCount,
      countedAsPassed: false, futureTaskScopeEquivalent: 'not_proven' };
  });
  return { audit: 'cashneuro-json-cache-review/1', observed: observedJsonRun, suppliedExportSha256: benchmarkDigest(value), recordsConsumed: consumed.size,
    paidCalls: 0, httpCalls: 0, ledgerModified: false, oldResultsRescoredAsSuccess: false, holdoutOpened: false,
    turns: rows.length, passed: rows.filter(r => r.score!.passed).length,
    development: { turns: rows.filter(r => r.occurrence === 0).length, passed: rows.filter(r => r.occurrence === 0 && r.score!.passed).length },
    independentRepetitions: { turns: rows.filter(r => r.occurrence > 0).length, passed: rows.filter(r => r.occurrence > 0 && r.score!.passed).length },
    primaryFailures: failures.filter(r => !r.score!.earlierFailure).length, failuresWithEarlierFailure: failures.filter(r => r.score!.earlierFailure).length,
    lostRejectedPayloads: [...records.values()].filter(r => r.code).length, repeatGroups, representationOnly, rows };
}
