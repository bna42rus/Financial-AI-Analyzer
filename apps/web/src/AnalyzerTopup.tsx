import {useEffect,useState} from 'react';
import {api} from './server-client';
import {moneyLabel} from '../../../packages/access/src/model';
import {OperationDialog} from './OperationDialog';
import common from './App.module.css';
import styles from './Settings.module.css';
type Order={id:string;units:number;status:string;redirect:string|null};
type Catalog={enabled:boolean;packages:{units:number;priceMinor:number}[];pending:Order[]};
export function AnalyzerTopup({onClose,onCredit}:{onClose:()=>void;onCredit:()=>void}){
 const [data,setData]=useState<Catalog|null>(null),[order,setOrder]=useState<Order|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const number=(n:number)=>n.toLocaleString('ru-RU');
 const load=()=>api<Catalog>('/finance/ai-packages',{},AbortSignal.timeout(8000)).then(d=>{setData(d);setError('');}).catch(e=>setError(e.message));
 useEffect(()=>{void load();},[]);
 async function proceed(id:string,units?:number){
  if(busy)return;setBusy(true);setError('');
  try{
   if(units!==undefined){const pending=await api<Order>('/finance/ai-topup',{id,units});setOrder(pending);}
   const updated=await api<Order>('/finance/ai-topup',{id});setOrder(updated);
   if(updated.status==='paid')onCredit();
  }catch(e){setError(e instanceof Error?e.message:'Не удалось проверить платёж.');void load();}
  finally{setBusy(false);}
 }
 return <OperationDialog compact title="Пополнить лимит Анализатора" onClose={()=>{if(!busy)onClose();}} footer={<button className={common.button} disabled={busy} onClick={onClose}>Закрыть</button>}>
  {error&&<p className={common.error} role="alert">{error}</p>}
  {data&&!data.enabled&&<p className={styles.muted}>Оплата пока не подключена. Здесь можно посмотреть пакеты и цены.</p>}
  {data?.enabled&&<p className={styles.muted}>Тестовый платёж. Реального списания не будет. Остаток пакета переносится на следующий месяц.</p>}
  {order?.status==='paid'?<p role="status">Добавлено {number(order.units)} единиц.</p>:order?.status==='cancelled'?<p role="status">Платёж отменён.</p>:order&&<div className={styles.cardActions}>{order.redirect&&<a className={common.primaryButton} href={order.redirect} target="_blank" rel="noreferrer">Перейти в ЮKassa</a>}<button className={common.button} disabled={busy} onClick={()=>void proceed(order.id)}>Проверить оплату</button></div>}
  {!data&&!error&&<p role="status">Загружаем пакеты…</p>}{!data&&error&&<button className={common.button} onClick={()=>void load()}>Повторить</button>}{data&&!data.packages.length&&<p>Нет доступных пакетов.</p>}
  {data&&!order&&<div className={styles.settingsStack}>{data.packages.map(p=><div key={p.units} className={styles.settingsRow}><strong>{number(p.units)} единиц</strong>{data.enabled?<button className={common.button} disabled={busy} onClick={()=>void proceed(crypto.randomUUID(),p.units)}>{moneyLabel(String(p.priceMinor))}</button>:<span>{moneyLabel(String(p.priceMinor))}</span>}</div>)}{data.enabled&&data.pending.map(p=><div key={p.id} className={styles.settingsRow}><span>{number(p.units)} единиц · ожидает оплаты</span><button className={common.button} disabled={busy} onClick={()=>{setOrder(p);void proceed(p.id);}}>Открыть</button></div>)}</div>}
 </OperationDialog>;
}
