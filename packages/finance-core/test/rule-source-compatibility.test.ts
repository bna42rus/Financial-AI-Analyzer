import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractSafeSource,sourceFields,descriptionSourceSanitizer,merchantSourceSanitizer,merchantNames} from '../../imports/src/safe-source.ts';
import {recognizeMerchant,applyMerchantRecognition} from '../src/merchant-recognition.ts';
import {ruleMatches,applyRules} from '../src/rules.ts';
import type {Rule} from '../src/rules.ts';
import {initialSemantics,facet} from '../src/model.ts';
import type {Operation,Account} from '../src/model.ts';
const account:Account={id:'synthetic-account',bankId:'other',name:'Синтетика',type:'debit_card',analyticsEnabled:true,defaultVisible:true,loanMode:null};
const op=(raw:string,profile:typeof descriptionSourceSanitizer|typeof merchantSourceSanitizer):Operation=>{
 const fields=sourceFields(extractSafeSource(raw,'-10000',profile),profile),merchant=profile===descriptionSourceSanitizer?recognizeMerchant(fields.merchantText,fields.description).name:fields.merchantText;
 return {id:'synthetic',source:{accountId:account.id,operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-10000',currency:'RUB',...fields,bankCategory:'',bankRefHmac:null,versions:{sourceSanitizer:profile,...(profile===merchantSourceSanitizer?{sourceTextEvidence:'intact'}:{})}},corrections:{},semantics:initialSemantics('purchase',merchant),comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]};
};
const rule=(conditions:Rule['conditions']):Rule=>({id:'private-rule',name:'Личное правило',enabled:true,priority:1,conditions,assignments:{categoryId:'private-category'}});
const merchants=['OZON','WILDBERRIES','PYATEROCHKA','MAGNIT','PEREKRESTOK','LENTA','VKUSVILL','AUCHAN','METRO','DIXY','FIX PRICE','SAMOKAT','LAMODA','DNS','MVIDEO','SPORTMASTER','HOFF','LEROY MERLIN','YANDEX MARKET','YANDEX TAXI','WORLD CLASS','XFIT','Timeweb.cloud','Unknown24','Пятёрочка','Магнит Косметик'];
test('/5 private merchant predicates have the same truth table as frozen /4 for old merchant initializers',()=>{
 const needles=[...Object.values(merchantNames),'Пятёроч','pyaterochka','PYATEROCHKA MOSCOW','Москва','Moscow','TimeWeb','таймвэб','World Class','XFIT','Unknown24','Незнакомый'];let checked=0;
 for(const merchant of merchants){const raw='Покупка '+merchant+' MOSCOW RUS',old=op(raw,descriptionSourceSanitizer),next=op(raw,merchantSourceSanitizer),before=structuredClone(next);
  for(const value of needles)for(const predicate of ['merchantContains','merchantEquals']as const){const r=rule({[predicate]:value});assert.equal(ruleMatches(next,account,r),ruleMatches(old,account,r),merchant+':'+predicate+':'+value);checked++;}
  assert.deepEqual(next,before);assert.equal(next.source.merchantText,merchant+' MOSCOW RUS');
 }assert.equal(checked,1612);
});
test('a private Cyrillic contains rule applies to Latin /5 source without a source/name/category rewrite',()=>{
 const next=op('Покупка PYATEROCHKA MOSCOW RUS',merchantSourceSanitizer),before=structuredClone(next),after=applyMerchantRecognition(applyRules(next,account,[rule({merchantContains:'Пятёрочка'})]),[]);
 assert.equal(after.semantics.category.value,'private-category');assert.equal(after.semantics.category.source,'personal_rule');assert.deepEqual(after.source,before.source);assert.deepEqual(after.semantics.merchant,before.semantics.merchant);assert.deepEqual(next,before);
});
test('manual, private, verified and AI merchant names use their current value; no compatibility override',()=>{
 for(const source of ['user','personal_rule','global_rule','ai']as const){const changed=op('Покупка PYATEROCHKA MOSCOW RUS',merchantSourceSanitizer);changed.semantics.merchant=facet('Личный24',source);
  assert.equal(ruleMatches(changed,account,rule({merchantContains:'Пятёрочка'})),false);assert.equal(ruleMatches(changed,account,rule({merchantContains:'Личный24'})),true);
 }
 const unknown=op('Покупка PYATEROCHKA',merchantSourceSanitizer);unknown.source.versions.sourceTextEvidence='unknown';assert.equal(ruleMatches(unknown,account,rule({merchantContains:'Пятёрочка'})),false);
});
test('compatibility uses bank amount, not effective correction, and does not reinterpret private description predicates',()=>{
 const next=op('Покупка PYATEROCHKA MOSCOW RUS',merchantSourceSanitizer);next.corrections.amountMinor='100';
 assert.equal(ruleMatches(next,account,rule({merchantContains:'Пятёрочка'})),true);assert.equal(ruleMatches(next,account,rule({descriptionContains:'PYATEROCHKA'})),true);assert.equal(ruleMatches(next,account,rule({descriptionContains:'Пятёрочка'})),false);
});
test('SAMOKAT matches the bank merchant in either alphabet and never replaces a manually named shop',()=>{
 const operation=op('Покупка SAMOKAT SANKT-PETERBU RUS',merchantSourceSanitizer);
 for(const value of ['SAMOKAT','Самокат'])assert.equal(ruleMatches(operation,account,rule({merchantContains:value})),true);
 assert.equal(ruleMatches(operation,account,rule({descriptionContains:'SAMOKAT'})),true);
 operation.semantics.merchant=facet('Мой магазин','user',true);
 assert.equal(ruleMatches(operation,account,rule({merchantContains:'SAMOKAT'})),false);
 assert.equal(ruleMatches(operation,account,rule({descriptionContains:'SAMOKAT'})),true);
});
test('the same rule checks all conditions and historical scope applies only its winning assignments',()=>{
 const operation=op('Покупка SAMOKAT SANKT-PETERBU RUS',merchantSourceSanitizer);
 operation.bankCounterpartyId='receiver';operation.semantics.counterparty=facet('previous');
 const conditions:Rule['conditions']={merchantEquals:'Самокат',merchantContains:'SAMOKAT',descriptionContains:'SANKT',accountId:account.id,bankId:account.bankId,counterpartyId:'previous',counterpartyBankIdentity:true,kind:'purchase',direction:'out',amountFromMinor:'-10000',amountThroughMinor:'-10000',currency:'RUB'};
 const selected:Rule={...rule(conditions),assignments:{categoryId:'new-root',counterpartyId:'receiver',analyticsOverride:'exclude'}};
 assert.equal(ruleMatches(operation,account,selected),true);
 for(const different of [{merchantEquals:'Озон'},{merchantContains:'Озон'},{descriptionContains:'Different'},{accountId:'other'},{bankId:'tbank'},{counterpartyId:'other'},{kind:'other'},{direction:'in'},{amountFromMinor:'-9999'},{amountThroughMinor:'-10001'}] as const){
  assert.equal(ruleMatches(operation,account,{...selected,conditions:{...conditions,...different}}),false);
 }
 assert.equal(ruleMatches({...operation,bankCounterpartyId:'other'},account,selected),false);
 const other:Rule={...rule({direction:'out'}),id:'other',priority:100,assignments:{categoryId:'other-root',role:'neutral',merchant:'Другой магазин'}};
 const categories=[{id:'new-root',name:'Новая',parentId:null,role:'expense',hidden:false},{id:'other-root',name:'Старая',parentId:null,role:'expense',hidden:false},{id:'old-child',name:'Старая подкатегория',parentId:'other-root',role:'expense',hidden:false}] as const;
 operation.semantics.category=facet('other-root');operation.semantics.subcategory=facet('old-child');
 const scoped=applyRules(operation,account,[selected,other],selected.id,categories);
 assert.equal(scoped.semantics.category.value,'new-root');assert.equal(scoped.semantics.subcategory.value,null);
 assert.equal(scoped.semantics.role.value,'expense');assert.deepEqual(scoped.semantics.merchant,operation.semantics.merchant);
 assert.equal(scoped.semantics.counterparty.value,'receiver');assert.equal(scoped.analyticsOverride,'exclude');
 assert.equal(applyRules(operation,account,[selected,other],undefined,categories).semantics.merchant.value,'Другой магазин');
 const higher:Rule={...selected,id:'higher',priority:2,assignments:{categoryId:'other-root',counterpartyId:'receiver'}};
 assert.equal(applyRules(operation,account,[selected,higher],selected.id,categories).semantics.category.value,'other-root');
 assert.equal(applyRules(operation,account,[selected,{...higher,enabled:false}],selected.id,categories).semantics.category.value,'new-root');
 assert.ok(applyRules(operation,account,[selected,{...higher,priority:1}],selected.id,categories).reviewReasons.includes('conflicting_rules'));
 operation.semantics.subcategory=facet('old-child','user',true);
 const protectedResult=applyRules(operation,account,[selected,other],selected.id,categories);
 assert.equal(protectedResult.semantics.category.value,'other-root');assert.equal(protectedResult.semantics.subcategory.value,'old-child');
});
