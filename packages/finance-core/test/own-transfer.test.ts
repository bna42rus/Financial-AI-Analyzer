import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialBankSemantics,applyFinancialRecognition} from '../src/financial-evidence.ts';
import {applyOwnTransfer} from '../src/own-transfer.ts';
import {initialSemantics,facet} from '../src/model.ts';
import type {Operation,Graph} from '../src/model.ts';
import {applyRules,reviewRuleConditions} from '../src/rules.ts';
import {aggregate,reconcile} from '../src/graph.ts';
import {operationDisplayName} from '../src/operation-name.ts';
const op=(text='Перевод себе',amount='12300'):Operation=>{const source={accountId:'account',operationDate:{precision:'day' as const,date:'2026-01-01'},postedDate:null,amountMinor:amount,currency:'RUB' as const,sourceKind:amount[0]==='-'?'transfer_out' as const:'transfer_in' as const,merchantText:'',description:text,bankCategory:'',bankRefHmac:null,versions:{sourceSanitizer:'bank-source/5',sourceTextEvidence:'intact'}};return {id:'op',source,semantics:initialBankSemantics(source),corrections:{},comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};};
const account={id:'account',bankId:'tbank',name:'Synthetic',type:'bank_account' as const,analyticsEnabled:true,defaultVisible:true,loanMode:null};
test('explicit self-transfer headings are neutral in either direction and have a plain name',()=>{
 for(const text of ['Перевод себе','Внутренний перевод себе','Перевод между своими счетами','Перевод на собственный счёт'])for(const amount of ['12300','-12300']){
  const operation=op(text,amount);assert.equal(operation.semantics.kind.value,'own_transfer');assert.equal(operation.semantics.role.value,'neutral');assert.equal(operationDisplayName(operation).title,'Перевод себе');
  const graph:Graph={accounts:[account],categories:[],operations:[operation],components:[],links:[],loanMode:'cashflow'};assert.equal(aggregate(reconcile(graph).operations).netExpensesMinor,'0');assert.equal(aggregate(reconcile(graph).operations).incomeMinor,'0');
 }
});
test('a matching owned account is sufficient, while manual roles/types and personal rules keep priority',()=>{
 const operation=op('Внешний перевод','-12300');operation.bankOwnAccountId='owned-target';const next=applyOwnTransfer(operation);assert.equal(next.semantics.kind.value,'own_transfer');assert.equal(operation.semantics.kind.value,'transfer_out');
 const manual=structuredClone(operation);manual.semantics.role=facet('expense','user',true);assert.deepEqual(applyOwnTransfer(manual),manual);
 const personal={id:'rule',name:'Owner decision',enabled:true,priority:100,conditions:{kind:'transfer_out' as const},assignments:{kind:'transfer_out' as const,role:'expense' as const}};
 const ruled=applyRules(next,account,[personal]);assert.equal(ruled.semantics.kind.value,'transfer_out');assert.equal(ruled.semantics.role.value,'expense');
});
test('remembering a self-transfer uses the protected counterparty identity for future directions',()=>{
 const operation=op('Внешний перевод','-12300');operation.bankCounterpartyId='peer';const conditions=reviewRuleConditions(operation,{kind:'own_transfer'});assert.deepEqual(conditions,{bankCounterpartyId:'peer'});
 for(const amount of ['12300','-12300']){const future=op('Перевод по реквизитам',amount);future.bankCounterpartyId='peer';const result=applyRules(future,account,[{id:'r',name:'Own',enabled:true,priority:100,conditions:conditions!,assignments:{kind:'own_transfer',role:'neutral'}}]);assert.equal(result.semantics.kind.source,'personal_rule');assert.equal(result.semantics.role.value,'neutral');}
 assert.equal(reviewRuleConditions(op('Внешний перевод'),{kind:'own_transfer'}),undefined);
});
test('explicit bank fees and early loan payments use the financial categories',()=>{
 const categories:Graph['categories']=[{id:'bank',name:'Банковские услуги',parentId:null,role:'expense',hidden:false},{id:'notify',name:'Уведомления',parentId:'bank',role:'expense',hidden:false},{id:'loan',name:'Кредиты и долги',parentId:null,role:'expense',hidden:false},{id:'payments',name:'Платежи по кредитам',parentId:'loan',role:'expense',hidden:false}];
 const fee=op('Плата за оповещения об операциях','-12300');fee.source.sourceKind='fee' as any;fee.semantics=initialSemantics('fee');const classified=applyFinancialRecognition(fee,categories);assert.equal(classified.semantics.category.value,'bank');assert.equal(classified.semantics.subcategory.value,'notify');
 const loan=op('Досрочное погашение кредита','-12300');loan.source.sourceKind='other' as any;loan.semantics=initialBankSemantics(loan.source);const result=applyFinancialRecognition(loan,categories);assert.equal(result.semantics.kind.value,'loan_payment');assert.equal(result.semantics.subcategory.value,'payments');assert.equal(operationDisplayName(result).title,'Досрочное погашение кредита');
});
