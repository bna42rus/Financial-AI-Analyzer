import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { trialCatalog, trialRows, trialId } from './task-trial.ts';
import { calculateWidget, parseWidget } from '../../../packages/finance-core/src/overview.ts';
import type { OverviewCatalog } from '../../../packages/finance-core/src/overview.ts';
import { emptyConversation } from '../../../packages/analyzer/src/assistant-conversation.ts';
import { profileCalendar } from '../../../packages/analyzer/src/assistant-plan.ts';
import { parseTool } from '../../../packages/analyzer/src/registry.ts';
import { globalSnapshot } from '../../../packages/analyzer/src/task-context.ts';
import type { Query } from '../../../packages/analyzer/src/registry.ts';
import type { AssistantReply, AssistantRequest, AssistantServices } from './assistant-workflow.ts';
import type { AssistantJournal, RunReceipt } from './assistant-workflow.ts';
import { assistantRequestFingerprint, assistantWorkflowVersion } from './assistant-workflow.ts';
import { parseAssistantPlan, AssistantError } from '../../../packages/analyzer/src/assistant-plan.ts';
import type { Conversation } from '../../../packages/analyzer/src/assistant-conversation.ts';
import type { OperationsFilter } from '../../../packages/finance-core/src/operations.ts';

export const assistantTrialVersion = 'cashneuro-assistant-smoke/3';
export function seedAssistantReplay(journal: AssistantJournal, saved: { version: string; receipt: RunReceipt }, request: AssistantRequest) {
  const old = saved.receipt;
  if (saved.version !== assistantWorkflowVersion || old.fingerprint !== assistantRequestFingerprint(request) || journal.receipt.fingerprint !== old.fingerprint ||
      journal.receipt.calls.length || !Array.isArray(old.calls) || old.calls.length !== 1 || old.calls[0]!.phase !== 'understand' || old.calls[0]!.state !== 'received' || !old.calls[0]!.usage ||
      parseAssistantPlan(old.calls[0]!.value).action !== 'read') throw new AssistantError('ASSISTANT_REPLAY_CHANGED');
  // Recompile the actual received plan; never import an old result, golden
  // query or failed conversation. runAssistant verifies the call fingerprint.
  journal.receipt.calls = structuredClone(old.calls); journal.receipt.replayedCalls = old.calls.length;
}
const base = { from: '2026-10-01', through: '2026-10-31' }, september = { from: '2026-09-01', through: '2026-09-30' };
type Expected = { status: AssistantReply['status']; code?: string; query?: Query; totalMinor?: string; parent?: string | null; categorySuggestion?: string };
export type AssistantTrialCase = { id: string; scenario: string; question: string; timezone?: string; noTaxi?: boolean; expected: Expected };
const query = (metric: Query['metric'], filter: OperationsFilter, grouping: Query['grouping'] = 'none', comparison: Query['comparison'] = 'none'): Query => ({ name: 'query_finances', metric, grouping, comparison, filter });
const expectedQuery = (q: Query, totalMinor: string, parent: string | null = null): Expected => ({ status: 'query', query: q, totalMinor, parent });
const food = { ...september, categoryIds: [trialId(10)] }, threshold = { ...food, amountFrom: '100000', amountThrough: '250000', amountBasis: 'absolute_operation' as const };
/** New public synthetic DEVELOPMENT smoke, authored before model execution.
 * Expected queries never enter a model prompt. This is not a holdout or a
 * replacement for the product acceptance corpus. */
export const assistantTrialCases: AssistantTrialCase[] = [
  { id: 'chain-1', scenario: 'chain', question: 'За сентябрь 2026 посчитай мои траты на продукты.', expected: expectedQuery(query('expenses', food), '160000') },
  { id: 'chain-2', scenario: 'chain', question: 'Разложи результат по категориям.', expected: expectedQuery(query('expenses', food, 'category'), '160000', 'chain-1') },
  { id: 'chain-3', scenario: 'chain', question: 'Сравни с предыдущим таким же периодом.', expected: expectedQuery(query('expenses', food, 'category', 'previous_same'), '160000', 'chain-2') },
  { id: 'chain-4', scenario: 'chain', question: 'Теперь доходы.', expected: expectedQuery(query('income', food, 'category', 'previous_same'), '0', 'chain-3') },
  { id: 'chain-5', scenario: 'chain', question: 'Оставь операции с суммой от 1000 до 2500 рублей включительно.', expected: expectedQuery(query('income', threshold, 'category', 'previous_same'), '0', 'chain-4') },
  { id: 'chain-6', scenario: 'chain', question: 'Покажи каждую операцию отдельно.', expected: expectedQuery(query('income', threshold, 'operation', 'previous_same'), '0', 'chain-5') },
  { id: 'chain-7', scenario: 'chain', question: 'Сними только ограничение по сумме.', expected: expectedQuery(query('income', food, 'operation', 'previous_same'), '0', 'chain-6') },
  { id: 'today-east', scenario: 'today-east', question: 'Каковы мои траты за сегодня?', timezone: 'Asia/Vladivostok', expected: expectedQuery(query('expenses', { from: '2026-10-16', through: '2026-10-16' }), '0') },
  { id: 'today-west', scenario: 'today-west', question: 'Каковы мои траты за сегодня?', timezone: 'America/Los_Angeles', expected: expectedQuery(query('expenses', { from: '2026-10-15', through: '2026-10-15' }), '0') },
  { id: 'current-month', scenario: 'current-month', question: 'Общий размер расходов за текущий месяц?', expected: expectedQuery(query('expenses', { from: '2026-10-01', through: '2026-10-16' }), '17000') },
  { id: 'named-month', scenario: 'named-month', question: 'Общий размер расходов за сентябрь?', expected: expectedQuery(query('expenses', september), '195000') },
  { id: 'taxi-choice', scenario: 'taxi-choice', noTaxi: true, question: 'Сколько ушло на такси в сентябре 2026?', expected: { status: 'clarification', code: 'CATEGORY_CHOICE_REQUIRED', categorySuggestion: 'Общественный транспорт' } },
  { id: 'transport-selected', scenario: 'taxi-choice', noTaxi: true, question: 'Тогда посчитай по категории Общественный транспорт.', expected: expectedQuery(query('expenses', { ...september, categoryIds: [trialId(11)] }), '35000') },
  { id: 'concept', scenario: 'concept', question: 'Объясни, как инфляция влияет на мои накопления.', expected: { status: 'answer', code: 'FINANCIAL_EXPLANATION' } },
  { id: 'current-rate', scenario: 'current-rate', question: 'Какая сейчас ключевая ставка Банка России?', expected: { status: 'unsupported', code: 'FRESH_SOURCE_UNAVAILABLE' } },
  { id: 'mixed', scenario: 'mixed', question: 'Посчитай мои расходы за выбранный период и сообщи погоду в Омске.', expected: expectedQuery(query('expenses', base), '17000') },
  { id: 'unrelated', scenario: 'unrelated', question: 'Отчего у белки рыжая шуба?', expected: { status: 'redirect', code: 'UNRELATED' } },
  { id: 'ambiguous', scenario: 'ambiguous', question: 'И это самое?', expected: { status: 'clarification', code: 'MEANING_UNCLEAR' } },
  { id: 'unknown-event', scenario: 'unknown-event', question: 'Сколько ушло после дня моей зарплаты?', expected: { status: 'clarification' } },
  { id: 'signed', scenario: 'signed', question: 'Общие расходы за сентябрь 2026, только операции со знаковой суммой от -1200 до -400 рублей включительно.',
    expected: expectedQuery(query('expenses', { ...september, amountFrom: '-120000', amountThrough: '-40000', amountBasis: 'signed_operation' }), '160000') },
];

export function assistantTrialCatalog(noTaxi = false): typeof trialCatalog {
  return noTaxi ? { ...structuredClone(trialCatalog), categories: (trialCatalog.categories as OverviewCatalog['categories']).filter(c => c.id !== trialId(12)).map(c => c.id === trialId(11) ? { ...c, name: 'Общественный транспорт' } : structuredClone(c)) } : structuredClone(trialCatalog);
}
export function assistantTrialCalculate(q: Query, noTaxi = false) {
  const rows = structuredClone(trialRows);
  if (noTaxi) for (const r of rows) { r.classification.subcategory.value = null; for (const p of r.parts) p.subcategoryId = null; }
  return calculateWidget(parseWidget({ id: trialId(90), name: 'Новый синтетический опыт', metrics: [q.metric], grouping: q.grouping, period: 'global', filter: q.filter,
    comparison: { kind: q.comparison }, chart: 'table', topN: 10 }), rows, assistantTrialCatalog(noTaxi), {}, new Date('2026-10-16T12:00:00Z'));
}
export const assistantTrialRequestId = (index: number) => trialId(9000 + index);
export function assistantTrialRequest(c: AssistantTrialCase, index: number, conversation?: Conversation): AssistantRequest {
  const scenario = assistantTrialCases.findIndex(t => t.scenario === c.scenario), scope = { ownerId: 'new-assistant-synthetic-owner', chatId: trialId(8000 + scenario), generation: trialId(7000), chatEpoch: trialId(7001) };
  return { requestId: assistantTrialRequestId(index), scope, conversation: conversation ?? emptyConversation(scope), global: globalSnapshot({ revision: 0, filter: base, touched: {} }),
    dataRevision: '1', question: c.question, now: new Date('2026-10-15T22:30:00Z'), timezone: c.timezone ?? 'Asia/Vladivostok' };
}
export function assistantTrialServices(r: AssistantRequest, c: AssistantTrialCase, save: (state: Conversation) => void): AssistantServices {
  return { async guard(expected) { if (expected.scope.ownerId !== r.scope.ownerId || expected.scope.chatId !== r.scope.chatId) throw Error('ASSISTANT_TRIAL_SCOPE_CHANGED'); },
    async catalog() { return assistantTrialCatalog(c.noTaxi); }, async authorizeQuery(q) {
      parseTool(q); const catalog = assistantTrialCatalog(c.noTaxi);
      for (const key of ['categoryIds', 'subcategoryIds', 'excludedCategoryIds'] as const) if (q.filter[key]?.some(id => !catalog.categories.some(row => row.id === id))) throw Error('ASSISTANT_TRIAL_OWNERSHIP_DENIED');
      if (q.filter.accountIds?.some(id => !catalog.accounts.some(a => a.id === id)) || q.filter.counterpartyIds?.length) throw Error('ASSISTANT_TRIAL_OWNERSHIP_DENIED');
    }, async calculate(q, calendar) { if (!isDeepStrictEqual(calendar, profileCalendar(r.now, r.timezone))) throw Error('ASSISTANT_TRIAL_CALENDAR_CHANGED'); return assistantTrialCalculate(q, c.noTaxi); },
    render(q, result) { return 'Проверенный итог в копейках: ' + (result as ReturnType<typeof assistantTrialCalculate>).totals[q.metric]; },
    async commit(input) { save(input.conversation); },
  };
}
export function scoreAssistantTrial(c: AssistantTrialCase, reply: AssistantReply, conversation: Conversation) {
  const e = c.expected, failures: string[] = [];
  if (e.status !== reply.status) failures.push('status');
  if (e.code && e.code !== reply.code) failures.push('code');
  if (e.query && !isDeepStrictEqual(reply.query, e.query)) failures.push('query');
  if (e.totalMinor !== undefined && (reply.result as ReturnType<typeof assistantTrialCalculate> | undefined)?.totals[e.query!.metric] !== e.totalMinor) failures.push('totalMinor');
  if (e.categorySuggestion && !reply.text.includes(e.categorySuggestion)) failures.push('categorySuggestion');
  if ('parent' in e && reply.status === 'query') {
    const parentIndex = e.parent === null ? -1 : assistantTrialCases.findIndex(t => t.id === e.parent);
    if (conversation.book.nodes.at(-1)?.parent !== (parentIndex < 0 ? null : assistantTrialRequestId(parentIndex))) failures.push('parent');
  }
  return { id: c.id, passed: failures.length === 0, failures, actualStatus: reply.status, code: reply.code };
}

/** Closed relative-import closure; changing code, prompts, corpus or pinned
 * dependencies creates a different experiment and refuses old receipts. */
export async function assistantTrialManifest() {
  const root = new URL('../../../', import.meta.url), pending = [new URL('./assistant-trial-main.ts', import.meta.url), new URL('../../../package.json', import.meta.url), new URL('../../../pnpm-lock.yaml', import.meta.url)];
  const source: Record<string, string> = {};
  for (let i = 0; i < pending.length; i++) {
    const url = pending[i]!, key = url.href.slice(root.href.length);
    if (!url.href.startsWith(root.href) || pending.length > 400) throw Error('ASSISTANT_TRIAL_SOURCE_INVALID');
    if (key in source) continue;
    const text = await readFile(url, 'utf8'); source[key] = createHash('sha256').update(text).digest('hex');
    if (!/\.(?:ts|js|mjs)$/.test(url.pathname)) continue;
    for (const pattern of [/^\s*import\s+(?:[^;'"`]+\s+from\s+)?['"](\.[^'"`]+)['"]/gmu, /^\s*export\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+['"](\.[^'"`]+)['"]/gmu]) for (const m of text.matchAll(pattern)) pending.push(new URL(m[1]!, url));
  }
  const sorted = Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b)));
  return { version: assistantTrialVersion, sourceSha256: createHash('sha256').update(JSON.stringify(sorted)).digest('hex'), source: sorted,
    cases: assistantTrialCases.length, maximumCalls: 60, cumulativeCapRub: '10', deductPreviousAttempt: true, liveExecuted: false, runtimeAiEnabled: false, developmentSmokeOnly: true };
}
