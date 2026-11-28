import {reserveCost} from '../src/analyzer-cost.ts';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import type { PoolClient } from 'pg';
import { postgresFixture } from './postgres.ts';
import { syntheticOperations } from './operations-fixture.ts';
import { createServer } from '../src/server.ts';
import type { Config } from '../src/types.ts';
import { token, hashPassword } from '../src/crypto.ts';
import { prepareFinance, financeView, acceptAccount, importEpoch } from '../src/finance.ts';
import { createTestAssistantProvider } from '../src/analyzer-assistant-provider.ts';
import {intentVersion} from '../../../packages/analyzer/src/next/intent.ts';
import {nextReviewVersion} from '../src/analyzer-next-review.ts';
import {restoreNextSession} from '../src/analyzer-next-checkpoint.ts';
import {nextStoreVersion} from '../src/analyzer-next-store.ts';
import {nextEmailSetting} from '../src/analyzer-next-config.ts';
import { assistantVersion } from '../../../packages/analyzer/src/assistant-plan.ts';

let pg: Awaited<ReturnType<typeof postgresFixture>>, server: Awaited<ReturnType<typeof createServer>>, config: Config;
let cookie: string, generation: string, account: string, operationIds: string[], calls = 0, outputs: unknown[], outgoing: any[], behavior = 'normal';
let activePlan:any;let reviewAccepted=true;
let onDispatch: (() => Promise<void>) | undefined;
const password = 'Synthetic Assistant password 123!';
const set = (field: string, value: unknown) => ({ field, op: 'set', value });
const plan = (changes: unknown[], mode = 'new') => ({ version: assistantVersion, topic: 'personal_finance', action: 'read', context: { mode }, changes });
const fetcher: typeof fetch = async (_url, options) => {
  const input = JSON.parse(JSON.parse(String(options?.body)).messages[1].content);
  outgoing.push(input); calls++;
  // Observe a committed reservation from an independent DB connection BEFORE
  // simulating the HTTP response. No workspace transaction can be held here.
  const reserved = (await pg.owner.query("SELECT count(*) AS n FROM commerce.ai_cost_reservation WHERE state='reserved'")).rows[0].n;
  assert.equal(Number(reserved), 1);
  await onDispatch?.();
  if (behavior === 'timeout') throw Error('synthetic-timeout');
  let value: any;
  if(input.version===nextReviewVersion){value={version:nextReviewVersion,decision:reviewAccepted?'accept':'reject',conditions:[{quote:input.question,covered:reviewAccepted}]};}
  else if (input.candidate) {
    const next: any = outputs[0];
    if (next?.plan) value = outputs.shift();
    else value = { plan: activePlan, conditions: [] };
  } else {
    value = outputs.shift();
    if (value?.version) activePlan = value;
  }
  return new Response(JSON.stringify({ model: 'openai/gpt-oss-120b', usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 },
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', tool_calls: [], content: behavior === 'invalid-json' ? '{broken' : JSON.stringify(value) } }] }));
};
function provider() { return createTestAssistantProvider(pg.finance, fetcher, { projectId: 'test/analyzer-next-http', projectPeriodStart: '2020-01-01T00:00:00Z', projectPeriodEnd: '2100-01-01T00:00:00Z', projectLimitRub: '45' }); }
before(async () => {
  pg = await postgresFixture({ name: 'finance_staging' });
  config = { profile: 'finance', pool: pg.finance, baseURL: 'https://api.example.test', origin: 'https://app.example.test', authSecret: token(), wrappingKey: randomBytes(32), environment:'test',assistantProvider:provider(),analyzerNextEmails:['first@example.test'] };
  server = await createServer(config);
});
after(async () => { await server?.close(); await pg?.close(); });
async function within<T>(action: (db: PoolClient) => Promise<T>, user = 'first') {
  const db = await pg.finance.connect();
  try { await db.query('BEGIN'); await prepareFinance(db, user); const result = await action(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
const request = (path: string, payload: unknown = {}, target = server) => target.fastify.inject({ method: 'POST', url: path, payload: payload as Record<string, unknown>, headers: { origin: config.origin, cookie, 'content-type': 'application/json' } });
beforeEach(async () => {
  reviewAccepted=true;calls = 0; outputs = []; outgoing = []; behavior = 'normal'; onDispatch = undefined; activePlan = undefined;
  await pg.owner.query('TRUNCATE identity.auth_user,identity.rate_limit,finance.workspace,commerce.access_cycle,commerce.ai_project_budget CASCADE');
  for (const user of ['first', 'second']) {
    await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Synthetic user',$2,true,now(),now())", [user, user + '@example.test']);
    await pg.owner.query('INSERT INTO identity.security_state(user_id,indefinite) VALUES($1,true)', [user]);
    await within(async () => {}, user);
  }
  await pg.owner.query("INSERT INTO identity.auth_account(id,user_id,account_id,provider_id,password,created_at,updated_at) VALUES('first-account','first','first','credential',$1,now(),now())", [await hashPassword(password)]);
  const login = await server.fastify.inject({ method: 'POST', url: '/auth/sign-in/email', payload: { email: 'first@example.test', password }, headers: { origin: config.origin, 'content-type': 'application/json' } });
  assert.equal(login.statusCode, 200, login.body); cookie = login.cookies.map(c => c.name + '=' + c.value).join('; ');
  account = randomUUID();
  await within(async db => {
    const state = await financeView(db, 'first'); generation = state.generation;
    await acceptAccount(db, 'first', importEpoch(state), { id: account, bankId: 'tbank', systemName: 'Synthetic assistant account', type: 'bank_account' });
    operationIds = await syntheticOperations(db, 'first', 2, account, state.categories.find(c => c.name === 'Продукты' && c.parentId === null)!.id);
  });
  await pg.owner.query("INSERT INTO commerce.access_cycle(user_id,anchor_at,timezone,calendar_months,extra_days,indefinite,quota_policy) VALUES('first',date_trunc('milliseconds',clock_timestamp()-interval '1 day')+interval '456 microseconds','Europe/Moscow',0,0,true,'{\"source\":\"override\",\"limit\":10000}')");
  // Functional scenario has an active paid allowance window, as the current billing contract requires.
  await pg.owner.query("INSERT INTO commerce.access_paid_window(user_id,starts_at,ends_at,kind,quota,allowance_anchor) SELECT user_id,anchor_at,anchor_at+interval '1 month','calendar_months',10000,anchor_at FROM commerce.access_cycle WHERE user_id='first'");
  assert.equal((await request('/finance/assistant-profile', { timezone: 'Europe/Moscow' })).statusCode, 200);
});
async function body() {
  const created = await request('/finance/analyzer-chat', { id: randomUUID(), create: true }); assert.equal(created.statusCode, 200, created.body);
  const context = await request('/finance/analyzer-context', { generation }); assert.equal(context.statusCode, 200, context.body);
  return { id: randomUUID(), chatId: created.json().id as string, chatEpoch: created.json().chatEpoch as string, generation, globalRevision: context.json().revision as number, text:'Расходы за сентябрь 2026 по категориям' };
}
const run = (b: Awaited<ReturnType<typeof body>>, target = server) => request('/finance/analyzer-task', b, target);

const intent=(action:string,parameters:unknown,binding:unknown={mode:'new'},format='auto')=>({relevance:'financial',intent:{version:intentVersion,action,parameters,binding,presentation:{format,detail:'normal'}}});
const read=(conditions:unknown[]=[],binding:unknown={mode:'new'})=>intent('read',{metric:'expenses',grouping:'category',comparison:null,conditions,options:{}},binding);
const setLoan=(field:string,value:unknown,quote:string)=>({field,op:'set',value,quote});
const loan=(edits:unknown[],binding:unknown={mode:'new'},format='auto')=>intent('calculate',{calculator:'loan',edits},binding,format);
const loanBody=async()=>({...await body(),text:'Кредит 100000 рублей под 10% на 24 месяца'});
const initialLoan=()=>loan([setLoan('principalRubles','100000','100000 рублей'),setLoan('annualRatePercent','10','10%'),setLoan('months',24,'24 месяца')]);
const saved=async(b:Awaited<ReturnType<typeof body>>)=>restoreNextSession({ownerId:'first',chatId:b.chatId,chatEpoch:b.chatEpoch,generation:b.generation},(await pg.owner.query("SELECT conversation FROM finance.assistant_conversation WHERE user_id='first' AND chat_id=$1",[b.chatId])).rows[0].conversation,config.wrappingKey).snapshot();

test('opted-in HTTP reads current operations only after both calls, persists the signed context and replays after restart',async()=>{
 const b=await body();outputs=[read([{field:'period',op:'set',expression:'сентябрь 2026'}])];
 const first=await run(b);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().answer.result.totals.expenses,'24690');assert.equal(calls,2);
 assert.equal(first.json().answer.query.filter.from,'2026-09-01');assert.equal((await saved(b)).history.length,1);
 assert.equal((await pg.owner.query('SELECT workflow FROM finance.assistant_run')).rows[0].workflow,nextStoreVersion);
 const restarted=await createServer({...config,assistantProvider:provider()});
 try{const replay=await run(b,restarted);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().result.replayed,true);assert.deepEqual(replay.json().answer,first.json().answer);assert.equal(calls,2);}finally{await restarted.close();}
 await within(async db=>{const state=await financeView(db,'first');await syntheticOperations(db,'first',1,account,state.categories.find(c=>c.name==='Продукты'&&c.parentId===null)!.id);});
 const historical=await run(b);assert.equal(historical.json().result.historical,true);assert.equal(historical.json().answer.result.totals.expenses,'24690');
 outputs=[read([],{mode:'continue',conditions:'pin'})];const next=await run({...b,id:randomUUID(),text:'Повтори расходы за тот же период'});
 assert.equal(next.statusCode,200,next.body);assert.equal(next.json().answer.result.totals.expenses,'37035');assert.equal(calls,4);
 assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_dependency')).rows[0].n,'5');
 for(const input of outgoing){const text=JSON.stringify(input);for(const secret of [account,...operationIds,'first@example.test',b.chatId,b.chatEpoch,b.generation])assert.equal(text.includes(secret),false);}
});
test('HTTP keeps a pending loan across explanation and renders both schedules, a chosen payment type and an explicit comparison',async()=>{
 const b={...await body(),text:'Кредит 100000 рублей на 24 месяца'};
 outputs=[loan([setLoan('principalRubles','100000','100000 рублей'),setLoan('months',24,'24 месяца')])];
 const waiting=await run(b);assert.equal(waiting.statusCode,200,waiting.body);assert.equal(waiting.json().answer.mode,'clarification');assert.match(waiting.json().answer.text,/годовую ставку/);const pending=(await saved(b)).pending;
 outputs=[intent('explain',{subject:{kind:'concept',question:'Что такое аннуитетный и дифференцированный?'}})];
 const explanation=await run({...b,id:randomUUID(),text:'Что такое аннуитетный и дифференцированный?'});assert.equal(explanation.statusCode,200,explanation.body);assert.match(explanation.json().answer.text,/основной долг/);assert.deepEqual((await saved(b)).pending,pending);
 outputs=[loan([setLoan('annualRatePercent','10','10%')],{mode:'answer',clarification:pending!.handle,option:null})];
 const complete=await run({...b,id:randomUUID(),text:'10%'});assert.equal(complete.statusCode,200,complete.body);const report=complete.json().answer.report;assert.equal(report.sections.length,2);assert.ok(report.sections.every((s:any)=>s.calculation.rows.length===24));
 outputs=[loan([setLoan('payment','annuity','Аннуитетный')],{mode:'continue',conditions:'pin'})];
 const chosen=await run({...b,id:randomUUID(),text:'Аннуитетный'});assert.equal(chosen.statusCode,200,chosen.body);assert.equal(chosen.json().answer.calculation.input.payment,'annuity');
 outputs=[loan([{field:'payment',op:'clear'}],{mode:'continue',conditions:'pin'},'chart')];
 const both=await run({...b,id:randomUUID(),text:'Покажи оба графика платежей, не меняя условий.'});assert.equal(both.statusCode,200,both.body);assert.equal(both.json().answer.report.sections.length,2);
 const active=(await saved(b)).active;outputs=[intent('compare',{scenarios:[active+'_v1',active+'_v2'],criterion:'interest',objective:'min'})];
 const compare=await run({...b,id:randomUUID(),text:'Какой из этих вариантов дешевле по процентам?'});assert.equal(compare.statusCode,200,compare.body);assert.match(compare.json().answer.text,/Наименьшее|равны/);assert.equal(compare.json().answer.report.sections.length,2);
 assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_dependency')).rows[0].n,'0');
});
test('HTTP semantic refusal publishes an honest error without a financial result or successful task',async()=>{
 const b=await body();reviewAccepted=false;outputs=[read([{field:'period',op:'set',expression:'сентябрь 2026'}])];const reply=await run(b);
 assert.equal(reply.statusCode,200,reply.body);assert.equal(reply.json().answer.notice.code,'SEMANTIC_REVIEW_REJECTED');assert.equal(reply.json().answer.result,undefined);assert.equal((await saved(b)).history.length,0);assert.equal(calls,2);
 assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_dependency')).rows[0].n,'0');
});
test('HTTP cancellation during transport settles actual usage without publishing an answer',async()=>{
 const b=await loanBody();outputs=[initialLoan()];onDispatch=async()=>{onDispatch=undefined;assert.equal((await request('/finance/analyzer-task-cancel',{id:b.id,chatId:b.chatId,chatEpoch:b.chatEpoch})).statusCode,200);};
 const stopped=await run(b);assert.equal(stopped.statusCode,409,stopped.body);assert.equal(stopped.json().code,'AI_REQUEST_CANCELLED');assert.equal(calls,1);
 assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_message')).rows[0].n,'0');assert.equal((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows[0].state,'settled');
});
test('HTTP unknown delivery keeps its reserve and cached error; another request cannot send',async()=>{
 const b=await loanBody();outputs=[initialLoan()];behavior='timeout';const failed=await run(b);assert.equal(failed.statusCode,200,failed.body);assert.equal(failed.json().answer.notice.code,'ASSISTANT_DELIVERY_UNKNOWN');assert.equal(calls,1);
 assert.equal((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows[0].state,'unknown');
 assert.equal((await run(b)).json().result.replayed,true);behavior='normal';const blocked=await run(await loanBody());assert.equal(blocked.statusCode,200,blocked.body);assert.equal(blocked.json().answer.notice.code,'AI_COST_RECONCILIATION_REQUIRED');assert.equal(calls,1);
});
test('enabling the slice preserves legacy history; disabling a signed chat fails before dispatch',async()=>{
 const legacy=await createServer({...config,analyzerNextEmails:undefined});const b=await body();outputs=[plan([set('metric','expenses')])];
 try{const old=await run({...b,text:'Сумма расходов'},legacy);assert.equal(old.statusCode,200,old.body);}finally{await legacy.close();}
 const before=calls;const follow=await run({...b,id:randomUUID(),text:'А по категориям?'});assert.equal(follow.statusCode,200,follow.body);assert.equal(calls,before);assert.equal(follow.json().result,undefined);
 const next=await loanBody();outputs=[initialLoan()];assert.equal((await run(next)).statusCode,200);const count=calls;
 const disabled=await createServer({...config,analyzerNextEmails:undefined});try{const blocked=await run({...next,id:randomUUID()},disabled);assert.equal(blocked.statusCode,409,blocked.body);assert.equal(blocked.json().code,'AI_CHAT_PROTOCOL_CHANGED');const history=await request('/finance/analyzer-state',{},disabled);assert.equal(history.statusCode,200,history.body);assert.ok(history.json().chats.some((c:any)=>c.id===next.chatId));}finally{await disabled.close();}assert.equal(calls,count);
});
test('only the server allowlist selects the slice; forged flags and unauthenticated requests cannot invoke it',async()=>{
 const other=await createServer({...config,analyzerNextEmails:['second@example.test']});const b=await body();outputs=[plan([set('metric','expenses')])];
 try{const reply=await run({...b,text:'Сумма расходов'},other);assert.equal(reply.statusCode,200,reply.body);assert.equal(reply.json().result,undefined);}finally{await other.close();}
 const count=calls;const bad=await run({...await loanBody(),next:true} as any);assert.equal(bad.statusCode,400,bad.body);assert.equal(calls,count);
 const anonymous=await server.fastify.inject({method:'POST',url:'/finance/analyzer-task',payload:await loanBody(),headers:{origin:config.origin}});assert.equal(anonymous.statusCode,401,anonymous.body);assert.equal(calls,count);
});
test('test account configuration is explicit, bounded, provider-authorized and disabled by default',async()=>{
 assert.equal(nextEmailSetting(undefined),undefined);for(const value of ['', '*', 'first@example.test,second@example.test','FIRST@example.test'])assert.throws(()=>nextEmailSetting(value),/CONFIGURATION_DENIED/);
 for(const patch of [{assistantProvider:undefined},{environment:'development'},{profile:'control'},{analyzerNextEmails:[]},{analyzerNextEmails:['first@example.test','second@example.test']},{assistantProvider:createTestAssistantProvider(pg.finance,fetcher,{projectId:'test/deny',projectPeriodStart:'2020-01-01T00:00:00Z',projectPeriodEnd:'2100-01-01T00:00:00Z',projectLimitRub:'45'},['second@example.test'])}])await assert.rejects(createServer({...config,...patch} as Config));
});
