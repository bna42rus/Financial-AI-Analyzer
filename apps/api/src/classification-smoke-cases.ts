import {initialSemantics} from '../../../packages/finance-core/src/model.ts';
import type {Graph} from '../../../packages/finance-core/src/model.ts';
import {classificationPlan} from './classification-plan.ts';
import type {Decision} from './classification-plan.ts';

export const classificationSmokeNames=['known-merchants','taxi-without-category'] as const;
export function classificationSmokeCase(name:typeof classificationSmokeNames[number]){
 const categories=[{id:'food',name:'Продукты'},{id:'electronics',name:'Электроника'},{id:'taxi',name:'Такси'},{id:'public',name:'Общественный транспорт'}].map(c=>({...c,role:'expense' as const,parentId:null,hidden:false}));
 const graph:Graph={accounts:[{id:'synthetic',bankId:'tbank',name:'Synthetic',type:'bank_account',analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories,components:[],links:[],loanMode:'cashflow',operations:['Пятёрочка','DNS','Яндекс Go','Ozon'].map((merchant,i)=>({id:'synthetic-'+i,source:{accountId:'synthetic',operationDate:{precision:'day',date:'2026-10-01'},postedDate:null,amountMinor:'-10000',currency:'RUB',merchantText:merchant,description:'',bankCategory:'',bankRefHmac:null,versions:{}},semantics:initialSemantics('purchase',merchant),corrections:{},comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]}))};
 if(name==='taxi-without-category'){graph.categories=graph.categories.filter(c=>c.id!=='taxi');graph.operations=graph.operations.filter(o=>o.source.merchantText==='Яндекс Go');}
 else graph.operations=graph.operations.filter(o=>o.source.merchantText!=='Яндекс Go');
 const plan=classificationPlan(graph),input={catalog:plan.catalog,operations:plan.groups.map((g,i)=>({ref:'r'+(i+1),...g.signal}))};
 const checks=(decisions:Decision[])=>plan.groups.map((g,i)=>({merchant:g.signal.merchant,category:decisions[i]!.categoryId,confidence:decisions[i]!.confidence}));
 const passed=(decisions:Decision[])=>checks(decisions).every(c=>{const expected=name==='taxi-without-category'?null:({'Пятёрочка':'food',DNS:'electronics',Ozon:null} as Record<string,string|null>)[c.merchant!];return c.category===expected&&(expected===null||c.confidence>=90);});
 return {plan,input,checks,passed};
}
