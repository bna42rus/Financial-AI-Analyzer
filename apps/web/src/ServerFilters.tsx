import type {FinanceState} from './finance-client';
import {bankNames} from './finance-client';
import type {WorkspaceFilters} from './workspace';
import {allHistory} from './workspace';
import common from './App.module.css';
import styles from './Workspace.module.css';
import type {Condition} from '../../../packages/analyzer/src/task-context';
export function ServerFilters({state,value,onChange,disabled}:{state:FinanceState;value:WorkspaceFilters;onChange:(v:WorkspaceFilters,touched?:Condition[])=>void;disabled:boolean}){
 const banks=[...new Set(state.accounts.map(a=>a.bankId))];
 return <fieldset className={styles.filters} disabled={disabled}><legend>Общие фильтры</legend>
 <label>С даты<input type="date" value={value.from} onChange={e=>onChange({...value,from:e.target.value},['period'])}/></label><label>По дату<input type="date" value={value.through} onChange={e=>onChange({...value,through:e.target.value},['period'])}/></label>
 <label>Банк<select aria-label="Банк" value={value.bankId} onChange={e=>onChange({...value,bankId:e.target.value,accountId:''},['bank','accounts'])}><option value="">Все банки</option>{banks.map(b=><option key={b} value={b}>{bankNames[b]??'Другой банк'}</option>)}</select></label>
 <label>Счёт<select aria-label="Счёт" value={value.accountId} onChange={e=>onChange({...value,accountId:e.target.value},['accounts'])}><option value="">Все счета</option>{state.accounts.filter(a=>!value.bankId||a.bankId===value.bankId).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
 <label>Категории<select aria-label="Категории" multiple value={value.categoryIds} onChange={e=>onChange({...value,categoryIds:Array.from(e.target.selectedOptions,o=>o.value)},['categories'])} aria-describedby="category-filter-help">{state.categories.filter(c=>!c.hidden||value.categoryIds.includes(c.id)).map(c=><option key={c.id} value={c.id}>{c.parentId?'↳ ':''}{c.name}</option>)}</select></label>
 <button className={common.button} onClick={()=>onChange({...allHistory,categoryIds:[]},['period','bank','accounts','categories'])}>За всю историю</button><small id="category-filter-help">Категории можно выбрать несколько. Итоги рассчитывает сервер; категории составной операции учитываются по частям.</small>
 </fieldset>;
}
