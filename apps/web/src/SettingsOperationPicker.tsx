import {useEffect,useState} from 'react';
import {OperationDialog} from './OperationDialog';
import {SearchField} from './SearchFilter';
import {api} from './server-client';
import {displayBankDate} from './finance-client';
import type {FinanceState} from './finance-client';
import type {OperationsPage} from './operations-client';
import {formatMoney} from './demo/overview';
import common from './App.module.css';
import styles from './Settings.module.css';
export function SettingsOperationPicker({title,state,timezone,disabled,onClose,onApply,omit=[]}:{title:string;state:FinanceState;timezone:string;disabled:boolean;onClose:()=>void;onApply:(ids:string[])=>void;omit?:string[]}){
 const [search,setSearch]=useState(''),[page,setPage]=useState(1),[data,setData]=useState<OperationsPage|null>(null),[selected,setSelected]=useState<string[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(true);
 useEffect(()=>{const controller=new AbortController();const timer=setTimeout(()=>{setBusy(true);setError('');void api<OperationsPage>('/finance/operations-page',{query:{filter:{...(search.trim()?{search:search.trim()}:{}),inclusion:'any'},sort:'date',direction:'desc',group:'none'},displayLimit:25,page},controller.signal).then(result=>{if(controller.signal.aborted)return;if(result.generation!==state.generation||result.revision!==state.revision)throw new Error('Данные изменились. Откройте окно заново.');setData(result);}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Не удалось загрузить операции.');}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});},200);return()=>{clearTimeout(timer);controller.abort();};},[search,page,state.generation,state.revision]);
 return <OperationDialog compact title={title} onClose={onClose} footer={<><button className={common.button} onClick={onClose}>Отменить</button><button className={common.primaryButton} disabled={disabled||busy||!selected.length||!!error} onClick={()=>onApply(selected)}>Продолжить{selected.length?' · '+selected.length:''}</button></>}>
  <SearchField value={search} onValueChange={value=>{setSearch(value);setPage(1);setBusy(true);}} placeholder="Дата, магазин, описание, сумма" aria-label="Найти операцию"/>
  {error&&<p className={common.error} role="alert">{error}</p>}
  <ul className={styles.reviewList}>{data?.operations.filter(op=>!omit.includes(op.id)).map(o=><li key={o.id}><label className={styles.reviewChoice}><input type="checkbox" disabled={disabled||busy||selected.length>=1000&&!selected.includes(o.id)} checked={selected.includes(o.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,o.id]:ids.filter(id=>id!==o.id))}/><span>{o.displayName?.compositeLabel||o.classification.merchant.value||'Операция'}<small>{displayBankDate(o.date,timezone)} · {formatMoney(o.amountMinor)}</small></span></label></li>)}</ul>
  {data&&!data.total&&<p>Операции не найдены.</p>}
  {data&&data.total>25&&<div className={styles.cardActions}><button className={common.button} disabled={busy||page===1} onClick={()=>{setBusy(true);setPage(n=>n-1);}}>Назад</button><span>{page} / {Math.ceil(data.total/25)}</span><button className={common.button} disabled={busy||!data.nextCursor} onClick={()=>{setBusy(true);setPage(n=>n+1);}}>Вперёд</button></div>}
 </OperationDialog>;
}
