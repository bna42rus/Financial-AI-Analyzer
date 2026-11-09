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

type PickerProps={state:FinanceState;timezone:string;disabled:boolean;omit?:string[];counterpartyId?:string;allowedIds?:string[];label?:string};
export function OperationSelection({state,timezone,disabled,omit=[],counterpartyId,allowedIds,label,selected,onSelected,onReady}:PickerProps&{selected:string[];onSelected:(ids:string[])=>void;onReady:(ready:boolean)=>void}){
 const [search,setSearch]=useState(''),[page,setPage]=useState(1),[data,setData]=useState<OperationsPage|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true);
 useEffect(()=>{onReady(!busy&&!error);},[busy,error,onReady]);
 useEffect(()=>{const controller=new AbortController();const timer=setTimeout(()=>{setBusy(true);setError('');void api<OperationsPage>('/finance/operations-page',{query:{filter:{...(search.trim()?{search:search.trim()}:{}),...(counterpartyId?{counterpartyIds:[counterpartyId]}:{}),...(allowedIds?{operationIds:allowedIds}:{}),inclusion:'any'},sort:'date',direction:'desc',group:'none'},displayLimit:25,page},controller.signal).then(result=>{if(controller.signal.aborted)return;if(result.generation!==state.generation||result.revision!==state.revision)throw new Error('Данные изменились. Откройте окно заново.');setData(result);}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Не удалось загрузить операции.');}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});},200);return()=>{clearTimeout(timer);controller.abort();};},[search,page,state.generation,state.revision,counterpartyId,allowedIds]);
 const visible=data?.operations.filter(op=>!omit.includes(op.id))??[];
 return <div className={styles.operationPicker}>{label&&<span className={styles.pickerLabel}>{label}</span>}<SearchField value={search} onValueChange={value=>{setSearch(value);setPage(1);setBusy(true);}} placeholder="Дата, название, описание, сумма" aria-label="Найти операцию"/>
  {error&&<p className={common.error} role="alert">{error}</p>}
  {busy&&<p role="status">Загружаем операции…</p>}
  {!busy&&!error&&visible.length>0&&<ul className={styles.reviewList}>{visible.map(o=><li key={o.id}><label className={styles.reviewChoice}><input type="checkbox" disabled={disabled||busy||selected.length>=1000&&!selected.includes(o.id)} checked={selected.includes(o.id)} onChange={e=>onSelected(e.target.checked?[...selected,o.id]:selected.filter(id=>id!==o.id))}/><span>{o.displayName?.compositeLabel||o.classification.merchant.value||'Операция'}<small>{displayBankDate(o.date,timezone)} · {formatMoney(o.amountMinor)}</small></span></label></li>)}</ul>}
  {!busy&&!error&&data&&!visible.length&&<p>Операции не найдены.</p>}
  {data&&data.total>25&&<div className={styles.cardActions}><button type="button" className={common.button} disabled={busy||page===1} onClick={()=>{setBusy(true);setPage(n=>n-1);}}>Назад</button><span>{page} / {Math.ceil(data.total/25)}</span><button type="button" className={common.button} disabled={busy||!data.nextCursor} onClick={()=>{setBusy(true);setPage(n=>n+1);}}>Вперёд</button></div>}
 </div>;
}
export function SettingsOperationPicker({title,onClose,onApply,error,onRetry,initialSelected,allowEmpty=false,...props}:PickerProps&{title:string;onClose:()=>void;onApply:(ids:string[])=>void;error?:string;onRetry?:()=>void;initialSelected?:string[];allowEmpty?:boolean}){
 const [selected,setSelected]=useState<string[]>(initialSelected??[]),[ready,setReady]=useState(false);
 return <OperationDialog compact title={title} onClose={onClose} footer={<><button className={common.button} onClick={onClose}>Отменить</button><button className={common.primaryButton} disabled={props.disabled||!ready||!allowEmpty&&!selected.length} onClick={()=>onApply(selected)}>{allowEmpty?'Сохранить выбор':'Продолжить'}{selected.length?' · '+selected.length:''}</button></>}>
  <OperationSelection {...props} selected={selected} onSelected={setSelected} onReady={setReady}/>
  {error&&<p role="alert" className={common.error}>{error}</p>}{onRetry&&<button type="button" className={common.button} onClick={onRetry}>Повторить проверку</button>}
 </OperationDialog>;
}
