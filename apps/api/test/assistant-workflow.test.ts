import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantVersion, parseAssistantPlan, profileCalendar, compileAssistantPlan, cleanAssistantQuestion } from '../../../packages/analyzer/src/assistant-plan.ts';
import { emptyConversation, conversationInput } from '../../../packages/analyzer/src/assistant-conversation.ts';
import { runAssistant, assistantRequestFingerprint } from '../src/assistant-workflow.ts';
import type { AssistantJournal, AssistantModel, AssistantRequest, CompletionInput, AssistantServices } from '../src/assistant-workflow.ts';
import { trialId, trialCatalog, trialResult } from '../src/task-trial.ts';

const scope = { ownerId: 'assistant-synthetic-owner', chatId: trialId(801), generation: trialId(802), chatEpoch: trialId(803) };
const calendar = { timezone: 'Asia/Vladivostok', currentDate: '2026-10-16' };
const global = { revision: 0, filter: { from: '2026-10-01', through: '2026-10-31' }, touched: {} };
const set = (field: string, value: unknown, source?: string) => ({ field, op: 'set', value, ...(source ? { source } : {}) });
const plan = (changes: unknown[], mode = 'new') => ({ version: assistantVersion, topic: 'personal_finance', action: 'read', context: { mode }, changes });
function harness() {
  let conversation = emptyConversation(scope), calls: CompletionInput[] = [], catalogs = 0, calculations = 0, currentGlobal = structuredClone(global), currentNow = new Date('2026-10-15T22:30:00Z');
  const journals = new Map<string, AssistantJournal>(), requests = new Map<string, AssistantRequest>();
  const execute = async (n: number, question: string, replies: unknown[], options: { failure?: boolean; global?: any; timezone?: string; now?: Date; catalog?: typeof trialCatalog } = {}) => {
    if (options.global) currentGlobal = options.global; if (options.now) currentNow = options.now;
    const request: AssistantRequest = requests.get(trialId(n)) ?? { requestId: trialId(n), scope, conversation: structuredClone(conversation), global: currentGlobal, dataRevision: '1', question, now: currentNow, timezone: options.timezone ?? calendar.timezone };
    requests.set(request.requestId, request);
    let index = 0; let lastPlan: unknown;
    const model: AssistantModel = { bound: { inputTokens: 131072, outputTokens: 1200, modelVersion: 'synthetic' }, async complete(input, before) {
      calls.push(input); await before(); if (options.failure) throw Error('SYNTHETIC_TIMEOUT');
      const value = input.phase === 'check_changes' && index >= replies.length ? lastPlan : replies[index++];
      if (['understand', 'repair', 'check_changes'].includes(input.phase)) lastPlan = value;
      return { value, usage: { inputTokens: 100, outputTokens: 50, modelVersion: 'synthetic' } };
    } };
    const journal = journals.get(request.requestId) ?? { receipt: { fingerprint: assistantRequestFingerprint(request), calls: [] }, async persist() {}, async reserve() {}, async settle() {} } as AssistantJournal;
    journals.set(request.requestId, journal);
    const services: AssistantServices = { async guard() {}, async catalog() { catalogs++; return options.catalog ?? trialCatalog; }, async authorizeQuery() {},
      async calculate(query, actualCalendar) { calculations++; assert.equal(actualCalendar.timezone, request.timezone); return trialResult(query); },
      render(_query, result) { return 'Проверенный расчёт: ' + JSON.stringify((result as any).totals); }, async commit(input) { conversation = input.conversation; } };
    return runAssistant(request, model, journal, services);
  };
  return { execute, get state() { return conversation; }, get calls() { return calls; }, get catalogs() { return catalogs; }, get calculations() { return calculations; }, journals };
}

test('profile timezone defines date/month/year, including opposite sides of midnight and DST; invalid profile has no Moscow fallback', () => {
  const now = new Date('2026-01-01T01:30:00Z');
  assert.equal(profileCalendar(now, 'America/Los_Angeles').currentDate, '2025-12-31');
  assert.equal(profileCalendar(now, 'Asia/Vladivostok').currentDate, '2026-01-01');
  assert.equal(profileCalendar(new Date('2026-03-29T01:30:00Z'), 'Europe/Berlin').currentDate, '2026-03-29');
  assert.throws(() => profileCalendar(now, 'Bad/Zone'), /ASSISTANT_TIMEZONE_INVALID/);
  assert.throws(() => profileCalendar(now, ''), /ASSISTANT_TIMEZONE_INVALID/);
});

test('new plan has field-specific types without quote duplication or lexical grouping failures', () => {
  assert.doesNotThrow(() => parseAssistantPlan(plan([set('metric', 'attention'), set('grouping', 'operation')])));
  assert.doesNotThrow(() => parseAssistantPlan(plan([set('metric', 'expenses'), set('period', 'в сентябре 2026 года')])));
  for (const value of [plan([set('amount', true)]), plan([set('operationIds', [trialId(1)])]), { ...plan([]), sql: 'SELECT 1' }, plan([set('period', 'сегодня'), set('period', 'вчера')])]) assert.throws(() => parseAssistantPlan(value));
});

test('boolean freshness defaults on read never cause repair or change the financial route', async () => {
  for (const flag of [false, true]) {
    const h = harness();
    const reply = await h.execute(990, 'Подсчитай мои траты', [{ ...plan([set('metric', 'expenses')]), needsFreshSources: flag }]);
    assert.equal(reply.status, 'query'); assert.equal(reply.modelCalls, 1); assert.equal(h.calls[0]!.phase, 'understand');
  }
});

test('semantic review removes an unrequested reset and repairs a wrongly new amount-only continuation', async () => {
  const h = harness();
  await h.execute(991, 'Траты за август по категориям в сравнении с предыдущим периодом', [plan([set('metric', 'expenses'), set('period', 'август 2026'), set('grouping', 'category'), set('comparison', 'previous_same')])]);
  const changed = await h.execute(992, 'Дальше поступления', [
    { ...plan([set('metric', 'income'), set('grouping', 'none'), set('period', 'август 2026')], 'continue'), needsFreshSources: false },
    plan([set('metric', 'income')], 'continue'),
  ]);
  assert.equal(changed.query!.metric, 'income'); assert.equal(changed.query!.grouping, 'category'); assert.equal(changed.query!.comparison, 'previous_same');
  assert.equal(changed.query!.filter.from, '2026-08-01'); assert.equal(changed.modelCalls, 2);
  assert.equal(h.calls.at(-1)!.phase, 'check_changes'); assert.equal((h.calls.at(-1)!.input as any).history, undefined);
  const amount = set('amount', { basis: 'absolute_operation', expression: 'больше 750 рублей' });
  const narrowed = await h.execute(993, 'Отбери операции больше 750 рублей', [plan([amount]), plan([amount], 'continue')]);
  assert.equal(narrowed.status, 'query'); assert.equal(narrowed.query!.filter.amountFrom, '75001'); assert.equal(narrowed.query!.filter.from, '2026-08-01');
  assert.equal(narrowed.query!.grouping, 'category'); assert.equal(narrowed.query!.comparison, 'previous_same');
});

test('structure repair cannot rewrite valid fields; semantic contract errors do not trigger paid repair', async () => {
  const h = harness(), original = plan([set('metric', 'income')]);
  const changed = await h.execute(994, 'Доходы одной суммой', [{ ...original, extraneous: true }, plan([set('metric', 'expenses')])]);
  assert.equal(changed.code, 'ASSISTANT_REPAIR_MEANING_CHANGED'); assert.equal(h.calculations, 0);
  const invalid = await h.execute(995, 'Покажи расходы', [plan([set('metric', 'income'), set('metric', 'expenses')])]);
  assert.equal(invalid.modelCalls, 1); assert.equal(invalid.code, 'ASSISTANT_DUPLICATE_CHANGE');
});

test('today/current month use the profile date while explicit date-only operation filters remain unchanged', async () => {
  const h = harness();
  const today = await h.execute(900, 'Каковы траты за сегодня?', [plan([set('metric', 'expenses'), set('period', 'сегодня')])]);
  assert.equal(today.query!.filter.from, '2026-10-16'); assert.equal(today.query!.filter.through, '2026-10-16');
  const month = await h.execute(901, 'Теперь текущий месяц', [plan([set('period', 'текущий месяц')], 'continue')]);
  assert.equal(month.query!.filter.through, '2026-10-16');
  const fixed = await h.execute(902, 'Сумма за 2026-09-02 по 2026-09-04', [plan([set('metric', 'expenses'), set('period', '2026-09-02 по 2026-09-04')])], { timezone: 'America/Los_Angeles' });
  assert.equal(fixed.query!.filter.from, '2026-09-02'); assert.equal(fixed.query!.filter.through, '2026-09-04');
});

test('category grouping and metric changes preserve amount/account/date conditions, and explicit removal only removes its group', async () => {
  const h = harness();
  await h.execute(910, 'Доходы от 1000 до 2500 рублей включительно', [plan([set('metric', 'income'), set('amount', { basis: 'absolute_operation', expression: 'от 1000 до 2500 рублей включительно' })])]);
  const byCategory = await h.execute(911, 'Разбей по категориям', [plan([set('grouping', 'category')], 'continue')]);
  assert.equal(byCategory.query!.filter.amountFrom, '100000'); assert.equal(byCategory.query!.filter.amountThrough, '250000');
  const expenses = await h.execute(912, 'А расходы?', [plan([set('metric', 'expenses')], 'continue')]);
  assert.equal(expenses.query!.filter.amountFrom, '100000'); assert.equal(expenses.query!.grouping, 'category');
  const clear = await h.execute(913, 'Сними только порог', [plan([{ field: 'amount', op: 'clear' }], 'continue')]);
  assert.equal(clear.query!.filter.amountFrom, undefined); assert.equal(clear.query!.grouping, 'category');
  assert.equal(clear.query!.filter.from, '2026-10-01');
});

test('failed first request stays in cleaned history and can be reinterpreted with a follow-up without accepting failed JSON', async () => {
  const h = harness();
  const bad = { ...plan([]), arbitrary: true };
  const failure = await h.execute(920, 'Траты на продукты в сентябре 2026 года', [bad, bad]);
  assert.equal(failure.status, 'error'); assert.equal(h.state.book.nodes.length, 0); assert.equal(h.state.turns[0]!.pending, true);
  const recovered = await h.execute(921, 'Теперь по категориям', [plan([set('metric', 'expenses', 'h1'), set('period', 'сентябрь 2026 года', 'h1'), set('categories', { names: ['продукты'] }, 'h1'), set('grouping', 'category')], 'pending')]);
  assert.equal(recovered.status, 'query'); assert.equal(recovered.query!.filter.from, '2026-09-01'); assert.equal(recovered.query!.grouping, 'category');
  assert.deepEqual(recovered.query!.filter.categoryIds, [trialId(10)]);
  const sent = h.calls.findLast(c => c.phase === 'understand')!.input as any;
  assert.equal(sent.history[0].question, 'Траты на продукты в сентябре 2026 года'); assert.equal(sent.history[0].pending, true);
  assert.equal(JSON.stringify(sent).includes('arbitrary'), false); assert.equal(JSON.stringify(sent).includes('50000000-'), false);
});

test('two failed messages can be reinterpreted together without losing the first period or the second threshold', async () => {
  const h = harness(), bad = { broken: true };
  await h.execute(980, 'Траты за сентябрь 2026', [bad, bad]);
  await h.execute(981, 'Только операции от 100 рублей', [bad, bad]);
  const recovered = await h.execute(982, 'Теперь по категориям', [plan([set('metric', 'expenses', 'h1'), set('period', 'сентябрь 2026', 'h1'),
    set('amount', { basis: 'absolute_operation', expression: 'от 100 рублей' }, 'h2'), set('grouping', 'category')], 'pending')]);
  assert.equal(recovered.status, 'query'); assert.equal(recovered.query!.filter.from, '2026-09-01'); assert.equal(recovered.query!.filter.amountFrom, '10000');
  assert.equal(recovered.query!.grouping, 'category');
});

test('unrelated and ambiguous never read finances, general financial answers need no financial catalog, and current rate has honest source unavailability', async () => {
  const h = harness();
  const unrelated = await h.execute(930, 'Отчего у белки рыжая шуба?', [{ version: assistantVersion, topic: 'unrelated', action: 'redirect' }]);
  assert.equal(unrelated.status, 'redirect');
  const ambiguity = await h.execute(931, 'И это?', [{ version: assistantVersion, topic: 'ambiguous', action: 'clarification' }]); assert.equal(ambiguity.status, 'clarification');
  const knowledge = await h.execute(932, 'Объясни инфляцию простыми словами', [{ version: assistantVersion, topic: 'general_finance', action: 'explain' }, { text: 'Инфляция — рост общего уровня цен.' }]);
  assert.equal(knowledge.status, 'answer');
  const fresh = await h.execute(933, 'Назови текущую ставку', [{ version: assistantVersion, topic: 'general_finance', action: 'explain', needsFreshSources: true }]);
  assert.equal(fresh.code, 'FRESH_SOURCE_UNAVAILABLE'); assert.equal(h.catalogs, 0); assert.equal(h.calculations, 0);
});

test('missing taxi offers an existing transport category and never silently calculates it or invents a category', async () => {
  const h = harness(), catalog = { ...trialCatalog, categories: [{ ...trialCatalog.categories[0]!, name: 'Общественный транспорт' }] };
  const reply = await h.execute(940, 'Посчитай траты на такси', [plan([set('metric', 'expenses'), set('categories', { names: ['Такси'] })]), { names: ['Общественный транспорт'] }], { catalog });
  assert.equal(reply.code, 'CATEGORY_CHOICE_REQUIRED'); assert.match(reply.text, /Такси/); assert.match(reply.text, /Общественный транспорт/); assert.equal(h.calculations, 0);
  assert.equal(h.state.book.nodes.length, 0);
  const invented = await h.execute(941, 'Снова такси', [plan([set('metric', 'expenses'), set('categories', { names: ['Такси'] })]), { names: ['Несуществующая категория'] }], { catalog });
  assert.equal(invented.code, 'ASSISTANT_SUGGESTION_INVALID'); assert.equal(h.calculations, 0);
});

test('known answer replays without a model call; timeout stays unknown and is never automatically dispatched again', async () => {
  const h = harness();
  const first = await h.execute(950, 'Итог расходов', [plan([set('metric', 'expenses')])]); const calls = h.calls.length;
  const again = await h.execute(950, 'Итог расходов', []); assert.deepEqual(again, first); assert.equal(h.calls.length, calls);
  const unknown = await h.execute(951, 'Траты за день', [], { failure: true }); assert.equal(unknown.code, 'ASSISTANT_DELIVERY_UNKNOWN');
  assert.equal(h.journals.get(trialId(951))!.receipt.calls[0]!.state, 'unknown');
  const retry = await h.execute(951, 'Траты за день', []); assert.deepEqual(retry, unknown); assert.equal(h.calls.length, calls + 1);
});

test('one structure repair maximum and three calls total include category selection; a second bad structure fails without extra attempts', async () => {
  const h = harness(), bad = { wrong: true };
  const failed = await h.execute(952, 'Итог затрат', [bad, bad]);
  assert.equal(failed.status, 'error'); assert.equal(failed.modelCalls, 2);
  const catalog = { ...trialCatalog, categories: [{ ...trialCatalog.categories[0]!, name: 'Транспорт' }] };
  const three = await h.execute(953, 'Траты на такси', [bad, plan([set('metric', 'expenses'), set('categories', { names: ['Такси'] })]), { names: ['Транспорт'] }], { catalog });
  assert.equal(three.status, 'clarification'); assert.equal(three.modelCalls, 3); assert.equal(h.calculations, 0);
});

test('manual UI edits affect their group, explicit text wins, use_current is explicit, and general answers do not erase a task', async () => {
  const h = harness();
  await h.execute(954, 'Расходы в сентябре', [plan([set('metric', 'expenses'), set('period', 'сентябрь'), set('amount', { basis: 'absolute_operation', expression: 'от 100 рублей' })])]);
  const changed = { revision: 1, filter: { from: '2026-08-01', through: '2026-08-31' }, touched: { period: 1 } };
  const second = await h.execute(955, 'По категориям', [plan([set('grouping', 'category')], 'continue')], { global: changed });
  assert.equal(second.query!.filter.from, '2026-08-01'); assert.equal(second.query!.filter.amountFrom, '10000');
  const explicit = await h.execute(956, 'Но за июль', [plan([set('period', 'июль')], 'continue')]); assert.equal(explicit.query!.filter.from, '2026-07-01');
  await h.execute(957, 'Что такое вклад?', [{ version: assistantVersion, topic: 'general_finance', action: 'explain' }, { text: 'Вклад — деньги, размещённые в банке на условиях договора.' }]);
  const current = await h.execute(958, 'Возьми период сверху', [plan([{ field: 'period', op: 'use_current' }], 'continue')]);
  assert.equal(current.query!.filter.from, '2026-08-01'); assert.equal(current.query!.filter.amountFrom, '10000');
});

test('pending recovery respects its old calendar and newer UI touches and cannot widen an earlier fixed selection', async () => {
  const h = harness(), bad = { wrong: true }, original = { ...global, filter: { ...global.filter, operationIds: [trialId(30)] } };
  await h.execute(970, 'Затраты сегодня от 100 рублей', [bad, bad], { global: original, now: new Date('2026-10-15T22:30:00Z') });
  const changed = { revision: 1, filter: { from: '2026-09-01', through: '2026-09-30', operationIds: [trialId(31)] }, touched: { period: 1 } };
  const recovered = await h.execute(971, 'Разбей по категориям', [plan([set('metric', 'expenses', 'h1'), set('period', 'сегодня', 'h1'), set('amount', { basis: 'absolute_operation', expression: 'от 100 рублей' }, 'h1'), set('grouping', 'category')], 'pending')], { global: changed, now: new Date('2026-10-17T03:00:00Z') });
  assert.equal(recovered.status, 'query'); assert.equal(recovered.query!.filter.from, '2026-09-01'); assert.deepEqual(recovered.query!.filter.operationIds, []);
  const h2 = harness(); await h2.execute(972, 'Затраты сегодня', [bad, bad], { now: new Date('2026-10-15T22:30:00Z') });
  const anchored = await h2.execute(973, 'Одной суммой', [plan([set('metric', 'expenses', 'h1'), set('period', 'сегодня', 'h1'), set('grouping', 'none')], 'pending')], { now: new Date('2026-10-17T03:00:00Z') });
  assert.equal(anchored.query!.filter.from, '2026-10-16');
});

test('explicit old result returns to that task; vague reference to multiple independent tasks clarifies', async () => {
  const h = harness();
  await h.execute(980, 'Расходы за сентябрь', [plan([set('metric', 'expenses'), set('period', 'сентябрь')])]);
  await h.execute(981, 'Расходы за август новым расчётом', [plan([set('metric', 'expenses'), set('period', 'август')])]);
  const vague = await h.execute(982, 'Вернись к расходам', [{ ...plan([], 'reference'), context: { mode: 'reference', reference: 'к расходам' } }]); assert.equal(vague.status, 'clarification');
  const old = await h.execute(983, 'К первому результату расходов', [{ ...plan([set('grouping', 'category')], 'reference'), context: { mode: 'reference', reference: 'первому результату расходов' } }]);
  assert.equal(old.query!.filter.from, '2026-09-01'); assert.equal(old.query!.grouping, 'category');
});

test('secrets and bank identifiers do not enter model question/history', () => {
  const cleaned = cleanAssistantQuestion('Мой пароль=abcSECRET карта 1234567890123456 почта test@example.com');
  for (const secret of ['abcSECRET', '1234567890123456', 'test@example.com']) assert.equal(cleaned.includes(secret), false);
  assert.throws(() => conversationInput(emptyConversation(scope), { ...scope, chatId: trialId(999) }, 'Доходы?', calendar), /TASK_SCOPE_MISMATCH/);
});

test('unknown event period clarifies instead of calculating globals, signed thresholds remain integer and scalar evidence is unnecessary', async () => {
  const h = harness();
  const unclear = await h.execute(960, 'Расходы после неизвестного события', [plan([set('metric', 'expenses'), set('period', 'после моей зарплаты')])]); assert.equal(unclear.status, 'clarification'); assert.equal(h.calculations, 0);
  const strict = await h.execute(961, 'Доходы больше 1000 рублей', [plan([set('metric', 'income'), set('amount', { basis: 'absolute_operation', expression: 'больше 1000 рублей' })])]);
  assert.equal(strict.query!.filter.amountFrom, '100001');
});
