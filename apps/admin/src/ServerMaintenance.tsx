import {useEffect,useState} from 'react';
import type {Maintenance} from '../../../packages/access/src/maintenance';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {api} from '../../web/src/server-client';
import {localAdminDate,parseAdminDate,useAdminData,useAdminNotice} from './admin-view';
import common from '../../web/src/App.module.css';
import form from '../../web/src/ServerAccess.module.css';
import shell from './ServerAdmin.module.css';
const zone='Europe/Moscow',label=(v:string|null)=>v?new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:zone}).format(new Date(v))+' по МСК':'—';
export function ServerMaintenance({refresh}:{refresh:number}){
 const {data,error,loading,reload}=useAdminData<Maintenance>('/control/maintenance',refresh),notify=useAdminNotice();
 const [busy,setBusy]=useState(false),[failure,setFailure]=useState(''),[pending,setPending]=useState<Record<string,unknown>|null>(null);
 useEffect(()=>{const timer=window.setInterval(reload,30000);return()=>window.clearInterval(timer);},[reload]);
 async function save(command:Record<string,unknown>){if(busy)return;setBusy(true);setFailure('');try{await api('/control/maintenance',command);setPending(null);reload();notify('Настройки технических работ сохранены.');}catch(e){setFailure(e instanceof Error?e.message:'Не удалось сохранить.');}finally{setBusy(false);}}
 function command(action:string,values?:FormData){if(!data)return;setFailure('');try{
  const body:Record<string,unknown>={id:crypto.randomUUID(),revision:data.revision,action};
  if(values){body.title=String(values.get('title')??'');body.message=String(values.get('message')??'');body.startsAt=data.phase==='active'?data.startsAt:parseAdminDate(String(values.get('start')),zone);body.endsAt=parseAdminDate(String(values.get('end')),zone);}
  if(['start','finish','cancel'].includes(action))setPending(body);else void save(body);
 }catch(e){setFailure(e instanceof Error?e.message:'Проверьте даты.');}}
 const active=data?.phase==='active',planned=data?.phase==='scheduled';
 return <section className={form.card+' '+shell.maintenanceSection}>
  {error&&<p role="alert" className={form.error}>{error}</p>}{loading&&!data&&<p role="status">Загружаем расписание…</p>}{!data&&error&&<button className={common.button} onClick={reload}>Повторить</button>}
  {data&&<><p><strong>{active?'Технические работы идут':planned?'Технические работы запланированы':'Технические работы не идут'}</strong></p>
  {(active||planned)&&<p>{label(data.startsAt)} — {label(data.endsAt)}</p>}
  
  <form key={data.revision} className={form.renewalBody+' '+shell.maintenanceForm} onSubmit={e=>{e.preventDefault();const action=(e.nativeEvent as SubmitEvent).submitter?.getAttribute('data-action')??(active||planned?'update':'schedule');command(action,new FormData(e.currentTarget));}}>
   <OperationField label="Заголовок"><input name="title" maxLength={100} required defaultValue={data.title||'Обновляем CashNeuro'}/></OperationField>
   <OperationField label="Сообщение пользователям"><textarea name="message" maxLength={1000} rows={3} defaultValue={data.message} placeholder="Что обновляем и когда планируем вернуться"/></OperationField>
   <div className={form.formRow}><OperationField label="Начало (по МСК)"><input className={shell.accessDate} name="start" type="datetime-local" required disabled={active||busy} defaultValue={localAdminDate((active||planned)&&data.startsAt?Date.parse(data.startsAt):Date.now()+3600000,zone)}/></OperationField><OperationField label="Окончание (по МСК)"><input className={shell.accessDate} name="end" type="datetime-local" required disabled={busy} defaultValue={localAdminDate(data.endsAt&&Date.parse(data.endsAt)>Date.now()?Date.parse(data.endsAt):Date.now()+7200000,zone)}/></OperationField></div>
   <div className={form.actions}><button className={common.primaryButton} disabled={busy}>{active||planned?'Сохранить изменения':'Запланировать'}</button>{!active&&<button data-action="start" className={common.button} disabled={busy}>Начать сейчас</button>}{planned&&<button type="button" className={common.button} disabled={busy} onClick={()=>command('cancel')}>Отменить работы</button>}{active&&<button type="button" className={common.button} disabled={busy} onClick={()=>command('finish')}>Завершить сейчас</button>}</div>
  </form></>}
  {failure&&<p role="alert" className={form.error}>{failure}</p>}
  {pending&&<OperationDialog compact title={pending.action==='start'?'Начать технические работы?':pending.action==='finish'?'Открыть сайт для пользователей?':'Отменить запланированные работы?'} onClose={()=>{if(!busy)setPending(null);}} footer={<><button className={common.button} disabled={busy} onClick={()=>setPending(null)}>Назад</button><button className={common.primaryButton} disabled={busy} onClick={()=>void save(pending)}>Подтвердить</button></>}>
   <p>{pending.action==='start'?'Пользовательский сайт перейдёт на страницу технических работ. Уже начатые операции завершатся безопасно.':pending.action==='finish'?'Убедитесь, что пользовательский API и сайт готовы. Пользователи смогут вернуться в приложение.':'Пользователи увидят обновление об отмене работ.'}</p>{failure&&<p role="alert" className={form.error}>{failure}</p>}
  </OperationDialog>}
 </section>;
}
