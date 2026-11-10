import {Pencil,ShieldCheck,UserRound} from 'lucide-react';
import {useState} from 'react';
import {api} from '../../web/src/server-client';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {TimezonePicker,timezoneLabel} from '../../web/src/InterfaceSettings';
import {useMailCooldown} from '../../web/src/use-mail-cooldown';
import type {MailSend} from '../../web/src/use-mail-cooldown';
import {useAdminData,useAdminTime,useAdminNotice} from './admin-view';
import common from '../../web/src/App.module.css';
import styles from '../../web/src/ServerAccess.module.css';
import shell from './ServerAdmin.module.css';

type Login={id:string;createdAt:string;current:boolean;device?:string};
type Panel='timezone'|'password'|'sessions';
export function ServerAdminAccount({email,timezone,onTimezone}:{email:string;timezone:string;onTimezone:(zone:string)=>void}){
 const [panel,setPanel]=useState<Panel|null>(null),[zone,setZone]=useState(timezone),[busy,setBusy]=useState(false),[error,setError]=useState(''),[review,setReview]=useState(false);
 const time=useAdminTime(),notify=useAdminNotice(),mail=useMailCooldown(email);
 function open(value:Panel){setError('');setReview(false);setZone(timezone);setPanel(value);}
 async function act(){
  if(busy||panel==='password'&&mail.seconds)return;
  setBusy(true);setError('');
  try{
   if(panel==='timezone'){const result=await api<{timezone:string}>('/control/admin-preferences',{timezone:zone});onTimezone(result.timezone);setPanel(null);notify('Часовой пояс сохранён.');}
   else{mail.remember(await api<MailSend>('/security/reset-request',{email}));setPanel(null);notify('Ссылка для смены пароля запрошена. Проверьте почту.');}
  }catch(e){if(panel==='password')mail.remember(e);setError(e instanceof Error?e.message:'Не удалось сохранить.');}
  finally{setBusy(false);}
 }
 return <div className={styles.accountStack+' '+shell.account}>
  <section className={styles.accountSection}><h2><UserRound size={18}/>Профиль</h2><dl>
   <div><dt>Почта</dt><dd className={styles.profileValue}>{email}</dd></div>
   <div><dt>Часовой пояс</dt><dd className={styles.profileValue}><span>{time.label}</span><button type="button" className={common.iconButton} aria-label="Изменить часовой пояс" onClick={()=>open('timezone')}><Pencil size={16}/></button></dd></div>
  </dl></section>
  <section className={styles.accountSection}><h2><ShieldCheck size={18}/>Безопасность</h2><p>Двухфакторная защита включена</p><div className={styles.accountActions}>
   <button className={common.button} onClick={()=>open('sessions')}>Активные сеансы</button><button className={common.button} onClick={()=>open('password')}>Сменить пароль</button>
  </div></section>
  {panel==='sessions'&&<AdminSessions onClose={()=>setPanel(null)}/>}
  {(panel==='timezone'||panel==='password')&&<OperationDialog narrow title={panel==='timezone'?(review?'Подтверждение изменений':'Часовой пояс'):'Смена пароля'} onClose={()=>{if(!busy)setPanel(null);}} footer={<>
   <button className={common.button} disabled={busy} onClick={()=>{if(review){setReview(false);setError('');}else setPanel(null);}}>{review?'Назад':'Отмена'}</button>
   {<button className={common.primaryButton} disabled={busy||(panel==='timezone'?zone===timezone:!email||!!mail.seconds)} onClick={()=>{if(panel==='timezone'&&!review){setReview(true);setError('');}else void act();}}>{panel==='timezone'?(review?'Подтвердить':'Продолжить'):mail.label??'Отправить ссылку'}</button>}
  </>}>
   {panel==='timezone'?<div className={styles.renewalBody}>{review?<><p>Часовой пояс: {time.label} → {zone==='device'?'Как на устройстве':timezoneLabel(zone)}.</p>{error&&<p className={styles.error} role="alert">{error}</p>}</>:<OperationField label="Часовой пояс" error={error||undefined}><TimezonePicker value={zone} onChange={setZone} disabled={busy}/></OperationField>}</div>:<>
    <p>Отправим ссылку на {email}. После смены пароля потребуется войти заново.</p>
    {error&&<p className={styles.error} role="alert">{error}</p>}
   </>}
  </OperationDialog>}
 </div>;
}
function AdminSessions({onClose}:{onClose:()=>void}){
 const {data,setData,error,loading,reload}=useAdminData<{sessions:Login[]}>('/security/sessions',0);
 const [target,setTarget]=useState<Login|null>(null),[busy,setBusy]=useState(false),[failure,setFailure]=useState('');
 const time=useAdminTime(),notify=useAdminNotice();
 async function end(){
  if(!target||busy)return;
  setBusy(true);setFailure('');
  try{await api('/security/revoke-session',{sessionId:target.id});setData(before=>before?{sessions:before.sessions.filter(s=>s.id!==target.id)}:before);setTarget(null);notify('Сеанс завершён.');}
  catch(e){setFailure(e instanceof Error?e.message:'Не удалось завершить сеанс.');}
  finally{setBusy(false);}
 }
 return <OperationDialog compact title={target?'Завершить сеанс?':'Активные сеансы'} onClose={()=>{if(!busy){if(target)setTarget(null);else onClose();}}} footer={<>
  <button className={common.button} disabled={busy} onClick={()=>target?setTarget(null):onClose()}>{target?'Назад':'Закрыть'}</button>
  {target&&<button className={common.dangerButton} disabled={busy} onClick={()=>void end()}>Завершить сеанс</button>}
 </>}>
 {target?<><p>Для входа на устройстве {target.device??'в другом сеансе'} потребуется повторная авторизация.</p>{failure&&<p role="alert" className={styles.error}>{failure}</p>}</>:<>
 {loading&&!data&&<p role="status">Загружаем сеансы…</p>}
 {error&&<><p role="alert" className={styles.error}>{error}</p><button className={common.button} onClick={reload}>Повторить</button></>}
 <ul className={styles.sessions}>{data?.sessions.map(row=><li key={row.id}><div><strong>{row.device??'Устройство не определено'}</strong><small>{row.current?'Текущий сеанс · ':''}{time.format(row.createdAt)}</small></div>{!row.current&&<button className={common.dangerButton} onClick={()=>{setFailure('');setTarget(row);}}>Завершить</button>}</li>)}</ul></>}
 </OperationDialog>;
}
