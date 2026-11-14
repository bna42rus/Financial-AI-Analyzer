import {useEffect,useRef,useState} from 'react';
import type {Maintenance} from '../../../packages/access/src/maintenance';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {api,ApiError} from '../../web/src/server-client';
import {localAdminDate,parseAdminDate,useAdminData,useAdminNotice} from './admin-view';
import common from '../../web/src/App.module.css';
import form from '../../web/src/ServerAccess.module.css';
import shell from './ServerAdmin.module.css';
const zone='Europe/Moscow',label=(v:string|null)=>v?new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:zone}).format(new Date(v))+' по МСК':'—';
type Field='title'|'message'|'start'|'end';
const fieldMessages:Record<string,{field:Field;text:string}>={
 MAINTENANCE_TITLE_REQUIRED:{field:'title',text:'Введите заголовок технических работ.'},
 MAINTENANCE_TITLE_LONG:{field:'title',text:'Заголовок должен быть не длиннее 100 символов.'},
 MAINTENANCE_MESSAGE_LONG:{field:'message',text:'Сообщение должно быть не длиннее 1 000 символов.'},
 MAINTENANCE_START_INVALID:{field:'start',text:'Укажите корректные дату и время начала по МСК.'},
 MAINTENANCE_END_INVALID:{field:'end',text:'Укажите корректные дату и время окончания по МСК.'},
 MAINTENANCE_START_PAST:{field:'start',text:'Начало работ уже прошло. Выберите будущее время или нажмите «Начать сейчас».'},
 MAINTENANCE_END_ORDER:{field:'end',text:'Окончание должно быть позже начала работ.'},
 MAINTENANCE_END_PAST:{field:'end',text:'Окончание работ уже прошло. Выберите будущее время.'},
 MAINTENANCE_START_FIXED:{field:'start',text:'Работы уже начались. Дату начала изменить нельзя. Обновите страницу.'},
};
export function ServerMaintenance({refresh}:{refresh:number}){
 const {data,error,loading,reload}=useAdminData<Maintenance>('/control/maintenance',refresh),notify=useAdminNotice();
 const element=useRef<HTMLFormElement>(null),[fieldErrors,setFieldErrors]=useState<Partial<Record<Field,string>>>({});
 function focus(field:string){requestAnimationFrame(()=>{const input=element.current?.elements.namedItem(field);if(input instanceof HTMLElement)input.focus();});}
 const [busy,setBusy]=useState(false),[failure,setFailure]=useState(''),[pending,setPending]=useState<Record<string,unknown>|null>(null);
 useEffect(()=>{const timer=window.setInterval(reload,30000);return()=>window.clearInterval(timer);},[reload]);
 async function save(command:Record<string,unknown>){if(busy)return;setBusy(true);setFailure('');try{await api('/control/maintenance',command);setPending(null);setFieldErrors({});reload();notify('Настройки технических работ сохранены.');}catch(e){const issue=e instanceof ApiError?fieldMessages[e.code]:undefined;if(issue){setPending(null);setFieldErrors({[issue.field]:issue.text});focus(issue.field);}else setFailure(e instanceof Error?e.message:'Не удалось сохранить.');}finally{setBusy(false);}}
 function command(action:string,values?:FormData){if(!data)return;setFailure('');const errors:Partial<Record<Field,string>>={};
  const body:Record<string,unknown>={id:crypto.randomUUID(),revision:data.revision,action};
  if(values){
   const title=String(values.get('title')??''),message=String(values.get('message')??'');body.title=title;body.message=message;
   if(!title.trim())errors.title=fieldMessages.MAINTENANCE_TITLE_REQUIRED!.text;else if(title.length>100)errors.title=fieldMessages.MAINTENANCE_TITLE_LONG!.text;
   if(message.length>1000)errors.message=fieldMessages.MAINTENANCE_MESSAGE_LONG!.text;
   function date(field:'start'|'end'){try{return parseAdminDate(String(values!.get(field)??''),zone);}catch{return errors[field]=fieldMessages['MAINTENANCE_'+field.toUpperCase()+'_INVALID']!.text,undefined;}}
   body.startsAt=action==='start'?data.now:data.phase==='active'?data.startsAt:date('start');body.endsAt=date('end');
   if(typeof body.startsAt==='string'&&action!=='start'&&data.phase!=='active'&&Date.parse(body.startsAt)<Date.parse(data.now))errors.start=fieldMessages.MAINTENANCE_START_PAST!.text;
   if(typeof body.endsAt==='string'){
    if(typeof body.startsAt==='string'&&Date.parse(body.endsAt)<=Date.parse(body.startsAt))errors.end=fieldMessages.MAINTENANCE_END_ORDER!.text;
    else if(Date.parse(body.endsAt)<=Date.parse(data.now))errors.end=fieldMessages.MAINTENANCE_END_PAST!.text;
   }
  }
  setFieldErrors(errors);const first=Object.keys(errors)[0];if(first){focus(first);return;}
  if(['start','finish','cancel'].includes(action))setPending(body);else void save(body);
 }
 const active=data?.phase==='active',planned=data?.phase==='scheduled';
 return <section className={form.card+' '+shell.maintenanceSection}>
  {error&&<p role="alert" className={form.error}>{error}</p>}{loading&&!data&&<p role="status">Загружаем расписание…</p>}{!data&&error&&<button className={common.button} onClick={reload}>Повторить</button>}
  {data&&<><p><strong>{active?'Технические работы идут':planned?'Технические работы запланированы':'Технические работы не идут'}</strong></p>
  {(active||planned)&&<p>{label(data.startsAt)} — {label(data.endsAt)}</p>}
  
  <form ref={element} noValidate key={data.revision} onChange={e=>{const target=e.nativeEvent.target;if(!(target instanceof HTMLInputElement)&&!(target instanceof HTMLTextAreaElement))return;const field=target.name as Field;setFieldErrors(current=>{const next={...current};delete next[field];return next;});setFailure('');}} className={form.renewalBody+' '+shell.maintenanceForm} onSubmit={e=>{e.preventDefault();const action=(e.nativeEvent as SubmitEvent).submitter?.getAttribute('data-action')??(active||planned?'update':'schedule');command(action,new FormData(e.currentTarget));}}>
   <OperationField label="Заголовок" error={fieldErrors.title}><input name="title" maxLength={100} required defaultValue={data.title||'Обновляем CashNeuro'}/></OperationField>
   <OperationField label="Сообщение пользователям" error={fieldErrors.message}><textarea name="message" maxLength={1000} rows={3} defaultValue={data.message} placeholder="Что обновляем и когда планируем вернуться"/></OperationField>
   <div className={form.formRow}><OperationField label="Начало (по МСК)" error={fieldErrors.start}><input className={shell.accessDate} name="start" type="datetime-local" required disabled={active||busy} defaultValue={localAdminDate((active||planned)&&data.startsAt?Date.parse(data.startsAt):Date.now()+3600000,zone)}/></OperationField><OperationField label="Окончание (по МСК)" error={fieldErrors.end}><input className={shell.accessDate} name="end" type="datetime-local" required disabled={busy} defaultValue={localAdminDate(data.endsAt&&Date.parse(data.endsAt)>Date.now()?Date.parse(data.endsAt):Date.now()+7200000,zone)}/></OperationField></div>
   <div className={form.actions}><button className={common.primaryButton} disabled={busy}>{active||planned?'Сохранить изменения':'Запланировать'}</button>{!active&&<button data-action="start" className={common.button} disabled={busy}>Начать сейчас</button>}{planned&&<button type="button" className={common.button} disabled={busy} onClick={()=>command('cancel')}>Отменить работы</button>}{active&&<button type="button" className={common.button} disabled={busy} onClick={()=>command('finish')}>Завершить сейчас</button>}</div>
  </form></>}
  {failure&&!pending&&!Object.keys(fieldErrors).length&&<p role="alert" className={form.error+' '+shell.maintenanceFailure}>{failure}</p>}
  {pending&&<OperationDialog compact title={pending.action==='start'?'Начать технические работы?':pending.action==='finish'?'Открыть сайт для пользователей?':'Отменить запланированные работы?'} onClose={()=>{if(!busy)setPending(null);}} footer={<><button className={common.button} disabled={busy} onClick={()=>setPending(null)}>Назад</button><button className={common.primaryButton} disabled={busy} onClick={()=>void save(pending)}>Подтвердить</button></>}>
   <p>{pending.action==='start'?'Пользовательский сайт перейдёт на страницу технических работ. Уже начатые операции завершатся безопасно.':pending.action==='finish'?'Убедитесь, что пользовательский API и сайт готовы. Пользователи смогут вернуться в приложение.':'Пользователи увидят обновление об отмене работ.'}</p>{failure&&<p role="alert" className={form.error}>{failure}</p>}
  </OperationDialog>}
 </section>;
}
