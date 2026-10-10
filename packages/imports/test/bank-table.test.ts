import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {csvTable,parseBankTable,tableDate,localBankAdapter} from '../src/bank-table.ts';
import {localSourceSanitizer,extractSafeSource,parseSafeSource,sourceFields} from '../src/safe-source.ts';
import {createLocalPreparation} from '../src/local.ts';
import {validatePreparedBatch} from '../src/contract.ts';

const text='Банк;Т-Банк\nНомер счета;00000000000000000001\nДата операции;Сумма операции;Валюта;Описание;Дата обработки\n01.09.2026;-10.01;RUB;Покупка OZON Private-Terminal;02.09.2026\n2026-09-02;20,5;RUB;Возврат покупки OZON;';
const parse=(s=text)=>parseBankTable(randomUUID(),new TextEncoder().encode(s),csvTable(s));
async function prepare(file=parse()){
 const local=await createLocalPreparation({contextId:randomUUID(),generation:randomUUID(),keyVersion:randomUUID(),key:Buffer.alloc(32,17).toString('base64url'),expiresAt:new Date(Date.now()+60000).toISOString()},undefined,localBankAdapter,localSourceSanitizer);
 try{return await local.prepare(randomUUID(),[file]);}finally{local.dispose();}
}
test('CSV retains exact amounts, dates, issuer account, safe source and parser without identifiers',async()=>{
 const b=await prepare(),rows=b.files[0]!.rows;assert.deepEqual(rows.map(r=>r.amountMinor),['-1001','2050']);assert.equal(rows[0]!.parser,'tbank-table/1');assert.deepEqual(rows[0]!.safeSource,{event:'purchase',merchant:'ozon'});assert.equal(rows[0]!.postedDate?.precision,'day');
 assert.equal(validatePreparedBatch(b).report.counts.validRows,2);for(const secret of ['Private','00000000000000000001','Номер счета'])assert.equal(JSON.stringify(b).includes(secret),false);
});
test('four-column CSV accepts explicit bank and account metadata above the required header',async()=>{
 for(const delimiter of [';',',','\t']){
  const s=['Банк;Т-Банк','Номер счета;00000000000000000001','Дата операции;Сумма операции;Валюта;Описание','2026-09-01;-10.01;RUB;Снятие наличных Private ATM'].join('\n').replaceAll(';',delimiter);
  const b=await prepare(parse(s));assert.equal(b.files[0]!.rows.length,1);assert.equal(b.files[0]!.rows[0]!.amountMinor,'-1001');assert.deepEqual(b.files[0]!.rows[0]!.safeSource,{event:'cash_withdrawal',merchant:null});
 }
});
test('quoted CSV delimiters, escaped quotes and multiline descriptions never split operations',async()=>{
 const s=text.replace('Покупка OZON Private-Terminal','"Покупка OZON; terminal ""private""\nline"');assert.equal((await prepare(parse(s))).files[0]!.rowsFound,2);
 for(const malformed of [text.replace('Покупка OZON Private-Terminal','"unterminated'),text.replace('Покупка OZON Private-Terminal','"purchase"extra')])assert.throws(()=>parse(malformed),/UNSUPPORTED_LAYOUT/);
 const comma=text.replaceAll(';',',').replace('20,5','20.50');assert.equal(parse(comma).rows.length,2);
});
test('bad bank facts are counted per-row issues while another valid row survives',async()=>{
 for(const [bad,code] of [['30.02.2026','INVALID_DATE'],['=1+1','INVALID_AMOUNT'],['USD','INVALID_CURRENCY']] as const){
  const s=code==='INVALID_DATE'?text.replace('01.09.2026',bad):code==='INVALID_AMOUNT'?text.replace('-10.01',bad):text.replace('RUB',bad),b=await prepare(parse(s));assert.equal(b.files[0]!.rowsFound,2);assert.deepEqual(b.files[0]!.issues,[{ordinal:1,code}]);assert.equal(b.files[0]!.rows.length,1);
 }
});
test('no bank, account, duplicate header or inconsistent issuer is inferred from descriptions',()=>{
 for(const s of [text.replace('Банк;Т-Банк\n',''),text.replace('Номер счета;00000000000000000001\n',''),text.replace('Дата обработки','Описание'),text.replace('Банк;Т-Банк','Банк;Unknown Private bank')])assert.throws(()=>parse(s));
 const perRow='Дата операции;Сумма операции;Валюта;Описание;Банк;Номер счета\n2026-09-01;-1.00;RUB;Покупка OZON;Т-Банк;00000000000000000001\n2026-09-01;-1.00;RUB;Покупка OZON;Сбербанк;00000000000000000001';assert.throws(()=>parse(perRow),/AMBIGUOUS_FORMAT/);
});
test('timezone and precision are explicit, impossible calendars and naive instants are rejected',()=>{
 assert.deepEqual(tableDate('2026-09-01T23:30:01+03:00'),{precision:'instant',instant:'2026-09-01T20:30:01.000Z'});
 for(const s of ['30.02.2026','2026-02-30T12:00:00Z','2026-09-01T24:00:00Z','2026-09-01 10:00','46200','1e3'])assert.throws(()=>tableDate(s));
});
test('the server closes parser metadata and prevents OCR signals from becoming strict evidence',async()=>{
 const b=await prepare();for(const parser of ['sber-table/1','private parser raw text']){const altered=structuredClone(b);altered.files[0]!.rows[0]!.parser=parser as any;assert.throws(()=>validatePreparedBatch(altered));}
 const ocr=parse();for(const r of ocr.rows){r.parser='tbank-ocr/1';r.localDescription=undefined;r.safeSource=null;}
 const prepared=await prepare(ocr);assert.equal(prepared.files[0]!.rows[0]!.descriptionHmac,null);assert.equal(prepared.files[0]!.rows[0]!.safeSource,null);
 prepared.files[0]!.rows[0]!.safeSource={event:'purchase',merchant:'ozon'};assert.throws(()=>validatePreparedBatch(prepared));
});
test('executable, shifted and numeric-overflow values never become automatic bank facts',async()=>{
 const huge=await prepare(parse(text.replace('-10.01','-92233720368547758.09')));assert.equal(huge.files[0]!.issues[0]!.code,'INVALID_AMOUNT');
 const shifted=await prepare(parse(text.replace('01.09.2026;-10.01;RUB','01.09.2026;unexpected;-10.01;RUB')));assert.equal(shifted.files[0]!.issues.length,1);
 assert.throws(()=>csvTable(text+'a'.repeat(2_000_001)),/LOCAL_LIMIT/);
});

test('explicit cash, cashback and transfer signals preserve signs and never infer ownership or a recipient',()=>{
 const cases=[['Снятие наличных ATM Private','-100','cash_withdrawal'],['Внесение наличных ATM Private','100','cash_deposit'],['Кешбэк за покупки Private','100','cashback'],['Входящий перевод Private Person','100','transfer_in'],['Исходящий перевод Private Person','-100','transfer_out']] as const;
 for(const [description,amount,event] of cases){const signal=extractSafeSource(description,amount,localSourceSanitizer);assert.deepEqual(signal,{event,merchant:null});assert.equal(sourceFields(signal).sourceKind,event);assert.equal(sourceFields(signal).description.includes('Private'),false);assert.throws(()=>parseSafeSource(signal,amount,'bank-source/2'));assert.equal(extractSafeSource(description,(-BigInt(amount)).toString(),localSourceSanitizer),null);}
 assert.equal(extractSafeSource('Перевод между моими счетами Private','-100',localSourceSanitizer),null);assert.equal(extractSafeSource('Снятие наличных комиссия банка','-100',localSourceSanitizer),null);
});
