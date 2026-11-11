import {useEffect,useState} from 'react';
import {SearchField,foldSearch} from '../../web/src/SearchFilter';
import {AccountDeletionReview} from './ServerAccountDeletions';
import {useAdminData,useAdminTime,useAdminNotice} from './admin-view';
import styles from '../../web/src/ServerAccess.module.css';
import shell from './ServerAdmin.module.css';
type Row={id:string;email:string;at:string;type:'deletion';status:'decision'};
export type RequestFilters={query:string};
export const initialRequestFilters:RequestFilters={query:''};
export function ServerRequests({refresh,target,initialSearch,filters,onFilters}:{refresh:number;target?:string;initialSearch?:string;filters:RequestFilters;onFilters:(value:RequestFilters)=>void}){
 const {data,error,loading,reload}=useAdminData<{requests:Row[]}>('/control/workspace-requests'+(target?'?id='+encodeURIComponent(target):''),refresh);
 const [deletion,setDeletion]=useState<Row|null>(null),time=useAdminTime(),notify=useAdminNotice();
 useEffect(()=>{if(initialSearch!==undefined)onFilters({query:initialSearch});},[initialSearch]);
 const visible=data?.requests.filter(r=>r.id===target||foldSearch(r.email??'').includes(foldSearch(filters.query.trim())));
 return <section className={styles.card}><p>Заявки пользователей, требующие решения администратора.</p><div className={shell.filters}><SearchField value={filters.query} onValueChange={query=>onFilters({query})} placeholder="Поиск по почте" aria-label="Поиск заявок"/></div>
 {error&&<p role="alert" className={styles.error}>{error}</p>}{loading&&!data&&<p role="status">Загружаем заявки…</p>}{visible?.length===0&&<p>Заявок на рассмотрении нет.</p>}
 <div className={shell.records+' '+shell.recordCards}>{visible?.map(row=><article key={row.id} data-highlight={row.id===target}><div className={shell.paymentHead}><strong>{row.email}</strong><span className={shell.attention}>Ожидает решения</span></div><p>Удаление аккаунта · {time.format(row.at)}</p><details open={row.id===target||undefined}><summary>Подробнее</summary><div><p>Владелец подтвердил заявку паролем и кодом из письма.</p><button className={styles.secondary} onClick={()=>setDeletion(row)}>Рассмотреть заявку</button></div></details></article>)}</div>
 {deletion&&<AccountDeletionReview target={{id:deletion.id,email:deletion.email,requestedAt:deletion.at}} onClose={()=>setDeletion(null)} onComplete={()=>{setDeletion(null);notify('Аккаунт удалён. Подтверждение поставлено в очередь.');reload();}}/>}</section>;
}
