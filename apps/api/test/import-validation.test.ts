import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {postgresFixture} from './postgres.ts';
import {createServer} from '../src/server.ts';
import {hashPassword,token,envelope} from '../src/crypto.ts';
import {prepareFinance,prepareImportContext,acceptAccount,acceptObservation,importEpoch} from '../src/finance.ts';
import {createLocalPreparation} from '../../../packages/imports/src/local.ts';
import type {ExtractedRow,LocalContext} from '../../../packages/imports/src/local.ts';
import type {Config} from '../src/types.ts';
let pg:Awaited<ReturnType<typeof postgresFixture>>,server:Awaited<ReturnType<typeof createServer>>,control:Awaited<ReturnType<typeof createServer>>,fc:Config,cookie:string;
const password='Synthetic import password 123!',account='00000000000000000001';
before(async()=>{pg=await postgresFixture();fc={profile:'finance',pool:pg.finance,baseURL:'https://api.example.test',origin:'https://app.example.test',authSecret:token(),wrappingKey:randomBytes(32),environment:'test'};server=await createServer(fc);control=await createServer({...fc,profile:'control',pool:pg.control});});
after(async()=>{await server?.close();await control?.close();await pg?.close();});
async function within<T>(user:string,fn:(db:PoolClient)=>Promise<T>){const db=await pg.finance.connect();try{await db.query('BEGIN');await prepareFinance(db,user);const r=await fn(db);await db.query('COMMIT');return r;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
async function seed(id:string){await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Synthetic user',$2,true,now(),now())",[id,id+'@example.test']);await pg.owner.query("INSERT INTO identity.auth_account(id,user_id,account_id,provider_id,password,created_at,updated_at) VALUES($1,$2,$2,'credential',$3,now(),now())",[randomUUID(),id,await hashPassword(password)]);await pg.owner.query('INSERT INTO identity.security_state(user_id,indefinite) VALUES($1,true)',[id]);}
beforeEach(async()=>{await pg.owner.query('TRUNCATE identity.auth_user,identity.rate_limit,identity.outbox,commerce.access_cycle,finance.workspace CASCADE');await seed('first');await seed('second');const r=await server.fastify.inject({method:'POST',url:'/auth/sign-in/email',payload:{email:'first@example.test',password},headers:{origin:fc.origin,'content-type':'application/json'}});assert.equal(r.statusCode,200,r.body);cookie=r.cookies.map(c=>c.name+'='+c.value).join('; ');});
function request(path:string,payload?:unknown,overrides:Record<string,string>={}){return server.fastify.inject({method:payload===undefined?'GET':'POST',url:path,...(payload===undefined?{}:{payload:payload as Record<string,unknown>}),headers:{origin:fc.origin,cookie,...(payload===undefined?{}:{'content-type':'application/json'}),...overrides}});}
async function context():Promise<LocalContext>{const r=await request('/finance/import-context',{contextId:randomUUID()});assert.equal(r.statusCode,200,r.body);return r.json();}
function row(overrides:Partial<ExtractedRow>={}):ExtractedRow{return {operationDate:{precision:'day',date:'2026-09-01'},amountMinor:'-100',currency:'RUB',direction:'debit',account:{kind:'bank_account',value:account},bankReference:'Synthetic-1',...overrides};}
async function batch(c?:LocalContext,rows=[row()]){const local=await createLocalPreparation(c??await context());try{return await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic statement bytes'),rows,filename:'Private local filename',password:'Private local password'}]);}finally{local.dispose();}}
async function counts(){const result:Record<string,number>={};for(const table of ['transaction','source_observation','account','account_alias','component','link','action','ingestion_context'])result[table]=Number((await pg.owner.query(`SELECT count(*) AS n FROM finance.${table} WHERE user_id='first'`)).rows[0].n);return result;}
async function command(intent:unknown){const e=await request('/finance/epoch'),state=e.json(),actionId=randomUUID(),p=await request('/finance/preview',{actionId,generation:state.generation,revision:state.revision,intent});assert.equal(p.statusCode,200,p.body);const c=await request('/finance/commit',{actionId,...((intent as {kind:string}).kind==='reset_financial'?{confirmReset:true}:{})});assert.equal(c.statusCode,200,c.body);return c.json();}
test('own prepared payload validates with no-store and no financial writes or reflected source content',async()=>{
 const c=await context(),payload=await batch(c),before=await counts(),r=await request('/finance/import-validation',payload);assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.json().stage,'validation_only');assert.deepEqual(r.json().counts,{files:1,blockedFiles:0,rowsFound:1,validRows:1,rowsNotPrepared:0});assert.deepEqual(await counts(),before);
 for(const secret of [account,c.key,payload.files[0]!.fileHmac,payload.files[0]!.rows[0]!.account.hmac,'-100','2026-09-01','Private local'])assert.equal(r.body.includes(secret),false);
});
test('server distinguishes invalid bank facts from semantic review without cancelling valid files',async()=>{
 const c=await context(),payload=await batch(c,[row(),row({amountMinor:undefined}),row()]);payload.files[0]!.rows[1]!.operationDate={precision:'day',date:'2026-02-30'};
 const local=await createLocalPreparation(c);try{const extra=await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'sber',bytes:new Uint8Array([1]),rows:[row()],error:'LOCAL_READ_FAILED'},{fileId:randomUUID(),bank:'ozon',bytes:new Uint8Array([2]),rows:[row()]}]);payload.files.push(...extra.files);}finally{local.dispose();}
 const r=await request('/finance/import-validation',payload);assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().counts,{files:3,blockedFiles:1,rowsFound:5,validRows:2,rowsNotPrepared:3});assert.deepEqual(r.json().files[0].issues,[{ordinal:2,code:'INVALID_AMOUNT'},{ordinal:3,code:'INVALID_DATE'}]);assert.equal((await counts()).transaction,0);
});
test('unknown raw fields fail closed with a static error even when other row facts are invalid',async()=>{
 const payload=await batch();payload.files[0]!.rows[0]!.amountMinor='invalid';(payload.files[0]!.rows[0]!.operationDate as any).rawNumber='Private identifier sentinel';const r=await request('/finance/import-validation',payload);assert.equal(r.statusCode,400,r.body);assert.deepEqual(r.json(),{code:'INVALID_IMPORT_PAYLOAD'});assert.equal(r.body.includes('sentinel'),false);assert.equal((await counts()).transaction,0);
});
test('unverified or unauthenticated users cannot validate a payload',async()=>{
 const payload=await batch();assert.equal((await request('/finance/import-validation',payload,{cookie:''})).statusCode,401);await pg.owner.query("UPDATE identity.auth_user SET email_verified=false WHERE id='first'");assert.equal((await request('/finance/import-validation',payload)).statusCode,401);
});
test('current suspended and expired access is enforced before payload validation',async()=>{
 const payload=await batch();(payload as any).rawIdentifier='Private sentinel';await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id='first'");assert.equal((await request('/finance/import-validation',payload)).statusCode,403);await pg.owner.query("UPDATE identity.security_state SET status='active',indefinite=false,access_end=clock_timestamp()-interval '1 second' WHERE user_id='first'");assert.equal((await request('/finance/import-validation',payload)).statusCode,403);
});
test('a foreign preparation cannot authorize validation even with an own current generation',async()=>{
 const c=await context(),other=await within('second',async db=>prepareImportContext(db,'second',await prepareFinance(db,'second'),{contextId:randomUUID()},envelope(fc.wrappingKey)));
 const payload=await batch(c);payload.context.contextId=other.contextId;const r=await request('/finance/import-validation',payload);assert.equal(r.statusCode,409,r.body);assert.equal(r.json().code,'IMPORT_CONTEXT_CHANGED');assert.equal((await counts()).transaction,0);
});
test('full reset rejects old device generation and substituted fresh generation with an old key',async()=>{
 const old=await context(),payload=await batch(old);await command({kind:'reset_financial',keepCategories:true,keepRules:true,keepInterface:true});const r=await request('/finance/import-validation',payload);assert.equal(r.statusCode,409,r.body);assert.equal(r.json().message,'Данные были сброшены на другом устройстве. Загрузите файл заново.');const fresh=await context();payload.context.generation=fresh.generation;assert.equal((await request('/finance/import-validation',payload)).json().code,'IMPORT_CONTEXT_CHANGED');const newPayload=await batch(fresh);assert.notEqual(newPayload.files[0]!.rows[0]!.account.hmac,payload.files[0]!.rows[0]!.account.hmac);assert.equal((await request('/finance/import-validation',newPayload)).statusCode,200);assert.equal((await counts()).transaction,0);
});
test('selective deletion invalidates old prepared payloads while keeping fresh HMAC aliases stable',async()=>{
 const old=await context(),payload=await batch(old),operation=await within('first',async db=>{
  const id=randomUUID(),epoch=importEpoch(old);await acceptAccount(db,'first',epoch,{id,bankId:'synthetic',systemName:'Synthetic account',type:'bank_account'});
  return acceptObservation(db,'first',epoch,randomUUID(),null,{accountId:id,operationDate:{precision:'day',date:'2026-09-01'},postedDate:null,amountMinor:'-100',currency:'RUB',merchantText:'Synthetic shop',description:'Sanitized',bankCategory:'',bankRefHmac:null,versions:{parser:'synthetic/1'}},'purchase');
 });await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[operation.transactionId]}});assert.equal((await request('/finance/import-validation',payload)).statusCode,409);const fresh=await context(),next=await batch(fresh);assert.equal(next.files[0]!.rows[0]!.account.hmac,payload.files[0]!.rows[0]!.account.hmac);assert.equal((await request('/finance/import-validation',next)).statusCode,200);
});
test('server expiry rejects a still locally prepared payload with the recovery message',async()=>{
 const c=await context(),payload=await batch(c);await pg.owner.query("UPDATE finance.ingestion_context SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[c.contextId]);const r=await request('/finance/import-validation',payload);assert.equal(r.statusCode,409,r.body);assert.equal(r.json().code,'IMPORT_CONTEXT_EXPIRED');assert.equal(r.json().message,'Срок подготовки загрузки истёк. Загрузите файл заново.');
});
test('bounded normalized payloads above the auth route limit validate, while auth keeps 8 KiB',async()=>{
 const payload=await batch(await context(),Array.from({length:1000},()=>row({bankReference:undefined})));assert.ok(JSON.stringify(payload).length>8192);const r=await request('/finance/import-validation',payload);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().counts.validRows,1000);const auth=await request('/auth/sign-in/email',{email:'first@example.test',password:'x'.repeat(9000)});assert.equal(auth.statusCode,413);assert.deepEqual(auth.json(),{code:'INVALID_REQUEST'});
});
test('oversize, malformed JSON and unsupported versions never reflect request content',async()=>{
 const c=await context(),payload=await batch(c);(payload.versions as any).pipeline='future/1';const wrong=await request('/finance/import-validation',payload);assert.equal(wrong.statusCode,400);assert.deepEqual(wrong.json(),{code:'INVALID_IMPORT_PAYLOAD'});
 for(const text of ['{"private":"Private sentinel"','{"private":"'+('Private sentinel'.repeat(40_000))+'"}']){const r=await server.fastify.inject({method:'POST',url:'/finance/import-validation',payload:text,headers:{origin:fc.origin,cookie,'content-type':'application/json'}});assert.ok([400,413].includes(r.statusCode));assert.deepEqual(r.json(),{code:'INVALID_REQUEST'});assert.equal(r.body.includes('sentinel'),false);}
});
test('method, origin, query and control deployment do not bypass the finance-only contract',async()=>{
 const payload=await batch();assert.equal((await request('/finance/import-validation')).statusCode,404);assert.equal((await request('/finance/import-validation?raw=Private',payload)).statusCode,404);assert.equal((await request('/finance/import-validation',payload,{origin:'https://other.example.test'})).statusCode,403);const r=await control.fastify.inject({method:'POST',url:'/finance/import-validation',payload,headers:{origin:fc.origin,cookie,'content-type':'application/json'}});assert.equal(r.statusCode,404,r.body);
});
test('retries return the same count-only report without consuming context or writing financial history',async()=>{
 const payload=await batch(),before=await counts(),a=await request('/finance/import-validation',payload),b=await request('/finance/import-validation',payload);assert.equal(a.statusCode,200,a.body);assert.deepEqual(a.json(),b.json());assert.deepEqual(await counts(),before);assert.equal((await counts()).action,0);
});
