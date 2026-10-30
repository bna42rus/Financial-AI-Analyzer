import {useEffect,useRef,useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {ShieldCheck,Upload,X} from 'lucide-react';
import {api} from './server-client';
import {useNotices} from './Notifications';
import {ImportFlow} from './import-flow';
import type {ImportFlowState} from './import-flow';
import {importActive} from '../../../packages/imports/src/report';
import type {ImportReport} from '../../../packages/imports/src/report';
import type {LocalContext} from '../../../packages/imports/src/local';
import common from './App.module.css';
import styles from './ShellDialogs.module.css';
export const localIssueLabels:Record<string,string>={UNSUPPORTED_FILE:'Выберите PDF, CSV или XLSX.',EMPTY_FILE:'Файл пустой. Выберите другую копию.',LOCAL_LIMIT:'Превышен лимит: до 20 МБ, 100 страниц PDF (20 для сканов) и 1000 строк за загрузку.',PASSWORD_REQUIRED:'Для открытия нужен пароль PDF.',WRONG_PASSWORD:'Пароль не подошёл.',OCR_REQUIRED:'Не удалось прочитать скан. Выберите более чёткую копию или текстовую выписку.',OCR_UNCERTAIN:'Не удалось уверенно прочитать скан. Выберите более чёткую копию.',UNKNOWN_FORMAT:'Формат выписки пока не поддерживается.',AMBIGUOUS_FORMAT:'Не удалось определить банк.',UNSUPPORTED_LAYOUT:'Этот вид выписки пока не поддерживается.',LOCAL_READ_FAILED:'Не удалось прочитать файл. Выберите другую копию.'};
export function ServerImport({open,onClose,onOpen,onHistory,onAccepted,recovered,active}:{open:boolean;onClose:()=>void;onOpen:()=>void;onHistory:(batchId?:string)=>void;onAccepted:(report:ImportReport)=>void;recovered:ImportReport|null;active:boolean}){
 const [state,setState]=useState<ImportFlowState>({phase:'idle',issues:[],locked:[],error:''}),[passwords,setPasswords]=useState<Record<string,string>>({}),[files,setFiles]=useState<{id:string;file:File}[]>([]),[selectionError,setSelectionError]=useState(''),[batch,setBatch]=useState<ImportReport|null>(null);
 const flow=useRef<ImportFlow|null>(null),fileInput=useRef<HTMLInputElement>(null),accepted=useRef(onAccepted),callbacks=useRef({onOpen,onHistory}),noticeId=useRef(''),notices=useNotices();accepted.current=report=>{setBatch(report);setFiles([]);onAccepted(report);};callbacks.current={onOpen,onHistory};
 useEffect(()=>{const instance=new ImportFlow({context:signal=>api<LocalContext>('/finance/import-context',{contextId:crypto.randomUUID()},signal),prepare:async(...args)=>(await import('./import-local')).prepareLocalBankFiles(...args),accept:prepared=>api<ImportReport>('/finance/import-accept',prepared)},setState,report=>accepted.current(report));flow.current=instance;return()=>{instance.dispose();if(flow.current===instance)flow.current=null;};},[]);
 useEffect(()=>{if(recovered){flow.current?.recover(recovered);setBatch(previous=>previous?.batchId===recovered.batchId?recovered:previous);}},[recovered]);
 useEffect(()=>{if(!['local','sending','retry'].includes(state.phase))return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[state.phase]);
 useEffect(()=>{
  if(!noticeId.current||!notices)return;const id=noticeId.current,group='import';
  if(state.phase==='local'||state.phase==='sending'){notices.push({id,group,title:'Загрузка началась',detail:state.phase==='local'?'Подготавливаем файлы. Не закрывайте страницу.':'Отправляем подготовленные данные.',busy:true});return;}
  if(state.phase==='retry'){notices.push({id,group,title:'Загрузка ожидает подтверждения',detail:'Повторите отправку. Дубликаты не появятся.',action:{label:'Повторить отправку',run:()=>void flow.current?.retry()}});return;}
  if(batch){const running=importActive(batch.status),total=batch.counts.rowsFound,pending=batch.counts.pending,progress=running?(total?Math.min(99,Math.floor((total-pending)*100/total)):0):100;
   const title=running?'Загрузка началась':batch.status==='partial'||state.issues.length>0?'Загрузка завершена: есть что проверить':batch.status==='invalidated'?'Загрузка остановлена':batch.status==='cancelled'?'Загрузка отменена':'Загрузка завершена';
   notices.push({id,group,title,detail:running?`Обработано операций: ${Math.max(0,total-pending)} из ${total}.`:state.issues.length?`Не удалось подготовить файлов: ${state.issues.length}.`:undefined,busy:running,progress,...(state.issues.length&&!running&&!state.locked.length?{secondaryAction:{label:'Проверить файлы',run:()=>callbacks.current.onOpen()}}:{}),action:{label:state.locked.length?'Ввести пароль':running?'Открыть загрузку':'Смотреть результат',run:()=>state.locked.length?callbacks.current.onOpen():callbacks.current.onHistory(batch.batchId)}});return;}
  if(state.locked.length||state.issues.length||state.error){notices.push({id,group,title:state.locked.length?'Для выписки нужен пароль':'Не удалось загрузить все файлы',detail:state.error||undefined,action:{label:state.locked.length?'Ввести пароль':'Проверить файлы',run:()=>callbacks.current.onOpen()}});}
 },[state.phase,state.error,state.locked,state.issues,batch,notices]);
 function close(){if(state.phase==='idle'){flow.current?.close();setFiles([]);setSelectionError('');}setPasswords({});if(fileInput.current)fileInput.current.value='';onClose();}
 const disabled=active||state.phase!=='idle';
 function choose(chosen:FileList|null){if(chosen&&!disabled){const next=[...files,...Array.from(chosen).map(file=>({id:crypto.randomUUID(),file}))];if(next.length>10)setSelectionError('Можно выбрать до 10 файлов. Уберите лишние и попробуйте снова.');else{setFiles(next);setSelectionError('');setPasswords({});}}if(fileInput.current)fileInput.current.value='';}
 function start(){if(!files.length||disabled)return;noticeId.current='import:'+crypto.randomUUID();setBatch(null);setSelectionError('');setPasswords({});onClose();void flow.current?.choose(files.map(f=>f.file));}
 return <Dialog.Root open={open} onOpenChange={next=>{if(!next)close();}}><Dialog.Portal><Dialog.Overlay className={common.overlay}/><Dialog.Content className={`${common.dialog} ${styles.modal}`} onOpenAutoFocus={event=>{const choose=fileInput.current?.parentElement?.querySelector<HTMLButtonElement>('[data-choose]');if(choose&&!choose.disabled){event.preventDefault();choose.focus();}}}>
  <div className={common.dialogHead}><Dialog.Title>Загрузка выписок</Dialog.Title><button className={common.iconButton} aria-label="Закрыть: Загрузка выписок" onClick={close}><X size={20}/></button></div>
  <Dialog.Description>Выберите до 10 выписок: PDF, CSV или XLSX.</Dialog.Description>
  <div className={styles.notice}><ShieldCheck size={20} aria-hidden="true"/><p>Файл и пароль остаются на вашем устройстве. На сервер отправляются данные с замаскированными реквизитами.</p></div>
  {active&&<p role="status">Другая загрузка ещё обрабатывается. Дождитесь её завершения.</p>}
  <div className={styles.dropzone} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();choose(event.dataTransfer.files);}}>
   <Upload size={28} aria-hidden="true"/><h3>Перетащите файлы сюда</h3><p>или выберите их на устройстве</p>
   <input ref={fileInput} className={styles.fileInput} type="file" accept=".pdf,.csv,.xlsx" multiple aria-label="Файлы выписок" disabled={disabled} onChange={event=>choose(event.target.files)}/>
   <button data-choose className={common.button} disabled={disabled} onClick={()=>fileInput.current?.click()}>Выбрать файлы</button><small>До 10 файлов · до 20 МБ каждый</small><p>Проверьте отмеченные операции после загрузки: текст скана мог прочитаться неточно.</p>
  </div>
  {files.length>0&&<ul className={styles.files} aria-label="Выбранные файлы">{files.map(({id,file})=><li key={id}><div><strong>{file.name}</strong><small>{(file.size/1024/1024).toLocaleString('ru-RU',{maximumFractionDigits:2})} МБ</small></div><button type="button" className={common.iconButton} aria-label={'Убрать файл: '+file.name} disabled={disabled} onClick={()=>{setFiles(files.filter(f=>f.id!==id));setSelectionError('');}}><X size={17}/></button></li>)}</ul>}
  {selectionError&&<p role="alert" className={styles.error}>{selectionError}</p>}
  {state.phase==='local'&&<><p role="status">Подготавливаем файлы…</p><button className={common.button} onClick={()=>{flow.current?.close();setPasswords({});}}>Остановить подготовку</button></>}
  {state.phase==='sending'&&<p role="status">Отправляем подготовленные данные…</p>}{state.error&&<p role="alert" className={styles.error}>{state.error}</p>}
  {state.phase==='retry'&&<button className={common.primaryButton} disabled={active} onClick={()=>{onClose();void flow.current?.retry();}}>Повторить отправку</button>}
  {state.issues.length>0&&<ul className={styles.files} aria-label="Ошибки локальной подготовки">{state.issues.map(i=><li key={i.fileId}><div><strong>{i.name}</strong><p>{localIssueLabels[i.code]??'Не удалось прочитать файл. Выберите другую копию.'}</p></div></li>)}</ul>}
  {state.locked.length>0&&<form onSubmit={event=>{event.preventDefault();const attempt={...passwords};setPasswords({});setBatch(null);noticeId.current='import:'+crypto.randomUUID();onClose();void flow.current?.unlock(attempt);}}>{state.locked.map(i=><label className={styles.field} key={i.fileId}>Пароль PDF: {i.name}<input type="password" autoComplete="off" maxLength={1024} value={passwords[i.fileId]??''} onChange={event=>setPasswords(p=>({...p,[i.fileId]:event.target.value}))}/></label>)}<button className={common.primaryButton} disabled={disabled}>Открыть защищённые PDF</button></form>}
  <div className={styles.actions}><button className={common.button} onClick={()=>{close();onHistory();}}>История загрузок</button>{files.length>0&&!state.locked.length&&<button className={common.primaryButton} disabled={disabled} onClick={start}>Загрузить</button>}<button className={common.button} onClick={close}>Закрыть</button></div>
 </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
