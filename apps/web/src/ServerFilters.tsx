import {useId,useState} from 'react';
import {ChevronDown} from 'lucide-react';
import type {FinanceState} from './finance-client';
import {bankNames} from './finance-client';
import type {WorkspaceFilters} from './workspace';
import {allHistory} from './workspace';
import {CategoryFilter} from './CategoryFilter';
import styles from './CompactFilters.module.css';
import type {Condition} from '../../../packages/analyzer/src/task-context';
const dateLabel=(s:string)=>s.split('-').reverse().join('.');
export function ServerFilters({state,value,onChange,disabled}:{state:FinanceState;value:WorkspaceFilters;onChange:(v:WorkspaceFilters,touched?:Condition[])=>void;disabled:boolean}){
 const banks=[...new Set(state.accounts.map(a=>a.bankId))],[expanded,setExpanded]=useState(false),detailsId=useId();
 const categoryName=(id:string)=>{const c=state.categories.find(c=>c.id===id);if(!c)return 'Недоступная категория';const parent=state.categories.find(p=>p.id===c.parentId);return (parent?parent.name+' → ':'')+c.name+(c.hidden?' (скрытая)':'');};
 const period=value.from||value.through?`${value.from?'С '+dateLabel(value.from):'С начала истории'} — ${value.through?'по '+dateLabel(value.through):'по последнюю операцию'}`:'Вся история';
 return <fieldset className={styles.filters} disabled={disabled}><legend className={styles.srOnly}>Общие фильтры</legend>
  <div className={styles.bar}><div className={styles.fields}>
   <CategoryFilter categories={state.categories} value={value.categoryIds} onChange={categoryIds=>onChange({...value,categoryIds},['categories'])} disabled={disabled}/>
   <label className={styles.field}><span className={styles.srOnly}>Банк</span><select className={styles.bank} aria-label="Банк" title={value.bankId?bankNames[value.bankId]??'Другой банк':'Все банки'} value={value.bankId} onChange={e=>onChange({...value,bankId:e.target.value,accountId:''},['bank','accounts'])}><option value="">Все банки</option>{banks.map(b=><option key={b} value={b}>{bankNames[b]??'Другой банк'}</option>)}</select></label>
   <label className={styles.field}><span className={styles.srOnly}>Счёт</span><select className={styles.account} aria-label="Счёт" title={state.accounts.find(a=>a.id===value.accountId)?.name??'Все счета'} value={value.accountId} onChange={e=>onChange({...value,accountId:e.target.value},['accounts'])}><option value="">Все счета</option>{state.accounts.filter(a=>!value.bankId||a.bankId===value.bankId).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
   <div className={styles.dates}>   <label className={styles.dateField}><span aria-hidden="true">С</span><span className={styles.srOnly}>С даты</span><input type="date" aria-label="С даты" value={value.from} onChange={e=>onChange({...value,from:e.target.value},['period'])}/></label>
   <label className={styles.dateField}><span aria-hidden="true">До</span><span className={styles.srOnly}>По дату</span><input type="date" aria-label="По дату" value={value.through} onChange={e=>onChange({...value,through:e.target.value},['period'])}/></label>
</div>
  </div><div className={styles.actions}><button type="button" className={styles.reset} onClick={()=>onChange({...allHistory,categoryIds:[]},['period','bank','accounts','categories'])}>Сбросить</button><button type="button" className={styles.expand} aria-expanded={expanded} aria-controls={detailsId} aria-label={expanded?'Скрыть подробности фильтров':'Показать подробности фильтров'} title="Подробности фильтров" onClick={()=>setExpanded(v=>!v)}><ChevronDown size={17} aria-hidden="true"/></button></div></div>
  {expanded&&<section id={detailsId} className={styles.details} aria-label="Подробности общих фильтров"><dl><div><dt>Период</dt><dd>{period}</dd></div><div><dt>Банк</dt><dd>{value.bankId?bankNames[value.bankId]??'Другой банк':'Все банки'}</dd></div><div><dt>Счёт</dt><dd>{state.accounts.find(a=>a.id===value.accountId)?.name??'Все счета'}</dd></div><div className={styles.wide}><dt>Категории</dt><dd>{value.categoryIds.length?<ul>{value.categoryIds.map(id=><li key={id}>{categoryName(id)}{state.categories.some(c=>c.parentId===id)&&<ul>{state.categories.filter(c=>c.parentId===id).map(c=><li key={c.id}>{c.name}</li>)}</ul>}</li>)}</ul>:'Все категории'}</dd></div></dl></section>}
 </fieldset>;
}
