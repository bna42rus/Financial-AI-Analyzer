import {test} from 'node:test';
import assert from 'node:assert/strict';
import {facet,initialSemantics} from '../src/model.ts';
import type {Component,Graph,Kind,Operation} from '../src/model.ts';
import {aggregate,reconcile} from '../src/graph.ts';
import {operationDisplayName} from '../src/operation-name.ts';

const account={id:'bank',bankId:'synthetic',name:'Синтетический счёт',type:'loan' as const,analyticsEnabled:true,defaultVisible:true,loanMode:null};
function operation(id:string,amountMinor:string,kind:Kind='loan_payment',day='2026-09-30'):Operation{return {id,source:{accountId:'bank',operationDate:{precision:'day',date:day},postedDate:null,amountMinor,currency:'RUB',sourceKind:kind,merchantText:'Банк',description:'Синтетический платёж',bankCategory:'',bankRefHmac:null,versions:{}},semantics:initialSemantics(kind,'Банк',amountMinor),corrections:{},comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};}
function fixture(parts=true):Graph{
 const op=operation('payment','-2500000');op.decomposition=parts;
 const component=(id:string,type:Component['type'],amountMinor:string):Component=>({id,transactionId:op.id,type,amountMinor,role:facet('unresolved'),category:facet(null),subcategory:facet(null)});
 return {accounts:[{...account}],operations:[op],categories:[],links:[],loanMode:'cashflow',components:parts?[component('principal','principal','-2000000'),component('interest','interest','-450000'),component('insurance','insurance','-50000')]:[]};
}
for(const global of ['economic','cashflow'] as const)for(const override of [null,'economic','cashflow'] as const)test('FIN-T43–T46/P05: '+global+' global / '+override+' account; terminal parts replace parent',()=>{
 const g=fixture();g.loanMode=global;g.accounts[0]!.loanMode=override;const before=structuredClone(g),p=reconcile(g),economic=(override??global)==='economic',totals=aggregate(p.operations);
 assert.equal(totals.netExpensesMinor,economic?'500000':'2500000');assert.equal(totals.neutralMinor,economic?'2000000':'0');assert.equal(totals.incomeMinor,'0');assert.equal(totals.unresolvedMinor,'0');
 assert.equal(p.operations[0]!.parts.reduce((n,p)=>n+BigInt(p.amountMinor),0n),-2500000n);assert.equal(p.operations[0]!.parts.length,3);assert.deepEqual(g,before);
});
test('FIN-T47/P05: missing economic composition is unresolved while cashflow remains the actual payment',()=>{
 const g=fixture(false);g.loanMode='economic';let p=reconcile(g);assert.equal(aggregate(p.operations).netExpensesMinor,'0');assert.equal(p.operations[0]!.unresolvedMinor,'2500000');assert.ok(p.operations[0]!.reviewReasons.includes('incomplete_credit_data'));
 g.loanMode='cashflow';assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'2500000');
});
test('FIN-P04/P05: verified component roles override either loan mode',()=>{
 const g=fixture();g.components[0]!.role=facet('neutral','user',true);assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'500000');g.loanMode='economic';g.components[1]!.role=facet('neutral','user',true);assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'50000');
});
test('FIN-T44/T51/P08: an invalid signed component sum suspends every component without silently adjusting source',()=>{
 const g=fixture();g.loanMode='economic';g.components[1]!.amountMinor='-449999';const before=structuredClone(g),p=reconcile(g);assert.equal(aggregate(p.operations).netExpensesMinor,'0');assert.equal(p.operations[0]!.unresolvedMinor,'2500000');assert.ok(p.operations[0]!.reviewReasons.includes('component_conflict'));assert.deepEqual(g,before);
});
test('FIN-T39–T41: credit purchase is expense once, loan issue and card repayment stay neutral',()=>{
 const g=fixture(false);g.accounts[0]!.type='loan';g.operations=[operation('issue','10000000','loan_disbursement'),operation('repayment','-10000000','credit_card_repayment')];let p=reconcile(g);assert.equal(aggregate(p.operations).netExpensesMinor,'0');assert.equal(aggregate(p.operations).incomeMinor,'0');assert.ok(p.operations[1]!.reviewReasons.includes('incomplete_credit_data'));
 g.accounts.push({...account,id:'card',type:'credit_card'});const purchase=operation('purchase','-10000000','purchase');purchase.source.accountId='card';g.operations.push(purchase);p=reconcile(g);assert.equal(aggregate(p.operations).netExpensesMinor,'10000000');assert.equal(p.operations.find(p=>p.id==='repayment')!.analyticsRole,'neutral');
});
test('FIN-T86/P10: refund reduces its actual month and never backdates the original expense',()=>{
 const g=fixture(false);g.operations=[operation('purchase','-10000','purchase'),operation('refund','4000','refund','2026-10-01')];g.links=[{id:'return',sourceId:'refund',targetId:'purchase',sourceComponentId:null,targetComponentId:null,kind:'refund',amountMinor:'4000',status:'confirmed',confidence:100,createdBy:'user'}];
 const p=reconcile(g);assert.equal(p.links[0]!.active,true);assert.equal(aggregate(p.operations,{from:'2026-09-01',through:'2026-09-30'}).netExpensesMinor,'10000');assert.equal(aggregate(p.operations,{from:'2026-10-01',through:'2026-10-31'}).expenseReductionsMinor,'4000');assert.equal(aggregate(p.operations).netExpensesMinor,'6000');
});
test('FIN-T87/T88: concurrent returns exceeding the same capacity invalidate all without picking a winner',()=>{
 const g=fixture(false);g.operations=[operation('purchase','-10000','purchase'),operation('r1','6000','refund'),operation('r2','6000','refund')];g.links=['r1','r2'].map(id=>({id,sourceId:id,targetId:'purchase',sourceComponentId:null,targetComponentId:null,kind:'refund',amountMinor:'6000',status:'confirmed',confidence:100,createdBy:'user'}));
 const before=structuredClone(g),p=reconcile(g);assert.ok(p.links.every(l=>!l.active&&l.reason==='CAPACITY_CONFLICT'));assert.equal(aggregate(p.operations).netExpensesMinor,'10000');assert.deepEqual(g,before);
});
test('FIN-T88: candidate/rejected links never authorize a refund reduction',()=>{
 const g=fixture(false);g.operations=[operation('purchase','-10000','purchase'),operation('refund','4000','refund')];for(const status of ['candidate','rejected'] as const){g.links=[{id:'return',sourceId:'refund',targetId:'purchase',sourceComponentId:null,targetComponentId:null,kind:'refund',amountMinor:'4000',status,confidence:100,createdBy:'user'}];const p=reconcile(g);assert.equal(p.links[0]!.active,false);assert.equal(p.operations[1]!.analyticsRole,'unresolved');assert.equal(aggregate(p.operations).netExpensesMinor,'10000');}
});
test('FIN-T91/T96: NAME cannot change credit parts, confirmed links or any financial totals',()=>{
 const g=fixture();g.loanMode='economic';const before=structuredClone(g),totals=aggregate(reconcile(g).operations);for(const op of g.operations){const name=operationDisplayName(op);assert.equal(typeof name.compositeLabel,'string');}assert.deepEqual(g,before);assert.deepEqual(aggregate(reconcile(g).operations),totals);
});
