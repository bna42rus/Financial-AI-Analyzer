import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import { postgresFixture } from './postgres.ts';
import { prepareFinance } from '../src/finance.ts';
import { analyzerQuota } from '../src/analyzer.ts';
import { createYandexTransport } from '../src/yandex-transport.ts';
import { createYandexAnalyzer } from '../src/yandex-runtime.ts';
import { settleCost } from '../src/analyzer-cost.ts';
import type { CostPolicy } from '../src/analyzer-cost.ts';
import { rubAmount, tokenCost } from '../../../packages/analyzer/src/cost.ts';

let pg: Awaited<ReturnType<typeof postgresFixture>>, metadata: Pool;
let behavior='normal',paidCalls=0,tokenizerCalls=0;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
let barrier: ReturnType<typeof deferred> | undefined;
const modelUri='gpt://b1g00000000000000000/yandexgpt-5.1';
const settings={realm:'staging/finance' as const,apiKey:'synthetic-api-key-for-tests-only',modelUri,allowedEmails:['first@example.test'],maxDailyCalls:30,maxTokens:512,timeoutMs:1000};
const policy: CostPolicy={projectId:'staging/finance/cost-tests',projectPeriodStart:'2020-01-01T00:00:00Z',projectPeriodEnd:'2100-01-01T00:00:00Z',projectLimitRub:'1000',price:{version:'synthetic-yandex-800',currency:'RUB',inputRubPerMillion:'800',outputRubPerMillion:'800'}};
const transport=createYandexTransport(settings,(async url=>{
  if(String(url).endsWith('/tokenizeCompletion')){tokenizerCalls++;if(behavior==='tokenizer-fails')return new Response('{}',{status:500});return new Response(JSON.stringify({tokens:Array.from({length:20},(_,i)=>({id:String(i),text:'synthetic',special:false})),modelVersion:'synthetic-1'}));}
  paidCalls++;if(behavior==='timeout')throw new Error('synthetic-network-private-error');
  if(behavior==='block')await barrier!.promise;
  const input=behavior==='overshoot'?21:20;
  return new Response(JSON.stringify({result:{alternatives:[{status:behavior==='truncated'?'ALTERNATIVE_STATUS_TRUNCATED_FINAL':'ALTERNATIVE_STATUS_FINAL',message:{role:'assistant',text:behavior==='bad-json'?'synthetic-private-not-json':JSON.stringify({ok:true})}}],...(behavior==='missing-usage'?{}:{usage:{inputTextTokens:String(input),completionTokens:'10',totalTokens:String(input+10)}}),modelVersion:'synthetic-1'}}));
}) as typeof fetch);
before(async()=>{pg=await postgresFixture();const options=(pg.finance as Pool&{options:PoolConfig}).options;metadata=new Pool({...options,password:options.password,max:3});});
after(async()=>{barrier?.resolve();await metadata?.end();await pg?.close();});
async function within<T>(user:string,fn:(db:PoolClient)=>Promise<T>){const db=await metadata.connect();try{await db.query('BEGIN');await db.query("SELECT set_config('app.user_id',$1,true)",[user]);const result=await fn(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
beforeEach(async()=>{
  behavior='normal';paidCalls=0;tokenizerCalls=0;barrier=undefined;
  await pg.owner.query('TRUNCATE identity.auth_user,finance.workspace,commerce.access_cycle,commerce.ai_project_budget CASCADE');
  for(const user of ['first','second']){
    await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Synthetic user',$2,true,now(),now())",[user,user+'@example.test']);
    await pg.owner.query('INSERT INTO identity.security_state(user_id,indefinite) VALUES($1,true)',[user]);
    await within(user,db=>prepareFinance(db,user));
    await pg.owner.query("INSERT INTO commerce.access_cycle(user_id,anchor_at,timezone,calendar_months,extra_days,indefinite,quota_policy) VALUES($1,clock_timestamp()-interval '1 day','Europe/Moscow',0,0,true,'{\"source\":\"override\",\"limit\":10}')",[user]);
  }
});
async function request(user='first'){
  return within(user,async db=>{
    const chatId=randomUUID();await db.query('INSERT INTO finance.analyzer_chat(user_id,id) VALUES($1,$2)',[user,chatId]);
    const quota=await analyzerQuota(db,user),anchor=(await db.query('SELECT anchor_at::text AS anchor FROM commerce.access_cycle WHERE user_id=$1',[user])).rows[0].anchor;
    return {userId:user,chatId,requestId:randomUUID(),step:'gate' as const,binding:{test:'cost/1'},prompt:'Return synthetic JSON.',input:{question:'Синтетический финансовый вопрос'},schema:{type:'object'},anchorAt:anchor,periodStart:quota.periodStart!};
  });
}
const usage={inputTokens:20,outputTokens:10,modelVersion:'synthetic-1'};
async function waitForPaid(){for(let n=0;n<200;n++){if(paidCalls)return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Paid dispatch did not reach the synthetic barrier');}
test('durable user/project reservation settles exact actual cost; exact retry is free',async()=>{
  const service=createYandexAnalyzer(metadata,transport,policy),r=await request();
  await service.call(r,v=>v);assert.equal(paidCalls,1);assert.equal(tokenizerCalls,1);
  await service.call(r,v=>v);assert.equal(paidCalls,1);assert.equal(tokenizerCalls,1);
  const cost=(await pg.owner.query('SELECT * FROM commerce.ai_cost_reservation')).rows[0];
  assert.equal(cost.state,'settled');assert.equal(BigInt(cost.settled_atoms),tokenCost(policy.price,20,10));
  const balance=(await pg.owner.query('SELECT *,anchor_at::text AS precise_anchor FROM commerce.ai_user_budget')).rows[0];assert.equal(BigInt(balance.spent_atoms),rubAmount('0.024'));assert.equal(balance.reserved_atoms,'0');assert.equal(balance.precise_anchor,r.anchorAt);
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.analyzer_usage')).rows[0].n,'0');
});
test('bad JSON/truncation costs are reported and settled without a customer charge or private cache',async()=>{
  const service=createYandexAnalyzer(metadata,transport,policy);
  for(const mode of ['bad-json','truncated']){behavior=mode;await assert.rejects(service.call(await request(),v=>v),/AI_RESPONSE_INVALID/);}
  const rows=(await pg.owner.query('SELECT input_tokens,output_tokens,usage_state FROM commerce.analyzer_request')).rows;
  assert.ok(rows.every(r=>r.input_tokens===20&&r.output_tokens===10&&r.usage_state==='reported'));
  assert.equal((await pg.owner.query('SELECT spent_atoms,reserved_atoms FROM commerce.ai_user_budget')).rows[0].spent_atoms,rubAmount('0.048').toString());
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_provider_plan')).rows[0].n,'0');
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.analyzer_usage')).rows[0].n,'0');
});
test('missing usage and unknown delivery hold money; neither retries paid dispatch',async()=>{
  const service=createYandexAnalyzer(metadata,transport,policy);
  for(const mode of ['missing-usage','timeout']){behavior=mode;const r=await request();await assert.rejects(service.call(r,v=>v));await assert.rejects(service.call(r,v=>v));}
  assert.equal(paidCalls,2);const rows=(await pg.owner.query('SELECT input_tokens,output_tokens,usage_state FROM commerce.analyzer_request')).rows;
  assert.ok(rows.every(r=>r.input_tokens===null&&r.output_tokens===null&&r.usage_state==='unknown'));
  assert.ok((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows.every(r=>r.state==='unknown'));
  const balance=(await pg.owner.query('SELECT spent_atoms,reserved_atoms FROM commerce.ai_user_budget')).rows[0];assert.equal(balance.spent_atoms,'0');assert.equal(BigInt(balance.reserved_atoms),2n*tokenCost(policy.price,20,512));
});
test('tokenization failure dispatches nothing and has an explicit not_sent usage state',async()=>{
  behavior='tokenizer-fails';const service=createYandexAnalyzer(metadata,transport,policy);await assert.rejects(service.call(await request(),v=>v),/AI_TOKENIZATION_FAILED/);
  assert.equal(paidCalls,0);assert.equal((await pg.owner.query('SELECT usage_state FROM commerce.analyzer_request')).rows[0].usage_state,'not_sent');
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.ai_cost_reservation')).rows[0].n,'0');
});
test('last user budget is reserved atomically across concurrent requests without holding a connection over network wait',async()=>{
  behavior='block';barrier=deferred();const service=createYandexAnalyzer(metadata,transport,policy),a=await request(),b=await request();
  await pg.owner.query('INSERT INTO commerce.ai_user_budget(user_id,anchor_at,period_start,limit_atoms,spent_atoms) VALUES($1,$2,$3,$4,$5)',['first',a.anchorAt,a.periodStart,rubAmount('100').toString(),rubAmount('99.5').toString()]);
  const first=service.call(a,v=>v);
  await waitForPaid();
  await assert.rejects(service.call(b,v=>v),/AI_USER_COST_EXHAUSTED/);assert.equal(paidCalls,1);barrier.resolve();await first;
  const balance=(await pg.owner.query('SELECT spent_atoms,reserved_atoms FROM commerce.ai_user_budget')).rows[0];assert.equal(balance.spent_atoms,rubAmount('99.524').toString());assert.equal(balance.reserved_atoms,'0');
});
test('global project reserve prevents a second user overspending the same cap',async()=>{
  behavior='block';barrier=deferred();const service=createYandexAnalyzer(metadata,transport,{...policy,projectLimitRub:'0.5'}),a=await request(),b=await request('second');
  const first=service.call(a,v=>v);await waitForPaid();
  await assert.rejects(service.call(b,v=>v),/AI_PROJECT_COST_EXHAUSTED/);assert.equal(paidCalls,1);barrier.resolve();await first;
});
test('repeated settlement cannot double-charge or replace a receipt, and contract changes freeze new dispatch',async()=>{
  const service=createYandexAnalyzer(metadata,transport,policy),r=await request();await service.call(r,v=>v);
  await within('first',db=>settleCost(db,'first',r.requestId,r.step,usage));
  await assert.rejects(within('first',db=>settleCost(db,'first',r.requestId,r.step,{...usage,outputTokens:11})),/AI_RECEIPT_CHANGED/);
  assert.equal((await pg.owner.query('SELECT spent_atoms FROM commerce.ai_user_budget')).rows[0].spent_atoms,rubAmount('0.024').toString());
  behavior='overshoot';await assert.rejects(service.call(await request(),v=>v),/AI_PROVIDER_CONTRACT_CHANGED/);
  assert.equal((await pg.owner.query('SELECT blocked FROM commerce.ai_project_budget')).rows[0].blocked,true);
  const old=paidCalls;behavior='normal';await assert.rejects(service.call(await request(),v=>v),/AI_PROVIDER_CONTRACT_CHANGED/);assert.equal(paidCalls,old);
});
test('chat deletion clears private plans but keeps technical costs and immutable prices',async()=>{
  const service=createYandexAnalyzer(metadata,transport,policy),r=await request();await service.call(r,v=>v);
  await within('first',db=>db.query('DELETE FROM finance.analyzer_chat WHERE user_id=$1 AND id=$2',['first',r.chatId]));
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM finance.analyzer_provider_plan')).rows[0].n,'0');
  assert.equal((await pg.owner.query('SELECT count(*) AS n FROM commerce.ai_cost_reservation')).rows[0].n,'1');
  await assert.rejects(within('first',db=>db.query("UPDATE commerce.ai_cost_reservation SET price='{}' WHERE user_id='first'")),/IMMUTABLE_COST_RECEIPT/);
  for(const pool of [pg.control,pg.mailFinance,pg.mailControl])await assert.rejects(pool.query('SELECT * FROM commerce.ai_cost_reservation'));
  assert.equal((await within('second',db=>db.query('SELECT * FROM commerce.ai_cost_reservation'))).rowCount,0);
});
test('legacy attempts cannot be silently omitted from a current cost period',async()=>{
  const r=await request();await pg.owner.query("INSERT INTO commerce.analyzer_request(user_id,request_id,step,fingerprint,state,model) VALUES('first',$1,'gate',repeat('a',64),'failed',$2)",[randomUUID(),modelUri]);
  const service=createYandexAnalyzer(metadata,transport,policy);await assert.rejects(service.call(r,v=>v),/AI_COST_RECONCILIATION_REQUIRED/);assert.equal(paidCalls,0);
});
test('invalid parsed plans still settle cost while a failed cache transaction cannot duplicate payment',async()=>{
  const service=createYandexAnalyzer(metadata,transport,policy),r=await request();await assert.rejects(service.call(r,()=>{throw new Error('synthetic-invalid-plan');}),/AI_PLAN_INVALID/);
  const row=(await pg.owner.query('SELECT input_tokens,usage_state FROM commerce.analyzer_request')).rows[0];assert.equal(row.input_tokens,20);assert.equal(row.usage_state,'reported');
  await assert.rejects(service.call(r,v=>v));assert.equal(paidCalls,1);
});
