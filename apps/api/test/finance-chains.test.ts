import {importEpoch} from '../src/finance.ts';
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {postgresFixture} from './postgres.ts';
import {createServer} from '../src/server.ts';
import {hashPassword,token} from '../src/crypto.ts';
import {prepareFinance,acceptAccount,acceptObservation,financeView,previewFinance,commitFinance} from '../src/finance.ts';
import type {Config} from '../src/types.ts';
import type {Kind} from '../../../packages/finance-core/src/model.ts';
let pg:Awaited<ReturnType<typeof postgresFixture>>,server:Awaited<ReturnType<typeof createServer>>,control:Awaited<ReturnType<typeof createServer>>,fc:Config;
const pw='Synthetic finance password 123!';let cookie:string,account:string;
before(async()=>{pg=await postgresFixture();fc={profile:'finance',pool:pg.finance,baseURL:'https://api.example.test',origin:'https://app.example.test',authSecret:token(),wrappingKey:randomBytes(32),environment:'test'};server=await createServer(fc);control=await createServer({...fc,profile:'control',pool:pg.control,baseURL:'https://control.example.test',origin:'https://admin.example.test',authSecret:token(),wrappingKey:randomBytes(32)});});
after(async()=>{await server?.close();await control?.close();await pg?.close();});
async function within<T>(user:string,fn:(db:PoolClient)=>Promise<T>){const db=await pg.finance.connect();try{await db.query('BEGIN');await prepareFinance(db,user);const r=await fn(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
async function seed(id:string){await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Synthetic user',$2,true,now(),now())",[id,id+'@example.test']);await pg.owner.query("INSERT INTO identity.auth_account(id,user_id,account_id,provider_id,password,created_at,updated_at) VALUES($1,$2,$2,'credential',$3,now(),now())",[randomUUID(),id,await hashPassword(pw)]);await pg.owner.query('INSERT INTO identity.security_state(user_id,indefinite) VALUES($1,true)',[id]);}
beforeEach(async()=>{
 await pg.owner.query('TRUNCATE identity.auth_user,identity.rate_limit,identity.outbox,commerce.access_cycle,finance.workspace CASCADE');await seed('first');await seed('second');
 const login=await server.fastify.inject({method:'POST',url:'/auth/sign-in/email',payload:{email:'first@example.test',password:pw},headers:{origin:fc.origin,'content-type':'application/json'}});assert.equal(login.statusCode,200);cookie=login.cookies.map(c=>c.name+'='+c.value).join('; ');
 account=randomUUID();await within('first',async db=>{const w=(await financeView(db,'first'));await acceptAccount(db,'first',importEpoch(w),{id:account,bankId:'synthetic-bank',systemName:'Synthetic account',type:'bank_account'});});
});
async function request(path:string,payload?:unknown){return server.fastify.inject({method:payload===undefined?'GET':'POST',url:path,...(payload===undefined?{}:{payload:payload as Record<string,unknown>}),headers:{origin:fc.origin,cookie,...(payload===undefined?{}:{'content-type':'application/json'})}});}
async function view(){const r=await request('/finance/state');assert.equal(r.statusCode,200,r.body);return r.json();}
async function append(amount:string,kind:Kind='purchase',transactionId:string|null=null,bankAccount=account,day='2026-09-01'){
 return within('first',async db=>{const w=await financeView(db,'first');return acceptObservation(db,'first',importEpoch(w),randomUUID(),transactionId,{accountId:bankAccount,operationDate:{precision:'day',date:day},postedDate:null,amountMinor:amount,currency:'RUB',merchantText:'Synthetic shop',description:'Sanitized example',bankCategory:'Safe bank category',bankRefHmac:null,versions:{parser:'synthetic-1',normalizer:'1',sanitizer:'1'}},kind);});
}
async function command(intent:unknown){const w=await view(),actionId=randomUUID(),preview=await request('/finance/preview',{actionId,generation:w.generation,revision:w.revision,intent});assert.equal(preview.statusCode,200,preview.body);const commit=await request('/finance/commit',{actionId});assert.equal(commit.statusCode,200,commit.body);return {actionId,preview:preview.json(),result:commit.json()};}
function link(sourceId:string,targetId:string,amountMinor:string,kind='refund'){return {kind:'link',link:{sourceId,targetId,kind,amountMinor,status:'confirmed'}};}

async function preview(intent:unknown){const w=await view();return request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent});}
async function chain(){
 const p=await append('-600'),q=await append('-400'),r=await append('1000','refund'),v=await append('-200','reversal',null,account,'2026-10-01'),w=await view();
 const food=w.categories.find((c:{name:string;parentId:string|null})=>c.name==='Продукты'&&c.parentId===null).id,clothes=w.categories.find((c:{name:string;parentId:string|null})=>c.name==='Одежда и аксессуары'&&c.parentId===null).id;
 await command({kind:'operation',id:p.transactionId,patch:{categoryId:food}});await command({kind:'operation',id:q.transactionId,patch:{categoryId:clothes}});
 const first=await command(link(r.transactionId,p.transactionId,'600')),second=await command(link(r.transactionId,q.transactionId,'400'));
 const upstream=first.preview.intent.id,other=second.preview.intent.id,intent={...link(v.transactionId,r.transactionId,'200','reversal'),link:{...link(v.transactionId,r.transactionId,'200','reversal').link,targetAllocationId:upstream}};
 return {p:p.transactionId,q:q.transactionId,r:r.transactionId,v:v.transactionId,food,clothes,first,second,upstream,other,intent};
}
test('HTTP preview is read-only and the confirmed derived refund reversal changes only its own period/category',async()=>{
 const c=await chain(),before=await view(),p=await preview(c.intent);assert.equal(p.statusCode,200,p.body);assert.equal(p.json().impact.after.netExpensesMinor,'200');assert.deepEqual(p.json().impact.affectedOperationIds,[c.v]);assert.equal((await view()).summary.netExpensesMinor,'0');
 const committed=await request('/finance/commit',{actionId:p.json().actionId});assert.equal(committed.statusCode,200,committed.body);assert.deepEqual((await request('/finance/commit',{actionId:p.json().actionId})).json(),committed.json());assert.equal((await view()).revision,(BigInt(before.revision)+1n).toString());
 const oct=(await request('/finance/summary',{from:'2026-10-01',categoryIds:[c.food]})).json().summary;assert.equal(oct.netExpensesMinor,'200');assert.equal(oct.incomeMinor,'0');const card=(await request('/finance/operation',{id:c.v})).json();assert.equal(card.links[0].targetAllocationId,c.upstream);assert.equal(card.projection.parts[0].allocationId,card.links[0].id);assert.equal(card.source.amountMinor,'-200');
});
test('category edits propagate through two derived generations while manual child decisions retain priority',async()=>{
 const c=await chain(),third=await command(c.intent),last=await append('200','reversal');await command({...link(last.transactionId,c.v,'200','reversal'),link:{...link(last.transactionId,c.v,'200','reversal').link,targetAllocationId:third.preview.intent.id}});
 await command({kind:'operation',id:c.p,patch:{categoryId:c.clothes}});assert.equal((await request('/finance/operation',{id:last.transactionId})).json().projection.parts[0].categoryId,c.clothes);
 await command({kind:'operation',id:c.v,patch:{categoryId:c.food}});assert.equal((await request('/finance/operation',{id:last.transactionId})).json().projection.parts[0].categoryId,c.food);assert.equal((await view()).summary.netExpensesMinor,'0');assert.equal((await pg.owner.query('SELECT count(*) FROM finance.source_observation')).rows[0].count,'5');
});
test('two independent confirmations cannot spend the same derived target capacity',async()=>{
 const c=await chain(),one=await append('-400','reversal'),two=await append('-400','reversal'),w=await view(),actions=[randomUUID(),randomUUID()];
 for(const [i,o]of [one,two].entries()){const p=await request('/finance/preview',{actionId:actions[i],generation:w.generation,revision:w.revision,intent:{...link(o.transactionId,c.r,'400','reversal'),link:{...link(o.transactionId,c.r,'400','reversal').link,targetAllocationId:c.upstream}}});assert.equal(p.statusCode,200,p.body);}
 const results=await Promise.allSettled(actions.map(actionId=>within('first',db=>commitFinance(db,'first',{actionId}))));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);assert.equal((await pg.owner.query('SELECT count(*) FROM finance.link')).rows[0].count,'3');
});
test('a derived source allocation replaces only its declared money and leaves the remainder visible',async()=>{
 const p=await append('-1000'),r=await append('1000','refund'),debt=await append('-300','transfer_out'),root=await command(link(r.transactionId,p.transactionId,'1000'));
 await command({...link(r.transactionId,debt.transactionId,'300','debt_repayment'),link:{...link(r.transactionId,debt.transactionId,'300','debt_repayment').link,sourceAllocationId:root.preview.intent.id}});const card=(await request('/finance/operation',{id:r.transactionId})).json();assert.equal(card.projection.neutralMinor,'300');assert.equal(card.projection.parts.reduce((n:bigint,p:{amountMinor:string})=>n+BigInt(p.amountMinor),0n),1000n);assert.equal((await view()).summary.netExpensesMinor,'300');
});
test('target-side own transfer portions reverse as neutral, without manufacturing income or expense',async()=>{
 const out=await append('-1000','transfer_out'),incoming=await append('1000','transfer_in'),v=await append('-300','reversal'),own=await command(link(out.transactionId,incoming.transactionId,'1000','own_transfer'));
 await command({...link(v.transactionId,incoming.transactionId,'300','reversal'),link:{...link(v.transactionId,incoming.transactionId,'300','reversal').link,targetAllocationId:own.preview.intent.id}});assert.equal((await request('/finance/operation',{id:v.transactionId})).json().projection.neutralMinor,'300');assert.equal((await view()).summary.netExpensesMinor,'0');assert.equal((await view()).summary.incomeMinor,'0');
});
test('new source facts suspend the ancestor and descendants without clipping their persisted amounts',async()=>{
 const c=await chain();await command(c.intent);await append('-500','purchase',c.p);const w=await view();assert.equal(w.links.find((l:{id:string})=>l.id===c.upstream).reason,'CAPACITY_CONFLICT');assert.equal(w.operations.find((o:{id:string})=>o.id===c.v).unresolvedMinor,'200');assert.equal((await pg.owner.query('SELECT amount_minor FROM finance.link WHERE id=$1',[c.upstream])).rows[0].amount_minor,'600');
 await command({kind:'operation',id:c.p,patch:{corrections:{amountMinor:'-600'}}});assert.ok((await view()).links.every((l:{active:boolean})=>l.active));assert.equal((await view()).summary.netExpensesMinor,'200');
});
test('rejecting a producer preserves the descendant decision but suspends its calculation',async()=>{
 const c=await chain(),child=await command(c.intent);await command({kind:'link',id:c.upstream,link:{...link(c.r,c.p,'600').link,status:'rejected'}});const w=await view();assert.equal(w.links.find((l:{id:string})=>l.id===child.preview.intent.id).reason,'DEPENDENCY_CONFLICT');assert.equal(w.operations.find((o:{id:string})=>o.id===c.v).unresolvedMinor,'200');assert.equal((await pg.owner.query('SELECT status FROM finance.link WHERE id=$1',[child.preview.intent.id])).rows[0].status,'confirmed');
});
test('server rejects cyclic references and selector ambiguity before writing a preview',async()=>{
 const c=await chain(),child=await command(c.intent);const cycle=await preview({kind:'link',id:c.upstream,link:{...link(c.r,c.v,'600','reversal').link,targetAllocationId:child.preview.intent.id}});assert.equal(cycle.statusCode,409);assert.equal(cycle.json().code,'CYCLIC_DEPENDENCY');
 for(const patch of [{targetComponentId:randomUUID()},{targetAllocationId:42},{extra:true},{amountMinor:1}]){const r=await preview({...c.intent,link:{...c.intent.link,...patch}});assert.equal(r.statusCode,400,r.body);}assert.equal((await pg.owner.query('SELECT target_allocation_id FROM finance.link WHERE id=$1',[c.upstream])).rows[0].target_allocation_id,null);
});
test('deferred database constraints reject cycles, wrong parent operation and self-reference independently of HTTP',async()=>{
 const a=await append('100','refund'),b=await append('-100','reversal'),x=randomUUID(),y=randomUUID();
 await assert.rejects(within('first',async db=>{await db.query("INSERT INTO finance.link(user_id,id,source_id,target_id,target_allocation_id,kind,amount_minor,status,confidence,created_by) VALUES('first',$1,$2,$3,$4,'reversal',100,'candidate',100,'user'),('first',$4,$3,$2,$1,'reversal',100,'candidate',100,'user')",[x,a.transactionId,b.transactionId,y]);}),{code:'23514'});
 const p=await append('-100'),root=await command(link(a.transactionId,p.transactionId,'100'));
 await assert.rejects(within('first',db=>db.query("INSERT INTO finance.link(user_id,id,source_id,target_id,target_allocation_id,kind,amount_minor,status,confidence,created_by) VALUES('first',$1,$2,$3,$4,'reversal',100,'candidate',100,'user')",[randomUUID(),b.transactionId,p.transactionId,root.preview.intent.id])),{code:'23514'});
 await assert.rejects(within('first',db=>db.query("INSERT INTO finance.link(user_id,id,source_id,target_id,target_allocation_id,kind,amount_minor,status,confidence,created_by) VALUES('first',$1,$2,$3,$1,'reversal',100,'candidate',100,'user')",[randomUUID(),b.transactionId,a.transactionId])),{code:'23514'});
 assert.equal((await pg.owner.query('SELECT count(*) FROM finance.link')).rows[0].count,'1');
});
test('another user allocation cannot confer HTTP authority or pass composite foreign keys',async()=>{
 const c=await chain(),otherAccount=randomUUID(),otherLink=randomUUID();await within('second',async db=>{const w=await financeView(db,'second');await acceptAccount(db,'second',importEpoch(w),{id:otherAccount,bankId:'other',systemName:'Other',type:'bank_account'});const observation=(amountMinor:string)=>({accountId:otherAccount,operationDate:{precision:'day' as const,date:'2026-09-01'},postedDate:null,amountMinor,currency:'RUB',merchantText:'Safe',description:'Safe',bankCategory:'',bankRefHmac:null,versions:{parser:'1',normalizer:'1',sanitizer:'1'}});const p=await acceptObservation(db,'second',importEpoch(w),randomUUID(),null,observation('-100'),'purchase'),r=await acceptObservation(db,'second',importEpoch(w),randomUUID(),null,observation('100'),'refund');await db.query("INSERT INTO finance.link(user_id,id,source_id,target_id,kind,amount_minor,status,confidence,created_by) VALUES('second',$1,$2,$3,'refund',100,'confirmed',100,'user')",[otherLink,r.transactionId,p.transactionId]);});
 const denied=await preview({...c.intent,link:{...c.intent.link,targetAllocationId:otherLink}});assert.equal(denied.statusCode,404);
 await assert.rejects(within('first',db=>db.query("INSERT INTO finance.link(user_id,id,source_id,target_id,target_allocation_id,kind,amount_minor,status,confidence,created_by) VALUES('first',$1,$2,$3,$4,'reversal',100,'candidate',100,'user')",[randomUUID(),c.v,c.r,otherLink])),e=>['23503'].includes((e as {code:string}).code));
 assert.equal((await pg.owner.query("SELECT count(*) FROM finance.link WHERE user_id='second'")).rows[0].count,'1');
 for(const pool of [pg.control,pg.mailControl,pg.mailFinance])await assert.rejects(pool.query('SELECT * FROM finance.link'),{code:'42501'});
});
test('deleting a purchase previews and removes the full reference cascade while surviving operations remain',async()=>{
 const c=await chain(),child=await command(c.intent),last=await append('200','reversal');await command({...link(last.transactionId,c.v,'200','reversal'),link:{...link(last.transactionId,c.v,'200','reversal').link,targetAllocationId:child.preview.intent.id}});
 const intent={kind:'delete_financial',scope:{kind:'operations',operationIds:[c.p]}},p=await preview(intent);assert.equal(p.statusCode,200,p.body);assert.equal(p.json().impact.details.counts.links,3);assert.deepEqual(p.json().impact.details.survivingRelatedOperationIds,[c.r,c.v,last.transactionId].sort());assert.equal((await pg.owner.query('SELECT count(*) FROM finance.link')).rows[0].count,'4');
 const commit=await request('/finance/commit',{actionId:p.json().actionId});assert.equal(commit.statusCode,200,commit.body);const w=await view();assert.equal(w.operations.length,4);assert.equal(w.links.length,1);assert.equal(w.operations.find((o:{id:string})=>o.id===c.v).unresolvedMinor,'200');assert.equal(w.operations.find((o:{id:string})=>o.id===last.transactionId).unresolvedMinor,'200');const actions=(await pg.owner.query('SELECT intent,preview,result,undo_patch,change_set FROM finance.action')).rows;assert.equal(actions.length,1);assert.equal(actions[0].change_set,null);assert.equal(actions[0].undo_patch,null);assert.ok(!JSON.stringify(actions).includes(c.p));assert.equal(w.summary.incomeMinor,'0');
});
test('independently verified survivor meaning remains after its derived dependencies are physically deleted',async()=>{
 const c=await chain();await command(c.intent);await command({kind:'operation',id:c.v,patch:{role:'expense',categoryId:c.clothes}});await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[c.p]}});const card=(await request('/finance/operation',{id:c.v})).json();assert.equal(card.projection.parts[0].role,'expense');assert.equal(card.projection.parts[0].categoryId,c.clothes);assert.equal(card.source.amountMinor,'-200');assert.equal(card.links.length,0);
});
test('undoing a derived link restores only that edit and keeps its ancestor available',async()=>{
 const c=await chain(),child=await command(c.intent);await command({kind:'undo',id:randomUUID(),value:child.actionId});const w=await view();assert.equal(w.links.length,2);assert.ok(w.links.every((l:{active:boolean})=>l.active));assert.equal(w.summary.netExpensesMinor,'0');assert.equal(w.operations.find((o:{id:string})=>o.id===c.v).unresolvedMinor,'200');
});
test('single ancestor rollback reports the dependent child conflict, and selected bulk rollback is atomic',async()=>{
 const c=await chain(),child=await command(c.intent);const single=await preview({kind:'restore_history',actionIds:[c.first.actionId]});assert.equal(single.statusCode,200,single.body);assert.ok(single.json().impact.details.conflicts.some((c:{reason:string})=>c.reason==='DEPENDENCY_CONFLICT'));assert.equal((await request('/finance/commit',{actionId:single.json().actionId})).statusCode,409);assert.equal((await view()).links.length,3);
 const bulk=await command({kind:'restore_history',actionIds:[c.first.actionId,child.actionId]});assert.deepEqual(bulk.preview.impact.details.conflicts,[]);assert.equal((await view()).links.length,1);assert.equal((await view()).summary.netExpensesMinor,'600');assert.equal((await pg.owner.query('SELECT count(*) FROM finance.action WHERE undone=true')).rows[0].count,'2');
});
test('changing a producer endpoint cannot silently relabel a referenced portion',async()=>{
 const c=await chain();await command(c.intent);const other=await append('600','refund');const r=await preview({kind:'link',id:c.upstream,link:{...link(other.transactionId,c.p,'600').link}});assert.equal(r.statusCode,409);assert.equal(r.json().code,'ALLOCATION_REFERENCE_CONFLICT');assert.equal((await pg.owner.query('SELECT source_id FROM finance.link WHERE id=$1',[c.upstream])).rows[0].source_id,c.r);
});
test('loan model changes propagate invalidity to a reversal of the principal refund and recover without rewriting facts',async()=>{
 const p=await append('-1000','loan_payment'),r=await append('800','refund'),v=await append('-100','reversal');const components=await command({kind:'components',id:p.transactionId,parts:[{type:'principal',amountMinor:'-800'},{type:'interest',amountMinor:'-200'}]});const principal=components.preview.intent.parts[0].id;
 const parent=await command({...link(r.transactionId,p.transactionId,'800'),link:{...link(r.transactionId,p.transactionId,'800').link,targetComponentId:principal}});await command({...link(v.transactionId,r.transactionId,'100','reversal'),link:{...link(v.transactionId,r.transactionId,'100','reversal').link,targetAllocationId:parent.preview.intent.id}});assert.equal((await view()).summary.netExpensesMinor,'300');
 await command({kind:'analytics',value:'economic'});let w=await view();assert.equal(w.links.find((l:{id:string})=>l.id===parent.preview.intent.id).reason,'INCOMPATIBLE_RETURN');assert.equal(w.operations.find((o:{id:string})=>o.id===v.transactionId).unresolvedMinor,'100');assert.equal(w.summary.netExpensesMinor,'200');await command({kind:'analytics',value:'cashflow'});w=await view();assert.ok(w.links.every((l:{active:boolean})=>l.active));assert.equal(w.summary.netExpensesMinor,'300');
});
test('replacing explicit components suspends nested endpoints, and Undo restores the original graph',async()=>{
 const p=await append('-1000'),r=await append('600','refund'),v=await append('-100','reversal');const parts=await command({kind:'components',id:p.transactionId,parts:[{type:'other',amountMinor:'-600',role:'expense'},{type:'other',amountMinor:'-400',role:'expense'}]}),parent=await command({...link(r.transactionId,p.transactionId,'600'),link:{...link(r.transactionId,p.transactionId,'600').link,targetComponentId:parts.preview.intent.parts[0].id}});await command({...link(v.transactionId,r.transactionId,'100','reversal'),link:{...link(v.transactionId,r.transactionId,'100','reversal').link,targetAllocationId:parent.preview.intent.id}});
 const replacement=await command({kind:'components',id:p.transactionId,parts:[{type:'other',amountMinor:'-700',role:'expense'},{type:'other',amountMinor:'-300',role:'expense'}]});assert.ok((await view()).links.every((l:{active:boolean})=>!l.active));await command({kind:'undo',id:randomUUID(),value:replacement.actionId});assert.ok((await view()).links.every((l:{active:boolean})=>l.active));assert.equal((await view()).summary.netExpensesMinor,'500');
});
test('full financial reset clears every nested link and old journal in one transaction',async()=>{
 const c=await chain();await command(c.intent);const p=await preview({kind:'reset_financial',keepCategories:true,keepRules:true,keepInterface:true});assert.equal(p.statusCode,200,p.body);const reset=await request('/finance/commit',{actionId:p.json().actionId,confirmReset:true});assert.equal(reset.statusCode,200,reset.body);const w=await view();assert.equal(w.operations.length,0);assert.equal(w.links.length,0);assert.equal((await pg.owner.query('SELECT count(*) FROM finance.action')).rows[0].count,'1');assert.equal((await pg.owner.query('SELECT count(*) FROM finance.link')).rows[0].count,'0');
});

test('an existing own-transfer portion cannot hide a second counterparty through a nested source selector',async()=>{
 const out=await append('-1000','transfer_out'),incoming=await append('1000','transfer_in'),third=await append('1000','transfer_in'),own=await command(link(out.transactionId,incoming.transactionId,'1000','own_transfer'));
 const r=await preview({...link(out.transactionId,third.transactionId,'1000','own_transfer'),link:{...link(out.transactionId,third.transactionId,'1000','own_transfer').link,sourceAllocationId:own.preview.intent.id}});assert.equal(r.statusCode,409);assert.equal(r.json().code,'SOURCE_ALREADY_PAIRED');assert.equal((await view()).operations.find((o:{id:string})=>o.id===third.transactionId).unresolvedMinor,'1000');
});
test('database cascade removes dependent links even when a producer is deleted outside the mutation API',async()=>{
 const c=await chain(),child=await command(c.intent),last=await append('200','reversal');await command({...link(last.transactionId,c.v,'200','reversal'),link:{...link(last.transactionId,c.v,'200','reversal').link,targetAllocationId:child.preview.intent.id}});
 await within('first',db=>db.query('DELETE FROM finance.link WHERE user_id=$1 AND id=$2',['first',c.upstream]));assert.equal((await pg.owner.query('SELECT count(*) FROM finance.link')).rows[0].count,'1');assert.equal((await view()).operations.length,5);assert.equal((await view()).operations.find((o:{id:string})=>o.id===last.transactionId).unresolvedMinor,'200');
});
