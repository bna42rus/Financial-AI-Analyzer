import type {OperationsQuery,OperationsView,OperationRow,Column} from '../../../packages/finance-core/src/operations';
import type {aggregate} from '../../../packages/finance-core/src/graph';
export type {OperationsQuery,OperationsView,OperationRow,Column};
export type OperationsPage={generation:string;revision:string;operations:OperationRow[];total:number;workspaceTotal:number;offset:number;summary:ReturnType<typeof aggregate>&{operationCount?:number;attentionCount?:number};nextCursor:{generation:string;revision:string;queryHash:string;offset:number}|null};
export type SavedOperationsView={id:string;name:string;definition:OperationsView;isDefault:boolean;dependencyStatus:'ready'|'needs_setup';revision:string;position:number;modifiedAt:string};
export const columnNames:Record<Column,string>={date:'Дата',merchant:'Операция / магазин',amount:'Сумма',account:'Счёт',kind:'Тип',role:'Учёт',category:'Категория',status:'Проверка',bank:'Банк',subcategory:'Подкатегория',counterparty:'Контрагент',comment:'Комментарий',confidence:'Уверенность',source:'Источник',rule:'Правило',postedDate:'Дата проводки',inclusion:'Участие',import:'Импорт',bankCategory:'Банковская категория',id:'ID операции'};
export const sourceNames:Record<string,string>={user:'Пользователь',personal_rule:'Персональное правило',deterministic_system_rule:'Системное правило',global_rule:'Общее правило',ai:'AI',bank:'Банк'};
export const groupingNames={none:'Без группировки',date:'Дата',category:'Категория',subcategory:'Подкатегория',merchant:'Магазин',counterparty:'Контрагент',account:'Счёт',kind:'Тип'};
