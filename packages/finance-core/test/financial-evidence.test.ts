import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultRole,initialSemantics,facet} from '../src/model.ts';
import type {BankFact,Graph,Operation} from '../src/model.ts';
import {aggregate,reconcile} from '../src/graph.ts';
import {applyFinancialRecognition,bankInterestEvidence,initialBankSemantics,refreshBankSemantics} from '../src/financial-evidence.ts';

test('FIN-T49: received and paid bank interest have different roles, with unknown and zero unresolved',()=>{
 assert.equal(defaultRole('interest','450000'),'income');
 assert.equal(defaultRole('interest','-450000'),'expense');
 assert.equal(defaultRole('interest','0'),'unresolved');
 assert.equal(defaultRole('interest'),'unresolved');
 assert.equal(initialSemantics('interest','', '450000').role.value,'income');
});

function bankFact(description:string,amountMinor='450000'):BankFact{return {accountId:'bank',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor,currency:'RUB',sourceKind:'other',merchantText:'',description,bankCategory:'',bankRefHmac:null,versions:{sourceSanitizer:'bank-source/5',sourceTextEvidence:'intact'}};}
function operation(source:BankFact):Operation{return {id:'op',source,corrections:{},semantics:initialSemantics(source.sourceKind??'other',source.merchantText),comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};}
function graph(op:Operation):Graph{return {accounts:[{id:'bank',bankId:'synthetic',name:'Банк',type:'deposit',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories:[],operations:[op],components:[],links:[],loanMode:'cashflow'};}

test('FIN-T50: corrections and clearing them recompute automatic interest from effective direction without mutating source',()=>{
 const o=operation({...bankFact('Проценты по вкладу'),sourceKind:'interest'}),g=graph(o),before=structuredClone(o.source);
 // Reconcile an old persisted initializer too; a view must not rewrite its record.
 o.semantics.role=facet('expense');const persisted=structuredClone(o.semantics);
 assert.equal(aggregate(reconcile(g).operations).incomeMinor,'450000');
 o.corrections.amountMinor='-450000';assert.equal(aggregate(reconcile(g).operations).netExpensesMinor,'450000');
 o.corrections={};assert.equal(aggregate(reconcile(g).operations).incomeMinor,'450000');
 assert.deepEqual(o.source,before);assert.deepEqual(o.semantics,persisted);
});

for(const source of ['user','personal_rule','global_rule','ai'] as const)test('FIN-P04: explicit '+source+' interest role stays independent of direction',()=>{
 const o=operation({...bankFact('Проценты по вкладу'),sourceKind:'interest'});o.semantics.role=facet('neutral',source,source==='user');
 assert.equal(reconcile(graph(o)).operations[0]!.analyticsRole,'neutral');
});

for(const text of ['Начисление процентов по вкладу','Выплата процентов по депозиту за октябрь 2026','Зачисление процентов по накопительному счёту','Проценты на остаток','Проценты по счету'])test('FIN-T49: intact bank cash heading '+text,()=>{
 const fact=bankFact(text),before=structuredClone(fact),fresh=initialBankSemantics(fact);assert.equal(fresh.kind.value,'interest');assert.equal(fresh.kind.source,'deterministic_system_rule');assert.equal(fresh.role.value,'income');assert.deepEqual(bankInterestEvidence(fact),{role:'income',subject:'deposit'});assert.deepEqual(fact,before);assert.equal(fact.sourceKind,'other');
});
for(const text of ['Уплата процентов по кредиту','Списание процентов по займу','Проценты по кредитной карте за сентябрь'])test('FIN-T48: paid interest heading '+text,()=>{
 const fresh=initialBankSemantics(bankFact(text,'-450000'));assert.equal(fresh.kind.value,'interest');assert.equal(fresh.role.value,'expense');
});
for(const [text,amount] of [
 ['Начисление процентов по вкладу','-450000'],['Уплата процентов по кредиту','450000'],['Начисление процентов по вкладу','0'],
 ['Прогноз начисления процентов по вкладу','450000'],['Ожидается выплата процентов по вкладу','450000'],
 ['Не начисление процентов по вкладу','450000'],['Проценты по вкладу отмена','450000'],['Возврат процентов по кредиту','450000'],
 ['Выплата процентов по вкладу и возврат суммы вклада','450000'],['Проценты по кредиту и комиссия','-450000'],
 ['Книга Проценты по вкладу','-450000'],['Проценты по вкладуМагазин','450000'],['Выплата процентов по вкладу бонус','450000'],
 ['Выплата процентов по вкладу и погашение кредита','450000'],
 ['Проценты','450000'],['Т-Банк','450000'],['Перевод от Иванов Иван Иванович проценты','450000'],
] as const)test('FIN-P02/P06: insufficient or conflicting cash evidence '+text+' '+amount,()=>{
 const fact=bankFact(text,amount);assert.equal(bankInterestEvidence(fact),null);assert.equal(initialBankSemantics(fact).kind.value,'other');assert.equal(initialBankSemantics(fact).role.value,'unresolved');
});
test('FIN-P02/P11: legacy, incomplete boundaries, positive purchase and comments cannot supply interest authority',()=>{
 for(const patch of [{versions:{sourceSanitizer:'bank-source/4'}},{versions:{sourceSanitizer:'bank-source/5',sourceTextEvidence:'unknown'}},{sourceKind:'purchase' as const}])assert.equal(bankInterestEvidence({...bankFact('Проценты по вкладу'),...patch}),null);
 const o=operation(bankFact('Перевод'));o.comment='Начисление процентов по вкладу';assert.equal(initialBankSemantics(o.source).kind.value,'other');
});
test('FIN-T50: reimport refreshes only eligible facets and removes a prior inferred meaning when actual evidence is lost',()=>{
 const source=bankFact('Проценты по вкладу'),first=initialBankSemantics(source);assert.equal(refreshBankSemantics(first,source).role.value,'income');
 const lost=refreshBankSemantics(first,bankFact('Перевод'));assert.equal(lost.kind.value,'other');assert.equal(lost.role.value,'unresolved');assert.equal(lost.kind.confidence,0);
 for(const priority of ['user','personal_rule','global_rule','ai'] as const){const own=structuredClone(first);own.role=facet('neutral',priority,priority==='user');own.merchant=facet('Мои проценты',priority,priority==='user');const next=refreshBankSemantics(own,source);assert.deepEqual(next.role,own.role);assert.deepEqual(next.merchant,own.merchant);}
 const explicit=structuredClone(first);explicit.kind=facet('transfer_in','user',true);assert.deepEqual(refreshBankSemantics(explicit,source).kind,explicit.kind);
});
test('FIN-P03: own interest category resolves by role and visible parent, never the identically named expense leaf',()=>{
 const fact=bankFact('Проценты по вкладу'),o=operation(fact);o.semantics=initialBankSemantics(fact);
 const cats=[{id:'income',name:'Проценты и инвестиции',role:'income' as const,parentId:null,hidden:false},{id:'received',name:'Проценты по счетам и вкладам',role:'income' as const,parentId:'income',hidden:false},{id:'loans',name:'Кредиты и долги',role:'expense' as const,parentId:null,hidden:false},{id:'paid',name:'Проценты',role:'expense' as const,parentId:'loans',hidden:false}];
 assert.equal(applyFinancialRecognition(o,cats).semantics.subcategory.value,'received');
 const expense=operation(bankFact('Проценты по кредиту','-450000'));expense.semantics=initialBankSemantics(expense.source);assert.equal(applyFinancialRecognition(expense,cats).semantics.subcategory.value,'paid');
 assert.equal(applyFinancialRecognition(o,cats.map(c=>({...c,hidden:c.id==='income'}))).semantics.category.value,null);
 assert.equal(applyFinancialRecognition(o,[...cats,{...cats[1]!,id:'duplicate'}]).semantics.category.value,null);
 const saved=structuredClone(o);saved.semantics.category=facet('private','personal_rule');assert.deepEqual(applyFinancialRecognition(saved,cats),saved);
 const split={...o,decomposition:true};assert.equal(applyFinancialRecognition(split,cats),split);
});
