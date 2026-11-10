import {useEffect,useState} from 'react';
import {SearchField,foldSearch} from '../../web/src/SearchFilter';
import {SelectField} from '../../web/src/SelectField';
import {moneyLabel} from '../../../packages/access/src/model';
import {AccountDeletionReview} from './ServerAccountDeletions';
import {adminLink,useAdminData,useAdminTime} from './admin-view';
import styles from '../../web/src/ServerAccess.module.css';
import shell from './ServerAdmin.module.css';

type Kind='first'|'renewal'|'deletion';
type Row={id:string;email:string;at:string;type:Kind;status:string;attention:boolean;tariff?:string;priceMinor?:string;paymentId?:string;invitationId?:string;inviteUntil?:string;invitationState?:string;mail?:string;activatedAt?:string;previousEnd?:string;accessEnd?:string};
const types:Record<Kind,string>={first:'Первый доступ',renewal:'Продление',deletion:'Удаление аккаунта'};
const statusNames:Record<string,string>={email:'Ожидает подтверждения почты',pay:'Ожидает оплаты',registration:'Ожидает регистрации',newLink:'Нужно новое приглашение',registered:'Регистрация завершена',expired:'Срок заявки истёк',closed:'Заявка закрыта',reconcile:'Требует сверки',renewed:'Доступ продлён',failed:'Продление не состоялось',decision:'Ожидает решения'};
const states:Record<Kind,string[]>={first:['email','pay','registration','newLink','registered','expired','closed','reconcile'],renewal:['pay','renewed','failed','reconcile'],deletion:['decision']};
export type RequestFilters={query:string;kind:''|Kind;status:string;automaticKind:boolean};
export const initialRequestFilters:RequestFilters={query:'',kind:'',status:'',automaticKind:false};

export function ServerRequests({refresh,target,initialSearch,filters,onFilters}:{refresh:number;target?:string;initialSearch?:string;filters:RequestFilters;onFilters:(value:RequestFilters)=>void}){
 const {data,error,loading,reload}=useAdminData<{requests:Row[]}>('/control/workspace-requests'+(target?'?id='+encodeURIComponent(target):''),refresh);
 const [deletion,setDeletion]=useState<Row|null>(null),[notice,setNotice]=useState('');
 const time=useAdminTime();
 const {query,kind,status,automaticKind}=filters;
 useEffect(()=>{if(initialSearch!==undefined)onFilters({...initialRequestFilters,query:initialSearch});},[initialSearch]);
 const options=kind&&!automaticKind?states[kind]:Object.keys(statusNames);
 const visible=data?.requests.filter(r=>r.id===target||(!kind||kind===r.type)&&(!status||(status==='attention'?r.attention:r.status===status))&&foldSearch(r.email??'').includes(foldSearch(query.trim())));
 function changeKind(next:''|Kind){onFilters({...filters,kind:next,automaticKind:false,status:!next||status==='attention'||states[next].includes(status)?status:''});}
 function changeStatus(next:string){
  const matching=(Object.keys(states) as Kind[]).filter(type=>states[type].includes(next));
  const current=matching.length===1?matching[0]!:(next==='attention'||matching.includes(kind as Kind)?kind:'');
  onFilters({...filters,status:next,kind:current,automaticKind:automaticKind||current!==kind});
 }
 return <section className={styles.card}>
  <div className={shell.filters}>
   <SearchField value={query} onValueChange={query=>onFilters({...filters,query})} placeholder="Поиск по почте" aria-label="Поиск заявок"/>
   <SelectField value={kind} aria-label="Тип заявки" onChange={e=>changeKind(e.target.value as ''|Kind)}><option value="">Все типы</option>{Object.entries(types).map(([id,name])=><option key={id} value={id}>{name}</option>)}</SelectField>
   <SelectField value={status} aria-label="Статус заявки" onChange={e=>changeStatus(e.target.value)}><option value="">Все статусы</option><option value="attention">Требует внимания</option>{options.map(id=><option key={id} value={id}>{statusNames[id]}</option>)}</SelectField>
  </div>
  {notice&&<p role="status" className={styles.success}>{notice}</p>}
  {error&&<p role="alert" className={styles.error}>{error}</p>}{loading&&!data&&<p role="status">Загружаем заявки…</p>}
  {visible?.length===0&&<p>Заявки не найдены.</p>}
  <div className={shell.records}>{visible?.map(row=><article key={row.id} data-highlight={row.id===target}>
   <div className={shell.paymentHead}><strong>{row.email??'Адрес недоступен'}</strong><span className={row.attention?shell.attention:shell.badge}>{statusNames[row.status]}</span></div>
   <p>{types[row.type]} · {time.format(row.at)}</p>
   <details key={row.id+String(row.id===target)} open={row.id===target||undefined}><summary>Подробнее</summary><div>
   {row.tariff&&<p>{row.tariff}{row.priceMinor&&' · '+moneyLabel(row.priceMinor)}</p>}
   {row.type==='renewal'&&row.accessEnd&&<p>Срок доступа · {time.format(row.previousEnd)} → {time.format(row.accessEnd)}</p>}
   {row.type==='first'&&row.activatedAt&&<p>Регистрация завершена · {time.format(row.activatedAt)}</p>}
   {row.invitationId&&<p>{row.invitationState==='active'?'Ссылка действует до '+time.format(row.inviteUntil):row.invitationState==='expired'?'Срок ссылки истёк':row.invitationState==='used'?'Ссылка использована':'Ссылка закрыта'}{row.mail==='failed'?' · письмо не отправлено':''}</p>}
   {row.type==='deletion'&&<p>Владелец подтвердил заявку паролем и кодом из письма.</p>}
   <div className={styles.actions}>
    {row.paymentId&&<a className={styles.secondary} href={adminLink('payments',{id:row.paymentId})}>Открыть платёж</a>}
    {row.invitationId&&<a className={styles.secondary} href={adminLink('invitations',{id:row.invitationId})}>Открыть приглашение</a>}
    {row.type==='deletion'&&<button className={styles.secondary} onClick={()=>setDeletion(row)}>Рассмотреть заявку</button>}
   </div></div></details>
  </article>)}</div>
  {deletion&&<AccountDeletionReview target={{id:deletion.id,email:deletion.email,requestedAt:deletion.at}} onClose={()=>setDeletion(null)} onComplete={()=>{setDeletion(null);setNotice('Аккаунт удалён. Подтверждение поставлено в очередь.');reload();}}/>}
 </section>;
}
