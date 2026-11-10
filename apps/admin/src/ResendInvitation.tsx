import {useState} from 'react';
import {useMailCooldown} from '../../web/src/use-mail-cooldown';
import type {MailSend} from '../../web/src/use-mail-cooldown';
import {api} from '../../web/src/server-client';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {useAdminNotice} from './admin-view';
import styles from '../../web/src/ServerAccess.module.css';
import common from '../../web/src/App.module.css';

export function ResendInvitation({invitationId,disabled,onResent}:{invitationId:string;disabled:boolean;onResent:()=>Promise<void>}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reason,setReason]=useState(''),[command,setCommand]=useState<{actionId:string;invitationId:string;reason:string}|null>(null);
 const mail=useMailCooldown(invitationId),notify=useAdminNotice();
 function close(){if(!busy){setOpen(false);setCommand(null);setReason('');setError('');}}
 async function send(){
  if(!command||busy||disabled||mail.seconds)return;
  setBusy(true);setError('');
  try{mail.remember(await api<MailSend>('/control/invitation-resend',command));setOpen(false);setCommand(null);setReason('');notify('Приглашение поставлено в очередь повторно.');await onResent();}
  catch(e){mail.remember(e);setError(e instanceof Error?e.message:'Не удалось повторить отправку.');}
  finally{setBusy(false);}
 }
 return <><button className={styles.secondary} disabled={disabled||busy||mail.seconds>0} onClick={()=>setOpen(true)}>{mail.label??'Отправить приглашение повторно'}</button>
 {open&&<OperationDialog narrow title={command?'Подтвердить повторную отправку':'Отправить приглашение повторно'} onClose={close} footer={<>
  <button className={common.button} disabled={busy} onClick={()=>{if(command){setCommand(null);setError('');}else close();}}>{command?'Назад':'Отмена'}</button>
  {command?<button className={common.primaryButton} disabled={busy||disabled||!!mail.seconds} onClick={()=>void send()}>{mail.label??'Подтвердить'}</button>:<button form="invitation-resend-form" type="submit" className={common.primaryButton}>Продолжить</button>}
 </>}>
  <div className={styles.renewalBody}>
   <p>Отправится та же действующая ссылка. Срок ссылки, оплата и период доступа сохраняются.</p>
   {command?<><p>Заметка: {command.reason}</p>{error&&<p role="alert" className={styles.error}>{error}</p>}</>:<form id="invitation-resend-form" onSubmit={e=>{e.preventDefault();if(!reason.trim()){setError('Добавьте заметку.');return;}setCommand({actionId:crypto.randomUUID(),invitationId,reason:reason.trim()});}}>
    <OperationField label="Заметка приглашения" error={error||undefined}><textarea value={reason} maxLength={1000} rows={2} onChange={e=>{setReason(e.target.value);setError('');}}/></OperationField>
   </form>}
  </div>
 </OperationDialog>}</>;
}
