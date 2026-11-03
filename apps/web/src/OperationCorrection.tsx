import {useState} from 'react';
import type {Account} from '../../../packages/finance-core/src/model';
import {minorToRubles,parseCorrectionDate,rublesToMinor} from './finance-client';
import type {CorrectionDraft,FinanceDetail} from './finance-client';
import {DateInput} from './DateInput';
import {OperationDialog,OperationField} from './OperationDialog';
import common from './App.module.css';
import styles from './ServerOperation.module.css';

export function OperationCorrection({initial,detail,accounts,onApply,onClose}:{initial:CorrectionDraft;detail:FinanceDetail;accounts:Account[];onApply:(draft:CorrectionDraft)=>void;onClose:()=>void}){
 const [draft,setDraft]=useState(initial),[checked,setChecked]=useState(false);
 const errors:Partial<Record<keyof CorrectionDraft,string>>={};
 try{rublesToMinor(draft.amount);}catch(e){errors.amount=(e as Error).message;}
 try{parseCorrectionDate(draft);}catch{errors.date=draft.precision==='day'?'Укажите существующую дату.':'Укажите существующие дату и время (UTC).';}
 if(!accounts.some(a=>a.id===draft.accountId)&&draft.accountId!==initial.accountId&&draft.accountId!==(detail.accountAssignmentId??detail.source.accountId))errors.accountId='Выберите доступный счёт.';
 const set=(patch:Partial<CorrectionDraft>)=>setDraft(d=>({...d,...patch}));
 const apply=()=>{setChecked(true);if(!Object.keys(errors).length)onApply({...draft,amount:minorToRubles(rublesToMinor(draft.amount))});};
 const restore=()=>{const date=detail.source.operationDate;setDraft({amount:minorToRubles(detail.source.amountMinor),precision:date.precision,date:date.precision==='day'?date.date:date.instant.replace(/Z$/,''),accountId:detail.accountAssignmentId??detail.source.accountId});setChecked(false);};
 const dateLabel=draft.precision==='day'?'Дата операции':'Дата и время операции (UTC)';
 return <OperationDialog title="Изменение банковских значений" onClose={onClose} compact footer={<><button className={styles.quietButton} onClick={restore}>Вернуть банковские значения</button><button className={styles.quietButton} onClick={()=>{setDraft(initial);setChecked(false);}}>Сбросить</button><button className={common.primaryButton+' '+styles.rightAction} onClick={apply}>Применить</button></>}>
  <fieldset className={styles.form}>
   <OperationField label="Сумма операции, ₽" error={checked?errors.amount:undefined}><input inputMode="decimal" value={draft.amount} onChange={e=>set({amount:e.target.value})}/></OperationField>
   <label>Точность даты<select value={draft.precision} onChange={e=>set({precision:e.target.value as CorrectionDraft['precision'],date:e.target.value==='day'?draft.date.slice(0,10):''})}><option value="day">Дата без времени</option><option value="instant">Дата и время (UTC)</option></select></label>
   <OperationField label={dateLabel} error={checked?errors.date:undefined}>{draft.precision==='day'?<DateInput aria-label={dateLabel} value={draft.date} showError={false} onValueChange={date=>set({date})}/>:<input aria-label={dateLabel} type="datetime-local" step="0.001" value={draft.date} onChange={e=>set({date:e.target.value})}/>}</OperationField>
   <OperationField label="Счёт операции" error={checked?errors.accountId:undefined}><select value={draft.accountId} onChange={e=>set({accountId:e.target.value})}>{!accounts.some(a=>a.id===draft.accountId)&&<option value={draft.accountId}>Исходный счёт</option>}{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></OperationField>
  </fieldset>
 </OperationDialog>;
}
