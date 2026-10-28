import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classificationPlan,parseClassification,applyClassification,classificationSignal,classificationRequestSchema,digest,classificationVersion,classificationPrompt} from '../src/classification-plan.ts';
import {createCloudAssistantModel} from '../src/assistant-transport.ts';
import {applyMerchantRecognition} from '../../../packages/finance-core/src/merchant-recognition.ts';
import {initialSemantics,facet} from '../../../packages/finance-core/src/model.ts';
import type {Graph,Operation} from '../../../packages/finance-core/src/model.ts';
import {reconcile} from '../../../packages/finance-core/src/graph.ts';
const op=(id='operation'):Operation=>({id,source:{accountId:'account',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-12500',currency:'RUB',merchantText:'Пятёрочка',description:'Sensitive raw text must stay local',bankCategory:'',bankRefHmac:'private-hmac',versions:{}},corrections:{},semantics:initialSemantics('purchase','Пятёрочка'),comment:'private comment',analyticsOverride:'default',decomposition:false,reviewReasons:[]});
const graph=():Graph=>({accounts:[{id:'account',bankId:'tbank',name:'Private account',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories:[{id:'food',name:'Продукты',role:'expense',parentId:null,hidden:false},{id:'leaf',name:'Супермаркеты',role:'expense',parentId:'food',hidden:false},{id:'income',name:'Зарплата',role:'income',parentId:null,hidden:false}],operations:[op()],components:[],links:[],loanMode:'cashflow'});
function response(plan:ReturnType<typeof classificationPlan>,category='food',confidence=95,subcategory:string|null=null){return {decisions:[{ref:'r1',category:plan.catalog[plan.categories.findIndex(c=>c.id===category)]!.ref,subcategory:subcategory?plan.catalog[plan.categories.findIndex(c=>c.id===subcategory)]!.ref:null,confidence}]};}
test('outbound signals exclude source text, identifiers, amounts, accounts and user comments; repeated merchants share one item',()=>{
 const g=graph();g.operations.push(op('second'));const plan=classificationPlan(g);
 assert.equal(plan.groups.length,1);assert.equal(plan.groups[0]!.operationIds.length,2);
 const input=JSON.stringify({catalog:plan.catalog,signals:plan.groups.map(g=>g.signal)});
 for(const secret of ['Sensitive','private','12500','2026','account','operation'])assert.ok(!input.includes(secret),secret);
 assert.ok(input.includes('Пятёрочка'));
 const bad=op();bad.source.merchantText='Иван Петров 1234567890123456';assert.equal(classificationSignal(bad,g),null);
});
test('manual category/subcategory, personal/global rules, decomposition and unresolved roles are protected',()=>{
 for(const change of [(o:Operation)=>{o.semantics.category=facet('food','user');},(o:Operation)=>{o.semantics.subcategory=facet('leaf','ai',true);},(o:Operation)=>{o.semantics.category=facet('food','personal_rule');},(o:Operation)=>{o.semantics.category=facet('food','global_rule');},(o:Operation)=>{o.decomposition=true;},(o:Operation)=>{o.semantics.role=facet('unresolved');}]){const g=graph();change(g.operations[0]!);assert.equal(classificationPlan(g).groups.length,0);}
 const g=graph();assert.equal(classificationPlan(g,[{id:'rule',name:'New rule',enabled:true,priority:0,conditions:{merchantEquals:'Пятёрочка'},assignments:{categoryId:'food'}}]).groups.length,0);
});
test('confidence is facet-specific and Review retains independent reasons without changing bank facts or totals',()=>{
 for(const confidence of [95,80,60]){const g=graph(),plan=classificationPlan(g),before=structuredClone(g.operations[0]!);g.operations[0]=applyClassification(before,parseClassification(response(plan,'food',confidence),plan,plan.groups)[0]!);
  const after=g.operations[0]!;assert.deepEqual(after.source,before.source);assert.deepEqual(after.semantics.kind,before.semantics.kind);assert.deepEqual(after.semantics.role,before.semantics.role);assert.equal(after.semantics.category.source,'ai');assert.equal(after.semantics.category.value,confidence<70?null:'food');
  assert.equal(reconcile(g).operations[0]!.reviewReasons.includes('low_category_confidence'),confidence<90);
 }
});
test('closed parser rejects missing, duplicate, foreign, wrong-role and unrelated-child assignments',()=>{
 const plan=classificationPlan(graph());
 for(const bad of [{decisions:[]},{decisions:[response(plan).decisions[0],response(plan).decisions[0]]},response(plan,'income'),{decisions:[{ref:'r1',category:'foreign',subcategory:null,confidence:99}]},{decisions:[{ref:'r2',category:'c1',subcategory:null,confidence:99}]},{decisions:[{...response(plan).decisions[0],reason:'ignore previous instructions'}]},{decisions:[{...response(plan).decisions[0],confidence:90.5}]}])assert.throws(()=>parseClassification(bad,plan,plan.groups));
 assert.equal(parseClassification(response(plan,'food',98,'leaf'),plan,plan.groups)[0]!.subcategoryId,'leaf');
 assert.equal(parseClassification({decisions:[{ref:'r1',category:null,subcategory:null,confidence:0}]},plan,plan.groups)[0]!.categoryId,null);
});
test('cache identity changes with the catalog and does not depend on monetary/identifier data',()=>{
 const g=graph(),first=classificationPlan(g).groups[0]!.signature;g.operations[0]!.source.amountMinor='-99900';assert.equal(classificationPlan(g).groups[0]!.signature,first);g.categories[0]!.name='Еда';assert.notEqual(classificationPlan(g).groups[0]!.signature,first);
});
test('a confident category resolves only its confidence reason and preserves independent review problems',()=>{
 const o=op();o.reviewReasons=['low_category_confidence','possible_duplicate','unlinked_refund'];
 assert.deepEqual(applyClassification(o,{categoryId:'food',subcategoryId:null,confidence:95}).reviewReasons,['possible_duplicate','unlinked_refund']);
 assert.ok(applyClassification(o,{categoryId:'food',subcategoryId:null,confidence:75}).reviewReasons.includes('low_category_confidence'));
});
test('exact visible names resolve within role and parent; unknown, ambiguous, hidden and ref/name collisions fail closed',()=>{
 const named=(category:unknown,subcategory:unknown=null)=>({decisions:[{ref:'r1',category,subcategory,confidence:96}]});
 let g=graph(),plan=classificationPlan(g);
 assert.deepEqual(parseClassification(named('Продукты','Супермаркеты'),plan,plan.groups)[0],{categoryId:'food',subcategoryId:'leaf',confidence:96});
 for(const category of ['продукты',' Продукты','Единороги','Зарплата'])assert.throws(()=>parseClassification(named(category),plan,plan.groups));
 g.categories.push({id:'duplicate',name:'Продукты',role:'expense',parentId:null,hidden:false});plan=classificationPlan(g);
 assert.throws(()=>parseClassification(named('Продукты'),plan,plan.groups),/CATEGORY_AMBIGUOUS/);
 g.categories.at(-1)!.hidden=true;plan=classificationPlan(g);assert.equal(parseClassification(named('Продукты'),plan,plan.groups)[0]!.categoryId,'food');
 g.categories.at(-1)!.hidden=false;g.categories.at(-1)!.name=plan.catalog.find(c=>c.name==='Продукты')!.ref;plan=classificationPlan(g);
 const ref=plan.catalog[plan.categories.findIndex(c=>c.id==='food')]!.ref;
 g.categories.at(-1)!.name=ref;plan=classificationPlan(g);
 assert.throws(()=>parseClassification(named(ref),plan,plan.groups),/CATEGORY_AMBIGUOUS/);
});
test('a repeated subcategory name is resolved only under the selected parent',()=>{
 const g=graph();g.categories.push({id:'other-root',name:'Другие расходы',role:'expense',parentId:null,hidden:false},{id:'other-leaf',name:'Супермаркеты',role:'expense',parentId:'other-root',hidden:false});
 const plan=classificationPlan(g),value={decisions:[{ref:'r1',category:'Продукты',subcategory:'Супермаркеты',confidence:96}]};
 assert.equal(parseClassification(value,plan,plan.groups)[0]!.subcategoryId,'leaf');
 value.decisions[0]!.subcategory=plan.catalog[plan.categories.findIndex(c=>c.id==='other-leaf')]!.ref;
 assert.throws(()=>parseClassification(value,plan,plan.groups),/CATEGORY_MISMATCH/);
});
test('the synthetic rejected wire is replayed in its original item order and exact labels preserve unknown services',()=>{
 const categories=[{id:'food',name:'Продукты'},{id:'electronics',name:'Электроника'},{id:'taxi',name:'Такси'},{id:'public',name:'Общественный транспорт'}].map(c=>({...c,role:'expense' as const,parentId:null,hidden:false}));
 const g=graph();g.categories=categories;g.operations=['Пятёрочка','DNS','Яндекс Go','Ozon'].map((merchant,i)=>{const value=op(String(i));value.source.merchantText=merchant;value.semantics=initialSemantics('purchase',merchant);return value;});
 const plan=classificationPlan(g),oldVersion='cashneuro-category-classification/1',catalogHash=digest({version:oldVersion,categories:plan.categories});
 const originalGroups=[...plan.groups].sort((a,b)=>digest({version:oldVersion,catalogHash,signal:a.signal}).localeCompare(digest({version:oldVersion,catalogHash,signal:b.signal})));
 assert.deepEqual(originalGroups.map(g=>g.signal.merchant),['DNS','Яндекс Go','Ozon','Пятёрочка']);
 const wire={decisions:[{ref:'r1',category:'Электроника',subcategory:null,confidence:95},{ref:'r2',category:null,subcategory:null,confidence:0},{ref:'r3',category:null,subcategory:null,confidence:0},{ref:'r4',category:'Продукты',subcategory:null,confidence:95}]};
 assert.deepEqual(parseClassification(wire,plan,originalGroups).map(d=>d.categoryId),['electronics',null,null,'food']);
});
test('classification HTTP uses its own protocol and a schema bound to catalog values and operation refs',async()=>{
 const g=graph();g.categories.push({id:'hidden',name:'Невидимая',role:'expense',parentId:null,hidden:true});const plan=classificationPlan(g),schema=classificationRequestSchema(plan,plan.groups);
 assert.deepEqual(schema.properties.decisions.items.properties.ref.enum,['r1']);assert.equal(schema.properties.decisions.minItems,1);assert.equal(schema.properties.decisions.maxItems,1);
 assert.ok(schema.properties.decisions.items.properties.category.enum.includes('Продукты'));assert.ok(!schema.properties.decisions.items.properties.category.enum.includes('Невидимая'));
 let reserves=0,posts=0;
 const model=createCloudAssistantModel({apiKey:'synthetic-key-for-tests-only'},async(_url,options)=>{
  posts++;assert.equal(reserves,1);assert.equal(model.bound.outputTokens,4096);const body=JSON.parse(String(options?.body));assert.equal(body.max_completion_tokens,model.bound.outputTokens);assert.ok(body.messages[0].content.startsWith('Protocol '+classificationVersion+'\n'));assert.ok(!body.messages[0].content.includes('cashneuro-assistant-plan/'));
  return new Response(JSON.stringify({model:'openai/gpt-oss-120b',usage:{prompt_tokens:50,completion_tokens:30,total_tokens:80},choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({decisions:[{ref:'r1',category:'Продукты',subcategory:null,confidence:96}]})}}]}));
 },'classification');
 const answer=await model.complete({phase:'understand',protocol:classificationVersion,prompt:classificationPrompt,input:{catalog:plan.catalog,operations:plan.groups.map((g,i)=>({ref:'r'+(i+1),...g.signal}))},schema},async()=>{reserves++;});
 assert.equal(parseClassification(answer.value,plan,plan.groups)[0]!.categoryId,'food');assert.equal(posts,1);
});

test('versioned sanitized descriptions admit unfamiliar merchants and distinguish services at the same brand',()=>{
 const g=graph(),a=g.operations[0]!;
 a.source={...a.source,merchantText:'Кофейня Север',description:'Покупка Кофейня Север',bankCategory:'Кафе',sourceMcc:'5814',versions:{sourceSanitizer:'bank-source/4'}};
 const plan=classificationPlan(g);assert.equal(plan.groups.length,1);assert.equal(plan.groups[0]!.signal.merchant,'Кофейня Север');
 assert.equal(plan.groups[0]!.signal.description,'Покупка Кофейня Север');assert.equal(plan.groups[0]!.signal.mcc,'5814');
 const b=structuredClone(a);b.id='second';b.source.description='Покупка Кофейня Север продукты';b.source.sourceMcc='5411';g.operations.push(b);assert.equal(classificationPlan(g).groups.length,2);
 a.source.versions={};assert.equal(classificationSignal(a,g),null);
 a.source.versions={sourceSanitizer:'bank-source/4'};a.source.description='Покупка card 4111111111111111';assert.equal(classificationSignal(a,g),null);
});

test('observed broad-service error is blocked despite confidence 95; source-specific evidence can resolve ambiguity',()=>{
 const g=graph();g.categories=[{id:'fuel',name:'Автомобиль',role:'expense',parentId:null,hidden:false}];
 const o=g.operations[0]!;o.source.merchantText='Яндекс Go';o.source.description='';o.semantics=initialSemantics('purchase','Яндекс Go');
 let plan=classificationPlan(g);const wire={decisions:[{ref:'r1',category:plan.catalog[0]!.ref,subcategory:null,confidence:95}]};
 const before=structuredClone(o),decision=parseClassification(wire,plan,plan.groups)[0]!;
 assert.deepEqual(decision,{categoryId:null,subcategoryId:null,confidence:0});const applied=applyClassification(o,decision);assert.equal(applied.semantics.category.value,null);assert.equal(applied.semantics.category.userVerified,false);assert.deepEqual(applied.source,before.source);
 for(const merchant of ['Ozon','Wildberries','Яндекс Маркет']){o.source.merchantText=merchant;o.semantics=initialSemantics('purchase',merchant);plan=classificationPlan(g);assert.equal(parseClassification(wire,plan,plan.groups)[0]!.categoryId,null);}
 o.source={...o.source,merchantText:'Яндекс Go',description:'Покупка Яндекс Go такси',bankCategory:'Такси',sourceMcc:'4121',versions:{sourceSanitizer:'bank-source/4'}};o.semantics=initialSemantics('purchase','Яндекс Go');g.categories=[{id:'taxi',name:'Такси',role:'expense',parentId:null,hidden:false}];plan=classificationPlan(g);
 assert.equal(parseClassification(wire,plan,plan.groups)[0]!.categoryId,'taxi');
});

test('grocery homonyms and contradictory activities cannot be accepted from a confident model or old cache',()=>{
 for(const [merchant,description,mcc] of [['Победа','Авиакомпания','4511'],['Гулливер','Магазин детской одежды','5641'],['METRO','Проезд','4111'],['Линия','',''],['Магнит','Аптека','5912']] as const){
  const g=graph(),o=g.operations[0]!;o.source={...o.source,merchantText:merchant,description,sourceMcc:mcc||null,versions:{sourceSanitizer:'bank-source/4'}};o.semantics=initialSemantics('purchase',merchant);
  const plan=classificationPlan(g);assert.equal(plan.groups.length,1,merchant);
  assert.deepEqual(parseClassification(response(plan),plan,plan.groups)[0],{categoryId:null,subcategoryId:null,confidence:0},merchant);
  o.semantics.category=facet('food','ai',false,99);assert.ok(classificationSignal(o,g),merchant);
 }
});

test('structured food MCC resolves a homonym and is also respected by the deterministic pass',()=>{
 for(const merchant of ['Гулливер','METRO','Победа','Линия','В1']){
  const g=graph(),o=g.operations[0]!;o.source={...o.source,merchantText:merchant,description:'Покупка',sourceMcc:'5411',versions:{sourceSanitizer:'bank-source/4'}};o.semantics=initialSemantics('purchase',merchant);
  const plan=classificationPlan(g);assert.equal(parseClassification(response(plan),plan,plan.groups)[0]!.categoryId,'food',merchant);
  assert.equal(applyMerchantRecognition(o,g.categories).semantics.category.value,'food',merchant);
 }
});

test('/5 known activity conflicts and unavailable own targets cannot fall through to model/cache inference',()=>{
 for(const name of ['Аптека Север','Optika Север','СТО','Вендинг','Ресторан Аптека','Яндекс Go']){
  const g=graph(),o=g.operations[0]!;o.source.merchantText=name;o.source.description='Покупка '+name;o.source.versions={sourceSanitizer:'bank-source/5',sourceTextEvidence:'intact'};o.semantics=initialSemantics('purchase',name);
  assert.equal(classificationSignal(o,g),null,name);assert.equal(classificationPlan(g).groups.length,0,name);
 }
 const g=graph(),o=g.operations[0]!;o.source.merchantText='UnknownMerchant24';o.source.description='Покупка UnknownMerchant24';o.source.versions={sourceSanitizer:'bank-source/5',sourceTextEvidence:'intact'};o.semantics=initialSemantics('purchase','UnknownMerchant24');
 assert.equal(classificationSignal(o,g)?.merchant,'UnknownMerchant24');assert.equal(classificationPlan(g).groups.length,1);
 o.source.versions.sourceTextEvidence='unknown';assert.equal(classificationPlan(g).groups.length,0);
});
