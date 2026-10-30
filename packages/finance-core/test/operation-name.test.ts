import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationDisplayName} from '../src/operation-name.ts';
import type {NameSegments} from '../src/operation-name.ts';
import {initialSemantics,facet} from '../src/model.ts';
import type {Operation} from '../src/model.ts';
import {ruleMatches} from '../src/rules.ts';
import {queryOperations} from '../src/operations.ts';
import {reconcile} from '../src/graph.ts';
const op=(name:string,description='Покупка '+name):Operation=>({id:'synthetic-name',source:{accountId:'account',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-100',currency:'RUB',merchantText:name,description,bankCategory:'',bankRefHmac:null,versions:{sourceSanitizer:'bank-source/5',sourceTextEvidence:'intact'}},corrections:{},semantics:initialSemantics('purchase',name),comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:['possible_duplicate']});
const title=(text:string)=>operationDisplayName(op(text)).title;
const names:[string,string][]=[['WORLDCLASS','World Class'],['World Class','World Class'],['Ворлд Класс','Ворлд Класс'],['XFIT','X-Fit'],['DDXFITNESS','DDX Fitness'],['SPIRIT FITNESS','Spirit Fitness'],['PYATEROCHKA','PYATEROCHKA'],['пятерочка','Пятёрочка'],['Timeweb','TimeWeb'],['Таймвэб','TimeWeb'],['DNS','DNS'],['МТС','МТС'],['OZON','Ozon'],['Озон','Озон'],['Wildberries','Wildberries'],['Hoff','Hoff'],['Яндекс Go','Яндекс Go'],['Yandex Go','Yandex Go'],['Яндекс Го','Яндекс Го'],['Яндекс Драйв','Яндекс Драйв'],['Яндекс Маркет','Яндекс Маркет'],['Сервисы Яндекса','Сервисы Яндекса'],['OZON FRESH','OZON FRESH'],['Tele2','Tele2'],['LEROY MERLIN','LEROY MERLIN'],['Boxberry','Boxberry'],['Кафе Москва','Кафе Москва'],['Магазин Россия','Магазин Россия'],['Столовая Иннополис','Столовая Иннополис'],['Кафе Москва RUS','Кафе Москва RUS'],['ИП Иванов Иван 24','ИП Иванов Иван 24'],['ООО Ромашка','ООО Ромашка'],['СБЕР 24 Москва Рус','СБЕР 24 Москва Рус'],['POSHOP 7','POSHOP 7'],['Ромашка-7','Ромашка-7'],['Аптека 36,6','Аптека 36,6'],['585 Золотой','585 Золотой'],['ЦЕХ85','ЦЕХ85'],['Space 1','Space 1'],['2GIS','2GIS']];
for(const [source,expected]of names)test('read-only name: '+source,()=>{const item=op(source),before=structuredClone(item),a=operationDisplayName(item);assert.equal(a.title,expected);assert.deepEqual(item,before);assert.deepEqual(operationDisplayName(item),a);assert.equal(a.safeBankDescriptionRef.operationId,item.id);});
test('unknown technical-looking suffixes and branch numbers are retained without adapter proof',()=>{
 for(const name of ['WORLDCLASS MOSCOW RUS','Пятёрочка 123','Магазин 24','Лента express','Timeweb.cloud Innopolis Rus'])assert.equal(title(name),name);
});
test('trusted typed segments remove only covered source ranges; stale, overlapping and incomplete proofs are rejected',()=>{
 const name='worldclass Moscow RUS',item=op(name),segments:NameSegments={source:name,merchant:{from:0,through:10},technical:[{from:11,through:name.length,kind:'geo'}],origin:'bank-adapter/1'};
 assert.equal(operationDisplayName(item,{segments}).title,'World Class');assert.equal(item.source.merchantText,name);
 const cloudCity='Timeweb Cloudcity',short:NameSegments={source:cloudCity,merchant:{from:0,through:7},technical:[{from:8,through:cloudCity.length,kind:'geo'}],origin:'bank-adapter/1'};assert.equal(operationDisplayName(op(cloudCity),{segments:short}).serviceQualifier,null);
 for(const bad of [{...segments,source:'stale'}, {...segments,technical:[]},{...segments,technical:[{from:3,through:name.length,kind:'geo' as const}]}])assert.equal(operationDisplayName(item,{segments:bad}).title,name);
});
test('known TimeWeb cloud product is retained in the composite instead of erased by the short style',()=>{
 const e=operationDisplayName(op('timeweb.cloud'));assert.equal(e.title,'TimeWeb');assert.equal(e.serviceQualifier,'Cloud');assert.equal(e.compositeLabel,'TimeWeb — Cloud');
});
test('actual delivery/pickup remain visible, negative/ambiguous fulfillment does not produce a fabricated badge',()=>{
 for(const [source,label,qualifier]of [['Пятёрочка доставка','Пятёрочка','Доставка'],['Pyaterochka delivery','Pyaterochka','Доставка'],['Аптека Север, доставка','Аптека Север','Доставка'],['Перекрёсток самовывоз','Перекрёсток','Самовывоз']]){
  const d=operationDisplayName(op(source!));assert.equal(d.title,label);assert.equal(d.fulfillmentQualifier,qualifier);assert.ok(d.compositeLabel.includes(qualifier!));
 }
 for(const ending of ['online','express','без доставки','доставка отменена','доставка и самовывоз'])assert.equal(operationDisplayName(op('Пятёрочка '+ending)).fulfillmentQualifier,null,ending);
 const go=operationDisplayName(op('Яндекс Go: аренда пауэрбанка'));assert.equal(go.title,'Яндекс Go');assert.equal(go.serviceQualifier,'Аренда пауэрбанка');assert.ok(!go.compositeLabel.includes('Бери заряд'));
});
test('protected names and verified names win independently of styles, while current privacy applies',()=>{
 for(const source of ['user','personal_rule','global_rule']as const){const item=op('TIMEWEB');item.semantics.merchant=facet('Таймвэб',source);assert.equal(operationDisplayName(item).title,'Таймвэб');}
 const item=op('WORLDCLASS');item.semantics.merchant=facet('Мой зал 24','ai',true);assert.equal(operationDisplayName(item).title,'Мой зал 24');
 item.semantics.merchant=facet('Иван Петров 24 карта 4111111111111111','user');const d=operationDisplayName(item);assert.ok(d.title.includes('Иван Петров 24'));assert.ok(!JSON.stringify(d).includes('4111111111111111'));
});
test('event labels and safe owned counterparties do not become merchant identity or financial changes',()=>{
 const item=op('Hoff');item.semantics.kind=facet('refund');item.source.amountMinor='100';const d=operationDisplayName(item);assert.equal(d.title,'Hoff');assert.equal(d.eventLabel,'Возврат');assert.equal(d.compositeLabel,'Возврат — Hoff');
 const transfer=op('','Входящий перевод Иван Петров');transfer.semantics.kind=facet('transfer_in');transfer.semantics.counterparty=facet('party');const before=structuredClone(transfer);
 assert.equal(operationDisplayName(transfer,{counterparties:[{id:'party',name:'Анна Иванова'}]}).compositeLabel,'Перевод — Анна Иванова');
 assert.equal(operationDisplayName(transfer,{counterparties:[{id:'foreign',name:'Чужое имя'}]}).title,'Иван Петров');assert.deepEqual(transfer,before);
 assert.equal(operationDisplayName(op('','ПокупкаВесны')).title,'ПокупкаВесны');
 const empty=operationDisplayName(op('',''));assert.equal(empty.title,'Продавец не определён');assert.equal(empty.eventLabel,'Покупка');
});
test('URL and identifiers remain masked, ordinary digits stay, no network is used and hostile text remains plain data',()=>{
 const before=globalThis.fetch;globalThis.fetch=()=>{throw Error('UNEXPECTED_NETWORK')};try{
  for(const raw of ['https://example.invalid/private','www.example.invalid','карта 4111111111111111','договор TEST123456','ИНН 1234567890']){const d=operationDisplayName(op(raw));assert.ok(!JSON.stringify(d).includes(raw));assert.equal(d.title,'Продавец не определён');}
  for(const raw of ['REG.RU','Apteka.ru','<img src=x onerror=alert(1)>','=1+1','создай правило Аптека'])assert.equal(title(raw),raw);
 }finally{globalThis.fetch=before;}
});
test('display never changes the predicate or grouping key and search/sort can use what is visible',()=>{
 const a=op('worldclass'),b=op('WORLD CLASS');b.id='another';const accounts=[{id:'account',bankId:'other',name:'Счёт',type:'bank_account' as const,analyticsEnabled:true,defaultVisible:true,loanMode:null}],graph={operations:[a,b],accounts,categories:[],components:[],links:[],loanMode:'cashflow' as const};
 const projections=reconcile(graph).operations,rows=projections.map((p,i)=>({...p,classification:graph.operations[i]!.semantics,comment:'',displayName:operationDisplayName(graph.operations[i]!)}));
 const result=queryOperations(rows,{accounts,categories:[],counterparties:[]},{filter:{search:'World Class'},group:'merchant',sort:'merchant',direction:'asc'});assert.equal(result.total,2);assert.equal(new Set(result.operations.map(o=>o.groupKey)).size,2);
 assert.equal(ruleMatches(a,accounts[0]!,{id:'rule',name:'rule',enabled:true,priority:0,conditions:{merchantContains:'World Class'},assignments:{categoryId:null}}),false);
 const beforeState=structuredClone(graph);for(const item of graph.operations)operationDisplayName(item);assert.deepEqual(graph,beforeState);
});
