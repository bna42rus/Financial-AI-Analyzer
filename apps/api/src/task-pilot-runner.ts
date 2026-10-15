import { performance } from 'node:perf_hooks';
import { benchmarkDigest } from './benchmark-ledger.ts';
import { BenchmarkFailure, benchmarkRequestBody } from './benchmark-transport.ts';
import type { BenchmarkResult, BenchmarkTransport } from './benchmark-transport.ts';
import { taskTrialManifest, trialRequestId, evaluateTrialScenario } from './task-trial.ts';
import type { TrialCorpus, TrialTurn, TrialScore } from './task-trial.ts';
import type { TaskModel } from './analyzer-task-workflow.ts';
import { taskRelevancePrompt, taskProposalPrompt, taskRelevanceSchema, taskProposalSchema, parseTaskRelevance, parseTaskProposalWire } from '../../../packages/analyzer/src/task-protocol.ts';
import { PilotJournal } from './task-pilot-journal.ts';

export const pilotVersion = 'cashneuro-cloud-service-pilot/1';
export const pilotProviderSnapshot = 'b27d11d11429899c431d95d974e69a5dfb7e56797fe127584992a2782432db68';
export const pilotTariff = { version: '261015', checkedOn: '2026-10-15', url: 'https://cdn.cloud.ru/docs/legal/tariffs/evolution/current-version/foundation-models.pdf', rows: [271, 272], inputRubPerMillion: '15.86', outputRubPerMillion: '61', taxIncluded: true };
export function assertPilotFreshness(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const day = ['year', 'month', 'day'].map(kind => parts.find(p => p.type === kind)!.value).join('-');
  if (day !== pilotTariff.checkedOn) throw new BenchmarkFailure('TASK_PILOT_FRESHNESS_RECHECK_REQUIRED');
}
export async function pilotBinding() {
  const manifest = await taskTrialManifest();
  if (manifest.corpusSha256 !== '8b7f4890d9cc172c37856be9e0bea53a455a07dcc33a76829bb2a834e19e213f' || manifest.promptsSha256 !== 'e2465ece6e41faf4cb7277c4b667ef6b1ce544e705412a23dabc1c11f3c347e8' ||
      manifest.bound.inputTokens !== 131072 || manifest.bound.outputTokens !== 1200 || manifest.price.inputRubPerMillion !== pilotTariff.inputRubPerMillion || manifest.price.outputRubPerMillion !== pilotTariff.outputRubPerMillion) throw new BenchmarkFailure('TASK_PILOT_CONTRACT_CHANGED');
  const binding = { version: pilotVersion, manifest, providerMetadataSha256: pilotProviderSnapshot, tariff: pilotTariff,
    scope: 'Provisional bounded evaluation of the observed Cloud.ru service alias; not immutable-model acceptance, staging enablement or release.',
    incrementalCapAtoms: '20000000000', maximumCalls: 240, controlledPilotDispatchEnabled: true, paidDispatchScope: 'operator --live-pilot only; no legacy CLI or runtime enablement', immutableModelVersionVerified: false, currentTariffConfirmed: true };
  return { binding, sha256: benchmarkDigest(binding) };
}
export function pilotRequestIds(corpus: TrialCorpus, bindingSha256: string) {
  const slots = [...corpus.singles, ...corpus.dialogs.flatMap(d => d.turns)].map(turn => ({ turn, occurrence: 0 }));
  for (const repeat of corpus.repetitions) for (let occurrence = 1; occurrence <= repeat.additionalIndependentCopies; occurrence++) slots.push({ turn: corpus.singles.find(t => t.id === repeat.caseId)!, occurrence });
  return slots.flatMap(({ turn, occurrence }) => (['gate', 'plan'] as const).map(phase => trialRequestId(bindingSha256, turn.id, phase, occurrence))).sort();
}
export function pilotStagePassed(corpus: TrialCorpus, rows: TrialScore[], includeHoldout: boolean) {
  const slots = [...corpus.singles, ...corpus.dialogs.flatMap(d => d.turns)].filter(t => includeHoldout || t.split === 'development').map(t => `${t.id}@0`);
  for (const r of corpus.repetitions) for (let copy = 1; copy <= r.additionalIndependentCopies; copy++) slots.push(`${r.caseId}@${copy}`);
  const actual = rows.map(r => `${r.id}@${r.occurrence}`), expected = new Set(slots);
  return rows.length === slots.length && new Set(actual).size === slots.length && actual.every(id => expected.has(id)) && rows.every(row => row.passed);
}
type Diagnostics = { paidCalls: number; replayCalls: number; errors: { id: string; code: string }[] };
export type RejectedTaskPayload = { id: string; wireSha256: string; phase: 'gate' | 'plan'; value: unknown; validationCode: string };
export type RejectedTaskSink = (payload: RejectedTaskPayload) => Promise<void>;
/** Technical usage is durably settled before closed parsing/private-cache work.
 * Missing cache after an actual receipt is an explicit stop, never repayment. */
export function pilotModel(transport: BenchmarkTransport, journal: PilotJournal, bindingSha256: string, turn: TrialTurn, occurrence: number, diagnostics: Diagnostics, secrets: string[] = [], beforeDispatch?: () => void, reusedInitialGate?: { turnId: string; value: unknown }, onRejectedPayload?: RejectedTaskSink): TaskModel {
  const reflected = (value: string | null | undefined) => !!value && secrets.some(secret => secret.length > 0 && value.includes(secret));
  async function call(phase: 'gate' | 'plan', input: unknown) {
    const prompt = phase === 'gate' ? taskRelevancePrompt : taskProposalPrompt, schema = phase === 'gate' ? taskRelevanceSchema : taskProposalSchema;
    const wireSha256 = benchmarkDigest(transport.requestBody?.(prompt, input, schema) ?? benchmarkRequestBody('cloud-oss', transport.bound, prompt, input, schema)), id = trialRequestId(bindingSha256, turn.id, phase, occurrence);
    const parse = (value: unknown) => {
      const checked = phase === 'gate' ? parseTaskRelevance(value) : parseTaskProposalWire(value, turn.question);
      if (secrets.some(secret => secret.length > 0 && JSON.stringify(checked).includes(secret))) throw new Error('REFLECTED_CREDENTIAL_DENIED');
      return checked;
    };
    if (phase === 'gate' && occurrence === 0 && reusedInitialGate?.turnId === turn.id) { diagnostics.replayCalls++; return parse(reusedInitialGate.value); }
    const old = journal.ledger.records.get(id);
    if (old) {
      const cached = await journal.cached(id, wireSha256); diagnostics.replayCalls++;
      if (cached.code) { diagnostics.errors.push({ id, code: cached.code }); return {}; }
      try { return parse(cached.payload); } catch { throw new BenchmarkFailure('TASK_PILOT_CACHE_INVALID'); }
    }
    if (journal.readOnly) throw new BenchmarkFailure('BENCH_REPLAY_ONLY');
    let completed: BenchmarkResult;
    let reserved = false; const started = performance.now();
    try {
      completed = await transport.complete(prompt, input, schema, async () => { beforeDispatch?.(); await journal.reserve(id, transport.price, transport.bound); reserved = true; diagnostics.paidCalls++; });
    } catch (error) {
      if (!reserved) throw error;
      const failure = error instanceof BenchmarkFailure ? error : new BenchmarkFailure('BENCH_DELIVERY_UNKNOWN');
      await journal.ledger.receipt({ id, usage: failure.usage ?? null, value: { wireSha256 }, code: failure.code, fingerprint: reflected(failure.fingerprint) ? null : failure.fingerprint ?? null,
        latencyMs: Math.ceil(performance.now() - started), cachedTokens: null, reasoningTokens: null });
      diagnostics.errors.push({ id, code: failure.code });
      if (!failure.usage || journal.verify().cost.blocked) throw new BenchmarkFailure('BENCH_RECONCILIATION_REQUIRED');
      return {};
    }
    const unsafeFingerprint = reflected(completed.fingerprint);
    await journal.ledger.receipt({ id, usage: completed.usage, value: { wireSha256 }, code: unsafeFingerprint ? 'TASK_PILOT_PROVIDER_INVALID' : null, fingerprint: unsafeFingerprint ? null : completed.fingerprint,
      latencyMs: Math.ceil(performance.now() - started), cachedTokens: completed.cachedTokens, reasoningTokens: completed.reasoningTokens });
    if (unsafeFingerprint || journal.verify().cost.blocked) throw new BenchmarkFailure('TASK_PILOT_PROVIDER_DRIFT');
    let value: unknown, code: string | null = null, validationCode = 'closed_contract';
    try { value = parse(completed.value); } catch (error) {
      value = null; code = 'TASK_PILOT_PAYLOAD_INVALID'; diagnostics.errors.push({ id, code });
      // Only public fixed codes enter diagnostics; provider text never does.
      const message = error instanceof Error ? error.message : '';
      if (['TASK_WIRE_INVALID', 'TASK_NAMES_INVALID', 'TASK_EVIDENCE_MISSING', 'TASK_DUPLICATE_EDIT', 'TASK_EMPTY_SET', 'REFLECTED_CREDENTIAL_DENIED'].includes(message)) validationCode = message;
    }
    await journal.cache(id, wireSha256, value, code);
    // The private sink is reached only AFTER settled receipt and invalid-cache
    // fsync. Replay cannot dispatch, recache or call it again. A sink fault
    // preserves billing/cache and stops rather than silently losing evidence.
    if (code) await onRejectedPayload?.({ id, wireSha256, phase, value: completed.value, validationCode });
    return code ? {} : value;
  }
  return { relevance: input => call('gate', input), proposal: input => call('plan', input) };
}
export type PilotProgress = { phase: string; completedTurns: number; passedTurns: number; paidCallsThisRun: number; replayCalls: number; incrementalUpperAtoms: string };
export async function runPilot(corpus: TrialCorpus, transport: BenchmarkTransport, journal: PilotJournal, bindingSha256: string,
    options: { secrets?: string[]; progress?: (row: PilotProgress) => void; beforeDispatch?: () => void; reusedInitialGate?: { turnId: string; value: unknown }; onRejectedPayload?: RejectedTaskSink } = {}) {
  const diagnostics: Diagnostics = { paidCalls: 0, replayCalls: 0, errors: [] }, rows: TrialScore[] = [];
  let phase = 'development', stop: string | null = null, holdoutOpened = false;
  const onTurn = async (row: TrialScore) => {
    rows.push(row);
    if (rows.length % 6 === 0) options.progress?.({ phase, completedTurns: rows.length, passedTurns: rows.filter(r => r.passed).length,
      paidCallsThisRun: diagnostics.paidCalls, replayCalls: diagnostics.replayCalls, incrementalUpperAtoms: journal.verify().incrementalUpperAtoms });
  };
  const evaluate = async (turns: TrialTurn[], occurrence = 0) => evaluateTrialScenario(turns, turn => pilotModel(transport, journal, bindingSha256, turn, occurrence, diagnostics, options.secrets, options.beforeDispatch, options.reusedInitialGate, options.onRejectedPayload), occurrence, onTurn);
  try {
    for (const turn of corpus.singles.filter(t => t.split === 'development')) await evaluate([turn]);
    for (const dialog of corpus.dialogs.filter(d => d.split === 'development')) await evaluate(dialog.turns);
    phase = 'independent-repetitions';
    for (const repeat of corpus.repetitions) for (let occurrence = 1; occurrence <= repeat.additionalIndependentCopies; occurrence++) await evaluate([corpus.singles.find(t => t.id === repeat.caseId)!], occurrence);
    if (!pilotStagePassed(corpus, rows, false)) stop = 'TASK_PILOT_DEVELOPMENT_FAILED';
    else {
      phase = 'holdout'; holdoutOpened = true;
      for (const turn of corpus.singles.filter(t => t.split === 'holdout')) await evaluate([turn]);
      for (const dialog of corpus.dialogs.filter(d => d.split === 'holdout')) await evaluate(dialog.turns);
    }
  } catch (error) { if (!(error instanceof BenchmarkFailure)) throw error; stop = error.code; }
  holdoutOpened = [...corpus.singles, ...corpus.dialogs.flatMap(d => d.turns)].filter(t => t.split === 'holdout').some(t => journal.ledger.records.has(trialRequestId(bindingSha256, t.id, 'gate', 0)));
  const allPassed = !stop && pilotStagePassed(corpus, rows, true);
  const current = journal.verify();
  return { pilot: pilotVersion, bindingSha256, status: allPassed ? 'provisional_pilot_passed' : stop ? 'stopped' : 'provisional_pilot_failed',
    stop, phase, completedTurns: rows.length, passedTurns: rows.filter(r => r.passed).length, maximumTurns: 120, holdoutOpened,
    paidCallsThisRun: diagnostics.paidCalls, replayCalls: diagnostics.replayCalls, totalPilotCalls: current.calls, incrementalUpperAtoms: current.incrementalUpperAtoms,
    immutableModelVersionVerified: false, modelAccepted: false, runtimeAiEnabled: false,
    fieldAccuracy: Object.fromEntries(['relevanceCorrect', 'statusCorrect', 'queryCorrect', 'bindingCorrect', 'totalCorrect', 'privacyCorrect'].map(key => [key, rows.filter(r => r[key as keyof TrialScore] === true).length])),
    failures: rows.filter(r => !r.passed), technicalErrors: diagnostics.errors,
  };
}
