import {DateInput} from './DateInput';
import {useId,useState} from 'react';
import {ChevronDown} from 'lucide-react';
import type {FinanceState} from './finance-client';
import {bankNames} from './finance-client';
import type {WorkspaceFilters} from './workspace';
import {allHistory} from './workspace';
import {AccountFilter} from './AccountFilter';
import {CategoryFilter} from './CategoryFilter';
import styles from './CompactFilters.module.css';
import type {Condition} from '../../../packages/analyzer/src/task-context';
const dateLabel=(s:string)=>s.split('-').reverse().join('.');
export function ServerFilters({state,value,onChange,disabled}:{state:FinanceState;value:WorkspaceFilters;onChange:(v:WorkspaceFilters,touched?:Condition[])=>void;disabled:boolean}){
 const [expanded,setExpanded]=useState(false),detailsId=useId(),[resetVersion,setResetVersion]=useState(0);
 const categoryName=(id:string)=>{const c=state.categories.find(c=>c.id===id);if(!c)return 'Недоступная категория';const parent=state.categories.find(p=>p.id===c.parentId);return (parent?parent.name+' → ':'')+c.name+(c.hidden?' (скрытая)':'');};
 const period=value.from||value.through?`${value.from?'С '+dateLabel(value.from):'С начала истории'} — ${value.through?'по '+dateLabel(value.through):'по последнюю операцию'}`:'Вся история';
 return <fieldset className={styles.filters} disabled={disabled}><legend className={styles.srOnly}>Общие фильтры</legend>
  <div className={styles.bar}><div className={styles.fields}>
   <CategoryFilter categories={state.categories} value={value.categoryIds} onChange={categoryIds=>onChange({...value,categoryIds},['categories'])} disabled={disabled}/>
   <AccountFilter accounts={state.accounts} value={value.accountIds??(value.accountId?[value.accountId]:value.bankId?state.accounts.filter(a=>a.bankId===value.bankId).map(a=>a.id):[])} disabled={disabled} onChange={ids=>onChange({...value,bankId:'',accountId:'',accountIds:ids.length?ids:undefined},['bank','accounts'])}/>
   <div className={styles.dates}>   <label className={styles.dateField}><span aria-hidden="true">С</span><span className={styles.srOnly}>С даты</span><DateInput key={'from:'+resetVersion} aria-label="С даты" value={value.from} onValueChange={date=>onChange({...value,from:date},['period'])}/></label>
   <label className={styles.dateField}><span aria-hidden="true">До</span><span className={styles.srOnly}>По дату</span><DateInput key={'through:'+resetVersion} aria-label="По дату" value={value.through} onValueChange={date=>onChange({...value,through:date},['period'])}/></label>
</div>
  </div><div className={styles.actions}><button type="button" className={styles.reset} onClick={()=>{setResetVersion(n=>n+1);onChange({...allHistory,categoryIds:[]},['period','bank','accounts','categories']);}}>Сбросить</button><button type="button" className={styles.expand} aria-expanded={expanded} aria-controls={detailsId} aria-label={expanded?'Скрыть подробности фильтров':'Показать подробности фильтров'} title="Подробности фильтров" onClick={()=>setExpanded(v=>!v)}><ChevronDown size={17} aria-hidden="true"/></button></div></div>
  {expanded&&<section id={detailsId} className={styles.details} aria-label="Подробности общих фильтров"><dl><div><dt>Период</dt><dd>{period}</dd></div><div><dt>Банк</dt><dd>{value.bankId?bankNames[value.bankId]??'Другой банк':'Все банки'}</dd></div><div><dt>Счёт</dt><dd>{value.accountIds?value.accountIds.map(id=>state.accounts.find(a=>a.id===id)?.name??'Недоступный счёт').join(', '):state.accounts.find(a=>a.id===value.accountId)?.name??'Все счета'}</dd></div><div className={styles.wide}><dt>Категории</dt><dd>{value.categoryIds.length?<ul>{value.categoryIds.map(id=><li key={id}>{categoryName(id)}{state.categories.some(c=>c.parentId===id)&&<ul>{state.categories.filter(c=>c.parentId===id).map(c=><li key={c.id}>{c.name}</li>)}</ul>}</li>)}</ul>:'Все категории'}</dd></div></dl></section>}
 </fieldset>;
}
