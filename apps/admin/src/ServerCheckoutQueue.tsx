import {SelectField} from '../../web/src/SelectField';
import {useEffect,useState} from 'react';
import {api} from '../../web/src/server-client';
import {SearchField,foldSearch} from '../../web/src/SearchFilter';
import {dateLabel,moneyLabel} from '../../../packages/access/src/model';
import styles from '../../web/src/ServerAccess.module.css';
import shell from './ServerAdmin.module.css';
const labels={created:'Создан',pending:'Ожидает оплаты',paid:'Подтверждён',cancelled:'Не завершён',reconcile:'Требует сверки'};
type Order={id:string;channel:'first'|'renewal';status:keyof typeof labels;mode:'once'|'enroll'|'automatic';tariff:string;price_minor:string;provider_id:string|null;created_at:string;paid_at:string|null};
export function ServerCheckoutQueue(){
 const [orders,setOrders]=useState<Order[]|null>(null),[error,setError]=useState(''),[filter,setFilter]=useState('all'),[search,setSearch]=useState('');
 useEffect(()=>{const c=new AbortController();void api<{orders:Order[]}>('/control/access-checkouts',undefined,c.signal).then(r=>setOrders(r.orders)).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[]);
 const visible=orders?.filter(o=>(filter==='all'||o.status===filter)&&foldSearch([o.tariff,o.id,o.provider_id].join(' ')).includes(foldSearch(search.trim())));
 return <section className={styles.card}><h2>Платежи через ЮKassa</h2><div className={shell.filters}><SearchField aria-label="Поиск платежей" placeholder="Тариф или номер платежа" value={search} onValueChange={setSearch}/><SelectField aria-label="Статус платежа" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">Все статусы</option>{Object.entries(labels).map(([key,title])=><option key={key} value={key}>{title}</option>)}</SelectField></div>
 {error&&<p className={styles.error} role="alert">{error}</p>}{!orders&&!error&&<p role="status">Загружаем платежи…</p>}{visible?.length===0&&<p>{orders?.length?'Платежи не найдены.':'Онлайн-платежей пока нет.'}</p>}
 <div className={shell.paymentList}>{visible?.map(o=><article key={o.id} className={styles.record}><div className={shell.paymentHead}><strong>{moneyLabel(o.price_minor)} · {o.tariff}</strong><span className={o.status==='reconcile'?shell.attention:shell.badge}>{labels[o.status]}</span></div><p>{o.channel==='first'?'Первый доступ':o.mode==='automatic'?'Автопродление':'Продление'} · {dateLabel(o.paid_at??o.created_at)}</p>{o.provider_id&&<small>Номер в ЮKassa: {o.provider_id}</small>}{o.status==='reconcile'&&<p>Сверьте операцию в кабинете ЮKassa. Не подтверждайте её как ручной перевод.</p>}</article>)}</div>
 </section>;
}
