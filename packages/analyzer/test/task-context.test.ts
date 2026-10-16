import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTaskBook, resolveTaskDecision, acceptTaskResult, parseTaskBook, taskDescriptors, selectTask } from '../src/task-context.ts';
import type { TaskBook, TaskDecision, GlobalSnapshot, ConditionEdit, TaskBinding } from '../src/task-context.ts';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { ownerId: id(1), chatId: id(2), generation: id(3), chatEpoch: id(4) };
const food = id(10), travel = id(11), taxi = id(12), account = id(13), op = id(14);
const october = { from: '2026-10-01', through: '2026-10-31' }, september = { from: '2026-09-01', through: '2026-09-30' };
const ui: GlobalSnapshot = { revision: 0, filter: october, touched: {} };
const keep = { op: 'keep' } as const, nearest = { kind: 'nearest', metric: null, comparison: null } as const;
const decision = (overrides: Partial<TaskDecision> = {}): TaskDecision => ({ binding: nearest, metric: keep, grouping: keep, comparison: keep, edits: [], ...overrides });
const edits = (...items: ConditionEdit[]) => items;
function step(book: TaskBook, n: number, d: TaskDecision, global = ui) {
  const result = resolveTaskDecision(book, scope, global, d, id(n)); assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') throw new Error('expected resolved');
  return { book: acceptTaskResult(book, result), ...result };
}
const begin = (global = ui) => step(emptyTaskBook(scope), 20, decision({ binding: { kind: 'new' }, metric: { op: 'set', value: 'expenses' },
  edits: edits({ field: 'period', op: 'set', value: september }, { field: 'categories', op: 'set', value: { categoryIds: [food] } }) }), global);

test('six-turn scope chain preserves category/date/grouping and a new income question resets the former task', () => {
  const a = begin(), b = step(a.book, 21, decision({ grouping: { op: 'set', value: 'category' } }));
  const c = step(b.book, 22, decision({ edits: edits({ field: 'categories', op: 'set', value: { categoryIds: [travel], subcategoryIds: [taxi] } }) }));
  const d = step(c.book, 23, decision({ edits: edits({ field: 'period', op: 'set', value: october }) }));
  const e = step(d.book, 24, decision({ binding: { kind: 'new' }, metric: { op: 'set', value: 'income' } }));
  const f = step(e.book, 25, decision({ grouping: { op: 'set', value: 'category' } }));
  assert.deepEqual(c.query.filter, { ...september, categoryIds: [travel], subcategoryIds: [taxi] }); assert.equal(c.query.grouping, 'category');
  assert.equal(d.query.grouping, 'category'); assert.deepEqual(d.query.filter.subcategoryIds, [taxi]);
  assert.deepEqual(e.query, { name: 'query_finances', metric: 'income', grouping: 'none', comparison: 'none', filter: october });
  assert.deepEqual(f.query.filter, october); assert.equal(f.query.metric, 'income'); assert.equal(f.query.grouping, 'category');
  assert.equal(e.node.parent, null); assert.equal(f.node.parent, id(24));
});

test('keep, clear, empty selection and use_current are distinct and their effect survives the next turn', () => {
  const global = { ...ui, filter: { ...october, categoryIds: [travel] } }, a = begin(global);
  const b = step(a.book, 21, decision({ edits: edits({ field: 'categories', op: 'clear' }) }), global);
  assert.equal(b.query.filter.categoryIds, undefined); assert.equal(b.node.origins.categories.operation, 'clear');
  const c = step(b.book, 22, decision(), global); assert.equal(c.query.filter.categoryIds, undefined);
  const d = step(c.book, 23, decision({ edits: edits({ field: 'categories', op: 'set', value: { categoryIds: [] } }) }), global);
  assert.deepEqual(d.query.filter.categoryIds, []);
  const e = step(d.book, 24, decision({ edits: edits({ field: 'categories', op: 'use_current' }, { field: 'period', op: 'use_current' }) }), global);
  assert.deepEqual(e.query.filter, { ...october, categoryIds: [travel] });
  const f = step(e.book, 25, decision(), global); assert.deepEqual(f.query.filter, e.query.filter);
  assert.equal(f.node.origins.period.messageId, id(24));
});

test('manual same-value period selection is observed by its field stamp; unrelated manual edits preserve the period', () => {
  const a = begin();
  const flags = { revision: 1, filter: { ...october, attention: true }, touched: { attention: 1 } };
  const b = step(a.book, 21, decision(), flags); assert.equal(b.query.filter.from, september.from);
  const touched = { ...flags, revision: 2, touched: { attention: 1, period: 2 } };
  const c = step(b.book, 22, decision(), touched); assert.equal(c.query.filter.from, october.from); assert.equal(c.node.origins.period.source, 'global');
  const d = step(c.book, 23, decision({ edits: edits({ field: 'period', op: 'set', value: september }) }), touched);
  assert.equal(d.query.filter.from, september.from); assert.equal(d.node.origins.period.messageId, id(23));
});

test('parent-only replacement drops even the same-parent leaf but preserves independent money, account, period and fixed IDs', () => {
  const global = { ...ui, filter: { ...october, accountIds: [account], operationIds: [op], amountFrom: '100000' } };
  const a = begin(global), b = step(a.book, 21, decision({ edits: edits({ field: 'categories', op: 'set', value: { categoryIds: [travel], subcategoryIds: [taxi] } }) }), global);
  const c = step(b.book, 22, decision({ edits: edits({ field: 'categories', op: 'set', value: { categoryIds: [travel] } }) }), global);
  const d = step(c.book, 23, decision({ edits: edits({ field: 'attention', op: 'set', value: { attention: true } }) }), global);
  assert.deepEqual(d.query.filter, { ...september, accountIds: [account], operationIds: [op], amountFrom: '100000', categoryIds: [travel], attention: true });
});

test('manual removal of a compound category scope removes its inherited leaf; empty arrays remain restrictive', () => {
  const firstGlobal = { revision: 0, filter: { ...october, categoryIds: [travel], subcategoryIds: [taxi] }, touched: {} };
  const a = step(emptyTaskBook(scope), 20, decision({ binding: { kind: 'new' }, metric: { op: 'set', value: 'expenses' } }), firstGlobal);
  const b = step(a.book, 21, decision(), { revision: 1, filter: october, touched: { categories: 1 } });
  assert.equal(b.query.filter.categoryIds, undefined); assert.equal(b.query.filter.subcategoryIds, undefined);
  const c = step(b.book, 22, decision(), { revision: 2, filter: { ...october, categoryIds: [] }, touched: { categories: 2 } });
  assert.deepEqual(c.query.filter.categoryIds, []);
});

test('nearest compatible, explicit old result, ordinal and unique selection have distinct behavior across tasks', () => {
  const a = step(begin().book, 21, decision({ comparison: { op: 'set', value: 'previous_same' } }));
  const b = step(a.book, 22, decision({ binding: { kind: 'new' }, metric: { op: 'set', value: 'income' } }));
  const c = step(b.book, 23, decision({ binding: { kind: 'nearest', metric: 'expenses', comparison: 'previous_same' }, grouping: { op: 'set', value: 'category' } }));
  assert.equal(c.inheritedFrom, id(21)); assert.equal(c.query.metric, 'expenses');
  const d = step(c.book, 24, decision({ binding: { kind: 'ordinal', index: 1, metric: null, comparison: 'previous_same' } }));
  assert.equal(d.inheritedFrom, id(21)); assert.equal(d.query.grouping, 'none');
  const e = step(d.book, 25, decision({ binding: { kind: 'reference', handle: 't3' } }));
  assert.equal(e.query.metric, 'income');
  assert.equal(selectTask(e.book, { kind: 'unique', metric: 'expenses', comparison: null }).node?.messageId, id(24));
  const f = step(e.book, 26, decision({ binding: { kind: 'new' }, metric: { op: 'set', value: 'expenses' } }));
  assert.equal(selectTask(f.book, { kind: 'unique', metric: 'expenses', comparison: null }).reason, 'task_ambiguous');
  assert.equal(selectTask(e.book, { kind: 'reference', handle: 't100' }).reason, 'task_missing');
  assert.deepEqual(Object.keys(taskDescriptors(e.book)[0]!), ['handle', 'taskHandle', 'parentHandle', 'metric', 'grouping', 'comparison']);
});

test('genuinely missing or ambiguous tasks do not silently fall back to the last result', () => {
  const a = begin();
  for (const binding of [{ kind: 'reference', handle: 't99' }, { kind: 'ordinal', index: 2, metric: 'income', comparison: null }, { kind: 'nearest', metric: 'income', comparison: null }] as TaskBinding[])
    assert.equal(resolveTaskDecision(a.book, scope, ui, decision({ binding }), id(30)).status, 'clarification');
  assert.equal(resolveTaskDecision(emptyTaskBook(scope), scope, ui, decision({ binding: { kind: 'new' } }), id(30)).status, 'clarification');
});

test('selection cannot be edited or widened, including clear/use_current and subsequent global removals', () => {
  const another = id(15), outsider = id(16), global = { ...ui, filter: { ...october, operationIds: [op, another] } };
  const a = begin(global), b = step(a.book, 21, decision({ edits: edits({ field: 'categories', op: 'clear' }, { field: 'period', op: 'use_current' }) }), { revision: 1, filter: { ...october, operationIds: [another, outsider] }, touched: {} });
  assert.deepEqual(b.query.filter.operationIds, [another]); assert.deepEqual(b.node.fixedOperationIds, [op, another]);
  const c = step(b.book, 22, decision(), { revision: 2, filter: october, touched: {} });
  assert.deepEqual(c.query.filter.operationIds, [op, another]);
  const d = decision({ edits: [{ field: 'selection', op: 'clear' }] as any });
  assert.throws(() => resolveTaskDecision(a.book, scope, global, d, id(30)));
  const corrupt = structuredClone(a.book); corrupt.nodes[0]!.query.filter.operationIds = [outsider];
  assert.throws(() => parseTaskBook(corrupt, scope), /TASK_SELECTION_WIDENED/);
});

test('provenance stores the original edit/clear message and never adds totals, transcripts or reasoning', () => {
  const a = begin(), b = step(a.book, 21, decision({ edits: edits({ field: 'categories', op: 'clear' }) }));
  const c = step(b.book, 22, decision()); assert.equal(c.node.origins.categories.messageId, id(21)); assert.equal(c.node.origins.period.messageId, id(20));
  assert.deepEqual(Object.keys(c.node).sort(), ['fixedOperationIds', 'global', 'messageId', 'origins', 'parent', 'query']);
  assert.throws(() => parseTaskBook({ ...c.book, totals: '100' }, scope));
});

test('cross-owner/chat/reset scope, cyclic parents, reused messages and stale globals fail without changing input', () => {
  const a = begin(), before = structuredClone(a.book);
  for (const key of ['ownerId', 'chatId', 'chatEpoch', 'generation']) assert.throws(() => parseTaskBook(a.book, { ...scope, [key]: id(99) }), /TASK_SCOPE_MISMATCH/);
  const cyclic = structuredClone(a.book); cyclic.nodes[0]!.parent = id(20); assert.throws(() => parseTaskBook(cyclic, scope));
  assert.throws(() => resolveTaskDecision(a.book, scope, ui, decision(), id(20)), /TASK_MESSAGE_REUSED/);
  assert.throws(() => step(a.book, 21, decision(), { ...ui, filter: september }), /TASK_GLOBAL_VERSION_INVALID/);
  assert.deepEqual(a.book, before);
});

test('conflicting periods and comparison without dates clarify rather than cancel a different condition', () => {
  const a = begin();
  const compared = step(a.book, 21, decision({ comparison: { op: 'set', value: 'previous_same' } }));
  const cleared = resolveTaskDecision(compared.book, scope, ui, decision({ edits: edits({ field: 'period', op: 'clear' }) }), id(22));
  assert.deepEqual(cleared, { status: 'clarification', reason: 'comparison_period_required' });
  const duplicates = decision({ edits: edits({ field: 'period', op: 'clear' }, { field: 'period', op: 'use_current' }) });
  assert.throws(() => resolveTaskDecision(a.book, scope, ui, duplicates, id(22)), /TASK_DUPLICATE_EDIT/);
});
