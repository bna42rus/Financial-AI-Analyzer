import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseBankPdf,pdfMoney,BankPdfError,MAX_PDF_BYTES} from '../src/bank-pdf.ts';
import type {PdfLayout,TextItem} from '../src/bank-pdf.ts';
import {readLocalPdf} from '../src/pdf-reader.ts';
import type {LocalPdfEngine} from '../src/pdf-reader.ts';
import {createLocalPreparation} from '../src/local.ts';
import {validatePreparedBatch} from '../src/contract.ts';
const account='00000000000000000001';
const item=(text:string,x:number,y:number):TextItem=>({text,x,y,width:text.length*4});
import {syntheticLayout} from './synthetic-layout.ts';

function parse(bank:'tbank'|'ozon'|'sber',layout=syntheticLayout(bank)){return parseBankPdf(randomUUID(),new TextEncoder().encode('Synthetic bytes'),layout);}
async function prepare(bank:'tbank'|'ozon'|'sber',layout=syntheticLayout(bank)){
 const s=await createLocalPreparation({contextId:randomUUID(),generation:randomUUID(),keyVersion:randomUUID(),key:Buffer.alloc(32,17).toString('base64url'),expiresAt:new Date(Date.now()+60000).toISOString()},undefined,'bank-pdf/1');
 try{return await s.prepare(randomUUID(),[parse(bank,layout)]);}finally{s.dispose();}
}
test('T-Bank uses card-account amount, not foreign operation amount or masked card',async()=>{
 const f=(await prepare('tbank')).files[0]!;assert.equal(f.rows.length,2);assert.deepEqual(f.rows.map(r=>r.amountMinor),['-1001','-1001']);
 assert.deepEqual(f.rows[0]!.operationDate,{precision:'day',date:'2026-09-01'});assert.deepEqual(f.rows[0]!.postedDate,{precision:'day',date:'2026-09-02'});assert.equal(f.rows[0]!.account.kind,'bank_account');
});
test('Sber retains processing date, resolves explicit Moscow time and unsigned debits',async()=>{
 const f=(await prepare('sber')).files[0]!;assert.equal(f.rows.length,2);assert.deepEqual(f.rows.map(r=>r.amountMinor),['-1001','1001']);
 assert.deepEqual(f.rows[0]!.operationDate,{precision:'instant',instant:'2026-09-01T20:30:00.000Z'});assert.deepEqual(f.rows[0]!.postedDate,{precision:'day',date:'2026-09-02'});assert.equal(f.rows[0]!.bankRefHmac,null);
});
test('Ozon uses account contract without assuming loan, signed amount and declared Moscow time',async()=>{
 const f=(await prepare('ozon')).files[0]!;assert.equal(f.rows.length,2);assert.equal(f.rows[0]!.account.kind,'bank_contract');assert.deepEqual(f.rows.map(r=>r.amountMinor),['-1001','1001']);
 assert.deepEqual(f.rows[0]!.operationDate,{precision:'instant',instant:'2026-09-01T20:30:01.000Z'});assert.equal(f.rows[0]!.postedDate,null);assert.equal(f.rows[0]!.bankRefHmac,null);
});
test('raw file, descriptions, name, phone and unstable document/auth codes never enter wire profile',async()=>{
 for(const bank of ['tbank','ozon','sber'] as const){const b=await prepare(bank),json=JSON.stringify(b);for(const s of [account,'Sensitive','Private','123456','Synthetic-Account-A','Synthetic bytes'])assert.equal(json.includes(s),false);assert.equal(b.versions.adapter,'bank-pdf/1');assert.equal(validatePreparedBatch(b).report.counts.validRows,2);}
});
test('identical source purchases retain separate row instances and auth codes never manufacture stable IDs',async()=>{
 const b=await prepare('tbank');assert.deepEqual(b.files[0]!.rows.map(r=>r.ordinal),[1,2]);assert.equal(b.files[0]!.rows.every(r=>r.bankRefHmac===null),true);
});
test('invalid amount and impossible operation date quarantine only their rows, without raw snippets',async()=>{
 const a=syntheticLayout('tbank');a[0]!.find(i=>i.x===290&&i.y===650)!.text='Private malformed amount';const b=await prepare('tbank',a);assert.deepEqual(b.files[0]!.issues,[{ordinal:1,code:'INVALID_AMOUNT'}]);assert.equal(b.files[0]!.rows.length,1);
 const d=syntheticLayout('sber');d[0]!.find(i=>i.x===50&&i.y===650)!.text='30.02.2026';assert.deepEqual((await prepare('sber',d)).files[0]!.issues,[{ordinal:1,code:'INVALID_DATE'}]);
});
test('unsupported currencies never become RUB, even for a recognized bank',async()=>{
 const a=syntheticLayout('sber');a[0]!.find(i=>i.text.startsWith('Валюта:'))!.text='Валюта: ДОЛЛАР США';assert.equal((await prepare('sber',a)).files[0]!.issues.every(i=>i.code==='INVALID_CURRENCY'),true);
 const b=syntheticLayout('tbank');b[0]!.find(i=>i.x===290&&i.y===650)!.text='10.01';assert.deepEqual((await prepare('tbank',b)).files[0]!.issues,[{ordinal:1,code:'INVALID_CURRENCY'}]);
});
test('account identifiers must come from a recognized label, never another number in the document',()=>{
 const a=syntheticLayout('tbank');a[0]!.find(i=>i.text.startsWith('Номер лицевого'))!.text='Номер лицевого счета: ****0001';a[0]!.push(item('Unrelated bank number '+account,50,730));assert.throws(()=>parse('tbank',a),/UNSUPPORTED_LAYOUT/);
});
test('unknown, ambiguous, scanned and unsupported layouts fail without echoing text',()=>{
 assert.throws(()=>parseBankPdf(randomUUID(),new Uint8Array(),[[]]),/OCR_REQUIRED/);
 assert.throws(()=>parseBankPdf(randomUUID(),new Uint8Array(),[[item('Private unknown statement',50,800)]]),/UNKNOWN_FORMAT/);
 const a=syntheticLayout('tbank');a[0]!.push(item('ООО ОЗОН Банк · Справка о движении',50,790));assert.throws(()=>parse('tbank',a),/AMBIGUOUS_FORMAT/);
 const b=syntheticLayout('tbank');b[0]!.find(i=>i.text==='Сумма операции')!.text='Unsupported column';assert.throws(()=>parse('tbank',b),/UNSUPPORTED_LAYOUT/);
});
test('PDF money conversion is exact, bounded, and rejects malformed grouping/precision/exponents',()=>{
 assert.equal(pdfMoney('- 92 233 720 368 547 758.08 ₽').amountMinor,'-9223372036854775808');assert.equal(pdfMoney('+ 0,01').amountMinor,'1');assert.equal(pdfMoney('0.00',true).amountMinor,'0');
 for(const s of ['','1','1.001','1,2','1e3','1 23.45','92233720368547758.08','NaN','--1.00','1.00 USD'])assert.throws(()=>pdfMoney(s));
});
test('no implicit timezone is invented when a statement lacks its timezone legend',async()=>{
 const a=syntheticLayout('ozon');a[0]!.pop();assert.deepEqual((await prepare('ozon',a)).files[0]!.rows[0]!.operationDate,{precision:'day',date:'2026-09-01'});
});
test('repeated page headers with shifted columns preserve all source row ordinals',async()=>{
 const a=syntheticLayout('sber'),second=a[0]!.filter(i=>i.y<=700).map(i=>({...i,x:i.x*.8+15,width:i.width*.8}));a.push(second);
 const f=(await prepare('sber',a)).files[0]!;assert.equal(f.rows.length,4);assert.deepEqual(f.rows.map(r=>r.ordinal),[1,2,3,4]);assert.deepEqual(f.rows.map(r=>r.amountMinor),['-1001','1001','-1001','1001']);
});
test('a later page with an unrecognized table cannot silently truncate the import',()=>{
 const a=syntheticLayout('sber');a.push([item('01.09.2026',50,650),item('Private changed description',150,650),item('10.01',420,650)]);assert.throws(()=>parse('sber',a),/UNSUPPORTED_LAYOUT/);
});
test('Ozon continues its established table on the next page without a repeated header',async()=>{
 const a=syntheticLayout('ozon'),second=a[0]!.filter(i=>i.y<=650).map(i=>({...i}));a[0]!.pop();a.push(second);
 const f=(await prepare('ozon',a)).files[0]!;assert.equal(f.rows.length,4);assert.deepEqual(f.rows.map(r=>r.amountMinor),['-1001','1001','-1001','1001']);
});
test('layout limits and nonfinite coordinates fail closed',()=>{
 assert.throws(()=>parseBankPdf(randomUUID(),new Uint8Array(MAX_PDF_BYTES+1),[]),/LOCAL_LIMIT/);const a=syntheticLayout('tbank');a[0]![0]!.x=NaN;assert.throws(()=>parse('tbank',a),/UNSUPPORTED_LAYOUT/);
});
function engine(outcome:'success'|'password'|'wrong'|'private'|'scan',calls:{destroy:number;cleanup:number;options?:Record<string,unknown>}):LocalPdfEngine{
 return {getDocument:options=>{calls.options=options;return {promise:outcome==='password'||outcome==='wrong'||outcome==='private'?Promise.reject(outcome==='private'?new Error('Private bank content'):Object.assign(new Error('Private password'),{name:'PasswordException',code:outcome==='wrong'?2:1})):Promise.resolve({numPages:1,getPage:async()=>({getTextContent:async()=>({items:outcome==='scan'?[]:syntheticLayout('tbank')[0]!.map(i=>({str:i.text,width:i.width,transform:[1,0,0,1,i.x,i.y]}))}),cleanup:()=>{calls.cleanup++;}})}),destroy:async()=>{calls.destroy++;}}}};
}
test('PDF engine receives memory bytes with network fetch/eval disabled and is destroyed after use',async()=>{
 const calls={destroy:0,cleanup:0,options:undefined as Record<string,unknown>|undefined},bytes=new Uint8Array([1,2]);const f=await readLocalPdf(engine('success',calls),randomUUID(),bytes,'Local synthetic password');assert.equal(f.rows.length,2);assert.equal(calls.destroy,1);assert.equal(calls.cleanup,1);assert.equal(calls.options!.useWorkerFetch,false);assert.equal(calls.options!.isEvalSupported,false);assert.equal('url' in calls.options!,false);assert.deepEqual([...bytes],[1,2]);assert.deepEqual([...(calls.options!.data as Uint8Array)],[0,0]);
});
test('password/read/scan failures are technical only and always destroy the reader',async()=>{
 for(const [outcome,code] of [['password','PASSWORD_REQUIRED'],['wrong','WRONG_PASSWORD'],['private','LOCAL_READ_FAILED'],['scan','OCR_REQUIRED']] as const){const calls={destroy:0,cleanup:0};await assert.rejects(readLocalPdf(engine(outcome,calls),randomUUID(),new Uint8Array([1])),(e:unknown)=>e instanceof BankPdfError&&e.code===code&&!e.message.includes('Private'));assert.equal(calls.destroy,1);}
});
test('abort closes pending extraction and prevents returning raw or prepared rows',async()=>{
 const a=new AbortController();let reject!:(e:unknown)=>void,destroyed=0;
 const e:LocalPdfEngine={getDocument:()=>({promise:new Promise((_,r)=>{reject=r}),destroy:async()=>{destroyed++;reject(new Error('Private interrupted PDF'));}})};
 const pending=readLocalPdf(e,randomUUID(),new Uint8Array([1]),undefined,a.signal);a.abort();await assert.rejects(pending,/PREPARATION_CLOSED/);assert.equal(destroyed,1);
});
