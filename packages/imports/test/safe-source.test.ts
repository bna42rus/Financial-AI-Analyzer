import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {extractSafeSource,parseSafeSource,sourceFields,sourceSanitizer,merchantNames,normalizeSourceDescription} from '../src/safe-source.ts';
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
async function prepared(bank:'tbank'|'sber'|'ozon',sanitizer:'text-free/1'|'bank-source/1'|'bank-source/2'=sourceSanitizer){
 const layout=syntheticLayout(bank),descriptionX=bank==='tbank'?390:bank==='sber'?150:225;
 const description=layout[0]!.find(i=>i.x===descriptionX&&i.y===650)!;description.text='Покупка OZON Private-ID';
 if(bank==='tbank')layout[0]!.find(i=>i.x===500&&i.y===650)!.text='Sensitive-card';
 const local=await createLocalPreparation({contextId:randomUUID(),generation:randomUUID(),keyVersion:randomUUID(),key:randomBytes(32).toString('base64url'),expiresAt:new Date(Date.now()+60000).toISOString()},undefined,sanitizer==='bank-source/1'?'bank-pdf/1':'bank-pdf/2',sanitizer);
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
 const b=await prepared('tbank');b.files[0]!.bank='other';assert.throws(()=>validatePreparedBatch(b),ImportContractError);b.files[0]!.bank='tbank';b.versions.adapter='source-adapter/1';assert.throws(()=>validatePreparedBatch(b),ImportContractError);(b.versions as any).sanitizer='bank-source/3';assert.throws(()=>validatePreparedBatch(b),ImportContractError);
});
test('expanded artificial merchant corpus supports aliases, case and explicit bank payment/refund prefixes',()=>{
 const corpus:[string,string][]=[['VKUSVILL','vkusvill'],['AUCHAN','auchan'],['METRO','metro'],['DIXY','dixy'],['FIX_PRICE','fixprice'],['SAMOKAT','samokat'],['LAMODA','lamoda'],['DNS','dns'],['M.VIDEO','mvideo'],['SPORTMASTER','sportmaster'],['HOFF','hoff'],['LEMANAPRO','leroymerlin'],['YANDEX MARKET','yandexmarket'],['YANDEX.TAXI','yandextaxi']];
 for(const [alias,merchant] of corpus)for(const prefix of ['Оплата по карте','Оплата картой','Card payment'])assert.deepEqual(extractSafeSource(prefix+' '+alias+' terminal Synthetic-Terminal-1','-101'),{event:'purchase',merchant});
 assert.deepEqual(extractSafeSource('Возврат оплаты ВкусВилл Synthetic-Order','101'),{event:'refund',merchant:'vkusvill'});
 for(const text of ['Transfer to DNS','Card payment DNS recipient Synthetic Person','Card payment DNS refund','Покупка METROPRIVATE','Покупка DNSPRIVATE'])assert.equal(extractSafeSource(text,'-101')?.merchant??null,null);
});
test('old bank-source profile stays closed to expanded merchants and new identity fields',async()=>{
 assert.throws(()=>parseSafeSource({event:'purchase',merchant:'vkusvill'},'-100','bank-source/1'));
 const b=await prepared('tbank','bank-source/1');assert.equal('descriptionHmac' in b.files[0]!.rows[0]!,false);
 (b.files[0]!.rows[0]! as any).descriptionHmac='a'.repeat(64);assert.throws(()=>validatePreparedBatch(b),ImportContractError);
});
test('description identity is a per-user and per-account HMAC, preserves full evidence and emits no raw text',async()=>{
 const c={contextId:randomUUID(),generation:randomUUID(),keyVersion:randomUUID(),key:randomBytes(32).toString('base64url'),expiresAt:new Date(Date.now()+60000).toISOString()};
 const digest=async(key=c.key,description='Покупка Synthetic Unknown Shop auth Synthetic-Private-1',account='00000000000000000001')=>{
  const local=await createLocalPreparation({...c,key},undefined,'bank-pdf/2',sourceSanitizer);
  try{const b=await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new Uint8Array([1]),rows:[{operationDate:{precision:'instant',instant:'2026-09-01T10:00:00.000Z'},amountMinor:'-100',currency:'RUB',direction:'debit',account:{kind:'bank_account',value:account},localDescription:description,safeSource:extractSafeSource(description,'-100')}]}]);assert.equal(JSON.stringify(b).includes('Synthetic'),false);return b.files[0]!.rows[0]!.descriptionHmac;}finally{local.dispose();}
 };
 const a=await digest();assert.match(a!,/^[0-9a-f]{64}$/);assert.equal(a,await digest(c.key,'  ПОКУПКА  Synthetic Unknown Shop\n auth Synthetic-Private-1  '));
 assert.notEqual(a,await digest(randomBytes(32).toString('base64url')));assert.notEqual(a,await digest(c.key,undefined,'00000000000000000002'));assert.notEqual(a,await digest(c.key,'Покупка Synthetic Unknown Shop auth Synthetic-Private-2'));
 assert.equal(await digest(c.key,'Покупка Synthetic\u200bPrivate'),null);assert.equal(normalizeSourceDescription('x'.repeat(4001)),null);
});
test('new identity wire field is mandatory and checked before invalid facts can hide smuggling',async()=>{
 for(const value of ['Synthetic raw text','a'.repeat(63),42,undefined,{raw:'Synthetic'}]){const b=await prepared('tbank');const r=b.files[0]!.rows[0]!;r.operationDate={precision:'day',date:'2026-02-30'};(r as any).descriptionHmac=value;assert.throws(()=>validatePreparedBatch(b),ImportContractError);}
 const b=await prepared('tbank');delete b.files[0]!.rows[0]!.descriptionHmac;assert.throws(()=>validatePreparedBatch(b),ImportContractError);
});
