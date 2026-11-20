import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {merchantBankDescription,financialTransferText} from '../src/bank-description.ts';
import {extractSafeSource,sourceFields,parseSafeSource,merchantSourceSanitizer,descriptionSourceSanitizer,localSourceSanitizer} from '../src/safe-source.ts';
import {createLocalPreparation} from '../src/local.ts';
import {localBankAdapter} from '../src/bank-table.ts';
import {validatePreparedBatch} from '../src/contract.ts';
import {strictSourceDescriptor,matchSource} from '../src/matching.ts';

test('/5 retains the permitted source alphabet, services, unknown names and numbers without altering /4',()=>{
 for(const name of ['PYATEROCHKA MOSCOW RUS','Пятёрочка Москва Рус','OZON FRESH MOSCOW RUS','WORLDCLASS','XFit','СБЕР 24 Москва Рус','ИП Иванов Иван 24','Бюро переводов Север']){
  const raw='Покупка '+name,source=extractSafeSource(raw,'-100',merchantSourceSanitizer)!;
  assert.equal(sourceFields(source,merchantSourceSanitizer).merchantText,name);
  assert.equal(sourceFields(source,merchantSourceSanitizer).description,raw);
  assert.deepEqual(parseSafeSource(source,'-100',merchantSourceSanitizer),source);
 }
 const raw='Покупка PYATEROCHKA MOSCOW RUS';
 assert.equal(sourceFields(extractSafeSource(raw,'-100',descriptionSourceSanitizer),descriptionSourceSanitizer).merchantText,'Пятёрочка');
 assert.equal(sourceFields(extractSafeSource(raw,'-100',localSourceSanitizer),localSourceSanitizer).description,'Покупка');
});

test('commercial translation is distinct from money transfer, including explicit merchant and SBP payment channel',()=>{
 for(const [description,merchant] of [['Оплата услуг бюро переводов','Бюро переводов Север'],['Покупка Бюро переводов Север',''],['Оплата через СБП Магазин24','Магазин24']] as const){
  const details=merchantBankDescription(description,merchant);
  assert.equal(financialTransferText(description),false);assert.ok(details.merchantText);
 }
 for(const description of ['Перевод Иванову 1500 рублей','Исходящий перевод Иван Петров','Входящий перевод Анна Сидорова','СБП ИВАНОВ ИВАН','Transfer Alice Smith','Bank transfer Alice Smith','Оплата услуг: перевод денежных средств','Оплата: денежный перевод']){
  assert.equal(financialTransferText(description),true);
  assert.equal(merchantBankDescription(description,'Иван Петров').merchantText,'');
  assert.equal(merchantBankDescription(description).description,description);
 }
 assert.equal(extractSafeSource('Оплата услуг бюро переводов Север','-100',merchantSourceSanitizer)!.event,'purchase');
 assert.equal(extractSafeSource('Возврат покупки Бюро переводов Север','100',merchantSourceSanitizer)!.event,'refund');
});

const context={contextId:randomUUID(),generation:randomUUID(),keyVersion:randomUUID(),key:Buffer.alloc(32,17).toString('base64url'),expiresAt:new Date(Date.now()+60000).toISOString()};
const rawRow={operationDate:{precision:'instant',instant:'2026-10-01T12:00:00Z'},amountMinor:'-100',currency:'RUB',direction:'debit',account:{kind:'bank_account' as const,value:'00000000000000000001'},parser:'tbank-table/1',localDescription:'Покупка PYATEROCHKA MOSCOW RUS карта 4111111111111111 RRN SYNTHETIC-123'};
async function prepared(profile:typeof merchantSourceSanitizer|typeof descriptionSourceSanitizer,rows=[rawRow]){
 const local=await createLocalPreparation(context,undefined,localBankAdapter,profile);
 try{return await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('Synthetic source identity fixture'),rows}]);}finally{local.dispose();}
}
test('new profile crosses browser/server validation without changing keyed identity or cross-file matching',async()=>{
 const old=await prepared(descriptionSourceSanitizer),next=await prepared(merchantSourceSanitizer);
 const a=old.files[0]!.rows[0]!,b=validatePreparedBatch(next).batch.files[0]!.rows[0]!;
 assert.equal(a.descriptionHmac,b.descriptionHmac);assert.equal(old.files[0]!.fileHmac,next.files[0]!.fileHmac);
 assert.deepEqual(a.account,b.account);assert.equal(strictSourceDescriptor(a),strictSourceDescriptor(b));
 assert.equal(matchSource(b,'another-file',[{transactionId:'retained',fileHmac:'old-file',ordinal:1,bankRefHmac:null,operationDate:a.operationDate,postedDate:a.postedDate,amountMinor:a.amountMinor,currency:a.currency,direction:a.direction,strictFingerprint:strictSourceDescriptor(a)}],new Set(),strictSourceDescriptor(b)).transactionId,'retained');
 for(const secret of ['4111111111111111','00000000000000000001','SYNTHETIC-123'])assert.ok(!JSON.stringify(next).includes(secret));
 const text=sourceFields(b.safeSource,merchantSourceSanitizer);assert.ok(text.merchantText.startsWith('PYATEROCHKA'));assert.ok(text.description.includes('[скрыто]'));
});

test('lost invisible boundaries are explicit unknown evidence and do not silently become a new literal alias',async()=>{
 const row={...rawRow,localDescription:'Покупка AP\u200bTEKA Ромашка',localMerchant:'AP\u200bTEKA Ромашка'};
 const batch=await prepared(merchantSourceSanitizer,[row]);
 const details=batch.files[0]!.rows[0]!.safeSource!.details!;
 assert.ok('textEvidence' in details&&details.textEvidence==='unknown');
 assert.equal(batch.files[0]!.rows[0]!.descriptionHmac,null);
 assert.ok(!JSON.stringify(batch).includes('\u200b'));
 const unsafe=merchantBankDescription('Покупка карта 4111\u200b111111111111 user@\u200bexample.test','Аптека');
 assert.ok(!unsafe.description.includes('4111'));assert.ok(!unsafe.description.includes('example.test'));assert.equal(unsafe.textEvidence,'unknown');
});

test('/5 wire evidence is closed, mandatory and cannot be downgraded to /4 or an unrelated adapter',async()=>{
 const batch=await prepared(merchantSourceSanitizer);
 for(const flag of [undefined,true,'safe']){
  const bad=structuredClone(batch);(bad.files[0]!.rows[0]!.safeSource!.details as any).textEvidence=flag;
  assert.throws(()=>validatePreparedBatch(bad));
 }
 const downgrade=structuredClone(batch);downgrade.versions.sanitizer=descriptionSourceSanitizer;assert.throws(()=>validatePreparedBatch(downgrade));
 const extra=structuredClone(batch);(extra.files[0]!.rows[0]!.safeSource!.details as any).raw='forbidden';extra.files[0]!.rows[0]!.amountMinor='bad';assert.throws(()=>validatePreparedBatch(extra));
 const adapter=structuredClone(batch);adapter.versions.adapter='bank-pdf/2';assert.throws(()=>validatePreparedBatch(adapter));
});
