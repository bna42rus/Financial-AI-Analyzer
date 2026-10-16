import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialSemantics,facet} from '../src/model.ts';
import {reviewGroupIds} from '../src/review-group.ts';
import type {ReviewGroupOperation} from '../src/review-group.ts';
const op=(id:string,patch:Partial<ReviewGroupOperation>={}):ReviewGroupOperation=>({id,accountId:'account',amountMinor:'-100',classification:initialSemantics('purchase','ВкусВилл'),decompositionActive:false,reviewReasons:['category_not_defined'],parts:[{included:true}],...patch});
test('group is a fixed session subset in its original order, irrespective of new imports',()=>{
 const operations=[op('one'),op('two',{amountMinor:'-200'}),op('new')];
 assert.deepEqual(reviewGroupIds(operations,['two','one'],'one'),['two','one']);
 assert.deepEqual(reviewGroupIds(operations,['two'],'one'),[]);
});
test('resolved, unavailable, different-account and conflicting decisions are excluded',()=>{
 const different=initialSemantics('purchase','ВкусВилл');different.category=facet('different-category','user',true);
 const operations=[op('one'),op('two'),op('resolved',{reviewReasons:[]}),op('account',{accountId:'other'}),op('different',{classification:different})];
 assert.deepEqual(reviewGroupIds(operations,['one','two','resolved','missing','account','different'],'one'),['one','two']);
});
test('duplicates, links, parts, unknown merchants and opposite signs never become a group',()=>{
 for(const patch of [{reviewReasons:['possible_duplicate']},{reviewReasons:['unlinked_refund']},{reviewReasons:['dependency_conflict']},{decompositionActive:true},{amountMinor:'100'},{classification:initialSemantics('purchase','')},{classification:initialSemantics('transfer_out','ВкусВилл')}]){
  assert.deepEqual(reviewGroupIds([op('one',patch),op('two',patch)],['one','two'],'one'),[]);
 }
});
test('independent verification, counterparty and participation remain separate group decisions',()=>{
 const semantics=initialSemantics('purchase','ВкусВилл');semantics.role=facet('expense','user',true);
 assert.deepEqual(reviewGroupIds([op('one'),op('two',{classification:semantics})],['one','two'],'one'),[]);
 assert.deepEqual(reviewGroupIds([op('one'),op('two',{parts:[{included:false}]})],['one','two'],'one'),[]);
});
test('single remaining items and over-limit sessions produce no truncated suggestion',()=>{
 assert.deepEqual(reviewGroupIds([op('one')],['one'],'one'),[]);
 const ids=Array.from({length:1001},(_,i)=>String(i));assert.deepEqual(reviewGroupIds(ids.map(id=>op(id)),ids,'0'),[]);
});
