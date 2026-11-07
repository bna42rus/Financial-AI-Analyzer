import {useMailCooldown} from './use-mail-cooldown';
import type {MailSend} from './use-mail-cooldown';
import {useState} from 'react';
import {OperationDialog,OperationField} from './OperationDialog';
import {TimezonePicker} from './InterfaceSettings';
import {api,ApiError} from './server-client';
import type {Session} from './server-client';
import common from './App.module.css';
import workspace from './Workspace.module.css';
export type AccountProfileField='name'|'email'|'timezone';
export function AccountProfileEditor({field,session,onClose,onSaved}:{field:AccountProfileField;session:Session;onClose:()=>void;onSaved:()=>Promise<void>}){
 const [value,setValue]=useState(field==='name'?session.name:field==='timezone'?session.timezone??'device':''),[secret,setSecret]=useState(''),[code,setCode]=useState(''),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[where,setWhere]=useState('');
 const mail=useMailCooldown();
 const title=field==='name'?'Изменить имя':field==='timezone'?'Часовой пояс':'Изменить почту';
 function issue(place:string,message:string){setWhere(place);setError(message);}
 async function submit(){
  if(busy||field==='email'&&!confirm&&mail.seconds)return;issue('','');
  if(!confirm&&(!value.trim()||field==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))){issue('value',field==='email'?'Укажите новый адрес почты.':'Укажите имя.');return;}
  if(field==='email'&&!confirm&&value.trim().toLocaleLowerCase()===session.email?.toLocaleLowerCase()){issue('value','Укажите адрес, отличный от текущего.');return;}
  if(field==='email'&&!(confirm?code.trim():secret)){issue(confirm?'code':'password',confirm?'Введите код из письма.':'Введите текущий пароль.');return;}
  setBusy(true);
  try{
   if(field==='email'&&!confirm){mail.remember(await api<MailSend>('/account/email-request',{email:value.trim(),password:secret}));setConfirm(true);setSecret('');return;}
   if(field==='email')await api('/account/email-confirm',{code:code.trim()});
   if(field==='name')await api('/account/name',{name:value.trim()});
   if(field==='timezone')await api('/account/timezone',{timezone:value==='device'?Intl.DateTimeFormat().resolvedOptions().timeZone:value});
   if(field==='timezone')try{if(value==='device')localStorage.setItem('cashneuro-timezone-device','yes');else localStorage.removeItem('cashneuro-timezone-device');}catch{/* Optional preference. */}
   await onSaved();onClose();
  }catch(e){if(field==='email'&&!confirm)mail.remember(e);const tag=e instanceof ApiError?e.code:'';if(tag==='INVALID_CREDENTIALS')issue('password','Пароль не подходит.');else if(tag==='INVALID_TOKEN')issue('code','Код не подходит или истёк.');else if(tag==='EMAIL_UNAVAILABLE')issue(confirm?'code':'value','Этот адрес недоступен.');else issue(field==='timezone'?'value':confirm?'code':'form',e instanceof Error?e.message:'Не удалось сохранить изменения.');}
  finally{setBusy(false);}
 }
 return <OperationDialog narrow title={title} onClose={()=>{if(!busy)onClose();}} footer={<><button className={common.button} disabled={busy} onClick={onClose}>Отменить</button><button type="submit" className={common.primaryButton} form="account-profile-editor" disabled={busy||field==='email'&&!confirm&&mail.seconds>0}>{field!=='email'?'Сохранить':confirm?'Подтвердить':(mail.label??'Отправить код')}</button></>}>
  <form id="account-profile-editor" className={workspace.form} onSubmit={e=>{e.preventDefault();void submit();}} noValidate>
   {field==='timezone'?<OperationField label="Часовой пояс" error={where==='value'?error:undefined}><TimezonePicker disabled={busy} value={value} onChange={setValue}/></OperationField>:!confirm&&<OperationField label={field==='name'?'Имя':'Новый адрес почты'} error={where==='value'?error:undefined}><input type={field==='email'?'email':'text'} autoComplete={field==='email'?'email':'name'} maxLength={field==='email'?254:100} disabled={busy} value={value} onChange={e=>{setValue(e.target.value);issue('','');}}/></OperationField>}
   {field==='email'&&(confirm?<><p>{value?`Введите код из письма на ${value}.`:"Введите код, который мы отправили на новый адрес."}</p><OperationField label="Код из письма" error={where==='code'?error:undefined}><input autoComplete="one-time-code" maxLength={100} value={code} disabled={busy} onChange={e=>{setCode(e.target.value);issue('','');}}/></OperationField><button type="button" className={common.linkButton} disabled={busy} onClick={()=>{setConfirm(false);setCode('');issue('','');}}>Изменить адрес</button></>:<><OperationField label="Текущий пароль" error={where==='password'?error:undefined}><input type="password" autoComplete="current-password" maxLength={128} disabled={busy} value={secret} onChange={e=>{setSecret(e.target.value);issue('','');}}/></OperationField><button type="button" className={common.linkButton} disabled={busy} onClick={()=>{setValue('');setSecret('');issue('','');setConfirm(true);}}>У меня уже есть код</button></>)}
   {where==='form'&&<p role="alert" className={common.error}>{error}</p>}
  </form>
 </OperationDialog>;
}
