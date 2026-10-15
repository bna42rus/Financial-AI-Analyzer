import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskIntent, compileTaskIntent, taskIntentSchema, taskIntentPrompt } from '../../../packages/analyzer/src/task-intent.ts';
import { intentTaskModel } from '../src/analyzer-intent-model.ts';
import { evaluateTrialScenario, loadTrialCorpus } from '../src/task-trial.ts';
import { intentRequestBody } from '../src/task-intent-transport.ts';
import { expandPromptSchema, factorPromptSchema } from '../src/task-prepared-contract.ts';
import { emptyTaskBook, resolveTaskDecision, acceptTaskResult } from '../../../packages/analyzer/src/task-context.ts';
import { prepareTaskProposal } from '../../../packages/analyzer/src/task-protocol.ts';
import { trialCatalog, trialId } from '../src/task-trial.ts';

const m = (value: string, quote: string) => ({ value, quote });
const set = (field: string, value: unknown, quote: string) => ({ field, op: 'set', value, quote });
const period = (quote: string) => set('period', quote, quote);
const category = (name: string) => set('categories', { names: [name] }, name);
const amount = (quote: string, basis = 'absolute_operation') => set('amount', { basis, expression: quote }, quote);
const read = (fields: Record<string, unknown> = {}) => ({ relevance: 'financial', action: 'read', ...fields });
const unsupported = { relevance: 'financial', action: 'unsupported' };
const unrelated = { relevance: 'unrelated', action: 'clarification' };
const ambiguous = { relevance: 'ambiguous', action: 'clarification' };
const expenses = (quote: string, edits: unknown[] = []) => read({ metric: m('expenses', quote), ...(edits.length ? { edits } : {}) });
const income = (quote: string, edits: unknown[] = []) => read({ metric: m('income', quote), ...(edits.length ? { edits } : {}) });
const byCategory = read({ grouping: m('category', 'по категориям') });
// Independently annotated literal mentions, not generated from expected queries.
// These are parser/resolver tests, NEVER evidence of GPT-OSS language accuracy.
const singles = [
  expenses('потрачено'), income('доходы'), read({ metric: m('attention', 'требуют внимания') }),
  expenses('расходов', [category('продукты'), period('сентябрь 2026 года')]),
  expenses('расходы', [category('такси')]), read({ metric: m('expenses', 'расходы'), grouping: m('category', 'по категориям') }),
  read({ metric: m('expenses', 'расходы'), comparison: m('previous_same', 'Сравни') }),
  expenses('потратил', [period('сентябре 2026 года')]), read({ metric: m('expenses', 'Расходы'), grouping: m('none', 'одной суммой'), edits: [period('2026-09-02 по 2026-09-04')] }),
  expenses('потратил', [period('сегодня')]), expenses('потратил', [period('вчера')]),
  expenses('потратил', [period('текущий месяц')]), expenses('потратил', [period('предыдущий месяц')]), expenses('расходов', [period('февраль 2024 года')]),
  read({ metric: m('attention', 'надо проверить'), edits: [period('сентябрь 2026 года')] }),
  income('доход', [amount('от 1000 до 2500 рублей включительно')]), income('доходов', [amount('не выше 99 рублей 50 копеек')]),
  income('доходов', [amount('больше 1000 рублей')]), income('доходов', [amount('не меньше 1000 рублей')]),
  expenses('Расходы', [period('сентябрь 2026 года'), amount('от -1200 до -400 рублей включительно', 'signed_operation')]),
  expenses('потратил', [category('Единороги')]), expenses('потратил', [period('после моей зарплаты')]),
  unrelated, unrelated, unrelated, unrelated, ambiguous, ambiguous, unsupported,
  { ...expenses('расходы'), relevance: 'adjacent' }, unsupported, unsupported,
];
const dialogs: Record<string, unknown[]> = {
  scope: [expenses('потратил', [category('продукты'), period('сентябре 2026 года')]), byCategory, read({ edits: [category('такси')] }), read({ edits: [period('октябрь 2026 года')] }), income('доходы'), byCategory],
  manual: [expenses('расходов', [period('сентябрь 2026 года')]), byCategory, read({ grouping: m('none', 'итог одной суммой') }), read({ edits: [period('сентябрь 2026 года')] }), read({ grouping: m('operation', 'отдельные операции') }), income('заработал')],
  branch: [read({ metric: m('expenses', 'расходы'), comparison: m('previous_same', 'Сравни'), edits: [period('сентябрь 2026 года')] }), income('доходы', [period('октябрь 2026 года')]), read({ reference: 'первому результату', grouping: m('category', 'по категориям') }), read({ comparison: m('none', 'без сравнения') }), read({ edits: [category('такси')] }), read({ edits: [{ field: 'categories', op: 'clear', quote: 'без ограничения по категориям' }] })],
  preserve: [expenses('расходов', [category('продукты'), period('сентябре 2026 года')]), unrelated, read({ edits: [category('Единороги')] }), byCategory, unsupported, read({ grouping: m('operation', 'отдельные операции') })],
  fixed: [expenses('расходов'), read({ edits: [category('продукты')] }), read({ edits: [{ field: 'categories', op: 'clear', quote: 'без ограничения по категории' }] }), byCategory, read({ edits: [period('октябрь 2026 года')] }), income('доходов')],
  money: [income('доходов', [amount('от 1000 до 2500 рублей включительно')]), byCategory, read({ grouping: m('operation', 'отдельные операции') }), read({ edits: [{ field: 'amount', op: 'clear', quote: 'без ограничения по сумме' }] }), read({ grouping: m('none', 'общий итог') }), expenses('расходов', [period('сентябрь 2026 года')])],
};

test('all 68 development turns and 24 repeat slots resolve exact independent goldens from literal mentions, without a model binding or golden parent', async () => {
  const { corpus } = await loadTrialCorpus(), sent: unknown[] = [], rows = [];
  const run = (turns: typeof corpus.singles, values: unknown[], occurrence = 0) => evaluateTrialScenario(turns, turn => intentTaskModel(async input => {
    sent.push(input); return structuredClone(values[turns.indexOf(turn)]);
  }), occurrence);
  for (const [index, turn] of corpus.singles.filter(t => t.split === 'development').entries()) rows.push(...await run([turn], [singles[index]]));
  for (const dialog of corpus.dialogs.filter(d => d.split === 'development')) rows.push(...await run(dialog.turns, dialogs[dialog.id]!));
  for (const repetition of corpus.repetitions) {
    const index = corpus.singles.findIndex(t => t.id === repetition.caseId);
    for (let occurrence = 1; occurrence <= 2; occurrence++) rows.push(...await run([corpus.singles[index]!], [singles[index]], occurrence));
  }
  assert.equal(rows.length, 92); assert.deepEqual(rows.filter(row => !row.passed), []);
  assert.equal(sent.length, 92);
  for (const input of sent) assert.deepEqual(Object.keys(input as object).sort(), ['hasFinancialTasks', 'question']);
  const wire = JSON.stringify(sent); for (const denied of ['expected', '50000000-', 'totalMinor', 'taskHandle', '160000', '2100000']) assert.equal(wire.includes(denied), false);
});

test('money follow-ups keep the 1000..2500 RUB threshold, presentation changes, explicit removal and new task remain distinct', async () => {
  const { corpus } = await loadTrialCorpus(), turns = corpus.dialogs.find(d => d.id === 'money')!.turns;
  const rows = await evaluateTrialScenario(turns, (turn) => intentTaskModel(async () => dialogs.money![turns.indexOf(turn)]));
  assert.equal(rows[1]!.actualTotalMinor, '100000'); assert.equal(rows[1]!.actualQuery!.filter.amountFrom, '100000');
  assert.equal(rows[2]!.actualQuery!.grouping, 'operation'); assert.equal(rows[3]!.actualQuery!.filter.amountFrom, undefined);
  assert.equal(rows[3]!.actualTotalMinor, '2100000'); assert.equal(rows[4]!.actualQuery!.grouping, 'none'); assert.equal(rows[5]!.bindingCorrect, true);
});

test('default context is local and invalid/nonfinancial intent never causes another model request or financial read', async () => {
  const { corpus } = await loadTrialCorpus();
  for (const intent of [unrelated, ambiguous, { ...read(), binding: { kind: 'new' } }, read({ metric: m('income', 'по категориям') })]) {
    let requests = 0;
    const [row] = await evaluateTrialScenario([corpus.singles[0]!], () => intentTaskModel(async () => { requests++; return intent; }));
    assert.equal(requests, 1); assert.equal(row!.passed, false); assert.equal(row!.actualQuery, undefined);
  }
  // A wrong gate stays a visible model failure, even for an obvious financial question.
  const [wrong] = await evaluateTrialScenario([corpus.singles[2]!], () => intentTaskModel(async () => unrelated));
  assert.equal(wrong!.actualStatus, 'redirect'); assert.equal(wrong!.relevanceCorrect, false);
});

test('the evidence validator rejects fabricated metrics, accidental operation format, redundant review filters and unsupported protocol authority', () => {
  const cases: [string, unknown][] = [
    ['А по категориям?', read({ metric: m('income', 'по категориям') })],
    ['Сумма доходов по операциям не выше 100 рублей.', read({ grouping: m('operation', 'по операциям') })],
    ['А на такси?', read({ grouping: m('none', 'такси') })],
    ['Какие операции требуют внимания?', read({ metric: m('attention', 'требуют внимания'), edits: [set('attention', true, 'требуют внимания')] })],
    ['Сумма расходов.', { ...expenses('расходов'), filter: { operationIds: [] } }],
    ['Сумма расходов.', { ...expenses('расходов'), metric: { value: 'expenses', quote: 'не было' } }],
    ['Сумма расходов.', { ...expenses('расходов'), edits: [{ field: 'categories', op: 'keep' }] }],
    ['Сумма расходов.', { ...expenses('расходов'), edits: [{ field: 'operationIds', op: 'clear', quote: 'расходов' }] }],
  ];
  for (const [question, value] of cases) assert.throws(() => compileTaskIntent(value, question), question);
  const exact = compileTaskIntent(read({ edits: [amount('от 1000 до 2500 рублей включительно')] }), 'А от 1000 до 2500 рублей включительно?');
  assert.deepEqual(exact.metric, { op: 'keep' }); assert.deepEqual(exact.grouping, { op: 'keep' });
});

test('task selection is compiled from literal references and omitted fields; model handles and binding instructions are rejected', () => {
  for (const [question, intent, expected] of [
    ['Покажи доходы.', income('доходы'), { kind: 'new' }],
    ['А по категориям?', byCategory, { kind: 'nearest', metric: null, comparison: null }],
    ['К первому сравнению расходов.', read({ reference: 'первому сравнению расходов' }), { kind: 'ordinal', index: 1, metric: 'expenses', comparison: 'previous_same' }],
    ['К результату №12.', read({ reference: 'результату №12' }), { kind: 'ordinal', index: 12, metric: null, comparison: null }],
    ['К единственному сравнению доходов.', read({ reference: 'единственному сравнению доходов' }), { kind: 'unique', metric: 'income', comparison: 'previous_same' }],
  ] as const) assert.deepEqual(compileTaskIntent(intent, question).binding, expected);
  assert.equal(compileTaskIntent(read({ reference: 'доходы' }), 'доходы').status, 'clarification');
  assert.throws(() => parseTaskIntent({ ...byCategory, reference: { handle: 't1' } }, 'А по категориям?'));
});

test('new transport exposes only question/context-presence and carries a lossless closed schema in documented JSON mode', () => {
  const bound = { inputTokens: 131072, outputTokens: 1200, modelVersion: 'openai/gpt-oss-120b' };
  const input = { question: 'А по категориям?', hasFinancialTasks: true }, body = JSON.parse(intentRequestBody('cloud-oss', bound, taskIntentPrompt, input, taskIntentSchema));
  assert.deepEqual(JSON.parse(body.messages[1].content), input); assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(expandPromptSchema(factorPromptSchema(taskIntentSchema)), taskIntentSchema);
  assert.equal(body.max_completion_tokens, 1200); assert.equal(body.temperature, 0); assert.equal(body.stream, false);
  for (const patch of [{ tasks: [] }, { filter: {} }, { capabilities: {} }, { totalMinor: '1000' }, { expected: {} }]) assert.throws(() => intentRequestBody('cloud-oss', bound, taskIntentPrompt, { ...input, ...patch }, taskIntentSchema));
});

test('every metric/presentation/comparison combination preserves independent conditions and fixed selection across sparse intent changes', () => {
  const scope = { ownerId: 'intent-invariants', chatId: trialId(1000), chatEpoch: trialId(2), generation: trialId(3) };
  let checked = 0;
  for (const metric of ['expenses', 'income', 'attention'] as const) for (const grouping of ['none', 'category', 'operation'] as const) for (const comparison of ['none', 'previous_same'] as const) {
    const global = { revision: 0, touched: {}, filter: { from: '2026-09-01', through: '2026-09-30', amountFrom: '10000', amountThrough: '200000', amountBasis: 'absolute_operation' as const,
      categoryIds: [trialId(10)], operationIds: [trialId(30)], includeExcluded: false, refund: false } };
    const first = resolveTaskDecision(emptyTaskBook(scope), scope, global, { binding: { kind: 'new' }, metric: { op: 'set', value: metric }, grouping: { op: 'set', value: grouping }, comparison: { op: 'set', value: comparison }, edits: [] }, trialId(100));
    assert.equal(first.status, 'resolved'); if (first.status !== 'resolved') throw new Error();
    const book = acceptTaskResult(emptyTaskBook(scope), first);
    for (const [question, intent, changed] of [
      ['А по категориям?', byCategory, 'grouping'],
      ['А отдельные операции?', read({ grouping: m('operation', 'отдельные операции') }), 'grouping'],
      ['А одной суммой?', read({ grouping: m('none', 'одной суммой') }), 'grouping'],
      ['А за октябрь 2026 года?', read({ edits: [period('октябрь 2026 года')] }), 'period'],
      ['А без ограничения по сумме?', read({ edits: [{ field: 'amount', op: 'clear', quote: 'без ограничения по сумме' }] }), 'amount'],
      ['А без сравнения?', read({ comparison: m('none', 'без сравнения') }), 'comparison'],
      ['А только такси?', read({ edits: [category('такси')] }), 'categories'],
    ] as const) {
      const prepared = prepareTaskProposal(compileTaskIntent(intent, question), question, book, scope, global, trialId(101), '2026-10-15', trialCatalog);
      assert.equal(prepared.status, 'query'); if (prepared.status !== 'query') throw new Error();
      const next = resolveTaskDecision(book, scope, global, prepared.decision, trialId(101)); assert.equal(next.status, 'resolved'); if (next.status !== 'resolved') throw new Error();
      assert.equal(next.inheritedFrom, trialId(100)); assert.equal(next.query.metric, metric); assert.deepEqual(next.query.filter.operationIds, global.filter.operationIds);
      if (changed !== 'grouping') assert.equal(next.query.grouping, grouping);
      if (changed !== 'comparison') assert.equal(next.query.comparison, comparison);
      if (changed !== 'period') { assert.equal(next.query.filter.from, global.filter.from); assert.equal(next.query.filter.through, global.filter.through); }
      if (changed !== 'amount') { assert.equal(next.query.filter.amountFrom, global.filter.amountFrom); assert.equal(next.query.filter.amountThrough, global.filter.amountThrough); assert.equal(next.query.filter.amountBasis, global.filter.amountBasis); }
      if (changed !== 'categories') assert.deepEqual(next.query.filter.categoryIds, global.filter.categoryIds);
      assert.equal(next.query.filter.refund, false); assert.equal(next.query.filter.includeExcluded, false); checked++;
    }
  }
  assert.equal(checked, 126);
});

test('a repeated metric in a connected follow-up preserves its compatible task; a self-contained new income starts with globals', () => {
  const intent = expenses('потратил');
  const connected = compileTaskIntent(intent, 'А сколько потратил?', '2026-10-15', ['expenses', 'income']);
  assert.deepEqual(connected.binding, { kind: 'nearest', metric: 'expenses', comparison: null });
  assert.deepEqual(compileTaskIntent(intent, 'Сколько потратил?', '2026-10-15', ['expenses']).binding, { kind: 'new' });
  assert.deepEqual(compileTaskIntent(income('доходы'), 'А доходы?', '2026-10-15', ['expenses']).binding, { kind: 'new' });
});
