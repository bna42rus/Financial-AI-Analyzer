import type {BulkIntent,FinanceState,OperationPatch} from './finance-client';
import {safeOperationPatch} from './finance-client';
export type BulkAction='category'|'role'|'kind'|'counterparty'|'comment'|'inclusion'|'verify'|'review';
export const bulkActionNames:Record<BulkAction,string>={category:'Категория и подкатегория',role:'Финансовый смысл',kind:'Тип операции',counterparty:'Контрагент',comment:'Комментарий',inclusion:'Участие в аналитике',verify:'Подтвердить поля',review:'Метка проверки'};
export const facetNames={kind:'Тип',role:'Финансовый смысл',category:'Категория',subcategory:'Подкатегория'};
export function rangeSelection(ids:string[],selected:string[],anchor:string|null,target:string,range:boolean){const next=new Set(selected);const at=ids.indexOf(target),from=anchor?ids.indexOf(anchor):-1;if(at<0)return selected.filter(id=>ids.includes(id));if(range&&from>=0)for(const id of ids.slice(Math.min(at,from),Math.max(at,from)+1))next.add(id);else if(next.has(target))next.delete(target);else next.add(target);return ids.filter(id=>next.has(id));}
export function buildBulkIntent(state:FinanceState,ids:string[],action:BulkAction,value:{categoryId:string;subcategoryId:string;role:string;kind:string;counterpartyId:string;comment:string;inclusion:string;review:boolean;verify:(keyof typeof facetNames)[]}):BulkIntent {
 if(!ids.length||ids.length>1000||new Set(ids).size!==ids.length||ids.some(id=>!state.operations.some(o=>o.id===id)))throw new Error('Выберите от 1 до 1000 доступных операций.');
 let patch:OperationPatch={};
 if(action==='category')patch={categoryId:value.categoryId||null,subcategoryId:value.subcategoryId||null};
 if(action==='role')patch={role:value.role};if(action==='kind')patch={kind:value.kind};if(action==='counterparty')patch={counterpartyId:value.counterpartyId||null};if(action==='comment')patch={comment:value.comment};if(action==='inclusion')patch={analyticsOverride:value.inclusion as OperationPatch['analyticsOverride']};if(action==='review')patch={reviewRequested:value.review};
 if(action==='verify'&&!value.verify.length)throw new Error('Выберите поля для подтверждения.');
 const changesMeaning=action==='role'||action==='category'||action==='verify'&&value.verify.some(k=>k!=='kind');
 if(changesMeaning&&state.operations.some(o=>ids.includes(o.id)&&o.decompositionActive))throw new Error('У выбранных операций есть отдельные части. Проверьте смысл и категории частей в карточке операции.');
 return {kind:'bulk_operations',operationIds:[...ids],...(action==='verify'?{verify:[...value.verify]}:{patch:safeOperationPatch(patch)})};
}
