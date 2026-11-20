import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialSemantics,facet} from '../src/model.ts';
import type {Operation,Category} from '../src/model.ts';
import {applyMerchantRecognition} from '../src/merchant-recognition.ts';
import {activityDecision} from '../src/activity-recognition.ts';
const categories:Category[]=[{id:'own-root',name:'Мой личный раздел',parentId:null,role:'both',hidden:false},{id:'own-leaf',name:'Мои покупки для здоровья',parentId:'own-root',role:'expense',hidden:false},{id:'starter',name:'Здоровье и спорт',parentId:null,role:'expense',hidden:false},{id:'pharmacy',name:'Аптеки',parentId:'starter',role:'expense',hidden:false}];
const binding={pharmacy:{categoryId:'own-root',subcategoryId:'own-leaf'}};
function op():Operation{return {id:'operation',source:{accountId:'account',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-100',currency:'RUB',sourceKind:'purchase',merchantText:'Аптека Ромашка',description:'Покупка Аптека Ромашка',bankCategory:'',bankRefHmac:null,versions:{sourceSanitizer:'bank-source/5',sourceTextEvidence:'intact'}},semantics:initialSemantics('purchase','Аптека Ромашка','-100'),corrections:{},comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};}
test('explicit own mapping survives arbitrary own names and wins over a starter alias without changing money/source',()=>{
 const o=op(),before=structuredClone(o),a=applyMerchantRecognition(o,categories,binding);assert.equal(a.semantics.category.value,'own-root');assert.equal(a.semantics.subcategory.value,'own-leaf');assert.deepEqual(a.source,before.source);assert.deepEqual(o,before);
 const renamed=categories.map(c=>({...c,name:'Другое название '+c.id}));assert.equal(applyMerchantRecognition(o,renamed,binding).semantics.subcategory.value,'own-leaf');
});
test('hidden, moved, wrong-role and missing mapping targets fail closed instead of choosing the tempting starter',()=>{
 for(const own of [categories.filter(c=>c.id!=='own-leaf'),categories.map(c=>c.id==='own-leaf'?{...c,hidden:true}:c),categories.map(c=>c.id==='own-leaf'?{...c,parentId:'starter'}:c),categories.map(c=>c.id==='own-root'?{...c,role:'income' as const}:c)]){const o=op();assert.equal(activityDecision(o,own,binding)!.resolution.status,'invalid_binding');assert.equal(applyMerchantRecognition(o,own,binding).semantics.category.value,null);}
});
test('owner mapping never outranks user/private facets, decomposition or uncertain literal provenance',()=>{
 for(const source of ['user','personal_rule'] as const){const o=op();o.semantics.category=facet('manual',source,source==='user');assert.equal(applyMerchantRecognition(o,categories,binding).semantics.category.value,'manual');}
 const split=op();split.decomposition=true;assert.equal(applyMerchantRecognition(split,categories,binding).semantics.category.value,null);const uncertain=op();uncertain.source.versions.sourceTextEvidence='unknown';assert.equal(applyMerchantRecognition(uncertain,categories,binding).semantics.category.value,null);
});
