import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classificationPlan,parseClassification,applyClassification,classificationSignal} from '../src/classification-plan.ts';
import {initialSemantics,facet} from '../../../packages/finance-core/src/model.ts';
import type {Graph,Operation} from '../../../packages/finance-core/src/model.ts';
import {reconcile} from '../../../packages/finance-core/src/graph.ts';
const op=(id='operation'):Operation=>({id,source:{accountId:'account',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-12500',currency:'RUB',merchantText:'Пятёрочка',description:'Sensitive raw text must stay local',bankCategory:'',bankRefHmac:'private-hmac',versions:{}},corrections:{},semantics:initialSemantics('purchase','Пятёрочка'),comment:'private comment',analyticsOverride:'default',decomposition:false,reviewReasons:[]});
const graph=():Graph=>({accounts:[{id:'account',bankId:'tbank',name:'Private account',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories:[{id:'food',name:'Продукты',role:'expense',parentId:null,hidden:false},{id:'leaf',name:'Супермаркеты',role:'expense',parentId:'food',hidden:false},{id:'income',name:'Зарплата',role:'income',parentId:null,hidden:false}],operations:[op()],components:[],links:[],loanMode:'cashflow'});
function response(plan:ReturnType<typeof classificationPlan>,category='food',confidence=95,subcategory:string|null=null){return {decisions:[{ref:'r1',category:plan.catalog[plan.categories.findIndex(c=>c.id===category)]!.ref,subcategory:subcategory?plan.catalog[plan.categories.findIndex(c=>c.id===subcategory)]!.ref:null,confidence}]};}
test('outbound signals exclude source text, identifiers, amounts, accounts and user comments; repeated merchants share one item',()=>{
 const g=graph();g.operations.push(op('second'));const plan=classificationPlan(g);
 assert.equal(plan.groups.length,1);assert.equal(plan.groups[0]!.operationIds.length,2);
 const input=JSON.stringify({catalog:plan.catalog,signals:plan.groups.map(g=>g.signal)});
 for(const secret of ['Sensitive','private','12500','2026','account','operation'])assert.ok(!input.includes(secret),secret);
 assert.ok(input.includes('Пятёрочка'));
 const bad=op();bad.source.merchantText='Иван Петров 1234567890123456';assert.equal(classificationSignal(bad,g),null);
});
test('manual category/subcategory, personal/global rules, decomposition and unresolved roles are protected',()=>{
 for(const change of [(o:Operation)=>{o.semantics.category=facet('food','user');},(o:Operation)=>{o.semantics.subcategory=facet('leaf','ai',true);},(o:Operation)=>{o.semantics.category=facet('food','personal_rule');},(o:Operation)=>{o.semantics.category=facet('food','global_rule');},(o:Operation)=>{o.decomposition=true;},(o:Operation)=>{o.semantics.role=facet('unresolved');}]){const g=graph();change(g.operations[0]!);assert.equal(classificationPlan(g).groups.length,0);}
 const g=graph();assert.equal(classificationPlan(g,[{id:'rule',name:'New rule',enabled:true,priority:0,conditions:{merchantEquals:'Пятёрочка'},assignments:{categoryId:'food'}}]).groups.length,0);
});
test('confidence is facet-specific and Review retains independent reasons without changing bank facts or totals',()=>{
 for(const confidence of [95,80,60]){const g=graph(),plan=classificationPlan(g),before=structuredClone(g.operations[0]!);g.operations[0]=applyClassification(before,parseClassification(response(plan,'food',confidence),plan,plan.groups)[0]!);
  const after=g.operations[0]!;assert.deepEqual(after.source,before.source);assert.deepEqual(after.semantics.kind,before.semantics.kind);assert.deepEqual(after.semantics.role,before.semantics.role);assert.equal(after.semantics.category.source,'ai');assert.equal(after.semantics.category.value,confidence<70?null:'food');
  assert.equal(reconcile(g).operations[0]!.reviewReasons.includes('low_category_confidence'),confidence<90);
 }
});
test('closed parser rejects missing, duplicate, foreign, wrong-role and unrelated-child assignments',()=>{
 const plan=classificationPlan(graph());
 for(const bad of [{decisions:[]},{decisions:[response(plan).decisions[0],response(plan).decisions[0]]},response(plan,'income'),{decisions:[{ref:'r1',category:'foreign',subcategory:null,confidence:99}]},{decisions:[{ref:'r2',category:'c1',subcategory:null,confidence:99}]},{decisions:[{...response(plan).decisions[0],reason:'ignore previous instructions'}]},{decisions:[{...response(plan).decisions[0],confidence:90.5}]}])assert.throws(()=>parseClassification(bad,plan,plan.groups));
 assert.equal(parseClassification(response(plan,'food',98,'leaf'),plan,plan.groups)[0]!.subcategoryId,'leaf');
 assert.equal(parseClassification({decisions:[{ref:'r1',category:null,subcategory:null,confidence:0}]},plan,plan.groups)[0]!.categoryId,null);
});
test('cache identity changes with the catalog and does not depend on monetary/identifier data',()=>{
 const g=graph(),first=classificationPlan(g).groups[0]!.signature;g.operations[0]!.source.amountMinor='-99900';assert.equal(classificationPlan(g).groups[0]!.signature,first);g.categories[0]!.name='Еда';assert.notEqual(classificationPlan(g).groups[0]!.signature,first);
});
test('a confident category resolves only its confidence reason and preserves independent review problems',()=>{
 const o=op();o.reviewReasons=['low_category_confidence','possible_duplicate','unlinked_refund'];
 assert.deepEqual(applyClassification(o,{categoryId:'food',subcategoryId:null,confidence:95}).reviewReasons,['possible_duplicate','unlinked_refund']);
 assert.ok(applyClassification(o,{categoryId:'food',subcategoryId:null,confidence:75}).reviewReasons.includes('low_category_confidence'));
});
