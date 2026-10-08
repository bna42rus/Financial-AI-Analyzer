import {importEpoch} from '../src/finance.ts';
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import type {PoolClient} from 'pg';
import {postgresFixture} from './postgres.ts';
import {createServer} from '../src/server.ts';
import {hashPassword,token,envelope} from '../src/crypto.ts';
import {prepareFinance,acceptAccount,acceptObservation,acceptCounterpartyAlias,acceptCounterpartyObservation,acceptAccountAlias,financeView,commitFinance,prepareImportContext,withPreparedImport} from '../src/finance.ts';
import type {Config} from '../src/types.ts';
import type {Kind} from '../../../packages/finance-core/src/model.ts';
let pg:Awaited<ReturnType<typeof postgresFixture>>,server:Awaited<ReturnType<typeof createServer>>,fc:Config;
const pw='Synthetic reset password 123!';let cookie:string,account:string;
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
async function preview(intent:unknown){const w=await view();return request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent});}
async function party(name='Synthetic person',isSelf=false){const r=await command({kind:'counterparty',create:true,patch:{name,isSelf}});return r.preview.intent.id as string;}
async function category(name='Synthetic category',role='expense',parentId:string|null=null){const r=await command({kind:'category',create:true,patch:{name,role,parentId}});return r.preview.intent.id as string;}
async function assign(id:string,categoryId:string,subcategoryId:string|null=null){await command({kind:'operation',id,patch:{categoryId,subcategoryId}});}
async function alias(counterpartyId:string,fill='a'){const id=randomUUID();return within('first',async db=>acceptCounterpartyAlias(db,'first',importEpoch((await financeView(db,'first'))),{id,counterpartyId,type:'phone',hmac:fill.repeat(64)}));}
async function bind(observationId:string,counterpartyId:string,aliasId:string|null=null){return within('first',async db=>acceptCounterpartyObservation(db,'first',importEpoch((await financeView(db,'first'))),{observationId,counterpartyId,aliasId}));}
async function rule(conditions:Record<string,unknown>,assignments:Record<string,unknown>){const r=await command({kind:'rule',create:true,patch:{name:'Synthetic scoped rule',enabled:true,priority:1,conditions,assignments}});return r.preview.intent.id as string;}
async function op(id:string){const r=await request('/finance/operation',{id});assert.equal(r.statusCode,200,r.body);return r.json();}
const resetIntent=(keepCategories=false,keepRules=false,keepInterface=false)=>({kind:'reset_financial',keepCategories,keepRules,keepInterface});
const prepared=(c:{contextId:string;generation:string;keyVersion:string})=>({contextId:c.contextId,generation:c.generation,keyVersion:c.keyVersion});
async function context(contextId=randomUUID()){
 const r=await request('/finance/import-context',{contextId});assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');return r.json();
}
async function resetPreview(intent=resetIntent()){
 const r=await request('/finance/epoch');assert.equal(r.statusCode,200,r.body);const w=r.json(),actionId=randomUUID(),p=await request('/finance/preview',{actionId,generation:w.generation,revision:w.revision,intent});assert.equal(p.statusCode,200,p.body);return {actionId,preview:p.json(),epoch:w};
}
async function reset(intent=resetIntent()){
 const p=await resetPreview(intent),r=await request('/finance/commit',{actionId:p.actionId,confirmReset:true});assert.equal(r.statusCode,200,r.body);return {...p,result:r.json()};
}
async function counts(user='first'){
 const result:Record<string,number>={};for(const name of ['transaction','source_observation','component','link','account','account_alias','observation_account','counterparty','counterparty_alias','observation_counterparty','category','rule','action','ingestion_context'])result[name]=Number((await pg.owner.query(`SELECT count(*) AS n FROM finance.${name} WHERE user_id=$1`,[user])).rows[0].n);return result;
}
test('two device preparations share one stable 256-bit key while users have independent keys',async()=>{
 const a=await context(),b=await context();assert.equal(a.key,b.key);assert.equal(a.keyVersion,b.keyVersion);assert.equal(a.generation,b.generation);assert.equal(Buffer.from(a.key,'base64url').length,32);assert.notEqual(a.contextId,b.contextId);
 const other=await within('second',async db=>prepareImportContext(db,'second',await prepareFinance(db,'second'),{contextId:randomUUID()},envelope(fc.wrappingKey)));assert.notEqual(a.key,other.key);
 const h=(key:string)=>createHmac('sha256',Buffer.from(key,'base64url')).update('account/bank_account/synthetic-id').digest('hex');assert.equal(h(a.key),h(b.key));assert.notEqual(h(a.key),h(other.key));
 const rows=(await pg.owner.query('SELECT sealed_key FROM protected_keys.pseudonym_key')).rows;assert.equal(rows.length,2);assert.equal(JSON.stringify(rows).includes(a.key),false);assert.equal(JSON.stringify(await view()).includes(a.key),false);
});
test('concurrent key preparation is idempotent and never creates different current keys',async()=>{
 const results=await Promise.all([context(),context(),context()]);assert.equal(new Set(results.map(r=>r.key)).size,1);assert.equal((await pg.owner.query("SELECT count(*) AS n FROM protected_keys.pseudonym_key WHERE user_id='first'")).rows[0].n,'1');
 const retry=await context(results[0].contextId);assert.deepEqual(retry,results[0]);assert.equal((await counts()).action,0);
});
test('protected keys and capabilities are inaccessible to control and mail roles',async()=>{
 const c=await context();
 for(const pool of [pg.finance,pg.control,pg.mailFinance,pg.mailControl])await assert.rejects(pool.query('SELECT * FROM protected_keys.pseudonym_key'),{code:'42501'});
 for(const pool of [pg.control,pg.mailFinance,pg.mailControl])await assert.rejects(pool.query('SELECT * FROM finance.ensure_pseudonym_key($1,$2,$3)',[c.generation,c.keyVersion,'untrusted']),{code:'42501'});
 await assert.rejects(within('first',db=>db.query('UPDATE finance.workspace SET key_version=gen_random_uuid() WHERE user_id=$1',['first'])),{code:'42501'});
 const other=await within('second',db=>prepareFinance(db,'second'));await assert.rejects(within('first',db=>db.query('SELECT * FROM finance.ensure_pseudonym_key($1,$2,$3)',[other.generation,other.key_version,'untrusted'])),{code:'40001'});
});
test('key endpoint requires own verified active session and rejects extra fields or GET',async()=>{
 const anonymous=await server.fastify.inject({method:'POST',url:'/finance/import-context',payload:{contextId:randomUUID()},headers:{origin:fc.origin}});assert.equal(anonymous.statusCode,401);
 assert.equal((await request('/finance/import-context')).statusCode,404);assert.equal((await request('/finance/import-context',{contextId:randomUUID(),userId:'second'})).statusCode,400);
 await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id='first'");assert.equal((await request('/finance/import-context',{contextId:randomUUID()})).statusCode,403);
 assert.equal((await pg.owner.query('SELECT count(*) AS n FROM protected_keys.pseudonym_key')).rows[0].n,'0');
});
test('reset preview is read-only, lists exact counts and requires all preservation choices',async()=>{
 const p=await append('-1000');await command({kind:'operation',id:p.transactionId,patch:{comment:'Private synthetic note'}});const c=await context(),before=await view(),p0=await resetPreview();
 assert.deepEqual(await view(),before);assert.equal(p0.preview.impact.details.counts.operations,1);assert.equal(p0.preview.impact.details.counts.observations,1);assert.equal(p0.preview.impact.details.counts.preparedContexts,1);assert.equal(p0.preview.impact.details.requiresConfirmation,true);assert.equal((await context(c.contextId)).key,c.key);
 const saved=(await pg.owner.query('SELECT intent,preview,change_set FROM finance.action WHERE id=$1',[p0.actionId])).rows[0];assert.equal(saved.change_set,null);assert.equal(JSON.stringify(saved).includes('Private synthetic note'),false);assert.equal(JSON.stringify(saved).includes(p.transactionId),false);assert.equal(JSON.stringify(saved).includes(c.key),false);
 const invalid=await request('/finance/preview',{actionId:randomUUID(),generation:before.generation,revision:before.revision,intent:{kind:'reset_financial',keepCategories:true}});assert.equal(invalid.statusCode,400);
 const missing=await request('/finance/commit',{actionId:p0.actionId});assert.equal(missing.statusCode,400);assert.equal(missing.json().code,'RESET_CONFIRMATION_REQUIRED');assert.deepEqual(await view(),before);
});
test('full reset removes all supported financial copies including inactive parts and merged cards',async()=>{
 const c=await context(),p=await append('-1000'),r=await append('100','refund'),cp=await party(),ca=await alias(cp);await bind(p.observationId,cp,ca.id);
 await within('first',db=>acceptAccountAlias(db,'first',importEpoch(c),{id:randomUUID(),accountId:account,type:'card',hmac:'b'.repeat(64)}));
 await command({kind:'components',id:p.transactionId,parts:[{type:'other',amountMinor:'-1000',role:'expense'}]});const composed=await command({kind:'components',id:p.transactionId,parts:[{type:'other',amountMinor:'-600',role:'expense'},{type:'other',amountMinor:'-400',role:'expense'}]});await command({kind:'link',link:{...link(r.transactionId,p.transactionId,'100').link,targetComponentId:composed.preview.intent.parts[0].id}});
 const cp2=await party('Donor');await command({kind:'merge_counterparties',id:cp,sourceIds:[cp2]});await rule({merchantContains:'shop'},{role:'expense'});await command({kind:'operation',id:p.transactionId,patch:{comment:'Erase this private note'}});
 const before=await counts(),done=await reset(),after=await counts();assert.equal(done.preview.impact.details.counts.components,3);assert.equal(done.result.cleanup.counts.history,before.action);
 for(const [table,n]of Object.entries(after))assert.equal(n,table==='action'?1:0,table);
 const receipt=(await pg.owner.query('SELECT intent,preview,result,undo_patch,change_set,affected_operation_ids FROM finance.action WHERE id=$1',[done.actionId])).rows[0];assert.equal(receipt.undo_patch,null);assert.equal(receipt.change_set,null);assert.deepEqual(receipt.affected_operation_ids,[]);for(const erased of [p.transactionId,cp,'Erase this private note',c.key,'b'.repeat(64)])assert.equal(JSON.stringify(receipt).includes(erased),false);
 const h=await request('/finance/history');assert.equal(h.json().actions.length,1);assert.equal(h.json().actions[0].undoable,false);assert.equal((await request('/finance/operation',{id:p.transactionId})).statusCode,404);
 const fresh=await context();assert.notEqual(fresh.key,c.key);assert.notEqual(fresh.generation,c.generation);assert.notEqual(fresh.keyVersion,c.keyVersion);assert.equal((await pg.owner.query('SELECT count(*) AS n FROM protected_keys.pseudonym_key')).rows[0].n,'1');
});
test('preserved categories and merchant rules remain usable while removed object references require setup',async()=>{
 const cp=await party(),cat=(await view()).categories.find((c:{parentId:string|null;role:string})=>c.parentId===null&&c.role==='expense').id;
 const merchant=await rule({merchantContains:'shop'},{role:'expense',categoryId:cat}),scoped=await rule({accountId:account,counterpartyId:cp},{categoryId:cat,counterpartyId:cp}),before=await view();
 const done=await reset(resetIntent(true,true,true)),after=await view();assert.deepEqual(after.categories,before.categories);assert.equal(after.interfaceEpoch,before.interfaceEpoch);assert.equal(done.result.cleanup.rulesNeedSetup,1);
 assert.deepEqual(after.rules.find((r:{id:string})=>r.id===merchant),before.rules.find((r:{id:string})=>r.id===merchant));const disabled=after.rules.find((r:{id:string})=>r.id===scoped);assert.equal(disabled.enabled,false);assert.equal(disabled.dependencyStatus,'needs_setup');assert.deepEqual(disabled.conditions,{});assert.deepEqual(disabled.assignments,{categoryId:cat});assert.equal(JSON.stringify(after.rules).includes(cp),false);assert.equal(JSON.stringify(after.rules).includes(account),false);
 account=randomUUID();await within('first',db=>acceptAccount(db,'first',importEpoch(after),{id:account,bankId:'synthetic-bank',systemName:'New safe account',type:'bank_account'}));const p=await append('-100');assert.equal((await op(p.transactionId)).semantics.category.value,cat);
});
test('cleared categories disable retained category rules, without silently widening their assignments',async()=>{
 const cat=(await view()).categories.find((c:{parentId:string|null;role:string})=>c.parentId===null&&c.role==='expense').id,id=await rule({merchantContains:'shop'},{categoryId:cat});const done=await reset(resetIntent(false,true,false)),after=await view(),r=after.rules.find((r:{id:string})=>r.id===id);
 assert.equal(after.categories.length,0);assert.equal(r.enabled,false);assert.equal(r.dependencyStatus,'needs_setup');assert.deepEqual(r.assignments,{});assert.equal(JSON.stringify(r).includes(cat),false);assert.notEqual(after.interfaceEpoch,done.epoch.interfaceEpoch);
});
test('all eight explicit preservation combinations have consistent category/rule/interface outcomes',async()=>{
 for(const keepCategories of [false,true])for(const keepRules of [false,true])for(const keepInterface of [false,true]){
  await pg.owner.query("UPDATE identity.rate_limit SET expires_at=clock_timestamp()-interval '1 second'");
  if(!(await view()).categories.length)await category();await rule({merchantContains:'shop'},{role:'expense'});const before=await view(),done=await reset(resetIntent(keepCategories,keepRules,keepInterface)),after=await view();
  assert.equal(after.categories.length,keepCategories?before.categories.length:0);assert.equal(after.rules.length,keepRules?before.rules.length:0);assert.equal(after.interfaceEpoch===before.interfaceEpoch,keepInterface);assert.equal(done.result.cleanup.preserved.interface,keepInterface);
 }
});
test('stale phone preparation and every internal source or alias hook are rejected after reset',async()=>{
 const old=await context(),p=await append('-1000'),cp=await party();await reset();let called=false;
 await assert.rejects(within('first',db=>withPreparedImport(db,'first',prepared(old),async()=>{called=true;})),/IMPORT_CONTEXT_CHANGED/);assert.equal(called,false);
 const bad:Array<(db:PoolClient)=>Promise<unknown>>=[(db:PoolClient)=>acceptAccount(db,'first',importEpoch(old),{id:account,bankId:'safe',systemName:'Old account',type:'bank_account'}),(db:PoolClient)=>acceptAccountAlias(db,'first',importEpoch(old),{id:randomUUID(),accountId:account,type:'card',hmac:'a'.repeat(64)}),(db:PoolClient)=>acceptCounterpartyAlias(db,'first',importEpoch(old),{id:randomUUID(),counterpartyId:cp,type:'phone',hmac:'a'.repeat(64)}),(db:PoolClient)=>acceptCounterpartyObservation(db,'first',importEpoch(old),{observationId:p.observationId,counterpartyId:cp,aliasId:null}),(db:PoolClient)=>acceptObservation(db,'first',importEpoch(old),randomUUID(),null,{},'purchase')];
 for(const write of bad)await assert.rejects(within('first',write),/GENERATION_CHANGED/);const after=await counts();assert.equal(after.transaction,0);assert.equal(after.account,0);assert.equal(after.ingestion_context,0);
});
test('old key version is rejected even if a stale payload substitutes the current generation',async()=>{
 const old=await context();await reset();const fresh=await context(),forged={generation:fresh.generation,keyVersion:old.keyVersion};await assert.rejects(within('first',db=>acceptAccount(db,'first',forged,{id:account,bankId:'safe',systemName:'Old alias payload',type:'bank_account'})),/KEY_VERSION_CHANGED/);
 let called=false;await assert.rejects(within('first',db=>withPreparedImport(db,'first',{...prepared(old),generation:fresh.generation},async()=>{called=true;})),/IMPORT_CONTEXT_CHANGED/);assert.equal(called,false);assert.equal((await counts()).account,0);
});
test('fresh preparation can import again with new pseudonyms and old IDs are never restored by Undo',async()=>{
 const old=await context(),p=await append('-1000'),edited=await command({kind:'operation',id:p.transactionId,patch:{comment:'Old correction'}});await reset();const c=await context();account=randomUUID();
 await within('first',db=>withPreparedImport(db,'first',prepared(c),epoch=>acceptAccount(db,'first',epoch,{id:account,bankId:'synthetic-bank',systemName:'Reimported account',type:'bank_account'})));await append('-1000');assert.equal((await view()).operations.length,1);assert.equal((await request('/finance/operation',{id:p.transactionId})).statusCode,404);
 const stale=await preview({kind:'restore_history',actionIds:[edited.actionId]});assert.equal(stale.statusCode,404);const h=(key:string)=>createHmac('sha256',Buffer.from(key,'base64url')).update('synthetic').digest('hex');assert.notEqual(h(c.key),h(old.key));
});
test('selective deletion invalidates preparations but preserves the stable key and key version',async()=>{
 const c=await context(),p=await append('-1000');await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[p.transactionId]}});const next=await context();assert.equal(next.key,c.key);assert.equal(next.keyVersion,c.keyVersion);assert.notEqual(next.generation,c.generation);await assert.rejects(within('first',db=>withPreparedImport(db,'first',prepared(c),async()=>{})),/IMPORT_CONTEXT_CHANGED/);
});
test('foreign preparation IDs cannot authorize a write under a current own epoch',async()=>{
 const own=await context();
 const foreign=await within('second',async db=>prepareImportContext(db,'second',await prepareFinance(db,'second'),{contextId:randomUUID()},envelope(fc.wrappingKey)));let called=false;
 await assert.rejects(within('first',db=>withPreparedImport(db,'first',{...prepared(own),contextId:foreign.contextId},async()=>{called=true;})),/IMPORT_CONTEXT_CHANGED/);assert.equal(called,false);
});
test('expired preparations stop before writing and show a recovery message',async()=>{
 const c=await context();await pg.owner.query("UPDATE finance.ingestion_context SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[c.contextId]);let called=false;
 await assert.rejects(within('first',db=>withPreparedImport(db,'first',prepared(c),async()=>{called=true;})),/IMPORT_CONTEXT_EXPIRED/);assert.equal(called,false);
 const response=await request('/finance/import-context',{contextId:c.contextId});assert.equal(response.statusCode,409);assert.equal(response.json().message,'Срок подготовки загрузки истёк. Загрузите файл заново.');
});
test('worker acceptance rechecks its context after writes and rollback removes tentative effects',async()=>{
 const c=await context(),id=randomUUID();await assert.rejects(within('first',db=>withPreparedImport(db,'first',prepared(c),async epoch=>{
  await acceptAccount(db,'first',epoch,{id,bankId:'safe',systemName:'Tentative account',type:'bank_account'});await db.query('DELETE FROM finance.ingestion_context WHERE user_id=$1 AND id=$2',['first',c.contextId]);
 })),/IMPORT_CONTEXT_CHANGED/);assert.equal((await view()).accounts.some((a:{id:string})=>a.id===id),false);assert.equal((await counts()).ingestion_context,1);
});
test('repeated reset commit returns its receipt and performs exactly one key rotation',async()=>{
 const done=await reset(),c=await context();assert.deepEqual((await request('/finance/commit',{actionId:done.actionId,confirmReset:true})).json(),done.result);assert.deepEqual((await request('/finance/commit',{actionId:done.actionId})).json(),done.result);const retry=await context(c.contextId);assert.equal(retry.key,c.key);assert.equal(retry.keyVersion,c.keyVersion);assert.equal((await counts()).action,1);
});
test('entitlement revocation, expiry or changed workspace rejects reset commit without deletion',async()=>{
 const p=await append('-1000'),r=await resetPreview();await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id='first'");assert.equal((await request('/finance/commit',{actionId:r.actionId,confirmReset:true})).statusCode,403);assert.equal((await counts()).transaction,1);
 await pg.owner.query("UPDATE identity.security_state SET status='active' WHERE user_id='first'");await pg.owner.query("UPDATE finance.action SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[r.actionId]);assert.equal((await request('/finance/commit',{actionId:r.actionId,confirmReset:true})).statusCode,409);
 const next=await resetPreview();await command({kind:'operation',id:p.transactionId,patch:{comment:'Newer'}});assert.equal((await request('/finance/commit',{actionId:next.actionId,confirmReset:true})).statusCode,409);assert.equal((await op(p.transactionId)).comment,'Newer');
});
test('out-of-protocol object updates invalidate reset preview even when counts and workspace revision stay equal',async()=>{
 const p=await append('-1000'),r=await resetPreview();await pg.owner.query('UPDATE finance.transaction SET comment=$2 WHERE id=$1',[p.transactionId,'New private note']);const rejected=await request('/finance/commit',{actionId:r.actionId,confirmReset:true});assert.equal(rejected.statusCode,409);assert.equal(rejected.json().code,'DEPENDENCIES_CHANGED');assert.equal((await op(p.transactionId)).comment,'New private note');
});
test('a preparation created after preview changes reset scope and requires a new preview',async()=>{
 const r=await resetPreview();await context();const rejected=await request('/finance/commit',{actionId:r.actionId,confirmReset:true});assert.equal(rejected.statusCode,409);assert.equal(rejected.json().code,'DEPENDENCIES_CHANGED');assert.equal((await counts()).account,1);
});
test('concurrent reset confirmations are idempotent and acceptance is serialized with reset',async()=>{
 const c=await context(),r=await resetPreview(),results=await Promise.all([request('/finance/commit',{actionId:r.actionId,confirmReset:true}),request('/finance/commit',{actionId:r.actionId,confirmReset:true})]);assert.equal(results[0]!.statusCode,200,results[0]!.body);assert.deepEqual(results[0]!.json(),results[1]!.json());await assert.rejects(within('first',db=>withPreparedImport(db,'first',prepared(c),async()=>{})),/IMPORT_CONTEXT_CHANGED/);
});
test('full reset leaves another user data, protected key and login/access unchanged',async()=>{
 const other=await within('second',async db=>{const state=await prepareFinance(db,'second'),c=await prepareImportContext(db,'second',state,{contextId:randomUUID()},envelope(fc.wrappingKey));await acceptAccount(db,'second',importEpoch(c),{id:randomUUID(),bankId:'safe',systemName:'Other user',type:'bank_account'});return c;});const before=await counts('second');await reset();assert.deepEqual(await counts('second'),before);
 const retry=await within('second',async db=>prepareImportContext(db,'second',await prepareFinance(db,'second'),{contextId:other.contextId},envelope(fc.wrappingKey)));assert.equal(retry.key,other.key);assert.equal((await request('/security/sessions')).statusCode,200);assert.equal((await request('/finance/epoch')).statusCode,200);assert.equal((await pg.owner.query("SELECT indefinite FROM identity.security_state WHERE user_id='first'")).rows[0].indefinite,true);
});
test('ciphertext transplanted from another user fails closed without exposing a key',async()=>{
 await context();await within('second',async db=>prepareImportContext(db,'second',await prepareFinance(db,'second'),{contextId:randomUUID()},envelope(fc.wrappingKey)));const other=(await pg.owner.query("SELECT sealed_key FROM protected_keys.pseudonym_key WHERE user_id='second'")).rows[0].sealed_key;await pg.owner.query("UPDATE protected_keys.pseudonym_key SET sealed_key=$1 WHERE user_id='first'",[other]);const r=await request('/finance/import-context',{contextId:randomUUID()});assert.equal(r.statusCode,503);assert.equal(r.json().code,'PSEUDONYM_KEY_UNAVAILABLE');assert.equal('key'in r.json(),false);
});
test('reset works above the ordinary graph limit using the epoch endpoint and count-only preview',async()=>{
 const db=await pg.owner.connect();try{
  await db.query('BEGIN');
  await db.query(`INSERT INTO finance.transaction(user_id,id,source_observation_id,semantics) SELECT 'first',gen_random_uuid(),gen_random_uuid(),$1::jsonb FROM generate_series(1,10001)`,[JSON.stringify({kind:{value:'purchase',source:'bank',confidence:100,userVerified:false},role:{value:'expense',source:'bank',confidence:100,userVerified:false},category:{value:null,source:'bank',confidence:0,userVerified:false},subcategory:{value:null,source:'bank',confidence:0,userVerified:false},merchant:{value:'Synthetic',source:'bank',confidence:100,userVerified:false},counterparty:{value:null,source:'bank',confidence:0,userVerified:false}})]);
  await db.query(`INSERT INTO finance.source_observation(user_id,id,transaction_id,account_id,operation_date,amount_minor,currency,merchant_text,description,bank_category,versions,source_kind) SELECT user_id,source_observation_id,id,$1,'{"precision":"day","date":"2026-09-01"}',-100,'RUB','Synthetic','Sanitized','Safe','{"parser":"synthetic-1"}','purchase' FROM finance.transaction WHERE user_id='first'`,[account]);
  await db.query("INSERT INTO finance.observation_account(user_id,observation_id,account_id) SELECT user_id,id,account_id FROM finance.source_observation WHERE user_id='first'");
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 assert.equal((await request('/finance/state')).statusCode,409);const done=await reset();assert.equal(done.result.cleanup.counts.operations,10001);assert.equal(done.result.cleanup.counts.observations,10001);assert.equal((await counts()).transaction,0);assert.equal((await view()).operations.length,0);
});
test('an executing acceptance cannot race an older reset preview or resurrect data after a new reset',async()=>{
 const c=await context(),r=await resetPreview(),id=randomUUID();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const worker=within('first',db=>withPreparedImport(db,'first',prepared(c),async epoch=>{await acceptAccount(db,'first',epoch,{id,bankId:'safe',systemName:'Worker account',type:'bank_account'});entered();await gate;}));
 await Promise.race([started,worker.then(()=>{throw new Error('Acceptance finished before gate');})]);const commit=request('/finance/commit',{actionId:r.actionId,confirmReset:true});release();await worker;const stale=await commit;assert.equal(stale.statusCode,409);assert.equal((await view()).accounts.some((a:{id:string})=>a.id===id),true);
 await reset();await assert.rejects(within('first',db=>withPreparedImport(db,'first',prepared(c),async()=>{})),/IMPORT_CONTEXT_CHANGED/);assert.equal((await counts()).account,0);
});
test('old sessions require a fresh password proof, without retaining it in reset history',async()=>{
 await append('-1000');const r=await resetPreview();await pg.owner.query("UPDATE identity.auth_session SET created_at=clock_timestamp()-interval '6 minutes' WHERE user_id='first'");
 const blocked=await request('/finance/commit',{actionId:r.actionId,confirmReset:true});assert.equal(blocked.statusCode,401);assert.equal(blocked.json().code,'RECENT_AUTHENTICATION_REQUIRED');
 const wrong=await request('/finance/commit',{actionId:r.actionId,confirmReset:true,password:'Wrong password 123!'});assert.equal(wrong.statusCode,401);assert.equal((await counts()).transaction,1);
 const done=await request('/finance/commit',{actionId:r.actionId,confirmReset:true,password:pw});assert.equal(done.statusCode,200,done.body);assert.equal((await counts()).transaction,0);const receipt=(await pg.owner.query('SELECT * FROM finance.action WHERE id=$1',[r.actionId])).rows[0];assert.equal(JSON.stringify(receipt).includes(pw),false);
});
test('password proof failures persist a subject limit across rejected transactions and IP changes',async()=>{
 const r=await resetPreview();await pg.owner.query("UPDATE identity.auth_session SET created_at=clock_timestamp()-interval '6 minutes' WHERE user_id='first'");
 for(let i=0;i<5;i++){const result=await server.fastify.inject({method:'POST',url:'/finance/commit',payload:{actionId:r.actionId,confirmReset:true,password:'Wrong password 123!'},headers:{origin:fc.origin,cookie,'content-type':'application/json'},remoteAddress:'192.0.2.'+(i+1)});assert.equal(result.statusCode,401);}
 const limited=await request('/finance/commit',{actionId:r.actionId,confirmReset:true,password:pw});assert.equal(limited.statusCode,429);assert.equal((await counts()).account,1);assert.equal((await counts()).action,1);
});
