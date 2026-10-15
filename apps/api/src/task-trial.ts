import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { object, facet } from '../../../packages/finance-core/src/model.ts';
import type { OperationRow } from '../../../packages/finance-core/src/operations.ts';
import { calculateWidget, parseWidget } from '../../../packages/finance-core/src/overview.ts';
import type { OverviewCatalog } from '../../../packages/finance-core/src/overview.ts';
import { parseTool } from '../../../packages/analyzer/src/registry.ts';
import type { Query, Relevance } from '../../../packages/analyzer/src/registry.ts';
import type { Catalog } from '../../../packages/analyzer/src/yandex-contract.ts';
import { safeQuestion } from '../../../packages/analyzer/src/yandex-contract.ts';
import { globalSnapshot, emptyTaskBook, parseTaskBook } from '../../../packages/analyzer/src/task-context.ts';
import type { GlobalSnapshot } from '../../../packages/analyzer/src/task-context.ts';
import { taskRelevancePrompt, taskProposalPrompt, taskRelevanceSchema, taskProposalSchema } from '../../../packages/analyzer/src/task-protocol.ts';
import { tokenCost } from '../../../packages/analyzer/src/cost.ts';
import { runAnalyzerTask, taskWorkflowBinding } from './analyzer-task-workflow.ts';
import type { TaskModel, TaskOutcome } from './analyzer-task-workflow.ts';
import { candidates, benchmarkRequestBody, correctedResponseContractVersion, BenchmarkFailure } from './benchmark-transport.ts';
import { smokeCostReport } from './benchmark-engine.ts';
import type { BenchmarkLedger } from './benchmark-ledger.ts';

export const taskTrialVersion = 'cashneuro-task-trial/1';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const trialRequestId = (manifestSha256: string, caseId: string, phase: 'gate' | 'plan', occurrence: number) => {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256) || !/^[a-z][a-z0-9-]{1,60}$/.test(caseId) || !['gate', 'plan'].includes(phase) || !Number.isInteger(occurrence) || occurrence < 0 || occurrence > 2) throw new BenchmarkFailure('TASK_TRIAL_ID_INVALID');
  return digest(JSON.stringify({ experiment: taskTrialVersion, manifestSha256, caseId, phase, occurrence }));
};
export const trialId = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const food = trialId(10), travel = trialId(11), taxi = trialId(12), account = trialId(13);
export const trialCatalog: Catalog & OverviewCatalog = {
  accounts: [{ id: account, name: 'Синтетический счёт', bankId: 'synthetic', type: 'bank_account', analyticsEnabled: true, defaultVisible: true, loanMode: null }],
  categories: [{ id: food, name: 'Продукты', parentId: null, role: 'expense', hidden: false }, { id: travel, name: 'Поездки', parentId: null, role: 'expense', hidden: false }, { id: taxi, name: 'Такси', parentId: travel, role: 'expense', hidden: false }], counterparties: [],
};
function row(n: number, amount: string, category: string | null, subcategory: string | null, date: string, role: 'income' | 'expense' = 'expense'): OperationRow {
  return { id: trialId(n), accountId: account, amountMinor: amount, date: { precision: 'day', date }, analyticsRole: role, decompositionActive: false,
    reviewReasons: n === 30 ? ['possible_duplicate'] : [], unresolvedMinor: '0', neutralMinor: '0', excludedMinor: '0',
    classification: { kind: facet(role === 'income' ? 'transfer_in' : 'purchase'), role: facet(role), category: facet(category), subcategory: facet(subcategory), merchant: facet('Синтетический магазин'), counterparty: facet(null) },
    parts: [{ id: 'trial-part-' + n, componentId: null, allocationId: null, amountMinor: amount, role, categoryId: category, subcategoryId: subcategory, included: true, basis: [] }], comment: '' };
}
export const trialRows = [row(30, '-120000', food, null, '2026-09-02'), row(31, '-40000', food, null, '2026-09-04'), row(32, '-35000', travel, taxi, '2026-09-07'),
  row(33, '-17000', travel, taxi, '2026-10-01'), row(34, '2000000', null, null, '2026-10-10', 'income'), row(35, '100000', food, null, '2026-10-12', 'income')];
type Expected = { relevance: Relevance; status: 'query' | 'clarification' | 'redirect' | 'unsupported'; query?: Query; totalMinor?: string; parentTurnId?: string | null };
export type TrialTurn = { id: string; split: 'development' | 'holdout'; family: string; question: string; global: GlobalSnapshot; expected: Expected };
export type TrialScore = { id: string; occurrence: number; split: TrialTurn['split']; family: string; passed: boolean; earlierFailure: boolean;
  relevanceCorrect: boolean; statusCorrect: boolean; queryCorrect: boolean; bindingCorrect: boolean; totalCorrect: boolean; privacyCorrect: boolean;
  planFields: Record<string, boolean>; actualStatus: TaskOutcome<unknown>['status']; actualQuery?: Query; actualTotalMinor?: string; reason?: string };
export type TrialCorpus = { version: string; scope: string; currentDate: string; singles: TrialTurn[]; dialogs: { id: string; split: TrialTurn['split']; turns: TrialTurn[] }[];
  repetitions: { caseId: string; additionalIndependentCopies: number }[] };
export const trialResult = (query: Query) => calculateWidget(parseWidget({ id: trialId(90), name: 'Синтетическое испытание', metrics: [query.metric], grouping: query.grouping, period: 'global', filter: query.filter,
  comparison: { kind: query.comparison }, chart: 'table', topN: 10 }), structuredClone(trialRows), trialCatalog, {}, new Date('2026-10-15T12:00:00Z'));

/** Goldens are independently authored queries/totals, never model output or interpret().
 * This validates their internal consistency; it does not measure language accuracy. */
export function validateTrialCorpus(value: unknown): TrialCorpus {
  const root = object(value, ['version', 'scope', 'currentDate', 'singles', 'dialogs', 'repetitions']);
  const fail = (): never => { throw new BenchmarkFailure('TASK_TRIAL_CORPUS_INVALID'); };
  if (root.version !== 'cashneuro-task-trial-corpus/1' || root.currentDate !== '2026-10-15' || typeof root.scope !== 'string' || !root.scope.length ||
      !Array.isArray(root.singles) || root.singles.length !== 48 || !Array.isArray(root.dialogs) || root.dialogs.length !== 8 || !Array.isArray(root.repetitions) || root.repetitions.length !== 12) fail();
  const seen = new Set<string>();
  const turn = (value: unknown, parents: Map<string, TrialTurn>, split?: string): TrialTurn => {
    const r = object(value, ['id', 'split', 'family', 'question', 'global', 'expected']);
    if (typeof r.id !== 'string' || !/^[a-z][a-z0-9-]{1,60}$/.test(r.id) || seen.has(r.id) || !['development', 'holdout'].includes(String(r.split)) ||
        split !== undefined && r.split !== split || typeof r.family !== 'string' || !/^[a-z][a-z-]{1,40}$/.test(r.family) || typeof r.question !== 'string' || safeQuestion(r.question) !== r.question) fail();
    seen.add(r.id as string);
    const e = object(r.expected, ['relevance', 'status', 'query', 'totalMinor', 'parentTurnId']);
    if (!['financial', 'adjacent', 'ambiguous', 'unrelated'].includes(String(e.relevance)) || !['query', 'clarification', 'redirect', 'unsupported'].includes(String(e.status))) fail();
    const currentGlobal = globalSnapshot(r.global);
    if (e.status === 'query') {
      const query = parseTool(e.query);
      if (query.name !== 'query_finances' || !['financial', 'adjacent'].includes(String(e.relevance)) || typeof e.totalMinor !== 'string' || !/^-?\d{1,20}$/.test(e.totalMinor) ||
          !(e.parentTurnId === null || typeof e.parentTurnId === 'string' && parents.get(e.parentTurnId)?.expected.status === 'query')) fail();
      if (query.name !== 'query_finances' || trialResult(query).totals[query.metric] !== e.totalMinor) fail();
      const q = query as Query;
      for (const key of ['categoryIds', 'subcategoryIds'] as const) for (const id of q.filter[key] ?? []) if (!trialCatalog.categories.some(c => c.id === id)) fail();
      for (const id of q.filter.operationIds ?? []) if (!trialRows.some(row => row.id === id)) fail();
    } else if (Object.keys(e).some(k => !['relevance', 'status'].includes(k)) || e.relevance === 'unrelated' && e.status !== 'redirect' || e.relevance === 'ambiguous' && e.status !== 'clarification') fail();
    return { ...r, global: currentGlobal, expected: e } as TrialTurn;
  };
  const singles = (root.singles as unknown[]).map(v => turn(v, new Map()));
  const dialogIds = new Set<string>();
  const dialogs = (root.dialogs as unknown[]).map(value => {
    const r = object(value, ['id', 'split', 'turns']);
    if (typeof r.id !== 'string' || !/^[a-z][a-z-]{1,40}$/.test(r.id) || dialogIds.has(r.id) || !['development', 'holdout'].includes(String(r.split)) || !Array.isArray(r.turns) || r.turns.length !== 6) fail();
    dialogIds.add(r.id as string); const parents = new Map<string, TrialTurn>();
    const turns = (r.turns as unknown[]).map(v => { const t = turn(v, parents, r.split as string); parents.set(t.id, t); return t; });
    return { id: r.id as string, split: r.split as TrialTurn['split'], turns };
  });
  const repeats = new Set<string>();
  const repetitions = (root.repetitions as unknown[]).map(value => {
    const r = object(value, ['caseId', 'additionalIndependentCopies']);
    if (typeof r.caseId !== 'string' || repeats.has(r.caseId) || !singles.some(t => t.id === r.caseId && t.split === 'development') || r.additionalIndependentCopies !== 2) fail();
    repeats.add(r.caseId as string); return { caseId: r.caseId as string, additionalIndependentCopies: 2 };
  });
  const all = [...singles, ...dialogs.flatMap(d => d.turns)];
  if (all.filter(t => t.split === 'development').length !== 68 || all.filter(t => t.split === 'holdout').length !== 28) fail();
  return { version: root.version as string, scope: root.scope as string, currentDate: root.currentDate as string, singles, dialogs, repetitions };
}
export async function loadTrialCorpus() {
  const bytes = await readFile(new URL('../test/fixtures/task-trial-corpus-v1.json', import.meta.url), 'utf8');
  return { corpus: validateTrialCorpus(JSON.parse(bytes)), hash: digest(bytes) };
}

/** The same workflow/shared core runs on synthetic rows. Wrong earlier answers
 * remain visible as cascade risk; the evaluator never replaces them with goldens. */
export async function evaluateTrialScenario(turns: TrialTurn[], modelForTurn: (turn: TrialTurn, occurrence: number) => TaskModel, occurrence = 0) {
  const scope = { ownerId: 'synthetic-trial-owner', chatId: trialId(1000 + occurrence), generation: trialId(2), chatEpoch: trialId(3) };
  let book = emptyTaskBook(scope), earlierFailure = false;
  const messages = new Map(turns.map((turn, i) => [turn.id, trialId(100 + i)])), results: TrialScore[] = [];
  for (const [index, turn] of turns.entries()) {
    let actualRelevance: unknown = null; const model = modelForTurn(turn, occurrence); let catalogs = 0, calculations = 0;
    const expectedHead = book.nodes.at(-1)?.messageId ?? null, expectedCount = book.nodes.length;
    const guard = async () => { if (book.nodes.length !== expectedCount || (book.nodes.at(-1)?.messageId ?? null) !== expectedHead) throw new Error('TASK_TRIAL_STATE_CHANGED'); };
    const outcome: TaskOutcome<ReturnType<typeof trialResult>> = await runAnalyzerTask({ scope, book, global: turn.global, dataRevision: '1', messageId: messages.get(turn.id)!, question: turn.question, currentDate: '2026-10-15' }, {
      async relevance(input) { const value = await model.relevance(input); actualRelevance = value && typeof value === 'object' ? (value as { relevance?: unknown }).relevance : null; return value; },
      proposal: input => model.proposal(input),
    }, {
      guard, async catalog() { catalogs++; return structuredClone(trialCatalog); },
      async authorizeQuery(query) { parseTool(query); for (const key of ['categoryIds', 'subcategoryIds'] as const) if (query.filter[key]?.some(id => !trialCatalog.categories.some(c => c.id === id))) throw new Error('TASK_TRIAL_OWNERSHIP_DENIED'); },
      async calculate(query) { calculations++; return trialResult(query); }, async commit(input) { await guard(); book = parseTaskBook(input.book, scope); },
    });
    const e = turn.expected, relevanceCorrect = actualRelevance === e.relevance, statusCorrect = outcome.status === e.status;
    const queryCorrect = e.status === 'query' ? outcome.status === 'query' && isDeepStrictEqual(outcome.query, e.query) : outcome.status !== 'query';
    const bindingCorrect = e.status !== 'query' || outcome.status === 'query' && outcome.inheritedFrom === (e.parentTurnId === null ? null : messages.get(e.parentTurnId!));
    const totalCorrect = e.status !== 'query' || outcome.status === 'query' && outcome.result.totals[outcome.query.metric] === e.totalMinor;
    const nonfinancialExpected = ['ambiguous', 'unrelated'].includes(e.relevance), nonfinancialActual = ['ambiguous', 'unrelated'].includes(String(actualRelevance));
    const privacyCorrect = !(nonfinancialExpected || nonfinancialActual) || catalogs === 0 && calculations === 0;
    const passed = relevanceCorrect && statusCorrect && queryCorrect && bindingCorrect && totalCorrect && privacyCorrect;
    const planFields: Record<string, boolean> = {};
    if (e.query && outcome.status === 'query') {
      for (const key of ['metric', 'grouping', 'comparison'] as const) planFields[key] = outcome.query[key] === e.query[key];
      const expectedFilter = e.query.filter as Record<string, unknown>, actualFilter = outcome.query.filter as Record<string, unknown>;
      for (const key of new Set([...Object.keys(expectedFilter), ...Object.keys(actualFilter)])) planFields['filter.' + key] = isDeepStrictEqual(expectedFilter[key], actualFilter[key]);
    }
    results.push({ id: turn.id, occurrence, split: turn.split, family: turn.family, passed, earlierFailure, relevanceCorrect, statusCorrect, queryCorrect, bindingCorrect, totalCorrect, privacyCorrect, planFields, actualStatus: outcome.status,
      ...(outcome.status === 'query' ? { actualQuery: outcome.query, actualTotalMinor: outcome.result.totals[outcome.query.metric] } : { reason: outcome.reason }) });
    earlierFailure ||= !passed;
  }
  return results;
}

const fingerprintPaths = [
  'src/task-trial.ts', 'src/task-trial-main.ts', 'test/fixtures/task-trial-corpus-v1.json', 'src/analyzer-task-workflow.ts', 'src/benchmark-transport.ts',
  '../../../packages/analyzer/src/task-protocol.ts', '../../../packages/analyzer/src/task-context.ts', '../../../packages/analyzer/src/task-literals.ts',
  '../../../packages/analyzer/src/money-literals.ts', '../../../packages/analyzer/src/closed-schema.ts', '../../../packages/analyzer/src/registry.ts',
  '../../../packages/analyzer/src/cost.ts', '../../../packages/finance-core/src/operations.ts', '../../../packages/finance-core/src/overview.ts', '../../../packages/finance-core/src/model.ts',
];
export async function taskTrialManifest() {
  const { corpus, hash } = await loadTrialCorpus(), source: Record<string, string> = {};
  for (const path of fingerprintPaths) source[path] = digest(await readFile(new URL(path.startsWith('../../../') ? path : '../' + path, import.meta.url), 'utf8'));
  const spec = candidates['cloud-oss'], bound = { inputTokens: spec.contextTokens, outputTokens: 1200, modelVersion: spec.model };
  return { experiment: taskTrialVersion, corpusVersion: corpus.version, corpusSha256: hash, sourceSha256: digest(JSON.stringify(source)), source,
    workflow: taskWorkflowBinding, responseContract: correctedResponseContractVersion, candidate: 'cloud-oss', model: spec.model, bound, price: spec.price,
    promptsSha256: digest(JSON.stringify({ gate: taskRelevancePrompt, proposal: taskProposalPrompt, gateSchema: taskRelevanceSchema, proposalSchema: taskProposalSchema })),
    sampling: { temperature: 0, stream: false, n: 1, maxCompletionTokens: 1200, seed: null },
    requestIdentity: 'SHA256(experiment, manifestSha256, caseId, phase, occurrence); occurrence=0 base, 1/2 independent repeat; stable replay is not a new repeat',
    counts: { baseTurns: 96, development: 68, holdout: 28, independentRepeatTurns: 24, maximumTurns: 120, maximumNewModelCalls: 240 },
    budget: { existingGlobalCapAtoms: '45000000000', incrementalCapAtoms: '20000000000', maximumReservationAtoms: tokenCost(spec.price, bound.inputTokens, bound.outputTokens).toString() },
    gates: { paidRunnerImplemented: false, paidDispatchEnabled: false, immutableModelVersionVerified: false, currentTariffConfirmed: false },
    fullProductAcceptanceTurns: 420, fullProductAcceptanceExecuted: false, previouslySeenRegressionTurns: 96, previouslySeenRegressionsExecutedUnderNewProtocol: false };
}

export function assertTrialBaseline(ledger: BenchmarkLedger) {
  const cost = smokeCostReport(ledger), expected = { calls: 492, reportedCalls: 489, failedCalls: 30, inputTokens: 342288, outputTokens: 132701, spentAtoms: '13372140620', heldAtoms: '7516800640', budgetUsedUpperBoundAtoms: '20888941260' };
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) if (cost[key] !== expected[key]) throw new BenchmarkFailure('TASK_TRIAL_BASELINE_CHANGED');
  const unknown = new Map([
    ['450efb69910d48616d56b90fbc4d486ad693e39fa3ebcb6c2c2d7c2efc1e1f67', ['BENCH_PROVIDER_FAILURE', '2152001920']],
    ['0ad80ba131a38008dacf4478f6920d91bea1b5b9c4432c48cdb944d3fea43fd6', ['BENCH_PROVIDER_FAILURE_HTTP_402', '2152001920']],
    ['25a3ac53af98c5810ed7fd871cab65ff664b0191c43e9a63c1d156ca879ed185', ['BENCH_PROVIDER_FAILURE_HTTP_400', '3212796800']],
  ]);
  let count = 0;
  for (const [id, record] of ledger.records) if (!record.receipt?.usage) { count++; const old = unknown.get(id); if (!old || record.receipt?.code !== old[0] || record.reserve.atoms !== old[1]) throw new BenchmarkFailure('TASK_TRIAL_BASELINE_CHANGED'); }
  if (count !== 3 || ledger.totals().blocked) throw new BenchmarkFailure('TASK_TRIAL_RECONCILIATION_REQUIRED');
  return cost;
}

/** Exactly one GET to the fixed catalog endpoint. No completion transport,
 * reservations, keys in output, redirects, retries, locks or ledger writes. */
export async function inspectCloudTaskModel(credentials: unknown, fetcher: typeof fetch) {
  const r = object(credentials, ['apiKey']);
  if (typeof r.apiKey !== 'string' || !/^[\x21-\x7e]{20,512}$/.test(r.apiKey)) throw new BenchmarkFailure('TASK_TRIAL_CREDENTIALS_INVALID');
  let response: Response;
  try { response = await fetcher('https://foundation-models.api.cloud.ru/v1/models', { method: 'GET', headers: { authorization: 'Bearer ' + r.apiKey, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch { throw new BenchmarkFailure('TASK_TRIAL_CATALOG_UNAVAILABLE'); }
  if (!response.ok) { try { await response.body?.cancel(); } catch { /* No retry or reflected error body. */ } throw new BenchmarkFailure('TASK_TRIAL_CATALOG_HTTP_' + response.status); }
  const reader = response.body?.getReader(); if (!reader) throw new BenchmarkFailure('TASK_TRIAL_CATALOG_INVALID');
  try {
    const parts: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 524288) throw new Error(); parts.push(part.value); }
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || !Array.isArray(value.data) || value.data.length > 1000) throw new Error();
    const matches = value.data.filter((m: unknown) => !!m && typeof m === 'object' && (m as { id?: unknown }).id === candidates['cloud-oss'].model);
    if (matches.length !== 1) throw new Error();
    const model = matches[0] as Record<string, unknown>;
    const numeric: Record<string, number> = {};
    for (const name of ['created', 'context_length', 'max_model_len', 'max_input_tokens', 'max_output_tokens']) if (Number.isSafeInteger(model[name]) && (model[name] as number) >= 0) numeric[name] = model[name] as number;
    // Untrusted free text is never returned, including descriptions/provider errors.
    return { model: candidates['cloud-oss'].model, modelMetadataSha256: digest(JSON.stringify(model)), numericMetadata: numeric,
      metadataFieldsPresent: ['created', 'owned_by', 'version', 'revision', 'snapshot', 'context_length', 'max_model_len', 'max_input_tokens', 'max_output_tokens', 'pricing', 'capabilities'].filter(k => Object.hasOwn(model, k)),
      immutableModelVersionVerified: false, priceVerified: false, paidCalls: 0, catalogHttpCalls: 1 };
  } catch { throw new BenchmarkFailure('TASK_TRIAL_CATALOG_INVALID'); }
  finally { try { await reader.cancel(); } catch { /* Stream may already be closed. */ } }
}

// Exported only for request-shape inspection/tests; no fetch or provider key.
export const trialWire = (phase: 'gate' | 'plan', input: unknown) => benchmarkRequestBody('cloud-oss', { inputTokens: 131072, outputTokens: 1200, modelVersion: candidates['cloud-oss'].model },
  phase === 'gate' ? taskRelevancePrompt : taskProposalPrompt, input, phase === 'gate' ? taskRelevanceSchema : taskProposalSchema);
