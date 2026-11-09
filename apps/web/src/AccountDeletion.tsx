import {useMailCooldown} from './use-mail-cooldown';
import {useEffect,useState} from 'react';
import {OperationDialog,OperationField} from './OperationDialog';
import {api,ApiError} from './server-client';
import {dateLabel} from '../../../packages/access/src/model';
import common from './App.module.css';
import styles from './ServerAccess.module.css';

type Status={status:'none'|'awaiting_code'|'pending';expiresAt?:string;requestedAt?:string};
export function AccountDeletion({email}:{email:string}){
 const mail=useMailCooldown(email);
 const [state,setState]=useState<Status|null>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState('');
 useEffect(()=>{
  const abort=new AbortController();
  void api<Status>('/account/deletion',undefined,abort.signal).then(setState).catch(()=>{});
  return()=>abort.abort();
 },[email]);
 async function request(path:string,body?:Record<string,unknown>){
  setBusy(true);setError('');
  try{
   const next=await api<Status>('/account/deletion'+path,body);
   mail.remember(next);setState(next);
   if(path==='-confirm'){setNote('Заявка отправлена администратору.');setOpen(false);}
   if(path==='-cancel'&&state?.status==='pending'){setNote('Заявка отозвана.');setOpen(false);}
  }catch(e){
   mail.remember(e);
   if(e instanceof ApiError&&e.code==='DELETION_CODE_INVALID')setError('Код неверен или истёк. Можно запросить новый.');
   else setError(e instanceof Error?e.message:'Не удалось выполнить действие.');
  }finally{setBusy(false);}
 }
 const waiting=state?.status==='awaiting_code',pending=state?.status==='pending';
 return <section className={styles.accountSection}>
  <h2>Удаление аккаунта</h2>
  <p>{pending?'Заявка на рассмотрении. Её можно отозвать до начала удаления.':'Можно подать заявку, в том числе после окончания доступа.'}</p>
  {note&&<p role="status">{note}</p>}
  <button className={common.dangerButton} disabled={busy} onClick={()=>{setNote('');setError('');setOpen(true);void request('');}}>{pending?'Посмотреть заявку':waiting?'Подтвердить заявку':'Подать заявку на удаление'}</button>
  {open&&<OperationDialog title={pending?'Заявка на удаление':'Удаление аккаунта CashNeuro'} compact onClose={()=>{if(!busy)setOpen(false);}} footer={<>
   <button className={common.button} disabled={busy} onClick={()=>setOpen(false)}>Закрыть</button>
   {pending?<button className={common.button} disabled={busy} onClick={()=>void request('-cancel',{})}>Отозвать заявку</button>:
    <button type="submit" form="account-deletion" className={waiting?common.dangerButton:common.primaryButton} disabled={busy||!waiting&&!!mail.seconds}>{waiting?'Отправить заявку':mail.label??'Получить код'}</button>}
  </>}>
   {pending?<p>Заявка подана {dateLabel(state?.requestedAt??null)}. О результате сообщим на {email}.</p>:waiting?<form id="account-deletion" onSubmit={e=>{e.preventDefault();void request('-confirm',{code:String(new FormData(e.currentTarget).get('code')).trim()});}}>
    <p>Введите шестизначный код из письма на {email}. Действует 15 минут.</p>
    <OperationField label="Код из письма" error={error}><input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" required/></OperationField>
    <button type="button" className={common.linkButton} disabled={busy||!!mail.seconds} onClick={()=>void request('-cancel',{})}>{mail.label??'Запросить новый код'}</button>
   </form>:<form id="account-deletion" onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);void request('-start',{password:form.get('password'),confirm:form.get('confirm')==='on'});}}>
    <p>После подтверждения администратором удалим профиль, выписки, операции, настройки и историю Анализатора. Все сеансы завершатся, автопродление отключится.</p>
    <p>Платёжные сведения и подтверждение удаления могут храниться отдельно. Условия хранения описаны в <a href="/privacy" target="_blank" rel="noreferrer">политике обработки данных</a>.</p>
    <OperationField label="Текущий пароль" error={error}><input name="password" type="password" autoComplete="current-password" required maxLength={128}/></OperationField>
    <label className={styles.legalChoice}><input type="checkbox" name="confirm" required/> Я понимаю, что после удаления восстановить данные кабинета будет невозможно.</label>
   </form>}
   {pending&&error&&<p role="alert" className={styles.error}>{error}</p>}
  </OperationDialog>}
 </section>;
}
