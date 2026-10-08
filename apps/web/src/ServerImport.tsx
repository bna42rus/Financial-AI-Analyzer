import {useEffect,useRef,useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {ShieldCheck,Upload,X} from 'lucide-react';
import {api} from './server-client';
import {ImportFlow} from './import-flow';
import type {ImportFlowState} from './import-flow';
import type {ImportReport} from '../../../packages/imports/src/report';
import type {LocalContext} from '../../../packages/imports/src/local';
import common from './App.module.css';
import styles from './ShellDialogs.module.css';

export const localIssueLabels:Record<string,string>={UNSUPPORTED_FILE:'Пока поддерживаются PDF. CSV и XLSX ещё недоступны.',EMPTY_FILE:'Файл пустой. Выберите другую копию.',LOCAL_LIMIT:'Превышен лимит: до 20 МБ на файл и 100 страниц.',PASSWORD_REQUIRED:'Для открытия нужен пароль PDF.',WRONG_PASSWORD:'Пароль не подошёл.',OCR_REQUIRED:'В этом PDF нет доступного текста. Чтение сканов пока недоступно.',UNKNOWN_FORMAT:'Формат выписки пока не поддерживается.',AMBIGUOUS_FORMAT:'Не удалось однозначно определить банк.',UNSUPPORTED_LAYOUT:'Структура выписки отличается от поддерживаемой.',LOCAL_READ_FAILED:'Не удалось прочитать файл. Выберите другую копию.'};
export function ServerImport({open,onClose,onHistory,onAccepted,recovered,active}:{open:boolean;onClose:()=>void;onHistory:()=>void;onAccepted:(report:ImportReport)=>void;recovered:ImportReport|null;active:boolean}){
 const [state,setState]=useState<ImportFlowState>({phase:'idle',issues:[],locked:[],error:''}),[passwords,setPasswords]=useState<Record<string,string>>({}),[receipt,setReceipt]=useState<ImportReport|null>(null);
 const flow=useRef<ImportFlow|null>(null),fileInput=useRef<HTMLInputElement>(null),accepted=useRef(onAccepted);accepted.current=report=>{setReceipt(report);onAccepted(report);};
 useEffect(()=>{const instance=new ImportFlow({context:signal=>api<LocalContext>('/finance/import-context',{contextId:crypto.randomUUID()},signal),prepare:async(...args)=>(await import('./import-local')).prepareLocalBankPdfs(...args),accept:batch=>api<ImportReport>('/finance/import-accept',batch)},setState,report=>accepted.current(report));flow.current=instance;return()=>{instance.dispose();if(flow.current===instance)flow.current=null;};},[]);
 useEffect(()=>{if(recovered)flow.current?.recover(recovered);},[recovered]);
 useEffect(()=>{if(!['local','sending','retry'].includes(state.phase))return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[state.phase]);
 function close(){flow.current?.close();setPasswords({});setReceipt(null);if(fileInput.current)fileInput.current.value='';onClose();}
 const disabled=active||state.phase!=='idle';
 function choose(files:FileList|null){if(files&&!disabled){setPasswords({});setReceipt(null);void flow.current?.choose(Array.from(files));}if(fileInput.current)fileInput.current.value='';}
 return <>
 {!open&&state.phase==='retry'&&<p role="alert" className={common.error}>Приём загрузки не подтверждён. Откройте «Загрузить файлы», чтобы повторить отправку.</p>}
 <Dialog.Root open={open} onOpenChange={next=>{if(!next)close();}}><Dialog.Portal><Dialog.Overlay className={common.overlay}/><Dialog.Content className={`${common.dialog} ${styles.modal}`} onOpenAutoFocus={event=>{const choose=fileInput.current?.parentElement?.querySelector<HTMLButtonElement>('[data-choose]');if(choose&&!choose.disabled){event.preventDefault();choose.focus();}}}>
  <div className={common.dialogHead}><Dialog.Title>Загрузка выписок</Dialog.Title><button className={common.iconButton} aria-label="Закрыть: Загрузка выписок" onClick={close}><X size={20}/></button></div>
  <Dialog.Description>Выберите один или несколько PDF банковских выписок.</Dialog.Description>
  <div className={styles.notice}><ShieldCheck size={20} aria-hidden="true"/><p>Файл и пароль остаются на устройстве. На сервер отправляются только проверенные сведения об операциях с очищенными реквизитами.</p></div>
  {receipt&&<p role="status">Загрузка принята сервером. Результат сохранён в истории загрузок.</p>}
  {active&&<p role="status">Предыдущая загрузка ещё обрабатывается. Её результат доступен в истории загрузок.</p>}
  <div className={styles.dropzone} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();choose(event.dataTransfer.files);}}>
   <Upload size={28} aria-hidden="true"/><h3>Перетащите файлы сюда</h3><p>или выберите их на устройстве</p>
   <input ref={fileInput} className={styles.fileInput} type="file" accept=".pdf" multiple aria-label="Файлы выписок" disabled={disabled} onChange={event=>choose(event.target.files)}/>
   <button data-choose className={common.primaryButton} disabled={disabled} onClick={()=>fileInput.current?.click()}>Выбрать файлы</button><small>До 10 PDF за один раз · до 20 МБ на файл</small>
  </div>
  {state.phase==='local'&&<><p role="status">Подготавливаем выписки на устройстве. Не закрывайте страницу.</p><button className={common.button} onClick={()=>{flow.current?.close();setPasswords({});}}>Остановить локальную подготовку</button></>}
  {state.phase==='sending'&&<p role="status">Передаём подготовленные сведения. Ожидаем подтверждение сервера.</p>}
  {state.error&&<p role="alert" className={styles.error}>{state.error}</p>}
  {state.phase==='retry'&&<><p>Исходный файл повторно не отправляется. Повтор использует ту же подготовленную загрузку.</p><button className={common.primaryButton} disabled={active} onClick={()=>void flow.current?.retry()}>Повторить отправку</button></>}
  {state.issues.length>0&&<ul className={styles.files} aria-label="Ошибки локальной подготовки">{state.issues.map(i=><li key={i.fileId}><div><strong>{i.name}</strong><p>{localIssueLabels[i.code]??'Не удалось подготовить файл. Выберите другую копию.'}</p></div></li>)}</ul>}
  {state.locked.length>0&&<form onSubmit={event=>{event.preventDefault();const attempt={...passwords};setPasswords({});void flow.current?.unlock(attempt);}}>{state.locked.map(i=><label className={styles.field} key={i.fileId}>Пароль PDF: {i.name}<input type="password" autoComplete="off" maxLength={1024} value={passwords[i.fileId]??''} onChange={event=>setPasswords(p=>({...p,[i.fileId]:event.target.value}))}/></label>)}<p className={styles.footnote}>Пароль используется только для этой попытки открытия и не сохраняется.</p><button className={common.primaryButton} disabled={disabled}>Открыть защищённые PDF</button></form>}
  <div className={styles.actions}><button className={common.button} onClick={()=>{close();onHistory();}}>История загрузок</button><button className={common.button} onClick={close}>Закрыть</button></div>
 </Dialog.Content></Dialog.Portal></Dialog.Root></>;
}
