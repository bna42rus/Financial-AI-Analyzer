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

test('new workspace has starter categories, no invented transactions and scoped runtime roles',async()=>{
 const w=await view();assert.equal(w.operations.length,0);assert.equal(w.summary.netExpensesMinor,'0');assert.equal(w.categories.filter((c:{parentId:string|null})=>c.parentId===null).length,30);assert.equal(w.categories.some((c:{name:string})=>c.name==='Возврат'),false);
 for(const pool of [pg.control,pg.mailControl,pg.mailFinance])await assert.rejects(pool.query('SELECT * FROM finance.transaction'),{code:'42501'});
 assert.equal((await control.fastify.inject({method:'GET',url:'/finance/state',headers:{cookie,origin:'https://admin.example.test'}})).statusCode,404);
});
test('real HTTP snapshot respects session, active entitlement, suspension and canonical paid clock',async()=>{
 assert.equal((await server.fastify.inject({method:'GET',url:'/finance/state'})).statusCode,401);
 await pg.owner.query("INSERT INTO commerce.access_cycle(user_id,anchor_at,access_end,timezone,calendar_months,extra_days) VALUES('first',now()-interval '2 days',now()-interval '1 day','Europe/Moscow',0,1)");
 assert.equal((await request('/finance/state')).statusCode,403);await pg.owner.query("UPDATE commerce.access_cycle SET access_end=now()+interval '1 day' WHERE user_id='first'");assert.equal((await request('/finance/state')).statusCode,200);
 await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id='first'");assert.equal((await request('/finance/state')).statusCode,403);
});
test('RLS, composite source/component/link references and immutable identities block crossing users',async()=>{
 const first=await append('-1000'),otherAccount=randomUUID();let other:string='';await within('second',async db=>{const w=await financeView(db,'second');await acceptAccount(db,'second',importEpoch(w),{id:otherAccount,bankId:'other-bank',systemName:'Other account',type:'bank_account'});other=(await acceptObservation(db,'second',importEpoch(w),randomUUID(),null,{accountId:otherAccount,operationDate:{precision:'day',date:'2026-09-01'},postedDate:null,amountMinor:'1000',currency:'RUB',merchantText:'Other',description:'Safe',bankCategory:'',bankRefHmac:null,versions:{parser:'1',normalizer:'1',sanitizer:'1'}},'refund')).transactionId;});
 const w=await view();assert.equal(w.operations.length,1);assert.equal((await request('/finance/operation',{id:other})).statusCode,404);
 const result=await request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent:link(other,first.transactionId,'1000')});assert.equal(result.statusCode,404);
 await assert.rejects(within('first',db=>db.query("INSERT INTO finance.link(user_id,id,source_id,target_id,kind,amount_minor,status,confidence,created_by) VALUES('first',$1,$2,$3,'refund',1000,'confirmed',100,'user')",[randomUUID(),other,first.transactionId])),{code:'23503'});
 await assert.rejects(within('first',db=>db.query('UPDATE finance.account SET id=$2 WHERE user_id=$1',['first',randomUUID()])),/immutable identity/);
 assert.equal((await pg.finance.query('SELECT * FROM finance.transaction')).rowCount,0,'Pool request has no leaked tenant context');
});
test('effective corrections preserve append-only bank facts and survive a new observation',async()=>{
 const a=await append('-10000'),category=(await view()).categories.find((c:{name:string;parentId:string|null})=>c.name==='Продукты'&&c.parentId===null).id;
 await command({kind:'operation',id:a.transactionId,patch:{corrections:{amountMinor:'-8000',operationDate:{precision:'day',date:'2026-10-02'}},role:'expense',categoryId:category,merchant:'Manual name'}});
 await append('-9000','purchase',a.transactionId);const r=await request('/finance/operation',{id:a.transactionId});assert.equal(r.statusCode,200);const o=r.json();assert.equal(o.source.amountMinor,'-9000');assert.equal(o.source.operationDate.date,'2026-09-01');assert.equal(o.corrections.amountMinor,'-8000');assert.equal(o.semantics.merchant.value,'Manual name');assert.equal(o.source.bankRefHmac,undefined);assert.equal((await view()).summary.netExpensesMinor,'8000');
 await assert.rejects(within('first',db=>db.query('UPDATE finance.source_observation SET amount_minor=1 WHERE user_id=$1',['first'])),{code:'42501'});
 await assert.rejects(within('first',db=>db.query('DELETE FROM finance.source_observation WHERE user_id=$1',['first'])),{code:'42501'});
 assert.equal((await pg.owner.query('SELECT count(*) FROM finance.source_observation')).rows[0].count,'2');
});
test('preview is read-only; commit and retried preview are idempotent across JSON key order',async()=>{
 const a=await append('-1000'),w=await view(),actionId=randomUUID(),intent={kind:'operation',id:a.transactionId,patch:{comment:'Synthetic note'}};
 const p=await request('/finance/preview',{actionId,generation:w.generation,revision:w.revision,intent});assert.equal(p.statusCode,200,p.body);assert.deepEqual(p.json().impact.affectedOperationIds,[a.transactionId]);assert.equal((await request('/finance/operation',{id:a.transactionId})).json().comment,'');
 const c=await request('/finance/commit',{actionId});assert.equal(c.statusCode,200,c.body);assert.deepEqual((await request('/finance/commit',{actionId})).json(),c.json());
 const reordered={patch:{comment:'Synthetic note'},id:a.transactionId,kind:'operation'};assert.deepEqual((await request('/finance/preview',{actionId,generation:w.generation,revision:w.revision,intent:reordered})).json(),c.json());assert.equal((await pg.owner.query("SELECT count(*) FROM finance.action WHERE status='committed'")).rows[0].count,'1');
 assert.equal((await request('/finance/preview',{actionId,generation:w.generation,revision:(await view()).revision,intent:{...intent,patch:{comment:'Different'}}})).statusCode,409);
});
test('changes, expiry, suspension and generation changes after preview block the old commit',async()=>{
 const a=await append('-1000');let w=await view(),actionId=randomUUID();assert.equal((await request('/finance/preview',{actionId,generation:w.generation,revision:w.revision,intent:{kind:'operation',id:a.transactionId,patch:{comment:'Old preview'}}})).statusCode,200);
 await append('-2000');assert.equal((await request('/finance/commit',{actionId})).json().code,'FINANCE_CHANGED');
 w=await view();actionId=randomUUID();await request('/finance/preview',{actionId,generation:w.generation,revision:w.revision,intent:{kind:'operation',id:a.transactionId,patch:{comment:'New preview'}}});
 await pg.owner.query("UPDATE identity.security_state SET indefinite=false,access_end=now()-interval '1 second' WHERE user_id='first'");assert.equal((await request('/finance/commit',{actionId})).statusCode,403);
 await pg.owner.query("UPDATE identity.security_state SET indefinite=true WHERE user_id='first'");await pg.owner.query("UPDATE finance.workspace SET generation=gen_random_uuid() WHERE user_id='first'");assert.equal((await request('/finance/commit',{actionId})).json().code,'GENERATION_CHANGED');
 const stale=await pg.finance.connect();try{await stale.query('BEGIN');await assert.rejects(acceptAccount(stale,'first',importEpoch(w),{id:randomUUID(),bankId:'stale',systemName:'Stale',type:'bank_account'}),/GENERATION_CHANGED/);await stale.query('ROLLBACK');}finally{stale.release();}
});
test('simultaneous commits cannot oversubscribe a return capacity',async()=>{
 const p=await append('-1000'),r=await append('600','refund'),c=await append('600','transfer_in'),w=await view(),ids=[randomUUID(),randomUUID()];
 for(const [index,source]of [r,c].entries())assert.equal((await request('/finance/preview',{actionId:ids[index],generation:w.generation,revision:w.revision,intent:link(source.transactionId,p.transactionId,'600',index===0?'refund':'expense_reimbursement')})).statusCode,200);
 // Separate DB clients bypass the HTTP auth lock: test the financial mutation lock itself.
 const results=await Promise.allSettled(ids.map(actionId=>within('first',db=>commitFinance(db,'first',{actionId}))));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);assert.equal((await pg.owner.query('SELECT count(*) FROM finance.link')).rows[0].count,'1');
 const latest=await view(),newAttempt=await request('/finance/preview',{actionId:randomUUID(),generation:latest.generation,revision:latest.revision,intent:link(c.transactionId,p.transactionId,'600','expense_reimbursement')});assert.equal(newAttempt.statusCode,409);
});
test('linked refund inherits categories and changes only its own period',async()=>{
 const p=await append('-10000'),r=await append('10000','refund',null,account,'2026-10-01'),w=await view(),food=w.categories.find((c:{name:string;parentId:string|null})=>c.name==='Продукты'&&c.parentId===null).id,clothes=w.categories.find((c:{name:string;parentId:string|null})=>c.name==='Одежда и аксессуары'&&c.parentId===null).id;
 await command({kind:'operation',id:p.transactionId,patch:{categoryId:food}});await command(link(r.transactionId,p.transactionId,'10000'));
 const s=await request('/finance/summary',{from:'2026-10-01',through:'2026-10-31'});assert.equal(s.json().summary.netExpensesMinor,'-10000');assert.equal(s.json().summary.incomeMinor,'0');
 await command({kind:'operation',id:p.transactionId,patch:{categoryId:clothes}});assert.equal((await request('/finance/operation',{id:r.transactionId})).json().projection.parts[0].categoryId,clothes);
 await command({kind:'operation',id:r.transactionId,patch:{categoryId:food,role:'expense'}});await command({kind:'operation',id:p.transactionId,patch:{categoryId:food}});await command({kind:'operation',id:p.transactionId,patch:{categoryId:clothes}});assert.equal((await request('/finance/operation',{id:r.transactionId})).json().projection.parts[0].categoryId,food);
});
test('source reconciliation retains confirmed decisions but disables impossible derived allocations',async()=>{
 const p=await append('-1000'),r=await append('1000','refund');await command(link(r.transactionId,p.transactionId,'1000'));await append('-900','purchase',p.transactionId);const w=await view();assert.equal(w.links[0].active,false);assert.equal(w.links[0].reason,'CAPACITY_CONFLICT');assert.equal(w.summary.unresolvedMinor,'1000');assert.equal((await pg.owner.query('SELECT amount_minor,status FROM finance.link')).rows[0].amount_minor,'1000');
 await command({kind:'operation',id:p.transactionId,patch:{corrections:{amountMinor:'-1000'}}});assert.equal((await view()).links[0].active,true);assert.equal((await view()).summary.netExpensesMinor,'0');
});
test('loan components obey account override, replace parent, and warn after amount corrections',async()=>{
 const p=await append('-2500000','loan_payment');await command({kind:'account',id:account,patch:{type:'loan',loanMode:'economic'}});
 await command({kind:'components',id:p.transactionId,parts:[{type:'principal',amountMinor:'-2000000'},{type:'interest',amountMinor:'-450000'},{type:'insurance',amountMinor:'-50000'}]});assert.equal((await view()).summary.netExpensesMinor,'500000');
 await command({kind:'analytics',value:'cashflow'});assert.equal((await view()).summary.netExpensesMinor,'500000');await command({kind:'account',id:account,patch:{loanMode:null}});assert.equal((await view()).summary.netExpensesMinor,'2500000');
 await command({kind:'operation',id:p.transactionId,patch:{corrections:{amountMinor:'-2400000'}}});const w=await view();assert.equal(w.summary.netExpensesMinor,'0');assert.equal(w.summary.unresolvedMinor,'2400000');assert.ok(w.operations[0].reviewReasons.includes('component_conflict'));
});
test('single reversible edit has undo, and stale undo never overwrites a later edit',async()=>{
 const p=await append('-1000'),w=await view(),id=randomUUID();const edit=await request('/finance/edit',{actionId:id,generation:w.generation,revision:w.revision,intent:{kind:'operation',id:p.transactionId,patch:{comment:'First'}}});assert.equal(edit.statusCode,200,edit.body);await command({kind:'undo',id:randomUUID(),value:id});assert.equal((await request('/finance/operation',{id:p.transactionId})).json().comment,'');
 const one=await command({kind:'operation',id:p.transactionId,patch:{comment:'Second'}});await command({kind:'operation',id:p.transactionId,patch:{comment:'Third'}});const latest=await view();assert.equal((await request('/finance/preview',{actionId:randomUUID(),generation:latest.generation,revision:latest.revision,intent:{kind:'undo',id:randomUUID(),value:one.actionId}})).json().code,'UNDO_CONFLICT');assert.equal((await request('/finance/operation',{id:p.transactionId})).json().comment,'Third');
});
test('future personal rules preserve manual facets and do not reclassify old operations',async()=>{
 const p=await append('-1000'),w=await view(),food=w.categories.find((c:{name:string;parentId:string|null})=>c.name==='Продукты'&&c.parentId===null).id;
 await command({kind:'rule',create:true,patch:{name:'Synthetic shop rule',enabled:true,priority:0,conditions:{merchantEquals:'Synthetic shop',direction:'out'},assignments:{categoryId:food}}});assert.equal((await request('/finance/operation',{id:p.transactionId})).json().semantics.category.value,null);const next=await append('-2000');assert.equal((await request('/finance/operation',{id:next.transactionId})).json().semantics.category.value,food);
 const party=await command({kind:'counterparty',create:true,patch:{name:'Алексей И.',state:'registered',isSelf:true}});assert.equal((await view()).counterparties.length,1);assert.equal(party.result.status,'committed');
});
test('raw identifiers, numeric money, foreign analytics currency, guessed dates and unknown fields are rejected',async()=>{
 const p=await append('-1000'),w=await view();for(const patch of [{comment:'Карта 1234567890123456'},{corrections:{amountMinor:1}},{corrections:{operationDate:{precision:'day',date:'2026-02-30'}}},{sourceAmountMinor:'1'}])assert.equal((await request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent:{kind:'operation',id:p.transactionId,patch}})).statusCode,400);
 assert.equal((await request('/finance/state?userId=second')).statusCode,404);assert.equal((await request('/finance/summary',{export:true})).statusCode,400);assert.equal((await request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,userId:'second',intent:{kind:'operation',id:p.transactionId,patch:{comment:'Safe'}}})).statusCode,400);
 assert.equal((await request('/finance/operation',{id:p.transactionId})).json().comment,'');
 for(const bad of [{amountMinor:1},{currency:'EUR'},{operationDate:{precision:'day',date:'2026-02-30'}}])await assert.rejects(within('first',db=>acceptObservation(db,'first',importEpoch(w),randomUUID(),null,{accountId:account,operationDate:{precision:'day',date:'2026-09-01'},postedDate:null,amountMinor:'100',currency:'RUB',merchantText:'Safe',description:'',bankCategory:'',bankRefHmac:null,versions:{parser:'1',normalizer:'1',sanitizer:'1'},...bad},'purchase')));
 assert.equal((await view()).operations.length,1);
});
test('known expense without a category still counts; specific include overrides an excluded account',async()=>{
 const p=await append('-1000');assert.equal((await view()).summary.netExpensesMinor,'1000');assert.equal((await view()).summary.categories[0].id,null);
 await command({kind:'account',id:account,patch:{analyticsEnabled:false}});assert.equal((await view()).summary.netExpensesMinor,'0');await command({kind:'operation',id:p.transactionId,patch:{analyticsOverride:'include'}});assert.equal((await view()).summary.netExpensesMinor,'1000');
});
test('internal observation retry preserves the canonical ID and rejects a reused ID with new data',async()=>{
 const w=await view(),id=randomUUID(),input={accountId:account,operationDate:{precision:'day',date:'2026-09-01'},postedDate:null,amountMinor:'-100',currency:'RUB',merchantText:'Safe',description:'',bankCategory:'',bankRefHmac:null,versions:{parser:'1',normalizer:'1',sanitizer:'1'}};
 const first=await within('first',db=>acceptObservation(db,'first',importEpoch(w),id,null,input,'purchase')),retry=await within('first',db=>acceptObservation(db,'first',importEpoch(w),id,null,input,'purchase'));assert.equal(retry.transactionId,first.transactionId);assert.equal((await view()).operations.length,1);
 await assert.rejects(within('first',db=>acceptObservation(db,'first',importEpoch(w),id,null,{...input,amountMinor:'-200'},'purchase')),/OBSERVATION_REUSED/);
});
test('category parent and child roles cannot silently become contradictory',async()=>{
 const w=await view(),food=w.categories.find((c:{name:string;parentId:string|null})=>c.name==='Продукты'&&c.parentId===null).id,child=w.categories.find((c:{parentId:string|null})=>c.parentId===food).id;
 const a=await request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent:{kind:'category',id:child,patch:{role:'income'}}});assert.equal(a.statusCode,409);assert.equal(a.json().code,'CATEGORY_ROLE_CONFLICT');
 const b=await request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent:{kind:'category',id:food,patch:{role:'income'}}});assert.equal(b.statusCode,409);assert.equal(b.json().code,'DEPENDENCY_MIGRATION_REQUIRED');
 assert.equal((await view()).categories.find((c:{id:string})=>c.id===food).role,'expense');
});

test('operation detail returns a coherent editing epoch and computed related-link outcome; stale edits fail',async()=>{
 const purchase=await append('-10000'),refund=await append('1000','refund');await command(link(refund.transactionId,purchase.transactionId,'1000'));
 const detail=(await request('/finance/operation',{id:purchase.transactionId})).json(),w=await view();assert.equal(detail.generation,w.generation);assert.equal(detail.revision,w.revision);assert.equal(detail.linkStates.length,1);assert.equal(detail.linkStates[0].active,true);assert.equal(detail.source.bankRefHmac,undefined);
 await append('-2000');const stale=await request('/finance/edit',{actionId:randomUUID(),generation:detail.generation,revision:detail.revision,intent:{kind:'operation',id:purchase.transactionId,patch:{comment:'Stale device'}}});assert.equal(stale.statusCode,409);assert.equal(stale.json().code,'FINANCE_CHANGED');assert.equal((await request('/finance/operation',{id:purchase.transactionId})).json().comment,'');
 const current=(await request('/finance/operation',{id:purchase.transactionId})).json();assert.notEqual(current.revision,detail.revision);assert.equal(current.generation,detail.generation);
});


test('interactive finance reads and edits have separate durable limits without consuming authentication budgets',async()=>{
 const a=await append('-1000');
 for(let i=0;i<12;i++){const detail=await request('/finance/operation',{id:a.transactionId});assert.equal(detail.statusCode,200,detail.body);const d=detail.json(),r=await request('/finance/edit',{actionId:randomUUID(),generation:d.generation,revision:d.revision,intent:{kind:'operation',id:a.transactionId,patch:{comment:'Synthetic edit '+i}}});assert.equal(r.statusCode,200,r.body);}
 const d=(await request('/finance/operation',{id:a.transactionId})).json();assert.equal(d.comment,'Synthetic edit 11');assert.equal(d.source.amountMinor,'-1000');
 // Invalid writes consume the same durable budget, and a fresh server cannot bypass it.
 for(let i=12;i<60;i++)assert.equal((await request('/finance/edit',{})).statusCode,400);
 assert.equal((await request('/finance/edit',{})).statusCode,429);const fresh=await createServer(fc);try{assert.equal((await fresh.fastify.inject({method:'POST',url:'/finance/edit',payload:{},headers:{origin:fc.origin,cookie,'content-type':'application/json'}})).statusCode,429);}finally{await fresh.close();}
 // The initial successful login counted once; four failed attempts exhaust the unchanged account budget.
 for(let i=0;i<4;i++)assert.equal((await request('/auth/sign-in/email',{email:'first@example.test',password:'Synthetic wrong password'})).statusCode,401);
 assert.equal((await request('/auth/sign-in/email',{email:'first@example.test',password:'Synthetic wrong password'})).statusCode,429);
});

test('editing component amounts preserves automatic and verified facets, with coherent preview and Undo',async()=>{
 const p=await append('-25000','loan_payment');await command({kind:'analytics',value:'economic'});
 await command({kind:'components',id:p.transactionId,parts:[{type:'principal',amountMinor:'-20000'},{type:'interest',amountMinor:'-5000',role:'expense',categoryId:null}]});
 const detail=(await request('/finance/operation',{id:p.transactionId})).json(),principal=detail.components.find((c:any)=>c.type==='principal'),interest=detail.components.find((c:any)=>c.type==='interest');assert.equal(principal.role.userVerified,false);assert.equal(interest.role.userVerified,true);
 const changed=await command({kind:'components',id:p.transactionId,parts:[{id:principal.id,type:'principal',amountMinor:'-19000'},{id:interest.id,type:'interest',amountMinor:'-6000'}]});
 assert.equal(changed.preview.impact.after.netExpensesMinor,'6000');const after=(await request('/finance/operation',{id:p.transactionId})).json();assert.deepEqual(after.components.find((c:any)=>c.id===principal.id).role,principal.role);assert.deepEqual(after.components.find((c:any)=>c.id===interest.id).role,interest.role);assert.equal(after.source.amountMinor,'-25000');
 await command({kind:'undo',id:randomUUID(),value:changed.actionId});assert.equal((await view()).summary.netExpensesMinor,'5000');
});

test('returning to the whole operation previews invalidated component links, preserves decisions and can be undone',async()=>{
 const p=await append('-10000'),refund=await append('5000','refund'),partId=randomUUID();
 await command({kind:'components',id:p.transactionId,parts:[{id:partId,type:'other',amountMinor:'-10000',role:'expense'}]});
 const linked=await command({kind:'link',link:{sourceId:refund.transactionId,targetId:p.transactionId,targetComponentId:partId,kind:'refund',amountMinor:'5000',status:'confirmed'}});assert.equal((await view()).summary.netExpensesMinor,'5000');
 const w=await view(),actionId=randomUUID(),preview=await request('/finance/preview',{actionId,generation:w.generation,revision:w.revision,intent:{kind:'components',id:p.transactionId,parts:[]}});assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().impact.after.netExpensesMinor,'10000');assert.ok(preview.json().impact.dependencyConflicts.length);assert.equal((await view()).summary.netExpensesMinor,'5000');
 const commit=await request('/finance/commit',{actionId});assert.equal(commit.statusCode,200,commit.body);const d=(await request('/finance/operation',{id:p.transactionId})).json();assert.equal(d.decomposition,false);assert.equal(d.components.length,0);assert.equal(d.links[0].status,'confirmed');assert.equal(d.linkStates[0].active,false);
 await command({kind:'undo',id:randomUUID(),value:actionId});assert.equal((await view()).summary.netExpensesMinor,'5000');assert.equal((await request('/finance/operation',{id:p.transactionId})).json().links[0].id,linked.preview.intent.id);
});

test('component removal and updates cannot cross tenants or silently disregard effective amount corrections',async()=>{
 const p=await append('-10000');await command({kind:'operation',id:p.transactionId,patch:{corrections:{amountMinor:'-8000'}}});const w=await view();
 for(const intent of [{kind:'components',id:randomUUID(),parts:[]},{kind:'components',id:p.transactionId,parts:[{type:'other',amountMinor:'-10000'}]}]){const r=await request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent});assert.equal(r.statusCode,intent.parts.length?409:404,r.body);}
 const second=await within('second',async db=>{const state=await financeView(db,'second');const a=await acceptAccount(db,'second',importEpoch(state),{id:randomUUID(),bankId:'synthetic-bank',systemName:'Other tenant',type:'bank_account'});return acceptObservation(db,'second',importEpoch(await financeView(db,'second')),randomUUID(),null,{accountId:a.id,operationDate:{precision:'day',date:'2026-09-01'},postedDate:null,amountMinor:'-1000',currency:'RUB',merchantText:'Other synthetic shop',description:'Safe',bankCategory:'',bankRefHmac:null,versions:{parser:'synthetic-1',normalizer:'1',sanitizer:'1'}},'purchase');});
 const denied=await request('/finance/preview',{actionId:randomUUID(),generation:w.generation,revision:w.revision,intent:{kind:'components',id:second.transactionId,parts:[]}});assert.equal(denied.statusCode,404);assert.equal((await view()).summary.netExpensesMinor,'8000');
});
