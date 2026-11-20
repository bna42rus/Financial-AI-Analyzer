import type {OperationsFilter} from '../../../packages/finance-core/src/operations';
import type {FinanceState} from './finance-client';
/** Collapse the old root AND leaf selectors without broadening their intersection. */
export function unifiedWidgetCategories(filter:OperationsFilter,categories:FinanceState['categories']):OperationsFilter{
 if(!filter.subcategoryIds)return filter;
 const byId=new Map(categories.map(c=>[c.id,c]));
 if([...filter.subcategoryIds,...(filter.categoryIds??[])].some(id=>!byId.has(id)))return filter;
 const ids=filter.subcategoryIds.filter(id=>{const c=byId.get(id)!;return !!c.parentId&&(!filter.categoryIds||filter.categoryIds.includes(c.parentId)||filter.categoryIds.includes(id));});
 const result={...filter,categoryIds:ids};delete result.subcategoryIds;return result;
}
