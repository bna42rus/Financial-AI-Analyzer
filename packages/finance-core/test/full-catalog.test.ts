import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fullCatalogProfiles,fullCatalogEvidence} from '../src/full-catalog.ts';
import {recognizeActivity,applyActivityRecognition} from '../src/activity-recognition.ts';
import {literalIndex,catalogFold} from '../src/catalog-lexical.ts';
import {initialSemantics,facet} from '../src/model.ts';
import type {Operation} from '../src/model.ts';
import {starterCategories} from '../src/starter.ts';
const input=(merchantText:string,description='Покупка',mcc:string|null=null)=>({merchantText,description,mcc,bankCategory:'',kind:'purchase',role:'expense'});
// Independently written semantic examples, not expectations copied from policy().
const cases:[string,string,string,(string|null)?][]=[
 ['Skuratov Coffee','Покупка','cafe'],['Дринкит','Покупка','cafe'],['кофелайке','Покупка','cafe'],['Вареничная №1','Обед','cafe'],['ROSTICS','Обед','cafe'],['Папа Джонс','Покупка','cafe'],['Тануки','Покупка','cafe'],['Суши Вёсла','Покупка','cafe'],['Цех85','Покупка','cafe'],
 ['Мострансавто','Покупка','public'],['Московский метрополитен','Покупка','public'],['Таксовичкоф','Покупка','taxi'],['Whoosh','Покупка','micromobility'],['Юрент','Покупка','micromobility'],['ЛУКОЙЛ','Покупка','fuel'],['Teboil','Покупка','fuel'],['FIT SERVICE','Покупка','auto_service'],
 ['Зарядиум','Покупка','powerbank'],['PowerApp','Покупка','powerbank'],['Самсон Фарма','Покупка','pharmacy'],['Магнит Аптека','Покупка','pharmacy'],['Неофарм','Покупка','pharmacy'],['ЕАПТЕКА','Покупка','pharmacy'],['МЕДСИ','Покупка','doctors'],['СМ-Клиника','Покупка','doctors'],['ИНВИТРО','Покупка','diagnostics'],['KDL','Медицинская лаборатория','diagnostics'],['Мегастом','Покупка','dentistry'],['ДентаВита','Покупка','dentistry'],['Линзмастер','Покупка','optics'],['Айкрафт','Покупка','optics'],['ОРТЕКА','Покупка','medical_devices'],['Мелфон','Покупка','medical_devices'],
 ['World Class','Покупка','fitness'],['XFIT','Покупка','fitness'],['SMSTRETCHING','Покупка','fitness'],['SwimRocket','Покупка','fitness'],['Чемпионика','Покупка','child_sections'],['ПандаПарк','Покупка','ent_other'],['FitStars','Покупка','fitness'],['Триал-Спорт','Покупка','sport_goods'],['ВелоСтрана','Покупка','sport_goods'],['Demix','Покупка','clothes'],['5lb','Покупка','sport_nutrition'],
 ['DOM Лента','Покупка','home_repair'],['ВсеИнструменты.ру','Покупка','home_repair'],['Бауцентр','Покупка','home_repair'],['Askona','Покупка','home_goods'],['Столплит','Покупка','home_goods'],['Divan.ru','Покупка','home_goods'],['Мосэнергосбыт','Покупка','utilities'],['МосОблЕИРЦ','Оплата ЖКХ','utilities'],['Qlean','Покупка','household_service'],
 ['Befree','Покупка','clothes'],["O'STIN",'Покупка','clothes'],['Gloria Jeans','Покупка','clothes'],['KARI','Покупка','shoes'],['RALF RINGER','Покупка','shoes'],['Котофей','Покупка','child_goods'],['INCANTO','Покупка','clothes'],['Пан Чемодан','Покупка','accessories'],['Acoola','Покупка','child_goods'],['585*Золотой','Покупка','accessories'],
 ['Лэтуаль','Покупка','cosmetics'],['Рив Гош','Покупка','cosmetics'],['Улыбка радуги','Покупка','cosmetics'],['Чио Чио','Покупка','salon'],['OldBoy Barbershop','Покупка','salon'],['Nail Sunny','Покупка','salon'],
 ['Кинопоиск','Покупка','video'],['Яндекс Музыка','Покупка','video'],['Литрес','Покупка','books'],['Яндекс Диск','Покупка','cloud'],['Dr.Web','Покупка','software'],['Canva','Покупка','software'],['Midjourney','Покупка','ai'],['Beget','Покупка','cloud'],['Proton VPN','Покупка','vpn'],
 ['Wildberries','Покупка','marketplace'],['Ozon','Покупка товара','marketplace'],['Ситилинк','Покупка','electronics'],['Детский мир','Покупка','child_goods'],['Читай-город','Покупка','books'],['Hobby Games','Покупка','games'],['Синема Парк','Покупка','events'],['Московский зоопарк','Покупка','ent_other'],['Московский планетарий','Покупка','events'],
 ['Skillbox','Покупка','courses'],['Фоксфорд','Покупка','child_education'],['Skyeng','Покупка','courses'],['Аэрофлот','Покупка','air'],['S7 Airlines','Покупка','air'],['AZIMUT Hotels','Проживание','hotel'],['101Hotels','Покупка','hotel'],['Coral Travel','Покупка','tours'],
 ['Бетховен','Покупка','pet_goods'],['Petshop.ru','Покупка','pet_goods'],['ВетСити','Покупка','vet'],['Догси','Покупка','pet_care'],['Флорист.ру','Покупка','gifts'],['Подари жизнь','Благотворительное пожертвование','charity'],
];
for(const [name,description,target,mcc]of cases)test('catalog semantic: '+name,()=>{const a=recognizeActivity(input(name,description,mcc??null));assert.equal(a.status,'recognized',JSON.stringify(a));assert.equal(a.targetKey,target,JSON.stringify(a));});
test('all 1215 records have finite spellings, immutable provenance and a terminal activation outcome',()=>{
 assert.equal(fullCatalogProfiles.length,1215);assert.equal(new Set(fullCatalogProfiles.map(p=>p.id)).size,1215);assert.ok(fullCatalogProfiles.every(p=>p.sourceDocument&&p.sourceLine>0&&p.outcome));
 const index=literalIndex(fullCatalogProfiles.map(p=>({value:p.id,forms:p.forms})));let checked=0;
 for(const p of fullCatalogProfiles)for(const f of p.forms){const normalized=catalogFold(f);assert.ok(index(f.toUpperCase()).some(h=>h.value===p.id&&h.form===normalized),p.id+': '+f);for(const wrapped of ['x'+f+'x',f+'\u200dX','X\u2060'+f])assert.ok(!index(wrapped).some(h=>h.value===p.id&&h.form===normalized),p.id+': '+wrapped);checked++;}
 assert.ok(checked>11000);assert.ok(fullCatalogProfiles.filter(p=>['EXCLUDED_FROM_ACTIVE_V1','HISTORICAL_CONTEXT_ONLY','REF_PROFILE','GENERIC_ACTIVITY_ONLY'].includes(p.disposition)).every(p=>!p.active));
});
test('a known store plus delivery keeps its store activity; actual independent courier is logistics',()=>{
 for(const [name,target]of [['Skuratov Coffee','meal_delivery'],['Самсон Фарма','pharmacy'],['Wildberries','marketplace']])assert.equal(recognizeActivity(input(name!,'Покупка, доставка')).targetKey,target);
 assert.equal(recognizeActivity(input('Пятёрочка','Отдельная оплата курьерской услуги доставки')).targetKey,'logistics');
});
test('common words, manufacturers, historical identities, negation, source metadata and financial events cannot create a made-up purchase',()=>{
 for(const name of ['Мария','Рассвет','Сатурн','Аксон','Энерго','Лужники','Будь здоров','Мотив','Контур','Сбербанк','НСПК','Долями','Красный Куб','Догтренинг','Яндекс','Apple','Google'])assert.notEqual(fullCatalogEvidence(input(name)).status,'recognized',name);
 for(const name of ['Сбербанк','ИНВИТРО','World Class','Ozon']){assert.notEqual(recognizeActivity({...input(name),role:'income',kind:'transfer_in'}).status,'recognized');assert.notEqual(recognizeActivity({...input(name),kind:'refund'}).status,'recognized');}
 assert.notEqual(recognizeActivity(input('Не Кофемания')).status,'recognized');assert.equal(recognizeActivity(input('Неизвестный продавец','Комментарий: купить билет в Синема Парк')).targetKey,null);
 assert.equal(recognizeActivity(input('Будь Здоров','Аптека')).targetKey,'pharmacy');assert.equal(recognizeActivity(input('Будь Здоров','Клиника')).targetKey,'doctors');
});
test('recognition preserves source, signed minor units, user rules, parts and arbitrary own category IDs',()=>{
 const categories=starterCategories.expense.flatMap((path,index)=>[{id:'r'+index,name:path[0],parentId:null,role:'expense' as const,hidden:false},...path.slice(1).map((name,j)=>({id:'s'+index+'-'+j,name,parentId:'r'+index,role:'expense' as const,hidden:false}))]),op:Operation={id:'synthetic',source:{accountId:'a',operationDate:{precision:'day',date:'2026-10-28'},postedDate:null,amountMinor:'-129900',currency:'RUB',merchantText:'Рив Гош',description:'Покупка',bankCategory:'',bankRefHmac:null,versions:{sourceSanitizer:'bank-source/5',sourceTextEvidence:'intact'}},corrections:{},semantics:initialSemantics('purchase','Рив Гош'),comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};
 const before=structuredClone(op),next=applyActivityRecognition(op,categories);assert.notEqual(next.semantics.category.value,null);assert.deepEqual(next.source,before.source);assert.deepEqual(op,before);
 for(const source of ['user','personal_rule','global_rule']as const){op.semantics.category=facet('owner-category',source);assert.deepEqual(applyActivityRecognition(op,categories),op);}op.semantics.category=facet(null);op.decomposition=true;assert.deepEqual(applyActivityRecognition(op,categories),op);
});

test('concrete work/medical/digital products win over a broad organization profile',()=>{
 assert.equal(recognizeActivity(input('TimeWeb','Хостинг для работы')).targetKey,'business_services');
 assert.equal(recognizeActivity(input('VK WorkSpace','Подписка')).targetKey,'cloud');
 assert.equal(recognizeActivity(input('Google Workspace','Подписка')).targetKey,'cloud');
 assert.equal(recognizeActivity(input('Контур','Подписка на ПО')).targetKey,'software');
 assert.equal(recognizeActivity(input('МТС','Мобильный тариф')).targetKey,'mobile');
 assert.equal(recognizeActivity(input('МТС','Домашний интернет')).targetKey,'internet');
 assert.equal(recognizeActivity(input('Siberian Wellness','Покупка')).targetKey,null);
 const waxing=recognizeActivity(input('Wax & Go','Эпиляция'));assert.equal(waxing.targetKey,'care_other');assert.equal(waxing.provisional,false);
});
