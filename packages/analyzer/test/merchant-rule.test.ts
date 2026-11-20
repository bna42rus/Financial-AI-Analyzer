import {test} from 'node:test';
import assert from 'node:assert/strict';
import {merchantRuleDraft} from '../src/merchant-rule.ts';
import {ruleMatches} from '../../finance-core/src/rules.ts';
import {initialSemantics} from '../../finance-core/src/model.ts';
import type {Category,Operation,Account} from '../../finance-core/src/model.ts';
const categories:Category[]=[{id:'food',name:'Продукты',parentId:null,role:'expense',hidden:false},{id:'other',name:'Прочие продукты',parentId:'food',role:'expense',hidden:false}];
test('only an explicit future instruction proposes an editable rule; one-row confirmation is not a rule',()=>{
 assert.equal(merchantRuleDraft('Это продукты',categories),null);assert.equal(merchantRuleDraft('Подтверждаю вендинг',categories),null);
 const rule=merchantRuleDraft('Весь вендинг относить к продуктам',categories);assert.ok(rule);assert.equal(rule.assignments.categoryId,'food');
 assert.equal(merchantRuleDraft('Весь вендинг относить к Продукты → Прочие продукты',categories)?.assignments.subcategoryId,'other');
 assert.equal(merchantRuleDraft('Все SPAR относить к продуктам',categories)?.conditions.merchantEquals,'SPAR');
 assert.equal(merchantRuleDraft('Все расходы относить к продуктам',categories),null);assert.equal(merchantRuleDraft('Весь вендинг относить к Единороги',categories),null);
 assert.equal(merchantRuleDraft('Весь вендинг относить к Продукты',categories.map(c=>({...c,hidden:true}))),null);
});
test('vending scope covers both alphabets and compounds; merchant rules survive normalized branch names',()=>{
 const rule={...merchantRuleDraft('Весь вендинг относить к продуктам',categories)!,id:'rule'},account:Account={id:'account',bankId:'tbank',name:'Счёт',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null};
 const op:Operation={id:'op',source:{accountId:'account',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-100',currency:'RUB',merchantText:'',description:'',bankCategory:'',bankRefHmac:null,versions:{}},corrections:{},semantics:initialSemantics('purchase'),comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};
 for(const text of ['Покупка ВипВендинг','Покупка VIPVENDING','Покупка VENDING']){op.source.description=text;assert.equal(ruleMatches(op,account,rule),true,text);}
 op.source.description='Покупка магазина';assert.equal(ruleMatches(op,account,rule),false);
 const shop={...rule,conditions:{merchantEquals:'SPAR'}};op.semantics.merchant.value='SPAR';assert.equal(ruleMatches(op,account,shop),true);op.semantics.merchant.value='SPARK';assert.equal(ruleMatches(op,account,shop),false);
 op.semantics.merchant.value='SPAR';assert.equal(ruleMatches(op,account,{...shop,conditions:{merchantEquals:'SPAR 349 Moscow Rus'}}),false);
});

test('the owner-approved TimeWeb display spelling preserves an existing personal rule using the earlier name',()=>{
 const account:Account={id:'account',bankId:'tbank',name:'Счёт',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null};
 const op:Operation={id:'op',source:{accountId:'account',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-100',currency:'RUB',merchantText:'timeweb.cloud',description:'Покупка timeweb.cloud',bankCategory:'',bankRefHmac:null,versions:{}},corrections:{},semantics:initialSemantics('purchase','TimeWeb'),comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};
 const rule={id:'rule',name:'Старое правило',enabled:true,priority:100,conditions:{merchantEquals:'Таймвэб'},assignments:{categoryId:'services'}};
 assert.equal(ruleMatches(op,account,rule),true);assert.equal(ruleMatches(op,account,{...rule,conditions:{merchantContains:'Таймвэб'}}),true);
});
