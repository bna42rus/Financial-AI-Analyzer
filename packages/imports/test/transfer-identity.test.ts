import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createLocalPreparation} from '../src/local.ts';
import {localBankAdapter} from '../src/bank-table.ts';
import {merchantSourceSanitizer} from '../src/safe-source.ts';
import {matchSource} from '../src/matching.ts';
import {validatePreparedBatch} from '../src/contract.ts';
import {parseBankPdf} from '../src/bank-pdf.ts';
import {syntheticLayout} from './synthetic-layout.ts';
const context=()=>({contextId:randomUUID(),generation:randomUUID(),keyVersion:randomUUID(),key:Buffer.alloc(32,5).toString('base64url'),expiresAt:new Date(Date.now()+60000).toISOString(),normalizers:['strict-source/3']});
const row=(account:string,description:string)=>({operationDate:{precision:'day',date:'2026-01-01',time:'10:20:30'},postedDate:null,amountMinor:'-12300',currency:'RUB',direction:'debit',account:{kind:'bank_account' as const,value:account},localDescription:description,parser:'tbank-movement-pdf/3'});
test('complete other-side identifiers share the owned-account namespace without sending raw identifiers',async()=>{
 const one='00000000000000000001',two='00000000000000000002',session=await createLocalPreparation(context(),undefined,localBankAdapter,merchantSourceSanitizer);
 try{
  const batch=await session.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('synthetic peer evidence'),rows:[row(one,'Внутренний перевод на счет '+two),row(two,'Перевод себе')]}]);
  const [out,own]=batch.files[0]!.rows;assert.ok(out);assert.ok(own);
  assert.equal(out.transferAccounts?.find(p=>p.bank==='tbank'&&p.kind==='bank_account')?.hmac,own.account.hmac);
  assert.ok(out.counterpartyEvidence?.hmac);assert.equal(own.operationDate.precision,'day');if(own.operationDate.precision==='day')assert.equal(own.operationDate.time,'10:20:30');
  assert.ok(!JSON.stringify(batch).includes(one));assert.ok(!JSON.stringify(batch).includes(two));validatePreparedBatch(batch);
  const bad=structuredClone(batch);(bad.files[0]!.rows[0]!.transferAccounts![0] as any).raw=two;bad.files[0]!.rows[0]!.operationDate={precision:'day',date:'invalid'};assert.throws(()=>validatePreparedBatch(bad));
 }finally{session.dispose();}
});
test('masked suffixes never establish a full counterparty or owned account',async()=>{
 const session=await createLocalPreparation(context(),undefined,localBankAdapter,merchantSourceSanitizer);
 try{const batch=await session.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('synthetic masked evidence'),rows:[row('00000000000000000001','Перевод на карту ****1234')]}]);const value=batch.files[0]!.rows[0]!;assert.equal(value.counterpartyEvidence,undefined);assert.equal(value.transferAccounts,undefined);}finally{session.dispose();}
});
test('bank sign-off is outside the last financial row and a printed clock survives parsing',()=>{
 const layout=syntheticLayout('tbank');for(const i of layout[0]!)if(i.x===390&&(i.y===650||i.y===600))i.text='Перевод себе';
 layout[0]!.push({text:'С уважением,',x:50,y:550,width:80},{text:'СИНТЕТИЧЕСКАЯ ПОДПИСЬ',x:390,y:550,width:150});
 const parsed=parseBankPdf(randomUUID(),new TextEncoder().encode('synthetic layout'),layout);assert.equal(parsed.rows.length,2);
 assert.equal(parsed.rows[1]!.localDescription,'Перевод себе');const date=parsed.rows[1]!.operationDate as {precision:string;time:string};assert.equal(date.precision,'day');assert.equal(date.time,'23:30:00');
});
test('re-reading the same file enriches clock metadata without choosing another transaction',()=>{
 const incoming={ordinal:1,operationDate:{precision:'day' as const,date:'2026-01-01',time:'10:20:30'},postedDate:null,amountMinor:'-12300',currency:'RUB' as const,direction:'debit' as const,account:{kind:'bank_account' as const,hmac:'a'.repeat(64)},bankRefHmac:null};
 const old={transactionId:'retained',fileHmac:'same-file',ordinal:1,operationDate:{precision:'day' as const,date:'2026-01-01'},postedDate:null,amountMinor:'-12300',currency:'RUB',direction:'debit',bankRefHmac:null};
 assert.equal(matchSource(incoming,'same-file',[old],new Set()).transactionId,'retained');
 assert.equal(matchSource({...incoming,amountMinor:'-12400'},'same-file',[old],new Set()).transactionId,null);
});
