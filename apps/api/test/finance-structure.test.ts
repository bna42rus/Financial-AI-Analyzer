import {importEpoch} from '../src/finance.ts';
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {PoolClient} from 'pg';
import {postgresFixture} from './postgres.ts';
import {createServer} from '../src/server.ts';
import {hashPassword,token} from '../src/crypto.ts';
import {prepareFinance,acceptAccount,acceptObservation,acceptAccountAlias,financeView,commitFinance} from '../src/finance.ts';
import type {Config} from '../src/types.ts';
import type {Kind} from '../../../packages/finance-core/src/model.ts';
let pg:Awaited<ReturnType<typeof postgresFixture>>,server:Awaited<ReturnType<typeof createServer>>,fc:Config;
const pw='Synthetic structure password 123!';let cookie:string,account:string;
before(async()=>{pg=await postgresFixture();fc={profile:'finance',pool:pg.finance,baseURL:'https://api.example.test',origin:'https://app.example.test',authSecret:token(),wrappingKey:randomBytes(32),environment:'test'};server=await createServer(fc);});
after(async()=>{await server?.close();await pg?.close();});
async function within<T>(user:string,fn:(db:PoolClient)=>Promise<T>){const db=await pg.finance.connect();try{await db.query('BEGIN');await prepareFinance(db,user);const r=await fn(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
async function seed(id:string){await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Synthetic user',$2,true,now(),now())",[id,id+'@example.test']);await pg.owner.query("INSERT INTO identity.auth_account(id,user_id,account_id,provider_id,password,created_at,updated_at) VALUES($1,$2,$2,'credential',$3,now(),now())",[randomUUID(),id,await hashPassword(pw)]);await pg.owner.query('INSERT INTO identity.security_state(user_id,indefinite) VALUES($1,true)',[id]);}
beforeEach(async()=>{
 await pg.owner.query('TRUNCATE identity.auth_user,identity.rate_limit,identity.outbox,commerce.access_cycle,finance.workspace CASCADE');await seed('first');await seed('second');
 const login=await server.fastify.inject({method:'POST',url:'/auth/sign-in/email',payload:{email:'first@example.test',password:pw},headers:{origin:fc.origin,'content-type':'application/json'}});assert.equal(login.statusCode,200);cookie=login.cookies.map(c=>c.name+'='+c.value).join('; ');
 account=randomUUID();await within('first',async db=>acceptAccount(db,'first',importEpoch((await financeView(db,'first'))),{id:account,bankId:'synthetic-bank',systemName:'Synthetic account',type:'bank_account'}));
});
async function request(path:string,payload?:unknown){return server.fastify.inject({method:payload===undefined?'GET':'POST',url:path,...(payload===undefined?{}:{payload:payload as Record<string,unknown>}),headers:{origin:fc.origin,cookie,...(payload===undefined?{}:{'content-type':'application/json'})}});}
async function view(){const r=await request('/finance/state');assert.equal(r.statusCode,200,r.body);return r.json();}
async function append(amount:string,kind:Kind='purchase',transactionId:string|null=null,bankAccount=account,day='2026-09-01'){
 return within('first',async db=>acceptObservation(db,'first',importEpoch((await financeView(db,'first'))),randomUUID(),transactionId,{accountId:bankAccount,operationDate:{precision:'day',date:day},postedDate:null,amountMinor:amount,currency:'RUB',merchantText:'Synthetic shop',description:'Sanitized example',bankCategory:'Safe bank category',bankRefHmac:null,versions:{parser:'synthetic-1',normalizer:'1',sanitizer:'1'}},kind));
}
async function command(intent:unknown){const w=await view(),actionId=randomUUID(),preview=await request('/finance/preview',{actionId,generation:w.generation,revision:w.revision,intent});assert.equal(preview.statusCode,200,preview.body);const commit=await request('/finance/commit',{actionId});assert.equal(commit.statusCode,200,commit.body);return {actionId,preview:preview.json(),result:commit.json()};}
function link(sourceId:string,targetId:string,amountMinor:string){return {kind:'link',link:{sourceId,targetId,kind:'refund',amountMinor,status:'confirmed'}};}
async function extraAccount(){const id=randomUUID();await within('first',async db=>acceptAccount(db,'first',importEpoch((await financeView(db,'first'))),{id,bankId:'synthetic-bank',systemName:'Second synthetic account',type:'bank_account'}));return id;}
async function alias(accountId:string,fill='a'){const id=randomUUID();await within('first',async db=>acceptAccountAlias(db,'first',importEpoch((await financeView(db,'first'))),{id,accountId,type:'bank_account',hmac:fill.repeat(64)}));return id;}
async function accountRule(accountId:string){const {preview}=await command({kind:'rule',create:true,patch:{name:'Scoped synthetic rule',enabled:true,priority:1,conditions:{accountId,merchantContains:'Synthetic'},assignments:{role:'expense'}}});return preview.intent.id as string;}
function newAccount(id:string){return {id,name:'Split destination',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null};}
async function splitIntent(destination:string){const w=await view();return {kind:'split_account',id:account,newAccounts:[newAccount(destination)],observations:w.accountSources.filter((b:{assignedAccountId:string})=>b.assignedAccountId===account).map((b:{observationId:string})=>({id:b.observationId,accountId:destination})),operations:w.operations.filter((o:{accountId:string})=>o.accountId===account).map((o:{id:string})=>({id:o.id,accountId:destination})),aliases:w.accountAliases.filter((a:{accountId:string})=>a.accountId===account).map((a:{id:string})=>({id:a.id,accountId:destination}))};}

test('merge moves matching bindings, aliases, rules and corrections without overwriting bank facts',async()=>{
 const donor=await extraAccount(),a=await append('-1000'),b=await append('-2000','purchase',null,donor),aliasId=await alias(donor),ruleId=await accountRule(donor);
 await command({kind:'account',id:donor,patch:{analyticsEnabled:false}});await command({kind:'operation',id:a.transactionId,patch:{corrections:{accountId:donor,amountMinor:'-800'}}});
 assert.equal((await view()).summary.netExpensesMinor,'0');const before=(await request('/finance/operation',{id:b.transactionId})).json().source;
 const {preview}=await command({kind:'merge_accounts',id:account,sourceIds:[donor]});assert.equal(preview.impact.details.observationsMoved,1);assert.deepEqual(preview.impact.details.rulesMoved,[ruleId]);
 const w=await view();assert.equal(w.accounts.length,1);assert.equal(w.mergedAccounts[0].id,donor);assert.equal(w.summary.netExpensesMinor,'2800');assert.equal(w.accountAliases.find((r:{id:string})=>r.id===aliasId).accountId,account);assert.equal(w.rules.find((r:{id:string})=>r.id===ruleId).conditions.accountId,account);
 const op=(await request('/finance/operation',{id:b.transactionId})).json();assert.deepEqual(op.source,before);assert.equal(op.accountAssignmentId,account);assert.equal((await request('/finance/operation',{id:a.transactionId})).json().corrections.accountId,account);
 const added=await append('-300','purchase',null,donor);assert.equal(added.projection?.accountId,account);assert.equal(JSON.stringify(w).includes('a'.repeat(64)),false);
});
test('merge Undo restores decisions and preserves immutable transaction and observation IDs',async()=>{
 const donor=await extraAccount(),a=await append('-1000','purchase',null,donor),aliasId=await alias(donor),ruleId=await accountRule(donor),before=await view();
 const merged=await command({kind:'merge_accounts',id:account,sourceIds:[donor]});await command({kind:'undo',id:randomUUID(),value:merged.actionId});const after=await view();
 assert.equal(after.accounts.length,2);assert.equal(after.mergedAccounts.length,0);assert.equal(after.operations[0].id,a.transactionId);assert.deepEqual(after.accountSources,before.accountSources);assert.equal(after.accountAliases.find((r:{id:string})=>r.id===aliasId).accountId,donor);assert.equal(after.rules.find((r:{id:string})=>r.id===ruleId).conditions.accountId,donor);
});
test('merge flattens previous donor redirects and Undo restores the earlier group',async()=>{
 const b=await extraAccount(),c=await extraAccount();await append('-1000','purchase',null,b);await command({kind:'merge_accounts',id:account,sourceIds:[b]});const second=await command({kind:'merge_accounts',id:c,sourceIds:[account]});
 assert.equal((await view()).mergedAccounts.every((a:{mergedIntoId:string})=>a.mergedIntoId===c),true);await command({kind:'undo',id:randomUUID(),value:second.actionId});const w=await view();assert.equal(w.mergedAccounts.length,1);assert.equal(w.mergedAccounts[0].mergedIntoId,account);assert.equal(w.operations[0].accountId,account);
});
test('split requires complete explicit distribution of old observations, aliases and operations',async()=>{
 const a=await append('-1000');await append('-1200','purchase',a.transactionId);await alias(account);const destination=randomUUID(),intent=await splitIntent(destination),w=await view();
 for(const bad of [{...intent,observations:intent.observations.slice(1)},{...intent,aliases:[]},{...intent,operations:[]},{...intent,observations:intent.observations.map((r:{id:string})=>({...r,accountId:randomUUID()}))}]){
  const r=await request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent:bad});assert.equal(r.statusCode,409,r.body);
 }
 assert.equal((await view()).accounts.length,1);assert.equal((await pg.owner.query('SELECT count(*) FROM finance.source_observation')).rows[0].count,'2');
});
test('split assigns sources separately from corrections and disables ambiguous future rules',async()=>{
 const a=await append('-1000'),b=await append('-2000'),aliasId=await alias(account),ruleId=await accountRule(account),destination=randomUUID(),intent=await splitIntent(destination);intent.newAccounts[0]!.analyticsEnabled=false;
 intent.observations.find((r:{id:string})=>r.id===a.observationId)!.accountId=account;intent.operations.find((r:{id:string})=>r.id===a.transactionId)!.accountId=account;
 const {preview}=await command(intent),w=await view();assert.deepEqual(preview.impact.details.rulesNeedSetup,[ruleId]);assert.equal(w.accounts.length,2);assert.equal(w.summary.netExpensesMinor,'1000');assert.equal(w.operations.find((o:{id:string})=>o.id===b.transactionId).accountId,destination);assert.equal(w.accountAliases.find((r:{id:string})=>r.id===aliasId).accountId,destination);
 const rule=w.rules.find((r:{id:string})=>r.id===ruleId);assert.equal(rule.enabled,false);assert.equal(rule.dependencyStatus,'needs_setup');assert.equal(rule.conditions.accountId,account);
 const source=(await request('/finance/operation',{id:b.transactionId})).json();assert.equal(source.source.accountId,account);assert.equal(source.accountAssignmentId,destination);assert.deepEqual(source.corrections,{});
});
test('split Undo removes only its new accounts and restores all matching decisions and rule state',async()=>{
 await append('-1000');await alias(account);const ruleId=await accountRule(account),before=await view(),split=await command(await splitIntent(randomUUID()));await command({kind:'undo',id:randomUUID(),value:split.actionId});
 const after=await view();assert.equal(after.accounts.length,1);assert.deepEqual(after.accountSources,before.accountSources);assert.deepEqual(after.accountAliases,before.accountAliases);assert.equal(after.rules.find((r:{id:string})=>r.id===ruleId).enabled,true);assert.equal(after.rules.find((r:{id:string})=>r.id===ruleId).dependencyStatus,'ready');
});
test('split distribution can preserve an independent correction to an unrelated own account',async()=>{
 const outside=await extraAccount(),a=await append('-1000');await command({kind:'operation',id:a.transactionId,patch:{corrections:{accountId:outside,amountMinor:'-700'}}});const w=await view(),destination=randomUUID();
 await command({kind:'split_account',id:account,newAccounts:[newAccount(destination)],observations:w.accountSources.map((b:{observationId:string})=>({id:b.observationId,accountId:destination})),operations:[{id:a.transactionId,accountId:outside}],aliases:[]});
 const op=(await request('/finance/operation',{id:a.transactionId})).json();assert.equal(op.accountAssignmentId,destination);assert.deepEqual(op.corrections,{accountId:outside,amountMinor:'-700'});assert.equal(op.projection.accountId,outside);
});
test('physical purchase deletion preserves an out-of-scope refund, removes links and asks for review',async()=>{
 const p=await append('-1000'),r=await append('1000','refund',null,account,'2026-10-01');await command({kind:'operation',id:p.transactionId,patch:{comment:'Deleted financial annotation'}});await command(link(r.transactionId,p.transactionId,'1000'));
 const w=await view(),actionId=randomUUID(),preview=await request('/finance/preview',{actionId,generation:w.generation,revision:w.revision,intent:{kind:'delete_financial',scope:{kind:'operations',operationIds:[p.transactionId]}}});assert.equal(preview.statusCode,200,preview.body);const impact=preview.json().impact;
 assert.deepEqual(impact.removedOperationIds,[p.transactionId]);assert.deepEqual(impact.details.survivingRelatedOperationIds,[r.transactionId]);assert.equal(impact.details.counts.observations,1);assert.equal(impact.details.counts.links,1);assert.equal(impact.details.counts.history,2);assert.equal(impact.reviewOperationIds.includes(r.transactionId),true);assert.equal((await view()).operations.length,2);
 const commit=await request('/finance/commit',{actionId});assert.equal(commit.statusCode,200,commit.body);assert.notEqual(commit.json().generation,w.generation);assert.equal(commit.json().cleanup.undoable,false);assert.equal(commit.json().impact,undefined);
 const after=await view();assert.equal(after.operations.length,1);assert.equal(after.operations[0].id,r.transactionId);assert.equal(after.summary.incomeMinor,'0');assert.equal(after.summary.unresolvedMinor,'1000');assert.equal(after.links.length,0);assert.equal((await pg.owner.query('SELECT count(*) FROM finance.source_observation')).rows[0].count,'1');
 const history=(await pg.owner.query('SELECT intent,preview,result,undo_patch FROM finance.action')).rows;assert.equal(history.length,1);const serialized=JSON.stringify(history);assert.equal(serialized.includes(p.transactionId),false);assert.equal(serialized.includes('Deleted financial annotation'),false);assert.equal(serialized.includes('netExpensesMinor'),false);assert.equal(history[0].undo_patch,null);
 assert.deepEqual((await request('/finance/commit',{actionId})).json(),commit.json());const undo=await request('/finance/preview',{actionId:randomUUID(),generation:after.generation,revision:after.revision,intent:{kind:'undo',id:randomUUID(),value:actionId}});assert.equal(undo.statusCode,409);assert.equal((await request('/finance/history')).json().actions[0].undoable,false);
});
test('physical deletion preserves independently verified refund meaning and active manual components',async()=>{
 const p=await append('-2000'),r=await append('2000','refund'),category=(await view()).categories.find((c:{name:string;parentId:string|null})=>c.name==='Продукты'&&c.parentId===null).id;
 await command(link(r.transactionId,p.transactionId,'2000'));await command({kind:'operation',id:r.transactionId,patch:{role:'expense',categoryId:category}});await command({kind:'components',id:r.transactionId,parts:[{type:'other',amountMinor:'2000',role:'expense',categoryId:category}]});
 await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[p.transactionId]}});const op=(await request('/finance/operation',{id:r.transactionId})).json();assert.equal(op.semantics.role.userVerified,true);assert.equal(op.projection.parts[0].categoryId,category);assert.equal((await view()).summary.netExpensesMinor,'-2000');assert.equal(op.components.length,1);
});
test('period deletion uses corrected dates and observed bank calendar without changing bank precision',async()=>{
 const old=await append('-1000'),corrected=await append('-2000');await command({kind:'operation',id:corrected.transactionId,patch:{corrections:{operationDate:{precision:'day',date:'2026-10-08'}}}});
 const instant=await within('first',async db=>acceptObservation(db,'first',importEpoch((await financeView(db,'first'))),randomUUID(),null,{accountId:account,operationDate:{precision:'instant',instant:'2026-10-08T22:30:00Z',sourceOffsetMinutes:180},postedDate:null,amountMinor:'-3000',currency:'RUB',merchantText:'Safe',description:'Safe',bankCategory:'',bankRefHmac:null,versions:{parser:'1',normalizer:'1',sanitizer:'1'}},'purchase'));
 const deletion=await command({kind:'delete_financial',scope:{kind:'period',from:'2026-10-08',through:'2026-10-08'}});assert.deepEqual(deletion.preview.impact.removedOperationIds,[corrected.transactionId]);const w=await view();assert.deepEqual(new Set(w.operations.map((o:{id:string})=>o.id)),new Set([old.transactionId,instant.transactionId]));assert.equal(w.summary.netExpensesMinor,'4000');
});
test('account deletion removes donor sources and aliases and retains disabled rules with setup status',async()=>{
 const donor=await extraAccount();await append('-1000');await append('-2000','purchase',null,donor);await alias(donor);const ruleId=await accountRule(donor);await command({kind:'merge_accounts',id:account,sourceIds:[donor]});
 const result=await command({kind:'delete_financial',scope:{kind:'account',accountId:account,deleteAccount:true}});assert.equal(result.preview.impact.details.counts.operations,2);assert.equal(result.result.cleanup.accounts,2);assert.equal(result.result.cleanup.aliases,1);
 const w=await view();assert.equal(w.accounts.length,0);assert.equal(w.mergedAccounts.length,0);assert.equal(w.accountSources.length,0);assert.equal(w.accountAliases.length,0);const r=w.rules.find((r:{id:string})=>r.id===ruleId);assert.equal(r.enabled,false);assert.equal(r.dependencyStatus,'needs_setup');assert.equal(r.conditions.accountId,undefined);
});
test('deleting an old source account cannot erase operations assigned to a split destination',async()=>{
 const a=await append('-1000'),destination=randomUUID();await command(await splitIntent(destination));let w=await view();
 const bad=await request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent:{kind:'delete_financial',scope:{kind:'account',accountId:account,deleteAccount:true}}});assert.equal(bad.statusCode,409);assert.equal(bad.json().code,'SOURCE_ACCOUNT_STILL_REFERENCED');assert.equal((await view()).operations[0].id,a.transactionId);
 await command({kind:'delete_financial',scope:{kind:'account',accountId:destination,deleteAccount:true}});w=await view();assert.equal(w.operations.length,0);assert.equal(w.accounts.length,1);assert.equal(w.accounts[0].id,account);
});
test('physical deletion invalidates stale acceptance and previews without touching other tenants',async()=>{
 const p=await append('-1000'),w=await view(),stale=randomUUID();await request('/finance/preview',{actionId:stale,generation:w.generation,revision:w.revision,intent:{kind:'operation',id:p.transactionId,patch:{comment:'Old preview'}}});
 await within('second',async db=>{const state=await financeView(db,'second');await acceptAccount(db,'second',importEpoch(state),{id:randomUUID(),bankId:'safe',systemName:'Other user',type:'bank_account'});});
 await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[p.transactionId]}});assert.equal((await request('/finance/commit',{actionId:stale})).statusCode,404);
 await assert.rejects(within('first',db=>acceptAccount(db,'first',importEpoch(w),{id:randomUUID(),bankId:'safe',systemName:'Old payload',type:'bank_account'})),/GENERATION_CHANGED/);
 await assert.rejects(within('first',db=>acceptAccountAlias(db,'first',importEpoch(w),{id:randomUUID(),accountId:account,type:'card',hmac:'c'.repeat(64)})),/GENERATION_CHANGED/);
 assert.equal((await pg.owner.query("SELECT count(*) FROM finance.account WHERE user_id='second'")).rows[0].count,'1');assert.equal((await view()).operations.length,0);
});
test('changed history dependencies after a delete preview reject commit atomically',async()=>{
 const p=await append('-1000'),w=await view(),id=randomUUID();await request('/finance/preview',{actionId:id,generation:w.generation,revision:w.revision,intent:{kind:'delete_financial',scope:{kind:'operations',operationIds:[p.transactionId]}}});
 await request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent:{kind:'operation',id:p.transactionId,patch:{comment:'Later preview'}}});const result=await request('/finance/commit',{actionId:id});assert.equal(result.statusCode,409);assert.equal(result.json().code,'DEPENDENCIES_CHANGED');const after=await view();assert.equal(after.generation,w.generation);assert.equal(after.operations.length,1);assert.equal((await pg.owner.query('SELECT count(*) FROM finance.action')).rows[0].count,'2');
});
test('successive deletions retain only metadata receipts and old retries never resurrect data',async()=>{
 const a=await append('-1000'),b=await append('-2000'),first=await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[a.transactionId]}});await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[b.transactionId]}});
 assert.deepEqual((await request('/finance/commit',{actionId:first.actionId})).json(),first.result);assert.equal((await view()).operations.length,0);const history=JSON.stringify((await pg.owner.query('SELECT intent,preview,result,undo_patch FROM finance.action')).rows);assert.equal(history.includes(a.transactionId),false);assert.equal(history.includes(b.transactionId),false);assert.equal(history.includes('netExpensesMinor'),false);assert.equal((await request('/finance/history')).json().actions.length,2);
});
test('structural intents and new tables enforce ownership and explicit destructive scopes',async()=>{
 const a=await append('-1000'),w=await view(),foreign=randomUUID();await within('second',async db=>acceptAccount(db,'second',importEpoch((await financeView(db,'second'))),{id:foreign,bankId:'safe',systemName:'Other',type:'bank_account'}));
 for(const intent of [{kind:'merge_accounts',id:account,sourceIds:[foreign]},{kind:'split_account',id:foreign,newAccounts:[newAccount(randomUUID())],observations:[],operations:[],aliases:[]},{kind:'delete_financial',scope:{kind:'account',accountId:foreign,deleteAccount:true}}])assert.equal((await request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent})).statusCode,404);
 assert.equal((await request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent:{kind:'delete_financial',scope:{kind:'all'}}})).statusCode,400);assert.equal((await request('/finance/edit',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent:{kind:'delete_financial',scope:{kind:'operations',operationIds:[a.transactionId]}}})).statusCode,400);
 await assert.rejects(within('first',db=>db.query('UPDATE finance.observation_account SET account_id=$2 WHERE user_id=$1',['first',foreign])),{code:'23503'});
 for(const pool of [pg.control,pg.mailControl,pg.mailFinance])for(const table of ['observation_account','account_alias'])await assert.rejects(pool.query('SELECT * FROM finance.'+table),{code:'42501'});
});
test('merge and deletion on independent clients cannot both commit the same revision',async()=>{
 const donor=await extraAccount(),a=await append('-1000','purchase',null,donor),w=await view(),ids=[randomUUID(),randomUUID()];
 for(const [i,intent]of [{kind:'merge_accounts',id:account,sourceIds:[donor]},{kind:'delete_financial',scope:{kind:'operations',operationIds:[a.transactionId]}}].entries())assert.equal((await request('/finance/preview',{actionId:ids[i],generation:w.generation,revision:w.revision,intent})).statusCode,200);
 const outcomes=await Promise.allSettled(ids.map(actionId=>within('first',db=>commitFinance(db,'first',{actionId}))));assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected'&&[404,409].includes(r.reason.status)).length,1);
});
test('migration backfills existing source bindings without rewriting observations',async()=>{
 const a=await append('-1000'),db=await pg.owner.connect();await db.query('BEGIN');try{
  const before=(await db.query('SELECT * FROM finance.source_observation')).rows;
  await db.query('DROP TABLE finance.observation_account,finance.account_alias; ALTER TABLE finance.account DROP COLUMN merged_into_id; ALTER TABLE finance.rule DROP COLUMN dependency_status; DROP FUNCTION finance.fixed_observation_binding()');
  await db.query(await readFile(new URL('../../../packages/database/migrations/0007_account_structure_deletion.sql',import.meta.url),'utf8'));
  assert.deepEqual((await db.query('SELECT * FROM finance.source_observation')).rows,before);assert.equal((await db.query('SELECT account_id FROM finance.observation_account WHERE observation_id=$1',[a.observationId])).rows[0].account_id,account);assert.equal((await db.query("SELECT relforcerowsecurity FROM pg_class WHERE oid='finance.source_observation'::regclass")).rows[0].relforcerowsecurity,true);
 }finally{await db.query('ROLLBACK');db.release();}
});
