import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extendedProfiles} from '../src/catalog/generated/name-v1.ts';
import {extendedCatalogHits,extendedCatalogEvidence} from '../src/extended-catalog.ts';
import {recognizeActivity} from '../src/activity-recognition.ts';
const input=(merchantText:string,description='Покупка '+merchantText,extra={})=>({merchantText,description,...extra});
test('all four agreed blocks and every frozen explicit form reach a namespaced candidate, including inactive references',()=>{
 assert.equal(extendedProfiles.length,81);for(const p of extendedProfiles)for(const form of p.forms)assert.ok(extendedCatalogHits(form).some(h=>h.value.id===p.id),p.id+':'+form);
 for(const id of ['LOG022','PRF001','PRF002','PRF016'])assert.equal(extendedProfiles.find(p=>p.id===id)!.active,false);
});
test('parcel profiles require actual logistics and do not guess goods or turn reference registries into recipients',()=>{
 for(const name of ['СДЭК','B2CPL','5Post','Почта России']){
  assert.equal(extendedCatalogEvidence(input(name,'')).status,'needs_context');
  const e=extendedCatalogEvidence(input(name,'Отправка посылки '+name));assert.equal(e.status,'recognized',name);if(e.status==='recognized')assert.equal(e.target,'logistics');
  assert.equal(extendedCatalogEvidence(input(name,'Стоимость товара наложенный платеж '+name)).status,'needs_context');
 }
 for(const name of ['Boxberry','Реестр нотариусов','Московская городская нотариальная палата'])assert.notEqual(extendedCatalogEvidence(input(name,'Юридические услуги')).status,'recognized');
 assert.equal(extendedCatalogEvidence(input('ТК КИТ')).status,'needs_context');assert.equal(extendedCatalogEvidence(input('Китовый набор')).status,'none');
});
test('same operation service context distinguishes a household business, working space and unrelated names',()=>{
 for(const name of ['Химчистка Диана','Химчистка Леда','Химчистка Лисичка'])assert.equal(extendedCatalogEvidence(input(name)).status,'recognized',name);
 assert.equal(extendedCatalogEvidence(input('Диана')).status,'none');
 for(const name of ['B2CPL','СДЭК','5Post','Химдиван','СамПРАЧКА']){const e=extendedCatalogEvidence(input(name));assert.equal(e.status,'recognized',name);if(e.status==='recognized')assert.equal(e.provisional,false);}
 const e=extendedCatalogEvidence(input('Space 1','Аренда офиса Space 1',{bankCategory:'Коворкинг'}));assert.equal(e.status,'recognized');if(e.status==='recognized')assert.equal(e.target,'work_expense');
 assert.equal(extendedCatalogEvidence(input('Лавандерия','Химчистка Лавандерия')).status,'none');
 assert.equal(extendedCatalogEvidence(input('Лавандерия Нижний Новгород','Химчистка Лавандерия Нижний Новгород')).status,'recognized');
 const actual=recognizeActivity({...input('B2CPL','Отправка посылки B2CPL'),kind:'purchase',role:'expense'});assert.equal(actual.targetKey,'logistics');assert.equal(actual.profileKey,'catalog-v1:LOG019');
 for(const kind of ['refund','own_transfer','credit_card_repayment'])assert.equal(recognizeActivity({...input('B2CPL','Отправка посылки'),kind,role:'expense'}).status,'delegate_fin');
});
