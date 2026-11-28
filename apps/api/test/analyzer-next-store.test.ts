/** Actual isolated PostgreSQL. Model replies are scripted, never language-quality evidence. */
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {postgresFixture} from './postgres.ts';
import {prepareFinance} from '../src/finance.ts';
import {analyzerChat} from '../src/analyzer.ts';
import {cancelAnalyzerTask} from '../src/analyzer-task-store.ts';
import {createTestAssistantProvider} from '../src/analyzer-assistant-provider.ts';
import {runNextRequest,nextStoreVersion} from '../src/analyzer-next-store.ts';
import type {NextStoreContext,NextExecution} from '../src/analyzer-next-store.ts';
import {nextModelCall} from '../src/analyzer-next-model-call.ts';
import {reviewNextUnderstanding,nextReviewVersion} from '../src/analyzer-next-review.ts';
import {restoreNextSession} from '../src/analyzer-next-checkpoint.ts';
import {pilotPrompt,pilotSchema} from '../../../packages/analyzer/src/next/pilot.ts';
import {intentVersion} from '../../../packages/analyzer/src/next/intent.ts';
import {registryVersion} from '../../../packages/analyzer/src/registry.ts';
import type {AssistantModel} from '../src/assistant-workflow.ts';
import type {Understanding} from '../../../packages/analyzer/src/next/workflow.ts';

let pg:Awaited<ReturnType<typeof postgresFixture>>,provider:ReturnType<typeof createTestAssistantProvider>;
const key=randomBytes(32);let posts=0,engines=0,reads=0,accept=true,unknown=false,afterDispatch:(()=>Promise<void>)|undefined;
before(async()=>{pg=await postgresFixture();provider=createTestAssistantProvider(pg.finance,async()=>{throw Error('No external HTTP');},{projectId:'test/next-store',projectPeriodStart:'2020-01-01T00:00:00Z',projectPeriodEnd:'2100-01-01T00:00:00Z',projectLimitRub:'45'});});
after(async()=>{await pg?.close();});
async function within<T>(action:(db:PoolClient)=>Promise<T>,user='first'){
 const db=await pg.finance.connect();try{await db.query('BEGIN');await prepareFinance(db,user);const result=await action(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
beforeEach(async()=>{
 posts=0;engines=0;reads=0;accept=true;unknown=false;afterDispatch=undefined;
 await pg.owner.query('TRUNCATE identity.auth_user,finance.workspace,commerce.access_cycle,commerce.ai_project_budget CASCADE');
 for(const user of ['first','second']){
  await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Synthetic',$2,true,now(),now())",[user,user+'@example.test']);
  await pg.owner.query('INSERT INTO identity.security_state(user_id,indefinite) VALUES($1,true)',[user]);
  await within(async db=>{await db.query("INSERT INTO finance.assistant_profile(user_id,timezone) VALUES($1,'Europe/Moscow')",[user]);},user);
  await pg.owner.query("INSERT INTO commerce.access_cycle(user_id,anchor_at,timezone,calendar_months,extra_days,indefinite,quota_policy) VALUES($1,clock_timestamp()-interval '1 day','Europe/Moscow',0,0,true,'{\"source\":\"override\",\"limit\":10000}')",[user]);
  await pg.owner.query("INSERT INTO commerce.access_paid_window(user_id,starts_at,ends_at,kind,quota,allowance_anchor) SELECT user_id,anchor_at,anchor_at+interval '1 month','calendar_months',10000,anchor_at FROM commerce.access_cycle WHERE user_id=$1",[user]);
 }
});
async function body(){return within(async db=>{
 const chat=await analyzerChat(db,'first',{id:randomUUID(),create:true}),workspace=(await db.query("SELECT generation FROM finance.workspace WHERE user_id='first'")).rows[0];
 return {id:randomUUID(),chatId:chat.id,chatEpoch:chat.chatEpoch!,generation:workspace.generation as string,globalRevision:0,text:'Кредит 100000 рублей под 10% на 24 месяца'};
});}
const loan=(edits:unknown[],binding:unknown={mode:'new'})=>({version:intentVersion,action:'calculate',binding,parameters:{calculator:'loan',edits},presentation:{format:'auto',detail:'normal'}});
const initial=()=>loan([{field:'principalRubles',op:'set',value:'100000',quote:'100000 рублей'},{field:'annualRatePercent',op:'set',value:'10',quote:'10%'},{field:'months',op:'set',value:24,quote:'24 месяца'}]);
function engine(raw:unknown=initial()){
 return async(context:NextStoreContext):Promise<NextExecution>=>{
  engines++;const {session,environment,journal}=context;
  const model:AssistantModel={bound:provider.model.bound,async complete(input,before){
   await before();posts++;
   assert.equal(Number((await pg.owner.query("SELECT count(*) AS n FROM commerce.ai_cost_reservation WHERE state='reserved'")).rows[0].n),1,'reserve must commit before transport');
   await afterDispatch?.();if(unknown)throw Error('private transport detail');
   const value=input.phase==='understand'?{relevance:'financial',intent:raw}:{version:nextReviewVersion,decision:accept?'accept':'reject',conditions:[{quote:environment.question,covered:accept}]};
   return {value,usage:{modelVersion:provider.model.bound.modelVersion,inputTokens:100,outputTokens:50}};
  }};
  const result=await session.run(environment,{async understand(input){return (await nextModelCall(model,journal,{phase:'understand',prompt:pilotPrompt,input,schema:pilotSchema})).value;}},{current:()=>environment,
   async authorize(){await context.within(async()=>{});},
   review:(input,reply)=>reviewNextUnderstanding(input,reply,session.snapshot(),environment,model,journal),
   tools:{async guard(){await context.within(async()=>{});},async read(){reads++;throw Error('No private financial read in these loan cases');}}});
  return {result,answer:{registryVersion,mode:result.status==='completed'?'ai':'unavailable',text:'Синтетический результат'}};
 };
}
const run=(b:Awaited<ReturnType<typeof body>>,execute=engine(),user='first')=>runNextRequest(pg.finance,user,b,provider,key,async()=>{},execute);
const count=async(table:string)=>Number((await pg.owner.query('SELECT count(*) AS n FROM '+table)).rows[0].n);
const snapshot=async(b:Awaited<ReturnType<typeof body>>)=>(await pg.owner.query("SELECT conversation FROM finance.assistant_conversation WHERE user_id='first' AND chat_id=$1",[b.chatId])).rows[0]?.conversation;

test('PostgreSQL persists context, response and one usage unit; new sessions replay without another provider call',async()=>{
 const b=await body(),first=await run(b);assert.equal(first.result.status,'completed');assert.equal(posts,2);assert.equal(reads,0);
 assert.equal(await count('finance.analyzer_message'),1);assert.equal(await count('commerce.analyzer_usage'),1);
 const saved=await snapshot(b),state=restoreNextSession({ownerId:'first',chatId:b.chatId,chatEpoch:b.chatEpoch,generation:b.generation},saved,key).snapshot();assert.equal(state.history.length,1);
 const again=await run(b,async()=>{throw Error('Completed request must not execute');});assert.equal(again.result.replayed,true);assert.equal(posts,2);assert.equal(await count('commerce.analyzer_usage'),1);assert.deepEqual(await snapshot(b),saved);
 const next={...b,id:randomUUID(),text:'Теперь на 12 месяцев'};
 const reply=await run(next,engine(loan([{field:'months',op:'set',value:12,quote:'12 месяцев'}],{mode:'continue',conditions:'pin'})));assert.equal(reply.result.status,'completed');assert.equal(posts,4);
 if(reply.result.status!=='completed'||reply.result.outcome.kind!=='loan')throw Error('loan');assert.ok(reply.result.outcome.results.every(r=>r.input.principalRubles==='100000'&&r.input.annualRatePercent==='10'&&r.input.months===12));
 assert.equal((await pg.owner.query('SELECT workflow FROM finance.assistant_run LIMIT 1')).rows[0].workflow,nextStoreVersion);
});
test('a failure at final request update rolls back answer, checkpoint and usage; retry reuses both received calls',async()=>{
 const b=await body();
 await pg.owner.query("CREATE FUNCTION finance.test_fail_next_commit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.state='completed' THEN RAISE EXCEPTION 'SYNTHETIC_COMMIT_FAILURE'; END IF; RETURN NEW; END$$; CREATE TRIGGER test_fail_next_commit BEFORE UPDATE ON finance.analyzer_task_request FOR EACH ROW EXECUTE FUNCTION finance.test_fail_next_commit();");
 try{await assert.rejects(run(b),/SYNTHETIC_COMMIT_FAILURE/);}finally{await pg.owner.query('DROP TRIGGER test_fail_next_commit ON finance.analyzer_task_request; DROP FUNCTION finance.test_fail_next_commit();');}
 assert.equal(await count('finance.analyzer_message'),0);assert.equal(await count('finance.assistant_conversation'),0);assert.equal(await count('commerce.analyzer_usage'),0);
 assert.equal((await pg.owner.query('SELECT receipt ? \'result\' AS complete FROM finance.assistant_run')).rows[0].complete,false);assert.equal(posts,2);
 const spent=(await pg.owner.query('SELECT sum(settled_atoms)::text AS n FROM commerce.ai_cost_reservation')).rows[0].n;
 assert.equal((await run(b)).result.status,'completed');assert.equal(posts,2);assert.equal(await count('commerce.analyzer_usage'),1);
 assert.equal((await pg.owner.query('SELECT sum(settled_atoms)::text AS n FROM commerce.ai_cost_reservation')).rows[0].n,spent);
});
test('a concurrent duplicate fails before a second execution and the request connection works with a pool of one',async()=>{
 const b=await body();let release!:()=>void,entered!:()=>void;const stopped=new Promise<void>(r=>release=r),inside=new Promise<void>(r=>entered=r);
 afterDispatch=async()=>{entered();await stopped;};const first=run(b);await inside;
 try{await assert.rejects(run(b),e=>(e as any).code==='AI_REQUEST_IN_PROGRESS');assert.equal(engines,1);}finally{afterDispatch=undefined;release();}
 await first;assert.equal(posts,2);
 const other=await body(),old=pg.finance.options.max;pg.finance.options.max=1;
 try{assert.equal((await run(other)).result.status,'completed');}finally{pg.finance.options.max=old;}
});
test('changed request, suspended access, foreign scope and control role cannot replay private answers',async()=>{
 const b=await body();await run(b);
 await assert.rejects(run({...b,text:'Другой вопрос'}),e=>(e as any).code==='AI_REQUEST_CHANGED');
 await assert.rejects(run(b,engine(),'second'),e=>(e as any).code==='AI_STATE_CHANGED');
 await assert.rejects(pg.control.query('SELECT * FROM finance.assistant_conversation'),/permission denied/);
 await within(async db=>{assert.equal((await db.query('SELECT * FROM finance.assistant_conversation')).rowCount,0);},'second');
 await pg.owner.query("UPDATE identity.security_state SET status='suspended',epoch=epoch+1 WHERE user_id='first'");
 await assert.rejects(run(b),e=>(e as any).code==='FINANCE_ACCESS_REQUIRED');assert.equal(posts,2);
});
test('a data revision or cancellation during understanding blocks publication while actual usage is settled',async()=>{
 const b=await body();let changed=false;afterDispatch=async()=>{if(!changed){changed=true;await pg.owner.query("UPDATE finance.workspace SET revision=revision+1 WHERE user_id='first'");}};
 await assert.rejects(run(b),e=>(e as any).code==='AI_STATE_CHANGED');assert.equal(await count('finance.analyzer_message'),0);assert.equal(await count('finance.assistant_conversation'),0);
 assert.equal((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows[0].state,'settled');
 await within(db=>cancelAnalyzerTask(db,'first',{id:b.id,chatId:b.chatId,chatEpoch:b.chatEpoch}));
 const another=await body();afterDispatch=async()=>{await within(db=>cancelAnalyzerTask(db,'first',{id:another.id,chatId:another.chatId,chatEpoch:another.chatEpoch}));};
 await assert.rejects(run(another),e=>(e as any).code==='AI_REQUEST_CANCELLED');assert.equal(await count('finance.analyzer_message'),0);assert.equal(await count('finance.assistant_conversation'),0);
 assert.equal((await pg.owner.query("SELECT count(*) AS n FROM commerce.ai_cost_reservation WHERE state='reserved'")).rows[0].n,'0');
});
test('rejection of semantics executes no financial tool and never registers a successful task',async()=>{
 const b=await body();accept=false;const reply=await run(b);assert.equal(reply.result.status,'failed');assert.equal('code'in reply.result&&reply.result.code,'SEMANTIC_REVIEW_REJECTED');assert.equal(reads,0);
 const state=restoreNextSession({ownerId:'first',chatId:b.chatId,chatEpoch:b.chatEpoch,generation:b.generation},await snapshot(b),key).snapshot();assert.equal(state.history.length,0);assert.equal(await count('commerce.analyzer_usage'),0);assert.equal(posts,2);
});
test('deleting a chat cascades new checkpoints and journals without deleting monetary receipts',async()=>{
 const b=await body();await run(b);await within(db=>analyzerChat(db,'first',{id:b.chatId,delete:true}));
 for(const table of ['analyzer_task_request','assistant_conversation','assistant_run','analyzer_message'])assert.equal(await count('finance.'+table),0);
 assert.equal(await count('commerce.analyzer_request'),2);assert.equal(await count('commerce.ai_cost_reservation'),2);
 await assert.rejects(run(b),e=>(e as any).code==='AI_STATE_CHANGED');
 const recreated=await within(db=>analyzerChat(db,'first',{id:b.chatId,create:true}));
 await assert.rejects(run({...b,chatEpoch:recreated.chatEpoch!}),e=>(e as any).code==='ACTION_REUSED');
});
test('generation reset rebinds a surviving checked context while old request IDs cannot be reused',async()=>{
 const b=await body();await run(b);
 const nextGeneration=randomUUID();await pg.owner.query("UPDATE finance.workspace SET generation=$1,revision=revision+1 WHERE user_id='first'",[nextGeneration]);
 assert.equal(await count('finance.analyzer_message'),1);assert.equal(await count('finance.analyzer_task_request'),0);
 await assert.rejects(run({...b,generation:nextGeneration}),e=>(e as any).code==='ACTION_REUSED');
 const next={...b,id:randomUUID(),generation:nextGeneration,text:'Теперь на 12 месяцев'};
 assert.equal((await run(next,engine(loan([{field:'months',op:'set',value:12,quote:'12 месяцев'}],{mode:'continue',conditions:'pin'})))).result.status,'completed');
 const state=restoreNextSession({ownerId:'first',chatId:b.chatId,chatEpoch:b.chatEpoch,generation:nextGeneration},await snapshot(b),key).snapshot();assert.equal(state.history.length,2);assert.equal(state.scope.generation,nextGeneration);
});
test('legacy chat history is left readable and never overwritten as a next checkpoint',async()=>{
 const b=await body(),legacy={version:'legacy-test',book:{scope:{ownerId:'first',chatId:b.chatId,chatEpoch:b.chatEpoch,generation:b.generation}}};
 await within(async db=>{await db.query('INSERT INTO finance.assistant_conversation(user_id,chat_id,chat_epoch,generation,conversation) VALUES($1,$2,$3,$4,$5)',['first',b.chatId,b.chatEpoch,b.generation,JSON.stringify(legacy)]);});
 await assert.rejects(run(b),e=>(e as any).code==='AI_CHAT_PROTOCOL_CHANGED');assert.deepEqual(await snapshot(b),legacy);assert.equal(posts,0);assert.equal(await count('commerce.ai_cost_reservation'),0);
});
test('unknown delivery survives a completed error response and blocks any new monetary reservation',async()=>{
 const b=await body();unknown=true;const failed=await run(b);assert.equal(failed.result.status,'failed');assert.equal('code'in failed.result&&failed.result.code,'ASSISTANT_DELIVERY_UNKNOWN');assert.equal(posts,1);
 const hold=(await pg.owner.query('SELECT state,reserved_atoms,settled_atoms FROM commerce.ai_cost_reservation')).rows[0];
 assert.equal(hold.state,'unknown');assert.ok(BigInt(hold.reserved_atoms)>0n);assert.equal(hold.settled_atoms,null);
 await run(b,async()=>{throw Error('No duplicate execution');});assert.equal(posts,1);
 const another=await body();unknown=false;const blocked=await run(another);assert.equal('code'in blocked.result&&blocked.result.code,'AI_COST_RECONCILIATION_REQUIRED');assert.equal(posts,1);assert.equal(await count('commerce.ai_cost_reservation'),1);
});
