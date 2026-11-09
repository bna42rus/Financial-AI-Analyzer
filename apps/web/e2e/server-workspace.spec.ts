import {chooseOption} from './choice-picker';
import {calculateOverview,defaultOverview} from '../../../packages/finance-core/src/overview';
// Synthetic HTTP responses exercise the connected UI. Real PostgreSQL/HTTP authorization
// and durable writes are covered separately by apps/api/test/browser.test.ts in CI.
import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import {createServer} from 'vite';
import type {ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {queryOperations,parseOperationsQuery} from '../../../packages/finance-core/src/operations';
import {aggregate} from '../../../packages/finance-core/src/graph';
import type {Filter} from '../../../packages/finance-core/src/graph';
import {syntheticDetail,syntheticPreview} from '../test/synthetic-finance';
import type {FinanceState} from '../src/finance-client';
let server:ViteDevServer,base:string;
test.beforeAll(async()=>{server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),cacheDir:fileURLToPath(new URL('../node_modules/.vite-connected-'+process.pid,import.meta.url)),server:{host:'127.0.0.1',port:0,strictPort:false},define:{'import.meta.env.VITE_API_ORIGIN':JSON.stringify('http://127.0.0.1:3000')}});await server.listen();base=server.resolvedUrls!.local[0]!;});
test.afterAll(async()=>{await server?.close();});
async function setup(page:Page,empty=false,duringInitialLoad?:()=>Promise<void>){await page.clock.setFixedTime(new Date('2026-09-20T12:00:00Z'));const detail=syntheticDetail(),state:FinanceState={generation:detail.generation,revision:'1',loanMode:'cashflow',accounts:[{id:detail.source.accountId,name:'Тестовый счёт',bankId:'tbank',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],mergedAccounts:[],categories:[],counterparties:[{id:crypto.randomUUID(),name:'Тестовый контрагент',state:'registered'},{id:crypto.randomUUID(),name:'Игнорируемый контрагент',state:'ignored'}],rules:[],operations:empty?[]:[{...detail.projection,classification:detail.semantics,comment:''}],summary:aggregate(empty?[]:[detail.projection])},calls:{path:string;body:Record<string,unknown>}[]=[],previews=new Map<string,Record<string,unknown>>();let blocked=false,lostCommit=false,commitAttempts=0,summaryWaiting=false,releaseSummary!:()=>void;const summaryGate=new Promise<void>(resolve=>{releaseSummary=resolve;});
 await page.route('http://127.0.0.1:3000/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname,body=req.postDataJSON()??{};calls.push({path,body});const headers={'Access-Control-Allow-Origin':req.headers().origin??new URL(base).origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};if(req.method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}let result:unknown={},status=200;
 if(path==='/session')result={name:'Искусственный пользователь',scope:blocked?'restricted':'active',capabilities:['finance'],indefinite:true,timezone:'Pacific/Honolulu'};
 else if(path==='/access/tariffs')result={tariffs:[]};else if(path.startsWith('/access/')){result={code:'NOT_FOUND'};status=404;}
 else if(blocked&&path.startsWith('/finance/')){result={code:'FINANCE_ACCESS_REQUIRED'};status=403;}
 else if(path==='/finance/summary'){if(duringInitialLoad){summaryWaiting=true;await summaryGate;}result={...state,summary:aggregate(state.operations,body as Filter)};}
 else if(path==='/finance/analyzer-state')result={chats:[],quota:{available:false,limit:null,used:0,remaining:null,periodStart:null,resetAt:null,warning:null},providerAvailable:false,registryVersion:'analyzer/1'};
 else if(path==='/finance/profile')result={timezone:body.timezone??'Pacific/Honolulu'};
 else if(path==='/finance/overview-views')result={views:[]};
 else if(path==='/finance/overview')result={generation:state.generation,revision:state.revision,timezone:'Pacific/Honolulu',budgetOptions:[],...calculateOverview(state.operations,state,body.filter??{},body.widgets??defaultOverview().widgets)};
 else if(path==='/finance/operations-views')result={views:[]};
 else if(path==='/finance/operations-page'){const q=parseOperationsQuery(body.query??{}),r=queryOperations(state.operations,state,q),limit=body.displayLimit==='all'?Math.max(1,r.total):Number(body.displayLimit??body.limit??50),offset=Number(body.cursor?.offset??((Math.min(Number(body.page??1),Math.max(1,Math.ceil(r.total/limit)))-1)*limit));result={...r,operations:r.operations.slice(offset,offset+limit),generation:state.generation,revision:state.revision,workspaceTotal:state.operations.length,offset,nextCursor:offset+limit<r.total?{generation:state.generation,revision:state.revision,queryHash:'synthetic',offset:offset+limit}:null};}
 else if(path==='/finance/operations-selection'){const r=queryOperations(state.operations,state,parseOperationsQuery(body.query??{}));result={operationIds:r.operations.map(o=>o.id),reviewIds:r.operations.filter(o=>o.reviewReasons.length).map(o=>o.id),operations:state.operations.filter(o=>body.ids?.includes(o.id)),generation:state.generation,revision:state.revision};}
 else if(path==='/finance/state')result=state;
 else if(path==='/finance/imports')result={batches:[],nextCursor:null};
 else if(path==='/finance/operation')result={...detail,revision:state.revision};
 else if(path==='/finance/history-query')result={actions:[],nextBeforeRevision:null};
 else if(path==='/finance/preview'){previews.set(String(body.actionId),body.intent);result=syntheticPreview(String(body.actionId),detail);}
 else if(path==='/finance/commit'){commitAttempts++;if(lostCommit&&commitAttempts===1){await route.abort('connectionreset');return;}const intent=previews.get(String(body.actionId));if(intent?.kind==='account'){const patch=intent.patch as Record<string,unknown>;Object.assign(state.accounts[0]!,patch);}else if(intent?.kind==='account_settings'){for(const change of intent.accounts as {id:string;patch:Record<string,unknown>}[]){const account=state.accounts.find(a=>a.id===change.id);if(account)Object.assign(account,change.patch);}}state.revision='2';result={status:'committed',actionId:body.actionId,generation:state.generation,revision:state.revision};}
 await route.fulfill({status,headers,contentType:'application/json',body:JSON.stringify(result)});
 });
 await page.goto(base);await expect(page.getByRole('navigation',{name:'Разделы сайта',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Обзор',exact:true})).toBeVisible();if(duringInitialLoad){await expect.poll(()=>summaryWaiting).toBe(true);try{await duringInitialLoad();}finally{releaseSummary();}}await expect(page.getByRole('status').filter({hasText:'Загружаем финансовые'})).toHaveCount(0,{timeout:duringInitialLoad?2000:5000});
 return {state,detail,calls,block:()=>{blocked=true;},loseCommit:()=>{lostCommit=true;}};
}
async function section(page:Page,title:string){await page.getByRole('link',{name:'Настройки',exact:true}).click();await page.getByRole('navigation',{name:'Подразделы настроек'}).getByRole('button',{name:new RegExp('^'+title)}).click();await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();}
test('live Review preserves a draft when selecting some similar operations',async({page})=>{
 const h=await setup(page),first=h.state.operations[0]!,similar=[1,2].map(()=>({...structuredClone(first),id:crypto.randomUUID()}));
 h.state.operations.push(...similar);const id=crypto.randomUUID(),category=crypto.randomUUID();
 h.state.categories.push({id:category,name:'Тестовая категория',parentId:null,role:'expense',hidden:false});
 const headers={'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'};
 await page.route('http://127.0.0.1:3000/finance/review-queue',async route=>{
  if(route.request().method()==='OPTIONS')return route.fallback();
  return route.fulfill({headers,json:{id,generation:h.state.generation,financeRevision:h.state.revision,revision:'1',remaining:3,anchor:first.id,operations:h.state.operations,similar:[first.id,...similar.map(o=>o.id)]}});
 });
 await page.getByRole('button',{name:'Обновить данные',exact:true}).click();
 await page.getByRole('link',{name:'Анализатор',exact:true}).click();
 await page.getByText('Проверка операций',{exact:true}).click();
 const review=page.getByRole('region',{name:'Нужно проверить',exact:true});
 await expect(review).toContainText('Осталось разобрать: 3');
 const future=review.getByRole('checkbox',{name:'Запомнить для будущих операций'});
 await expect(future).not.toBeChecked();
 const similarChoice=review.getByRole('checkbox',{name:'Применить к похожим операциям (2)'});
 await expect(similarChoice).not.toBeChecked();
 const [futureBox,similarBox]=await Promise.all([future.boundingBox(),similarChoice.boundingBox()]);
 expect(futureBox?.x).toBe(similarBox?.x);
 expect(futureBox!.y).toBeLessThan(similarBox!.y);
 await review.getByText('Другие поля',{exact:true}).click();
 for(const label of ['Тип операции','Финансовый смысл','Контрагент']){
  await review.getByRole('button',{name:label,exact:true}).click();
  await expect(page.getByRole('dialog',{name:label,exact:true}).getByRole('searchbox')).toBeVisible();
  await page.keyboard.press('Escape');
 }
 await review.getByRole('button',{name:'Категория',exact:true}).click();
 await page.getByRole('radio',{name:'Тестовая категория',exact:true}).click();
 await review.getByRole('checkbox',{name:'Применить к похожим операциям (2)'}).check();
 await expect(review.getByText('Выбрано: 0/2')).toBeVisible();
 await expect(review.getByRole('button',{name:'Применить',exact:true})).toBeDisabled();
 await review.getByRole('list').getByRole('checkbox').first().check();
 await expect(review.getByRole('button',{name:'Категория',exact:true})).toHaveText('Тестовая категория');
 await review.getByRole('button',{name:'Применить',exact:true}).click();
 await expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
 await page.getByRole('dialog',{name:'Решение при проверке'}).getByRole('button',{name:'Сохранить',exact:true}).click();
 await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/commit').length).toBe(1);
 expect(h.calls.find(c=>c.path==='/finance/preview')?.body.intent).toMatchObject({operationIds:[first.id,similar[0]!.id],patch:{categoryId:category},reviewScope:{sessionId:id,revision:'1',anchorId:first.id}});
});
test('bulk preview works on the first finance response without another navigation or polling refresh',async({page})=>{
 const h=await setup(page,false,async()=>{await page.getByRole('link',{name:'Операции',exact:true}).click();});await page.getByLabel('Выбрать операцию 1',{exact:true}).check();await page.getByRole('button',{name:'Изменить выбранные',exact:true}).click();await chooseOption(page.getByLabel('Действие с операциями',{exact:true}),'comment');await page.getByLabel('Новый комментарий',{exact:true}).fill('Synthetic first-load decision');await page.getByRole('button',{name:'Применить',exact:true}).click();await expect(page.getByRole('dialog',{name:'Подтвердить правку операций'}).getByRole('button',{name:'Сохранить',exact:true})).toBeVisible({timeout:2000});expect(h.calls.filter(c=>c.path==='/finance/preview')).toHaveLength(1);expect(h.calls.filter(c=>c.path==='/finance/preview')[0]!.body.intent).toMatchObject({operationIds:[h.detail.id],patch:{comment:'Synthetic first-load decision'}});
});
test('fixed bulk selection supports ranges, exact count and preview cancellation without adding a new matching row',async({page})=>{
 const h=await setup(page),first=h.state.operations[0]!;h.state.operations=[1,2,3].map(i=>({...structuredClone(first),id:crypto.randomUUID(),classification:{...structuredClone(first.classification),merchant:{...first.classification.merchant,value:'Тестовая покупка '+i}}}));h.state.categories=[{id:crypto.randomUUID(),name:'Тестовая категория',role:'expense',parentId:null,hidden:false}];let intent:Record<string,unknown>|null=null;
 await page.route('http://127.0.0.1:3000/finance/preview',async route=>{if(route.request().method()==='OPTIONS'){await route.fallback();return;}const b=route.request().postDataJSON(),i=b.intent;intent=i;const summary=aggregate(h.state.operations);await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{status:'previewed',actionId:b.actionId,impact:{before:summary,after:summary,affectedOperationIds:i.operationIds,dependencyConflicts:[],changes:i.operationIds.map((id:string)=>({id,kind:'operation',before:{values:{semantics:{category:{value:null}}}},after:{values:{semantics:{category:{value:i.patch.categoryId}}}}})),details:{kind:'bulk_operations',operationIds:i.operationIds,selectedCount:i.operationIds.length,atomic:true,patch:i.patch,verify:[],remainingReviewIds:i.operationIds,warnings:[]}}}});});
 await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.getByRole('link',{name:'Операции',exact:true}).click();await expect(page.getByRole('list',{name:'Сохранённые операции'}).getByRole('button')).toHaveCount(3);await page.getByLabel('Выбрать операцию 1',{exact:true}).check();await page.getByLabel('Выбрать операцию 3',{exact:true}).click({modifiers:['Shift']});await expect(page.getByRole('status').filter({hasText:'Выбрано: 3'})).toBeVisible();await page.getByRole('button',{name:'Изменить выбранные',exact:true}).click();await chooseOption(page.getByLabel('Новая категория',{exact:true}),h.state.categories[0]!.id);await page.getByRole('button',{name:'Применить',exact:true}).click();const confirmation=page.getByRole('dialog',{name:'Подтвердить правку операций'});
 await expect(confirmation.getByLabel('Последствия изменения')).toContainText(/Затронутые операции\s*3/);
 await expect(confirmation.getByLabel('Последствия изменения').getByText('Подробнее',{exact:true})).toHaveCount(0);
 await confirmation.getByText('Подробнее',{exact:true}).click();
 await expect(confirmation.getByText('Без категории → Тестовая категория',{exact:true})).toHaveCount(3);
 const fixed=(intent as unknown as {operationIds:string[]}).operationIds;expect(fixed).toHaveLength(3);h.state.operations.push({...structuredClone(first),id:crypto.randomUUID()});expect((intent as unknown as {operationIds:string[]}).operationIds).toEqual(fixed);await page.getByRole('button',{name:'Назад',exact:true}).click();expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);await expect(page.getByRole('region',{name:'Массовая правка'})).toBeVisible();
});
test('a stale bulk draft shows current values and needs an explicit fresh decision before another preview',async({page})=>{
 const h=await setup(page);await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByLabel('Выбрать операцию 1',{exact:true}).check();await page.getByRole('button',{name:'Изменить выбранные',exact:true}).click();await chooseOption(page.getByLabel('Действие с операциями',{exact:true}),'comment');await page.getByLabel('Новый комментарий',{exact:true}).fill('Моё решение');h.state.revision='2';h.state.operations[0]!.comment='Другое устройство';await page.evaluate(()=>document.querySelector<HTMLButtonElement>('button[aria-label="Обновить данные"]')!.click());await expect(page.getByRole('button',{name:'Применить',exact:true})).toBeDisabled();await page.getByText('Текущие и прежние значения',{exact:true}).click();await expect(page.getByRole('region',{name:'Изменённые значения выборки'})).toContainText('Другое устройство');await page.getByRole('button',{name:'Использовать моё решение с текущими данными'}).click();await page.getByRole('button',{name:'Применить',exact:true}).click();expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.revision).toBe('2');expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toMatchObject({operationIds:[h.detail.id],patch:{comment:'Моё решение'}});
});
test('Review skip persists across reload and refresh starts from the first unresolved operation',async({page})=>{
 const h=await setup(page),first=h.state.operations[0]!,second={...structuredClone(first),id:crypto.randomUUID(),classification:{...first.classification,merchant:{...first.classification.merchant,value:'Второй магазин'}}};h.state.operations.push(second);
 const id=crypto.randomUUID();let anchor=first.id,revision=1;
 await page.route('http://127.0.0.1:3000/finance/review-queue',async route=>{
  if(route.request().method()==='OPTIONS')return route.fallback();
  const b=route.request().postDataJSON();if(b.skip===anchor){expect(b.revision).toBe(String(revision));anchor=second.id;revision++;}
  if(b.refresh){anchor=first.id;revision++;}
  return route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{id,generation:h.state.generation,financeRevision:h.state.revision,revision:String(revision),remaining:2,anchor,operations:h.state.operations,similar:[]}});
 });
 await page.getByRole('link',{name:'Анализатор',exact:true}).click();await page.getByText('Проверка операций',{exact:true}).click();
 await page.getByRole('button',{name:'Пропустить',exact:true}).click();await expect(page.getByRole('region',{name:'Нужно проверить'})).toContainText('Второй магазин');
 await page.reload();await page.getByText('Проверка операций',{exact:true}).click();
 await expect(page.getByRole('region',{name:'Нужно проверить'})).toContainText('Второй магазин');
 await page.getByRole('button',{name:'Обновить список проверки',exact:true}).click();
 await expect(page.getByRole('region',{name:'Нужно проверить'})).not.toContainText('Второй магазин');
});
test('a delayed Review response cannot restore financial context after access is revoked',async({page})=>{
 const h=await setup(page);let release!:()=>void,started!:()=>void,finished!:()=>void;const gate=new Promise<void>(r=>{release=r;}),seen=new Promise<void>(r=>{started=r;}),delivered=new Promise<void>(r=>{finished=r;});await page.route('http://127.0.0.1:3000/finance/review-queue',async route=>{if(route.request().method()==='OPTIONS'){await route.fallback();return;}started();await gate;try{await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{generation:h.state.generation,sessions:[]}});}catch{}finally{finished();}});await page.getByRole('link',{name:'Анализатор',exact:true}).click();await page.getByText('Проверка операций',{exact:true}).click();await seen;h.block();try{await page.getByRole('button',{name:'Обновить данные',exact:true}).click({timeout:1000}).catch(async e=>{if(!await page.getByRole('heading',{name:'Аккаунт',exact:true}).isVisible())throw e;});await expect(page.getByRole('heading',{name:'Аккаунт',exact:true})).toBeVisible();}finally{release();}await delivered;await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await expect(page.getByRole('region',{name:'Нужно проверить'})).toHaveCount(0);await expect(page.getByRole('navigation',{name:'Разделы сайта'})).toHaveCount(0);
});
test('navigation during the initial finance read keeps its response and shows operations without waiting for the polling timer',async({page})=>{const h=await setup(page,false,async()=>{await expect(page.getByRole('status').filter({hasText:'Загружаем финансовые'})).toBeVisible();await page.getByRole('link',{name:'Операции',exact:true}).click();await expect(page.getByRole('heading',{name:'Операции',exact:true})).toBeVisible();});await expect(page.getByRole('list',{name:'Сохранённые операции'}).getByRole('button')).toHaveCount(1);expect(h.calls.filter(c=>c.path==='/finance/summary'&&'compact' in c.body)).toHaveLength(1);await page.getByLabel('С даты',{exact:true}).fill('2026-01-01');await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/summary'&&c.body.from==='2026-01-01').length).toBe(1);});
test('a delayed operation response cannot reopen its card after navigating to settings',async({page})=>{await setup(page);let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),requestStarted=new Promise<void>(resolve=>{started=resolve;});await page.route('http://127.0.0.1:3000/finance/operation',async route=>{started();await gate;await route.fallback();});await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByRole('list',{name:'Сохранённые операции'}).getByRole('button').click();await requestStarted;await page.getByRole('link',{name:'Настройки',exact:true}).click();const finished=page.waitForEvent('requestfinished',{predicate:r=>r.url().endsWith('/finance/operation')});release();await finished;await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await expect(page.getByRole('heading',{name:'Настройки',exact:true})).toBeVisible();await expect(page.getByRole('dialog',{name:'Операция'})).toHaveCount(0);});
test('a delayed operation response from before a financial reset cannot restore its old card',async({page})=>{const h=await setup(page);let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),requestStarted=new Promise<void>(resolve=>{started=resolve;});await page.route('http://127.0.0.1:3000/finance/operation',async route=>{started();await gate;await route.fallback();});await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByRole('list',{name:'Сохранённые операции'}).getByRole('button').click();await requestStarted;h.state.generation=crypto.randomUUID();h.state.operations=[];h.state.accounts=[];await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await expect(page.getByRole('heading',{name:'Здесь будут ваши операции'})).toBeVisible();const finished=page.waitForEvent('requestfinished',{predicate:r=>r.url().endsWith('/finance/operation')});release();await finished;await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await expect(page.getByRole('heading',{name:'Здесь будут ваши операции'})).toBeVisible();await expect(page.getByRole('dialog',{name:'Операция'})).toHaveCount(0);});
test('connected navigation includes all four screens and all ten settings sections with explicit pending states',async({page},info)=>{await setup(page);for(const n of ['Обзор','Операции','Анализатор','Настройки']){await page.getByRole('navigation',{name:'Разделы сайта'}).getByRole('link',{name:n,exact:true}).click();await expect(page.getByRole('heading',{name:n,exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);}for(const n of ['Счета','Загрузки','Категории','Правила','Контрагенты','Бюджеты','Аналитика','Интерфейс','Конфиденциальность','История']){await section(page,n);await expect(page.getByRole('region',{name:'Настройки сайта',exact:true})).toHaveCount(1);await expect(page.getByRole('navigation',{name:'Подразделы настроек',exact:true,includeHidden:true})).toHaveCount(1);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);}await section(page,'Контрагенты');await expect(page.getByText('Тестовый контрагент',{exact:true})).toBeVisible();await expect(page.getByText('Игнорируемый контрагент',{exact:true})).toBeHidden();await page.getByText('Игнорируемые · 1',{exact:true}).click();await expect(page.getByText('Игнорируемый контрагент',{exact:true})).toBeVisible();await section(page,'Интерфейс');await chooseOption(page.getByLabel('Тема',{exact:true}),'dark');await chooseOption(page.getByLabel('Размер текста',{exact:true}),'large');await page.getByRole('button',{name:'Применить',exact:true}).click();await page.screenshot({path:info.outputPath('connected-settings.png'),fullPage:true});await page.reload();await expect(page.getByRole('navigation',{name:'Разделы сайта',exact:true})).toBeVisible();await expect(page.getByLabel('Тема',{exact:true})).toHaveAttribute('value','dark');expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('finance-appearance-v1')!))).toEqual({theme:'dark',density:'comfortable',textSize:'large',motion:'system'});await page.getByRole('button',{name:'По умолчанию',exact:true}).click();await page.getByRole('button',{name:'Применить',exact:true}).click();await expect.poll(()=>page.evaluate(()=>localStorage.getItem('finance-appearance-v1'))).toBeNull();});
test('closed global filters use server-selected operation IDs and never show old totals for a new period',async({page},info)=>{const h=await setup(page);await page.getByLabel('По дату',{exact:true}).fill('2026-10-31');await page.getByLabel('С даты',{exact:true}).fill('2026-10-01');await expect(page.getByRole('region',{name:'Основные показатели'})).toContainText('0 ₽');await page.getByRole('link',{name:'Операции',exact:true}).click();await expect(page.getByText('Нет операций по выбранным фильтрам',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Изменить период',exact:true}).click();await expect(page.getByLabel('С даты',{exact:true})).toBeFocused();await page.getByRole('button',{name:'Сбросить',exact:true}).click();await expect(page.getByRole('list',{name:'Сохранённые операции'}).getByRole('button')).toHaveCount(1);await page.getByRole('button',{name:'Банки и счета',exact:true}).click();await page.getByRole('dialog',{name:'Выбор банков и счетов',exact:true}).getByRole('checkbox').last().check();await page.keyboard.press('Escape');await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/summary').at(-1)?.body.accountIds).toEqual([h.detail.source.accountId]);await page.getByRole('link',{name:'Обзор',exact:true}).click();await page.getByText('Как расшифровываются итоги',{exact:true}).click();await expect(page.getByText('Расходы без вычета возвратов',{exact:true})).toBeVisible();await page.screenshot({path:info.outputPath('connected-overview.png'),fullPage:true});});
test('lost Settings commit acknowledgement locks navigation and retries the exact action without creating another preview',async({page})=>{const h=await setup(page);await section(page,'Счета');h.loseCommit();await page.getByLabel('Название счёта: Тестовый счёт').fill('Переименованный тестовый счёт');await page.getByRole('button',{name:'Применить',exact:true}).click();await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();await expect(page.getByRole('button',{name:'Повторить то же изменение'})).toBeVisible();await expect(page.getByRole('link',{name:'Операции',exact:true,includeHidden:true})).toHaveAttribute('aria-disabled','true');await page.evaluate(()=>window.location.hash='#operations');await expect(page.getByRole('heading',{name:'Настройки',exact:true,includeHidden:true})).toHaveCount(1);await page.getByRole('button',{name:'Повторить то же изменение'}).click();await expect(page.getByLabel('Название счёта: Переименованный тестовый счёт')).toBeVisible();const commits=h.calls.filter(c=>c.path==='/finance/commit');expect(commits).toHaveLength(2);expect(commits[1]!.body).toEqual(commits[0]!.body);expect(h.calls.filter(c=>c.path==='/finance/preview')).toHaveLength(1);await page.getByLabel('Название счёта: Переименованный тестовый счёт').fill('Следующее имя');await expect(page.getByRole('button',{name:'Применить',exact:true})).toBeEnabled();});
test('empty account offers first upload, scoped history is reachable, and access loss immediately removes all financial data',async({page})=>{const h=await setup(page);await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByRole('list',{name:'Сохранённые операции'}).getByRole('button').click();await expect(page.getByRole('dialog',{name:'Операция'})).toBeVisible();await page.getByRole('button',{name:'История операции'}).click();await expect(page.getByText('История выбранной операции',{exact:true})).toBeVisible();await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/history-query').at(-1)?.body.operationIds).toEqual([h.detail.id]);await page.getByRole('button',{name:'Показать всю историю'}).click();await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/history-query').at(-1)?.body.operationIds).toBeUndefined();h.block();await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await expect(page.getByRole('heading',{name:'Аккаунт',exact:true})).toBeVisible();await expect(page.getByRole('navigation',{name:'Разделы сайта'})).toHaveCount(0);await expect(page.getByText('Synthetic shop',{exact:true})).toHaveCount(0);});
test('empty workspace starts with onboarding and hides invented zero KPIs',async({page})=>{await setup(page,true);await expect(page.getByRole('heading',{name:'Начните с первой выписки'})).toBeVisible();await expect(page.getByRole('region',{name:'Основные показатели'})).toHaveCount(0);await page.getByRole('button',{name:'Загрузить первую выписку'}).click();await expect(page.getByRole('dialog',{name:'Загрузка выписок'})).toBeVisible();await page.getByRole('button',{name:'Закрыть: Загрузка выписок'}).click();});
test('import cancellation shows destructive consequences, permits declining, and retries a lost commit without Undo',async({page})=>{
 const h=await setup(page),batchId=crypto.randomUUID(),fileId=crypto.randomUUID(),attempts:unknown[]=[],intents:Record<string,unknown>[]=[],cancelledAt='2026-10-09T07:00:00.000Z';let cancelled=false;
 const counts=()=>({rowsFound:1,pending:0,created:cancelled?0:1,existing:0,updated:0,notImported:0,removed:cancelled?1:0,review:0}),transactions=()=>({total:cancelled?0:1,created:cancelled?0:1,existing:0,updated:0,review:0});
 await page.route('http://127.0.0.1:3000/finance/**',async route=>{const path=new URL(route.request().url()).pathname,body=route.request().postDataJSON()??{},headers={'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};if(route.request().method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}let result:unknown;
  if(path==='/finance/imports')result={batches:[{batchId,status:cancelled?'cancelled':'completed',createdAt:cancelledAt,finishedAt:cancelledAt,files:1,rowsFound:1}],nextCursor:null};
  else if(path==='/finance/import-status')result={schemaVersion:1,batchId,stage:'server_accepted',status:cancelled?'cancelled':'completed',generation:h.state.generation,createdAt:cancelledAt,finishedAt:cancelledAt,operationIds:cancelled?[]:[h.detail.id],counts:{...counts(),files:1,blockedFiles:0},transactionCounts:transactions(),newAccountIds:[],files:[{fileId,bank:'tbank',cancelledAt:cancelled?cancelledAt:null,blocked:false,error:null,operationIds:cancelled?[]:[h.detail.id],counts:counts(),transactionCounts:transactions(),issues:[]}]};
  else if(path==='/finance/preview'){intents.push(body.intent);result={...syntheticPreview(body.actionId,h.detail),impact:{before:h.state.summary,after:aggregate([]),affectedOperationIds:[h.detail.id],dependencyConflicts:[],details:{kind:'cancel_import',counts:{files:1,operations:1,sharedOperations:0,observations:1,components:0,manualEdits:1,linksRecalculated:0,pendingRows:0,history:2},sourceRestorations:[]}}};}
  else if(path==='/finance/commit'){attempts.push(body);if(!cancelled){cancelled=true;h.state.generation=crypto.randomUUID();h.state.operations=[];h.state.revision='2';await route.abort('connectionreset');return;}result={status:'committed',actionId:body.actionId,generation:h.state.generation,revision:'2',cleanup:{destructive:true,undoable:false}};}
  else {await route.fallback();return;}
  await route.fulfill({headers,contentType:'application/json',body:JSON.stringify(result)});
 });
 await section(page,'Загрузки');await page.getByRole('button',{name:'Обновить данные',exact:true}).click();const files=page.getByText('Файлы загрузки · 1',{exact:true});
 await files.click();
 const file=page.getByText('Т-Банк · Файл 1',{exact:true});
 const arrowInset=(row:typeof files)=>row.evaluate(node=>node.querySelector('svg')!.getBoundingClientRect().left-node.parentElement!.getBoundingClientRect().left);
 expect(await arrowInset(file)).toBeCloseTo(await arrowInset(files),0);
 await file.click();
 expect(await arrowInset(file)).toBeCloseTo(await arrowInset(files),0);await expect(page.getByRole('button',{name:'Отменить файл',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Отменить файл',exact:true}).click();await expect(page.getByRole('region',{name:'Последствия отмены импорта'})).toContainText('Ручные правки в 1 удаляемых операциях исчезнут');await page.getByRole('button',{name:'Отмена',exact:true}).click();expect(attempts).toHaveLength(0);
 await page.getByRole('region',{name:'Результат загрузки'}).getByRole('button',{name:'Отменить загрузку',exact:true}).click();await page.getByRole('dialog',{name:'Отмена загрузки',exact:true}).getByRole('button',{name:'Отменить загрузку',exact:true}).click();await expect(page.getByRole('button',{name:'Повторить то же изменение'})).toBeVisible();await page.getByRole('button',{name:'Повторить то же изменение'}).click();await expect(page.getByText('Чтобы восстановить данные, загрузите исходные файлы заново.',{exact:true})).toBeVisible();expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);expect(intents).toEqual([{kind:'cancel_import',batchId,fileId},{kind:'cancel_import',batchId}]);await expect(page.getByRole('button',{name:'Отменить последнее изменение',exact:true})).toHaveCount(0);expect(await page.evaluate(()=>localStorage.length)).toBe(0);
});
test('different-operation decision removes only its candidate pair and keeps both operations',async({page})=>{
 const h=await setup(page),second={...h.state.operations[0]!,id:crypto.randomUUID()},pair={id:crypto.randomUUID(),leftId:h.detail.id,rightId:second.id};h.state.operations.push(second);h.state.duplicateCandidates=[pair];
 await page.route('http://127.0.0.1:3000/finance/commit',async route=>{if(route.request().method()==='OPTIONS'){await route.fallback();return;}const body=route.request().postDataJSON();h.state.duplicateCandidates=[];h.state.revision='2';await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},contentType:'application/json',body:JSON.stringify({status:'committed',actionId:body.actionId,generation:h.state.generation,revision:'2'})});});
 await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.getByRole('link',{name:'Операции',exact:true}).click();await expect(page.getByRole('list',{name:'Сохранённые операции'}).getByRole('button')).toHaveCount(2);await page.getByRole('button',{name:'Это разные операции'}).click();await page.getByRole('button',{name:'Сохранить обе операции'}).click();await expect(page.getByRole('region',{name:'Возможные дубли'})).toHaveCount(0);await expect(page.getByRole('list',{name:'Сохранённые операции'}).getByRole('button')).toHaveCount(2);expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toEqual({kind:'duplicate_different',id:pair.id});
});

test('duplicate merge requires manual choices, permits declining, and retries the same commit with Undo available',async({page})=>{
 const h=await setup(page),left={...h.detail,comment:'First note'},right={...structuredClone(h.detail),id:crypto.randomUUID(),comment:'Second note'},pair={id:crypto.randomUUID(),leftId:left.id,rightId:right.id},attempts:unknown[]=[],intents:Record<string,unknown>[]=[],responses=new Map<string,ReturnType<typeof syntheticPreview>>();right.projection={...right.projection,id:right.id};left.components=[{id:crypto.randomUUID(),transactionId:left.id,type:'other',amountMinor:'-10000',role:left.semantics.role,category:left.semantics.category,subcategory:left.semantics.subcategory}];right.components=[{...left.components[0]!,id:crypto.randomUUID(),transactionId:right.id}];const dropLink={id:crypto.randomUUID(),sourceId:left.id,targetId:right.id,sourceComponentId:null,targetComponentId:null,kind:'own_transfer' as const,amountMinor:'1',status:'candidate' as const,confidence:100,createdBy:'user' as const};left.links=[dropLink];right.links=[dropLink];h.state.duplicateCandidates=[pair];h.state.operations=[{...left.projection,classification:left.semantics,comment:left.comment},{...right.projection,classification:right.semantics,comment:right.comment}];
 const headers={'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'};
 await page.route('http://127.0.0.1:3000/finance/operation',async route=>{if(route.request().method()==='OPTIONS'){await route.fallback();return;}const id=route.request().postDataJSON().id;await route.fulfill({headers,contentType:'application/json',body:JSON.stringify({...((id===right.id)?right:left),revision:h.state.revision})});});
 await page.route('http://127.0.0.1:3000/finance/preview',async route=>{if(route.request().method()==='OPTIONS'){await route.fallback();return;}const body=route.request().postDataJSON(),intent=body.intent;intents.push(intent);const result=syntheticPreview(body.actionId,left);result.impact.details={kind:'merge_duplicate',canonicalId:intent.canonicalId,mapping:[{oldId:right.id,canonicalId:left.id}],sourcesPreserved:2,conflicts:intent.choices.comment?[]:[{field:'comment',left:left.comment,right:right.comment}],componentsKept:0,componentsRetired:0,linksMoved:[],linksDropped:[],undoable:true};responses.set(body.actionId,result);await route.fulfill({headers,contentType:'application/json',body:JSON.stringify(result)});});
 await page.route('http://127.0.0.1:3000/finance/commit',async route=>{if(route.request().method()==='OPTIONS'){await route.fallback();return;}const body=route.request().postDataJSON();attempts.push(body);h.state.duplicateCandidates=[];h.state.operations=[h.state.operations[0]!];h.state.operationAliases=[{id:right.id,canonicalId:left.id}];h.state.revision='2';if(attempts.length===1){await route.abort('failed');return;}await route.fulfill({headers,contentType:'application/json',body:JSON.stringify({status:'committed',actionId:body.actionId,generation:h.state.generation,revision:'2'})});});
 await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByRole('button',{name:'Это одна операция',exact:true}).click();await page.getByRole('button',{name:'Показать последствия объединения'}).click();await expect(page.getByRole('button',{name:'Объединить операции'})).toBeDisabled();expect(attempts).toHaveLength(0);await page.getByRole('button',{name:'Назад',exact:true}).click();await chooseOption(page.getByLabel('Комментарий',{exact:true}),'left');await chooseOption(page.getByLabel('Части операции',{exact:true}),'right');await page.getByLabel('Убрать связь 1',{exact:true}).check();await page.getByRole('button',{name:'Показать последствия объединения'}).click();await expect(page.getByRole('button',{name:'Объединить операции'})).toBeEnabled();await page.getByRole('button',{name:'Назад',exact:true}).click();expect(attempts).toHaveLength(0);
 await page.getByRole('button',{name:'Показать последствия объединения'}).click();await page.getByRole('button',{name:'Объединить операции'}).click();await expect(page.getByRole('button',{name:'Повторить то же изменение'})).toBeVisible();await expect(page.getByRole('link',{name:'Операции',exact:true,includeHidden:true})).toBeDisabled();await page.getByRole('button',{name:'Повторить то же изменение'}).click();expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(attempts[1]);expect(intents.at(-1)).toMatchObject({kind:'merge_duplicate',id:pair.id,canonicalId:left.id,sourceSide:'left',choices:{comment:'left'},components:'right',dropLinkIds:[dropLink.id]});await expect(page.getByRole('list',{name:'Сохранённые операции'}).locator('li')).toHaveCount(1);await expect(page.getByRole('button',{name:'Отменить последнее изменение',exact:true})).toBeVisible();expect(await page.evaluate(()=>Object.keys(localStorage))).toEqual([]);expect(await page.evaluate(()=>Object.keys(sessionStorage))).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});
test('a late duplicate comparison response cannot restore data after access is lost',async({page})=>{
 const h=await setup(page),pair={id:crypto.randomUUID(),leftId:h.detail.id,rightId:crypto.randomUUID()};h.state.duplicateCandidates=[pair];let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),seen=new Promise<void>(r=>{started=r;});
 await page.route('http://127.0.0.1:3000/finance/operation',async route=>{if(route.request().method()==='OPTIONS'){await route.fallback();return;}started();await gate;try{await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},contentType:'application/json',body:JSON.stringify(h.detail)});}catch{}});
 await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByRole('button',{name:'Это одна операция',exact:true}).click();await seen;const delivered=Promise.all([pair.leftId,pair.rightId].map(id=>page.waitForResponse(r=>r.url().endsWith('/finance/operation')&&r.request().method()==='POST'&&r.request().postDataJSON().id===id)));h.block();try{await expect(page.getByRole('heading',{name:'Аккаунт',exact:true})).toBeVisible({timeout:10000});}finally{release();}await delivered;await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await expect(page.getByRole('region',{name:'Выбор данных для объединения'})).toHaveCount(0);await expect(page.getByRole('navigation',{name:'Разделы сайта'})).toHaveCount(0);
});

test('component editor keeps signed cents, validates the sum and waits for explicit preview confirmation',async({page})=>{
 const h=await setup(page),categoryId=crypto.randomUUID();h.detail.semantics.kind.value='other';h.state.categories.push({id:categoryId,name:'Продукты',parentId:null,role:'expense',hidden:false});await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByRole('list',{name:'Сохранённые операции'}).getByRole('button').click();await page.getByRole('button',{name:'Разделить операцию на части'}).click();await chooseOption(page.getByLabel('Категория части 1',{exact:true}),categoryId);
 await page.getByLabel('Сумма части 1, ₽').fill('-80,01');await page.getByRole('button',{name:'Добавить часть',exact:true}).click();await page.getByLabel('Сумма части 2, ₽').fill('-19,98');await page.getByRole('button',{name:'Применить',exact:true}).click();await expect(page.getByRole('alert')).toContainText('точно совпадать');expect(h.calls.filter(c=>c.path==='/finance/preview')).toHaveLength(0);
 await page.getByLabel('Сумма части 2, ₽').fill('-19,99');await chooseOption(page.getByLabel('Смысл части 2'),'expense');await page.getByRole('button',{name:'Применить',exact:true}).click();expect(h.calls.filter(c=>c.path==='/finance/preview')).toHaveLength(0);await page.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(page.getByRole('region',{name:'Последствия изменения'})).toBeVisible();const intent=h.calls.find(c=>c.path==='/finance/preview')!.body.intent as {components:{amountMinor:string;role?:string}[]};expect(intent.components.map(p=>p.amountMinor)).toEqual(['-8001','-1999']);expect(intent.components[1]!.role).toBe('expense');expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);await page.getByRole('button',{name:'Отмена',exact:true}).click();await page.getByRole('button',{name:'Разделить операцию на части'}).click();await expect(page.getByLabel('Сумма части 2, ₽')).toHaveValue('-19,99');await expect(page.getByLabel('Сумма части 2, ₽')).toBeEnabled();expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});

test('links select exact allocation references from all history and a stale snapshot requires reopening',async({page})=>{
 const h=await setup(page),other=syntheticDetail(),allocationId=crypto.randomUUID(),componentId=crypto.randomUUID();h.detail.semantics.kind.value='other';other.projection.parts=[{...other.projection.parts[0]!,id:'opaque unrelated key',allocationId,componentId,role:'expense',amountMinor:'10000'}];h.state.operations.push({...other.projection,classification:other.semantics,comment:''});
 await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByRole('list',{name:'Сохранённые операции'}).getByRole('button').filter({hasText:'Synthetic shop'}).first().click();await page.getByRole('button',{name:'Связать с другой операцией'}).click();const parent=page.getByRole('dialog',{name:'Операция',exact:true,includeHidden:true}),child=page.getByRole('dialog',{name:'Связь с другой операцией',exact:true});
 await expect(parent).toHaveCSS('filter','brightness(0.85)');expect((await child.boundingBox())!.width).toBeLessThanOrEqual((await parent.boundingBox())!.width);
 await expect(child.getByLabel('Статус связи')).toHaveCount(0);await page.getByLabel('Связанная операция',{exact:true}).fill('01.09.2026 Synthetic');await page.getByRole('region',{name:'Результаты поиска операций'}).getByRole('button',{name:/Synthetic shop/}).click();await chooseOption(page.getByLabel('Часть первой операции'),'root');await chooseOption(page.getByLabel('Часть второй операции'),'allocation:'+allocationId);await page.getByLabel('Сумма связи, ₽').fill('20,01');await page.getByRole('button',{name:'Применить',exact:true}).click();expect(h.calls.filter(c=>c.path==='/finance/preview')).toHaveLength(0);await page.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(page.getByRole('region',{name:'Последствия изменения'})).toBeVisible();const intent=h.calls.find(c=>c.path==='/finance/preview')!.body.intent as {links:{link:Record<string,unknown>}[]};expect(intent.links[0]!.link.targetAllocationId).toBe(allocationId);expect(intent.links[0]!.link.targetComponentId).toBeNull();expect(intent.links[0]!.link.amountMinor).toBe('2001');expect(intent.links[0]!.link.status).toBe('confirmed');expect(JSON.stringify(intent)).not.toContain('opaque unrelated key');await page.getByRole('button',{name:'Отмена',exact:true}).click();h.state.revision='3';await page.getByRole('button',{name:'Связать с другой операцией'}).click();await expect(page.getByRole('alert')).toContainText('Обновите карточку');await expect(page.getByRole('button',{name:'Применить',exact:true})).toBeDisabled();await page.getByRole('dialog',{name:'Связь с другой операцией'}).getByRole('button',{name:'Обновить карточку'}).click();await page.getByRole('button',{name:'Не сохранять',exact:true}).click();await expect(page.getByRole('dialog',{name:'Связь с другой операцией'})).toHaveCount(0);
});

test('operation breakdown displays final server parts, expense reductions and exclusions without repeating parents',async({page})=>{
 const h=await setup(page),categoryId=crypto.randomUUID();h.state.categories.push({id:categoryId,name:'Продукты',parentId:null,role:'expense',hidden:false});h.detail.projection.amountMinor='10000';h.detail.projection.analyticsRole='mixed';h.detail.projection.decompositionActive=true;h.detail.projection.parts=[{...h.detail.projection.parts[0]!,id:'final allocation',amountMinor:'6000',categoryId,role:'expense',allocationId:crypto.randomUUID()},{...h.detail.projection.parts[0]!,id:'unresolved remainder',amountMinor:'4000',role:'unresolved',included:false}];
 await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByRole('list',{name:'Сохранённые операции'}).getByRole('button').click();const breakdown=page.getByRole('region',{name:'Учёт частей операции'});await expect(breakdown).toContainText('60 ₽ · Уменьшает расходы');await expect(breakdown).toContainText('Продукты');await expect(breakdown).toContainText('40 ₽ · Не определено');await expect(breakdown).toContainText('Исключено из аналитики');await expect(breakdown.getByRole('listitem')).toHaveCount(2);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});

async function settingsImpact(page:Page,h:Awaited<ReturnType<typeof setup>>,details:Record<string,unknown>){
 await page.route('http://127.0.0.1:3000/finance/preview',async route=>{if(route.request().method()==='OPTIONS'){await route.fallback();return;}const b=route.request().postDataJSON();h.calls.push({path:'/finance/preview',body:b});const summary=aggregate(h.state.operations);await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{status:'previewed',actionId:b.actionId,impact:{before:summary,after:summary,affectedOperationIds:[],dependencyConflicts:[],details}}});});
}
function syntheticRule(){return {id:crypto.randomUUID(),name:'Тестовое правило',enabled:true,priority:30,conditions:{merchantContains:'Synthetic',direction:'out' as const},assignments:{role:'expense' as const},dependencyStatus:'ready'};}
test('rule editor works before the first import, validates required fields and preserves signed cents and AND conditions without historical application',async({page})=>{
 const h=await setup(page,true);await section(page,'Правила');await page.getByRole('button',{name:'Создать правило'}).click();await page.getByLabel('Название правила',{exact:true}).fill('Тестовое правило');await page.getByRole('button',{name:'Создать правило',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'хотя бы одно условие'})).toBeVisible();expect(h.calls.filter(c=>c.path==='/finance/preview')).toHaveLength(0);
 await page.getByLabel('Магазин содержит',{exact:true}).fill('Synthetic');await chooseOption(page.getByLabel('Направление',{exact:true}),'out');await page.getByLabel('Сумма от, ₽',{exact:true}).fill('-100,01');await page.getByLabel('Сумма до, ₽',{exact:true}).fill('-1,01');await chooseOption(page.getByLabel('Назначить финансовый смысл',{exact:true}),'expense');const priority=page.getByLabel('Приоритет правила',{exact:true});await priority.fill('invalid');await expect(priority).toHaveValue('100');await priority.fill('-30');await page.getByRole('button',{name:'Создать правило',exact:true}).click();await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/commit').length).toBe(1);expect(h.calls.find(c=>c.path==='/finance/preview')?.body.intent).toMatchObject({kind:'rule',create:true,patch:{name:'Тестовое правило',priority:-30,conditions:{merchantContains:'Synthetic',direction:'out',amountFromMinor:'-10001',amountThroughMinor:'-101'},assignments:{role:'expense'}}});expect(h.calls.some(c=>(c.body.intent as {kind?:string})?.kind==='apply_rules')).toBe(false);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});
test('past rule application uses a fixed explicit set, displays protected decisions and never commits on cancellation',async({page})=>{
 const h=await setup(page),rule=syntheticRule();h.state.rules=[rule];h.state.operations[0]!.description='Synthetic description';await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await settingsImpact(page,h,{kind:'apply_rules',ruleName:rule.name,ruleIds:[rule.id],operationIds:[h.detail.id],selectedCount:1,changedOperationIds:[h.detail.id],protectedOperationIds:[h.detail.id],conflictingOperationIds:[h.detail.id],financialOperationsDeleted:0});await page.route('http://127.0.0.1:3000/finance/rule-candidates',async route=>{if(route.request().method()==='OPTIONS')return route.fallback();await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{operationIds:[h.detail.id],total:1,revision:h.state.revision}});});await section(page,'Правила');await page.getByRole('button',{name:'Применить к прошлым: '+rule.name,exact:true}).click();await expect(page.getByRole('button',{name:'Продолжить'})).toBeDisabled();await page.getByLabel('Операция правила 1',{exact:true}).check();await page.getByRole('button',{name:'Продолжить'}).click();await expect(page.getByRole('region',{name:'Последствия настроек и правил'})).toContainText(/Изменятся операции\s*1/);await expect(page.getByRole('region',{name:'Последствия настроек и правил'})).toContainText(/Потребуется проверка\s*1/);expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toEqual({kind:'apply_rules',ruleId:rule.id,operationIds:[h.detail.id]});await page.getByRole('button',{name:'Назад',exact:true}).click();expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);await expect(page.getByLabel('Операция правила 1',{exact:true})).toBeChecked();
});
test('stale rule drafts preserve entered values but require reopening before saving',async({page})=>{
 const h=await setup(page),rule=syntheticRule();h.state.rules=[rule];await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await section(page,'Правила');await page.getByRole('button',{name:'Изменить правило: '+rule.name,exact:true}).click();await page.getByLabel('Название правила',{exact:true}).fill('Мой черновик');h.state.revision='2';h.state.rules[0]!.name='Новое имя другого устройства';await page.evaluate(()=>document.querySelector<HTMLButtonElement>('button[aria-label="Обновить данные"]')!.click());await expect(page.getByRole('alert')).toContainText('Данные изменились.');await expect(page.getByLabel('Название правила',{exact:true})).toHaveValue('Мой черновик');await expect(page.getByRole('button',{name:'Сохранить',exact:true})).toBeDisabled();expect(h.calls.filter(c=>c.path==='/finance/preview')).toHaveLength(0);await page.getByRole('button',{name:'Закрыть: Изменение правила'}).click();await page.getByRole('button',{name:'Изменить правило: Новое имя другого устройства',exact:true}).click();await expect(page.getByLabel('Название правила',{exact:true})).toHaveValue('Новое имя другого устройства');await expect(page.getByRole('button',{name:'Сохранить',exact:true})).toBeEnabled();
});
test('account merge keeps the canonical card and shows source, rule and link dependencies before confirmation',async({page},testInfo)=>{
 const h=await setup(page),target=h.state.accounts[0]!,donor={...target,id:crypto.randomUUID(),name:'Второй тестовый счёт'};h.state.accounts.push(donor);await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await settingsImpact(page,h,{kind:'merge_accounts',canonicalSettings:target,sourceAccountIds:[donor.id],observationsMoved:2,aliasesMoved:1,rulesMoved:[],linkDependencies:[crypto.randomUUID()],sourceFactsPreserved:true});await section(page,'Счета');await page.getByRole('article',{name:target.name,exact:true}).getByRole('button',{name:'Объединить счёт с другим',exact:true}).click();await page.getByRole('group',{name:'Счета для объединения'}).getByRole('checkbox').check();if(testInfo.project.name==='desktop')await page.screenshot({path:testInfo.outputPath('cashneuro-obedinenie-schetov.png')});await page.getByRole('button',{name:'Продолжить'}).click();await expect(page.getByRole('region',{name:'Последствия настроек и правил'})).toContainText('Источники операций');expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toEqual({kind:'merge_accounts',id:target.id,sourceIds:[donor.id]});expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);await page.getByRole('button',{name:'Назад',exact:true}).click();
});
test('only a reversible merge offers account separation and uses its exact history action',async({page})=>{
 const h=await setup(page),account=h.state.accounts[0]!,mergeId=crypto.randomUUID(),sourceId=crypto.randomUUID();
 let hasMerge=false;
 await page.route('http://127.0.0.1:3000/finance/history-query',async route=>{
  if(route.request().method()==='OPTIONS')return route.fallback();
  expect(route.request().postDataJSON()).toEqual({mergeTargetId:account.id,limit:1});
  await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{actions:hasMerge?[{id:mergeId,undoable:true,changes:[{kind:'account',id:sourceId,before:{values:{display_name:'Второй счёт',merged_into_id:null}},after:{values:{merged_into_id:account.id}}}]}]:[],nextBeforeRevision:null}});
 });
 await section(page,'Счета');
 await page.getByRole('button',{name:'Объединить счёт с другим',exact:true}).click();
 let dialog=page.getByRole('dialog',{name:'Объединение счетов',exact:true});
 await expect(dialog).toContainText('Других счетов для объединения нет.');
 await expect(dialog.getByLabel('Действие')).toHaveCount(0);
 await dialog.getByRole('button',{name:'Закрыть'}).click();hasMerge=true;
 await page.getByRole('button',{name:'Объединить счёт с другим',exact:true}).click();
 await chooseOption(dialog.getByLabel('Действие',{exact:true}),'undo');
 await expect(dialog).toContainText('Второй счёт');
 await dialog.getByRole('button',{name:'Продолжить'}).click();
 await expect(page.getByRole('dialog',{name:'Разъединить счета',exact:true})).toBeVisible();
 expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toMatchObject({kind:'undo',value:mergeId});
 expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
});
test('settings group account edits under one preview and reset the draft without a write',async({page})=>{
 const h=await setup(page),account=h.state.accounts[0]!,second={...account,id:crypto.randomUUID(),bankId:'sber',name:'Резерв'};
 h.state.accounts.push(second);
 await section(page,'Счета');
 const name=page.getByLabel('Название счёта: '+account.name,{exact:true});
 await name.fill('');await page.getByRole('button',{name:'Применить',exact:true}).click();
 await expect(name).toHaveAttribute('aria-invalid','true');
 await name.fill('Основной');await chooseOption(page.getByLabel('Участие в аналитике: Резерв',{exact:true}),'false');
 await page.getByRole('button',{name:'Сбросить',exact:true}).click();
 await expect(name).toHaveValue(account.name);
 await name.fill('Основной');await chooseOption(page.getByLabel('Участие в аналитике: Резерв',{exact:true}),'false');
 await page.getByRole('button',{name:'Применить',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Сохранить настройки счетов'})).toBeVisible();
 expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toMatchObject({kind:'account_settings',accounts:expect.arrayContaining([{id:account.id,patch:{name:'Основной'}},{id:second.id,patch:{analyticsEnabled:false}}])});
 expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
 await page.getByRole('button',{name:'Отмена',exact:true}).click();
 await expect(name).toHaveValue('Основной');
});
test('account drilldown keeps independent filters and removes its own context on request',async({page})=>{
 const h=await setup(page);
 await page.getByRole('link',{name:'Операции',exact:true}).click();
 await page.getByLabel('Поиск в операциях',{exact:true}).fill('Synthetic');
 await section(page,'Счета');await page.getByRole('button',{name:'Операции счёта',exact:true}).click();
 await expect(page.getByRole('button',{name:'Снять контекст Настроек'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Снять контекст Обзора'})).toHaveCount(0);
 await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/operations-page').at(-1)?.body.query).toMatchObject({filter:{accountIds:[h.state.accounts[0]!.id],search:'Synthetic'}});
 await page.getByRole('button',{name:'Снять контекст Настроек'}).click();
 await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/operations-page').at(-1)?.body.query).not.toMatchObject({filter:{accountIds:[h.state.accounts[0]!.id]}});
 await expect(page.getByLabel('Поиск в операциях',{exact:true})).toHaveValue('Synthetic');
});
test('account opens over finance without losing the route and revokes another session only after confirmation',async({page})=>{
 const h=await setup(page);
 const id=crypto.randomUUID(),now=new Date().toISOString();
 await page.route('http://127.0.0.1:3000/security/**',async route=>{
  if(route.request().method()==='OPTIONS')return route.fallback();
  const path=new URL(route.request().url()).pathname;
  h.calls.push({path,body:route.request().postDataJSON()??{}});
  const json=path==='/security/sessions'?{sessions:[{id:crypto.randomUUID(),createdAt:now,expiresAt:now,current:true},{id,createdAt:now,expiresAt:now,current:false}]}:{status:'revoked'};
  await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json});
 });
 await page.getByRole('link',{name:'Операции',exact:true}).click();
 await page.getByLabel('Поиск в операциях',{exact:true}).fill('Synthetic');
 await page.getByRole('button',{name:'Аккаунт',exact:true}).click();
 await page.getByRole('button',{name:'Активные сеансы',exact:true}).click();
 const sessions=page.getByRole('dialog',{name:'Активные сеансы'});
 await expect(sessions.getByRole('button',{name:'Завершить',exact:true})).toHaveCount(1);
 await sessions.getByRole('button',{name:'Завершить',exact:true}).click();
 expect(h.calls.some(c=>c.path==='/security/revoke-session')).toBe(false);
 await page.getByRole('button',{name:'Завершить сеанс',exact:true}).click();
 await expect(sessions.getByRole('button',{name:'Завершить',exact:true})).toHaveCount(0);
 expect(h.calls.filter(c=>c.path==='/security/revoke-session').map(c=>c.body)).toEqual([{sessionId:id}]);
 await sessions.getByRole('button',{name:'Закрыть',exact:true}).click();await page.getByRole('button',{name:'Готово',exact:true}).click();
 await expect(page.getByLabel('Поиск в операциях',{exact:true})).toHaveValue('Synthetic');
});
test('category migration captures explicit operation and component roles without deleting financial data',async({page})=>{
 const h=await setup(page),id=crypto.randomUUID(),component=crypto.randomUUID();h.state.categories=[{id,name:'Тестовая категория',role:'expense',parentId:null,hidden:false}];h.state.operations[0]!.classification.category.value=id;h.state.categoryComponents=[{id:component,transactionId:h.detail.id,role:'expense',categoryId:id,subcategoryId:null}];await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await settingsImpact(page,h,{kind:'migrate_category',financialOperationsDeleted:0,rulesNeedSetup:[],categoriesChanged:[{id,name:'Тестовая категория',role:'income',parentId:null}]});await section(page,'Категории');await page.getByRole('searchbox',{name:'Поиск категорий'}).fill('Тестовая категория');await page.getByRole('button',{name:'Изменить категорию: Тестовая категория',exact:true}).click();await page.getByRole('button',{name:'Изменить смысл или родителя',exact:true}).click();await chooseOption(page.getByLabel('Допустимая роль категории',{exact:true}),'income');await page.getByText('Решения о финансовом смысле',{exact:true}).click();await chooseOption(page.getByLabel(/^Смысл операции 1:/),'income');await chooseOption(page.getByLabel(/^Смысл части 1:/),'income');await page.getByRole('button',{name:'Продолжить'}).click();await expect(page.getByRole('region',{name:'Последствия настроек и правил'})).toContainText('Операции сохранятся.');expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toEqual({kind:'migrate_category',id,parentId:null,role:'income',roleDecisions:[{kind:'operation',id:h.detail.id,role:'income'},{kind:'component',id:component,role:'income'}],childRoles:[]});expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
});
test('counterparty split refuses inconsistent aliases and ordinary card deletion preserves operations',async({page})=>{
 const h=await setup(page),p=h.state.counterparties[0]!,source=crypto.randomUUID(),alias=crypto.randomUUID();h.state.operations[0]!.classification.counterparty.value=p.id;h.state.counterpartySources=[{observationId:source,transactionId:h.detail.id,counterpartyId:p.id,aliasId:alias}];h.state.counterpartyAliases=[{id:alias,counterpartyId:p.id,type:'party'}];await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await section(page,'Контрагенты');await page.getByRole('button',{name:'Изменить',exact:true}).first().click();await page.getByRole('button',{name:'Разделить',exact:true}).click();await page.getByLabel('Название нового контрагента 1',{exact:true}).fill('Второй человек');const newId=await chooseOption(page.getByLabel(/^Источник 1:/),/^Второй человек$/);await chooseOption(page.getByLabel(/^Псевдоним 1:/),p.id);await chooseOption(page.getByLabel(/^Операция 1:/),'none');await page.getByRole('button',{name:'Продолжить'}).click();await expect(page.getByRole('alert')).toContainText('одного банковского псевдонима');expect(h.calls.filter(c=>c.path==='/finance/preview')).toHaveLength(0);await chooseOption(page.getByLabel(/^Псевдоним 1:/),newId!);await page.getByRole('button',{name:'Продолжить'}).click();await expect(page.getByRole('button',{name:'Разделить контрагента',exact:true})).toBeVisible();expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toMatchObject({kind:'split_counterparty',newParties:[{id:newId,name:'Второй человек'}],operations:[{id:h.detail.id,counterpartyId:null}]});await page.getByRole('button',{name:'Назад',exact:true}).click();await page.getByRole('dialog',{name:'Разделить · '+p.name}).getByRole('button',{name:'Отменить',exact:true}).click();await page.getByRole('dialog',{name:'Изменить контрагента'}).getByRole('button',{name:'Закрыть'}).click();await page.getByRole('button',{name:'Удалить',exact:true}).first().click();await settingsImpact(page,h,{kind:'delete_counterparty',counterpartiesRemoved:[p.id],financialOperationsDeleted:0,aliasesRemoved:1,rulesNeedSetup:[]});await page.getByRole('button',{name:'Только карточку'}).click();await expect(page.getByRole('region',{name:'Последствия настроек и правил'})).toContainText('Операции сохранятся.');expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toEqual({kind:'delete_counterparty',id:p.id});
});
test('rule deletion preview names past dependencies and does not modify operations',async({page})=>{
 const h=await setup(page),rule=syntheticRule();h.state.rules=[rule];await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await settingsImpact(page,h,{kind:'delete_rule',ruleName:rule.name,operationDependencies:[h.detail.id],historicalOperationsUnchanged:true,financialOperationsDeleted:0});await section(page,'Правила');await page.getByRole('button',{name:'Удалить правило: '+rule.name,exact:true}).click();await page.getByRole('button',{name:'Продолжить'}).click();await expect(page.getByRole('region',{name:'Последствия настроек и правил'})).toContainText('Классификация прошлых операций сохранится');expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);await page.getByRole('button',{name:'Отмена',exact:true}).click();expect(h.state.operations).toHaveLength(1);
});

test('category migration exposes retained inactive parts and merged operation versions for explicit role decisions',async({page})=>{
 const h=await setup(page),id=crypto.randomUUID(),retired=crypto.randomUUID(),component=crypto.randomUUID();h.state.categories=[{id,name:'Категория старых версий',role:'income',parentId:null,hidden:false}];h.state.categoryOperations=[{id:retired,role:'income',categoryId:id,subcategoryId:null,merchant:'Сохранённая операция',retired:true}];h.state.categoryComponents=[{id:component,transactionId:h.detail.id,role:'income',categoryId:id,subcategoryId:null,retired:true}];await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await section(page,'Категории');await page.getByRole('searchbox',{name:'Поиск категорий'}).fill('Категория старых версий');await page.getByRole('button',{name:'Изменить категорию: Категория старых версий',exact:true}).click();await page.getByRole('button',{name:'Изменить смысл или родителя',exact:true}).click();await chooseOption(page.getByLabel('Допустимая роль категории',{exact:true}),'expense');await page.getByText('Решения о финансовом смысле',{exact:true}).click();await expect(page.getByRole('dialog',{name:'Изменить смысл или родителя · Категория старых версий'})).toContainText('Сохранённая старая версия');await chooseOption(page.getByLabel(/^Смысл операции 1:/),'expense');await chooseOption(page.getByLabel(/^Смысл части 1:/),'expense');await page.getByRole('button',{name:'Продолжить'}).click();await expect(page.getByRole('button',{name:'Сохранить изменения',exact:true})).toBeVisible();expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toMatchObject({kind:'migrate_category',roleDecisions:[{kind:'operation',id:retired,role:'expense'},{kind:'component',id:component,role:'expense'}]});expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
});

async function deletionFixture(page:Page,h:Awaited<ReturnType<typeof setup>>,options:{lostCommit?:boolean;recent?:boolean;wrongPassword?:boolean;large?:boolean}={}){
 const prepared=new Map<string,Record<string,any>>(),commits:Record<string,unknown>[]=[];let rejected=false;
 const headers={'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'};
 await page.route('http://127.0.0.1:3000/finance/epoch',async r=>{if(r.request().method()==='OPTIONS')return r.fallback();h.calls.push({path:'/finance/epoch',body:{}});await r.fulfill({headers,json:{generation:h.state.generation,revision:h.state.revision,recentAuthenticationRequired:options.recent}});});
 await page.route('http://127.0.0.1:3000/finance/preview',async r=>{if(r.request().method()==='OPTIONS')return r.fallback();const b=r.request().postDataJSON(),intent=b.intent;h.calls.push({path:'/finance/preview',body:b});prepared.set(b.actionId,intent);const reset=intent.kind==='reset_financial',ids=reset?[]:intent.scope.kind==='operations'?intent.scope.operationIds:h.state.operations.map(o=>o.id),details={kind:intent.kind,counts:{operations:options.large?10001:ids.length||h.state.operations.length,observations:2,components:3,links:1,history:3,pendingImportRowsInvalidated:4,retainedOperations:1},operationIds:ids,retainedOperationIds:[crypto.randomUUID()],survivingRelatedOperationIds:[],accountsDeleted:intent.scope?.deleteAccount?[intent.scope.accountId]:[],aliasesDeleted:0,counterpartiesDeleted:[],counterpartyAliasesDeleted:0,rulesNeedSetup:reset?1:[],...(reset?{preserved:{categories:intent.keepCategories?h.state.categories.length:0,rules:intent.keepRules?h.state.rules.length:0,interface:intent.keepInterface}}:{})},impact=reset?{details}:{before:h.state.summary,after:aggregate([]),affectedOperationIds:ids,dependencyConflicts:[],details};await r.fulfill({headers,json:{status:'previewed',actionId:b.actionId,impact}});});
 await page.route('http://127.0.0.1:3000/finance/commit',async r=>{if(r.request().method()==='OPTIONS')return r.fallback();const b=r.request().postDataJSON();h.calls.push({path:'/finance/commit',body:b});commits.push(b);if(options.lostCommit&&commits.length===1)return r.abort('connectionreset');if(options.wrongPassword&&!rejected){rejected=true;return r.fulfill({status:401,headers,json:{code:'INVALID_CREDENTIALS'}});}const intent=prepared.get(b.actionId)!;h.state.operations=[];h.state.generation=crypto.randomUUID();h.state.revision='2';h.state.summary=aggregate([]);const reset=intent.kind==='reset_financial';if(reset){h.state.accounts=[];h.state.counterparties=[];if(!intent.keepCategories)h.state.categories=[];if(!intent.keepRules)h.state.rules=[];if(!intent.keepInterface)h.state.interfaceEpoch=crypto.randomUUID();}await r.fulfill({headers,json:{status:'committed',actionId:b.actionId,generation:h.state.generation,revision:'2',...(reset?{interfaceEpoch:h.state.interfaceEpoch}:{}),cleanup:{destructive:true,undoable:false,interfaceReset:reset&&!intent.keepInterface,counts:{operations:options.large?10001:1}}}});});return {commits};
}
async function resetChoices(page:Page){for(const label of ['Персональные правила','Контрагенты','Бюджеты','Счета','Кредиты и кредитные карты'])await chooseOption(page.getByLabel(label+' после сброса',{exact:true}),label==='Персональные правила'?'keep':'delete');}
test('deletion preview freezes selected operation IDs and cancellation performs no physical delete',async({page})=>{const h=await setup(page);await deletionFixture(page,h);await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByLabel('Выбрать операцию 1',{exact:true}).check();await page.getByRole('button',{name:'Удалить выбранные',exact:true}).click();await expect(page.getByRole('list',{name:'Удаляемые операции'})).toHaveCount(0);await page.getByText('Показать состав операций',{exact:true}).click();await expect(page.getByRole('list',{name:'Удаляемые операции'})).toContainText('Synthetic shop');expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toEqual({kind:'delete_financial',scope:{kind:'operations',operationIds:[h.detail.id]}});await expect(page.getByRole('region',{name:'Состав удаления'})).toContainText('неактивные');await expect(page.getByRole('region',{name:'Состав удаления'})).toContainText('Сохранённые версии');expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);expect(h.state.operations).toHaveLength(1);});
test('period deletion uses explicit inclusive dates and chosen accounts independently of global filters',async({page})=>{const h=await setup(page);await deletionFixture(page,h);await section(page,'Конфиденциальность');await page.getByRole('button',{name:'Удалить за период',exact:true}).click();await page.getByLabel('Удалить с даты',{exact:true}).fill('2026-09-01');await page.getByLabel('Удалить по дату',{exact:true}).fill('2026-09-30');await page.getByRole('button',{name:'Банки и счета',exact:true}).click();await page.getByRole('checkbox',{name:/Счёт «Тестовый счёт»/}).check();await page.getByRole('button',{name:'Закрыть банки и счета',exact:true}).click();await page.getByRole('button',{name:'Продолжить',exact:true}).click();expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toEqual({kind:'delete_financial',scope:{kind:'period',from:'2026-09-01',through:'2026-09-30',accountIds:[h.state.accounts[0]!.id]}});await expect(page.getByRole('region',{name:'Состав удаления'})).toContainText('Финансовая история');expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);});
test('account deletion keeps the account by default; counterparty deletion uses its explicit choice',async({page})=>{const h=await setup(page);await deletionFixture(page,h);await section(page,'Счета');await page.getByRole('button',{name:'Удалить данные счёта',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Удалить счёт',exact:true})).not.toBeChecked();await page.getByRole('button',{name:'Продолжить',exact:true}).click();expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toEqual({kind:'delete_financial',scope:{kind:'account',accountId:h.state.accounts[0]!.id,deleteAccount:false}});await page.getByRole('button',{name:'Отменить',exact:true}).click();await section(page,'Контрагенты');const p=h.state.counterparties[0]!;await page.getByRole('button',{name:'Удалить',exact:true}).first().click();await page.getByRole('button',{name:'Карточку и операции',exact:true}).click();await expect(page.getByRole('region',{name:'Состав удаления'})).toBeVisible();expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toEqual({kind:'delete_financial',scope:{kind:'counterparty',counterpartyId:p.id,deleteCard:true}});expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);});
test('physical deletion with a lost response retries the same commit, clears old rows and has no Undo',async({page})=>{const h=await setup(page),merchant=h.state.operations[0]!.classification.merchant.value;const fixture=await deletionFixture(page,h,{lostCommit:true});await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByLabel('Выбрать операцию 1',{exact:true}).check();await page.getByRole('button',{name:'Удалить выбранные',exact:true}).click();await page.getByRole('button',{name:'Удалить данные',exact:true}).click();await expect(page.getByRole('button',{name:'Отменить',exact:true})).toBeDisabled();await page.getByRole('button',{name:'Повторить',exact:true}).click();await expect(page.getByRole('region',{name:'Удаление завершено'})).toHaveText('Данные удалены. Обычная отмена недоступна.');expect(fixture.commits).toHaveLength(2);expect(fixture.commits[0]).toEqual(fixture.commits[1]);expect(await page.getByRole('dialog').innerText()).not.toContain(merchant);await page.getByRole('button',{name:'Закрыть',exact:true}).click();await expect(page.getByRole('heading',{name:'Здесь будут ваши операции'})).toBeVisible();await expect(page.getByRole('button',{name:'Отменить последнее изменение',exact:true})).toHaveCount(0);});
test('full reset has explicit preservation choices, one password confirmation and preserves the chosen theme',async({page},info)=>{const h=await setup(page);h.state.interfaceEpoch=crypto.randomUUID();await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await section(page,'Интерфейс');await chooseOption(page.getByLabel('Тема',{exact:true}),'dark');await page.getByRole('button',{name:'Применить',exact:true}).click();const fixture=await deletionFixture(page,h,{recent:true,wrongPassword:true});await section(page,'Конфиденциальность');await page.getByRole('button',{name:'Полный финансовый сброс',exact:true}).click();await resetChoices(page);await page.getByRole('button',{name:'Продолжить',exact:true}).click();await expect(page.getByRole('region',{name:'Состав удаления'})).toContainText(/Правила потребуется настроить заново\s*1/);expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toEqual({kind:'reset_financial',keepCategories:true,keepRules:true,keepInterface:true,keepCounterparties:false,keepBudgets:false,keepAccounts:false,keepCredits:false});expect(h.calls.filter(c=>c.path==='/finance/epoch')).toHaveLength(1);await page.screenshot({path:info.outputPath('financial-reset-preview.png'),fullPage:true});await page.getByLabel('Пароль для финансового сброса',{exact:true}).fill('Wrong synthetic password');await page.getByRole('button',{name:'Сбросить финансовые данные',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Проверьте пароль');await expect(page.getByLabel('Пароль для финансового сброса',{exact:true})).toHaveValue('');await page.getByLabel('Пароль для финансового сброса',{exact:true}).fill('Correct synthetic password');await page.getByRole('button',{name:'Сбросить финансовые данные',exact:true}).click();await expect(page.getByRole('region',{name:'Удаление завершено'})).toContainText('Финансовые данные сброшены');expect(fixture.commits.map(c=>c.actionId)).toEqual([fixture.commits[0]!.actionId,fixture.commits[0]!.actionId]);expect(fixture.commits[1]).toMatchObject({confirmReset:true,password:'Correct synthetic password'});expect(h.calls.filter(c=>c.path==='/finance/preview')).toHaveLength(1);expect(await page.evaluate(()=>document.documentElement.dataset.theme)).toBe('dark');expect(await page.evaluate(()=>JSON.stringify({...localStorage}))).not.toContain('synthetic password');expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);});
test('changed deletion dependencies discard the preview without deleting or automatically widening scope',async({page})=>{const h=await setup(page);await deletionFixture(page,h);await section(page,'Конфиденциальность');await page.getByRole('button',{name:'Полный финансовый сброс',exact:true}).click();await resetChoices(page);await page.getByRole('button',{name:'Продолжить',exact:true}).click();await page.route('http://127.0.0.1:3000/finance/commit',async r=>{if(r.request().method()==='OPTIONS')return r.fallback();h.calls.push({path:'/finance/commit',body:r.request().postDataJSON()});await r.fulfill({status:409,headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{code:'DEPENDENCIES_CHANGED'}});});await page.getByRole('button',{name:'Сбросить финансовые данные',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Ничего не удалено');await expect(page.getByRole('region',{name:'Состав удаления'})).toHaveCount(0);expect(h.state.operations).toHaveLength(1);expect(h.calls.filter(c=>c.path==='/finance/preview')).toHaveLength(1);});
test('large workspace reset opens through the count-only epoch despite a failed graph load',async({page})=>{const h=await setup(page);await deletionFixture(page,h,{large:true});await page.route('http://127.0.0.1:3000/finance/summary',async r=>{if(r.request().method()==='OPTIONS')return r.fallback();await r.fulfill({status:409,headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{code:'FINANCE_SIZE_LIMIT'}});});await page.reload();await expect(page.getByRole('navigation',{name:'Разделы сайта',exact:true})).toBeVisible();await page.getByRole('button',{name:'Открыть полный финансовый сброс',exact:true}).click();await resetChoices(page);await page.getByRole('button',{name:'Продолжить',exact:true}).click();await expect(page.getByRole('region',{name:'Состав удаления'})).toContainText('10001');await page.getByRole('button',{name:'Сбросить финансовые данные',exact:true}).click();await expect(page.getByRole('region',{name:'Удаление завершено'})).toHaveText('Финансовые данные сброшены. Обычная отмена недоступна.');expect(h.calls.filter(c=>c.path==='/finance/epoch')).toHaveLength(1);});
test('an interface epoch changed on another device resets stored appearance on the next refresh',async({page})=>{const h=await setup(page);h.state.interfaceEpoch=crypto.randomUUID();await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await section(page,'Интерфейс');await chooseOption(page.getByLabel('Тема',{exact:true}),'dark');await page.getByRole('button',{name:'Применить',exact:true}).click();const epoch=crypto.randomUUID();h.state.interfaceEpoch=epoch;h.state.generation=crypto.randomUUID();h.state.operations=[];await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await expect(page.getByLabel('Тема',{exact:true})).toHaveAttribute('value','system');expect(await page.evaluate(()=>localStorage.getItem('finance-interface-epoch-v1'))).toBe(epoch);expect(await page.evaluate(()=>localStorage.getItem('finance-appearance-v1'))).toBeNull();await page.reload();await expect(page.getByRole('navigation',{name:'Разделы сайта',exact:true})).toBeVisible();await expect(page.getByLabel('Тема',{exact:true})).toHaveAttribute('value','system');});

test('local CSV XLSX OCR upload dialog remains readable on desktop and mobile',async({page},testInfo)=>{
 await setup(page);await page.getByRole('button',{name:'Загрузить файлы',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Загрузка выписок'});await expect(dialog.getByLabel('Файлы выписок')).toHaveAttribute('accept','.pdf,.csv,.xlsx');await expect(dialog).toContainText('PDF, CSV или XLSX');await expect(dialog).toContainText('Данные передаются на сервер по зашифрованному соединению');expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await dialog.screenshot({path:testInfo.outputPath('local-import-preview.png')});
});


test('operations filters do not dirty the presentation and invalid boolean search does not query the API',async({page})=>{
 const h=await setup(page);await page.getByRole('link',{name:'Операции',exact:true}).click();await expect(page.getByRole('list',{name:'Сохранённые операции'})).toBeVisible();
 const search=page.getByLabel('Поиск в операциях',{exact:true});
 await search.fill('такси &');await expect(search).toHaveAttribute('aria-invalid','true');await expect(page.getByRole('alert')).toContainText('с обеих сторон');
 expect(h.calls.filter(c=>c.path==='/finance/operations-page').every(c=>(c.body.query as {filter:{search?:string}}).filter.search!=='такси &')).toBe(true);
 await search.fill('такси | поезд');await expect.poll(()=>(h.calls.filter(c=>c.path==='/finance/operations-page').at(-1)?.body.query as {filter:{search?:string}}|undefined)?.filter.search).toBe('такси | поезд');
 await expect(page.getByRole('button',{name:'Сохранить представление операций',exact:true})).toHaveCount(0);
 await page.getByText('Вид списка',{exact:true}).click();await chooseOption(page.getByLabel('Сортировка операций'),'amount');await expect(page.getByRole('button',{name:'Сохранить представление операций',exact:true})).toBeVisible();
 await page.getByRole('status').filter({hasText:'Есть несохранённые изменения'}).locator('..').getByRole('button',{name:'Сбросить',exact:true}).click();await expect(search).toHaveValue('такси | поезд');
});

test('operation card draft saves only after confirmation and an unacknowledged commit can be retried',async({page})=>{
 const h=await setup(page);await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByRole('list',{name:'Сохранённые операции'}).locator('button[data-operation]').first().click();
 const card=page.getByRole('dialog',{name:'Операция',exact:true}),comment=card.getByLabel('Комментарий',{exact:true});
 await comment.fill('Draft to discard');expect(h.calls.filter(c=>['/finance/preview','/finance/edit','/finance/commit'].includes(c.path))).toHaveLength(0);
 await card.getByRole('button',{name:'Сбросить',exact:true}).click();await expect(comment).toHaveValue('');
 await comment.fill('Synthetic draft');await card.getByRole('button',{name:'Сохранить',exact:true}).click();
 const confirmation=page.getByRole('dialog',{name:'Сохранить изменения?',exact:true});await expect(confirmation).toBeVisible();expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
 h.loseCommit();await confirmation.getByRole('button',{name:'Сохранить изменения',exact:true}).click();await card.getByRole('button',{name:'Повторить то же изменение',exact:true}).click();
 await expect(card.getByRole('button',{name:'Сохранить',exact:true})).toBeDisabled();const commits=h.calls.filter(c=>c.path==='/finance/commit');
 expect(commits).toHaveLength(2);expect(commits[0]!.body.actionId).toBe(commits[1]!.body.actionId);
});

test('refresh preserves an unsaved card name and requires a deliberate conflict choice',async({page})=>{
 const h=await setup(page);await section(page,'Счета');
 await page.getByLabel('Название счёта: Тестовый счёт',{exact:true}).fill('Мой черновик');
 h.state.accounts[0]!.name='Обновлено на другом устройстве';h.state.revision='2';
 await page.getByRole('button',{name:'Обновить данные',exact:true}).click();
 await expect(page.getByLabel('Название счёта: Обновлено на другом устройстве',{exact:true})).toHaveValue('Мой черновик');
 await expect(page.getByRole('alert')).toContainText('Черновик сохранён');
 await expect(page.getByRole('button',{name:'Применить',exact:true})).toBeDisabled();
 expect(h.calls.filter(c=>c.path==='/finance/preview')).toHaveLength(0);
 await page.getByRole('button',{name:'Использовать сохранённые значения',exact:true}).click();
 await expect(page.getByLabel('Название счёта: Обновлено на другом устройстве',{exact:true})).toHaveValue('Обновлено на другом устройстве');
 expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
});

test('start screen and default period follow device preferences and profile timezone while explicit links win',async({page})=>{
 await setup(page);await page.clock.setFixedTime(new Date('2026-10-10T01:00:00Z'));await section(page,'Интерфейс');
 await chooseOption(page.getByLabel('Стартовый экран',{exact:true}),'operations');await chooseOption(page.getByLabel('Период по умолчанию',{exact:true}),'current_month');await page.getByRole('button',{name:'Применить',exact:true}).click();
 await page.goto(base);await expect(page.getByRole('heading',{name:'Операции',exact:true})).toBeVisible();
 await expect(page.getByLabel('С даты',{exact:true})).toHaveValue('01.10.2026');await expect(page.getByLabel('По дату',{exact:true})).toHaveValue('09.10.2026');
 await page.getByRole('link',{name:'CashNeuro — Финансовый анализатор',exact:true}).click();await expect(page.getByRole('heading',{name:'Обзор',exact:true})).toBeVisible();
 await page.goto(base+'#analyzer');await expect(page.getByRole('heading',{name:'Анализатор',exact:true})).toBeVisible();
 const stored=await page.evaluate(()=>localStorage.getItem('finance-navigation-v1'));expect(JSON.parse(stored!)).toEqual({startScreen:'operations',defaultPeriod:'current_month'});
});

test('compact global category picker searches children, keeps multiple choices narrow and shares exact scope with Operations',async({page},info)=>{
 const h=await setup(page),food=crypto.randomUUID(),delivery=crypto.randomUUID(),shop=crypto.randomUUID(),pets=crypto.randomUUID();
 h.state.categories=[{id:food,name:'Продукты',parentId:null,role:'expense',hidden:false},{id:delivery,name:'Доставка продуктов',parentId:food,role:'expense',hidden:false},{id:shop,name:'Магазины продуктов',parentId:food,role:'expense',hidden:false},{id:pets,name:'Питомцы с очень длинным названием для проверки размера фильтра',parentId:null,role:'expense',hidden:false}];
 await page.getByRole('button',{name:'Обновить данные',exact:true}).click();
 const filters=page.getByRole('group',{name:'Общие фильтры',exact:true}),trigger=filters.getByRole('button',{name:'Категории',exact:true});
 await expect(page.getByText('Ваши сохранённые данные · единые фильтры для Обзора и Операций',{exact:true})).toHaveCount(0);
 await expect(filters.getByText(/Категории можно выбрать несколько/)).toHaveCount(0);
 await expect(page.getByText(/не баланс счёта/)).toHaveCount(0);
 const before=await filters.boundingBox();expect(before!.height).toBeLessThan(info.project.name==='mobile'?350:85);
 await trigger.click();const dialog=page.getByRole('dialog',{name:'Выбор категорий'}),search=dialog.getByRole('searchbox');
 await expect(search).toBeFocused();await search.fill('ДОСТАВКА');await expect(dialog.getByRole('checkbox',{name:'Категория «Продукты»',exact:true})).toBeVisible();
 await expect(dialog.getByRole('checkbox')).toHaveCount(2);await dialog.getByRole('checkbox',{name:'Подкатегория «Доставка продуктов» в «Продукты»',exact:true}).check();
 await search.fill('питомцы');await dialog.getByRole('checkbox').check();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(trigger).toBeFocused();await expect(trigger).toHaveText('Выбрано несколько');
 await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/summary').at(-1)?.body.categoryIds).toEqual([delivery,pets]);
 expect((await filters.boundingBox())!.height).toBe(before!.height);
 await filters.getByRole('button',{name:'Показать подробности фильтров'}).click();const details=filters.getByRole('region',{name:'Подробности общих фильтров'});await expect(details).toContainText('Продукты → Доставка продуктов');await expect(details).toContainText('Питомцы с очень длинным названием');
 await filters.getByRole('button',{name:'Скрыть подробности фильтров'}).click();expect((await filters.boundingBox())!.height).toBe(before!.height);
 await page.getByRole('link',{name:'Операции',exact:true}).click();await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/operations-page').at(-1)?.body.query).toMatchObject({filter:{categoryIds:[delivery,pets]}});
 await page.screenshot({path:info.outputPath('compact-global-filters.png'),fullPage:true});
 await trigger.click();await dialog.getByRole('searchbox').fill('несуществующая категория');await expect(dialog.getByText('Категории не найдены')).toBeVisible();await dialog.getByRole('button',{name:'Сбросить',exact:true}).click();await expect(dialog.getByRole('searchbox')).toHaveValue('');await expect(dialog.getByRole('checkbox',{checked:true})).toHaveCount(0);await dialog.getByRole('button',{name:'Закрыть категории'}).click();await expect(trigger).toHaveText('Все категории');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);expect(await page.evaluate(()=>innerWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);expect(h.calls.filter(c=>['/finance/preview','/finance/commit'].includes(c.path))).toHaveLength(0);
});

test('category branches distinguish a whole category from one child and reset only the intended filters',async({page},info)=>{
 const h=await setup(page),root=crypto.randomUUID(),child=crypto.randomUUID(),other=crypto.randomUUID();
 h.state.categories=[{id:root,name:'Транспорт',parentId:null,role:'expense',hidden:false},{id:child,name:'Такси',parentId:root,role:'expense',hidden:false},{id:other,name:'Метро',parentId:root,role:'expense',hidden:false}];
 await page.getByRole('button',{name:'Обновить данные',exact:true}).click();const filters=page.getByRole('group',{name:'Общие фильтры',exact:true});
 await filters.getByLabel('С даты',{exact:true}).fill('2026-09-01');await filters.getByRole('button',{name:'Банки и счета',exact:true}).click();await page.getByRole('dialog',{name:'Выбор банков и счетов',exact:true}).getByRole('checkbox').first().check();await page.keyboard.press('Escape');
 const trigger=filters.getByRole('button',{name:'Категории',exact:true});await trigger.click();const dialog=page.getByRole('dialog',{name:'Выбор категорий'}),parent=dialog.getByRole('checkbox',{name:'Категория «Транспорт»',exact:true}),leaf=dialog.getByRole('checkbox',{name:'Подкатегория «Такси» в «Транспорт»',exact:true});
 await leaf.check();await expect(parent).toHaveJSProperty('indeterminate',true);await parent.check();await expect(leaf).toBeChecked();await expect(leaf).toBeEnabled();await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/summary').at(-1)?.body.categoryIds).toEqual([child,other]);
 await leaf.uncheck();await expect(parent).toHaveJSProperty('indeterminate',true);await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/summary').at(-1)?.body.categoryIds).toEqual([other]);await parent.check();await parent.uncheck();await leaf.check();await expect(parent).not.toBeChecked();await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/summary').at(-1)?.body.categoryIds).toEqual([child]);
 await dialog.screenshot({path:info.outputPath('category-filter-menu.png')});await dialog.getByRole('button',{name:'Сбросить',exact:true}).click();await page.keyboard.press('Escape');
 await expect(trigger).toHaveText('Все категории');await expect(filters.getByLabel('С даты',{exact:true})).toHaveValue('01.09.2026');await expect(filters.getByRole('button',{name:'Банки и счета',exact:true})).toContainText(h.state.accounts[0]!.name);
 await filters.getByRole('button',{name:'Сбросить',exact:true}).click();await expect(filters.getByLabel('С даты',{exact:true})).toHaveValue('');await expect(filters.getByRole('button',{name:'Банки и счета',exact:true})).toContainText('Все банки и счета');await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/summary').at(-1)?.body).toEqual({compact:true});
});

test('attention toggles its visible filter while preserving text filters and multi-select review choices',async({page})=>{
 const h=await setup(page),first=h.state.operations[0]!;
 h.state.operations.push({...structuredClone(first),id:crypto.randomUUID(),reviewReasons:[],comment:'Other'});
 first.comment='Synthetic match';
 await page.getByRole('link',{name:'Операции',exact:true}).click();
 await page.getByRole('group',{name:'Общие фильтры'}).getByRole('button',{name:'Сбросить',exact:true}).click();
 await page.locator('summary').filter({hasText:'Дополнительные фильтры'}).click();
 const review=page.getByRole('button',{name:'Состояние проверки',exact:true});
 await review.click();
 const picker=page.getByRole('dialog',{name:'Состояние проверки'});
 await picker.getByRole('checkbox',{name:'Нужно решение',exact:true}).check();
 await picker.getByRole('checkbox',{name:'Проверить желательно',exact:true}).check();
 await picker.getByRole('button',{name:'Закрыть: Состояние проверки'}).click();
 await expect(page.getByText('Нужно решение, Проверить желательно',{exact:true})).toBeVisible();
 await page.getByLabel('Комментарий содержит',{exact:true}).fill('Synthetic');
 const button=page.getByRole('button',{name:'Показать требующие внимания',exact:true});
 await button.click();
 await expect(button).toHaveAttribute('aria-pressed','true');
 await expect.poll(()=>((h.calls.filter(c=>c.path==='/finance/operations-page').at(-1)?.body.query as {filter:unknown})?.filter)).toMatchObject({attention:true,comment:'Synthetic',statuses:['required','recommended']});
 await button.click();
 await expect(button).toHaveAttribute('aria-pressed','false');
 await expect.poll(()=>((h.calls.filter(c=>c.path==='/finance/operations-page').at(-1)?.body.query as {filter:unknown})?.filter)).toEqual({comment:'Synthetic',statuses:['required','recommended']});
 await page.getByRole('link',{name:'Обзор',exact:true}).click();
 await page.getByRole('region',{name:'Основные показатели'}).getByRole('button',{name:/Требуют внимания/}).click();
 await expect(button).toHaveAttribute('aria-pressed','true');
 await page.locator('summary').filter({hasText:'Дополнительные фильтры'}).click();
 await expect(page.getByLabel('Комментарий содержит',{exact:true})).toHaveValue('Synthetic');
 await button.click();
 await expect(button).toHaveAttribute('aria-pressed','false');
 await page.getByText('Вид списка',{exact:true}).click();
 await chooseOption(page.getByLabel('Операций за раз',{exact:true}),'10');
 await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/operations-page').at(-1)?.body.displayLimit).toBe(10);
});
test('numbered operation pages replace rows, preserve selection and return to page one after changing a filter',async({page})=>{
 const h=await setup(page),first=h.state.operations[0]!;
 h.state.operations=Array.from({length:53},(_,i)=>({...structuredClone(first),id:crypto.randomUUID(),classification:{...structuredClone(first.classification),merchant:{...first.classification.merchant,value:'Page shop '+i}},description:i===0?'Unique page marker':''}));
 await page.getByRole('link',{name:'Операции',exact:true}).click();
 const list=page.getByRole('list',{name:'Сохранённые операции'}),pages=page.getByRole('navigation',{name:'Страницы операций'});
 await expect(list.getByRole('listitem')).toHaveCount(50);const firstId=await list.locator('[data-operation]').first().getAttribute('data-operation');
 await list.getByRole('checkbox').first().check();await pages.getByRole('button',{name:'Страница 2',exact:true}).click();
 await expect(pages.getByRole('button',{name:'Страница 2',exact:true})).toHaveAttribute('aria-current','page');
 await expect(list.getByRole('listitem')).toHaveCount(3);await expect(list.locator('[data-operation="'+firstId+'"]')).toHaveCount(0);
 await expect(page.getByRole('status').filter({hasText:'Выбрано: 1'})).toBeVisible();
 await list.getByRole('checkbox').first().check();await pages.getByRole('button',{name:'Страница 1',exact:true}).click();await expect(list.getByRole('checkbox').first()).toBeChecked();
 await expect(page.getByRole('status').filter({hasText:'Выбрано: 2'})).toBeVisible();
 await pages.getByRole('button',{name:'Страница 2',exact:true}).click();await expect(list.getByRole('listitem')).toHaveCount(3);
 await page.getByLabel('Поиск в операциях',{exact:true}).fill('Unique page marker');
 await expect(list.getByRole('listitem')).toHaveCount(1);await expect(pages).toHaveCount(0);
 await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/operations-page').at(-1)?.body.page).toBe(1);
});

test('rule from a row can reset its draft and previews historical application without silently saving',async({page})=>{
 const h=await setup(page);
 await settingsImpact(page,h,{kind:'create_rule_with_history',ruleName:'Правило: Synthetic shop',selectedCount:2,changedOperationIds:[h.detail.id],protectedOperationIds:['protected'],conflictingOperationIds:[]});
 await page.getByRole('link',{name:'Операции',exact:true}).click();
 const row=page.getByRole('list',{name:'Сохранённые операции'}).getByRole('button');
 await row.click({button:'right'});await page.getByRole('button',{name:'Создать правило',exact:true}).click();
 const editor=page.getByRole('dialog',{name:'Создание правила'});
 const history=editor.getByLabel('Применить к уже загруженным операциям');
 await editor.getByLabel('Название правила').fill('Черновик');
 await history.check();await editor.getByRole('button',{name:'Сбросить',exact:true}).click();
 await expect(editor.getByLabel('Название правила')).toHaveValue('Правило: Synthetic shop');await expect(history).not.toBeChecked();
 await history.check();await editor.getByRole('button',{name:'Создать и применить правило',exact:true}).click();
 const confirmation=page.getByRole('region',{name:'Правило и прошлые операции'});
 await expect(confirmation).toContainText('Подходят по условиям за всю историю');await expect(confirmation).toContainText('Останутся без изменений');
 expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);expect(h.calls.filter(c=>c.path==='/finance/preview').at(-1)?.body.intent).toMatchObject({kind:'create_rule_with_history',patch:{enabled:true,conditions:{merchantEquals:'Synthetic shop'}}});
 await page.getByRole('button',{name:'Назад',exact:true}).click();await expect(editor).toBeVisible();await expect(history).toBeChecked();
});

test('Ctrl+A selects only the visible page; the button and all-rows view retain their separate meanings',async({page})=>{
 const h=await setup(page),template=h.state.operations[0]!;
 h.state.operations=Array.from({length:53},(_,i)=>({...structuredClone(template),id:crypto.randomUUID(),comment:'Test row '+i}));
 await page.getByRole('link',{name:'Операции',exact:true}).click();
 const list=page.getByRole('list',{name:'Сохранённые операции'});
 await expect(list.getByRole('checkbox')).toHaveCount(50);
 await page.getByRole('heading',{name:'Операции',exact:true}).click();await page.keyboard.press('Control+a');
 await expect(list.getByRole('checkbox',{checked:true})).toHaveCount(50);
 await expect(page.getByRole('status').filter({hasText:'Найдено операций:'})).toContainText('Выбрано: 50');
 await page.getByRole('button',{name:'Страница 2',exact:true}).click();await expect(list.getByRole('checkbox')).toHaveCount(3);
 await list.getByRole('button').first().focus();await page.keyboard.press('Shift+F10');
 await expect(page.getByRole('dialog',{name:'Действия операции'})).toHaveCount(0);
 await page.keyboard.press('Control+a');await expect(page.getByRole('status').filter({hasText:'Найдено операций:'})).toContainText('Выбрано: 3');
 await page.getByRole('button',{name:'Выбрать все',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Найдено операций:'})).toContainText('Выбрано: 53');
 await expect(page.getByText('Загружаем операции…',{exact:true})).toHaveCount(0);
 await page.getByText('Вид списка',{exact:true}).click();await chooseOption(page.getByLabel('Операций за раз',{exact:true}),'all');
 await expect(list.getByRole('checkbox')).toHaveCount(53);await expect(page.getByRole('navigation',{name:'Страницы операций'})).toHaveCount(0);
 const request=h.calls.filter(c=>c.path==='/finance/operations-page').at(-1)!.body;
 expect(request.displayLimit).toBe('all');expect(request.page).toBeUndefined();
});

test('deletion detail expands the sealed selection beyond the compact workspace',async({page})=>{
 const h=await setup(page);
 const extra={...structuredClone(h.state.operations[0]!),id:crypto.randomUUID()};extra.classification.merchant.value='Outside compact summary';h.state.operations.push(extra);
 await page.route('http://127.0.0.1:3000/finance/summary',async route=>{
  if(route.request().method()==='OPTIONS')return route.fallback();
  await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{...h.state,operations:[h.state.operations[0]]}});
 });
 await deletionFixture(page,h);
 await page.getByRole('link',{name:'Операции',exact:true}).click();
 await page.getByRole('button',{name:'Выбрать все',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'Найдено операций:'})).toContainText('Выбрано: 2');
 await page.getByRole('button',{name:'Удалить выбранные',exact:true}).click();
 await expect(page.getByRole('list',{name:'Удаляемые операции'})).toHaveCount(0);
 await page.getByText('Показать состав операций',{exact:true}).click();
 const list=page.getByRole('list',{name:'Удаляемые операции'});
 await expect(list.getByRole('listitem')).toHaveCount(2);await expect(list).toContainText('Outside compact summary');
 expect(h.calls.filter(c=>c.path==='/finance/operations-selection').at(-1)?.body.ids).toEqual([extra.id]);
 expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
});

test('counterparty split shows one dialog and one search frame; operation checkbox stays left',async({page})=>{
 const h=await setup(page),source=h.state.counterparties[0]!,target={id:crypto.randomUUID(),name:'Другой получатель',state:'registered' as const};
 h.state.counterparties.push(target);
 h.state.operations[0]!.classification.counterparty.value=source.id;
 await page.getByRole('button',{name:'Обновить данные',exact:true}).click();
 await section(page,'Контрагенты');
 const edit=page.getByRole('dialog',{name:'Изменить контрагента',exact:true});
 await page.locator('article').filter({hasText:source.name}).getByRole('button',{name:'Изменить',exact:true}).click();
 await edit.getByRole('button',{name:'Разделить',exact:true}).click();
 const split=page.getByRole('dialog',{name:'Разделить',exact:true});
 await expect(split).toBeVisible();
 await expect(edit).toBeHidden();
 await expect(page.locator('[data-cashneuro-dialog="overlay"]:visible')).toHaveCount(1);
 await chooseOption(split.getByLabel('Кому перенести',{exact:true}),target.id);
 const input=split.getByRole('searchbox',{name:'Найти операцию'});
 await expect(input).toBeVisible();
 const search=await input.evaluate(el=>[getComputedStyle(el).borderTopWidth,getComputedStyle(el.parentElement!).borderTopWidth]);
 expect(search).toEqual(['0px','1px']);
 const list=split.getByRole('list'),checkbox=list.getByRole('checkbox').first();
 await expect(checkbox).toBeVisible();
 expect(await checkbox.evaluate(el=>el.getBoundingClientRect().right<el.nextElementSibling!.getBoundingClientRect().left)).toBe(true);
 await input.fill('unmatched-query-xyz');
 await expect(split.getByText('Операции не найдены.',{exact:true})).toBeVisible();
 await expect(list).toHaveCount(0);
 await split.getByRole('button',{name:'Отменить',exact:true}).click();
 await expect(edit).toBeVisible();
});

test('public pricing opens the selected renewal and shares the support dialog',async({page})=>{
 await setup(page);
 const tariffs=[{id:'short',name:'2 недели',duration:{kind:'days',count:14},priceMinor:'21900',aiQuota:5000,active:true,publicVisible:true,availableForNew:true},{id:'first',name:'1 месяц',duration:{kind:'calendar_months',count:1},priceMinor:'39900',aiQuota:10000,active:true,publicVisible:true,availableForNew:true},{id:'long',name:'3 месяца',duration:{kind:'calendar_months',count:3},priceMinor:'104900',aiQuota:10000,active:true,publicVisible:true,availableForNew:true}];
 const cycle={anchorAt:'2026-10-05T12:00:00Z',accessEnd:'2026-12-05T12:00:00Z',timezone:'Europe/Moscow',calendarMonths:2,extraDays:0,revision:1};
 const paymentWrites:string[]=[];
 await page.route('http://127.0.0.1:3000/access/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,headers={'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
  if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
  const baseState={cycle,tariffs,request:{renewalState:'open',status:'awaiting_payment'},plannedEnds:{short:'2026-12-19T12:00:00Z',first:'2027-01-05T12:00:00Z',long:'2027-03-05T12:00:00Z'}};
  if(path.endsWith('/tariffs'))return route.fulfill({headers,json:{tariffs}});
  if(path.endsWith('/billing'))return route.fulfill({headers,json:{enabled:false,tariffs,renewal:null,order:null}});
  if(path.endsWith('/renewal'))return route.fulfill({headers,json:baseState});
  if(req.method()==='POST')paymentWrites.push(path);
  return route.fallback();
 });
 await page.goto(new URL('/tariffs',base).href);
 await expect(page).toHaveURL(/\/price$/);
 await expect(page.getByRole('link',{name:'Получить доступ',exact:true})).toHaveCount(0);
 await page.getByRole('article').filter({hasText:'3 месяца'}).getByRole('link',{name:'Выбрать тариф',exact:true}).click();
 const renewal=page.getByRole('dialog',{name:'Продление доступа',exact:true});
 await expect(renewal.getByRole('combobox',{name:'Период продления',exact:true})).toHaveAttribute('value','long');
 await expect(renewal.getByText('Доступ после продления')).toBeVisible();
 await expect(renewal).toContainText('5 мар.');
 await expect(renewal).not.toContainText('сохраняет текущий остаток');
 const period=renewal.getByRole('combobox',{name:'Период продления'});
 const periodFont=await period.evaluate(node=>getComputedStyle(node).fontSize);
 await period.press('ArrowDown');
 const picker=page.getByRole('dialog',{name:'Период продления'});
 const search=picker.getByRole('searchbox');
 await expect(search).toBeFocused();
 await search.fill('2 недели');
 await search.press('ArrowDown');
 const short=picker.getByRole('radio',{name:/2 недели/});
 await expect(short).toBeFocused();
 await expect(short.locator('..')).toHaveCSS('font-size',periodFont);
 await short.press('Enter');
 await expect(period).toBeFocused();
 await expect(renewal).toContainText(/Лимит Анализатора на новый период — 5\s000 единиц\./);
 await expect(renewal).not.toContainText('за период');
 await chooseOption(period,'first');
 await expect(renewal).toContainText('5 янв.');
 await chooseOption(renewal.getByRole('combobox',{name:'Период продления'}),'long');
 await expect(page.getByRole('heading',{name:'Аккаунт',exact:true})).toHaveCount(0);
 await expect(renewal.getByRole('button',{name:/Перейти к оплате · 1.?049/})).toBeDisabled();
 await expect(renewal.getByLabel('Имя отправителя')).toHaveCount(0);
 expect(paymentWrites).toHaveLength(0);
 await renewal.getByRole('button',{name:'Закрыть: Продление доступа',exact:true}).click();
 await page.getByRole('button',{name:'Поддержка',exact:true}).click();
 const support=page.getByRole('dialog',{name:'Поддержка CashNeuro'});
 await expect(support.getByText('Напишите нам — поможем разобраться.')).toBeVisible();
 await expect(support.getByRole('button',{name:'Написать письмо'})).toHaveCount(0);
 await page.context().grantPermissions(['clipboard-read','clipboard-write']);
 await support.getByRole('button',{name:'Скопировать адрес'}).click();
 await expect(support.getByText('Адрес скопирован.',{exact:true})).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe('support@cashneuro.ru');
});

test('credit accounting confirmation explains both models even when totals stay equal',async({page})=>{
 const h=await setup(page);
 await page.route('http://127.0.0.1:3000/finance/preview',async route=>{
  if(route.request().method()==='OPTIONS')return route.fallback();
  const body=route.request().postDataJSON();
  expect(body.intent.kind).toBe('analytics');
  return route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{status:'previewed',actionId:body.actionId,intent:body.intent,impact:{before:h.state.summary,after:h.state.summary,affectedOperationIds:[],dependencyConflicts:[],changes:[{kind:'analytics',before:{values:{loan_mode:'cashflow'}},after:{values:{loan_mode:'economic'}}}]}}});
 });
 await section(page,'Аналитика');
 await chooseOption(page.getByRole('combobox',{name:'Общая модель учёта',exact:true}),'economic');
 const confirm=page.getByRole('dialog',{name:'Изменить учёт кредитных платежей',exact:true});
 await expect(confirm).toContainText('В расходах весь платёж');
 await expect(confirm).toContainText('В расходах только проценты, комиссии и страховка');
 await expect(confirm.getByRole('button',{name:'Изменить учёт',exact:true})).toBeEnabled();
 await confirm.getByRole('button',{name:'Отмена',exact:true}).click();
 expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
});

test('exclusion uses matching impact rows and Back restores the selected operation',async({page})=>{
 const h=await setup(page);
 await page.route('http://127.0.0.1:3000/finance/preview',async route=>{
  if(route.request().method()==='OPTIONS')return route.fallback();
  const body=route.request().postDataJSON();
  expect(body.intent.operationIds).toEqual([h.detail.id]);
  return route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{status:'previewed',actionId:body.actionId,impact:{before:h.state.summary,after:{...h.state.summary,netExpensesMinor:'0'},affectedOperationIds:[h.detail.id],dependencyConflicts:[],details:{kind:'bulk_operations',operationIds:body.intent.operationIds,patch:body.intent.patch,warnings:[]}}}});
 });
 await section(page,'Аналитика');
 await page.getByRole('button',{name:'Выбрать для исключения',exact:true}).click();
 const picker=page.getByRole('dialog',{name:'Исключить операции',exact:true});
 const checkbox=picker.getByRole('checkbox').first();
 await checkbox.check();
 await picker.getByRole('button',{name:/^Продолжить/}).click();
 const confirm=page.getByRole('dialog',{name:'Исключение операций',exact:true});
 await expect(confirm).toBeVisible();
 await expect(picker).toBeHidden();
 const rows=confirm.locator('dl').first();
 await expect(rows).toContainText('Расходы');
 await expect(rows).toContainText('Затронутые операции');
 expect(await rows.locator('dt').evaluateAll(nodes=>new Set(nodes.map(n=>getComputedStyle(n).fontSize)).size)).toBe(1);
 await confirm.getByRole('button',{name:'Назад',exact:true}).click();
 await expect(checkbox).toBeChecked();
 expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
});

test('operation actions fit without horizontal scrolling',async({page})=>{
 await setup(page);
 await page.getByRole('link',{name:'Операции',exact:true}).click();
 await page.locator('button[data-operation]').first().click({button:'right'});
 const dialog=page.getByRole('dialog',{name:'Действия операции'});
 const buttons=await dialog.getByRole('button').filter({hasText:/Копировать ID|История операции|Создать правило|Удалить операцию/}).all();
 expect(buttons).toHaveLength(4);
 const boxes=await Promise.all(buttons.map(button=>button.boundingBox()));
 expect(boxes.every(Boolean)).toBe(true);
 if(page.viewportSize()!.width>680)expect(new Set(boxes.map(box=>box?.y)).size).toBe(1);
 expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 for(const button of buttons)await expect(button).toBeInViewport();
});

test('workspace footer follows the main gutters and category names share their size',async({page})=>{
 const h=await setup(page);
 const parent=crypto.randomUUID(),child=crypto.randomUUID();
 h.state.categories=[{id:parent,name:'Банковские услуги',parentId:null,role:'expense',hidden:false},{id:child,name:'Комиссии',parentId:parent,role:'expense',hidden:false}];
 await page.getByRole('button',{name:'Обновить данные',exact:true}).click();
 await section(page,'Категории');
 await page.getByRole('button',{name:/^Банковские услуги/}).click();
 const root=page.getByText('Банковские услуги',{exact:true}),leaf=page.getByText('Комиссии',{exact:true});
 const font=await root.evaluate(node=>getComputedStyle(node).fontSize);
 await expect(leaf).toHaveCSS('font-size',font);
 await expect(root).toHaveCSS('font-weight','600');
 await expect(leaf).toHaveCSS('font-weight','400');
 const footer=page.getByRole('contentinfo');
 const bounds=async(node:typeof footer)=>node.evaluate(element=>{
  const rect=element.getBoundingClientRect(),css=getComputedStyle(element);
  return [rect.left+parseFloat(css.paddingLeft),rect.right-parseFloat(css.paddingRight)];
 });
 expect(await bounds(footer)).toEqual(await bounds(page.getByRole('main')));
});

test('public footer aligns the desktop columns and contacts show a plain address',async({page})=>{
 await page.goto(base+'contacts');
 const footer=page.getByRole('contentinfo');
 await expect(footer.getByText('Поможем разобраться')).toBeVisible();
 await expect(footer.getByRole('navigation').getByRole('link')).toHaveCount(6);
 const main=page.getByRole('main');
 await expect(main.getByText('support@cashneuro.ru',{exact:true})).toBeVisible();
 await expect(main.getByRole('link',{name:'support@cashneuro.ru'})).toHaveCount(0);
 await expect(main.getByRole('button',{name:'Скопировать адрес'})).toHaveCount(0);
 if(page.viewportSize()!.width>600){
  const rows=await Promise.all([footer.getByText('support@cashneuro.ru',{exact:true}),footer.getByRole('link',{name:'Контакты',exact:true}),footer.getByRole('link',{name:'Конфиденциальность',exact:true})].map(node=>node.boundingBox()));
  const bottoms=rows.map(box=>box!.y+box!.height);
  expect(Math.max(...bottoms)-Math.min(...bottoms)).toBeLessThanOrEqual(1);
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('device timezone stays selected and shows the actual zone in the account',async({page})=>{
 await setup(page);
 const browserZone=await page.evaluate(()=>Intl.DateTimeFormat().resolvedOptions().timeZone);
 let preference={timezone:'Pacific/Honolulu',followsDevice:false};
 const saved:unknown[]=[];
 const headers={'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'};
 await page.route('http://127.0.0.1:3000/session',route=>route.fulfill({headers,json:{name:'Искусственный пользователь',scope:'active',capabilities:['finance'],indefinite:true,...preference}}));
 await page.route('http://127.0.0.1:3000/access/profile/timezone',async route=>{
  if(route.request().method()==='OPTIONS')return route.fallback();
  const body=route.request().postDataJSON();
  saved.push(body);
  preference={timezone:body.timezone,followsDevice:body.followsDevice};
  await route.fulfill({headers,json:preference});
 });
 await page.getByRole('button',{name:'Аккаунт',exact:true}).click();
 await page.getByRole('button',{name:'Изменить: часовой пояс'}).click();
 let dialog=page.getByRole('dialog',{name:'Часовой пояс'});
 await dialog.getByRole('button',{name:'Часовой пояс',exact:true}).click();
 await page.getByRole('radio',{name:'Как на устройстве',exact:true}).click();
 await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();
 await expect(dialog).toBeHidden();
 expect(saved).toEqual([{timezone:browserZone,followsDevice:true}]);
 const account=page.getByRole('dialog',{name:'Аккаунт',exact:true});
 await expect(account.getByText(/UTC/)).toBeVisible();
 await page.getByRole('button',{name:'Изменить: часовой пояс'}).click();
 dialog=page.getByRole('dialog',{name:'Часовой пояс'});
 await expect(dialog.getByRole('button',{name:'Часовой пояс',exact:true})).toHaveText('Как на устройстве');
});
