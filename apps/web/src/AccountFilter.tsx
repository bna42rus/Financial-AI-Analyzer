import {CategoryFilter} from './CategoryFilter';
import type {FinanceState} from './finance-client';
import {bankNames} from './finance-client';
export function AccountFilter({accounts,value,onChange,disabled,emptyLabel}:{accounts:FinanceState['accounts'];value:string[];onChange:(ids:string[])=>void;disabled:boolean;emptyLabel?:string}){
 const banks=[...new Set(accounts.map(a=>a.bankId))];
 const tree:FinanceState['categories']=[...banks.map(id=>({id:'bank:'+id,name:bankNames[id]??id,parentId:null,role:'both' as const,hidden:false})),...accounts.map(a=>({id:a.id,name:a.name,parentId:'bank:'+a.bankId,role:'both' as const,hidden:false}))];
 return <CategoryFilter accountMode categories={tree} value={value} disabled={disabled} emptyLabel={emptyLabel??'Все банки и счета'} onChange={onChange}/>;
}
