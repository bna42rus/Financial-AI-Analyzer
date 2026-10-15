import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAnalyzerTask } from '../src/analyzer-task-workflow.ts';
import type { TaskInput, TaskModel, TaskServices } from '../src/analyzer-task-workflow.ts';
import { emptyTaskBook, parseTaskBook } from '../../../packages/analyzer/src/task-context.ts';
import { parseTaskRelevance, taskCapabilities } from '../../../packages/analyzer/src/task-protocol.ts';
import { queryOperations } from '../../../packages/finance-core/src/operations.ts';
import { parseWidget, calculateWidget } from '../../../packages/finance-core/src/overview.ts';
import { facet } from '../../../packages/finance-core/src/model.ts';
import type { OperationRow } from '../../../packages/finance-core/src/operations.ts';

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { ownerId: id(1), chatId: id(2), generation: id(3), chatEpoch: id(4) }, food = id(10), travel = id(11), taxi = id(12), account = id(13);
const october = { from: '2026-10-01', through: '2026-10-31' }, september = { from: '2026-09-01', through: '2026-09-30' };
const catalog = { accounts: [{ id: account, name: 'Синтетический счёт', bankId: 'synthetic', type: 'bank_account' as const, analyticsEnabled: true, defaultVisible: true, loanMode: null }],
  categories: [{ id: food, name: 'Продукты', parentId: null, role: 'expense' as const, hidden: false }, { id: travel, name: 'Поездки', parentId: null, role: 'expense' as const, hidden: false }, { id: taxi, name: 'Такси', parentId: travel, role: 'expense' as const, hidden: false }], counterparties: [] };
function row(n: number, amount: string, category: string | null, subcategory: string | null, date: string, role: 'income' | 'expense' = 'expense'): OperationRow {
  return { id: id(n), accountId: account, amountMinor: amount, date: { precision: 'day', date }, analyticsRole: role, decompositionActive: false,
    reviewReasons: n === 30 ? ['possible_duplicate'] : [], unresolvedMinor: '0', neutralMinor: '0', excludedMinor: '0',
    classification: { kind: facet(role === 'income' ? 'transfer_in' : 'purchase'), role: facet(role), category: facet(category), subcategory: facet(subcategory), merchant: facet('Синтетический магазин'), counterparty: facet(null) },
    parts: [{ id: 'part-' + n, componentId: null, allocationId: null, amountMinor: amount, role, categoryId: category, subcategoryId: subcategory, included: true, basis: [] }], comment: '' };
}
const rows = [row(30, '-120000', food, null, '2026-09-02'), row(31, '-40000', food, null, '2026-09-04'), row(32, '-35000', travel, taxi, '2026-09-07'), row(33, '-17000', travel, taxi, '2026-10-01'), row(34, '2000000', null, null, '2026-10-10', 'income'), row(35, '100000', food, null, '2026-10-12', 'income')];
const keep = { op: 'keep' } as const, nearest = { kind: 'nearest', metric: null, comparison: null };
const set = (value: string, quote = value) => ({ op: 'set', value, quote });
const filter = (field: string, value: unknown, quote: string) => ({ field, op: 'set', value, quote });
const proposal = (patch: Record<string, unknown> = {}) => ({ status: 'query', binding: nearest, metric: keep, grouping: keep, comparison: keep, edits: [], ...patch });
const request = (question = 'Сумма расходов.', n = 40): TaskInput => ({ scope, book: emptyTaskBook(scope), global: { revision: 0, filter: october, touched: {} }, dataRevision: '1', messageId: id(n), question, currentDate: '2026-10-15' });
const scalarExpenses = set('expenses', 'расходов');
function rig() {
  const counts = { relevance: 0, proposal: 0, catalog: 0, authorize: 0, calculate: 0, commit: 0 }, sent: unknown[] = [];
  let book = emptyTaskBook(scope), revision = '1', globalRevision = 0;
  let value: unknown = proposal({ binding: { kind: 'new' }, metric: scalarExpenses });
  let gate: unknown = { relevance: 'financial' };
  const model: TaskModel = {
    async relevance(input) { counts.relevance++; sent.push(structuredClone(input)); return gate; },
    async proposal(input) { counts.proposal++; sent.push(structuredClone(input)); return value; },
  };
  const services: TaskServices<ReturnType<typeof calculateWidget>> = {
    async guard(expected) { assert.deepEqual(expected.scope, scope); if (expected.dataRevision !== revision || expected.globalRevision !== globalRevision || expected.count !== book.nodes.length || expected.head !== (book.nodes.at(-1)?.messageId ?? null)) throw new Error('TASK_CHANGED'); },
    async catalog() { counts.catalog++; return catalog; },
    async authorizeQuery(query) { counts.authorize++; for (const key of ['categoryIds', 'subcategoryIds'] as const) for (const selected of query.filter[key] ?? []) assert.ok(catalog.categories.some(c => c.id === selected)); },
    async calculate(query) { counts.calculate++; return calculateWidget(parseWidget({ id: id(90), name: 'Синтетический расчёт', metrics: [query.metric], grouping: query.grouping, period: 'global', filter: query.filter, comparison: { kind: query.comparison }, chart: 'table', topN: 10 }), rows, catalog, {}, new Date('2026-10-15T12:00:00Z')); },
    async commit(input) { await services.guard(input.expected); counts.commit++; book = parseTaskBook(input.book, scope); },
  };
  return { counts, sent, model, services, get book() { return book; }, set value(v: unknown) { value = v; }, set gate(v: unknown) { gate = v; }, set revision(v: string) { revision = v; }, set globalRevision(v: number) { globalRevision = v; } };
}

test('six financial turns reach shared core with exact totals and no old category on a new income task', async () => {
  const h = rig(); let input = request('Сумма расходов на продукты в сентябре 2026 года.');
  const turns = [
    { question: input.question, value: proposal({ binding: { kind: 'new' }, metric: scalarExpenses, edits: [filter('categories', { names: ['продукты'] }, 'продукты'), filter('period', 'сентябре 2026 года', 'сентябре 2026 года')] }), total: '160000', grouping: 'none' },
    { question: 'А по категориям?', value: proposal({ grouping: set('category', 'по категориям') }), total: '160000', grouping: 'category' },
    { question: 'А теперь на такси?', value: proposal({ edits: [filter('categories', { names: ['такси'] }, 'такси')] }), total: '35000', grouping: 'category' },
    { question: 'А за октябрь 2026 года?', value: proposal({ edits: [filter('period', 'октябрь 2026 года', 'октябрь 2026 года')] }), total: '17000', grouping: 'category' },
    { question: 'Покажи мои доходы.', value: proposal({ binding: { kind: 'new' }, metric: set('income', 'доходы') }), total: '2100000', grouping: 'none' },
    { question: 'А по категориям?', value: proposal({ grouping: set('category', 'по категориям') }), total: '2100000', grouping: 'category' },
  ];
  for (const [index, turn] of turns.entries()) {
    h.value = turn.value; input = { ...input, question: turn.question, messageId: id(40 + index), book: h.book };
    const result = await runAnalyzerTask(input, h.model, h.services); assert.equal(result.status, 'query');
    if (result.status !== 'query') throw new Error('expected query');
    assert.equal(result.query.grouping, turn.grouping); assert.equal(result.result.totals[result.query.metric], turn.total);
    if (index >= 4) assert.equal(result.query.filter.categoryIds, undefined);
    for (const point of result.result.points) assert.equal(queryOperations(rows, catalog, { filter: point.filter, sort: 'date', direction: 'asc', group: 'none' }).summary.metricMinor, point.values[result.query.metric]);
  }
  assert.equal(h.counts.relevance, 6); assert.equal(h.counts.proposal, 6); assert.equal(h.counts.calculate, 6); assert.equal(h.book.nodes.length, 6);
  const serialized = JSON.stringify(h.sent); for (const value of [food, travel, taxi, account, scope.ownerId, scope.chatId, '160000', '2100000', 'Синтетический счёт']) assert.equal(serialized.includes(value), false, value);
});

test('unrelated, ambiguous and malformed gates never invoke planner, catalog, authorization, finance or commit', async () => {
  for (const gate of [{ relevance: 'unrelated' }, { relevance: 'ambiguous' }, { relevance: 'financial', followUp: true }, { relevance: 'unknown' }]) {
    const h = rig(); h.gate = gate;
    const result = await runAnalyzerTask(request('Медицинские операции.'), h.model, h.services);
    assert.ok(['redirect', 'clarification', 'failed'].includes(result.status)); assert.deepEqual(h.counts, { relevance: 1, proposal: 0, catalog: 0, authorize: 0, calculate: 0, commit: 0 });
  }
  assert.throws(() => parseTaskRelevance({ relevance: 'financial', followUp: true }));
});

test('supported attention produces an operation result; the gate outcome is not overridden by word matching', async () => {
  const h = rig(); h.value = proposal({ binding: { kind: 'new' }, metric: set('attention', 'требуют внимания') });
  const outcome = await runAnalyzerTask({ ...request('Какие операции требуют внимания?'), global: { revision: 0, filter: september, touched: {} } }, h.model, h.services);
  assert.equal(outcome.status, 'query'); if (outcome.status !== 'query') throw new Error();
  assert.equal(outcome.query.grouping, 'operation'); assert.equal(outcome.result.totals.attention, '1');
  const blocked = rig(); blocked.gate = { relevance: 'unrelated' };
  assert.equal((await runAnalyzerTask(request('Какие операции требуют внимания?'), blocked.model, blocked.services)).status, 'redirect');
  assert.equal(blocked.counts.proposal, 0); // Model quality must be measured, not hidden.
});

test('clear/use_current and same-value manual changes persist across follow-up and keep current exact totals', async () => {
  const h = rig(), initial = request('Сумма расходов на продукты в сентябре 2026.');
  h.value = proposal({ binding: { kind: 'new' }, metric: scalarExpenses, edits: [filter('categories', { names: ['продукты'] }, 'продукты'), filter('period', 'сентябре 2026', 'сентябре 2026')] });
  await runAnalyzerTask(initial, h.model, h.services);
  h.value = proposal({ edits: [{ field: 'categories', op: 'clear', quote: 'все категории' }] });
  const cleared = await runAnalyzerTask({ ...initial, book: h.book, question: 'Теперь все категории.', messageId: id(41) }, h.model, h.services);
  assert.equal(cleared.status, 'query'); if (cleared.status !== 'query') throw new Error(); assert.equal(cleared.result.totals.expenses, '195000');
  h.value = proposal(); h.globalRevision = 1;
  const manual = await runAnalyzerTask({ ...initial, book: h.book, question: 'Повтори.', messageId: id(42), global: { revision: 1, filter: october, touched: { period: 1 } } }, h.model, h.services);
  assert.equal(manual.status, 'query'); if (manual.status !== 'query') throw new Error(); assert.equal(manual.result.totals.expenses, '17000');
});

test('unknown/ambiguous owned names clarify, and a later continuation keeps the last successful state', async () => {
  const h = rig(); await runAnalyzerTask(request(), h.model, h.services); const prior = structuredClone(h.book);
  h.value = proposal({ edits: [filter('categories', { names: ['Орбитальные станции'] }, 'Орбитальные станции')] });
  const bad = await runAnalyzerTask({ ...request('А теперь Орбитальные станции.', 41), book: h.book }, h.model, h.services);
  assert.equal(bad.status, 'clarification'); assert.deepEqual(h.book, prior);
  h.value = proposal({ grouping: set('category', 'по категориям') });
  const next = await runAnalyzerTask({ ...request('Тогда по категориям.', 42), book: h.book }, h.model, h.services);
  assert.equal(next.status, 'query'); assert.equal(h.book.nodes.length, 2);
  const duplicate = rig(); duplicate.value = proposal({ binding: { kind: 'new' }, metric: scalarExpenses, edits: [filter('categories', { names: ['Продукты'] }, 'Продукты')] });
  duplicate.services.catalog = async () => ({ ...catalog, categories: [...catalog.categories, { ...catalog.categories[0]!, id: id(80) }] });
  const ambiguous = await runAnalyzerTask(request('Сумма расходов на Продукты.'), duplicate.model, duplicate.services);
  assert.equal(ambiguous.status, 'clarification'); if (ambiguous.status === 'clarification') assert.equal(ambiguous.reason, 'reference_ambiguous');
  assert.equal(duplicate.counts.calculate, 0);
});

test('unsupported actions/part thresholds, missing task and malformed proposals do not query finance or invent a fallback', async () => {
  const variants = [
    proposal({ status: 'unsupported', binding: null, metric: keep }),
    proposal({ status: 'clarification', binding: null, metric: keep }),
    proposal({ binding: { kind: 'reference', handle: 't99' }, edits: [filter('categories', { names: ['Продукты'] }, 'Продукты')] }),
    proposal({ binding: { kind: 'new' }, metric: scalarExpenses, edits: [filter('amount', { basis: 'metric_part', expression: 'от 1000 рублей' }, 'от 1000 рублей')] }),
    proposal({ binding: { kind: 'new' }, metric: scalarExpenses, edits: [{ field: 'selection', op: 'clear', quote: 'все' }] }),
    { ...proposal({ binding: { kind: 'new' }, metric: scalarExpenses }), result: 'fake_total' },
  ];
  for (const value of variants) {
    const h = rig(); h.value = value;
    const result = await runAnalyzerTask(request('Сумма расходов на Продукты от 1000 рублей, все.'), h.model, h.services);
    assert.notEqual(result.status, 'query'); assert.equal(h.counts.catalog, 0); assert.equal(h.counts.calculate, 0); assert.equal(h.counts.commit, 0);
  }
});

test('exact period evidence prevents a passing-query date rewrite; names and UUIDs cannot be invented', async () => {
  const variants = [
    proposal({ binding: { kind: 'new' }, metric: scalarExpenses, edits: [filter('period', '2026-09-01', 'расходов')] }),
    proposal({ binding: { kind: 'new' }, metric: scalarExpenses, edits: [filter('period', 'расходов', 'расходов')] }),
    proposal({ binding: { kind: 'new' }, metric: scalarExpenses, edits: [filter('accounts', [account], 'расходов')] }),
    proposal({ binding: { kind: 'new' }, metric: scalarExpenses, edits: [filter('categories', { names: ['Продукты'] }, 'расходов')] }),
  ];
  for (const value of variants) { const h = rig(); h.value = value; const outcome = await runAnalyzerTask(request(), h.model, h.services); assert.equal(outcome.status, 'failed'); assert.equal(h.counts.calculate, 0); assert.equal(h.counts.commit, 0); }
});

test('financial calculations rerun on current rows and no task definition stores a previous total', async () => {
  const h = rig(); const first = await runAnalyzerTask(request(), h.model, h.services); assert.equal(first.status, 'query');
  h.revision = '2'; h.value = proposal();
  const original = h.services.calculate;
  h.services.calculate = async query => {
    const changed = structuredClone(rows); changed[3]!.amountMinor = '-22000'; changed[3]!.parts[0]!.amountMinor = '-22000';
    return calculateWidget(parseWidget({ id: id(90), name: 'Синтетический расчёт', metrics: [query.metric], grouping: query.grouping, filter: query.filter }), changed, catalog, {}, new Date('2026-10-15T12:00:00Z'));
  };
  const next = await runAnalyzerTask({ ...request('Повтори.', 41), book: h.book, dataRevision: '2' }, h.model, h.services);
  assert.equal(next.status, 'query'); if (next.status === 'query') assert.equal(next.result.totals.expenses, '22000');
  assert.equal(JSON.stringify(h.book).includes('22000'), false); h.services.calculate = original;
});

test('late cancellation/deletion/global or data revision change aborts before execution or persistence; service failures propagate', async () => {
  for (const phase of ['relevance', 'proposal', 'calculate', 'catalog'] as const) {
    const h = rig();
    if (phase === 'calculate') { const real = h.services.calculate; h.services.calculate = async q => { const value = await real(q); h.revision = '2'; return value; }; }
    else if (phase === 'catalog') {
      h.value = proposal({ binding: { kind: 'new' }, metric: scalarExpenses, edits: [filter('categories', { names: ['Продукты'] }, 'Продукты')] });
      h.services.catalog = async () => { throw new TypeError('CHAT_DELETED'); };
    } else { const real = h.model[phase]; h.model[phase] = async v => { const result = await (real as (input: unknown) => Promise<unknown>)(v); h.revision = '2'; return result; }; }
    await assert.rejects(runAnalyzerTask(request('Сумма расходов на Продукты.'), h.model, h.services), /TASK_CHANGED|CHAT_DELETED/);
    assert.equal(h.counts.commit, 0); if (phase !== 'calculate') assert.equal(h.counts.calculate, 0);
  }
  const denied = rig(); denied.services.authorizeQuery = async () => { throw new Error('OWNERSHIP_DENIED'); };
  await assert.rejects(runAnalyzerTask(request(), denied.model, denied.services), /OWNERSHIP_DENIED/); assert.equal(denied.counts.calculate, 0);
  const recreated = rig(), originalGuard = recreated.services.guard, originalGate = recreated.model.relevance;
  let epoch = scope.chatEpoch;
  recreated.services.guard = async expected => { await originalGuard(expected); if (expected.scope.chatEpoch !== epoch) throw new Error('CHAT_REPLACED'); };
  recreated.model.relevance = async input => { const value = await originalGate(input); epoch = id(80); return value; };
  await assert.rejects(runAnalyzerTask(request(), recreated.model, recreated.services), /CHAT_REPLACED/);
  assert.equal(recreated.counts.proposal, 0); assert.equal(recreated.counts.commit, 0);
});

test('reused messages fail before a model call; atomic commit conflict does not overwrite context', async () => {
  const h = rig(); const input = request(); await runAnalyzerTask(input, h.model, h.services);
  const before = { ...h.counts };
  await assert.rejects(runAnalyzerTask({ ...input, book: h.book }, h.model, h.services), /TASK_MESSAGE_REUSED/); assert.deepEqual(h.counts, before);
  const saved = structuredClone(h.book); h.value = proposal(); h.services.commit = async () => { throw new Error('TASK_COMMIT_CONFLICT'); };
  await assert.rejects(runAnalyzerTask({ ...request('Повтори.', 41), book: h.book }, h.model, h.services), /TASK_COMMIT_CONFLICT/); assert.deepEqual(h.book, saved);
});

test('name flags refine the selected category without losing it, while an explicit parent drops its leaf', async () => {
  const h = rig(); h.value = proposal({ binding: { kind: 'new' }, metric: scalarExpenses, edits: [filter('categories', { names: ['Такси'] }, 'Такси')] });
  await runAnalyzerTask(request('Сумма расходов на Такси.'), h.model, h.services);
  h.value = proposal({ edits: [filter('categories', { names: ['Поездки'] }, 'Поездки')] });
  const parent = await runAnalyzerTask({ ...request('Теперь все Поездки.', 41), book: h.book }, h.model, h.services);
  assert.equal(parent.status, 'query'); if (parent.status === 'query') { assert.deepEqual(parent.query.filter.categoryIds, [travel]); assert.equal(parent.query.filter.subcategoryIds, undefined); }
  h.value = proposal({ edits: [filter('categories', { noSubcategory: true }, 'без подкатегории')] });
  const flags = await runAnalyzerTask({ ...request('А без подкатегории?', 42), book: h.book }, h.model, h.services);
  assert.equal(flags.status, 'query'); if (flags.status === 'query') { assert.deepEqual(flags.query.filter.categoryIds, [travel]); assert.equal(flags.query.filter.noSubcategory, true); }
});

test('money ranges and output format are independent and produce exact shared finance results', async () => {
  const h = rig(); h.value = proposal({ binding: { kind: 'new' }, metric: scalarExpenses, edits: [filter('amount', { basis: 'absolute_operation', expression: 'от 1000 до 2500 рублей включительно' }, 'от 1000 до 2500 рублей включительно')] });
  const result = await runAnalyzerTask({ ...request('Сумма расходов по операциям от 1000 до 2500 рублей включительно.'), global: { revision: 0, filter: september, touched: {} } }, h.model, h.services);
  assert.equal(result.status, 'query'); if (result.status !== 'query') throw new Error();
  assert.equal(result.query.grouping, 'none'); assert.equal(result.query.filter.amountFrom, '100000'); assert.equal(result.query.filter.amountThrough, '250000'); assert.equal(result.result.totals.expenses, '120000');
  assert.equal(taskCapabilities.money.metricPart, 'unsupported');
});
