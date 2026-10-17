import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {postgresFixture} from './postgres.ts';
import {syntheticOperations} from './operations-fixture.ts';
import {prepareFinance,financeView,acceptAccount,importEpoch} from '../src/finance.ts';
import {initialSemantics,facet} from '../../../packages/finance-core/src/model.ts';
import {createTestAssistantProvider} from '../src/analyzer-assistant-provider.ts';
import {enqueueClassification,runClassificationStage,classificationStatus} from '../src/classification-store.ts';
let pg:Awaited<ReturnType<typeof postgresFixture>>,calls=0,behavior='normal',outgoing:unknown[],afterDispatch:(()=>Promise<void>)|undefined;
let ids:string[],category:string,account:string;
const fetcher:typeof fetch=async(_url,options)=>{
 calls++;const body=JSON.parse(String(options?.body)),input=JSON.parse(body.messages[1].content);outgoing.push(input);
 assert.equal(Number((await pg.owner.query("SELECT count(*) AS n FROM commerce.ai_cost_reservation WHERE state='reserved'")).rows[0].n),1);
 await afterDispatch?.();if(behavior==='unknown')throw Error('synthetic timeout');
 const cat=input.catalog.find((c:any)=>c.name==='Продукты'&&c.parent===null).ref;
 return new Response(JSON.stringify({model:'openai/gpt-oss-120b',usage:{prompt_tokens:600,completion_tokens:60,total_tokens:660},choices:[{finish_reason:'stop',message:{role:'assistant',tool_calls:[],content:JSON.stringify(behavior==='invalid'?{decisions:[]}:{decisions:input.operations.map((o:any)=>({ref:o.ref,category:cat,subcategory:null,confidence:96}))})}}]}));
};
const provider=(limit='45')=>createTestAssistantProvider(pg.finance,fetcher,{projectId:'test/classification',projectPeriodStart:'2020-01-01T00:00:00Z',projectPeriodEnd:'2100-01-01T00:00:00Z',projectLimitRub:limit});
async function within<T>(action:(db:PoolClient)=>Promise<T>,user='first'){const db=await pg.finance.connect();try{await db.query('BEGIN');await prepareFinance(db,user);const value=await action(db);await db.query('COMMIT');return value;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
async function seed(user='first',count=3){return within(async db=>{
 const state=await financeView(db,user);const account=randomUUID();await acceptAccount(db,user,importEpoch(state),{id:account,bankId:'tbank',systemName:'Synthetic category account',type:'bank_account'});
 const category=state.categories.find(c=>c.name==='Продукты'&&!c.parentId)!.id;
 const ids=await syntheticOperations(db,user,count,account,category,'Пятёрочка');
 await db.query('UPDATE finance.transaction SET semantics=$2 WHERE user_id=$1',[user,JSON.stringify(initialSemantics('purchase','Пятёрочка'))]);
return {ids,category,account};
 },user);}
const state=()=>within(db=>financeView(db,'first'));
const queue=()=>within(db=>enqueueClassification(db,'first'));
before(async()=>{pg=await postgresFixture();});after(async()=>{await pg?.close();});
beforeEach(async()=>{
 await pg.owner.query('TRUNCATE identity.auth_user,finance.workspace,commerce.ai_project_budget CASCADE');
 calls=0;behavior='normal';outgoing=[];afterDispatch=undefined;
 for(const user of ['first','second']){await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Synthetic',$2,true,now(),now())",[user,user+'@example.test']);await pg.owner.query('INSERT INTO identity.security_state(user_id,indefinite) VALUES($1,true)',[user]);}
 ({ids,category,account}=await seed());
});
test('real RLS/ledger pipeline groups repeated merchants, assigns categories and consumes zero customer quota/cost',async()=>{
 const before=await state();await queue();assert.equal(await runClassificationStage(pg.finance,provider()),true);
 const after=await state();assert.equal(calls,1);assert.ok(after.operations.every(o=>o.classification.category.value===category&&o.classification.category.source==='ai'));for(const key of ['grossExpensesMinor','expenseReductionsMinor','netExpensesMinor','incomeMinor','differenceMinor','unresolvedMinor','neutralMinor','excludedMinor','operationIds'] as const)assert.deepEqual(after.summary[key],before.summary[key]);
 assert.equal((await pg.owner.query('SELECT count(*)::int AS n FROM commerce.analyzer_usage')).rows[0].n,0);
 const budgets=(await pg.owner.query('SELECT spent_atoms,reserved_atoms FROM commerce.ai_user_budget')).rows;assert.ok(budgets.every(r=>BigInt(r.spent_atoms)===0n&&BigInt(r.reserved_atoms)===0n));
 assert.ok(BigInt((await pg.owner.query('SELECT spent_atoms FROM commerce.ai_project_budget')).rows[0].spent_atoms)>0n);
 assert.equal((outgoing[0] as any).operations.length,1);
 for(const privateValue of ['first@example.test',account,ids[0]!, '12345','Synthetic safe source'])assert.ok(!JSON.stringify(outgoing).includes(privateValue));
});
test('repeat run and a later import of the same merchant reuse only this users saved decision',async()=>{
 await queue();await runClassificationStage(pg.finance,provider());await queue();await runClassificationStage(pg.finance,provider());assert.equal(calls,1);
 await within(async db=>{const more=await syntheticOperations(db,'first',1,account,category,'Пятёрочка');await db.query('UPDATE finance.transaction SET semantics=$3 WHERE user_id=$1 AND id=$2',['first',more[0],JSON.stringify(initialSemantics('purchase','Пятёрочка'))]);});
 await queue();await runClassificationStage(pg.finance,provider());assert.equal(calls,1);assert.ok((await state()).operations.every(o=>o.classification.category.value===category));
 const second=await seed('second',1);await within(db=>enqueueClassification(db,'second'),'second');await runClassificationStage(pg.finance,provider());assert.equal(calls,2);assert.notEqual(second.category,category);
});
test('manual decisions made during HTTP win over the stale model response',async()=>{
 afterDispatch=()=>within(async db=>{const semantics=initialSemantics('purchase','Пятёрочка');semantics.category=facet(category,'user',true);await db.query('UPDATE finance.transaction SET semantics=$3 WHERE user_id=$1 AND id=ANY($2::uuid[])',['first',ids,JSON.stringify(semantics)]);});
 await queue();await runClassificationStage(pg.finance,provider());assert.ok((await state()).operations.every(o=>o.classification.category.source==='user'&&o.classification.category.userVerified));
 assert.equal((await pg.owner.query('SELECT sum(applied)::int AS n FROM finance.classification_run')).rows[0].n,0);
});
test('unknown delivery retains the reservation and cannot be sent again, including on explicit restart',async()=>{
 behavior='unknown';await queue();await runClassificationStage(pg.finance,provider());await queue();await runClassificationStage(pg.finance,provider());assert.equal(calls,1);
 const receipt=(await pg.owner.query('SELECT state,reserved_atoms FROM commerce.ai_cost_reservation')).rows[0];assert.equal(receipt.state,'unknown');assert.ok(BigInt(receipt.reserved_atoms)>0n);
 assert.equal((await within(db=>classificationStatus(db,'first',{},provider()))).state,'blocked');assert.ok((await state()).operations.every(o=>o.classification.category.value===null));
});
test('malformed answer is still paid, never applied and never automatically re-sent',async()=>{
 behavior='invalid';await queue();await runClassificationStage(pg.finance,provider());assert.equal((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows[0].state,'settled');
 assert.ok((await state()).operations.every(o=>o.classification.category.value===null));await queue();await runClassificationStage(pg.finance,provider());assert.equal(calls,1);
});
test('concurrent workers dispatch once; an exhausted project budget dispatches nothing',async()=>{
 await queue();await Promise.all([runClassificationStage(pg.finance,provider()),runClassificationStage(pg.finance,provider())]);assert.equal(calls,1);
 await pg.owner.query('TRUNCATE commerce.ai_project_budget,finance.classification_run CASCADE');await within(async db=>{await db.query('UPDATE finance.transaction SET semantics=$2 WHERE user_id=$1',['first',JSON.stringify(initialSemantics('purchase','Пятёрочка'))]);});calls=0;
 await queue();await runClassificationStage(pg.finance,provider('0.01'));assert.equal(calls,0);
});
test('access revocation after dispatch prevents changes but settles real provider cost',async()=>{
 afterDispatch=async()=>{await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id='first'");};await queue();await runClassificationStage(pg.finance,provider());
 assert.equal((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows[0].state,'settled');assert.ok((await pg.owner.query('SELECT semantics FROM finance.transaction')).rows.every(r=>r.semantics.category.value===null));
});
test('deletion/reset during HTTP never recreates operations or cached financial state',async()=>{
 afterDispatch=async()=>{await pg.owner.query("UPDATE finance.workspace SET generation=$1 WHERE user_id='first'",[randomUUID()]);await pg.owner.query("DELETE FROM finance.transaction WHERE user_id='first'");};
 await queue();await runClassificationStage(pg.finance,provider());
 assert.equal((await pg.owner.query('SELECT count(*)::int AS n FROM finance.transaction')).rows[0].n,0);
 assert.equal((await pg.owner.query('SELECT count(*)::int AS n FROM finance.classification_cache')).rows[0].n,0);
 assert.equal((await pg.owner.query('SELECT state FROM commerce.ai_cost_reservation')).rows[0].state,'settled');
});
test('private cache is inaccessible to other tenants and Control; scheduler exposes no financial payload',async()=>{
 await queue();await runClassificationStage(pg.finance,provider());
 const foreign=await within(db=>db.query("SELECT * FROM finance.classification_cache WHERE user_id='first'"),'second');assert.equal(foreign.rowCount,0);
 await assert.rejects(pg.control.query('SELECT * FROM finance.classification_cache'),/permission denied/);
 const columns=(await pg.owner.query("SELECT column_name FROM information_schema.columns WHERE table_schema='finance' AND table_name='classification_dispatch' ORDER BY ordinal_position")).rows.map(r=>r.column_name);
 assert.deepEqual(columns,['user_id','generation','state','updated_at']);
});
