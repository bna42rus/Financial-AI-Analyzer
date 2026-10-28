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
