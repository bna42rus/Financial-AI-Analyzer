import {facet} from '../../../finance-core/src/model.ts';
import type {OperationRow} from '../../../finance-core/src/operations.ts';
export const id=(n:number)=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
export const scope={ownerId:'synthetic-owner',chatId:id(1),chatEpoch:id(2),generation:id(3)};
export const account=id(4),food=id(5),taxi=id(6);
export const catalog={accounts:[{id:account,name:'Учебный счёт',bankId:'tbank',type:'bank_account' as const,analyticsEnabled:true,defaultVisible:true,loanMode:null}],
 categories:[{id:food,name:'Продукты',parentId:null,role:'expense' as const,hidden:false},{id:taxi,name:'Такси',parentId:null,role:'expense' as const,hidden:false}],counterparties:[]};
function row(n:number,date:string,categoryId:string,amountMinor:string):OperationRow{
 return {id:id(n),date:{precision:'day',date},accountId:account,amountMinor,analyticsRole:'expense',decompositionActive:false,reviewReasons:[],unresolvedMinor:'0',neutralMinor:'0',excludedMinor:'0',
  parts:[{id:id(n+100),componentId:null,allocationId:null,amountMinor,role:'expense',categoryId,subcategoryId:null,basis:[],included:true}],
  classification:{kind:facet('purchase'),role:facet('expense'),category:facet(categoryId),subcategory:facet(null),merchant:facet('Учебный магазин'),counterparty:facet(null)},comment:''};
}
export const rows=[row(10,'2025-09-10',food,'-10000'),row(11,'2025-09-11',taxi,'-2000'),row(12,'2025-10-10',food,'-15000'),row(13,'2025-10-11',taxi,'-1800')];
