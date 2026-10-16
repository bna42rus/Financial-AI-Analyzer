import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeText,safeText} from '../src/text.ts';

test('financial editable text removes passport, email and labelled opaque identifiers before transmission',()=>{
 const cases=[
  ['Паспорт 4510 123456','4510'],['паспорт серия 45 10 номер 123456','123456'],
  ['Passport 4510123456','4510123456'],['Email synthetic@example.test','synthetic@example.test'],
  ['Почта синтетика@пример.рф','синтетика@пример.рф'],
  ['Договор № TEST-123456','TEST-123456'],['contract number SYNTH_123456','SYNTH_123456'],
  ['Код авторизации 123456','123456'],['document id TEST/123456','TEST/123456'],
 ];
 for(const [raw,secret] of cases){const clean=sanitizeText(raw!);assert.ok(!clean.includes(secret!),raw);assert.ok(clean.includes('[реквизиты скрыты]'));assert.throws(()=>safeText(raw));assert.equal(safeText(clean),clean);assert.equal(sanitizeText(clean),clean);}
});
test('format characters and compatibility glyphs cannot bypass local or server financial text guards',()=>{
 for(const raw of ['Карта 1234\u200b5678\u20609012\u200e3456','Паспорт 4510\u200b 123456','Email synthe\u200btic@example.test','Карта １２３４５６７８９０１２３４５６']){
  const clean=sanitizeText(raw);assert.ok(clean.includes('[реквизиты скрыты]'));assert.ok(!/[\p{Cf}]/u.test(clean));assert.throws(()=>safeText(raw));assert.equal(safeText(clean),clean);
 }
});
test('ordinary financial explanations, dates, short aliases and amounts remain usable',()=>{
 for(const value of ['Алексей И. — аренда','Аренда за 2026-10-10 — 50 000 ₽','Договор аренды','Карта для поездок','Комиссия 123,45 ₽','Банк example.test','Кредит 2500000 ₽'])assert.equal(safeText(value),value);
});
