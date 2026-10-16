import { mkdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { object } from '../../../packages/finance-core/src/model.ts';
import type { Conversation } from '../../../packages/analyzer/src/assistant-conversation.ts';
import { AssistantError } from '../../../packages/analyzer/src/assistant-plan.ts';
import { tokenCost, rubAtoms } from '../../../packages/analyzer/src/cost.ts';
import { privateJson } from './kms.ts';
import { inspectCloudTaskModel } from './task-trial.ts';
import { assistantTrialManifest, assistantTrialCases, assistantTrialRequest, assistantTrialRequestId, assistantTrialServices, scoreAssistantTrial, seedAssistantReplay } from './assistant-trial.ts';
import { createCloudAssistantModel } from './assistant-transport.ts';
import { withAssistantJournal, readAssistantPrivateFile } from './assistant-journal.ts';
import { withAssistantBudget, assistantBudgetVersion, checkAssistantPermit, remainingAssistantTrialBudget } from './assistant-budget.ts';
import { runAssistant } from './assistant-workflow.ts';
import type { AssistantReply, CallReceipt } from './assistant-workflow.ts';

const directory = '/var/lib/cashneuro/analyzer-assistant-smoke-v3';
const previousDirectories = ['/var/lib/cashneuro/analyzer-assistant-smoke-v1', '/var/lib/cashneuro/analyzer-assistant-smoke-v2'];
async function priorBudget() {
  let previous: ReturnType<typeof remainingAssistantTrialBudget> | undefined;
  for (const path of previousDirectories) previous = remainingAssistantTrialBudget(await readAssistantPrivateFile(join(path, 'budget.json')), previous);
  return previous!;
}
const tariff = { version: 'cloud-20261016-oss120', currency: 'RUB' as const, inputRubPerMillion: '15.86', outputRubPerMillion: '61' };
const tariffCheckedAt = '2026-10-16T10:45:00Z';
const tariffSource = 'https://cloud.ru/products/evolution-ai-factory/catalog-foundation-models';
const money = (atoms: string) => { const n = BigInt(atoms); return (n / rubAtoms).toString() + '.' + (n % rubAtoms).toString().padStart(9, '0'); };
async function privateDirectory(path: string) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.uid !== 0 || s.mode & 0o022 || await realpath(path) !== path || path === directory && (s.mode & 0o777) !== 0o700) throw new AssistantError('ASSISTANT_TRIAL_DIRECTORY_INVALID');
}
async function report() {
  await privateDirectory(directory);
  const budget = await privateJson(join(directory, 'budget.json'));
  const savedPermit = checkAssistantPermit(budget.permit);
  if (savedPermit.previousBudgetSha256) console.log('Версия 3: расход двух прежних попыток вычтен из общего лимита 10 RUB; новый доступный лимит ' + money(savedPermit.capAtoms) + ' RUB.');
  let spent = 0n, held = 0n, input = 0, output = 0;
  for (const e of budget.entries as { bound: { inputTokens: number; outputTokens: number }; usage?: { inputTokens: number; outputTokens: number } }[]) {
    if (e.usage) { spent += tokenCost(savedPermit.price, e.usage.inputTokens, e.usage.outputTokens); input += e.usage.inputTokens; output += e.usage.outputTokens; }
    else held += tokenCost(savedPermit.price, e.bound.inputTokens, e.bound.outputTokens);
  }
  let complete = 0, passed = 0;
  console.log('CASHNEURO: новый помощник — синтетический development smoke, не приёмка продукта.');
  for (const [i, c] of assistantTrialCases.entries()) {
    let receipt;
    try { const saved = await readAssistantPrivateFile(join(directory, 'requests', assistantTrialRequestId(i) + '.json')); receipt = saved.receipt as { result?: AssistantReply; conversation?: Conversation; calls?: CallReceipt[]; replayedCalls?: number }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { console.log('НЕ ВЫПОЛНЕН ' + c.id); continue; } throw e; }
    if (!receipt.result || !receipt.conversation) { console.log('ПРЕРВАН ' + c.id + '; новых POST не будет.'); continue; }
    complete++; const score = scoreAssistantTrial(c, receipt.result, receipt.conversation); passed += Number(score.passed);
    console.log((score.passed ? 'PASS ' : 'FAIL ') + c.id + ' | ' + receipt.result.code + ' | новые вызовы ' + (receipt.result.modelCalls - (receipt.replayedCalls ?? 0)) + '; из архива ' + (receipt.replayedCalls ?? 0));
    if (!score.passed) { console.log('  Вопрос: ' + c.question); console.log('  Поля: ' + score.failures.join(', ')); console.log('  Ожидалось: ' + JSON.stringify(c.expected)); console.log('  Получено: ' + JSON.stringify({ status: receipt.result.status, code: receipt.result.code, query: receipt.result.query, text: receipt.result.text })); }
    if (!score.passed || receipt.result.status === 'answer') {
      for (const call of receipt.calls ?? []) console.log('  Модель: ' + JSON.stringify({ phase: call.phase, state: call.state, code: call.code, value: call.value }));
      if (receipt.result.status === 'answer') console.log('  Текст для смысловой оценки: ' + receipt.result.text);
    }
  }
  console.log('Сохранено ' + complete + '/20; проверку структуры/результата прошли ' + passed + '. Первые пять — старые ответы с новым компилятором, не новые замеры модели. Текст объяснений требует смысловой оценки.');
  console.log('Токены ' + input + '/' + output + '; расход ' + money(spent.toString()) + ' RUB; резерв ' + money(held.toString()) + ' RUB.');
  console.log('Новых вызовов при отчёте: 0. Исторический журнал не открывался. Runtime AI не включён.');
  console.log('Подробные квитанции и ответы: ' + join(directory, 'requests') + ' (0600, только синтетика).');
}
async function main() {
  const args = process.argv.slice(2), action = args[0];
  if (!['--prepare', '--inspect', '--live', '--report'].includes(action ?? '') || args.length !== (action === '--live' ? 2 : 1) || action === '--live' && args[1] !== '--within-original-cap-rub=10') throw new AssistantError('ASSISTANT_TRIAL_ARGUMENTS_INVALID');
  const manifest = await assistantTrialManifest();
  if (action === '--prepare') { console.log(JSON.stringify({ ...manifest, source: undefined, tariff, tariffCheckedAt, tariffSource, paidCalls: 0 }, null, 2)); return; }
  if (process.getuid?.() !== 0) throw new AssistantError('ASSISTANT_TRIAL_ROOT_REQUIRED');
  for (const p of ['/var/lib', '/var/lib/cashneuro']) await privateDirectory(p);
  if (action === '--report') return report();
  if (action === '--live') {
    // Repeating the operator block is report-only, even after a partial run.
    try { await lstat(join(directory, 'budget.json')); return report(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const age = Date.now() - Date.parse(tariffCheckedAt);
    if (age < 0 || age > 86400000) throw new AssistantError('ASSISTANT_TARIFF_STALE');
  }
  const keys = object(await privateJson('/etc/cashneuro/ai/benchmark/provider-keys.json'), ['cloud', 'yandex']);
  const provider = await inspectCloudTaskModel(keys.cloud, fetch);
  if (action === '--inspect') { console.log(JSON.stringify({ ...manifest, source: undefined, provider, tariff, tariffCheckedAt, tariffSource, paidCalls: 0 }, null, 2)); return; }
  if (provider.numericMetadata.context_length !== 131072 || provider.numericMetadata.max_model_len !== 131072) throw new AssistantError('ASSISTANT_PROVIDER_METADATA_CHANGED');
  const previous = await priorBudget();
  try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  await privateDirectory(directory);
  const requests = join(directory, 'requests'); try { await mkdir(requests, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const parent = await open('/var/lib/cashneuro', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
  const model = createCloudAssistantModel(keys.cloud, fetch), states = new Map<string, Conversation>(); let failures = 0;
  await withAssistantBudget(directory, { version: assistantBudgetVersion, sourceSha256: manifest.sourceSha256, metadataSha256: provider.modelMetadataSha256,
    tariffCheckedAt, tariffSource, price: tariff, bound: model.bound, capAtoms: previous.capAtoms, maximumCalls: previous.maximumCalls, previousBudgetSha256: previous.previousBudgetSha256 }, async (accounting, totals) => {
    const monitored = { settle: accounting.settle, async reserve(requestId: string, index: number, bound: typeof model.bound) {
      if ((await priorBudget()).previousBudgetSha256 !== previous.previousBudgetSha256) throw new AssistantError('ASSISTANT_PREVIOUS_BUDGET_CHANGED');
      return accounting.reserve(requestId, index, bound);
    } };
    for (const [i, c] of assistantTrialCases.entries()) {
      const r = assistantTrialRequest(c, i, states.get(c.scenario));
      const reply = await withAssistantJournal(requests, r, monitored, async j => {
        if (i < 5) {
          seedAssistantReplay(j, await readAssistantPrivateFile(join(previousDirectories[1]!, 'requests', r.requestId + '.json')), r);
          await j.persist(); console.log('REUSE ' + c.id + ': сохранённый ответ, новый POST не нужен.');
        }
        return runAssistant(r, model, j, assistantTrialServices(r, c, state => states.set(c.scenario, state)));
      });
      const score = scoreAssistantTrial(c, reply, states.get(c.scenario)!); failures += Number(!score.passed);
      console.log((score.passed ? 'PASS ' : 'FAIL ') + c.id + '; вызовы ' + totals().calls + '; расход ' + money(totals().spentAtoms) + ' RUB.');
      if (reply.status === 'error' || failures >= 3 || totals().blocked) { console.log('Остановка: требуется разбор сохранённых ответов. Автоматического нового прогона не будет.'); break; }
    }
  });
  await report();
}
main().catch(error => { console.error(error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'ASSISTANT_TRIAL_FAILED'); process.exitCode = 1; });
