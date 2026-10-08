import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {postgresFixture} from './postgres.ts';
import {createServer} from '../src/server.ts';
import {hashPassword,token,envelope} from '../src/crypto.ts';
import {prepareFinance,prepareImportContext} from '../src/finance.ts';
import {processImport,importStatus,runImportStage,IMPORT_CHUNK} from '../src/import-ingestion.ts';
import {createLocalPreparation} from '../../../packages/imports/src/local.ts';
import type {ExtractedRow,LocalContext} from '../../../packages/imports/src/local.ts';
import type {PreparedBatch} from '../../../packages/imports/src/contract.ts';
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
async function batch(rows=[row()],bytes='Synthetic statement bytes',c?:LocalContext){const local=await createLocalPreparation(c??await context());try{return await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode(bytes),rows,filename:'Private local filename',password:'Private local password'}]);}finally{local.dispose();}}
async function accept(b:PreparedBatch){const r=await request('/finance/import-accept',b);assert.equal(r.statusCode,202,r.body);return r.json();}
async function status(id:string){return within('first',db=>importStatus(db,'first',{batchId:id}));}
async function drain(id:string){for(let n=0;n<30;n++){const s=await status(id);if(!['accepted','processing'].includes(s.status))return s;await within('first',db=>processImport(db,'first',id));}throw new Error('Synthetic import did not finish');}
async function command(intent:unknown){const e=(await request('/finance/epoch')).json(),actionId=randomUUID(),p=await request('/finance/preview',{actionId,generation:e.generation,revision:e.revision,intent});assert.equal(p.statusCode,200,p.body);const c=await request('/finance/commit',{actionId,...((intent as {kind:string}).kind==='reset_financial'?{confirmReset:true}:{})});assert.equal(c.statusCode,200,c.body);return {preview:p.json(),result:c.json()};}
async function counts(){const result:Record<string,number>={};for(const table of ['transaction','source_observation','account','account_alias','ingestion_batch','ingestion_file','ingestion_row','ingestion_account','duplicate_candidate','ingestion_dispatch'])result[table]=Number((await pg.owner.query(`SELECT count(*) AS n FROM finance.${table} WHERE user_id='first'`)).rows[0].n);return result;}

test('acceptance is durable, count-only and does not yet write financial observations',async()=>{
 const b=await batch(),r=await request('/finance/import-accept',b);assert.equal(r.statusCode,202,r.body);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.json().status,'accepted');assert.equal(r.json().counts.pending,1);assert.equal((await counts()).transaction,0);assert.equal((await counts()).ingestion_row,1);
 for(const secret of [account,b.files[0]!.fileHmac,b.files[0]!.rows[0]!.account.hmac,'-100','2026-09-01','Private local'])assert.equal(r.body.includes(secret),false);
 assert.equal((await request('/finance/import-status',{batchId:b.batchId})).statusCode,200);
});
test('a worker can finish an accepted import without the browser or a live preparation TTL',async()=>{
 const b=await batch();await accept(b);await pg.owner.query("UPDATE finance.ingestion_context SET expires_at=clock_timestamp()-interval '1 second'");assert.equal(await runImportStage(pg.finance),true);const s=await status(b.batchId);assert.equal(s.status,'completed');assert.equal(s.counts.created,1);assert.equal(s.counts.review,1);assert.equal(s.newAccountIds.length,1);assert.equal((await counts()).ingestion_dispatch,0);assert.equal((await counts()).source_observation,1);assert.equal((await pg.owner.query('SELECT payload FROM finance.ingestion_row')).rows[0].payload,null);
});
test('invalid rows and blocked files produce exact partial counts without invented transactions',async()=>{
 const b=await batch([row(),row({amountMinor:undefined}),row()]);b.files[0]!.rows[1]!.operationDate={precision:'day',date:'2026-02-30'};b.files.push({fileId:randomUUID(),bank:'sber',fileHmac:'b'.repeat(64),rowsFound:2,status:'blocked',error:'LOCAL_READ_FAILED',rows:[],issues:[]});await accept(b);const s=await drain(b.batchId);assert.equal(s.status,'partial');assert.deepEqual(s.counts,{files:2,blockedFiles:1,rowsFound:5,pending:0,created:1,existing:0,updated:0,notImported:4,removed:0,review:1});assert.equal((await counts()).transaction,1);assert.equal(s.files[0]!.issues[0]!.nextStep,'verify_local_source');
});
test('same batch retry is idempotent after TTL, while altered reuse conflicts',async()=>{
 const b=await batch(),initial=await accept(b);assert.deepEqual(await accept(b),initial);await drain(b.batchId);await pg.owner.query("UPDATE finance.ingestion_context SET expires_at=clock_timestamp()-interval '1 second'");assert.equal((await accept(b)).counts.created,1);b.files[0]!.rows[0]!.amountMinor='-200';const r=await request('/finance/import-accept',b);assert.equal(r.statusCode,409,r.body);assert.equal(r.json().code,'IMPORT_BATCH_REUSED');assert.equal((await counts()).transaction,1);
});
test('the database and server allow one active batch, including concurrent acceptance',async()=>{
 const c=await context(),a=await batch([row()],'first',c),b=await batch([row()],'second',c),results=await Promise.all([request('/finance/import-accept',a),request('/finance/import-accept',b)]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[202,409]);assert.equal(results.find(r=>r.statusCode===409)!.json().code,'IMPORT_ALREADY_ACTIVE');assert.equal((await counts()).ingestion_batch,1);
});
test('exact file instances dedupe one to one while identical real purchases remain two transactions',async()=>{
 const rows=[row({bankReference:undefined}),row({bankReference:undefined})],a=await batch(rows);await accept(a);assert.equal((await drain(a.batchId)).counts.created,2);assert.equal((await counts()).duplicate_candidate,0);const b=await batch(rows);await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.existing,2);assert.equal((await counts()).transaction,2);assert.equal((await counts()).source_observation,4);
});
test('a stable reference joins intersecting different files without duplicating transactions',async()=>{
 const a=await batch();await accept(a);await drain(a.batchId);const b=await batch([row()],'Different bytes');await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.existing,1);assert.equal((await counts()).transaction,1);assert.equal((await counts()).source_observation,2);assert.equal((await counts()).account,1);
});
test('two rows sharing a reference consume a transaction at most once per file',async()=>{
 const a=await batch();await accept(a);await drain(a.batchId);const b=await batch([row(),row()],'Different bytes');await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.existing,1);assert.equal(s.counts.created,1);assert.equal((await counts()).transaction,2);assert.equal((await counts()).duplicate_candidate,1);
});
test('date/amount equality across different files is ambiguous in the text-free profile',async()=>{
 const a=await batch([row({bankReference:undefined})]);await accept(a);await drain(a.batchId);const b=await batch([row({bankReference:undefined})],'Other file');await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.created,1);assert.equal((await counts()).transaction,2);assert.equal((await counts()).duplicate_candidate,1);const ops=(await request('/finance/state')).json().operations;assert.equal(ops.every((o:any)=>o.reviewReasons.includes('possible_duplicate')),true);
});
test('new source facts update one operation while preserving user corrections and verified semantics',async()=>{
 const a=await batch();await accept(a);await drain(a.batchId);const t=(await pg.owner.query('SELECT id FROM finance.transaction')).rows[0].id,category=(await pg.owner.query("SELECT id FROM finance.category WHERE user_id='first' AND role='expense' AND parent_id IS NULL LIMIT 1")).rows[0].id;
 await command({kind:'operation',id:t,patch:{corrections:{amountMinor:'-777',operationDate:{precision:'day',date:'2026-09-05'}},kind:'purchase',role:'expense',categoryId:category,merchant:'Verified shop',comment:'Keep this synthetic comment'}});
 const before=(await pg.owner.query('SELECT corrections,semantics,comment FROM finance.transaction WHERE id=$1',[t])).rows[0];
 const b=await batch([row({amountMinor:'-200'})],'Updated source');await accept(b);assert.equal((await drain(b.batchId)).counts.updated,1);assert.deepEqual((await pg.owner.query('SELECT corrections,semantics,comment FROM finance.transaction WHERE id=$1',[t])).rows[0],before);assert.equal((await counts()).transaction,1);const source=(await pg.owner.query('SELECT o.amount_minor FROM finance.source_observation o JOIN finance.transaction t ON (t.user_id,t.source_observation_id)=(o.user_id,o.id) WHERE t.id=$1',[t])).rows[0];assert.equal(source.amount_minor,'-200');
});
test('a checkpoint retry preserves counts, consumed instances and provenance across restarts',async()=>{
 const rows=Array.from({length:IMPORT_CHUNK+1},(_,i)=>row({bankReference:'Synthetic-'+i})),a=await batch(rows);await accept(a);await within('first',db=>processImport(db,'first',a.batchId));let s=await status(a.batchId);assert.equal(s.status,'processing');assert.equal(s.counts.created,IMPORT_CHUNK);assert.equal(s.counts.pending,1);assert.equal(await runImportStage(pg.finance),true);s=await drain(a.batchId);assert.equal(s.counts.created,rows.length);assert.equal((await counts()).source_observation,rows.length);
});
test('a failed atomic stage rolls back account, operation, provenance and checkpoint together',async()=>{
 const a=await batch([row(),row({bankReference:'Synthetic-2'})]);await accept(a);const before=await counts();await assert.rejects(within('first',async db=>{const query=db.query.bind(db);(db as any).query=async(...args:any[])=>{if(typeof args[0]==='string'&&args[0].startsWith('UPDATE finance.ingestion_row SET status=\'imported\''))throw new Error('Synthetic checkpoint failure');return (query as any)(...args);};try{await processImport(db,'first',a.batchId);}finally{db.query=query;}}));assert.deepEqual(await counts(),before);assert.equal((await drain(a.batchId)).counts.created,2);
});
test('worker races serialize, so two workers never process one row twice',async()=>{
 const a=await batch();await accept(a);await Promise.all([within('first',db=>processImport(db,'first',a.batchId)),within('first',db=>processImport(db,'first',a.batchId))]);assert.equal((await counts()).transaction,1);assert.equal((await counts()).source_observation,1);assert.equal((await status(a.batchId)).counts.created,1);
});
test('physical deletion clears source dedupe and reimports only removed file instances',async()=>{
 const rows=[row({bankReference:'Synthetic-1'}),row({bankReference:'Synthetic-2'})],a=await batch(rows);await accept(a);await drain(a.batchId);const ids=(await pg.owner.query('SELECT transaction_id FROM finance.source_observation ORDER BY bank_ref_hmac')).rows.map(r=>r.transaction_id);await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[ids[0]]}});assert.equal((await counts()).ingestion_row,1);assert.equal((await status(a.batchId)).counts.removed,1);const b=await batch(rows);await accept(b);const s=await drain(b.batchId);assert.equal(s.counts.created,1);assert.equal(s.counts.existing,1);assert.equal((await counts()).transaction,2);assert.equal((await pg.owner.query('SELECT 1 FROM finance.transaction WHERE id=$1',[ids[0]])).rowCount,0);
});
test('deletion invalidates queued copies and old jobs cannot resurrect deleted financial data',async()=>{
 const a=await batch();await accept(a);await drain(a.batchId);const b=await batch([row(),row({bankReference:'Synthetic-2'})],'Pending file');await accept(b);const t=(await pg.owner.query('SELECT id FROM finance.transaction')).rows[0].id;const deletion=await command({kind:'delete_financial',scope:{kind:'operations',operationIds:[t]}});assert.equal(deletion.preview.impact.details.counts.pendingImportRowsInvalidated,2);assert.equal((await counts()).transaction,0);assert.equal((await counts()).ingestion_dispatch,0);await within('first',db=>processImport(db,'first',b.batchId));const s=await status(b.batchId);assert.equal(s.status,'invalidated');assert.equal(s.counts.notImported,2);assert.equal((await pg.owner.query('SELECT 1 FROM finance.ingestion_row WHERE payload IS NOT NULL')).rowCount,0);assert.equal((await request('/finance/import-accept',b)).statusCode,409);
});
test('full reset erases accepted payloads, fingerprints, issues, candidates and scheduler metadata',async()=>{
 const a=await batch([row({amountMinor:undefined}),row()]);await accept(a);const before=await context();const done=await command({kind:'reset_financial',keepCategories:true,keepRules:true,keepInterface:true});assert.equal(done.preview.impact.details.counts.imports,1);assert.equal(done.preview.impact.details.counts.importRows,2);const after=await counts();for(const key of Object.keys(after))assert.equal(after[key],0,key);const fresh=await context();assert.notEqual(fresh.keyVersion,before.keyVersion);assert.equal((await request('/finance/import-status',{batchId:a.batchId})).statusCode,404);
});
test('queued imports recheck current entitlement; suspension leaves a safe retry checkpoint',async()=>{
 const a=await batch();await accept(a);await pg.owner.query("UPDATE identity.security_state SET status='suspended' WHERE user_id='first'");assert.equal(await runImportStage(pg.finance),true);assert.equal((await counts()).transaction,0);assert.equal((await counts()).ingestion_row,1);assert.equal((await request('/finance/import-status',{batchId:a.batchId})).statusCode,403);await pg.owner.query("UPDATE identity.security_state SET status='active' WHERE user_id='first'");assert.equal((await drain(a.batchId)).counts.created,1);
});
test('server refuses missing access, raw smuggling, expired/foreign context and control profile',async()=>{
 const a=await batch();assert.equal((await request('/finance/import-accept',a,{cookie:''})).statusCode,401);assert.equal((await request('/finance/import-accept',a,{origin:'https://other.example.test'})).statusCode,403);assert.equal((await request('/finance/import-accept?private=sentinel',a)).statusCode,404);
 const foreign=await within('second',async db=>prepareImportContext(db,'second',await prepareFinance(db,'second'),{contextId:randomUUID()},envelope(fc.wrappingKey)));const b=structuredClone(a);b.context.contextId=foreign.contextId;assert.equal((await request('/finance/import-accept',b)).statusCode,409);
 (b as any).rawAccount='Private sentinel';b.context=a.context;const bad=await request('/finance/import-accept',b);assert.equal(bad.statusCode,400);assert.deepEqual(bad.json(),{code:'INVALID_IMPORT_PAYLOAD'});assert.equal(bad.body.includes('sentinel'),false);
 const cc=await control.fastify.inject({method:'POST',url:'/finance/import-accept',payload:a,headers:{origin:fc.origin,cookie,'content-type':'application/json'}});assert.equal(cc.statusCode,404);await pg.owner.query("UPDATE finance.ingestion_context SET expires_at=clock_timestamp()-interval '1 second'");assert.equal((await request('/finance/import-accept',a)).json().code,'IMPORT_CONTEXT_EXPIRED');assert.equal((await counts()).ingestion_batch,0);
});
test('ownership/RLS isolate all financial ingestion tables from other users and control/mail roles',async()=>{
 const a=await batch();await accept(a);await drain(a.batchId);await within('second',async db=>{for(const table of ['ingestion_batch','ingestion_file','ingestion_row','ingestion_account','duplicate_candidate'])assert.equal((await db.query(`SELECT 1 FROM finance.${table}`)).rowCount,0);});assert.equal((await within('second',db=>importStatus(db,'second',{batchId:a.batchId})).catch((e:any)=>e.code)),'NOT_FOUND');
 for(const role of ['control_api','mail_finance','mail_control'])for(const table of ['ingestion_batch','ingestion_file','ingestion_row','ingestion_account','duplicate_candidate','ingestion_dispatch'])assert.equal((await pg.owner.query('SELECT has_table_privilege($1,$2,\'SELECT\') AS allowed',[role,'finance.'+table])).rows[0].allowed,false);
});
