import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialSemantics} from '../../../packages/finance-core/src/model.ts';
import type {Operation} from '../../../packages/finance-core/src/model.ts';
import {reviewRuleConditions,reviewRuleSource} from '../../../packages/finance-core/src/rules.ts';
import {parseBulkIntent} from '../src/finance-bulk.ts';
const account='10000000-0000-4000-8000-000000000001',id='10000000-0000-4000-8000-000000000002';
const op={id,source:{accountId:account,amountMinor:'-100',operationDate:{precision:'day',date:'2026-01-01'},merchantText:'',description:'',currency:'RUB'},corrections:{},semantics:initialSemantics('other','')} as Operation;
test('remembering becomes available only for a matching edited purchase or stable transfer',()=>{
 assert.equal(reviewRuleSource('other','-100','Shop',false),undefined);
 assert.equal(reviewRuleSource('purchase','-100','',false),undefined);
 assert.equal(reviewRuleSource('purchase','-100','Shop',false),'purchase');
 assert.equal(reviewRuleSource('purchase','100','Shop',false),undefined);
 assert.equal(reviewRuleSource('transfer_out','-100','Recipient',false),undefined);
 assert.equal(reviewRuleSource('transfer_out','-100','Recipient',true),'transfer');
 assert.equal(reviewRuleSource('transfer_out','0','Recipient',true),undefined);
});
test('the rule uses edited matching fields without mutating the source operation',()=>{
 assert.equal(reviewRuleConditions(op),undefined);
 assert.deepEqual(reviewRuleConditions(op,{kind:'purchase',merchant:' Shop '}),{merchantEquals:'Shop',accountId:account,direction:'out',kind:'purchase'});
 assert.equal(op.semantics.kind.value,'other');assert.equal(op.semantics.merchant.value,'');
 const bank='10000000-0000-4000-8000-000000000003';
 assert.equal(reviewRuleConditions({...op,bankCounterpartyId:bank},{kind:'transfer_out'})?.bankCounterpartyId,bank);
 assert.equal(reviewRuleConditions({...op,bankCounterpartyId:bank},{kind:'other'}),undefined);
});
test('review remembers supported assignments while keeping comments local',()=>{
 const base={kind:'bulk_operations',operationIds:[id],reviewScope:{sessionId:account,anchorId:id,revision:'1'},rememberRule:true};
 assert.equal(parseBulkIntent({...base,patch:{kind:'purchase',role:'expense',merchant:'Shop'}}).rememberRule,true);
 for(const patch of [{merchant:'Shop'},{role:'expense',comment:'local note'},{role:'expense',counterpartyId:account}])assert.equal(parseBulkIntent({...base,patch}).rememberRule,true);
 assert.throws(()=>parseBulkIntent({...base,patch:{comment:'only a note'}}));
 assert.throws(()=>parseBulkIntent({...base,reviewScope:undefined,patch:{role:'expense'}}));
});
