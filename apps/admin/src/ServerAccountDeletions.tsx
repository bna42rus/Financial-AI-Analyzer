import {useEffect,useState} from 'react';
import {api,ApiError} from '../../web/src/server-client';
import {OperationDialog,OperationField} from '../../web/src/OperationDialog';
import {SearchField,foldSearch} from '../../web/src/SearchFilter';
import {dateLabel} from '../../../packages/access/src/model';
import styles from '../../web/src/ServerAccess.module.css';
import common from '../../web/src/App.module.css';

type Preview={operations:number;imports:number;dialogs:number};
type Deletion={id:string;email:string;requestedAt:string};
export function ServerAccountDeletions(){
 const [rows,setRows]=useState<Deletion[]|null>(null),[query,setQuery]=useState(''),[target,setTarget]=useState<Deletion|null>(null),[email,setEmail]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[preview,setPreview]=useState<Preview|null>(null);
 useEffect(()=>{
  const abort=new AbortController();
  void api<{requests:Deletion[]}>('/control/account-deletions',undefined,abort.signal).then(r=>setRows(r.requests)).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
  return()=>abort.abort();
 },[]);
 useEffect(()=>{
  if(!target)return;
  const abort=new AbortController();
  void api<Preview>('/control/account-deletion-preview',{id:target.id},abort.signal).then(r=>{if(!abort.signal.aborted)setPreview(r);}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
  return()=>abort.abort();
 },[target]);
 const visible=rows?.filter(row=>foldSearch(row.email).includes(foldSearch(query.trim())))??[];
 async function approve(code:string){
  if(!target||email.trim().toLowerCase()!==target.email)return;
  setBusy(true);setError('');
  try{
   await api('/control/account-deletion-approve',{id:target.id,email:email.trim(),code});
   setRows(previous=>previous?.filter(row=>row.id!==target.id)??null);
   setTarget(null);setNotice('Аккаунт удалён. Подтверждение поставлено в очередь отправки.');
  }catch(e){
   setError(e instanceof Error?e.message:'Не удалось подтвердить удаление.');
   if(e instanceof ApiError&&['DELETION_NOT_PENDING','DELETION_EMAIL_CHANGED'].includes(e.code)){
    setRows(previous=>previous?.filter(row=>row.id!==target.id)??null);setTarget(null);
   }
  }finally{setBusy(false);}
 }
 return <section className={styles.card}>
  <h2>Удаление аккаунтов</h2>
  <SearchField value={query} onValueChange={setQuery} placeholder="Почта" aria-label="Поиск заявок на удаление"/>
  {notice&&<p className={styles.success} role="status">{notice}</p>}
  {error&&!target&&<p className={styles.error} role="alert">{error}</p>}
  {!rows&&!error&&<p role="status">Загружаем заявки…</p>}
  {rows&&!visible.length&&<p>{query?'Подходящих заявок нет.':'Заявок на удаление пока нет.'}</p>}
  {visible.map(row=><article key={row.id} className={styles.record}><strong>{row.email}</strong><p>Подтверждено владельцем · {dateLabel(row.requestedAt)}</p>
   <button className={common.button} onClick={()=>{setTarget(row);setPreview(null);setEmail('');setError('');setNotice('');}}>Проверить заявку</button>
  </article>)}
  {target&&<OperationDialog title="Подтвердить удаление аккаунта" compact onClose={()=>{if(!busy){setTarget(null);setError('');}}} footer={<>
   <button className={common.button} disabled={busy} onClick={()=>{setTarget(null);setError('');}}>Назад</button>
   <button className={common.dangerButton} type="submit" form="approve-account-deletion" disabled={busy||!preview||email.trim().toLowerCase()!==target.email}>Удалить аккаунт</button>
  </>}>
   <p>Владелец {target.email} подтвердил заявку {dateLabel(target.requestedAt)}. Проверьте адрес перед необратимым удалением.</p>
   <p>Будут удалены профиль и данные кабинета. Активные сеансы и автопродление завершатся. Платёжные записи и подтверждение удаления хранятся отдельно.</p>
   {preview?<ul><li>Операции · {preview.operations.toLocaleString('ru-RU')}</li><li>Загрузки · {preview.imports.toLocaleString('ru-RU')}</li><li>Диалоги Анализатора · {preview.dialogs.toLocaleString('ru-RU')}</li></ul>:!error&&<p role="status">Проверяем данные аккаунта…</p>}
   <form id="approve-account-deletion"  onSubmit={e=>{e.preventDefault();void approve(String(new FormData(e.currentTarget).get('code')).trim());}}>
    <OperationField label="Введите адрес аккаунта"><input type="email" value={email} onChange={e=>setEmail(e.currentTarget.value)} autoComplete="off" required/></OperationField>
    <OperationField label="Код из приложения-аутентификатора" error={error}><input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></OperationField>
   </form>
  </OperationDialog>}
 </section>;
}
