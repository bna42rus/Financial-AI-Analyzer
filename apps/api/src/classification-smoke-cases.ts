import {bankDescription} from '../../../packages/imports/src/bank-description.ts';
import {initialSemantics} from '../../../packages/finance-core/src/model.ts';
import type {Graph} from '../../../packages/finance-core/src/model.ts';
import {classificationPlan} from './classification-plan.ts';
import type {Decision} from './classification-plan.ts';

export const classificationSmokeNames=['known-merchants','taxi-without-category'] as const;
export function classificationSmokeCase(name:typeof classificationSmokeNames[number]){
 const categories=[{id:'food',name:'Продукты'},{id:'electronics',name:'Электроника'},{id:'taxi',name:'Такси'},{id:'public',name:'Общественный транспорт'},{id:'health',name:'Здоровье'},{id:'cafe',name:'Кафе и рестораны'},{id:'fuel',name:'Автомобиль'},{id:'sport',name:'Спорт'},{id:'culture',name:'Развлечения'},{id:'services',name:'Бытовые услуги'}].map(c=>({...c,role:'expense' as const,parentId:null,hidden:false}));
 const graph:Graph={accounts:[{id:'synthetic',bankId:'tbank',name:'Synthetic',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories,components:[],links:[],loanMode:'cashflow',operations:['Пятёрочка','DNS','Яндекс Go','Ozon'].map((merchant,i)=>({id:'synthetic-'+i,source:{accountId:'synthetic',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-10000',currency:'RUB',merchantText:merchant,description:'',bankCategory:'',bankRefHmac:null,versions:{}},semantics:initialSemantics('purchase',merchant),corrections:{},comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]}))};
 if(name==='taxi-without-category'){graph.categories=graph.categories.filter(c=>c.id!=='taxi');graph.operations=graph.operations.filter(o=>o.source.merchantText==='Яндекс Go');}
 else graph.operations=graph.operations.filter(o=>o.source.merchantText!=='Яндекс Go');
 const corpus=[
  ['Пятёрочка','Покупка Пятёрочка','Продукты','5411','food'],
  ['ВкусВилл','Покупка ВкусВилл','Продукты','5411','food'],
  ['DNS','Покупка DNS','Электроника','5732','electronics'],
  ['Ozon','Покупка Ozon','','5999',null],
  ['Аптека Ромашка','Покупка Аптека Ромашка','',null,'health'],
  ['Кофейня Север','Покупка Кофейня Север','',null,'cafe'],
  ['Булочная Уют','Покупка Булочная Уют','Продукты','5462','food'],
  ['Столовая Полдень','Покупка Столовая Полдень','Рестораны','5812','cafe'],
  ['Городской автобус','Покупка билета Городской автобус','Транспорт','4131','public'],
  ['АЗС Пример','Покупка АЗС Пример','Топливо','5541','fuel'],
  ['Фитнес Север','Покупка Фитнес Север','Спорт','7997','sport'],
  ['Кинотеатр Экран','Покупка Кинотеатр Экран','',null,'culture'],
  ['Ремонт обуви','Покупка Ремонт обуви','Бытовые услуги','7251','services'],
  ['Wildberries','Покупка Wildberries','','5399',null],
  ['Неизвестная точка','Покупка Неизвестная точка','',null,null],
 ] as const;
 const expectedCategories:Record<string,string|null>={};
 if(name==='known-merchants')graph.operations=corpus.map(([merchant,description,bankCategory,mcc,expected],i)=>{
  expectedCategories[merchant]=expected;
  return {...graph.operations[0]!,id:'synthetic-diverse-'+i,source:{...graph.operations[0]!.source,...bankDescription(description,merchant,bankCategory,mcc),sourceMcc:mcc,versions:{sourceSanitizer:'bank-source/4'}},semantics:initialSemantics('purchase',merchant)};
 });
 const plan=classificationPlan(graph),input={catalog:plan.catalog,operations:plan.groups.map((g,i)=>({ref:'r'+(i+1),...g.signal}))};
 if(plan.groups.length!==(name==='known-merchants'?corpus.length:1))throw Error('CLASSIFICATION_SMOKE_CASE_INCOMPLETE');
 const checks=(decisions:Decision[])=>plan.groups.map((g,i)=>({merchant:g.signal.merchant,category:decisions[i]!.categoryId,confidence:decisions[i]!.confidence}));
 const passed=(decisions:Decision[])=>checks(decisions).every(c=>{const expected=name==='taxi-without-category'?null:expectedCategories[c.merchant!];return c.category===expected&&(expected===null||c.confidence>=90);});
 return {plan,input,checks,passed,expectedCategories};
}
