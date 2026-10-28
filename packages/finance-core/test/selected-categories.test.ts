import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planSelectedCategories,selectedCategoryDefinitions,selectedCategoryOptions} from '../src/selected-categories.ts';
import type {Category} from '../src/model.ts';
import {starterCategories} from '../src/starter.ts';
const keys=selectedCategoryDefinitions.map(d=>d.key),ids=Object.fromEntries(keys.map(k=>[k,{rootId:'root-'+k,leafId:'leaf-'+k}]));
const c=(id:string,name:string,parentId:string|null=null,extra:Partial<Category>={}):Category=>({id,name,parentId,role:'expense',hidden:false,...extra});
test('six selected additions have their agreed meaning and new workspace starter paths',()=>{
 assert.equal(keys.length,6);for(const d of selectedCategoryDefinitions){const root=starterCategories.expense.find(ns=>ns[0]===d.path[0]);assert.ok(root,d.key);if(d.path.length>1)assert.ok((root as readonly string[]).includes(d.path[1]!),d.key);}
});
test('an empty existing tree previews eight new nodes with shared parents, creates no money and is deterministic',()=>{
 const input:Category[]=[],before=structuredClone(input),a=planSelectedCategories(input,keys,ids),b=planSelectedCategories(input,[...keys].reverse(),ids);assert.equal(a.created.length,8);assert.deepEqual(a,b);assert.equal(a.created.filter(c=>c.name==='Здоровье и спорт').length,1);assert.deepEqual(input,before);assert.ok(a.decisions.every(d=>d.status==='create'));
 const again=planSelectedCategories(a.created,keys,ids);assert.equal(again.created.length,0);assert.ok(again.decisions.every(d=>d.status==='present'));
});
test('an explicit compatible owner synonym/root/leaf is reused, not reparented or renamed',()=>{
 const own=[c('health','Медицина',null,{role:'both'}),c('eyes','Очки и линзы','health'),c('communication','Связь'),c('rental','Прокат зарядок','communication'),c('tech','Техника')],before=structuredClone(own),p=planSelectedCategories(own,['optics','powerbank','electronics'],ids);assert.equal(p.created.length,0);assert.equal(p.decisions.find(d=>d.key==='optics')!.subcategoryId,'eyes');assert.equal(p.decisions.find(d=>d.key==='powerbank')!.subcategoryId,'rental');assert.equal(p.decisions.find(d=>d.key==='electronics')!.categoryId,'tech');assert.deepEqual(own,before);
});
test('hidden leaf or parent is not resurrected, while another visible independent own category can be reused',()=>{
 const own=[c('health','Здоровье и спорт'),c('eyes','Оптика','health',{hidden:true})];let p=planSelectedCategories(own,['optics'],ids);assert.equal(p.decisions[0]!.status,'hidden');assert.equal(p.created.length,0);
 p=planSelectedCategories([c('health','Здоровье и спорт',null,{hidden:true})],['dentistry','medical_devices'],ids);assert.equal(p.created.length,0);assert.ok(p.decisions.every(d=>d.status==='hidden'));
 p=planSelectedCategories([c('hidden','Здоровье и спорт',null,{hidden:true}),c('visible','Стоматология')],['dentistry'],ids);assert.equal(p.decisions[0]!.status,'present');assert.equal(p.decisions[0]!.categoryId,'visible');
});
test('equal own candidates require a decision and income-only nodes are never borrowed for an expense',()=>{
 const own=[c('health','Здоровье и спорт'),c('a','Спортивное питание','health'),c('b','Спортивное питание','health')],p=planSelectedCategories(own,['sport_nutrition'],ids);assert.equal(p.created.length,0);assert.equal(p.decisions[0]!.status,'ambiguous');
 const income=[c('own','Техника и электроника',null,{role:'income'})];const q=planSelectedCategories(income,['electronics'],ids);assert.equal(q.created.length,1);assert.notEqual(q.created[0]!.id,'own');
});
test('selected child is added beneath the actual compatible owner parent; profile absence never creates siblings',()=>{
 const p=planSelectedCategories([c('own','Медицина')],['dentistry'],ids);assert.deepEqual(p.created,[c('leaf-dentistry','Стоматология','own')]);assert.equal(selectedCategoryOptions(p.created).length,6);assert.equal(p.created.some(c=>c.name==='Оптика'),false);
});
test('malformed duplicate owner IDs or preallocated new-ID collision fail closed without mutating the graph',()=>{
 const own=[c('same','Связь'),c('same','Медицина')];assert.throws(()=>planSelectedCategories(own,keys,ids),/DUPLICATE_CATEGORY_ID/);
 const original=[c('root-electronics','Чужой смысл')],before=structuredClone(original);assert.throws(()=>planSelectedCategories(original,['electronics'],ids),/DUPLICATE_CATEGORY_ID/);assert.deepEqual(original,before);
});
