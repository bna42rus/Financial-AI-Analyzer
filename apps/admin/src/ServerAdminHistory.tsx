import {useEffect,useState} from 'react';
import {api} from '../../web/src/server-client';
import {dateLabel} from '../../../packages/access/src/model';
import {SearchField} from '../../web/src/SearchFilter';
import styles from '../../web/src/ServerAccess.module.css';
type Entry={id:string;kind:string;decision:string|null;target:string|null;actor:string|null;at:string;note:string|null;before:string|null;after:string|null;beforeIndefinite:boolean;afterIndefinite:boolean};
const names:Record<string,string>={account_deletion_completed:'Аккаунт удалён',commerce_catalog_updated:'Изменены тарифы или пакеты',extend:'Доступ продлён',set_end:'Изменена дата окончания',indefinite:'Выдан бессрочный доступ',end_now:'Доступ завершён',invite:'Выдано приглашение',cancel:'Приглашение отменено',reissue:'Приглашение заменено',review:'Сверка первого платежа',renewal:'Решение по продлению',manual_access:'Ручное изменение доступа',manual_invitation:'Изменено ручное приглашение',invitation:'Изменено приглашение',invitation_resend:'Приглашение отправлено повторно',mail_retry:'Письмо поставлено в очередь повторно',account_deletion:'Решение по удалению аккаунта',tariff:'Тариф изменён',pack:'Пакет изменён'};
export function ServerAdminHistory(){
 const [rows,setRows]=useState<Entry[]>([]),[search,setSearch]=useState(''),[error,setError]=useState(''),[pending,setPending]=useState(true),[more,setMore]=useState(true);
 useEffect(()=>{const abort=new AbortController();setPending(true);setError('');const timer=setTimeout(()=>{
  void api<{entries:Entry[]}>('/control/history',{search},abort.signal).then(r=>{if(!abort.signal.aborted){setRows(r.entries);setMore(r.entries.length===50);}}).catch(e=>{if(!abort.signal.aborted)setError(e.message);}).finally(()=>{if(!abort.signal.aborted)setPending(false);});
 },350);return()=>{clearTimeout(timer);abort.abort();};},[search]);
 async function next(){if(pending||!rows.length)return;setPending(true);setError('');try{const last=rows.at(-1)!;const r=await api<{entries:Entry[]}>('/control/history',{search,before:{at:last.at,id:last.id}});setRows(previous=>[...previous,...r.entries]);setMore(r.entries.length===50);}catch(e){setError(e instanceof Error?e.message:'Не удалось открыть историю.');}finally{setPending(false);}}
 return <section className={styles.card}><SearchField value={search} onValueChange={setSearch} placeholder="Адрес, решение или заметка" aria-label="Поиск по истории"/>
 {error&&<p role="alert" className={styles.error}>{error}</p>}{pending&&!rows.length&&<p role="status">Загружаем историю…</p>}{!pending&&!rows.length&&!error&&<p>Подходящих решений нет.</p>}
 {rows.map(r=><article key={r.id} className={styles.record}><strong>{names[r.decision??'']??names[r.kind]??'Административное действие'}</strong><p>{dateLabel(r.at)}{r.target?' · '+r.target:''}{r.actor?' · '+r.actor:''}</p>
 {(r.before||r.after||r.beforeIndefinite||r.afterIndefinite||r.note)&&<details><summary>Подробнее</summary>{(r.before||r.after||r.beforeIndefinite||r.afterIndefinite)&&<p>{r.beforeIndefinite?'Бессрочно':dateLabel(r.before)} → {r.afterIndefinite?'Бессрочно':dateLabel(r.after)}</p>}{r.note&&<p>Заметка: {r.note}</p>}</details>}</article>)}
 {more&&rows.length>0&&<button className={styles.secondary} disabled={pending} onClick={()=>void next()}>Показать ещё</button>}</section>;
}
