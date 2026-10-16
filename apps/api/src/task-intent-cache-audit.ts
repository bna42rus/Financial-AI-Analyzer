import { isDeepStrictEqual } from 'node:util';
import { assertClosedSchema } from '../../../packages/analyzer/src/closed-schema.ts';
import { parseTaskIntent, compileTaskIntent, taskIntentSchema, taskIntentPrompt } from '../../../packages/analyzer/src/task-intent.ts';
import { parseTaskProposalWire } from '../../../packages/analyzer/src/task-protocol.ts';
import { object } from '../../../packages/finance-core/src/model.ts';
import { tokenCost, usageTokens } from '../../../packages/analyzer/src/cost.ts';
import { benchmarkDigest } from './benchmark-ledger.ts';
import { BenchmarkFailure, candidates } from './benchmark-transport.ts';
import { intentTaskModel } from './analyzer-intent-model.ts';
import { replayIntentTransport, intentRequestBody } from './task-intent-transport.ts';
import { evaluateTrialScenario, loadTrialCorpus, trialRequestId } from './task-trial.ts';
import type { TrialTurn, TrialScore } from './task-trial.ts';
import type { TaskModel } from './analyzer-task-workflow.ts';

export const observedIntentRun = {
  bindingSha256: '0167d21fd279fa1df5cac60df29fa86f6966a164f270dff5e636cf6cb0e1e4fa',
  frozenSha256: '767ac28da3b8811a700d5844de6ddb48b8814045434dc52f4bff482711896e34',
  ledgerHeadSha256: '9af593b96f72a742b2117ab34c403da8d62bbd601fe6ad65c6009fb042b8a568',
  turns: 88, passed: 46, rejected: 23, costAtoms: '4333490020',
} as const;
const fail = (code: string): never => { throw new BenchmarkFailure('INTENT_DIAGNOSTICS_' + code); };
const errorCode = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'UNKNOWN_VALIDATION_ERROR';
export const rubles = (atoms: string | bigint) => {
  const n = BigInt(atoms); return `${n / 1000000000n}.${(n % 1000000000n).toString().padStart(9, '0')}`;
};
type Issue = { stage: string; path: string; code: string; detail: string };

/** Explanations only. The original authoritative parser still decides acceptance. */
function schemaIssues(value: unknown, schema: any, path = '$'): Issue[] {
  try { assertClosedSchema(value, schema); return []; } catch { /* Explain this rejection below. */ }
  const issue = (detail: string): Issue[] => [{ stage: 'intent_schema', path, code: 'TASK_WIRE_INVALID', detail }];
  if (schema.anyOf) return schema.anyOf.map((s: unknown) => schemaIssues(value, s, path)).sort((a: Issue[], b: Issue[]) => a.length - b.length)[0];
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const r = value as Record<string, unknown>, issues: Issue[] = [];
    for (const k of schema.required ?? []) if (!Object.hasOwn(r, k)) issues.push(...schemaIssues(undefined, schema.properties[k], path + '.' + k));
    for (const k of Object.keys(r)) {
      if (!Object.hasOwn(schema.properties, k)) issues.push({ stage: 'intent_schema', path: path + '[' + JSON.stringify(k) + ']', code: 'TASK_WIRE_INVALID', detail: 'Лишнее поле в закрытой схеме.' });
      else issues.push(...schemaIssues(r[k], schema.properties[k], path + '.' + k));
    }
    return issues.length ? issues : issue('Нарушено ограничение объекта.');
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    const nested = value.flatMap((v, i) => schemaIssues(v, schema.items, path + '[' + i + ']'));
    return nested.length ? nested : issue('Нарушено ограничение длины или уникальности массива.');
  }
  return issue(schema.enum ? 'Допустимые значения: ' + JSON.stringify(schema.enum) : 'Ожидается ' + schema.type + '; нарушен тип, длина или диапазон.');
}

export function inspectIntent(value: unknown, question: string) {
  const issues = schemaIssues(value, taskIntentSchema);
  let code: string | null = null;
  try { parseTaskIntent(value, question); } catch (error) { code = errorCode(error); }
  if (!code) return { accepted: true, code, issues: [] as Issue[] };
  if (issues.length) return { accepted: false, code, issues };
  const v = value as Record<string, any>;
  for (const key of ['metric', 'grouping', 'comparison']) if (v[key]) {
    try { parseTaskIntent({ relevance: 'financial', action: 'read', [key]: v[key] }, question); }
    catch (error) { issues.push({ stage: 'evidence', path: '$.' + key, code: errorCode(error), detail: question.includes(v[key].quote) ? 'Цитата дословна, но проверка слов для этого значения её отвергла; семантику нужно оценить отдельно.' : 'Цитата не является дословной подстрокой вопроса.' }); }
  }
  if (v.reference && !question.includes(v.reference)) issues.push({ stage: 'evidence', path: '$.reference', code: 'TASK_EVIDENCE_MISSING', detail: 'Ссылка не является дословной подстрокой вопроса.' });
  const seen = new Set<string>();
  for (const [index, e] of (v.edits ?? []).entries()) {
    const path = '$.edits[' + index + ']';
    if (seen.has(e.field)) issues.push({ stage: 'field_contract', path, code: 'TASK_DUPLICATE_EDIT', detail: 'Одна группа условий изменена повторно.' });
    seen.add(e.field);
    try { parseTaskProposalWire({ status: 'query', binding: { kind: 'new' }, metric: { op: 'keep' }, grouping: { op: 'keep' }, comparison: { op: 'keep' }, edits: [e] }, question); }
    catch (error) {
      const c = errorCode(error);
      let detail = 'Нарушен обязательный контракт значения для группы ' + e.field + '.';
      if (c === 'TASK_EVIDENCE_MISSING') detail = !question.includes(e.quote) ? 'Цитата не является дословной подстрокой вопроса.' :
        ['period', 'postedPeriod'].includes(e.field) ? 'Значение периода не совпадает с дословной цитатой.' : e.field === 'amount' ? 'expression не совпадает с дословной цитатой.' : 'Имя не найдено в цитате как целое слово; склонение и нормализацию нужно оценить отдельно.';
      issues.push({ stage: 'field_contract', path, code: c, detail });
    }
  }
  if (!issues.length) issues.push({ stage: 'intent_contract', path: '$', code, detail: 'Несовместимое сочетание relevance/action/полей либо ограничение размера ответа.' });
  return { accepted: false, code, issues };
}

type Cached = { id: string; caseId: string; occurrence: number; question: string; wireSha256: string; usage: { inputTokens: number; outputTokens: number; modelVersion: string }; validationCode: string | null; value: unknown };
type Trace = { id: string; occurrence: number; question: string; expected: TrialTurn['expected']; raw: unknown; usage: Cached['usage']; costAtoms: string;
  inspection: ReturnType<typeof inspectIntent>; savedValidationCode: string | null; hasFinancialTasks?: boolean; tasks?: Parameters<TaskModel['proposal']>[0]['tasks'];
  compiled?: unknown; compilerCode?: string; score?: TrialScore; errorClass?: string; expectedParentFailed?: boolean };

/** No fetch/key/ledger/dispatch adapter is accepted. Rejected values remain
 * rejected; missing records never cause a model call or a golden-parent repair. */
export async function auditObservedIntentCache(value: unknown) {
  const root = object(value, ['audit', 'bindingSha256', 'frozenSha256', 'ledgerHeadSha256', 'paidCalls', 'records']);
  if (root.audit !== 'cashneuro-intent-cached-decisions/1' || root.bindingSha256 !== observedIntentRun.bindingSha256 || root.frozenSha256 !== observedIntentRun.frozenSha256 ||
      root.ledgerHeadSha256 !== observedIntentRun.ledgerHeadSha256 || root.paidCalls !== 0 || !Array.isArray(root.records) || root.records.length !== 88) return fail('EXPORT_INVALID');
  const records = new Map<string, Cached>();
  for (const raw of root.records) {
    const r = object(raw, ['id', 'caseId', 'occurrence', 'question', 'wireSha256', 'usage', 'validationCode', 'value']);
    if (typeof r.id !== 'string' || !/^[a-f0-9]{64}$/.test(r.id) || records.has(r.id) || typeof r.wireSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.wireSha256) ||
        r.validationCode !== null && !/^TASK_PILOT_PAYLOAD_INVALID\/gate\/(?:TASK_WIRE_INVALID|TASK_NAMES_INVALID|TASK_EVIDENCE_MISSING|TASK_DUPLICATE_EDIT|TASK_EMPTY_SET|REFLECTED_CREDENTIAL_DENIED|closed_contract)$/.test(String(r.validationCode))) return fail('EXPORT_INVALID');
    const u = object(r.usage, ['inputTokens', 'outputTokens', 'modelVersion']);
    usageTokens(u.inputTokens); usageTokens(u.outputTokens); if (u.modelVersion !== 'openai/gpt-oss-120b') return fail('USAGE_INVALID');
    records.set(r.id, r as Cached);
  }
  const { corpus } = await loadTrialCorpus(), bound = replayIntentTransport().bound, consumed = new Set<string>(), rows: Trace[] = [];
  const evaluate = async (turns: TrialTurn[], occurrence = 0) => {
    const scores = await evaluateTrialScenario(turns, (turn): TaskModel => {
      const id = trialRequestId(observedIntentRun.bindingSha256, turn.id, 'gate', occurrence), cached = records.get(id);
      if (!cached || cached.caseId !== turn.id || cached.occurrence !== occurrence || cached.question !== turn.question) return fail('SLOT_MISMATCH');
      const inspection = inspectIntent(cached.value, turn.question);
      // Compare the reproduced parser rejection with its historical capsule.
      const safeCode = inspection.code && ['TASK_WIRE_INVALID', 'TASK_NAMES_INVALID', 'TASK_EVIDENCE_MISSING', 'TASK_DUPLICATE_EDIT', 'TASK_EMPTY_SET', 'REFLECTED_CREDENTIAL_DENIED'].includes(inspection.code) ? inspection.code : 'closed_contract';
      if ((cached.validationCode !== null) === inspection.accepted || cached.validationCode && cached.validationCode !== 'TASK_PILOT_PAYLOAD_INVALID/gate/' + safeCode) return fail('PARSER_DRIFT');
      const trace: Trace = { id: turn.id, occurrence, question: turn.question, expected: turn.expected, raw: cached.value, usage: cached.usage,
        costAtoms: tokenCost(candidates['cloud-oss'].price, cached.usage.inputTokens, cached.usage.outputTokens).toString(), inspection, savedValidationCode: cached.validationCode };
      rows.push(trace);
      const model = intentTaskModel(async input => {
        trace.hasFinancialTasks = input.hasFinancialTasks;
        if (benchmarkDigest(intentRequestBody('cloud-oss', bound, taskIntentPrompt, input, taskIntentSchema)) !== cached.wireSha256) return fail('WIRE_CHANGED');
        consumed.add(id);
        return cached.validationCode ? {} : structuredClone(cached.value);
      });
      return { relevance: input => model.relevance(input), proposal: async input => {
        trace.tasks = input.tasks;
        try { trace.compiled = compileTaskIntent(cached.value, input.question, input.currentDate, input.tasks.map(t => t.metric)); }
        catch (error) { trace.compilerCode = errorCode(error); }
        return model.proposal(input);
      } };
    }, occurrence);
    for (const score of scores) {
      const trace = rows.find(r => r.id === score.id && r.occurrence === occurrence)!; trace.score = score;
      trace.expectedParentFailed = Boolean(trace.expected.parentTurnId && scores.find(s => s.id === trace.expected.parentTurnId)?.passed === false);
      trace.errorClass = score.passed ? 'PASS' : !trace.inspection.accepted ? 'VALIDATION_REJECTION' : !score.relevanceCorrect ? 'MODEL_RELEVANCE_MISMATCH' :
        trace.compilerCode ? 'COMPILER_REJECTION' : score.reason === 'task_missing' ? 'TASK_CONTEXT_UNRESOLVED' : 'RESULT_MISMATCH_REQUIRES_REVIEW';
    }
  };
  for (const turn of corpus.singles.filter(t => t.split === 'development')) await evaluate([turn]);
  for (const dialog of corpus.dialogs.filter(d => d.split === 'development')) await evaluate(dialog.turns);
  for (const repeat of corpus.repetitions) for (let occurrence = 1; occurrence <= repeat.additionalIndependentCopies; occurrence++) {
    const turn = corpus.singles.find(t => t.id === repeat.caseId)!;
    // Exactly the original budget-stopped prefix. No holdout or absent repeat is evaluated.
    if (rows.length < 88) await evaluate([turn], occurrence);
  }
  if (consumed.size !== records.size || rows.length !== 88) return fail('UNUSED_RECORDS');
  const failed = rows.filter(r => !r.score!.passed), count = (predicate: (r: Trace) => boolean) => rows.filter(predicate).length;
  const totalCostAtoms = rows.reduce((n, r) => n + BigInt(r.costAtoms), 0n).toString();
  return { audit: 'cashneuro-intent-readable-review/1', observed: observedIntentRun, exportSha256: benchmarkDigest(value), paidCalls: 0, httpCalls: 0,
    ledgerModified: false, holdoutOpened: false, historicalContractOnly: true, turns: rows.length, passed: count(r => r.score!.passed), rejected: count(r => !r.inspection.accepted),
    totalCostAtoms, tokens: { input: rows.reduce((n, r) => n + r.usage.inputTokens, 0), output: rows.reduce((n, r) => n + r.usage.outputTokens, 0) },
    failuresByCategory: Object.fromEntries([...new Set(failed.map(r => r.errorClass!))].map(c => [c, count(r => r.errorClass === c)])),
    earlierFailurePresent: count(r => !r.score!.passed && r.score!.earlierFailure), expectedParentFailed: count(r => !r.score!.passed && !!r.expectedParentFailed),
    repeatGroups: corpus.repetitions.map(g => {
      const copies = rows.filter(r => r.id === g.caseId);
      return { id: g.caseId, occurrences: copies.map(r => r.occurrence), passed: copies.map(r => r.score!.passed),
        semanticOutcomeVaries: copies.some(r => !isDeepStrictEqual({ status: r.score!.actualStatus, query: r.score!.actualQuery, reason: r.score!.reason }, { status: copies[0]!.score!.actualStatus, query: copies[0]!.score!.actualQuery, reason: copies[0]!.score!.reason })) };
    }), rows };
}

export function renderIntentAudit(report: Awaited<ReturnType<typeof auditObservedIntentCache>>, full = false) {
  const lines = ['CASHNEURO AI DIAGNOSTICS', 'Исторический прогон 15.10; это НЕ приёмка нового контракта AI-помощника.',
    `Всего: ${report.turns}; успешно: ${report.passed}; ошибок: ${report.turns - report.passed}; отклонено кодом: ${report.rejected}.`,
    `Токены исходного прогона: вход ${report.tokens.input}; выход ${report.tokens.output}; стоимость ${rubles(report.totalCostAtoms)} RUB.`,
    'Новые вызовы модели: 0. HTTP: 0. Журнал и резервы не изменены.',
    'Категории: ' + JSON.stringify(report.failuresByCategory),
    `Есть предыдущая ошибка: ${report.earlierFailurePresent}; ожидаемый родитель не прошёл: ${report.expectedParentFailed}. Это НЕ доказывает причинную связь.`,
    'Отказ валидатора подтверждает правило отказа, но не доказывает, что смысл ответа модели неверен.',
    'JSON: все выгруженные ответы уже разобраны как JSON; исходный HTTP-текст выгрузка не содержит.', 'EXPORT SHA256: ' + report.exportSha256, ''];
  for (const r of report.rows.filter(r => full || !r.score!.passed)) {
    const s = r.score!;
    lines.push(`CASE ${r.id}@${r.occurrence} | ${r.errorClass}`, 'ВОПРОС: ' + JSON.stringify(r.question),
      'ОЖИДАЛОСЬ: ' + JSON.stringify(r.expected), 'МОДЕЛЬ: ' + JSON.stringify(r.raw),
      'ПРОВЕРКА: ' + (r.inspection.accepted ? 'PASS' : r.inspection.code) + '; ' + (r.inspection.issues.map(i => `${i.stage} ${i.path} ${i.code}: ${i.detail}`).join(' | ') || 'без отказов парсера'),
      'КОМПИЛЯТОР: ' + (r.compilerCode ?? (r.compiled ? JSON.stringify(r.compiled) : 'не вызывался')),
      'ФАКТИЧЕСКИ: ' + JSON.stringify({ status: s.actualStatus, reason: s.reason, query: s.actualQuery, totalMinor: s.actualTotalMinor, wrongFields: Object.keys(s.planFields).filter(k => !s.planFields[k]), bindingCorrect: s.bindingCorrect, earlierFailure: s.earlierFailure, expectedParentFailed: r.expectedParentFailed }),
      'СЛЕДУЮЩАЯ ПРОВЕРКА: ' + (r.errorClass === 'PASS' ? 'Проверить, не совпал ли лишний параметр с текущим default случайно.' : r.errorClass === 'VALIDATION_REJECTION' ? 'Сопоставить показанные raw-поля с ожидаемым смыслом; отказ кода воспроизведён, виновник семантической ошибки ещё не установлен.' : r.errorClass === 'MODEL_RELEVANCE_MISMATCH' ? 'Принятый relevance отличается от исторического эталона; проверить сам эталон по новому согласованному контракту.' : r.compilerCode ? 'Изолированно воспроизвести указанный код в compileTaskIntent; не менять промпт до разбора.' : 'Сопоставить raw edits, выбранную связь и прежние задачи; не подменять отсутствующего родителя эталонным.'),
      `ТОКЕНЫ: ${r.usage.inputTokens}/${r.usage.outputTokens}; СТОИМОСТЬ: ${rubles(r.costAtoms)} RUB.`, '');
    if (full) lines.push('ПРЕДЫДУЩИЕ ЗАДАЧИ: ' + JSON.stringify(r.tasks ?? []), '');
  }
  return lines.join('\n');
}
