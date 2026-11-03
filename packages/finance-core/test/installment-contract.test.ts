import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessInstallmentContract,installmentPaymentEvidence} from '../src/installment-contract.ts';
import {facet,initialSemantics} from '../src/model.ts';
import type {Graph,Operation,Kind} from '../src/model.ts';
import {aggregate,reconcile} from '../src/graph.ts';
import {activityDecision} from '../src/activity-recognition.ts';
const account={id:'a',name:'Реальный синтетический счёт',bankId:'synthetic',type:'bank_account' as const,analyticsEnabled:true,defaultVisible:true,loanMode:null};
function op(description:string,kind:Kind='purchase'):Operation{return {id:'payment',source:{accountId:'a',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-2500',currency:'RUB',sourceKind:kind,merchantText:'Яндекс Сплит',description,bankCategory:'Покупки',bankRefHmac:null,versions:{sourceSanitizer:'bank-source/5',sourceTextEvidence:'intact'}},semantics:initialSemantics(kind,'Яндекс Сплит','-2500'),corrections:{},comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};}
function graph(o:Operation):Graph{return {accounts:[{...account}],categories:[],operations:[o],components:[],links:[],loanMode:'cashflow'};}
for(const heading of ['Платёж по рассрочке','Очередной платёж Яндекс Сплит','Платеж Dolyame','Погашение по договору рассрочки Халва','Платеж частями','Списание сервис Долями'])test('FIN-T58/T59: '+heading+' needs an actual compatible contract',()=>{
 const o=op(heading),g=graph(o),before=structuredClone(g);assert.equal(assessInstallmentContract(o,account).status,'BLOCKED_UNSUPPORTED_CONTRACT');const p=reconcile(g);assert.equal(p.operations[0]!.financialContract?.status,'BLOCKED_UNSUPPORTED_CONTRACT');assert.equal(p.operations[0]!.analyticsRole,'unresolved');assert.ok(p.operations[0]!.reviewReasons.includes('unsupported_installment_contract'));assert.equal(aggregate(p.operations).netExpensesMinor,'0');assert.deepEqual(g,before);assert.equal(activityDecision(o,[])?.resolution.status,'missing');
});
for(const text of ['Покупка халвы','Покупка Ozon','Разделить покупку Ozon долями','Погашено долями','Погашение долями','Яндекс Сплит','Покупка через сервис Долями','Прогноз платежа Яндекс Сплит','Не платеж по рассрочке','Возврат платежа по рассрочке'])test('FIN-T56/T57/T60: no contract inferred from '+text,()=>{assert.equal(installmentPaymentEvidence(op(text).source),false);});
test('FIN-T59: a full purchase and unknown repayments never create a double expense',()=>{
 const g=graph(op('Очередной платёж Яндекс Сплит'));const purchase=op('Покупка Ozon');purchase.id='purchase';purchase.source.amountMinor='-10000';g.operations.push(purchase);const p=reconcile(g);assert.equal(aggregate(p.operations).netExpensesMinor,'10000');assert.equal(aggregate(p.operations).unresolvedMinor,'2500');assert.equal(g.operations.length,2);assert.equal(g.accounts.length,1);assert.equal(g.links.length,0);
});
test('FIN-I04: independently established bank loan/card models stay available on compatible real accounts',()=>{
 for(const [kind,type]of [['loan_payment','loan'],['credit_card_repayment','credit_card']] as const){const o=op('Платеж по рассрочке',kind),g=graph(o);g.accounts[0]!.type=type;assert.equal(assessInstallmentContract(o,g.accounts[0]).status,'existing_model');const p=reconcile(g);assert.equal(p.operations[0]!.financialContract,undefined);assert.equal(p.operations[0]!.analyticsRole,kind==='loan_payment'?'expense':'neutral');assert.equal(assessInstallmentContract(o,undefined).status,'BLOCKED_UNSUPPORTED_CONTRACT');}
});
test('FIN-P04/P08: verified and private choices and owner decomposition are protected',()=>{
 for(const source of ['user','personal_rule'] as const){const o=op('Платеж по рассрочке');o.semantics.role=facet('neutral',source,source==='user');assert.equal(assessInstallmentContract(o,account).status,'owner_decision');assert.equal(reconcile(graph(o)).operations[0]!.analyticsRole,'neutral');}
 const o=op('Платеж по рассрочке');o.decomposition=true;assert.equal(assessInstallmentContract(o,account).status,'owner_decision');
});
test('financial guard cannot be cleared by model confidence, opposite-sign correction or an unsafe source version',()=>{
 const o=op('Платеж по рассрочке');o.semantics.role=facet('expense','ai',false,100);assert.equal(reconcile(graph(o)).operations[0]!.analyticsRole,'unresolved');o.corrections.amountMinor='100';assert.equal(reconcile(graph(o)).operations[0]!.analyticsRole,'unresolved');
 const legacy=op('Платеж по рассрочке');legacy.source.versions.sourceSanitizer='bank-source/4';assert.equal(assessInstallmentContract(legacy,account).status,'not_applicable');const incoming=op('Платеж по рассрочке');incoming.source.amountMinor='100';assert.equal(assessInstallmentContract(incoming,account).status,'not_applicable');
});
