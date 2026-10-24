import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {bankDescription,cleanBankText,parseBankDescription} from '../src/bank-description.ts';
import {createLocalPreparation} from '../src/local.ts';
import {localBankAdapter} from '../src/bank-table.ts';
import {descriptionSourceSanitizer,localSourceSanitizer,extractSafeSource,parseSafeSource,sourceFields} from '../src/safe-source.ts';
import {validatePreparedBatch} from '../src/contract.ts';

test('bank wording and unfamiliar shops survive locally sanitized profile, old profiles stay finite',()=>{
 for(const name of ['Аптека Ромашка','Кофейня Север','AVTOZAPCHASTI','Театр','Мастерская Уют']){
  const raw='Покупка '+name,source=extractSafeSource(raw,'-100',descriptionSourceSanitizer)!;
  assert.equal(sourceFields(source).description,raw);assert.equal(sourceFields(source).merchantText,name);
  assert.equal(sourceFields(extractSafeSource(raw,'-100',localSourceSanitizer)).description,'Покупка');
  assert.deepEqual(parseSafeSource(source,'-100',descriptionSourceSanitizer),source);
  assert.throws(()=>parseSafeSource(source,'-100',localSourceSanitizer));
 }
 assert.equal(sourceFields(extractSafeSource('Нестандартная запись банка','-100',descriptionSourceSanitizer)).sourceKind,'other');
});
test('targeted identifiers and complete URLs are removed while names and transfer descriptions survive',()=>{
 const secrets=['00000000000000000001','4111111111111111','+7 (900) 123-45-67','user@example.test','ABCD-123456','123456','https://example.test/private?token=secret'];
 const raw='Покупка Аптека Ромашка карта '+secrets[1]+' счет '+secrets[0]+' телефон '+secrets[2]+' '+secrets[3]+' RRN '+secrets[4]+' auth '+secrets[5]+' '+secrets[6]+' Иванов Иван Иванович';
 const clean=cleanBankText(raw);for(const secret of secrets)assert.ok(!clean.includes(secret),secret);
 assert.ok(clean.includes('Аптека Ромашка'));assert.ok(clean.includes('Иванов Иван Иванович'));assert.equal(cleanBankText(clean),clean);
 for(const raw of ['Исходящий перевод Иван Петров','Входящий перевод Анна Сидорова','СБП ИВАНОВ ИВАН','Transfer Alice Smith']){
  const details=bankDescription(raw);assert.equal(details.merchantText,'');assert.equal(details.description,raw);
 }
 const details=bankDescription('Покупка Аптека','', 'Здоровье','5912');assert.deepEqual(parseBankDescription(details),details);
 for(const patch of [{description:'card 4111111111111111'},{merchantText:'Shop карта 4111111111111111'},{bankCategory:'user@example.test'},{mcc:'1'},{mcc:'0000'},{raw:'hidden'}])assert.throws(()=>parseBankDescription({...details,...patch}));
});
test('browser preparation /4 keeps description identity, emits only sanitized details and independently rejects wire tampering',async()=>{
 const context={contextId:randomUUID(),generation:randomUUID(),keyVersion:randomUUID(),key:Buffer.alloc(32,17).toString('base64url'),expiresAt:new Date(Date.now()+60000).toISOString()};
 const prepare=async(profile:typeof descriptionSourceSanitizer|typeof localSourceSanitizer)=>{const local=await createLocalPreparation(context,undefined,localBankAdapter,profile);try{return await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('synthetic description statement'),rows:[{operationDate:{precision:'instant',instant:'2026-10-01T12:00:00Z'},amountMinor:'-12300',currency:'RUB',direction:'debit',account:{kind:'bank_account',value:'00000000000000000001'},parser:'tbank-table/1',localDescription:'Покупка Аптека Ромашка карта 4111111111111111',localMcc:'5912',localBankCategory:'Здоровье',safeSource:{event:'purchase',merchant:null}}]}]);}finally{local.dispose();}};
 const old=await prepare(localSourceSanitizer),next=await prepare(descriptionSourceSanitizer),row=next.files[0]!.rows[0]!;
 assert.equal(row.descriptionHmac,old.files[0]!.rows[0]!.descriptionHmac);assert.equal(row.safeSource!.details!.mcc,'5912');
 assert.ok(row.safeSource!.details!.description.includes('Аптека Ромашка'));for(const secret of ['4111111111111111','00000000000000000001'])assert.ok(!JSON.stringify(next).includes(secret));
 const bad=structuredClone(next);bad.files[0]!.rows[0]!.safeSource!.details!.description='Покупка карта 4111111111111111';assert.throws(()=>validatePreparedBatch(bad));
 const extra=structuredClone(next);(extra.files[0]!.rows[0]!.safeSource!.details as any).raw='raw';assert.throws(()=>validatePreparedBatch(extra));
 const invalid=structuredClone(bad);invalid.files[0]!.rows[0]!.amountMinor='bad';assert.throws(()=>validatePreparedBatch(invalid));
});

test('only explicit card MCC can upgrade unfamiliar debit text, and OCR cannot fabricate text evidence',async()=>{
 const local=await createLocalPreparation({contextId:randomUUID(),generation:randomUUID(),keyVersion:randomUUID(),key:Buffer.alloc(32,17).toString('base64url'),expiresAt:new Date(Date.now()+60000).toISOString()},undefined,localBankAdapter,descriptionSourceSanitizer);
 const row={operationDate:{precision:'day',date:'2026-10-01'},amountMinor:'-100',currency:'RUB',direction:'debit',account:{kind:'bank_account' as const,value:'00000000000000000001'},parser:'tbank-table/1',localDescription:'APTEKA ROMASHKA'};
 try{
  const batch=await local.prepare(randomUUID(),[{fileId:randomUUID(),bank:'tbank',bytes:new TextEncoder().encode('synthetic mcc fixture'),rows:[row,{...row,localMcc:'5912'},{...row,localDescription:'СБП Иван Петров',localMcc:'5912'},{...row,parser:'tbank-ocr/1',localDescription:undefined}]}]);
  assert.deepEqual(batch.files[0]!.rows.map(r=>r.safeSource?.event??null),['other','purchase','other',null]);
  assert.equal(batch.files[0]!.rows[1]!.safeSource!.details!.merchantText,'APTEKA ROMASHKA');
  assert.equal(batch.files[0]!.rows[3]!.descriptionHmac,null);
 }finally{local.dispose();}
});

test('owner-approved display preserves FIO, IP names, ordinary numbers, mixed shop names and SBP wording',()=>{
 for(const text of ['Иванов Иван Иванович','ИП Иванов Иван Иванович','Получатель: Петров Пётр Петрович','Иванов И. И.','Магазин24','Аптека 36,6','Покупка 5ka магазин 123','Перевод Иванову 1500 рублей за 2 билета','Оплата через СБП Магазин24','Transfer Alice Smith 25']){
  assert.equal(cleanBankText(text),text);assert.equal(cleanBankText(cleanBankText(text)),text);assert.equal(parseBankDescription(bankDescription(text)).description,text);
 }
 assert.equal(cleanBankText('Карта ****1234 магазин 24'),'[скрыто] магазин 24');
 for(const raw of ['https://user@example.test/private?token=ABCD','www.example.test/card/1234567890123456','ftp://example.test/document/ABCDEF'])assert.equal(cleanBankText(raw),'[скрыто]');
 for(const raw of ['номер операции ABCDEF-123','код авторизации ABCDEF','терминал TERM-ABCDEF','ИНН 1234567890','БИК 044525225','договор ABCD123456','паспорт 12 34 567890','телефон +7 (900) 123-45-67','ИНН 123 456 7890','карта ****1234','номер договора ABCDEF-XYZ','номер счета 1234 5678'])assert.ok(!cleanBankText(raw).match(/ABCDEF|TERM-|1234567890|044525225|567890|900|1234/));
});
