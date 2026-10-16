import { object, choice, uuid } from '../../finance-core/src/model.ts';
import { parseOperationsFilter } from '../../finance-core/src/operations.ts';
import type { OperationsFilter } from '../../finance-core/src/operations.ts';
import { parseTool } from './registry.ts';
import type { Query } from './registry.ts';

export const taskContextVersion = 'analyzer-task-context/1';
// Atomic groups: a change replaces this condition, not unrelated conditions.
// Immutable operation IDs are a separate server boundary, never a model edit.
export const conditionFields = {
  period: ['from', 'through'], postedPeriod: ['postedFrom', 'postedThrough'],
  categories: ['categoryIds', 'subcategoryIds', 'excludedCategoryIds', 'uncategorized', 'noSubcategory'],
  accounts: ['accountIds'], bank: ['bankId'], counterparties: ['counterpartyIds', 'noCounterparty'],
  merchant: ['merchant', 'merchantExact'], amount: ['amountFrom', 'amountThrough', 'amountBasis'],
  kind: ['kind'], role: ['role'], inclusion: ['inclusion', 'includeExcluded'], attention: ['attention'],
  reviewReason: ['reason'], reviewStatus: ['status'], classificationFacet: ['facet'],
  confidence: ['confidenceFrom', 'confidenceThrough'], classificationSource: ['source'],
  refund: ['refund'], transfer: ['transfer'], linked: ['linked'], comment: ['comment'],
  rule: ['ruleId'], import: ['batchId', 'fileId'], possibleDuplicate: ['possibleDuplicate'], search: ['search'],
} as const satisfies Record<string, readonly (keyof OperationsFilter)[]>;
export type Condition = keyof typeof conditionFields;
export type GlobalSnapshot = { revision: number; filter: OperationsFilter; touched: Partial<Record<Condition, number>> };
export type TaskScope = { ownerId: string; chatId: string; chatEpoch: string; generation: string };
export type Origin = { source: 'global' | 'message'; operation: 'initial' | 'manual' | 'set' | 'clear' | 'use_current'; messageId: string | null; globalRevision: number };
export type Origins = Record<Condition, Origin>;
export type TaskNode = { messageId: string; parent: string | null; query: Query; global: GlobalSnapshot; origins: Origins; fixedOperationIds: string[] | null };
export type TaskBook = { version: typeof taskContextVersion; scope: TaskScope; nodes: TaskNode[] };
type Criteria = { metric: Query['metric'] | null; comparison: Query['comparison'] | null };
export type TaskBinding = { kind: 'new' } | ({ kind: 'nearest' | 'unique' } & Criteria) |
  ({ kind: 'ordinal'; index: number } & Criteria) | { kind: 'reference'; handle: string };
export type ScalarEdit<T> = { op: 'keep' } | { op: 'set'; value: T };
export type ConditionEdit = { field: Condition; op: 'keep' | 'clear' | 'use_current' } | { field: Condition; op: 'set'; value: OperationsFilter };
export type TaskDecision = { binding: TaskBinding; metric: ScalarEdit<Query['metric']>; grouping: ScalarEdit<Query['grouping']>; comparison: ScalarEdit<Query['comparison']>; edits: ConditionEdit[] };
export class TaskError extends TypeError { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
const invalid = (code = 'TASK_CONTEXT_INVALID'): never => { throw new TaskError(code); };
const conditions = Object.keys(conditionFields) as Condition[];
const canonical = (value: unknown): string => Array.isArray(value) ? JSON.stringify([...value].sort()) : JSON.stringify(value) ?? 'undefined';
const part = (filter: OperationsFilter, field: Condition) => Object.fromEntries(conditionFields[field].filter(k => Object.hasOwn(filter, k)).map(k => [k, filter[k]]));
const same = (a: OperationsFilter, b: OperationsFilter, field: Condition) => conditionFields[field].every(k => canonical(a[k]) === canonical(b[k]));
const revision = (value: unknown) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid(); return value; };
function scope(value: unknown): TaskScope {
  const r = object(value, ['ownerId', 'chatId', 'chatEpoch', 'generation']);
  // Better Auth IDs are opaque text, not finance UUIDs. Authority still comes
  // from the authenticated server session, never this serialized value.
  if (typeof r.ownerId !== 'string' || !r.ownerId.length || r.ownerId.length > 256 || /[\x00-\x1f\x7f]/.test(r.ownerId)) return invalid();
  return { ownerId: r.ownerId, chatId: uuid(r.chatId), chatEpoch: uuid(r.chatEpoch), generation: uuid(r.generation) };
}
export function globalSnapshot(value: unknown): GlobalSnapshot {
  const r = object(value, ['revision', 'filter', 'touched']), current = revision(r.revision), filter = parseOperationsFilter(r.filter);
  if (filter.metric) return invalid();
  const stamps = object(r.touched, conditions), touched: GlobalSnapshot['touched'] = {};
  for (const key of Object.keys(stamps) as Condition[]) { const n = revision(stamps[key]); if (n > current) return invalid(); touched[key] = n; }
  return { revision: current, filter, touched };
}
export function emptyTaskBook(value: TaskScope): TaskBook { return { version: taskContextVersion, scope: scope(value), nodes: [] }; }
/** Runtime deserialization boundary: no totals, free text, reasoning or authority. */
export function parseTaskBook(value: unknown, currentScope: TaskScope): TaskBook {
  const r = object(value, ['version', 'scope', 'nodes']), owner = scope(currentScope), stored = scope(r.scope);
  if (r.version !== taskContextVersion || Object.keys(owner).some(k => owner[k as keyof TaskScope] !== stored[k as keyof TaskScope])) return invalid('TASK_SCOPE_MISMATCH');
  if (!Array.isArray(r.nodes) || r.nodes.length > 100) return invalid();
  const seen = new Set<string>(), fixedByMessage = new Map<string, string[] | null>();
  const nodes = r.nodes.map(value => {
    const n = object(value, ['messageId', 'parent', 'query', 'global', 'origins', 'fixedOperationIds']);
    const messageId = uuid(n.messageId); if (seen.has(messageId) || n.parent !== null && !seen.has(uuid(n.parent))) return invalid();
    const query = parseTool(n.query); if (query.name !== 'query_finances') return invalid();
    const global = globalSnapshot(n.global), raw = object(n.origins, conditions), origins = {} as Origins;
    if (Object.keys(raw).length !== conditions.length) return invalid();
    for (const key of conditions) {
      const p = object(raw[key], ['source', 'operation', 'messageId', 'globalRevision']);
      const source = choice(p.source, ['global', 'message']), operation = choice(p.operation, ['initial', 'manual', 'set', 'clear', 'use_current']);
      if (source === 'global' && !['initial', 'manual'].includes(operation) || source === 'message' && !['set', 'clear', 'use_current'].includes(operation)) return invalid();
      const originMessage = p.messageId === null ? null : uuid(p.messageId), globalRevision = revision(p.globalRevision);
      if (globalRevision > global.revision || source === 'global' && originMessage !== null || source === 'message' && originMessage !== messageId && !seen.has(originMessage!)) return invalid();
      origins[key] = { source, operation, messageId: originMessage, globalRevision };
    }
    const fixedOperationIds = n.fixedOperationIds === null ? null : parseOperationsFilter({ operationIds: n.fixedOperationIds }).operationIds!;
    const parentBoundary = n.parent === null ? null : fixedByMessage.get(n.parent as string);
    if (parentBoundary && canonical(fixedOperationIds) !== canonical(parentBoundary)) return invalid('TASK_SELECTION_WIDENED');
    if (fixedOperationIds && (!query.filter.operationIds || query.filter.operationIds.some(id => !fixedOperationIds.includes(id)))) return invalid('TASK_SELECTION_WIDENED');
    seen.add(messageId); fixedByMessage.set(messageId, fixedOperationIds); return { messageId, parent: n.parent as string | null, query, global, origins, fixedOperationIds };
  });
  return { version: taskContextVersion, scope: owner, nodes };
}
export function taskDescriptors(book: TaskBook) {
  const handles = new Map(book.nodes.map((n, i) => [n.messageId, 't' + (i + 1)])), roots = new Map<string, string>();
  return book.nodes.map((n, index) => {
    const handle = 't' + (index + 1), taskHandle = n.parent === null ? handle : roots.get(n.parent)!; roots.set(n.messageId, taskHandle);
    return { handle, taskHandle, parentHandle: n.parent === null ? null : handles.get(n.parent)!, metric: n.query.metric, grouping: n.query.grouping, comparison: n.query.comparison };
  });
}
export function parseTaskBinding(value: unknown): TaskBinding {
  const r = object(value, ['kind', 'metric', 'comparison', 'index', 'handle']);
  if (r.kind === 'new') { object(r, ['kind']); return { kind: 'new' }; }
  if (r.kind === 'reference') { object(r, ['kind', 'handle']); if (typeof r.handle !== 'string' || !/^t(?:[1-9]\d?|100)$/.test(r.handle)) return invalid('TASK_REFERENCE_INVALID'); return { kind: 'reference', handle: r.handle }; }
  const kind = choice(r.kind, ['nearest', 'unique', 'ordinal']); object(r, kind === 'ordinal' ? ['kind', 'metric', 'comparison', 'index'] : ['kind', 'metric', 'comparison']);
  const metric = r.metric === null ? null : choice(r.metric, ['expenses', 'income', 'attention']);
  const comparison = r.comparison === null ? null : choice(r.comparison, ['none', 'previous_same']);
  if (kind === 'ordinal') { const index = revision(r.index); if (index < 1 || index > 100) return invalid(); return { kind, index, metric, comparison }; }
  return { kind, metric, comparison };
}
export function selectTask(book: TaskBook, binding: TaskBinding): { node: TaskNode | null; reason: 'task_missing' | 'task_ambiguous' | null } {
  const selector = parseTaskBinding(binding);
  if (selector.kind === 'new') return { node: null, reason: null };
  if (selector.kind === 'reference') return { node: book.nodes[Number(selector.handle.slice(1)) - 1] ?? null, reason: book.nodes[Number(selector.handle.slice(1)) - 1] ? null : 'task_missing' };
  const matches = book.nodes.filter(n => (!selector.metric || n.query.metric === selector.metric) && (!selector.comparison || n.query.comparison === selector.comparison));
  if (!matches.length || selector.kind === 'ordinal' && !matches[selector.index - 1]) return { node: null, reason: 'task_missing' };
  if (selector.kind === 'unique') {
    // Several versions of one logical task are not several competing tasks.
    const roots = new Map<string, string>(); for (const n of book.nodes) roots.set(n.messageId, n.parent === null ? n.messageId : roots.get(n.parent)!);
    if (new Set(matches.map(n => roots.get(n.messageId))).size !== 1) return { node: null, reason: 'task_ambiguous' };
  }
  return { node: selector.kind === 'ordinal' ? matches[selector.index - 1]! : matches.at(-1)!, reason: null };
}
export type ResolvedTask = { status: 'resolved'; query: Query; node: TaskNode; inheritedFrom: string | null };
export type TaskResolution = ResolvedTask | { status: 'clarification'; reason: string };
/** All input is server-side, resolved and owned. Model names/quotes are parsed
 * by task-protocol before this function. Callers must still authorize execution. */
export function resolveTaskDecision(rawBook: TaskBook, currentScope: TaskScope, rawGlobal: GlobalSnapshot, rawDecision: TaskDecision, message: string): TaskResolution {
  const book = parseTaskBook(rawBook, currentScope), global = globalSnapshot(rawGlobal), messageId = uuid(message);
  if (book.nodes.some(n => n.messageId === messageId)) return invalid('TASK_MESSAGE_REUSED');
  if (book.nodes.length === 100) return invalid('TASK_LIMIT');
  const selected = selectTask(book, rawDecision.binding); if (selected.reason) return { status: 'clarification', reason: selected.reason };
  const previous = selected.node, filter: OperationsFilter = structuredClone(previous?.query.filter ?? global.filter);
  const origins = structuredClone(previous?.origins ?? Object.fromEntries(conditions.map(k => [k, { source: 'global', operation: 'initial', messageId: null, globalRevision: global.revision }]))) as Origins;
  const replace = (field: Condition, replacement: OperationsFilter, origin: Origin) => {
    for (const key of conditionFields[field]) delete filter[key];
    Object.assign(filter, structuredClone(part(replacement, field))); origins[field] = origin;
  };
  if (previous) {
    if (global.revision < previous.global.revision) return invalid('TASK_GLOBAL_VERSION_INVALID');
    for (const field of conditions) {
      const oldTouch = previous.global.touched[field] ?? 0, newTouch = global.touched[field] ?? 0;
      if (newTouch < oldTouch || (!same(global.filter, previous.global.filter, field) || newTouch !== oldTouch) && global.revision === previous.global.revision) return invalid('TASK_GLOBAL_VERSION_INVALID');
      if (!same(global.filter, previous.global.filter, field) || newTouch !== oldTouch)
        replace(field, global.filter, { source: 'global', operation: 'manual', messageId: null, globalRevision: global.revision });
    }
  }
  const seen = new Set<string>();
  for (const value of rawDecision.edits) {
    const edit = object(value, ['field', 'op', 'value']), field = choice(edit.field, conditions), op = choice(edit.op, ['keep', 'set', 'clear', 'use_current']);
    if (seen.has(field)) return invalid('TASK_DUPLICATE_EDIT'); seen.add(field);
    if (op !== 'set') object(edit, ['field', 'op']);
    if (op === 'keep') continue;
    let replacement: OperationsFilter = {};
    if (op === 'set') {
      const fields = object(edit.value, [...conditionFields[field]]); if (!Object.keys(fields).length) return invalid('TASK_EMPTY_SET');
      replacement = parseOperationsFilter(fields);
    } else if (op === 'use_current') replacement = global.filter;
    replace(field, replacement, { source: 'message', operation: op, messageId, globalRevision: global.revision });
  }
  // A model cannot clear or replace a fixed list. Current UI selection may only
  // narrow it; changes to IDs never grant authorization over those operations.
  const fixedOperationIds = previous?.fixedOperationIds ?? global.filter.operationIds ?? null;
  const currentSelection = global.filter.operationIds;
  if (fixedOperationIds) filter.operationIds = fixedOperationIds.filter(id => !currentSelection || currentSelection.includes(id));
  else if (currentSelection) filter.operationIds = [...currentSelection];
  const scalar = <T extends string>(value: ScalarEdit<T>, values: readonly T[], fallback: T): T => {
    const e = object(value, ['op', 'value']); if (e.op === 'keep') { object(e, ['op']); return fallback; }
    if (e.op !== 'set') return invalid(); return choice(e.value, values);
  };
  if (!previous && rawDecision.metric.op === 'keep') return { status: 'clarification', reason: 'metric_required' };
  const metric = scalar(rawDecision.metric, ['expenses', 'income', 'attention'], previous?.query.metric ?? 'expenses');
  // An existing presentation wins over a metric's INITIAL default. Otherwise
  // changing only a date would reset an attention total/table to operations.
  const grouping = scalar(rawDecision.grouping, ['none', 'category', 'operation'], previous?.query.grouping ?? (metric === 'attention' ? 'operation' : 'none'));
  const comparison = scalar(rawDecision.comparison, ['none', 'previous_same'], previous?.query.comparison ?? 'none');
  let query: Query;
  try { query = parseTool({ name: 'query_finances', metric, grouping, comparison, filter: parseOperationsFilter(filter) }) as Query; }
  catch { return { status: 'clarification', reason: 'condition_conflict' }; }
  if (query.comparison !== 'none' && (!query.filter.from || !query.filter.through)) return { status: 'clarification', reason: 'comparison_period_required' };
  const node: TaskNode = { messageId, parent: previous?.messageId ?? null, query, global, origins, fixedOperationIds: fixedOperationIds ? [...fixedOperationIds] : null };
  return { status: 'resolved', query, node, inheritedFrom: previous?.messageId ?? null };
}
/** Call only after fresh calculation, authorization and the caller's atomic
 * compare-and-store. The book stores semantic definitions, never old totals. */
export function acceptTaskResult(book: TaskBook, resolved: ResolvedTask): TaskBook {
  if (book.nodes.some(n => n.messageId === resolved.node.messageId) || book.nodes.length >= 100 || resolved.node.parent !== null && !book.nodes.some(n => n.messageId === resolved.node.parent)) return invalid();
  return parseTaskBook({ ...book, nodes: [...book.nodes, resolved.node] }, book.scope);
}
