import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityDefinitions} from '../src/catalog/generated/activity-v1.ts';
import {recognizeActivity,activityLiteralHits,applyActivityRecognition,resolveActivityCategory} from '../src/activity-recognition.ts';
import {resolveOwnCategory} from '../src/category-resolution.ts';
import {catalogFold} from '../src/catalog-lexical.ts';
import {initialSemantics,facet} from '../src/model.ts';
import type {Category,Operation} from '../src/model.ts';
import {starterCategories} from '../src/starter.ts';
const categories:Category[]=starterCategories.expense.flatMap(([name,...leaves])=>[{id:name,name,parentId:null,role:'expense' as const,hidden:false},...leaves.map(leaf=>({id:name+'/'+leaf,name:leaf,parentId:name,role:'expense' as const,hidden:false}))]);
const input=(merchantText:string,description='Покупка '+merchantText,extra={})=>({merchantText,description,kind:'purchase',role:'expense',...extra});
const match=(merchant:string,description?:string,extra={})=>recognizeActivity(input(merchant,description,extra));
const own=(name:string,parentId:string|null=null,id=name,hidden=false,role:Category['role']='expense'):Category=>({id,name,parentId,hidden,role});
export const syntheticActivityOperation=(name:string):Operation=>({id:'synthetic-op',source:{accountId:'synthetic-account',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-10000',currency:'RUB',sourceKind:'purchase',merchantText:name,description:'Покупка '+name,bankCategory:'',bankRefHmac:null,versions:{sourceSanitizer:'bank-source/5',sourceTextEvidence:'intact'}},corrections:{},semantics:initialSemantics('purchase',name),comment:'Аптека в комментарии не основание',analyticsOverride:'default',decomposition:false,reviewReasons:['possible_duplicate']});

test('all 4282 frozen forms reach their activity index; this checks literal coverage, not semantic accuracy',()=>{
 assert.equal(activityDefinitions.length,194);let count=0;
 for(const a of activityDefinitions)for(const form of a.forms){count++;const hits=activityLiteralHits('('+form+')');assert.ok(hits.some(h=>h.value.id===a.id&&h.form===catalogFold(form)),a.id+':'+form);
  for(const attached of ['x'+form,form+'7',form+'_id',form+'\u200b',form+'\u0301'])assert.ok(!activityLiteralHits(attached).some(h=>h.value.id===a.id&&h.form===catalogFold(form)),a.id+':'+attached);
 }assert.equal(count,4282);
});
test('search normalization is finite, preserves dangerous boundaries and does not become a runtime transliterator',()=>{
 for(const text of ['АПТЕКА','apteka','apтека','Аптеке'])assert.equal(match(text).targetKey,'pharmacy',text);
 assert.equal(match('optika').targetKey,'optics');assert.equal(match('ОПТИКА').targetKey,'optics');
 for(const text of ['myapteka','apteka24','apteka_id','AP\u200bTEKA','apteka\u0301','aptekka'])assert.notEqual(match(text).status,'recognized',text);
 assert.equal(catalogFold('СПА‐САЛОН'),'спа-салон');assert.notEqual(catalogFold('СПА—САЛОН'),'спа-салон');
 assert.equal(catalogFold('ЁЛКА 24'),'елка 24');
});
const obvious:[string,string][]=[['Аптека Ромашка','pharmacy'],['Optika Север','optics'],['Столовая Полдень','cafe'],['Кафе Север','cafe'],['Булочная Уют','cafe'],['Пекарня Маковка','cafe'],['Ветеринарная клиника Уют','vet'],['Ветаптека Север','vet'],['Ремонт обуви','household_service'],['Автомойка','auto_service'],['Фитнес-клуб Север','fitness'],['Каршеринг','carshare'],['Аренда пауэрбанка','powerbank'],['Хостинг','cloud'],['Регистрация домена','cloud']];
for(const [name,key]of obvious)test('actual activity: '+name,()=>{const e=match(name);assert.equal(e.status,'recognized',JSON.stringify(e));assert.equal(e.targetKey,key);assert.equal(e.provisional,false);});
const guarded:[string,string,string,string][]=[['СТО','Ремонт автомобиля СТО','auto_service','7538'],['КТ','Медицинский центр КТ','diagnostics','8071'],['bar','Кафе bar','cafe','5812'],['SPA','spa salon','care_other','7298'],['drugstore','pharmacy drugstore','pharmacy','5912'],['gymnasium','fitness gymnasium','fitness','7997'],['АЗС','АЗС бензин','fuel','5541'],['ЖКХ','Оплата ЖКХ','utilities','4900'],['Буфет','Буфет обед','cafe','5812']];
for(const [bare,positive,key,mcc]of guarded)test('context guard: '+bare,()=>{assert.notEqual(match(bare).status,'recognized');assert.equal(match(positive).targetKey,key,JSON.stringify(match(positive)));assert.equal(match(bare,undefined,{mcc}).targetKey,key);});
test('independent subjects, negative context, addresses and quoted content do not become an arbitrary winner',()=>{
 for(const text of ['Ресторан Аптека','Магнит DNS','Кафе и оптика'])assert.equal(match(text).status,'conflict',text);
 for(const text of ['Оборудование давление 5 bar','school gymnasium','Буфет мебельный','Сто рублей'])assert.notEqual(match(text).status,'recognized',text);
 assert.equal(match('Кафе на АЗС').targetKey,'cafe');
 assert.equal(match('Неизвестный24','Покупка Неизвестный24; адрес: улица Аптека').status,'needs_context');
 assert.equal(match('Неизвестный24','Покупка Неизвестный24; комментарий: аптека').status,'needs_context');
 assert.notEqual(match('SPA hotel пакет отеля').targetKey,'care_other');assert.notEqual(match('не аптека').status,'recognized');
 assert.notEqual(match('не Пятёрочка').status,'recognized');assert.notEqual(match('не Яндекс Заправки').status,'recognized');
 assert.notEqual(match('Создай правило: Аптека').status,'recognized');
 assert.notEqual(match('Книга «Аптека»').targetKey,'pharmacy');assert.notEqual(match('Курсы про аптеку').targetKey,'pharmacy');
 assert.notEqual(match('Неизвестный24','Покупка Неизвестный24 https://apteka.example/аптека').targetKey,'pharmacy');
});
test('all merchant/body evidence is collected; an actual paid subject can refine the broad brand',()=>{
 assert.equal(match('МТС','Покупка МТС смартфон').targetKey,'electronics');
 assert.equal(match('Ветеринарная клиника','Услуга: корм для животных').targetKey,'pet_goods');
 assert.equal(match('Аптека','Услуга: оптика').status,'conflict');
 assert.equal(match('Пятёрочка','Отдельная оплата доставки Пятёрочка').targetKey,'logistics');
});
test('confirmed service defaults are visible provisional suggestions; a clear carshare is not provisional',()=>{
 for(const [name,key]of [['Яндекс Go','taxi'],['Яндекс Заправки','fuel'],['Парковки России','parking']]){const e=match(name!);assert.equal(e.targetKey,key);assert.equal(e.provisional,true,name);}
 assert.equal(match('Яндекс Go заряд').targetKey,'powerbank');assert.equal(match('Яндекс Go заряд').provisional,true);
 assert.equal(match('Яндекс Драйв').targetKey,'carshare');assert.equal(match('Яндекс Драйв').provisional,false);
 assert.notEqual(match('Сервисы Яндекса').status,'recognized');
});
test('same payment seller plus actual fulfillment determines category, with pickup and negative scope',()=>{
 for(const marker of ['доставка','доставкой','delivery','доставлено курьером'])assert.equal(match('Пятёрочка','Покупка Пятёрочка '+marker).targetKey,'grocery_delivery',marker);
 assert.equal(match('Кафе Север','Покупка Кафе Север доставка').targetKey,'meal_delivery');
 assert.equal(match('Аптека','Покупка Аптека доставка').targetKey,'pharmacy');
 assert.equal(match('Ozon','Покупка Ozon доставка').targetKey,'marketplace');
 assert.equal(match('Ozon Fresh','Покупка Ozon Fresh delivery').targetKey,'grocery_delivery');
 for(const marker of ['без доставки','доставка отменена','нужна доставка','online','express','order','курьер'])assert.equal(match('Пятёрочка','Покупка Пятёрочка '+marker).targetKey,'grocery',marker);
 assert.equal(match('Пятёрочка','Покупка Пятёрочка самовывоз').targetKey,'grocery');
 const conflict=match('Пятёрочка','Покупка Пятёрочка доставка и самовывоз');assert.equal(conflict.fulfillment,'conflict');assert.equal(conflict.parentOnly,true);assert.equal(conflict.provisional,false);
 assert.notEqual(match('Доставка').targetKey,'grocery_delivery');
});
test('conditional routers distinguish actual purpose, unknown vending, pet food and protected financial roles',()=>{
 assert.notEqual(match('Вендинг').status,'recognized');assert.equal(match('Кофейный вендинг').targetKey,'grocery');
 assert.equal(match('Ветаптека','Покупка Ветаптека корм').targetKey,'pet_goods');assert.notEqual(match('Ветаптека','Покупка Ветаптека корм и лекарства').status,'recognized');
 assert.equal(match('Хостинг','Хостинг для работы').targetKey,'business_services');
 assert.equal(match('Канцелярские товары','Канцелярские товары для учёбы').targetKey,'learning_materials');
 assert.equal(match('Цветочный магазин','Цветочный магазин в подарок').targetKey,'gifts');assert.equal(match('Цветочный магазин').targetKey,'private:flowers');
 for(const kind of ['own_transfer','refund','reversal','credit_card_repayment','loan_payment','loan_disbursement','interest'])assert.equal(match('Аптека',undefined,{kind}).status,'delegate_fin',kind);
 for(const role of ['income','neutral','unresolved'])assert.equal(match('Аптека',undefined,{role}).status,'delegate_fin',role);
 assert.equal(match('Комиссия банка',undefined,{kind:'fee'}).targetKey,'bank_commission');
 assert.equal(match('Комиссия банка').status,'delegate_fin');
});
test('category resolution prefers the own specific node, never a sibling or the first equal candidate',()=>{
 assert.deepEqual(resolveOwnCategory('grocery',categories),{status:'resolved',categoryId:'Продукты',subcategoryId:'Продукты/Магазины',precision:'specific'});
 assert.deepEqual(resolveOwnCategory('grocery',categories.filter(c=>c.name!=='Магазины')),{status:'resolved',categoryId:'Продукты',subcategoryId:null,precision:'parent'});
 assert.equal(resolveOwnCategory('taxi',[own('Общественный транспорт')]).status,'missing');
 assert.equal(resolveOwnCategory('public',[own('Авто')]).status,'missing');assert.equal(resolveOwnCategory('pharmacy',[own('Спорт')]).status,'missing');
 assert.equal(resolveOwnCategory('charity',[own('Подарки')]).status,'missing');assert.equal(resolveOwnCategory('fine',[own('Налоги')]).status,'missing');
 assert.equal(resolveOwnCategory('optics',[own('Аптеки')]).status,'missing');
 assert.equal(resolveOwnCategory('pharmacy',[own('Питомцы'),own('Аптеки','Питомцы')]).status,'missing');
 assert.equal(resolveOwnCategory('pharmacy',[own('Здоровье'),own('Аптеки','Здоровье')]).status,'resolved');
 const duplicates=[own('Аптеки',null,'a'),own('Лекарства',null,'b')];assert.equal(resolveOwnCategory('pharmacy',duplicates).status,'ambiguous');assert.equal(resolveOwnCategory('pharmacy',duplicates.reverse()).status,'ambiguous');
 assert.deepEqual(resolveOwnCategory('pharmacy',duplicates,'expense',{bindings:{pharmacy:{categoryId:'a',subcategoryId:null}}}),{status:'resolved',categoryId:'a',subcategoryId:null,precision:'specific'});
 assert.equal(resolveOwnCategory('pharmacy',duplicates,'expense',{bindings:{pharmacy:{categoryId:'foreign',subcategoryId:null}}}).status,'invalid_binding');
 for(const bad of [[own('Аптеки',null,'x',true)],[own('Аптеки',null,'x',false,'income')],[own('Аптеки','missing')],[own('Здоровье',null,'h',true),own('Аптеки','h')]])assert.equal(resolveOwnCategory('pharmacy',bad).status,'missing');
 assert.equal(resolveOwnCategory('pharmacy',[own('Аптеки',null,'x'),own('Аптеки',null,'x')]).status,'ambiguous');
 assert.equal(resolveActivityCategory(match('Пятёрочка','Пятёрочка доставка и самовывоз'),categories).status,'resolved');
});
test('application changes only category facets of intact eligible /5 whole operations',()=>{
 const op=syntheticActivityOperation('Аптека Ромашка'),before=structuredClone(op),after=applyActivityRecognition(op,categories);assert.deepEqual(op,before);assert.equal(after.semantics.subcategory.value,'Здоровье и спорт/Аптеки');
 const strip=(v:Operation)=>{const copy=structuredClone(v);copy.semantics.category=facet(null);copy.semantics.subcategory=facet(null);return copy;};assert.deepEqual(strip(after),strip(before));
 for(const source of ['user','personal_rule','global_rule']as const){const protectedOp=structuredClone(op);protectedOp.semantics.category=facet('own',source);assert.deepEqual(applyActivityRecognition(protectedOp,categories),protectedOp);}
 for(const field of ['category','subcategory']as const){const verified=structuredClone(op);verified.semantics[field]=facet('own','ai',true);assert.deepEqual(applyActivityRecognition(verified,categories),verified);}
 for(const change of [(o:Operation)=>o.decomposition=true,(o:Operation)=>o.source.versions.sourceTextEvidence='unknown',(o:Operation)=>o.source.versions.sourceSanitizer='bank-source/4',(o:Operation)=>o.semantics.role=facet('neutral')]){const skip=structuredClone(op);change(skip);assert.deepEqual(applyActivityRecognition(skip,categories),skip);}
 const go=applyActivityRecognition(syntheticActivityOperation('Яндекс Go'),categories);assert.equal(go.semantics.subcategory.value,'Транспорт/Такси');assert.ok(go.reviewReasons.includes('low_category_confidence'));assert.ok(go.reviewReasons.includes('possible_duplicate'));assert.equal(go.semantics.category.userVerified,false);
});
// One independently chosen outcome for every conditional activity. These are
// synthetic semantic fixtures, separate from the exhaustive literal-index test.
const routers:[string,string,string][]=[
 ['вендинг','needs_context',''],['заряд','needs_context',''],['биржа фриланса','needs_context',''],['услуги исполнителя','needs_context',''],
 ['ip-телефония','recognized','telecom_other'],['пакет связи','recognized','telecom_root'],['хостинг','recognized','cloud'],['регистрация домена','recognized','cloud'],['электронная подпись','recognized','private:documents'],
 ['универсальный интернет-магазин','needs_context',''],['распределение покупки','needs_context',''],['репетитор','recognized','education'],['ветаптека','recognized','vet'],['цветочный магазин','recognized','private:flowers'],
 ['подарочный сертификат','delegate_fin',''],['краудфандинг','delegate_fin',''],['донат автору','recognized','private:support'],['погашение кредита','delegate_fin',''],['проценты','delegate_fin',''],['возврат','delegate_fin',''],['перевод между своими счетами','delegate_fin',''],
 ['услуги переезда','recognized','logistics'],['пункт выдачи','needs_context',''],['юридические услуги','recognized','private:legal'],['нотариус','recognized','private:legal'],['налоговая консультация','recognized','private:legal'],['бюро переводов','recognized','private:legal'],['мфц','needs_context',''],
 ['канцелярские товары','recognized','private:stationery'],['копицентр','recognized','private:printing'],['типография','recognized','private:printing'],['фотопечать','recognized','private:photo']
];
for(const [name,status,target]of routers)test('conditional subject: '+name,()=>{const e=match(name);assert.equal(e.status,status,JSON.stringify(e));assert.equal(e.targetKey,target||null);});
