import {useEffect,useState} from 'react';
import {api,ApiError} from '../../web/src/server-client';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {useAdminTime} from './admin-view';
import styles from '../../web/src/ServerAccess.module.css';
import common from '../../web/src/App.module.css';

type Preview={operations:number;imports:number;dialogs:number};
export type DeletionReviewTarget={id:string;email:string;requestedAt:string};
export function AccountDeletionReview({target,onClose,onComplete}:{target:DeletionReviewTarget;onClose:()=>void;onComplete:()=>void}){
 const [preview,setPreview]=useState<Preview|null>(null),[code,setCode]=useState(''),[error,setError]=useState(''),[field,setField]=useState(''),[busy,setBusy]=useState(false);
 const time=useAdminTime();
 useEffect(()=>{let stopped=false;setBusy(true);void api<Preview>('/control/account-deletion-preview',{id:target.id}).then(value=>{if(!stopped)setPreview(value);}).catch(e=>{if(!stopped)setError(e.message);}).finally(()=>{if(!stopped)setBusy(false);});return()=>{stopped=true;};},[target.id]);
 async function submit(){
  if(busy)return;
  setError('');setField('');

  if(preview&&!/^\d{6}$/.test(code)){setField('code');setError('Введите шестизначный код.');return;}
  setBusy(true);
  try{
   if(!preview)setPreview(await api<Preview>('/control/account-deletion-preview',{id:target.id}));
   else{await api('/control/account-deletion-approve',{id:target.id,code});onComplete();}
  }catch(e){if(e instanceof ApiError&&e.code==='DELETION_ADMIN_CODE_INVALID')setField('code');setError(e instanceof Error?e.message:'Не удалось выполнить действие.');}
  finally{setBusy(false);}
 }
 return <OperationDialog compact title="Подтвердить удаление аккаунта" onClose={()=>{if(!busy)onClose();}} footer={<>
  <button className={common.button} disabled={busy} onClick={onClose}>Отмена</button>
  <button className={common.dangerButton} disabled={busy||!preview} onClick={()=>void submit()}>Удалить аккаунт</button>
 </>}>
  <div className={styles.renewalBody}><p><strong>{target.email}</strong> подтвердил заявку {time.format(target.requestedAt)}.</p>
   <p>Будут удалены профиль и данные кабинета. Сеансы завершатся, автопродление отключится. Платёжные сведения и подтверждение удаления хранятся отдельно.</p>
   {<><OperationField label="Код из приложения-аутентификатора" error={field==='code'?error:undefined}><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e=>{setCode(e.target.value.replace(/\D/g,''));setField('');setError('');}}/></OperationField>
   </>}
   {!field&&error&&<p className={styles.error} role="alert">{error}</p>}
  </div>
 </OperationDialog>;
}
