import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Graph,Operation} from '../src/model.ts';
import {facet} from '../src/model.ts';
import {starterCategories} from '../src/starter.ts';
import {initialBankSemantics} from '../src/financial-evidence.ts';
import {applyMerchantRecognition} from '../src/merchant-recognition.ts';
import {operationDisplayName} from '../src/operation-name.ts';
import {extractSafeSource,sourceFields,merchantSourceSanitizer} from '../../imports/src/safe-source.ts';
import {defaultMerchantDictionary} from '../src/catalog/merchant-dictionary-data.ts';
import {validateMerchantDictionary,setMerchantDictionary,dictionaryMerchant} from '../src/merchant-dictionary.ts';
const categories:Graph['categories']=[];
for(const role of ['expense','income'] as const)for(const [name,...children] of starterCategories[role]){const id=role+name;categories.push({id,name,parentId:null,role,hidden:false});for(const name of children)categories.push({id:id+name,name,parentId:id,role,hidden:false});}
function classify(merchant:string,description='Оплата в '+merchant){
 const fields=sourceFields(extractSafeSource(description,'-12300',merchantSourceSanitizer),merchantSourceSanitizer);
 const source={...fields,accountId:'account',operationDate:{precision:'day' as const,date:'2026-01-01'},postedDate:null,amountMinor:'-12300',currency:'RUB' as const,bankCategory:fields.bankCategory??'',bankRefHmac:null,versions:{sourceSanitizer:merchantSourceSanitizer,sourceTextEvidence:'intact'}};
 const op:Operation={id:'synthetic',source,semantics:initialBankSemantics(source),corrections:{},comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};
 return applyMerchantRecognition(op,categories);
}
const cases:[string,string,string,string?][]=[
 ['VKUSVILL_1234_KCO_1 MOSCOW RU','ВкусВилл','Продукты'],['вкуссвилл','ВкусВилл','Продукты'],['vkusvil','ВкусВилл','Продукты'],
 ['BRISTOL 1234 MOSCOW RU','Бристоль','Продукты'],['MAGNOLIYA MOSCOW RU','Магнолия','Продукты'],['DIXY-12345D MOSCOW RUS','Дикси','Продукты'],
 ['KRASNOE&BELOE MOSCOW RUS','Красное & Белое','Продукты'],['DOSTAVKA IZ PYATEROCHK','Пятёрочка','Продукты','Доставка продуктов'],
 ['SBER*5411*SAMOKAT SANKT-PETERBU','Самокат','Продукты','Доставка продуктов'],['ZDRASTE-D.DONSKOGO MOSKVA RU','Здрасте','Еда вне дома'],
 ['Restopay','Restopay','Еда вне дома'],['МОРЕМАНИЯ - АЛФАВИТ','Моремания','Еда вне дома'],['РЫБНАЯ МАНУФАКТУРА','Рыбная мануфактура','Еда вне дома'],
 ['1KOALA PICCA','Коала','Еда вне дома'],['ООО КИНОКАССА','Кинокасса','Развлечения и хобби'],['KINOKVARTAL YASEN','Киноквартал','Развлечения и хобби'],
 ['SHOKO TC ATLANTIS KM','Шоколадница','Еда вне дома'],['ШОКО ВЕРНАДСКОГО 14 КМ','Шоколадница','Еда вне дома'],
 ['DALE CUPS','Dale Cups','Еда вне дома'],['COFFEE BURO','Coffee Buro','Еда вне дома'],['BELOQUE','Beloque','Еда вне дома'],
 ['WINESTYLE','WineStyle','Продукты'],['MINI-LINE.RU','Mini-Line','Одежда и аксессуары'],['ultimavpsbot G KALININGRAD','UltimaVPS','Подписки и цифровые сервисы','VPN'],
 ['YM*energo','Energo','Связь и интернет','Аренда пауэрбанков'],['YANDEX*4121*GO','Яндекс Go','Транспорт','Такси'],
 ['YANDEX*7372*OBLAKO','Yandex Cloud','Подписки и цифровые сервисы','Облачные сервисы'],['YANDEX*7299*RUNCHARG E g.','Бери заряд','Связь и интернет','Аренда пауэрбанков'],
 ['YANDEX*7999*SCOOTERS g.','Яндекс Самокаты','Транспорт'],['OTO*Telegram','Telegram','Подписки и цифровые сервисы'],
 ['SG*Premium Hong Kong HKG','Telegram Premium','Подписки и цифровые сервисы'],['VIPVENDING','VIPVENDING','Продукты'],['МегаФон','МегаФон','Связь и интернет','Мобильная связь']
];
for(const [raw,name,root,leaf] of cases)test('dictionary projection: '+raw,()=>{
 const op=classify(raw);assert.equal(operationDisplayName(op).title,name);
 assert.equal(categories.find(c=>c.id===op.semantics.category.value)?.name,root);
 if(leaf)assert.equal(categories.find(c=>c.id===op.semantics.subcategory.value)?.name,leaf);
 assert.equal(op.semantics.role.value,'expense');assert.ok(op.source.description.includes(raw));
});
test('uncertainty is actionable and generic coffee/vending use the agreed activity rules',()=>{
 for(const raw of ['YANDEX*4121*GO','VIPVENDING','МегаФон']){const op=classify(raw);assert.equal(op.semantics.category.confidence,80);assert.ok(op.reviewReasons.includes('low_category_confidence'));}
 assert.equal(classify('INDEPENDENT COFFEE BAR').semantics.category.value,'expenseЕда вне дома');
 const vending=classify('LOCALVENDING');assert.equal(vending.semantics.category.value,'expenseПродукты');assert.ok(vending.reviewReasons.includes('low_category_confidence'));
});
test('Sber SBP metadata does not hide the real merchant or become a merchant itself',()=>{
 const description='Коммунальные платежи, связь, интернет. МегаФон Покупка по СБП в ТСТ другого банка.. Операция по карте ****0000';
 const op=classify('',description);assert.equal(op.source.merchantText,'МегаФон');assert.equal(operationDisplayName(op).title,'МегаФон');assert.equal(op.semantics.category.value,'expenseСвязь и интернет');
});
test('private names/categories survive a dictionary refresh and absent categories are not invented',()=>{
 const op=classify('Restopay');op.semantics.merchant=facet('Моё название','user',true);op.semantics.category=facet('custom','user',true);op.semantics.subcategory=facet(null,'user',true);
 const next=applyMerchantRecognition(op,[]);assert.equal(operationDisplayName(next).title,'Моё название');assert.equal(next.semantics.category.value,'custom');
 const unknown=classify('Restopay');unknown.semantics.category=facet(null);unknown.semantics.subcategory=facet(null);assert.equal(applyMerchantRecognition(unknown,[]).semantics.category.value,null);
});
test('hot data changes are atomic; alias collisions and executable fields are rejected',()=>{
 assert.ok(validateMerchantDictionary(defaultMerchantDictionary).entries.length>=30);
 const bad=structuredClone(defaultMerchantDictionary) as any;bad.entries.push({...bad.entries[0],id:'other'});assert.throws(()=>setMerchantDictionary(bad));assert.equal(dictionaryMerchant('Restopay')?.entry.name,'Restopay');
 const injected=structuredClone(defaultMerchantDictionary) as any;injected.entries[0].pattern='.*';assert.throws(()=>setMerchantDictionary(injected));
 const changed=structuredClone(defaultMerchantDictionary) as any;changed.revision='test.2';changed.entries[0].name='Restopay Test';try{setMerchantDictionary(changed);assert.equal(operationDisplayName(classify('Restopay')).title,'Restopay Test');}finally{setMerchantDictionary(defaultMerchantDictionary);}
});
