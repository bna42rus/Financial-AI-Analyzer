import {CardPicker} from './CardPicker';
import type {PaymentCard} from './CardPicker';
import {useEffect,useRef,useState} from 'react';
import {api} from './server-client';
import {moneyLabel} from '../../../packages/access/src/model';
import {OperationDialog} from './OperationDialog';
import common from './App.module.css';
import styles from './Settings.module.css';

type Order={id:string;units:number;status:string;redirect:string|null};
type Catalog={cards?:PaymentCard[];enabled:boolean;packages:{id:string;units:number;priceMinor:number}[];pending:Order[]};
const number=(n:number)=>n.toLocaleString('ru-RU');
const waiting=(order:Order|null)=>order?.status==='created'||order?.status==='pending';

export function AnalyzerTopup({onClose,onCredit}:{onClose:()=>void;onCredit:()=>void}){
 const [data,setData]=useState<Catalog|null>(null),[order,setOrder]=useState<Order|null>(null),[chosen,setChosen]=useState<string|null>(null),[card,setCard]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const attempt=useRef<{id:string;units:number;packId:string;priceMinor:number;cardId?:string}|null>(null),credit=useRef(onCredit);
 credit.current=onCredit;
 const selected=data?.packages.find(pack=>pack.id===chosen);

 async function load(signal?:AbortSignal){
  setError('');
  try{
   const catalog=await api<Catalog>('/finance/ai-packages',{},signal);
   if(signal?.aborted)return;
   setData(catalog);
   setOrder(catalog.pending[0]??null);
  }catch(e){if(!signal?.aborted)setError(e instanceof Error?e.message:'Не удалось загрузить пакеты.');}
 }
 useEffect(()=>{const abort=new AbortController();void load(abort.signal);return()=>abort.abort();},[]);
 useEffect(()=>{
  if(!data?.enabled||!waiting(order)||busy||!order)return;
  const abort=new AbortController();
  let running=false;
  async function check(){
   if(running||document.visibilityState==='hidden')return;
   running=true;
   try{
    const next=await api<Order>('/finance/ai-topup',{id:order!.id},AbortSignal.any([abort.signal,AbortSignal.timeout(10000)]));
    if(abort.signal.aborted)return;
    setOrder(next);
    setError('');
    if(!waiting(next))attempt.current=null;
    if(next.status==='paid')credit.current();
   }catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Не удалось проверить платёж.');}
   finally{running=false;}
  }
  void check();
  const timer=window.setInterval(()=>void check(),15000);
  window.addEventListener('focus',check);
  return()=>{abort.abort();window.clearInterval(timer);window.removeEventListener('focus',check);};
 },[data?.enabled,order?.id,order?.status,busy]);

 async function start(){
  if(busy||!selected||!data?.enabled||waiting(order))return;
  setBusy(true);setError('');
  if(attempt.current?.packId!==selected.id||attempt.current.units!==selected.units||attempt.current.priceMinor!==selected.priceMinor||(attempt.current.cardId??'')!==card)attempt.current={id:crypto.randomUUID(),units:selected.units,packId:selected.id,priceMinor:selected.priceMinor,...(card?{cardId:card}:{})};
  try{
   const pending=await api<Order>('/finance/ai-topup',attempt.current,AbortSignal.timeout(10000));
   setOrder(pending);
   const next=await api<Order>('/finance/ai-topup',{id:pending.id},AbortSignal.timeout(10000));
   setOrder(next);
   if(!waiting(next))attempt.current=null;
   if(next.status==='paid')credit.current();
   else if(next.redirect)window.location.assign(next.redirect);
  }catch(e){setError(e instanceof Error?e.message:'Не удалось открыть оплату.');}
  finally{setBusy(false);}
 }
 return <OperationDialog compact title="Пополнить лимит Анализатора" onClose={()=>{if(!busy)onClose();}} footer={<>
  <button className={common.button} disabled={busy} onClick={onClose}>Закрыть</button>
  {waiting(order)?order?.redirect&&<a className={common.primaryButton} href={order.redirect}>Продолжить оплату</a>:
   !!data?.packages.length&&<button className={common.primaryButton} disabled={busy||!data.enabled||!selected} onClick={()=>void start()}>{selected?'Перейти к оплате · '+moneyLabel(String(selected.priceMinor)):'Перейти к оплате'}</button>}
 </>}>
  {error&&<p className={common.error} role="alert">{error}</p>}
  {!data&&!error&&<p role="status">Загружаем пакеты…</p>}
  {!data&&error&&<button className={common.button} onClick={()=>void load()}>Повторить</button>}
  {data&&!data.packages.length&&<p>Нет доступных пакетов.</p>}
  {order?.status==='paid'&&<p role="status">Добавлено {number(order.units)} единиц.</p>}
  {order?.status==='cancelled'&&<p role="status">Платёж отменён. Можно выбрать пакет заново.</p>}
  {waiting(order)&&<p role="status">Ждём подтверждения оплаты за {number(order!.units)} единиц.</p>}
  {!!data?.packages.length&&!waiting(order)&&<fieldset className={styles.topupPackages} disabled={busy}>
   <legend>Выберите пакет</legend>
   {data.packages.map(pack=><label key={pack.id} className={styles.topupPackage}>
    <input type="radio" name="analyzer-topup" checked={chosen===pack.id} onChange={()=>setChosen(pack.id)}/>
    <strong>{number(pack.units)} единиц</strong>
    <span>{moneyLabel(String(pack.priceMinor))}</span>
   </label>)}
  </fieldset>}
  {!!data?.packages.length&&!waiting(order)&&<><CardPicker cards={data.cards} value={card} onChange={setCard} disabled={busy}/>{!card&&<p>Карта сохранится для следующих оплат. Это не включает автопродление.</p>}</>}
  {!!data?.packages.length&&<p className={styles.topupNote}>Неиспользованные единицы из купленных пакетов переносятся на следующий месяц.</p>}
 </OperationDialog>;
}
