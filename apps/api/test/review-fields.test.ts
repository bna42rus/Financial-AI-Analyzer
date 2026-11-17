import {test} from 'node:test';import assert from 'node:assert/strict';
import {initialSemantics,facet} from '../../../packages/finance-core/src/model.ts';
import {primaryReviewFields,reviewDraft,reviewPatch,reviewFieldErrors} from '../../web/src/review-fields.ts';
import type {FinanceState} from '../../web/src/finance-client.ts';
const row=()=>({id:'op',amountMinor:'-100',classification:initialSemantics('transfer_out',''),comment:'',reviewReasons:['unresolved_role','unresolved_transfer'],decompositionActive:false} as FinanceState['operations'][number]);
test('unresolved financial role never hides empty category/subcategory or counterparty',()=>{const p=primaryReviewFields(row());for(const k of ['role','category','subcategory','counterparty']as const)assert.ok(p.has(k));assert.ok(!p.has('comment'));});
test('a known category stays below while an empty subcategory stays available without becoming required',()=>{const o=row();o.classification.category=facet('food','user',true);assert.equal(primaryReviewFields(o).has('category'),false);assert.equal(primaryReviewFields(o).has('subcategory'),true);});
test('confirming a role does not fabricate or verify a category; explicit empty category is preserved',()=>{const o=row(),d=reviewDraft(o);d.role='neutral';assert.deepEqual(reviewPatch(o,d,new Set(['role'])),{role:'neutral',categoryId:null,subcategoryId:null});d.role='unresolved';assert.deepEqual(reviewPatch(o,d,new Set(['comment'])),{comment:''});assert.deepEqual(reviewPatch(o,d,new Set(['category'])),{categoryId:null,subcategoryId:null});});
test('only a component editor can change a decomposed operation category',()=>{const o=row();o.decompositionActive=true;const p=primaryReviewFields(o);assert.ok(!p.has('category'));assert.deepEqual(reviewPatch(o,reviewDraft(o),new Set(['category'])),{});});
test('deleted or foreign child assignments produce field errors; optional empty subcategory is valid',()=>{const o=row(),d=reviewDraft(o);d.role='expense';d.category='food';const state={categories:[{id:'food',name:'Еда',parentId:null,role:'expense',hidden:false}],counterparties:[]} as unknown as FinanceState;assert.deepEqual(reviewFieldErrors(o,d,state),{});d.subcategory='missing';assert.ok(reviewFieldErrors(o,d,state).subcategory);});

test('bank verification clears only parser/import issues, not duplicates or categories',async()=>{
 const {reviewReasonsAfterEdit}=await import('../../../packages/finance-core/src/review.ts');
 const reasons=['parser_uncertainty','import_issue','possible_duplicate','low_category_confidence'];
 assert.deepEqual(reviewReasonsAfterEdit(reasons,{corrections:{amountMinor:'100',operationDate:{precision:'day',date:'2026-01-01'},accountId:'account'}}),['possible_duplicate','low_category_confidence']);
 assert.deepEqual(reviewReasonsAfterEdit(reasons,{corrections:{amountMinor:'100'}}),reasons);
});
