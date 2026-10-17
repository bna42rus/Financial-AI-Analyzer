import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChildProcess } from 'node:child_process';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { PoolClient } from 'pg';
import { postgresFixture } from './postgres.ts';
import { syntheticOperations } from './operations-fixture.ts';
import { createServer } from '../src/server.ts';
import { createTestAssistantProvider } from '../src/analyzer-assistant-provider.ts';
import { assistantVersion } from '../../../packages/analyzer/src/assistant-plan.ts';
import { prepareFinance, financeView, acceptAccount, importEpoch } from '../src/finance.ts';
import { token, hashPassword } from '../src/crypto.ts';
import type { Config } from '../src/types.ts';
import { syntheticCsv, syntheticXlsx } from '../../../packages/imports/test/tabular-fixtures.ts';
import { syntheticPdf } from '../../../packages/imports/test/synthetic-pdf.ts';
import { syntheticLayout } from '../../../packages/imports/test/synthetic-layout.ts';
import {runClassificationStage} from '../src/classification-store.ts';
import type {AssistantProvider} from '../src/analyzer-assistant-provider.ts';
import {initialSemantics} from '../../../packages/finance-core/src/model.ts';
import { runImportStage } from '../src/import-ingestion.ts';

const expect = playwrightExpect.configure({ timeout: 20000 });
const web = 'http://127.0.0.1:5185', api = 'http://127.0.0.1:3035', password = 'Synthetic task browser password 123!';
let pg: Awaited<ReturnType<typeof postgresFixture>>, server: Awaited<ReturnType<typeof createServer>>, child: ChildProcess;
let calls = 0, blockNext = false;
let categoryProvider:AssistantProvider;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
let barrier = deferred(), reached = deferred();
const fetcher = (async (_url, options) => {
  const request = JSON.parse(String(options?.body)), input = JSON.parse(request.messages[1].content);
  calls++;
  if (blockNext) { blockNext = false; reached.resolve(); await barrier.promise; }
  if(input.operations){const cat=input.catalog.find((c:any)=>c.name==='Продукты'&&c.parent===null).ref;return new Response(JSON.stringify({model:'openai/gpt-oss-120b',usage:{prompt_tokens:500,completion_tokens:50,total_tokens:550},choices:[{finish_reason:'stop',message:{role:'assistant',tool_calls:[],content:JSON.stringify({decisions:input.operations.map((o:any)=>({ref:o.ref,category:cat,subcategory:null,confidence:96}))})}}]}));}
  const plan = input.candidate ?? { version: assistantVersion, topic: 'personal_finance', action: 'read',
    context: { mode: input.question.includes('сентябрь 2026') ? 'new' : 'continue' },
    changes: input.question.includes('сентябрь 2026') ? [{ field: 'metric', op: 'set', value: 'expenses' }, { field: 'period', op: 'set', value: 'сентябрь 2026' }] : [] };
  const value = input.candidate ? { plan, conditions: [] } : plan;
  return new Response(JSON.stringify({ model: 'openai/gpt-oss-120b', usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 },
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', tool_calls: [], content: JSON.stringify(value) } }] }));
}) as typeof fetch;
before(async () => {
  pg = await postgresFixture();
  const config: Config = { profile: 'finance', pool: pg.finance, baseURL: api, origin: web, authSecret: token(), wrappingKey: randomBytes(32), environment: 'test',
    assistantProvider: createTestAssistantProvider(pg.finance, fetcher, { projectId: 'test/task-browser', projectPeriodStart: '2020-01-01T00:00:00Z', projectPeriodEnd: '2100-01-01T00:00:00Z', projectLimitRub: '45' }) };
  config.classificationEnabled=true;categoryProvider=config.assistantProvider!;
  server = await createServer(config); await server.app.listen(3035, '127.0.0.1');
  const cwd = new URL('../../../', import.meta.url), env = { ...process.env, VITE_API_ORIGIN: api };
  if(process.env.ASSISTANT_UI_ASSET_MODE==='built') {
    await promisify(execFile)(process.execPath, ['scripts/build-connected-web.mjs', 'finance', '0'.repeat(40)], { cwd, env, timeout:120000 });
    child = spawn('pnpm', ['--filter', '@finance/web', 'exec', 'vite', 'preview', '--port', '5185', '--strictPort'], {cwd,env,stdio:'ignore'});
  } else child = spawn('pnpm', ['--filter', '@finance/web', 'dev', '--port', '5185', '--strictPort'], {cwd,env,stdio:'ignore'});
  for (let i = 0; i < 100; i++) { try { if ((await fetch(web)).ok) return; } catch { /* startup */ } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Task UI did not start');
});
after(async () => { barrier.resolve(); child?.kill('SIGTERM'); await server?.close(); await pg?.close(); });
async function within<T>(fn: (db: PoolClient) => Promise<T>) {
  const db = await pg.finance.connect();
  try { await db.query('BEGIN'); await prepareFinance(db, 'task-browser'); const result = await fn(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
async function screen(page: Page, name: string) {
  const opener = page.getByRole('button', { name: 'Открыть экраны приложения' }), link = page.getByRole('link', { name, exact: true });
  await expect(opener.or(link).first()).toBeVisible();
  if (await opener.isVisible()) await opener.click();
  await link.click();
}
for (const mobile of [false, true]) test(`assistant HTTP UI: profile timezone, manual touches, lost ACK, cross-tab CAS, reload/cancel and confirmed deletion (${mobile ? 'mobile' : 'desktop'})`, { timeout: 180000 }, async () => {
  calls = 0; blockNext = false;
  await pg.owner.query('TRUNCATE identity.auth_user,identity.rate_limit,finance.workspace,commerce.access_cycle,commerce.ai_project_budget CASCADE');
  await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES('task-browser','Synthetic task browser','task-browser@example.test',true,now(),now())");
  await pg.owner.query("INSERT INTO identity.security_state(user_id,indefinite) VALUES('task-browser',true)");
  await pg.owner.query("INSERT INTO identity.auth_account(id,user_id,account_id,provider_id,password,created_at,updated_at) VALUES('task-browser-account','task-browser','task-browser','credential',$1,now(),now())", [await hashPassword(password)]);
  await within(async db => { const state = await financeView(db, 'task-browser'), account = randomUUID(); await acceptAccount(db, 'task-browser', importEpoch(state), { id: account, bankId: 'tbank', systemName: 'Synthetic task UI account', type: 'bank_account' }); const ids=await syntheticOperations(db, 'task-browser', 2, account, state.categories.find(c => c.name === 'Продукты' && c.parentId === null)!.id,'Пятёрочка');await db.query('UPDATE finance.transaction SET semantics=$3 WHERE user_id=$1 AND id=$2',['task-browser',ids[0],JSON.stringify(initialSemantics('purchase','Пятёрочка'))]); });
  await pg.owner.query("INSERT INTO commerce.access_cycle(user_id,anchor_at,timezone,calendar_months,extra_days,indefinite,quota_policy) VALUES('task-browser',clock_timestamp()-interval '1 day','Europe/Moscow',0,0,true,'{\"source\":\"override\",\"limit\":20}')");
  const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, locale: 'ru-RU', timezoneId: 'Pacific/Honolulu' }), page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(20000);
  const messages = () => pg.owner.query("SELECT id,answer FROM finance.analyzer_message WHERE user_id='task-browser' ORDER BY created_at,id").then(r => r.rows);
  async function send(text: string) { const field = page.getByLabel('Ваш финансовый вопрос', { exact: true }); await field.fill(text); await page.getByRole('button', { name: 'Отправить вопрос', exact: true }).click(); }
  async function count(n: number) { await expect.poll(async () => (await messages()).length).toBe(n); await expect(page.getByRole('button', { name: 'Отправить вопрос', exact: true })).toBeDisabled(); }
  async function idle() { await expect(page.getByRole('button', { name: 'Фильтры', exact: true })).toBeEnabled(); }
  try {
    await page.goto(web + '/#login'); await page.getByLabel('Почта', { exact: true }).fill('task-browser@example.test'); await page.getByLabel('Пароль', { exact: true }).fill(password); await page.getByRole('button', { name: 'Продолжить', exact: true }).click(); await screen(page, 'Анализатор'); await idle();
    await expect(page.getByText('Часовой пояс анализа: Pacific/Honolulu', { exact: true })).toBeVisible();
    assert.equal((await pg.owner.query("SELECT timezone FROM finance.assistant_profile WHERE user_id='task-browser'")).rows[0].timezone, 'Pacific/Honolulu');
    const categoryPanel=page.getByRole('region',{name:'Категории с помощью AI'});
    await categoryPanel.getByRole('button',{name:'Разобрать категории загруженных операций',exact:true}).click();
    await expect(categoryPanel.getByText('Подбираем категории… Назначения обновляются по мере обработки.')).toBeVisible();
    assert.equal(await runClassificationStage(pg.finance,categoryProvider),true);
    assert.equal(await runClassificationStage(pg.finance,categoryProvider),true);
    await expect(categoryPanel).toContainText('Обработано операций: 1.');
    assert.equal(calls,1);assert.equal((await pg.owner.query('SELECT count(*)::int AS n FROM commerce.analyzer_usage')).rows[0].n,0);calls=0;
    await page.getByRole('button', { name: 'Фильтры', exact: true }).click(); const filters = page.getByRole('dialog', { name: 'Фильтры Анализатора' });
    await filters.getByLabel('С даты', { exact: true }).fill('2026-10-01'); await filters.getByLabel('По дату', { exact: true }).fill('2026-10-31'); await filters.getByRole('button', { name: 'Готово', exact: true }).click(); await idle();
    await send('Сумма расходов, сентябрь 2026'); await count(1); await idle();
    assert.equal((await messages())[0]!.answer.result.totals.expenses, '24690');
    await expect(page.getByRole('log', { name: 'Сообщения диалога' })).toContainText('246,90 ₽'); assert.equal(calls, 2);

    // The Analyzer unmounts here. The enclosing workspace must retain A->B->A.
    await screen(page, 'Обзор'); const global = page.getByRole('group', { name: 'Общие фильтры' });
    await global.getByLabel('С даты', { exact: true }).fill('2026-10-02'); await global.getByLabel('С даты', { exact: true }).fill('2026-10-01'); await screen(page, 'Анализатор'); await idle();
    await send('Итог?'); await count(2); await idle();
    assert.equal((await messages())[1]!.answer.result.totals.expenses, '0'); assert.equal((await messages())[0]!.answer.result.totals.expenses, '24690'); assert.equal(calls, 4);

    // Lose only the browser ACK after a successful committed HTTP response.
    let lose = true; const attempts: unknown[] = [];
    await page.route('**/finance/analyzer-task', async route => {
      attempts.push(route.request().postDataJSON());
      if (lose) { lose = false; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); } else await route.continue();
    });
    await send('Итог?'); await expect(page.getByRole('button', { name: 'Повторить тот же вопрос', exact: true })).toBeVisible(); assert.equal(calls, 6);
    await page.getByRole('button', { name: 'Повторить тот же вопрос', exact: true }).click(); await count(3); await idle(); assert.equal(calls, 6); assert.deepEqual(attempts[0], attempts[1]); await page.unroute('**/finance/analyzer-task');

    const generation = (await within(db => prepareFinance(db, 'task-browser'))).generation;
    const snap = await context.request.post(api + '/finance/analyzer-context', { headers: { origin: web }, data: { generation } }); assert.equal(snap.status(), 200);
    const changed = await context.request.post(api + '/finance/analyzer-context', { headers: { origin: web }, data: { generation, change: { id: randomUUID(), revision: (await snap.json()).revision, filter: {}, touched: ['period'] } } }); assert.equal(changed.status(), 200);
    await send('Итог?'); await expect(page.getByRole('alert')).toContainText('Общие фильтры изменились'); assert.equal(calls, 6); assert.equal((await messages()).length, 3);
    await send('Итог?'); await count(4); await idle(); assert.equal(calls, 8);

    // Reload while the real HTTP handler waits on a synthetic provider. The
    // recovered request can be cancelled without completing or charging a unit.
    blockNext = true; barrier = deferred(); reached = deferred(); await send('Итог?'); await reached.promise;
    await page.reload(); await screen(page, 'Анализатор'); await expect(page.getByRole('button', { name: 'Повторить тот же вопрос', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Отменить вопрос', exact: true }).click(); await expect(page.getByRole('button', { name: 'Отменить вопрос', exact: true })).toHaveCount(0); await idle(); barrier.resolve();
    await expect.poll(async () => (await pg.owner.query("SELECT count(*) AS n FROM commerce.ai_cost_reservation WHERE state='reserved'")).rows[0].n).toBe('0'); assert.equal((await messages()).length, 4);

    // Deletion must require confirmation and discard a recovered pending UI
    // request as well as its server book/cache. A late provider cannot revive it.
    blockNext = true; barrier = deferred(); reached = deferred(); await send('Итог?'); await reached.promise;
    await page.reload(); await screen(page, 'Анализатор'); await expect(page.getByRole('button', { name: 'Повторить тот же вопрос', exact: true })).toBeVisible();
    if (mobile) await page.getByRole('button', { name: 'Диалоги', exact: true }).click();
    await page.getByRole('button', { name: /^Настроить диалог:/ }).filter({ visible: true }).click(); const management = page.getByRole('dialog', { name: 'Настройки диалога' });
    await management.getByRole('button', { name: 'Удалить диалог', exact: true }).click(); assert.equal((await messages()).length, 4);
    await management.getByRole('button', { name: 'Подтвердить удаление диалога', exact: true }).click(); await expect(management).toHaveCount(0); await idle(); barrier.resolve();
    await expect(page.getByRole('button', { name: 'Повторить тот же вопрос', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Отменить вопрос', exact: true })).toHaveCount(0);
    for(const table of ['assistant_conversation','assistant_run'])assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.'+table)).rows[0].n,'0');
    assert.equal((await messages()).length, 0); await page.getByLabel('Ваш финансовый вопрос', { exact: true }).fill('Новый вопрос'); await expect(page.getByRole('button', { name: 'Отправить вопрос', exact: true })).toBeEnabled();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage)), []); assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), ['finance-interface-epoch-v1']);

    // Exercise the shipped bundle's file picker, lazy PDF/CSV/XLSX parsers,
    // actual PostgreSQL acceptance and worker, rather than a dev-only import.
    const prepared: string[] = [];
    page.on('request', request => { if(request.url().endsWith('/finance/import-accept'))prepared.push(request.postData()??''); });
    await page.getByRole('button', {name:'Загрузить файлы',exact:true}).click();
    await page.getByLabel('Файлы выписок').setInputFiles([
      {name:'Private.csv',mimeType:'text/csv',buffer:Buffer.from(syntheticCsv)},
      {name:'Private.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(syntheticXlsx())},
      {name:'Private.pdf',mimeType:'application/pdf',buffer:Buffer.from(syntheticPdf(syntheticLayout('tbank')))}
    ]);
    await expect(page.getByText('Загрузка принята сервером. Результат сохранён в истории загрузок.')).toBeVisible({timeout:30000});
    assert.equal(prepared.length,1);
    for(const secret of ['Private','%PDF','00000000000000000001','filename'])assert.equal(prepared[0]!.includes(secret),false);
    assert.equal((await pg.owner.query("SELECT count(*) AS n FROM finance.ingestion_batch WHERE user_id='task-browser'")).rows[0].n,'1');
    for(let i=0;i<15;i++) {
      if(!(await pg.owner.query("SELECT 1 FROM finance.ingestion_dispatch WHERE user_id='task-browser'")).rowCount)break;
      assert.equal(await runImportStage(pg.finance),true);
    }
    assert.equal((await pg.owner.query("SELECT count(*) AS n FROM finance.ingestion_dispatch WHERE user_id='task-browser'")).rows[0].n,'0');
    assert.ok(Number((await pg.owner.query("SELECT count(*) AS n FROM finance.transaction WHERE user_id='task-browser'")).rows[0].n)>2);
    await page.getByRole('button',{name:'Закрыть',exact:true}).click();
    assert.deepEqual(errors,[]);

  } finally { barrier.resolve(); await context.close(); await browser.close(); }
});
