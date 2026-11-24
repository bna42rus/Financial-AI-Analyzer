import {calculateFinancial} from '../../../packages/analyzer/src/calculators';
import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import {createServer} from 'vite';
import type {ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {syntheticDetail,syntheticPreview} from '../test/synthetic-finance';
import {aggregate} from '../../../packages/finance-core/src/graph';
import {calculateOverview,defaultOverview,parseOverviewView} from '../../../packages/finance-core/src/overview';
import {queryOperations,parseOperationsQuery} from '../../../packages/finance-core/src/operations';
import type {FinanceState} from '../src/finance-client';
import {interpret,registryVersion} from '../../../packages/analyzer/src/registry';
import type {Chat,Message} from '../../../packages/analyzer/src/types';
import {calculateWidget,parseWidget} from '../../../packages/finance-core/src/overview';
let server:ViteDevServer,base:string;
test.beforeAll(async()=>{server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),cacheDir:fileURLToPath(new URL('../node_modules/.vite-overview-'+process.pid,import.meta.url)),server:{host:'127.0.0.1',port:0},define:{'import.meta.env.VITE_API_ORIGIN':JSON.stringify('http://127.0.0.1:3000')}});await server.listen();base=server.resolvedUrls!.local[0]!;});
test.afterAll(async()=>{await server?.close();});
async function setup(page:Page,beforeOpen?:()=>Promise<void>,customerBudget?:{limit:number;remaining:number;extra:number;resetAt:string}){await page.clock.setFixedTime(new Date('2026-09-10T12:00:00Z'));const consoleKeys:string[]=[];page.on('console',m=>{if(m.text().includes('same key'))consoleKeys.push(m.text());});const detail=syntheticDetail(),category=crypto.randomUUID(),other=crypto.randomUUID(),op={...detail.projection,classification:detail.semantics,comment:''};op.date={precision:'day',date:'2026-09-03'};op.amountMinor='-10000';op.parts=op.parts.map(p=>({...p,amountMinor:'-10000',categoryId:category,role:'expense' as const,included:true}));op.classification.category.value=category;op.classification.merchant.value='Synthetic shop';op.reviewReasons=[];const second=structuredClone(op);second.id=crypto.randomUUID();second.amountMinor='-20000';second.parts[0]!.amountMinor='-20000';second.parts[0]!.categoryId=other;second.classification.category.value=other;second.classification.merchant.value='Synthetic shop plus';second.date={precision:'day',date:'2026-09-05'};
 const state:FinanceState={generation:detail.generation,revision:'1',accounts:[{id:detail.source.accountId,name:'Synthetic account',bankId:'tbank',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],mergedAccounts:[],categories:[{id:category,name:'Synthetic food',parentId:null,role:'expense',hidden:false},{id:other,name:'Synthetic other',parentId:null,role:'expense',hidden:false}],counterparties:[],rules:[],operations:[op,second],summary:aggregate([op,second])},views:any[]=[],calls:{path:string;body:Record<string,any>}[]=[],pending=new Map<string,Record<string,any>>();let blocked=false;const chats:Chat[]=[];let failNext=false,failActionNext=false;
 await page.route('http://127.0.0.1:3000/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname,body=req.postDataJSON()??{},headers={'Access-Control-Allow-Origin':req.headers().origin??new URL(base).origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});calls.push({path,body});let result:unknown={},status=200;
 if(path==='/session')result={name:'Synthetic user',scope:blocked?'restricted':'active',capabilities:['finance'],indefinite:true,timezone:'Europe/Moscow'};
 else if(path==='/access/tariffs')result={tariffs:[]};else if(path.startsWith('/access/')){status=404;result={code:'NOT_FOUND'};}
 else if(blocked&&path.startsWith('/finance/')){status=403;result={code:'FINANCE_ACCESS_REQUIRED'};}
 else if(path==='/finance/summary'||path==='/finance/state')result={...state,summary:aggregate(state.operations,body)};
 else if(path==='/finance/imports')result={batches:[],nextCursor:null};
 else if(path==='/finance/review-sessions')result={sessions:[]};
 else if(path==='/finance/analyzer-state')result={customerBudget,chats:chats.map(c=>({...c,matches:!body.search||(c.title+' '+c.messages.map(m=>m.question).join(' ')).toLocaleLowerCase('ru').includes(body.search.toLocaleLowerCase('ru')),messages:c.id===(body.chatId??chats[0]?.id)?c.messages:[]})),quota:{available:false,limit:null,used:0,remaining:null,periodStart:null,resetAt:null,warning:null},providerAvailable:false,registryVersion};
 else if(path==='/finance/analyzer-chat'){let c=chats.find(c=>c.id===body.id);if(body.create&&!c){c={id:body.id,title:'Новый диалог',pinned:false,createdAt:new Date().toISOString(),modifiedAt:new Date().toISOString(),messages:[]};chats.unshift(c);}if(body.delete)chats.splice(chats.findIndex(c=>c.id===body.id),1);else if(c){if(body.title)c.title=body.title;if(body.pinned!==undefined)c.pinned=body.pinned;}result={id:body.id};}
 else if(path==='/finance/analyzer-query'){const c=chats.find(c=>c.id===body.chatId)!;let m=c.messages.find(m=>m.id===body.id);if(!m){const prior=c.messages.find(m=>m.id===body.contextId),i=interpret(body.text,body.filter,prior?.answer.query,new Date('2026-10-11T12:00:00Z'));let answer:any={mode:i.relevance==='unrelated'?'redirect':i.relevance==='ambiguous'?'clarification':'unavailable',text:i.relevance==='unrelated'?'Я помогаю разбираться в финансах.':i.relevance==='ambiguous'?'Уточните показатель и период.':'Для такого вопроса нужна подключённая AI-модель.',registryVersion};if(i.query){const w=parseWidget({id:crypto.randomUUID(),name:'Расходы',metrics:[i.query.metric],grouping:i.query.grouping,comparison:{kind:i.query.comparison},filter:i.query.filter,chart:'table'});answer={...answer,mode:'deterministic',text:'Расчёт по вашим сохранённым операциям.',query:i.query,widget:w,result:calculateWidget(w,state.operations,state,{}),generation:state.generation,revision:state.revision,accountCount:1,periodFromQuestion:i.periodFromQuestion,followUp:i.followUp,computedAt:'2026-10-11T12:00:00Z'};c.title=body.text.slice(0,100);}m={id:body.id,question:body.text,answer,createdAt:new Date().toISOString(),actionId:null};c.messages.push(m);}result={id:m.id,answer:m.answer};if(failNext){failNext=false;return route.abort('failed');}}
 else if(path==='/finance/analyzer-propose'){const m=chats.flatMap(c=>c.messages).find(m=>m.id===body.tool.answerId)!;m.actionId=body.actionId;m.outcome={status:'previewed',tool:body.tool,confirmation:true};pending.set(body.actionId,body.tool.name==='finance_action'?body.tool.intent:{kind:'bulk_operations',operationIds:state.operations.map(o=>o.id),patch:body.tool.name==='set_inclusion'?{analyticsOverride:body.tool.value}:body.tool.patch});result={...syntheticPreview(body.actionId,detail),impact:{...syntheticPreview(body.actionId,detail).impact,details:{kind:pending.get(body.actionId)!.kind,operationIds:state.operations.map(o=>o.id)}},generation:state.generation,requiresConfirmation:true};}
 else if(path==='/finance/overview-views')result={views};
 else if(path==='/finance/overview')result={generation:state.generation,revision:state.revision,timezone:'Europe/Moscow',budgetOptions:[],...calculateOverview(state.operations,state,body.filter??{},body.widgets??defaultOverview().widgets)};
 else if(path==='/finance/operations-views')result={views:[]};
 else if(path==='/finance/operations-page'){const q=parseOperationsQuery(body.query??{}),r=queryOperations(state.operations,state,q);result={...r,operations:r.operations.slice(0,50),generation:state.generation,revision:state.revision,workspaceTotal:state.operations.length,offset:0,nextCursor:null};}
 else if(path==='/finance/operation')result={...detail,projection:state.operations.find(o=>o.id===body.id),revision:state.revision};
 else if(path==='/finance/preview'){pending.set(body.actionId,body.intent);result={...syntheticPreview(body.actionId,detail),impact:{before:state.summary,after:state.summary,affectedOperationIds:[],dependencyConflicts:[],details:{kind:body.intent.kind,name:body.intent.name,widgets:body.intent.definition?.widgets.length,operationsChanged:0}}};}
 else if(path==='/finance/commit'){const intent=pending.get(body.actionId)!;if(intent.kind==='save_overview_view'){const saved={id:intent.id,name:intent.name,isDefault:intent.isDefault,definition:parseOverviewView(intent.definition),dependencyStatus:'ready' as const,revision:'1',position:views.length,modifiedAt:'2026-10-11T00:00:00Z'};if(intent.isDefault)views.forEach(v=>v.isDefault=false);const index=views.findIndex(v=>v.id===intent.id);if(index<0)views.push(saved);else views[index]=saved;}if(intent.kind==='delete_overview_view')views.splice(views.findIndex(v=>v.id===intent.id),1);state.revision=String(Number(state.revision)+1);result={status:'committed',actionId:body.actionId,generation:state.generation,revision:state.revision};}
 if(failActionNext&&path==='/finance/analyzer-propose'){failActionNext=false;return route.abort();}
 await route.fulfill({status,headers,json:result});
 });if(beforeOpen)await beforeOpen();await page.goto(base+'#workspace');await expect(page.getByRole('navigation',{name:'Разделы сайта',exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'Основные показатели'})).toBeVisible();await page.getByRole('link',{name:'Анализатор',exact:true}).click();await expect(page.getByRole('region',{name:'Финансовый диалог'})).toBeVisible();return {consoleKeys,state,chats,views,calls,category,other,fail:()=>{failNext=true;},failAction:()=>{failActionNext=true;},block:()=>{blocked=true;}};}

const log=(page:Page)=>page.getByRole('log',{name:'Сообщения диалога'});
async function send(page:Page,text:string){const input=page.getByLabel('Ваш финансовый вопрос',{exact:true});await input.fill(text);await expect(input).toHaveValue(text);await page.getByRole('button',{name:'Отправить вопрос',exact:true}).click();}
async function history(page:Page){if(page.viewportSize()!.width<700){const button=page.getByRole('button',{name:'Диалоги',exact:true});await expect(button).toBeVisible();await button.click();}}
test('current saved finance calculations, question period, context and exact operations drill',async({page},info)=>{const h=await setup(page);await send(page,'Мои расходы за сентябрь 2026');await expect(log(page)).toContainText('300 ₽');await expect(log(page)).toContainText('Период взят из вопроса');await send(page,'А по категориям?');await expect(log(page).getByRole('table')).toContainText('Synthetic food');await expect(log(page)).toContainText('данные пересчитаны заново');await page.screenshot({path:info.outputPath('analyzer-connected.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await log(page).getByRole('button',{name:'Открыть в Операциях',exact:true}).last().click();await expect(page.getByRole('heading',{name:'Операции',exact:true})).toBeVisible();await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/operations-page').at(-1)?.body.query.filter.from).toBe('2026-09-01');expect(await page.evaluate(()=>Object.keys(sessionStorage))).toEqual([]);});
test('history persists after reload, independent chat scope, explicit delete and rename',async({page})=>{const h=await setup(page);await send(page,'Мои расходы');await expect(log(page)).toContainText('300 ₽');await history(page);await page.getByRole('button',{name:'Настроить диалог: Мои расходы',exact:true}).click();await page.getByLabel('Название диалога',{exact:true}).fill('Saved question');await page.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(page.getByRole('dialog',{name:'Настройки диалога'})).toHaveCount(0);await history(page);await page.getByRole('button',{name:'Новый диалог',exact:true}).filter({visible:true}).click();await send(page,'А по категориям?');await expect(log(page)).toContainText('Уточните показатель');expect(h.chats).toHaveLength(2);await page.reload();await expect(page.getByRole('navigation',{name:'Разделы сайта',exact:true})).toBeVisible();await page.getByRole('link',{name:'Анализатор',exact:true}).click();await history(page);await page.getByRole('button',{name:'Saved question',exact:true}).filter({visible:true}).click();await expect(log(page)).toContainText('300 ₽');await history(page);await page.getByRole('button',{name:'Настроить диалог: Saved question',exact:true}).click();await page.getByRole('dialog',{name:'Настройки диалога'}).getByRole('button',{name:'Удалить',exact:true}).click();expect(h.chats).toHaveLength(2);await page.getByRole('button',{name:'Удалить диалог',exact:true}).click();await expect.poll(()=>h.chats.length).toBe(1);expect(h.state.operations).toHaveLength(2);});
test('local sanitation precedes network and raw query never enters storage or URL',async({page})=>{const h=await setup(page);await send(page,'Карта 4111 1111 1111 1111 someone@example.test');await expect(log(page)).toBeVisible();await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/analyzer-query').length).toBe(1);const b=h.calls.filter(c=>c.path==='/finance/analyzer-query')[0]!.body;expect(b.text).not.toContain('4111');expect(b.text).not.toContain('someone@');expect(page.url()).not.toContain('4111');expect(await page.evaluate(()=>Object.keys(localStorage))).toEqual([]);expect(await page.evaluate(()=>Object.keys(sessionStorage))).toEqual([]);expect(h.consoleKeys).toEqual([]);});
test('lost response retries exact question ID without duplicating saved answer',async({page})=>{const h=await setup(page);h.fail();await send(page,'Мои расходы');await expect(page.getByRole('button',{name:'Повторить тот же вопрос'})).toBeVisible();await page.getByRole('button',{name:'Повторить тот же вопрос'}).click();await expect(log(page)).toContainText('300 ₽');const requests=h.calls.filter(c=>c.path==='/finance/analyzer-query');expect(requests).toHaveLength(2);expect(requests[0]!.body).toEqual(requests[1]!.body);expect(h.chats[0]!.messages).toHaveLength(1);});
test('revoked access during delayed response removes transcript and rejects its late resurrection',async({page})=>{const h=await setup(page);let release!:()=>void,seen!:()=>void,finished!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>seen=r),delivered=new Promise<void>(r=>finished=r);await page.route('http://127.0.0.1:3000/finance/analyzer-query',async route=>{if(route.request().method()==='OPTIONS')return route.fallback();seen();await gate;try{await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{id:crypto.randomUUID(),answer:{text:'Late private result'}}});}catch{}finally{finished();}});await send(page,'Мои расходы');await started;h.block();try{await page.evaluate(()=>document.querySelector<HTMLButtonElement>('button[aria-label="Обновить данные"]')?.click());await expect(page.getByRole('heading',{name:'Доступ ещё не активен',exact:true})).toBeVisible();}finally{release();}await delivered;await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await expect(page.getByRole('region',{name:'Финансовый диалог'})).toHaveCount(0);await expect(page.getByText('Late private result')).toHaveCount(0);});

test('malformed chat response leaves Review and navigation usable and exposes retry',async({page})=>{await setup(page);await page.route('http://127.0.0.1:3000/finance/analyzer-state',async route=>{if(route.request().method()==='OPTIONS')return route.fallback();await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{}});});await page.getByRole('link',{name:'Обзор',exact:true}).click();await page.getByRole('link',{name:'Анализатор',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Не удалось проверить ответ сервера');await expect(page.getByRole('button',{name:'Повторить загрузку диалогов'})).toBeEnabled();await page.getByRole('link',{name:'Операции',exact:true}).click();await expect(page.getByRole('heading',{name:'Операции',exact:true})).toBeVisible();});

test('Analyzer shared filters apply global scope and explicit question dates override it',async({page})=>{const h=await setup(page);const dialog=page.getByRole('group',{name:'Общие фильтры'});await dialog.getByLabel('С даты',{exact:true}).fill('2026-10-01');await dialog.getByLabel('По дату',{exact:true}).fill('2026-10-31');await send(page,'Мои расходы');await expect(log(page)).toContainText('0 ₽');await send(page,'Мои расходы за сентябрь 2026');await expect(log(page)).toContainText('300 ₽');const requests=h.calls.filter(c=>c.path==='/finance/analyzer-query');expect(requests[0]!.body.filter.from).toBe('2026-10-01');expect(h.chats[0]!.messages[1]!.answer.query!.filter.from).toBe('2026-09-01');});


test('chat selection survives a later background search while its first response is delayed',async({page})=>{const h=await setup(page);await send(page,'Мои расходы');await expect(log(page)).toContainText('300 ₽');await history(page);await page.getByRole('button',{name:'Новый диалог',exact:true}).filter({visible:true}).click();await send(page,'А по категориям?');await expect(log(page)).toContainText('Уточните показатель');const wanted=h.chats[1]!.id;let release!:()=>void,seen!:()=>void,hold=true;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>seen=r),reads:string[]=[];await page.route('http://127.0.0.1:3000/finance/analyzer-state',async route=>{if(route.request().method()==='OPTIONS')return route.fallback();const body=route.request().postDataJSON();reads.push(body.chatId);if(body.chatId===wanted&&hold){hold=false;seen();await gate;}await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{chats:h.chats.map(c=>({...c,matches:true,messages:c.id===body.chatId?c.messages:[]})),quota:{available:false,limit:null,used:0,remaining:null,periodStart:null,resetAt:null,warning:null},providerAvailable:false,registryVersion}});});await history(page);await page.getByRole('button',{name:'Мои расходы',exact:true}).filter({visible:true}).click();await started;const priorReads=reads.length;try{await page.getByLabel('Поиск диалогов',{exact:true}).filter({visible:true}).fill('Мои');await expect.poll(()=>reads.length).toBeGreaterThan(priorReads);expect(reads.at(-1)).toBe(wanted);}finally{release();}await expect(log(page)).toContainText('300 ₽');await expect(page.getByRole('dialog',{name:'Диалоги',exact:true})).toHaveCount(0);});


test('editing the next question while a request is in flight preserves the new draft',async({page})=>{const h=await setup(page);let release!:()=>void,seen!:()=>void,hold=true;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>seen=r);await page.route('http://127.0.0.1:3000/finance/analyzer-query',async route=>{if(route.request().method()==='OPTIONS')return route.fallback();if(hold){hold=false;seen();await gate;}return route.fallback();});await send(page,'Мои расходы');await started;const input=page.getByLabel('Ваш финансовый вопрос',{exact:true});try{await history(page);await page.getByLabel('Поиск диалогов',{exact:true}).filter({visible:true}).fill('Новый');await expect.poll(()=>h.calls.some(c=>c.path==='/finance/analyzer-state'&&c.body.search==='Новый')).toBe(true);await expect(page.locator('button[aria-current="true"]').filter({visible:true})).toHaveText('Новый диалог');if(page.viewportSize()!.width<700)await page.getByRole('button',{name:'Закрыть: Диалоги',exact:true}).click();await input.fill('А по категориям?');await expect(page.getByRole('button',{name:'Отправить вопрос',exact:true})).toBeDisabled();}finally{release();}await expect(log(page)).toContainText('300 ₽');await expect(page.getByRole('button',{name:'Отправить вопрос',exact:true})).toBeEnabled();await expect(input).toHaveValue('А по категориям?');await page.getByRole('button',{name:'Отправить вопрос',exact:true}).click();await expect(log(page).getByRole('table')).toContainText('Synthetic food');});


test('calculator answers show the exact assumptions and natural proposals require explicit confirmation',async({page})=>{
 const h=await setup(page),chat={id:crypto.randomUUID(),title:'Расчёты и настройки',pinned:false,createdAt:new Date().toISOString(),modifiedAt:new Date().toISOString(),messages:[] as Message[]};
 const calculation=calculateFinancial({kind:'loan',principalRubles:'100',annualRatePercent:'12',months:1,payment:'annuity'});
 chat.messages.push({id:crypto.randomUUID(),question:'Аннуитет 100 рублей, 12%, месяц',answer:{mode:'ai',registryVersion,text:'Проценты: 1 ₽. Всего: 101 ₽.',calculation},createdAt:new Date().toISOString(),actionId:null});
 const id=crypto.randomUUID(),intent={kind:'account' as const,id:h.state.accounts[0]!.id,patch:{name:'Основной счёт'}};
 chat.messages.push({id,question:'Переименуй счёт',answer:{mode:'ai',registryVersion,text:'Пока ничего не сохранено.',proposal:{version:'cashneuro-change-proposal/1',intent,title:'Название счёта',description:['Основной счёт'],sourceAnswerId:null}},createdAt:new Date().toISOString(),actionId:null});
 h.chats.unshift(chat);await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByRole('link',{name:'Анализатор',exact:true}).click();
 await page.getByText('Как рассчитано · условия и график',{exact:true}).click();await expect(page.getByRole('region',{name:'Расчётный график кредита'})).toContainText('101');await expect(page.getByRole('log')).toContainText('не официальный график банка');
 await page.getByRole('button',{name:'Проверить последствия предложения',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
 expect(h.calls.filter(c=>c.path==='/finance/analyzer-propose').at(-1)?.body.tool).toEqual({name:'finance_action',answerId:id,intent});
 await page.getByRole('button',{name:'Отмена',exact:true}).click();expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);await expect(page.getByRole('button',{name:'Проверить последствия предложения',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});

test('device commands show a local proposal, apply and undo without an AI or financial write',async({page})=>{
 const h=await setup(page);await send(page,'Включи тёмную тему');
 const panel=page.getByRole('region',{name:'Настройка из Анализатора'});await expect(panel).toBeVisible();expect(h.calls.filter(c=>['/finance/analyzer-query','/finance/analyzer-task','/finance/preview','/finance/commit'].includes(c.path))).toHaveLength(0);
 await panel.getByRole('button',{name:'Применить настройку',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await panel.getByRole('button',{name:'Отменить настройку',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','system');expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
});


test('monthly budget shows the purchased Analyzer units within the total limit',async({page})=>{
 await setup(page,undefined,{limit:10000,remaining:8300,extra:2000,resetAt:'2026-11-30T21:00:00Z'});
 await page.getByRole('button',{name:'Лимит Анализатора',exact:true}).click();
 const limit=page.getByRole('dialog',{name:'Лимит Анализатора'});
 await expect(limit).toContainText(/Осталось 10\s300 из 12\s000 ед\./);
 await expect(limit).toContainText(/Из них докупленных — 2\s000 единиц/);
 await expect(limit.getByRole('button',{name:'Докупить лимит'})).toBeVisible();
});


test('pending question can be resumed with the retry button without creating another request',async({page})=>{const h=await setup(page);h.fail();await send(page,'Мои расходы за сентябрь 2026');await expect(page.getByRole('button',{name:'Повторить тот же вопрос',exact:true})).toBeVisible();const resume=page.getByRole('button',{name:'Повторить тот же вопрос',exact:true});await expect(resume).toBeEnabled();await resume.click();await expect(page.getByRole('button',{name:'Отправить вопрос',exact:true})).toBeVisible();await expect.poll(()=>h.calls.filter(c=>c.path==='/finance/analyzer-query').length).toBe(2);await expect.poll(()=>h.chats[0]!.messages.length).toBe(1);const queries=h.calls.filter(c=>c.path==='/finance/analyzer-query');expect(queries).toHaveLength(2);expect(queries[0]!.body.id).toBe(queries[1]!.body.id);expect(h.chats[0]!.messages).toHaveLength(1);});

test('pending question immediately shows the submitted text and waiting state, then becomes one saved message',async({page})=>{
 const h=await setup(page);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 await page.route('http://127.0.0.1:3000/finance/analyzer-query',async route=>{
  if(route.request().method()==='OPTIONS')return route.fallback();
  await gate;await route.fallback();
 });
 try{
  await send(page,'Мои расходы за сентябрь 2026');
  const pending=log(page).locator('article[data-pending-question]');
  await expect(pending).toBeVisible();await expect(pending).toContainText('Мои расходы за сентябрь 2026');
  await expect(pending.getByRole('status')).toHaveText('Готовим ответ…');
 }finally{release();}
 await expect(log(page)).toContainText('300 ₽');
 await expect(log(page).locator('article[data-pending-question]')).toHaveCount(0);
 await expect(log(page).getByText('Мои расходы за сентябрь 2026',{exact:true})).toHaveCount(1);
 expect(h.calls.filter(c=>c.path==='/finance/analyzer-query')).toHaveLength(1);
});

test('Analyzer packages keep catalog prices and show payment only when configured',async({page})=>{
 await setup(page,async()=>{
  await page.route('http://127.0.0.1:3000/finance/ai-packages',async route=>{
   if(route.request().method()==='OPTIONS')return route.fallback();
   await route.fulfill({headers:{'Access-Control-Allow-Origin':new URL(base).origin,'Access-Control-Allow-Credentials':'true'},json:{enabled:false,pending:[],packages:[
    {id:'pack-1000',units:1000,priceMinor:3900},{id:'pack-2000',units:2000,priceMinor:6900},{id:'pack-5000',units:5000,priceMinor:14900},{id:'pack-10000',units:10000,priceMinor:26900},
   ]}});
  });
 });
 await page.getByRole('button',{name:'Лимит Анализатора',exact:true}).click();
 await page.getByRole('button',{name:'Докупить лимит',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Пополнить лимит Анализатора'});
 await expect(dialog.getByRole('radio')).toHaveCount(4);
 await expect(dialog.getByText('Неиспользованные единицы из купленных пакетов переносятся на следующий месяц.')).toBeVisible();
 await dialog.getByRole('radio',{name:/5\s000 единиц/}).check();
 await expect(dialog.getByRole('button',{name:/Перейти к оплате · 149/})).toBeDisabled();
 await expect(dialog.getByText('Оплата пока не подключена.',{exact:false})).toHaveCount(0);
});

test('multi-step report shows calculations, official source links and red step errors without page overflow',async({page})=>{
 const h=await setup(page),chat:Chat={id:crypto.randomUUID(),title:'Связанный расчёт',pinned:false,createdAt:new Date().toISOString(),modifiedAt:new Date().toISOString(),messages:[]};
 chat.messages.push({id:crypto.randomUUID(),question:'Расчёт и источник',answer:{mode:'ai',registryVersion,text:'Связанный ответ',report:{version:'cashneuro-report/1',facts:[],narrative:[{kind:'conclusion',text:'Расчёт по заданным условиям.'}],sections:[
  {index:1,label:'Проценты',calculation:calculateFinancial({kind:'percentage',baseRubles:'1000',percent:'10'})},
  {index:2,label:'Официальный источник',sources:{version:'cashneuro-financial-sources/1',request:{kind:'key_rate'},sources:[{id:'s1',title:'Банк России',url:'https://www.cbr.ru/hd_base/KeyRate/',retrievedAt:'2026-09-10T12:00:00Z',publishedDate:'2026-09-10',facts:[{label:'Тестовая ставка',value:'10%',unit:'percent'}],notice:'Ставка договора задаётся отдельно.'}]}},
  {index:3,label:'Недостающие условия',error:{code:'REPORT_REFERENCE_MISSING',text:'Укажите сумму и срок для этого расчёта.'}},
  {index:4,label:'Налог',calculation:calculateFinancial({kind:'tax_by_rules',incomeRubles:'1000',exemptionRubles:'100',rounding:'kopeck',bands:[{upToRubles:null,ratePercent:'10'}]})},
  {index:5,label:'Нерегулярные взносы',calculation:calculateFinancial({kind:'savings_schedule',initialRubles:'0',annualRatePercent:'0',months:3,additions:[{month:1,amountRubles:'100'},{month:3,amountRubles:'200'}]})}
 ]}},createdAt:new Date().toISOString(),actionId:null});
 h.chats.unshift(chat);await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByRole('link',{name:'Анализатор',exact:true}).click();
 const report=page.getByRole('region',{name:'Связанный финансовый ответ'});await expect(report).toBeVisible();await expect(report.getByRole('link',{name:'Банк России'})).toHaveAttribute('href','https://www.cbr.ru/hd_base/KeyRate/');await report.getByText('Источник и актуальность',{exact:true}).click();await expect(report).toContainText('по МСК');for(const summary of await report.locator('summary').filter({hasText:'Как рассчитано и условия'}).all())await summary.click();await expect(report).toContainText('Ставки и пороги');await expect(report).toContainText('Месяц 3: 200 ₽');const alert=report.getByRole('alert');await expect(alert).toContainText('Укажите сумму и срок');await expect(alert).toHaveCSS('color',/rgb\((181, 45, 70|255, 166, 181)\)/);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});


test('new chat waits for creation before accepting a draft and preserves the previous draft',async({page})=>{
 const h=await setup(page);await send(page,'Мои расходы');await expect(log(page)).toContainText('300 ₽');
 const input=page.getByLabel('Ваш финансовый вопрос',{exact:true});await input.fill('Несохранённый прежний вопрос');
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>started=r);
 await page.route('http://127.0.0.1:3000/finance/analyzer-chat',async route=>{if(route.request().method()==='OPTIONS')return route.fallback();if(route.request().postDataJSON().create){started();await gate;}return route.fallback();});
 await history(page);await page.getByRole('button',{name:'Новый диалог',exact:true}).filter({visible:true}).click();await seen;
 try{await expect(input).toBeDisabled();}finally{release();}
 await expect(input).toBeEditable();await expect(input).toHaveValue('');await input.fill('Вопрос нового диалога');await expect(input).toHaveValue('Вопрос нового диалога');expect(h.chats[1]!.messages).toHaveLength(1);
 await history(page);await page.getByRole('button',{name:'Мои расходы',exact:true}).filter({visible:true}).click();await expect(input).toHaveValue('Несохранённый прежний вопрос');
});

test('deleting a chat keeps confirmation until the refreshed context can accept the next question',async({page})=>{
 const h=await setup(page);await send(page,'Мои расходы');await expect(log(page)).toContainText('300 ₽');const deletedId=h.chats[0]!.id;
 let deleted=false,release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>started=r);
 await page.route('http://127.0.0.1:3000/finance/analyzer-chat',async route=>{if(route.request().method()!=='OPTIONS'&&route.request().postDataJSON().delete)deleted=true;return route.fallback();});
 await page.route('http://127.0.0.1:3000/finance/analyzer-state',async route=>{if(route.request().method()!=='OPTIONS'&&deleted){started();await gate;}return route.fallback();});
 await history(page);await page.getByRole('button',{name:/^Настроить диалог:/}).filter({visible:true}).click();await page.getByRole('dialog',{name:'Настройки диалога',exact:true}).getByRole('button',{name:'Удалить',exact:true}).click();
 const confirmation=page.getByRole('dialog',{name:'Удалить диалог?',exact:true});await confirmation.getByRole('button',{name:'Удалить диалог',exact:true}).click();await seen;
 try{await expect(confirmation).toBeVisible();await expect(page.getByLabel('Ваш финансовый вопрос',{exact:true})).toBeDisabled();}finally{release();}
 await expect(confirmation).toHaveCount(0);const field=page.getByLabel('Ваш финансовый вопрос',{exact:true});await expect(field).toBeEditable();await expect(field).toHaveValue('');await field.fill('Мои расходы');
 await expect(page.getByRole('button',{name:'Отправить вопрос',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Отправить вопрос',exact:true}).click();await expect(log(page)).toContainText('300 ₽');expect(h.chats).toHaveLength(1);expect(h.chats[0]!.id).not.toBe(deletedId);
});

test('loan answer shows monthly payment components, exact comparison totals and spaced pagination without internal versions',async({page},info)=>{
 const h=await setup(page),a=calculateFinancial({kind:'loan',principalRubles:'420000',annualRatePercent:'19.5',months:48,payment:'annuity'}),b=calculateFinancial({kind:'loan',principalRubles:'420000',annualRatePercent:'19.5',months:48,payment:'differentiated'});
 h.chats.unshift({id:crypto.randomUUID(),title:'Сравнение кредитов',pinned:false,createdAt:new Date().toISOString(),modifiedAt:new Date().toISOString(),messages:[{id:crypto.randomUUID(),question:'Сравни эти два варианта',answer:{mode:'ai',registryVersion,text:'Расчёты по заданным условиям.',report:{version:'cashneuro-report/1',facts:[],narrative:[],sections:[{index:1,label:'Аннуитетный',calculation:a},{index:2,label:'Дифференцированный',calculation:b}]}},createdAt:new Date().toISOString(),actionId:null}]});
 await page.getByRole('button',{name:'Обновить данные',exact:true}).click();await page.getByRole('link',{name:'Операции',exact:true}).click();await page.getByRole('link',{name:'Анализатор',exact:true}).click();
 await expect(page.getByRole('region',{name:'Сравнение кредитных расчётов',exact:true})).toBeVisible();await expect(log(page)).toContainText('Наименьшая сумма процентов');await expect(page.getByRole('img',{name:/Ежемесячные платежи: основной долг и проценты/})).toHaveCount(2);await expect(log(page)).not.toContainText('Версия');await expect(log(page)).not.toContainText('Экономия процентов');
 const section=page.getByRole('region',{name:'Дифференцированный',exact:true});await section.getByText('Как рассчитано · условия и график',{exact:true}).click();const table=section.getByRole('region',{name:'Расчётный график кредита',exact:true}),more=section.getByRole('button',{name:'Показать ещё месяцы · 12 из 48',exact:true});
 await expect(table.getByRole('columnheader')).toHaveCount(5);const bounds=await table.boundingBox(),button=await more.boundingBox();expect(button!.y-(bounds!.y+bounds!.height)).toBeGreaterThanOrEqual(12);await more.click();await expect(table.getByRole('row')).toHaveCount(37);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await page.screenshot({path:info.outputPath('loan-payment-comparison.png'),fullPage:true});expect(h.calls.filter(c=>['/finance/analyzer-query','/finance/analyzer-task'].includes(c.path))).toHaveLength(0);
});

test('answers expose only calculation details and operation navigation; returning to Analyzer keeps the loaded transcript',async({page})=>{
 const h=await setup(page);await send(page,'Мои расходы');await expect(log(page)).toContainText('300 ₽');
 const actions=log(page).locator('article').last();await expect(actions.getByRole('button',{name:'Как рассчитано',exact:true})).toBeVisible();await expect(actions.getByRole('button',{name:'Открыть в Операциях',exact:true})).toBeVisible();
 for(const name of ['Сохранить на Обзор','Изменить данные','Исключить операции ответа'])await expect(actions.getByRole('button',{name,exact:true})).toHaveCount(0);
 await page.getByRole('link',{name:'Обзор',exact:true}).click();let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 await page.route('http://127.0.0.1:3000/finance/analyzer-state',async route=>{if(route.request().method()==='OPTIONS')return route.fallback();await gate;await route.fallback();});
 try{await page.getByRole('link',{name:'Анализатор',exact:true}).click();await expect(log(page)).toContainText('300 ₽',{timeout:1000});await expect(page.getByText('Загружаем диалоги…',{exact:true})).toHaveCount(0);}finally{release();}
 expect(h.calls.filter(c=>c.path==='/finance/commit')).toHaveLength(0);
});
