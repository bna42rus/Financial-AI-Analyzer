import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groceryCatalog} from '../src/grocery-catalog.ts';
import {brandKey,brandKeys,brandPattern} from '../src/merchant-aliases.ts';
import {merchantCatalog,merchantCatalogVersion} from '../src/merchant-catalog.ts';
import {recognizeMerchant,merchantCategory,applyMerchantRecognition} from '../src/merchant-recognition.ts';
import {initialSemantics,facet} from '../src/model.ts';
import {ruleMatches} from '../src/rules.ts';
import type {Operation,Category,Account} from '../src/model.ts';
import type {Rule} from '../src/rules.ts';

const categories:Category[]=[{id:'food',name:'Продукты',parentId:null,role:'expense',hidden:false},{id:'shops',name:'Магазины',parentId:'food',role:'expense',hidden:false},{id:'delivery',name:'Доставка продуктов',parentId:'food',role:'expense',hidden:false}];
const op=(merchant:string,description='Покупка '+merchant):Operation=>({id:'synthetic',source:{accountId:'synthetic-account',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-12345',currency:'RUB',merchantText:merchant,description,bankCategory:'',bankRefHmac:null,versions:{sourceSanitizer:'bank-source/4'}},corrections:{},semantics:initialSemantics('purchase',merchant),comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:['possible_duplicate']});
const classify=(merchant:string,description='')=>merchantCategory(recognizeMerchant(merchant,description),categories);

test('all 50 approved food-store records have public provenance and disjoint normalized aliases',()=>{
 assert.equal(groceryCatalog.length,50);assert.equal(merchantCatalogVersion,'merchant-catalog/2');
 const owners=new Map<string,string>();
 for(const entry of merchantCatalog){assert.match(entry.source,/^https:\/\//);if(groceryCatalog.includes(entry))assert.equal(entry.checkedAt,'2026-10-25');for(const alias of entry.aliases){for(const key of brandKeys(alias)){const prior=owners.get(key);assert.ok(!prior||prior===entry.name,`${key}: ${prior} / ${entry.name}`);owners.set(key,entry.name);}}}
});

test('every declared Russian form, transliteration and joined form resolves to its own shop with retail evidence',()=>{
 for(const entry of groceryCatalog)for(const alias of entry.aliases){
  const text='Супермаркет «'+alias.toUpperCase()+'» №349';const actual=recognizeMerchant(text);
  assert.equal(actual.brand,entry.name,text);assert.equal(actual.conflict,false,text);assert.equal(actual.service,'grocery',text);
  assert.deepEqual(merchantCategory(actual,categories),{categoryId:'food',subcategoryId:'shops',confidence:96},text);
 }
});

test('requested cases and spelling conventions work without fuzzy guesses',()=>{
 for(const [text,brand] of [
  ['в Пятёрочке','Пятёрочка'],['из Пятерочки','Пятёрочка'],['PYATYOROCHKA','Пятёрочка'],['PIATEROCHKA','Пятёрочка'],
  ['Ashan','Ашан'],['AUCHAN','Ашан'],['в Ашане','Ашан'],['из Ашана','Ашан'],
  ['LENTA','Лента'],['v Lente','Лента'],['из Ленты','Лента'],['Перекрёстком','Перекрёсток'],
  ['в Азбуке вкуса','Азбука вкуса'],['AZBUKEVKUSA','Азбука вкуса'],['в Мясницком ряду','Мясницкий ряд'],
  ['в Марии-Ра','Мария-Ра'],['KRASNOM YARE','Красный Яр'],['в ХлебСоли','ХлебСоль'],
  ['в РемиСити','Реми'],['в EUROSPAR','EUROSPAR'],['магазин О’КЕЙ','О’КЕЙ'],
 ] as const){const r=recognizeMerchant(text);assert.equal(r.brand,brand,text);assert.equal(r.service,'grocery',text);}
 for(const unknown of ['PYATEROCHKKKA','ASHANN','LENNTA','SPARR'])assert.equal(recognizeMerchant(unknown).matched,false,unknown);
});

test('mixed alphabets, case and Unicode compatibility are bounded by each brand whitelist',()=>{
 for(const [text,brand] of [['Пятёрoчка','Пятёрочка'],['Пятёрочкa','Пятёрочка'],['Лeнтa','Лента'],['Aшан','Ашан'],['АSHAN','Ашан'],['Мaгнит','Магнит'],['МАГHИТ','Магнит'],['ＳＰＡＲ','SPAR']] as const){const r=recognizeMerchant(text);assert.equal(r.brand,brand,text);assert.equal(r.service,'grocery',text);}
 assert.deepEqual(brandKeys('PAY'),['pay']);assert.notEqual(brandKey('SPARα'),'spar');
});

test('all food aliases reject foreign word prefixes, letter suffixes and incomplete branch suffixes',()=>{
 for(const entry of groceryCatalog)for(const alias of entry.aliases){
  const pattern=brandPattern([alias]);for(const text of ['xx'+alias,alias+'xx',alias+'349x',alias+'α'])assert.ok(brandKeys(text).every(k=>!pattern.test(k)),text);
 }
 for(const text of ['SPARK','Магнитофон','Гулливерчик','Победитель','Перекрёсточный','LENTAX','XXASHAN','LENTA349X'])assert.notEqual(recognizeMerchant(text).service,'grocery',text);
 for(const text of ['SPAR349','LENTA349','ASHAN349'])assert.equal(recognizeMerchant(text).service,'grocery',text);
});

test('homonymous chains require actual retail evidence; mere payment, city or branch number is insufficient',()=>{
 for(const entry of groceryCatalog.filter(e=>e.requireGroceryContext&&e.name!=='В1 — Первый выбор')){
  assert.equal(classify(entry.name),null,entry.name);
  assert.equal(classify(entry.name,'Покупка '+entry.name+' Москва 349'),null,entry.name);
  assert.equal(classify(entry.name,'MCC 5411')?.subcategoryId,'shops',entry.name);
  assert.equal(classify('Супермаркет '+entry.name)?.subcategoryId,'shops',entry.name);
 }
 assert.equal(classify('METRO CASH & CARRY')?.subcategoryId,'shops');assert.equal(classify('Гиперглобус')?.subcategoryId,'shops');
 assert.equal(classify('В1'),null);assert.equal(classify('Первый выбор')?.subcategoryId,'shops');
 assert.equal(classify('да, всё хорошо'),null);assert.equal(classify('Верный ответ'),null);assert.equal(classify('станция метро'),null);
});

test('nonfood services veto the grocery assignment even beside positive store evidence',()=>{
 const cases=[['Победа','авиакомпания, MCC 4511'],['Гулливер','магазин детской одежды, MCC 5641'],['Европа','отель'],['Линия','рекламное агентство'],['Глобус','турагентство'],['Магнолия','цветочный магазин'],['Магнолия','покупка в цветочном магазине'],['Лента','клейкая лента'],['Глобус','магазин туров, турагентство'],['Лента','магазин штор'],['Мираторг','бургерная'],['Азбука вкуса','АВ кафе'],['Магнит','аптека'],['Магнит','косметика'],['METRO','проезд в метрополитене'],['Находка','город, отель'],['Ашан','перевод денежных средств']];
 for(const [merchant,description] of cases)assert.equal(classify(merchant!,description!),null,merchant+' '+description);
 for(const text of ['Магнит Косметик','М.Косметик','MAGNIT KOSMETIK'])assert.equal(recognizeMerchant(text).service,'cosmetics',text);
 for(const entry of groceryCatalog)assert.equal(classify(entry.name,'Супермаркет; MCC 4511'),null,entry.name);
});

test('multiple unrelated brands never choose the first food-store hit',()=>{
 for(const a of groceryCatalog)for(const b of groceryCatalog){if(a===b||a.parentBrand===b.name||b.parentBrand===a.name)continue;assert.equal(classify(a.name+' / '+b.name,'Супермаркеты'),null,a.name+' / '+b.name);}
 assert.equal(classify('Ozon / Пятёрочка'),null);assert.equal(classify('DNS / Ашан'),null);
});

test('source fallback and delivery recognition respect the same guards',()=>{
 assert.equal(classify('','Покупка в Пятёрочке')?.subcategoryId,'shops');
 assert.equal(classify('','Оплата в супермаркете Победа')?.subcategoryId,'shops');
 assert.equal(classify('','Перевод в Пятёрочку'),null);
 assert.equal(classify('','Покупка батона в супермаркете Неизвестный'),null);
 assert.equal(classify('Гулливер','Магазин'),null);
 assert.equal(classify('в Пятёрочке','Доставка продуктов')?.subcategoryId,'delivery');
 assert.equal(classify('Самокат')?.subcategoryId,'delivery');
 for(const mcc of ['5812','5814','4511','5912'])assert.equal(merchantCategory(recognizeMerchant('Мираторг','',{mcc}),categories),null,mcc);
 assert.equal(merchantCategory(recognizeMerchant('Победа','',{mcc:'5411'}),categories)?.subcategoryId,'shops');
});

test('manual choices, split purchases, source facts and nonexpense roles survive grocery expansion',()=>{
 const original=op('Ashan'),snapshot=structuredClone(original),result=applyMerchantRecognition(original,categories);
 assert.deepEqual(original,snapshot);assert.deepEqual(result.source,snapshot.source);assert.deepEqual(result.corrections,snapshot.corrections);assert.equal(result.semantics.category.value,'food');assert.ok(result.reviewReasons.includes('possible_duplicate'));
 for(const source of ['user','personal_rule','global_rule'] as const){const original=op('в Пятёрочке');original.semantics.category=facet('custom',source);assert.equal(applyMerchantRecognition(original,categories).semantics.category.value,'custom');}
 const verified=op('Lenta');verified.semantics.category=facet('custom','ai',true);assert.equal(applyMerchantRecognition(verified,categories).semantics.category.value,'custom');
 const split=op('Ashan');split.decomposition=true;assert.equal(applyMerchantRecognition(split,categories).semantics.category.value,null);
 const transfer=op('Пятёрочка');transfer.semantics.role=facet('neutral');assert.equal(applyMerchantRecognition(transfer,categories).semantics.category.value,null);
 assert.equal(merchantCategory(recognizeMerchant('Ashan'),categories.map(c=>({...c,hidden:true}))),null);
 assert.equal(merchantCategory(recognizeMerchant('Ashan'),categories.map(c=>({...c,role:'income'}))),null);
});

test('alias expansion preserves personal-rule equality without widening a branch-specific condition',()=>{
 const account={id:'synthetic-account',bankId:'synthetic-bank'} as Account;
 const rule={id:'rule',name:'synthetic',enabled:true,priority:100,conditions:{merchantEquals:'Ашан',direction:'out'},assignments:{categoryId:'custom'}} as Rule;
 for(const merchant of ['Ashan','AUCHAN','в Ашане'])assert.ok(ruleMatches(op(merchant),account,rule),merchant);
 assert.equal(ruleMatches(op('SPAR 350'),account,{...rule,conditions:{merchantEquals:'SPAR 349'}}),false);
 assert.equal(ruleMatches(op('Гулливер одежда'),account,{...rule,conditions:{merchantEquals:'Гулливер'}}),false);
});
