import {Trash2} from 'lucide-react';
import {useEffect,useState} from 'react';
import {OperationDialog,OperationField} from './OperationDialog';
import {api,ApiError} from './server-client';
import {useMailCooldown} from './use-mail-cooldown';
import {dateLabel} from '../../../packages/access/src/model';
import common from './App.module.css';
import styles from './ServerAccess.module.css';

type Status={status:'none'|'awaiting_code'|'pending';expiresAt?:string;requestedAt?:string};
const endpoint='/access/profile/deletion';

export function AccountDeletion({email}:{email:string}){
 const mail=useMailCooldown(email);
 const [state,setState]=useState<Status|null>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[fieldError,setFieldError]=useState(''),[note,setNote]=useState(''),[restart,setRestart]=useState(false);
 useEffect(()=>{
  const abort=new AbortController();
  void api<Status>(endpoint,undefined,abort.signal).then(setState).catch(()=>{});
  return()=>abort.abort();
 },[email]);
 async function request(path:string,body?:Record<string,unknown>){
  setBusy(true);setError('');setFieldError('');
  try{
   const next=await api<Status>(endpoint+path,body);
   mail.remember(next);setState(next);
   if(path==='-start')setRestart(false);
   if(path==='-confirm'){setOpen(false);}
   if(path==='-cancel'){setNote('Заявка отозвана.');setOpen(false);}
  }catch(e){
   mail.remember(e);
   if(e instanceof ApiError&&e.code==='INVALID_CREDENTIALS'&&path==='-start')setFieldError('Неверный пароль.');
   else if(e instanceof ApiError&&e.code==='DELETION_CODE_INVALID')setFieldError('Код неверен или истёк. Проверьте код или запросите новый.');
   else setError(e instanceof Error?e.message:'Не удалось выполнить действие.');
  }finally{setBusy(false);}
 }
 const waiting=state?.status==='awaiting_code'&&!restart,pending=state?.status==='pending';
 return <section className={styles.accountSection}>
  <h2><Trash2 size={18}/>Удаление аккаунта</h2>
  {pending&&<p>Заявка на рассмотрении. Её можно отозвать до начала удаления.</p>}
  {note&&<p role="status">{note}</p>}
  <button className={common.dangerButton} disabled={busy} onClick={()=>{setNote('');setRestart(false);setOpen(true);void request('');}}>{pending?'Посмотреть заявку':waiting?'Подтвердить заявку':'Подать заявку на удаление'}</button>
  {open&&<OperationDialog title={pending?'Заявка на удаление':waiting?'Подтверждение заявки':'Удаление аккаунта CashNeuro'} compact onClose={()=>{if(!busy)setOpen(false);}} footer={<>
   <button className={common.button} disabled={busy} onClick={()=>setOpen(false)}>{pending?'Закрыть':'Отмена'}</button>
   {pending?<button className={common.button} disabled={busy} onClick={()=>void request('-cancel',{})}>Отозвать заявку</button>:
    <button type="submit" form="account-deletion" className={waiting?common.dangerButton:common.primaryButton} disabled={busy||!waiting&&!!mail.seconds}>{waiting?'Отправить заявку':mail.label??'Получить код'}</button>}
  </>}>
   {pending?<div className={styles.renewalBody}><p>Заявка подана {dateLabel(state?.requestedAt??null)}.</p><p>Сообщим о результате на <strong>{email}</strong>. До рассмотрения заявку можно отозвать.</p></div>:waiting?
   <form className={styles.renewalBody} id="account-deletion" onSubmit={e=>{e.preventDefault();void request('-confirm',{code:String(new FormData(e.currentTarget).get('code')).trim()});}}>
    <p>Введите шестизначный код из письма на <strong>{email}</strong>. Код действует 15 минут.</p>
    <OperationField label="Код из письма" error={fieldError||undefined}><input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" required onChange={()=>setFieldError('')}/></OperationField>
    <button type="button" className={common.linkButton} disabled={busy||!!mail.seconds} onClick={()=>{setFieldError('');setRestart(true);}}>{mail.label??'Запросить новый код'}</button>
   </form>:<form className={styles.renewalBody} id="account-deletion" onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);void request('-start',{password:data.get('password'),confirm:data.get('confirm')==='on'});}}>
    <p>Подтвердите заявку паролем и кодом из письма. После проверки администратором удалим профиль, выписки, операции, настройки и историю Анализатора. Все сеансы завершатся, автопродление отключится.</p>
    <OperationField label="Текущий пароль" error={fieldError||undefined}><input name="password" type="password" autoComplete="current-password" required maxLength={128} onChange={()=>setFieldError('')}/></OperationField>
    <div className={styles.legalChoice}><input id="confirm-account-deletion" type="checkbox" name="confirm" required/><label htmlFor="confirm-account-deletion">Подтверждаю, что осознаю последствия удаления аккаунта.</label></div>
    <p className={styles.deletionFootnote}>О хранении платёжных сведений и подтверждения удаления — в <a href="/privacy" target="_blank" rel="noreferrer">политике обработки персональных данных</a>.</p>
   </form>}
   {error&&<p role="alert" className={styles.error}>{error}</p>}
  </OperationDialog>}
 </section>;
}
