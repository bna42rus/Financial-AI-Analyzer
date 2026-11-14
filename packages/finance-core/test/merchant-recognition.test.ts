import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recognizeMerchant,merchantCategory,applyMerchantRecognition} from '../src/merchant-recognition.ts';
import {merchantCatalog} from '../src/merchant-catalog.ts';
import {initialSemantics,facet} from '../src/model.ts';
import type {Category,Operation} from '../src/model.ts';
import {starterCategories} from '../src/starter.ts';
const categories:Category[]=starterCategories.expense.flatMap(([name,...leaves])=>[{id:name,name,parentId:null,role:'expense' as const,hidden:false},...leaves.map(leaf=>({id:name+'/'+leaf,name:leaf,parentId:name,role:'expense' as const,hidden:false}))]);
const classify=(merchant:string,description='Покупка '+merchant,c=categories)=>merchantCategory(recognizeMerchant(merchant,description),c);
const operation=(merchant:string):Operation=>({id:'op',source:{accountId:'account',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-10000',currency:'RUB',merchantText:merchant,description:'Покупка '+merchant,bankCategory:'',bankRefHmac:null,versions:{sourceSanitizer:'bank-source/4'}},corrections:{},semantics:initialSemantics('purchase',merchant),comment:'Комментарий',analyticsOverride:'default',decomposition:false,reviewReasons:['possible_duplicate']});
test('short names retain original source and recognizable Russian spelling, significant digits and unknown services',()=>{
 for(const [raw,name] of [['SPAR 349 Moscow Rus','SPAR'],['MAGNOLIYA MOSCOW RUS','MAGNOLIYA'],['Мострансспорт Москва Рус','Мострансспорт'],['SBER54,11 SAMOKAT SANKT-PETERBURG RUS','SAMOKAT'],['timeweb.cloud Innopolis Rus','TimeWeb'],['Аптека 36,6 Москва Рус','Аптека 36,6'],['Яндекс Драйв Москва Рус','Яндекс Драйв'],['Сервисы Яндекса','Сервисы Яндекса'],['Незнакомый24','Незнакомый24']])assert.equal(recognizeMerchant(raw).name,name,raw);
 const op=operation('SPAR 349 Moscow Rus'),before=structuredClone(op),after=applyMerchantRecognition(op,categories);assert.deepEqual(op,before);assert.deepEqual(after.source,before.source);assert.equal(after.semantics.merchant.value,'SPAR');assert.equal(after.semantics.category.value,'Продукты');
});
test('shop identity is shared by deliveries and stores, delivery remains a separate category',()=>{
 for(const text of ['Доставка Пятёрочка','DOSTAVKA PYATEROCHKA','Покупка PYATEROCHKA DELIVERY']){const match=recognizeMerchant('',text);assert.ok(['Пятёрочка','PYATEROCHKA'].includes(match.name));assert.equal(merchantCategory(match,categories)?.subcategoryId,'Продукты/Доставка продуктов');}
 assert.equal(classify('Пятёрочка')?.subcategoryId,'Продукты/Магазины');assert.equal(classify('Самокат')?.subcategoryId,'Продукты/Доставка продуктов');assert.equal(classify('Доставка'),null);
});
test('activity synonyms and transliteration generalize beyond named brands; fuzzy words require review',()=>{
 for(const merchant of ['Кафе Друзья','CAFE DRUZYA','KAFE DRUZIA','STOLOVAYA POLDEN','Ресторан Север']){const d=classify(merchant);assert.equal(d?.categoryId,'Еда вне дома',merchant);assert.equal(d?.subcategoryId,'Еда вне дома/Рестораны и кафе');assert.ok(d!.confidence>=90);}
 for(const merchant of ['Маковка','BUHANKA','Кофемания'])assert.equal(classify(merchant)?.categoryId,'Еда вне дома');
 assert.equal(classify('Аптека Ромашка')?.subcategoryId,'Здоровье и спорт/Аптеки');assert.equal(classify('DDX-FITNESS')?.subcategoryId,'Здоровье и спорт/Фитнес и спорт');
 assert.ok(classify('APTEKKA SEVER')!.confidence<90);assert.equal(classify('Кафетерий Аптека'),null);
});
test('broad transport does not guess metro, operator and vending remain review suggestions',()=>{
 assert.equal(classify('Мостранспорт')?.subcategoryId,'Транспорт/Общественный транспорт');
 const split=categories.filter(c=>c.name!=='Общественный транспорт').concat([{id:'metro',name:'Метро',parentId:'Транспорт',role:'expense',hidden:false}]);assert.equal(classify('Мостранспорт','',split)?.subcategoryId,null);
 for(const merchant of ['МТС','MEGAFON','BEELINE','ВипВендинг'])assert.ok(classify(merchant)!.confidence<90,merchant);
 assert.equal(classify('ВипВендинг')?.subcategoryId,'Продукты/Прочие продукты');assert.equal(classify('Бери заряд')?.categoryId,'Прочие расходы');assert.equal(classify('БелкаКар')?.subcategoryId,'Транспорт/Каршеринг');
 assert.equal(classify('МТС','Покупка МТС смартфон'),null);
});
test('marketplace catalog is user specific; broad Yandex and contradictory brands abstain',()=>{
 assert.equal(classify('Ozon')?.categoryId,'Маркетплейсы');const custom=categories.filter(c=>c.name!=='Маркетплейсы').concat([{id:'market',name:'Маркетплейсы',parentId:null,role:'expense',hidden:false}]);assert.equal(classify('Ozon','',custom)?.categoryId,'market');
 for(const merchant of ['Сервисы Яндекса','Яндекс Go','SPARK','Магнитофон','Ozon DNS','Ресторан Аптека'])assert.equal(classify(merchant),null,merchant);
 assert.equal(classify('SPAR','',categories.map(c=>({...c,hidden:true}))),null);
});
test('personal and confirmed facets win independently; confirming one row creates no rule',()=>{
 for(const source of ['user','personal_rule','global_rule'] as const){const op=operation('SPAR');op.semantics.category=facet('custom',source);op.semantics.merchant=facet('Моё название',source);assert.deepEqual(applyMerchantRecognition(op,categories).semantics,op.semantics);}
 const op=operation('МТС');op.semantics.category=facet('custom','ai',true);assert.deepEqual(applyMerchantRecognition(op,categories).semantics.category,op.semantics.category);
 const vending=applyMerchantRecognition(operation('VIPVENDING'),categories);assert.ok(vending.reviewReasons.includes('low_category_confidence'));assert.ok(vending.reviewReasons.includes('possible_duplicate'));assert.equal(vending.semantics.category.userVerified,false);
 const old=operation('SPAR');old.source.versions={};assert.deepEqual(applyMerchantRecognition(old,categories),old);
});
test('the public catalog has no conflicting aliases and each route uses the users visible parent hierarchy',()=>{
 const aliases=new Set<string>();for(const entry of merchantCatalog){assert.match(entry.source,/^https:\/\//);for(const alias of entry.aliases){assert.ok(!aliases.has(alias),alias);aliases.add(alias);}}
 const duplicate=categories.concat([{id:'duplicate',name:'Продукты',parentId:null,hidden:false,role:'expense'}]);assert.equal(classify('SPAR','',duplicate),null);
 const other=operation('SPAR');other.semantics.role=facet('neutral');assert.equal(applyMerchantRecognition(other,categories).semantics.category.value,null);
});

test('a verified specialist brand wins over its general parent; unrelated merchants still conflict',()=>{
 for(const text of ['Магнит Косметик','MAGNIT KOSMETIK MOSCOW RUS','М.Косметик']){
  const r=recognizeMerchant(text);assert.ok(['Магнит Косметик','MAGNIT KOSMETIK','М.Косметик'].includes(r.name));assert.equal(classify(text)?.subcategoryId,'Красота и уход/Косметика и уход');
 }
 assert.equal(classify('Магнит')?.categoryId,'Продукты');assert.equal(classify('Магнит DNS'),null);
});
test('veterinary services never receive the pet-food subcategory, even when the veterinary leaf is absent',()=>{
 for(const text of ['Ветклиника Север','VETKLINIKA SEVER','Ветеринарная клиника Уют'])assert.equal(classify(text)?.subcategoryId,'Питомцы/Ветеринар');
 const withoutLeaf=categories.filter(c=>c.name!=='Ветеринар');assert.equal(classify('Ветклиника Север','',withoutLeaf)?.subcategoryId,null);
 assert.equal(classify('Зоомагазин Север')?.subcategoryId,'Питомцы/Корм и товары');
});

test('bank alphabet and spelling survive simplification; TimeWeb is the explicit owner exception',()=>{
 for(const [raw,expected] of [['PYATEROCHKA MOSCOW RUS','PYATEROCHKA'],['Пятёрочка Москва Рус','Пятёрочка'],['World Class Moscow Rus','World Class'],['DDX-FITNESS MOSCOW RUS','DDX-FITNESS'],['Timeweb.cloud Innopolis Rus','TimeWeb']])assert.equal(recognizeMerchant(raw).name,expected);
 const without=categories.filter(c=>c.name!=='Маркетплейсы');assert.equal(classify('Ozon','',without)?.categoryId,'Прочие расходы');
 const nested=without.concat([{id:'market-leaf',name:'Маркетплейсы',parentId:'Прочие расходы',hidden:false,role:'expense'}]);assert.deepEqual(classify('Ozon','',nested),{categoryId:'Прочие расходы',subcategoryId:'market-leaf',confidence:96});
});

test('simplification retains a concrete service on a broad platform and never transliterates an unfamiliar name',()=>{
 assert.equal(recognizeMerchant('Yandex Go Taxi MOSCOW RUS').name,'Yandex Go Taxi');assert.equal(recognizeMerchant('UnknownBrand Москва Рус').name,'UnknownBrand');
});
