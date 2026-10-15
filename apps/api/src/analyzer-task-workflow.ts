import { object, dateFact, uuid } from '../../../packages/finance-core/src/model.ts';
import { safeQuestion } from '../../../packages/analyzer/src/yandex-contract.ts';
import type { Catalog } from '../../../packages/analyzer/src/yandex-contract.ts';
import type { Query } from '../../../packages/analyzer/src/registry.ts';
import { registryVersion } from '../../../packages/analyzer/src/registry.ts';
import { parseTaskBook, globalSnapshot, taskDescriptors, resolveTaskDecision, acceptTaskResult, taskContextVersion } from '../../../packages/analyzer/src/task-context.ts';
import type { TaskScope, TaskBook, GlobalSnapshot } from '../../../packages/analyzer/src/task-context.ts';
import { TaskError } from '../../../packages/analyzer/src/task-context.ts';
import { taskCapabilities, taskProtocolVersion, parseTaskRelevance, prepareTaskProposal } from '../../../packages/analyzer/src/task-protocol.ts';
import { literalContractVersion } from '../../../packages/analyzer/src/task-literals.ts';

export const taskWorkflowVersion = 'analyzer-task-workflow/1';
export type TaskInput = { scope: TaskScope; book: TaskBook; global: GlobalSnapshot; dataRevision: string; messageId: string; question: string; currentDate: string };
export type ExpectedTaskState = { scope: TaskScope; globalRevision: number; dataRevision: string; head: string | null; count: number };
export type TaskModel = {
  relevance(input: { question: string; hasFinancialTasks: boolean; capabilities: typeof taskCapabilities }): Promise<unknown>;
  proposal(input: { question: string; currentDate: string; timezone: 'Europe/Moscow'; tasks: ReturnType<typeof taskDescriptors>; capabilities: typeof taskCapabilities; hasFixedOperationScope: boolean }): Promise<unknown>;
};
export type TaskServices<Result> = {
  // The implementation checks owner/active access, chat lifetime, cancellation,
  // data/global revision and expected book head, also after awaited work.
  guard(expected: ExpectedTaskState): Promise<void>;
  catalog(): Promise<Catalog>;
  authorizeQuery(query: Query): Promise<void>;
  calculate(query: Query): Promise<Result>;
  // The implementation MUST atomically compare scope/generation/book head and
  // current data/global revisions when persisting the answer and semantic book.
  commit(input: { expected: ExpectedTaskState; book: TaskBook; query: Query; result: Result }): Promise<void>;
};
export type TaskOutcome<Result> = { status: 'query'; query: Query; result: Result; book: TaskBook; inheritedFrom: string | null } |
  { status: 'clarification' | 'unsupported' | 'redirect' | 'failed'; reason: string; book: TaskBook };
/** New offline-tested workflow. It is not registered in runtime routes, paid
 * CLI or provider adapters; release requires persistence and real-model gates.
 * No default model, network or retry exists. Accounting belongs in the adapter. */
export async function runAnalyzerTask<Result>(input: TaskInput, model: TaskModel, services: TaskServices<Result>): Promise<TaskOutcome<Result>> {
  const book = parseTaskBook(input.book, input.scope), global = globalSnapshot(input.global), messageId = uuid(input.messageId), question = safeQuestion(input.question);
  const currentDate = (dateFact({ precision: 'day', date: input.currentDate }) as { date: string }).date;
  if (!/^(0|[1-9]\d{0,18})$/.test(input.dataRevision)) throw new TaskError('TASK_REVISION_INVALID');
  if (book.nodes.some(n => n.messageId === messageId)) throw new TaskError('TASK_MESSAGE_REUSED');
  if (book.nodes.length === 100) throw new TaskError('TASK_LIMIT');
  const expected: ExpectedTaskState = { scope: book.scope, globalRevision: global.revision, dataRevision: input.dataRevision, head: book.nodes.at(-1)?.messageId ?? null, count: book.nodes.length };
  const guard = () => services.guard(structuredClone(expected));
  await guard();
  const relevanceValue = await model.relevance({ question, hasFinancialTasks: book.nodes.length > 0, capabilities: taskCapabilities });
  await guard();
  let relevance: ReturnType<typeof parseTaskRelevance>;
  try { relevance = parseTaskRelevance(relevanceValue); } catch { return { status: 'failed', reason: 'invalid_relevance', book }; }
  if (relevance.relevance === 'unrelated') return { status: 'redirect', reason: 'unrelated', book };
  if (relevance.relevance === 'ambiguous') return { status: 'clarification', reason: 'ambiguous', book };
  const raw = await model.proposal({ question, currentDate, timezone: 'Europe/Moscow', tasks: taskDescriptors(book), capabilities: taskCapabilities,
    hasFixedOperationScope: Boolean(global.filter.operationIds || book.nodes.some(n => n.fixedOperationIds)) });
  await guard();
  let prepared: ReturnType<typeof prepareTaskProposal>;
  let needsCatalog: boolean;
  try {
    // A valid financial gate still does not justify reading a catalog for a
    // model refusal/unsupported response. Only actual name edits need it.
    const root = object(raw, ['status', 'binding', 'metric', 'grouping', 'comparison', 'edits']);
    needsCatalog = root.status === 'query' && Array.isArray(root.edits) && root.edits.some(value => {
      const e = object(value, ['field', 'op', 'value', 'quote']);
      return e.op === 'set' && (e.field === 'accounts' || ['categories', 'counterparties'].includes(String(e.field)) && e.value !== null && typeof e.value === 'object' && (Object.hasOwn(e.value, 'names') || Object.hasOwn(e.value, 'excludedNames')));
    });
  } catch { return { status: 'failed', reason: 'invalid_proposal', book }; }
  try {
    prepared = prepareTaskProposal(raw, question, book, input.scope, global, messageId, currentDate, { accounts: [], categories: [], counterparties: [] });
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
    return { status: 'failed', reason: 'invalid_proposal', book };
  }
  // Missing/ambiguous task bindings and protocol errors are resolved before a
  // catalog read. Only a still-unresolved exact name needs owned metadata.
  if (needsCatalog && prepared.status === 'clarification' && prepared.reason === 'reference_missing') {
    const catalog = await services.catalog();
    await guard();
    try { prepared = prepareTaskProposal(raw, question, book, input.scope, global, messageId, currentDate, catalog); }
    catch (error) { if (!(error instanceof TypeError || error instanceof RangeError)) throw error; return { status: 'failed', reason: 'invalid_proposal', book }; }
  }
  if (prepared.status !== 'query') return { ...prepared, book };
  const resolved = resolveTaskDecision(book, input.scope, global, prepared.decision, messageId);
  if (resolved.status !== 'resolved') return { ...resolved, book };
  await services.authorizeQuery(structuredClone(resolved.query));
  await guard();
  const result = await services.calculate(structuredClone(resolved.query));
  await guard();
  const nextBook = acceptTaskResult(book, resolved);
  await services.commit({ expected: structuredClone(expected), book: structuredClone(nextBook), query: structuredClone(resolved.query), result });
  return { status: 'query', query: resolved.query, result, book: nextBook, inheritedFrom: resolved.inheritedFrom };
}
// Consumers include all versions in request/result binding. Old receipts and
// old runtime behavior are never reparsed under this independently versioned flow.
export const taskWorkflowBinding = { registry: registryVersion, workflow: taskWorkflowVersion, context: taskContextVersion, protocol: taskProtocolVersion, literals: literalContractVersion } as const;
