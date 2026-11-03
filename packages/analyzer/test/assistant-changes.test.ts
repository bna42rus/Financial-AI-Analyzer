import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileAssistantChange,parseAssistantChange} from '../src/assistant-changes.ts';
import type {ChangeCatalog} from '../src/assistant-changes.ts';
import {calculatorRublesMinor} from '../src/calculators.ts';
const id=(n:number)=>`10000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const catalog:ChangeCatalog={accounts:[{id:id(1),name:'Личная карта'}],categories:[{id:id(2),name:'Еда',role:'expense',parentId:null},{id:id(3),name:'Доставка',role:'expense',parentId:id(2)},{id:id(4),name:'Архив',role:'expense',parentId:null,hidden:true}],counterparties:[{id:id(5),name:'Алексей'}],rules:[{id:id(6),name:'Моё правило',enabled:true,priority:25,conditions:{merchantEquals:'Ozon'},assignments:{categoryId:id(2)}}],budgets:[{id:id(7),name:'Бюджет еды'}]};
const options={newId:id(8),sourceAnswerId:id(9),operationIds:[id(10),id(11)],parseRubles:calculatorRublesMinor};
const compile=(v:unknown,c=catalog,o=options)=>compileAssistantChange(v,c,o);
test('names resolve uniquely in the supplied own catalog; a guessed UUID is never accepted',()=>{
 assert.equal(compile({kind:'account',name:'ЛИЧНАЯ КАРТА',patch:{name:'Рабочая карта'}}).intent.id,id(1));
 assert.throws(()=>compile({kind:'account',name:'Чужой счёт',patch:{analyticsEnabled:false}}),/NEEDS_CHOICE/);
 assert.throws(()=>compile({kind:'account',name:'Личная карта',patch:{name:'Новая'}},{...catalog,accounts:[...catalog.accounts,{id:id(20),name:'Личная карта'}]}),/NEEDS_CHOICE/);
 assert.throws(()=>parseAssistantChange({kind:'account',name:'Личная карта',id:id(1),patch:{name:'Новая'}}),/CHANGE_INVALID/);
});
test('empty patches, arbitrary SQL, credentials, deletion and broadened operation selectors are closed out',()=>{
 for(const v of [{kind:'sql',sql:'SELECT 1'},{kind:'set_password',name:'x'},{kind:'delete_financial',all:true},{kind:'account',name:'Личная карта',patch:{}},{kind:'account',name:'Личная карта',patch:{email:'x'}},{kind:'answer_operations',patch:{comment:'x'},operationIds:[id(1)]},{kind:'answer_operations',patch:{subcategoryName:'Доставка'}}])assert.throws(()=>parseAssistantChange(v),/CHANGE_INVALID/);
});
test('creating categories uses an explicit role, real own parent and no hidden-node resurrection',()=>{
 assert.deepEqual(compile({kind:'create_category',name:'Перекусы',role:'expense',parentName:'Еда'}).intent,{kind:'category',id:id(8),create:true,patch:{name:'Перекусы',role:'expense',parentId:id(2),hidden:false}});
 for(const v of [{kind:'create_category',name:'Архив',role:'expense'},{kind:'create_category',name:'Доставка',role:'expense',parentName:'Еда'},{kind:'create_category',name:'Зарплата',role:'income',parentName:'Еда'}])assert.throws(()=>compile(v),/NEEDS_CHOICE/);
 assert.equal(compile({kind:'category',name:'Архив',patch:{hidden:false}}).intent.id,id(4));
});
test('operation changes contain only immutable last-answer IDs and exact category hierarchy',()=>{
 const before=structuredClone(catalog),proposal=compile({kind:'answer_operations',patch:{categoryName:'Еда',subcategoryName:'Доставка',inclusion:'exclude'}});
 assert.deepEqual(proposal.intent,{kind:'bulk_operations',operationIds:[id(10),id(11)],patch:{categoryId:id(2),subcategoryId:id(3),analyticsOverride:'exclude'}});
 assert.equal(proposal.sourceAnswerId,id(9));assert.deepEqual(catalog,before);
 for(const op of [{...options,operationIds:[]},{...options,sourceAnswerId:null},{...options,operationIds:Array.from({length:1001},(_,i)=>id(i+100))}])assert.throws(()=>compile({kind:'answer_operations',patch:{comment:'Мой комментарий'}},catalog,op as typeof options),/SCOPE_REQUIRED/);
 const one=compile({kind:'answer_operations',patch:{role:'neutral'}},catalog,{...options,operationIds:[id(10)]});assert.equal(one.intent.kind,'operation');assert.equal(one.intent.id,id(10));
});
test('rule enable uses saved conditions, while historical application requires explicit fixed scope',()=>{
 const a=compile({kind:'rule',name:'Моё правило',enabled:false});const {id:ruleId,...patch}=catalog.rules[0]!;assert.equal(a.intent.id,ruleId);assert.deepEqual(a.intent.patch,{...patch,enabled:false});assert.equal(a.sourceAnswerId,null);const b=compile({kind:'apply_rule',name:'Моё правило'});assert.deepEqual(b.intent,{kind:'apply_rules',ruleId,operationIds:options.operationIds});
});
test('budget rubles are converted by exact code and the period choice is mandatory',()=>{
 assert.deepEqual(compile({kind:'budget_limit',name:'Бюджет еды',amountRubles:'12 345,67',applyFrom:'next'}).intent,{kind:'set_budget_limit',id:id(7),limitMinor:'1234567',applyFrom:'next'});
 assert.throws(()=>compile({kind:'budget_limit',name:'Бюджет еды',amountRubles:'10000'}),/CHANGE_INVALID/);
});
test('catalog additions and own bindings use finite keys and owned root/leaf IDs',()=>{
 assert.deepEqual(compile({kind:'add_catalog_categories',keys:['powerbank','optics']}).intent,{kind:'add_catalog_categories',keys:['powerbank','optics']});
 const p=compile({kind:'category_binding',targetKey:'grocery',categoryName:'Еда',subcategoryName:'Доставка'});assert.equal(p.intent.categoryId,id(2));assert.equal(p.intent.subcategoryId,id(3));
 assert.throws(()=>compile({kind:'category_binding',targetKey:'arbitrary',categoryName:'Еда'}),/CHANGE_INVALID/);
});
