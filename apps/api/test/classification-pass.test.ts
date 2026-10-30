import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classificationInput,classificationTargets,summarizeClassification,classificationPassVersion} from '../src/classification-pass.ts';
import {classificationPlan,applyClassification} from '../src/classification-plan.ts';
import {initialSemantics,facet} from '../../../packages/finance-core/src/model.ts';
import type {Graph,Operation} from '../../../packages/finance-core/src/model.ts';
const op=(id='operation'):Operation=>({id,source:{accountId:'account',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-12500',currency:'RUB',merchantText:'Пятёрочка',description:'Synthetic only',bankCategory:'',bankRefHmac:'synthetic-hmac',versions:{}},corrections:{},semantics:initialSemantics('purchase','Пятёрочка'),comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]});
const graph=():Graph=>({accounts:[{id:'account',bankId:'tbank',name:'Synthetic account',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories:[{id:'food',name:'Продукты',role:'expense',parentId:null,hidden:false}],operations:[op()],components:[],links:[],loanMode:'cashflow'});
test('input invalidation follows new operations, category/catalog changes and not automatic output or UI-only edits',()=>{
 const g=graph(),before=classificationInput(g,[]);g.operations[0]=applyClassification(g.operations[0]!,{categoryId:'food',subcategoryId:null,confidence:96});g.operations[0]!.comment='Changed local comment';assert.equal(classificationInput(g,[]).inputHash,before.inputHash);
 g.categories.push({id:'leaf',name:'Супермаркеты',parentId:'food',role:'expense',hidden:false});assert.notEqual(classificationInput(g,[]).inputHash,before.inputHash);g.categories.pop();g.operations.push(op('second'));assert.notEqual(classificationInput(g,[]).inputHash,before.inputHash);
});
test('new catalogs can reconsider confident AI assignments while manual choices and rules remain protected',()=>{
 const g=graph();g.operations[0]=applyClassification(g.operations[0]!,{categoryId:'food',subcategoryId:null,confidence:96});assert.equal(classificationPlan(g).groups.length,0);assert.equal(classificationPlan(g,[],true).groups.length,1);
 g.operations[0]!.semantics.category=facet('food','user',true);assert.equal(classificationPlan(g,[],true).groups.length,0);assert.equal(classificationTargets(g,[]).length,0);
 g.operations[0]=op();const rules=[{id:'rule',name:'Own',enabled:true,priority:0,conditions:{merchantEquals:'Пятёрочка'},assignments:{categoryId:'food'}}];assert.equal(classificationTargets(g,rules).length,0);assert.equal(classificationPlan(g,rules,true).groups.length,0);
});
test('last-pass totals distinguish new assignments, refinements, unchanged and unresolved operations',()=>{
 const operations=[op('new'),op('refined'),op('same'),op('unknown')];operations[0]!.semantics.category=facet('food','ai');operations[1]!.semantics.category=facet('food','ai');operations[1]!.semantics.subcategory=facet('leaf','ai');operations[2]!.semantics.category=facet('food','ai');operations[3]!.reviewReasons=['low_category_confidence'];
 const report=summarizeClassification({version:classificationPassVersion,inputHash:'0'.repeat(64),catalogHash:'1'.repeat(64),reconsider:true,baseline:[{id:'new',categoryId:null,subcategoryId:null},{id:'refined',categoryId:'food',subcategoryId:null},{id:'same',categoryId:'food',subcategoryId:null},{id:'unknown',categoryId:null,subcategoryId:null},{id:'deleted',categoryId:null,subcategoryId:null}]},operations);
 assert.deepEqual(report,{scanned:4,defined:3,newlyAssigned:1,changed:2,refined:1,unchanged:2,unresolved:1,needsReview:1});
});
