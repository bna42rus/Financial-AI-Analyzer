import type {Component,Link,Role} from '../../../packages/finance-core/src/model';
import type {Projection} from '../../../packages/finance-core/src/graph';
import type {FinanceDetail} from './finance-client';
import {minorToRubles,rublesToMinor} from './finance-client';

export const componentNames:Record<Component['type'],string>={principal:'Основной долг',interest:'Проценты',fee:'Комиссия',insurance:'Страхование',other:'Другая часть'};
export const linkNames:Record<Link['kind'],string>={refund:'Возврат покупки',own_transfer:'Перевод между своими счетами',expense_reimbursement:'Компенсация расхода',reversal:'Отмена операции',credit_card_repayment:'Погашение кредитной карты',debt_repayment:'Возврат долга'};
export const linkStatusNames:Record<Link['status'],string>={confirmed:'Подтверждена',candidate:'Предполагаемая',rejected:'Отклонена'};
export type PartWrite={id:string;type:Component['type'];amountMinor:string;role?:Role;categoryId?:string|null;subcategoryId?:string|null};
export type RelationIntent={kind:'components';id:string;parts:PartWrite[]}|{kind:'link';id:string;link:Omit<Link,'id'|'confidence'|'createdBy'>};
export type ComponentDraft={id:string;type:Component['type'];amount:string;role:Role|'auto';categoryId:string|null;subcategoryId:string|null;categoryConfirmed:boolean;subcategoryConfirmed:boolean};
export function newComponent():ComponentDraft{return {id:crypto.randomUUID(),type:'other',amount:'',role:'auto',categoryId:null,subcategoryId:null,categoryConfirmed:false,subcategoryConfirmed:false};}
export function componentDrafts(detail:FinanceDetail):ComponentDraft[]{return detail.components.length?detail.components.map(c=>({id:c.id,type:c.type,amount:minorToRubles(c.amountMinor),role:c.role.userVerified?c.role.value:'auto',categoryId:c.category.value,subcategoryId:c.subcategory.value,categoryConfirmed:c.category.userVerified,subcategoryConfirmed:c.subcategory.userVerified})):[{...newComponent(),amount:minorToRubles(detail.projection.amountMinor),role:detail.semantics.role.value,categoryId:detail.semantics.category.value,subcategoryId:detail.semantics.subcategory.value,categoryConfirmed:true,subcategoryConfirmed:true}];}
export function componentsIntent(detail:FinanceDetail,drafts:ComponentDraft[]):RelationIntent{
 if(drafts.length>50)throw new Error('В одной операции допускается до 50 частей.');
 const parts=drafts.map(d=>({id:d.id,type:d.type,amountMinor:rublesToMinor(d.amount),...(d.role!=='auto'?{role:d.role}:{}),...(d.categoryConfirmed?{categoryId:d.categoryId}:{}),...(d.subcategoryConfirmed?{subcategoryId:d.subcategoryId}:{} )}));
 if(parts.length&&parts.reduce((s,p)=>s+BigInt(p.amountMinor),0n)!==BigInt(detail.projection.amountMinor))throw new Error('Сумма частей должна точно совпадать с суммой операции.');
 return {kind:'components',id:detail.id,parts};
}
export type Endpoint={key:string;componentId:string|null;allocationId:string|null;amountMinor:string;categoryId:string|null;role:Role|null;current?:boolean};
export function endpointKey(componentId:string|null,allocationId?:string|null){return allocationId?'allocation:'+allocationId:componentId?'component:'+componentId:'root';}
/** Projection IDs are opaque. Persist only the explicit component/allocation selectors. */
export function endpoints(op:Projection,existing?:{componentId:string|null;allocationId?:string|null}):Endpoint[]{
 const result=new Map<string,Endpoint>();
 for(const part of op.parts){const componentId=part.allocationId?null:part.componentId,key=endpointKey(componentId,part.allocationId);if(!result.has(key))result.set(key,{key,componentId,allocationId:part.allocationId,amountMinor:part.amountMinor,categoryId:part.categoryId,role:part.role});}
 if(existing){const key=endpointKey(existing.componentId,existing.allocationId);if(!result.has(key))result.set(key,{key,componentId:existing.componentId,allocationId:existing.allocationId??null,amountMinor:'0',categoryId:null,role:null,current:true});}
 return [...result.values()];
}
export function linkIntent(id:string,kind:Link['kind'],status:Link['status'],amount:string,source:Projection,target:Projection,sourceEndpoint:Endpoint,targetEndpoint:Endpoint):RelationIntent{
 const amountMinor=rublesToMinor(amount);if(BigInt(amountMinor)<=0n)throw new Error('Сумма связи должна быть положительной.');
 if(source.id===target.id)throw new Error('Выберите две разные операции.');
 return {kind:'link',id,link:{kind,status,amountMinor,sourceId:source.id,targetId:target.id,sourceComponentId:sourceEndpoint.componentId,targetComponentId:targetEndpoint.componentId,sourceAllocationId:sourceEndpoint.allocationId,targetAllocationId:targetEndpoint.allocationId}};
}
