import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {createLocalPreparation} from '../src/local.ts';
import type {ExtractedRow,ExtractedFile,LocalContext} from '../src/local.ts';
import {validatePreparedBatch,versions,MAX_ROWS} from '../src/contract.ts';
const account='00000000000000000001',key=Buffer.alloc(32,17).toString('base64url');
function context(overrides:Partial<LocalContext>={}):LocalContext{return {contextId:randomUUID(),generation:randomUUID(),keyVersion:randomUUID(),key,expiresAt:new Date(Date.now()+60_000).toISOString(),...overrides};}
function row(overrides:Partial<ExtractedRow>={}):ExtractedRow{return {operationDate:{precision:'day',date:'2026-09-01'},amountMinor:'-100',currency:'RUB',direction:'debit',account:{kind:'bank_account',value:account},bankReference:'Synthetic-Ref-1',...overrides};}
function file(rows=[row()],overrides:Partial<ExtractedFile>={}):ExtractedFile{return {fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic file bytes'),rows,...overrides};}
async function prepare(files=[file()],c=context()){const session=await createLocalPreparation(c);try{return await session.prepare(randomUUID(),files);}finally{session.dispose();}}
test('source calendar normalizer negotiates with the backend and preserves legacy wire without guessing a zone',async()=>{
 const f=file([row({operationDate:{precision:'instant',instant:'2026-09-30T22:30:00Z',sourceOffsetMinutes:540}}),row({operationDate:{precision:'instant',instant:'2026-09-30T22:30:00Z'}})]);
 const old=await prepare([f]);assert.equal(old.versions.normalizer,'strict-source/1');assert.equal(Object.hasOwn(old.files[0]!.rows[0]!.operationDate,'sourceOffsetMinutes'),false);
 const current=await prepare([f],context({normalizers:['strict-source/1','strict-source/2']}));assert.equal(current.versions.normalizer,'strict-source/2');assert.deepEqual(current.files[0]!.rows[0]!.operationDate,{precision:'instant',instant:'2026-09-30T22:30:00.000Z',sourceOffsetMinutes:540});assert.deepEqual(current.files[0]!.rows[1]!.operationDate,{precision:'instant',instant:'2026-09-30T22:30:00.000Z',sourceOffsetMinutes:null});
 assert.equal(old.files[0]!.fileHmac,current.files[0]!.fileHmac);assert.equal(old.files[0]!.rows[0]!.bankRefHmac,current.files[0]!.rows[0]!.bankRefHmac);assert.equal(old.files[0]!.rows[0]!.account.hmac,current.files[0]!.rows[0]!.account.hmac);
 const forged=structuredClone(current);forged.versions.normalizer='strict-source/1';forged.files[0]!.rows[0]!.amountMinor='invalid';assert.throws(()=>validatePreparedBatch(forged),/INVALID_IMPORT_PAYLOAD/);
});
test('only allowlisted facts and pseudonyms leave the device, with no free text or raw identifiers',async()=>{
 const source=file([row({description:'Recipient Synthetic Person phone +7 000 000 00 00',merchantText:'Sensitive free text',password:'Synthetic password',recipient:'Synthetic name',rawNumber:account})],{filename:'Synthetic Person.pdf',ocr:'Private local text',password:'Synthetic PDF password'}),batch=await prepare([source]),wire=JSON.stringify(batch);
 for(const secret of [account,'Synthetic-Ref-1','Synthetic Person','Sensitive free text','Private local text','Synthetic password','Synthetic PDF password',key,'Synthetic file bytes'])assert.equal(wire.includes(secret),false);
 assert.equal(batch.files[0]!.rows[0]!.amountMinor,'-100');assert.deepEqual(batch.versions,versions);assert.equal('key' in batch.context,false);
});
test('HMAC agrees with an independent SHA256 implementation and is domain separated',async()=>{
 const batch=await prepare(),alias=batch.files[0]!.rows[0]!.account.hmac;
 assert.equal(alias,createHmac('sha256',Buffer.from(key,'base64url')).update(JSON.stringify([versions.hmac,'tbank','bank_account',account])).digest('hex'));
 const card='0000000000000001',other=await prepare([file([row({account:{kind:'card',value:card},bankReference:card}),row({account:{kind:'loan_contract',value:card},bankReference:card})])]);
 assert.notEqual(other.files[0]!.rows[0]!.account.hmac,other.files[0]!.rows[0]!.bankRefHmac);assert.notEqual(other.files[0]!.rows[0]!.account.hmac,other.files[0]!.rows[1]!.account.hmac);
});
test('same user devices share pseudonyms; other user keys separate both aliases and file fingerprints',async()=>{
 const f=file(),a=await prepare([f]),b=await prepare([f]),c=await prepare([f],context({key:randomBytes(32).toString('base64url')}));
 assert.deepEqual(a.files,b.files);assert.notEqual(a.files[0]!.fileHmac,c.files[0]!.fileHmac);assert.notEqual(a.files[0]!.rows[0]!.account.hmac,c.files[0]!.rows[0]!.account.hmac);
});
test('numeric formatting canonicalizes locally but bank namespaces and leading zeros remain significant',async()=>{
 const a=await prepare([file([row(),row({account:{kind:'bank_account',value:'00000 00000-00000 00001'}})]),file([row()],{bank:'sber'})]);
 assert.equal(a.files[0]!.rows[0]!.account.hmac,a.files[0]!.rows[1]!.account.hmac);assert.notEqual(a.files[0]!.rows[0]!.account.hmac,a.files[1]!.rows[0]!.account.hmac);
 const b=await prepare([file([row({account:{kind:'bank_account',value:'1'}})])]);assert.equal(b.files[0]!.rows.length,0);assert.equal(b.files[0]!.issues[0]!.code,'INVALID_ACCOUNT');
});
test('opaque bank reference case, punctuation and internal spacing do not collapse distinct IDs',async()=>{
 const batch=await prepare([file(['Ref-A','ref-A','Ref/A','Ref A','Ref  A'].map(bankReference=>row({bankReference})))]);
 assert.equal(new Set(batch.files[0]!.rows.map(r=>r.bankRefHmac)).size,5);
});
test('identical real purchases retain separate ordinals; file fingerprint does not suppress re-preparation',async()=>{
 const f=file([row(),row()]),a=await prepare([f]),b=await prepare([f]);assert.equal(a.files[0]!.rows.length,2);assert.deepEqual(a.files[0]!.rows.map(r=>r.ordinal),[1,2]);assert.deepEqual(a.files,b.files);
});
test('missing mandatory facts create technical issues without guessed dates or zero amounts',async()=>{
 const batch=await prepare([file([row(),row({amountMinor:undefined,description:'Private error fragment'}),row({operationDate:undefined}),row({currency:'USD'}),row({account:{kind:'bank_account',value:'masked **** 0001'}})])]);
 const f=batch.files[0]!;assert.equal(f.rows.length,1);assert.deepEqual(f.issues,[{ordinal:2,code:'INVALID_AMOUNT'},{ordinal:3,code:'INVALID_DATE'},{ordinal:4,code:'INVALID_CURRENCY'},{ordinal:5,code:'INVALID_ACCOUNT'}]);assert.equal(JSON.stringify(f).includes('Private error fragment'),false);
 const r=validatePreparedBatch(batch).report;assert.equal(r.counts.rowsFound,5);assert.equal(r.counts.validRows,1);assert.equal(r.counts.rowsNotPrepared,4);
});
test('one blocked file does not remove valid rows from another file',async()=>{
 const batch=await prepare([file([row()],{error:'LOCAL_READ_FAILED'}),file([row(),row()])]),report=validatePreparedBatch(batch).report;
 assert.equal(report.counts.blockedFiles,1);assert.equal(report.counts.validRows,2);assert.equal(report.counts.rowsNotPrepared,1);assert.deepEqual(batch.files[0]!.rows,[]);
});
test('source precision is retained; impossible calendar dates and unnormalized instants are issues',async()=>{
 const batch=await prepare([file([row({operationDate:{precision:'instant',instant:'2026-09-01T20:59:59Z'}}),row({operationDate:{precision:'day',date:'2026-02-30'}}),row({operationDate:{precision:'instant',instant:'2026-09-01T10:00:00+03:00'}}),row({postedDate:{precision:'day',date:'2026-09-02'}})])]);
 assert.deepEqual(batch.files[0]!.rows[0]!.operationDate,{precision:'instant',instant:'2026-09-01T20:59:59.000Z'});assert.deepEqual(batch.files[0]!.issues.map(i=>i.code),['INVALID_DATE','INVALID_DATE']);assert.equal(batch.files[0]!.rows[1]!.postedDate!.precision,'day');
});
test('money keeps exact PostgreSQL bigint bounds and rejects floats, noncanonical and oversized strings',async()=>{
 const values=['-9223372036854775808','9223372036854775807','9223372036854775808',1.01,'01','-0','1.00','1'.repeat(100_000)];
 const batch=await prepare([file(values.map(amountMinor=>row({amountMinor,direction:'unknown'})))]);assert.deepEqual(batch.files[0]!.rows.map(r=>r.amountMinor),values.slice(0,2));assert.equal(batch.files[0]!.issues.length,6);
});
test('declared direction cannot contradict the signed source amount; real zero is not fabricated',async()=>{
 const batch=await prepare([file([row({amountMinor:'100',direction:'debit'}),row({amountMinor:'-100',direction:'credit'}),row({amountMinor:'0',direction:'unknown'}),row({amountMinor:'0',direction:'credit'})])]);
 assert.deepEqual(batch.files[0]!.rows.map(r=>r.ordinal),[3]);assert.deepEqual(batch.files[0]!.issues.map(i=>i.code),['INVALID_DIRECTION','INVALID_DIRECTION','INVALID_DIRECTION']);
});
test('invalid references and invisible/control characters fail closed without echoing their values',async()=>{
 const batch=await prepare([file([row({bankReference:'Private@identifier.test'}),row({account:{kind:'loan_contract',value:'Ref\u202eSecret'}}),row({bankReference:'Private\nRef'})])]);assert.equal(batch.files[0]!.rows.length,0);assert.equal(JSON.stringify(batch).includes('Private'),false);assert.equal(JSON.stringify(batch).includes('Secret'),false);
});
test('disposing an in-flight preparation prevents a sanitized result and rejects future calls',async()=>{
 const s=await createLocalPreparation(context()),pending=s.prepare(randomUUID(),[file()]);s.dispose();await assert.rejects(pending,/PREPARATION_CLOSED/);await assert.rejects(s.prepare(randomUUID(),[file()]),/PREPARATION_CLOSED/);
});
test('an abort signal closes both key initialization and in-flight preparation',async()=>{
 const before=new AbortController();before.abort();await assert.rejects(createLocalPreparation(context(),before.signal),/PREPARATION_CLOSED/);
 const during=new AbortController(),initializing=createLocalPreparation(context(),during.signal);during.abort();await assert.rejects(initializing,/PREPARATION_CLOSED/);
 const active=new AbortController(),session=await createLocalPreparation(context(),active.signal),pending=session.prepare(randomUUID(),[file()]);active.abort();await assert.rejects(pending,/PREPARATION_CLOSED/);await assert.rejects(session.prepare(randomUUID(),[file()]),/PREPARATION_CLOSED/);
});
test('expiry is checked during preparation as well as at key creation',async()=>{
 await assert.rejects(createLocalPreparation(context({expiresAt:'2020-01-01T00:00:00Z'})),/PREPARATION_EXPIRED/);
 const c=context(),s=await createLocalPreparation(c),now=Date.now;try{Date.now=()=>Date.parse(c.expiresAt)+1;await assert.rejects(s.prepare(randomUUID(),[file()]),/PREPARATION_EXPIRED/);await assert.rejects(s.prepare(randomUUID(),[file()]),/PREPARATION_CLOSED/);}finally{Date.now=now;s.dispose();}
});
test('malformed or noncanonical keys are never accepted',async()=>{
 for(const bad of ['',Buffer.alloc(31).toString('base64url'),key+'=',key.slice(0,-1)+'B'])await assert.rejects(createLocalPreparation(context({key:bad})),/INVALID_PREPARATION_KEY/);
});
test('server validation independently quarantines invalid source facts while retaining valid rows',async()=>{
 const batch=await prepare([file([row(),row(),row(),row()])]);batch.files[0]!.rows[1]!.amountMinor='1.5';batch.files[0]!.rows[2]!.operationDate={precision:'day',date:'2026-02-30'};batch.files[0]!.rows[3]!.account.hmac='00000000000000000001';
 const result=validatePreparedBatch(batch);assert.equal(result.batch.files[0]!.rows.length,1);assert.deepEqual(result.report.files[0]!.issues.map(i=>i.code),['INVALID_AMOUNT','INVALID_DATE','INVALID_PSEUDONYM']);assert.equal(JSON.stringify(result.report).includes(account),false);
});
test('missing mandatory wire facts are separate row issues and do not cancel valid rows',async()=>{
 const batch=await prepare([file([row(),row(),row(),row()])]);delete (batch.files[0]!.rows[1] as any).amountMinor;delete (batch.files[0]!.rows[2] as any).operationDate;delete (batch.files[0]!.rows[3] as any).account;
 const r=validatePreparedBatch(JSON.parse(JSON.stringify(batch)));assert.equal(r.report.counts.validRows,1);assert.deepEqual(r.report.files[0]!.issues.map(i=>i.code),['INVALID_AMOUNT','INVALID_DATE','INVALID_ACCOUNT']);
});
test('unknown fields are rejected at every wire boundary, even alongside an invalid row',async()=>{
 const original=await prepare();
 const paths=[[],['context'],['versions'],['files',0],['files',0,'rows',0],['files',0,'rows',0,'account'],['files',0,'rows',0,'operationDate']];
 for(const path of paths){const batch=structuredClone(original);let target:any=batch;for(const p of path)target=target[p];target.rawIdentifier='Private sentinel';batch.files[0]!.rows[0]!.amountMinor='invalid';assert.throws(()=>validatePreparedBatch(batch),/INVALID_IMPORT_PAYLOAD/);}
 const issue=await prepare([file([row({amountMinor:undefined})])]);(issue.files[0]!.issues[0] as any).fragment='Private sentinel';assert.throws(()=>validatePreparedBatch(issue),/INVALID_IMPORT_PAYLOAD/);
});
test('technical response contains no source money, dates, identifiers, HMAC or key',async()=>{
 const batch=await prepare(),report=validatePreparedBatch(batch).report,json=JSON.stringify(report);for(const secret of ['-100','2026-09-01',batch.files[0]!.fileHmac,batch.files[0]!.rows[0]!.account.hmac,key])assert.equal(json.includes(secret),false);assert.equal(report.stage,'validation_only');
});
test('unsupported schemas and all processing version mismatches are rejected',async()=>{
 const original=await prepare();for(const k of Object.keys(versions)){const batch=structuredClone(original);(batch.versions as any)[k]='other/1';assert.throws(()=>validatePreparedBatch(batch),/INVALID_IMPORT_PAYLOAD/);}const b=structuredClone(original);(b as any).schemaVersion=2;assert.throws(()=>validatePreparedBatch(b),/INVALID_IMPORT_PAYLOAD/);
});
test('provenance ordinals must partition rowsFound without duplicates, gaps or invented positions',async()=>{
 const original=await prepare([file([row(),row()])]);for(const ordinal of [0,1,3,1.5]){const b=structuredClone(original);b.files[0]!.rows[1]!.ordinal=ordinal;assert.throws(()=>validatePreparedBatch(b),/INVALID_IMPORT_PAYLOAD/);}const b=structuredClone(original);b.files[0]!.rowsFound=3;assert.throws(()=>validatePreparedBatch(b),/INVALID_IMPORT_PAYLOAD/);
});
test('duplicate file IDs and count limits fail before a large preparation',async()=>{
 const f=file();await assert.rejects(prepare([f,f]),/INVALID_LOCAL_FILE/);await assert.rejects(prepare([file(Array(MAX_ROWS+1).fill(row()))]),/PREPARATION_LIMIT/);
 const b=await prepare();b.files.push(structuredClone(b.files[0]!));assert.throws(()=>validatePreparedBatch(b),/INVALID_IMPORT_PAYLOAD/);
});
