import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {extractSafeSource,parseSafeSource,sourceFields,sourceSanitizer,merchantNames} from '../src/safe-source.ts';
import {createLocalPreparation} from '../src/local.ts';
import {validatePreparedBatch,ImportContractError} from '../src/contract.ts';
import {parseBankPdf} from '../src/bank-pdf.ts';
import {syntheticLayout} from './synthetic-layout.ts';

test('finite outputs retain canonical brands while discarding all recipient and document fragments',()=>{
 for(const [code,name] of Object.entries(merchantNames)){
  const signal=extractSafeSource('Оплата товаров и услуг '+name+' / Private Person phone +7 000 000 00 00 auth Private-ID','-100');
  assert.deepEqual(signal,{event:'purchase',merchant:code});assert.deepEqual(sourceFields(signal),{sourceKind:'purchase',merchantText:name,description:'Покупка'});
 }
 assert.deepEqual(extractSafeSource('Возврат покупки OZON order Private-ID','100'),{event:'refund',merchant:'ozon'});
 assert.deepEqual(extractSafeSource('Комиссия банка договор Private-ID','-100'),{event:'fee',merchant:null});
});
test('unknown stores keep the bank kind without leaking invented names',()=>{
 assert.deepEqual(extractSafeSource('Покупка Private unknown shop 00000000000000000001','-100'),{event:'purchase',merchant:null});
 assert.deepEqual(sourceFields(null),{sourceKind:'other',merchantText:'',description:''});
});
test('transfers, mixed events, conflicting signs, invisible text and brand substrings do not become merchants',()=>{
 for(const text of ['Перевод OZON','Покупка OZON перевод получателю','Покупка OZON возврат','Покупка OZON комиссия','Покупка OZON\u200b Private'])assert.equal(extractSafeSource(text,'-100'),null);
 assert.equal(extractSafeSource('Покупка OZON','100'),null);assert.equal(extractSafeSource('Возврат покупки OZON','-100'),null);assert.equal(extractSafeSource('Покупка OZON','0'),null);
 assert.equal(extractSafeSource('Покупка OZONPrivate','-100')?.merchant,null);
 assert.equal(extractSafeSource('Покупка '+ 'a'.repeat(4000),'-100'),null);
});
test('server accepts only closed codes with consistent signs; arbitrary strings and extra fields are rejected',()=>{
 for(const value of [{event:'purchase',merchant:'Private'},{event:'purchase',merchant:'__proto__'},{event:'purchase',merchant:'ozon',raw:'Private'},{event:'transfer',merchant:null},{event:'fee',merchant:'ozon'},{event:'purchase'},{event:'purchase',merchant:0}])assert.throws(()=>parseSafeSource(value,'-100'),/INVALID_SAFE_SOURCE/);
 assert.throws(()=>parseSafeSource({event:'refund',merchant:null},'-100'));assert.throws(()=>parseSafeSource({event:'purchase',merchant:null},'0'));
});
async function prepared(bank:'tbank'|'sber'|'ozon',sanitizer:'text-free/1'|'bank-source/1'=sourceSanitizer){
 const layout=syntheticLayout(bank),descriptionX=bank==='tbank'?390:bank==='sber'?150:225;
 const description=layout[0]!.find(i=>i.x===descriptionX&&i.y===650)!;description.text='Покупка OZON Private-ID';
 if(bank==='tbank')layout[0]!.find(i=>i.x===500&&i.y===650)!.text='Sensitive-card';
 const local=await createLocalPreparation({contextId:randomUUID(),generation:randomUUID(),keyVersion:randomUUID(),key:randomBytes(32).toString('base64url'),expiresAt:new Date(Date.now()+60000).toISOString()},undefined,'bank-pdf/1',sanitizer);
 try{return await local.prepare(randomUUID(),[parseBankPdf(randomUUID(),new TextEncoder().encode('Artificial source bytes'),layout)]);}finally{local.dispose();}
}
test('all bank column layouts produce structured signals without card/document/auth columns',async()=>{
 for(const bank of ['tbank','sber','ozon'] as const){const b=await prepared(bank);assert.deepEqual(b.files[0]!.rows[0]!.safeSource,{event:'purchase',merchant:'ozon'});assert.equal(b.versions.sanitizer,sourceSanitizer);const wire=JSON.stringify(b);for(const secret of ['Private','Sensitive','123456','Artificial source bytes'])assert.equal(wire.includes(secret),false);}
});
test('legacy text-free profile remains closed and cannot carry the new source object',async()=>{
 const b=await prepared('tbank','text-free/1');assert.equal('safeSource' in b.files[0]!.rows[0]!,false);(b.files[0]!.rows[0]! as any).safeSource=null;assert.throws(()=>validatePreparedBatch(b),ImportContractError);
});
test('source smuggling is rejected even when an unrelated row fact is invalid',async()=>{
 const b=await prepared('tbank'),r=b.files[0]!.rows[0]!;r.operationDate={precision:'day',date:'2026-02-30'};(r.safeSource as any).raw='Private';assert.throws(()=>validatePreparedBatch(b),ImportContractError);
});
test('missing or malformed money remains a technical issue and cannot cancel other safe rows',async()=>{
 const b=await prepared('tbank'),r=b.files[0]!.rows[0]!;r.safeSource={event:'refund',merchant:null};r.amountMinor='not-money';const v=validatePreparedBatch(b);assert.equal(v.batch.files[0]!.rows.length,1);assert.deepEqual(v.batch.files[0]!.issues,[{ordinal:1,code:'INVALID_AMOUNT'}]);assert.equal(JSON.stringify(v.report).includes('ozon'),false);
});
test('structured source cannot be attached to an unrelated adapter or unknown version',async()=>{
 const b=await prepared('tbank');b.files[0]!.bank='other';assert.throws(()=>validatePreparedBatch(b),ImportContractError);b.files[0]!.bank='tbank';b.versions.adapter='source-adapter/1';assert.throws(()=>validatePreparedBatch(b),ImportContractError);(b.versions as any).sanitizer='bank-source/2';assert.throws(()=>validatePreparedBatch(b),ImportContractError);
});
