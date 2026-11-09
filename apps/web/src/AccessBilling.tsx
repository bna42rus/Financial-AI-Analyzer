import {SelectField} from './SelectField';
import {useEffect,useState} from 'react';
import {api} from './server-client';
import {SupportLink} from './SupportDialog';
import {dateLabel,moneyLabel} from '../../../packages/access/src/model';
import type {AccessRequest,Tariff} from '../../../packages/access/src/model';
import type {BillingPlan} from '../../../packages/access/src/billing';
import {legalDocuments} from '../../../packages/access/src/legal';
import styles from './ServerAccess.module.css';

type Order={id:string;state:'created'|'pending'|'paid'|'cancelled'|'reconcile';mode:'once'|'enroll'|'automatic';autoRequested?:boolean;tariff:BillingPlan;plannedEnd?:string|null;redirect?:string|null};
type Renewal={state:'active'|'off'|'changed'|'failed';tariff:BillingPlan;nextAt:string};
type Billing={enabled:boolean;test:boolean;accessEnd:string|null;tariffs:Tariff[];renewal:Renewal|null;order:Order|null};
type Quote={tariff:BillingPlan;startsAt:string;endsAt:string;cycleRevision:number;offerVersion:string;renewalVersion:string};
type First={enabled:boolean;test:boolean;autoAvailable?:boolean;order:Order|null};
const unfinished=(o:Order|null|undefined)=>!!o&&['created','pending','reconcile'].includes(o.state);
const units=(t:BillingPlan,renewal=false)=>t.aiQuota.toLocaleString('ru-RU')+' единиц Анализатора'+(t.duration.kind==='calendar_months'?' в месяц':renewal?'':' за период');
function checkoutLabel(o:Order){return o.state==='paid'?'Оплата подтверждена.':o.state==='cancelled'?'Оплата не завершена. Доступ не активирован. Можно попробовать снова.':o.state==='reconcile'?'Проверяем платёж. Не оплачивайте повторно до ответа поддержки.':o.mode==='automatic'?'Проверяем автопродление.':'Ждём подтверждения оплаты.';}
function PayLinks(){return <p className={styles.muted}><a href="/offer" target="_blank" rel="noreferrer">Публичная оферта</a> · <a href="/payments" target="_blank" rel="noreferrer">Оплата и возврат</a> · <a href="/privacy" target="_blank" rel="noreferrer">Конфиденциальность и данные</a></p>;}
function resume(order:Order){if(order.redirect)window.location.assign(order.redirect);}
export function RenewalEnd({date,timezone='Europe/Moscow'}:{date:string;timezone?:string}){
 const end=new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(date));
 return <div className={styles.renewalEnd}><span>Доступ после продления</span><strong>До {end}</strong></div>;
}
export function useAccessBilling(){
 const [state,setState]=useState<Billing|null>(null),[loaded,setLoaded]=useState(false),[error,setError]=useState(false);
 async function reload(){try{const next=await api<Billing>('/access/billing',undefined,AbortSignal.timeout(8000));setState(next);setError(false);return next;}catch(e){setError(true);throw e;}finally{setLoaded(true);}}
 useEffect(()=>{let live=true;const read=()=>void api<Billing>('/access/billing',undefined,AbortSignal.timeout(8000)).then(v=>{if(live){setState(v);setError(false);}}).catch(()=>{if(live)setError(true);}).finally(()=>{if(live)setLoaded(true);});read();window.addEventListener('focus',read);return()=>{live=false;window.removeEventListener('focus',read);};},[]);
 return {state,loaded,error,reload};
}
export function OnlineRenewal({state,refresh,onRefresh,initialTariffId=''}:{state:Billing;refresh:()=>Promise<Billing>;onRefresh:()=>Promise<void>;initialTariffId?:string}){
 const [chosen,setChosen]=useState(initialTariffId),[quote,setQuote]=useState<Quote|null>(null),[auto,setAuto]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const selected=state.tariffs?.find(t=>t.id===chosen)??(!chosen?state.tariffs?.[0]:undefined),order=state.order;
 useEffect(()=>{if(!state.enabled||!selected||unfinished(order))return;let live=true;setQuote(null);
  void api<Quote>('/access/billing-quote',{tariffId:selected.id}).then(r=>{if(live)setQuote(r);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};
 },[selected?.id,selected?.catalogVersion,state.enabled,state.accessEnd,order?.state]);
 useEffect(()=>{if(busy||!state.enabled||!order||!['created','pending'].includes(order.state))return;let live=true,running=false;
  const check=async()=>{if(running||document.visibilityState==='hidden')return;running=true;try{const next=await api<Order>('/access/billing-sync',{id:order.id});if(live){await refresh();if(next.state==='paid')await onRefresh();}}catch{}finally{running=false;}};
  void check();const timer=window.setInterval(()=>void check(),15000);window.addEventListener('focus',check);return()=>{live=false;window.clearInterval(timer);window.removeEventListener('focus',check);};
 },[state.enabled,order?.id,order?.state,busy]);
 async function act(work:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'Не удалось продолжить.');}finally{setBusy(false);}}
 const update=state.renewal;
 return <section className={styles.renewalBody}>
 {state.accessEnd&&<p>Текущий срок — до {dateLabel(state.accessEnd)}.</p>}
 {error&&<p role="alert" className={styles.error}>{error}</p>}
 {update&&<div className={styles.record}><strong>Автопродление</strong>{update.state==='active'?<><p>{moneyLabel(update.tariff.priceMinor)} · следующий платёж {dateLabel(update.nextAt)}.</p><button type="button" className={styles.secondary} disabled={busy} onClick={()=>void act(async()=>{await api('/access/billing-disable',{});await refresh();})}>Отключить автопродление</button></>:update.state==='changed'?<><p>Условия изменились. Списаний не будет без вашего подтверждения. <a href="/price">Посмотреть тарифы</a></p><button type="button" className={styles.secondary} disabled={busy} onClick={()=>void act(async()=>{await api('/access/billing-disable',{});await refresh();})}>Отключить автопродление</button></>:<p>{update.state==='failed'?'Автопродление остановлено. Продлите доступ вручную.':'Выключено.'}</p>}</div>}
 {order&&<p role="status">{checkoutLabel(order)} {order.state==='reconcile'&&<SupportLink className={styles.secondary}/>}</p>}
 {unfinished(order)?<>{order?.plannedEnd&&<RenewalEnd date={order.plannedEnd}/>}{order?.redirect&&<button type="button" className={styles.primary} disabled={busy} onClick={()=>resume(order)}>Продолжить оплату</button>}{order?.mode==='enroll'&&!update&&<button type="button" className={styles.secondary} disabled={busy} onClick={()=>void act(async()=>{await api('/access/billing-disable',{});await refresh();setAuto(false);})}>Отказаться от будущих списаний</button>}</>:<form onSubmit={e=>{e.preventDefault();if(!quote||!selected||quote.tariff.id!==selected.id)return;void act(async()=>{
  const created=await api<Order>('/access/billing-create',{id:crypto.randomUUID(),tariffId:quote.tariff.id,priceMinor:quote.tariff.priceMinor,catalogVersion:quote.tariff.catalogVersion,cycleRevision:quote.cycleRevision,offerVersion:quote.offerVersion,...(auto?{renewalVersion:quote.renewalVersion}:{})});
  await refresh();const next=await api<Order>('/access/billing-sync',{id:created.id});await refresh();if(next.state==='paid')await onRefresh();else resume(next);
 });}}><label>Период продления<SelectField aria-label="Период продления" value={selected?.id??''} onChange={e=>{setChosen(e.target.value);setQuote(null);setAuto(false);setError('');}}>{!selected&&<option value="">{state.tariffs.length?'Выберите тариф':'Нет доступных тарифов'}</option>}{state.tariffs?.map(t=><option key={t.id} value={t.id}>{t.name} — {moneyLabel(t.priceMinor)}</option>)}</SelectField></label>
 {quote&&quote.tariff.id===selected?.id&&<><RenewalEnd date={quote.endsAt}/><p>Лимит на новый период — {units(quote.tariff,true)}.</p>
 <div className={styles.legalChoice}><input type="checkbox" id="checkout-auto-renewal" checked={auto} onChange={e=>setAuto(e.target.checked)}/><label htmlFor="checkout-auto-renewal">Включить автопродление: {moneyLabel(quote.tariff.priceMinor)} за «{quote.tariff.name}». Следующий платёж — {dateLabel(quote.endsAt)}. <a href="/autorenewal" target="_blank" rel="noreferrer">Условия автопродления</a></label></div>{!auto&&update?.state==='active'&&<p className={styles.muted}>Разовый платёж не отключает ранее настроенное автопродление.</p>}</>}
 <PayLinks/><button className={styles.primary} disabled={busy||!state.enabled||!quote||quote.tariff.id!==selected?.id}>{quote?'Перейти к оплате · '+moneyLabel(quote.tariff.priceMinor):'Перейти к оплате'}</button></form>}
 </section>;
}
export function FirstAccessBilling({row,onPaid,fallback,onRestart}:{row:AccessRequest;onPaid:()=>Promise<void>;fallback:React.ReactNode;onRestart:()=>void}){
 const [state,setState]=useState<First|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0),[auto,setAuto]=useState(false);
 useEffect(()=>{let live=true;api<First>('/access/first-checkout').then(s=>{if(live)setState(s);}).catch(()=>{if(live)setError('Не удалось проверить оплату.');});return()=>{live=false;};},[row.id,retry]);
 const order=state?.order;
 useEffect(()=>{if(busy||!state?.enabled||!order||!['created','pending'].includes(order.state))return;let live=true,running=false;
  const sync=async()=>{if(running||document.visibilityState==='hidden')return;running=true;try{const next=await api<Order>('/access/first-checkout-sync',{id:order.id});if(live){setState(s=>s?{...s,order:next}:null);if(next.state==='paid')await onPaid();}}catch{}finally{running=false;}};
  void sync();const timer=window.setInterval(()=>void sync(),15000);window.addEventListener('focus',sync);return()=>{live=false;window.clearInterval(timer);window.removeEventListener('focus',sync);};
 },[state?.enabled,order?.id,order?.state,busy]);
 if(!state)return error?<><p role="alert" className={styles.error}>{error}</p><button className={styles.secondary} onClick={()=>{setError('');setRetry(x=>x+1);}}>Повторить проверку</button></>:<p role="status">Проверяем возможность оплаты…</p>;
 if(row.status==='awaiting_payment'&&Date.parse(row.expiresAt)<=Date.now()&&!unfinished(order)&&order?.state!=='paid')return <><p>Срок заявки истёк. Создайте новую, чтобы получить актуальную цену.</p><button className={styles.primary} onClick={onRestart}>Создать заявку</button></>;
 if(!state.enabled||row.status==='needs_topup')return <>{fallback}</>;
 async function pay(){if(!state||busy)return;setError('');setBusy(true);try{
  const created=await api<Order>('/access/first-checkout-create',{id:crypto.randomUUID(),priceMinor:row.tariff.priceMinor,offerVersion:legalDocuments.offer.version,...(auto&&state.autoAvailable?{renewalVersion:legalDocuments.renewal.version}:{})});
  setState({...state,order:created});const next=await api<Order>('/access/first-checkout-sync',{id:created.id});setState({...state,order:next});if(next.state==='paid')await onPaid();resume(next);
 }catch(e){setError(e instanceof Error?e.message:'Не удалось открыть оплату.');}finally{setBusy(false);}}
 return <div className={styles.renewalBody}>{state.test&&<p className={styles.muted}>Тестовая оплата. Не вводите данные реальной карты.</p>}<p>{units(row.tariff)}. Оплаченный период начнётся после регистрации.</p>
 {!unfinished(order)&&state.autoAvailable&&<div className={styles.legalChoice}><input id="first-autorenew" type="checkbox" checked={auto} disabled={busy} onChange={e=>setAuto(e.target.checked)}/><label htmlFor="first-autorenew">Включить автопродление: {moneyLabel(row.tariff.priceMinor)} за «{row.tariff.name}». Первый платёж за продление — после окончания оплаченного периода. <a href="/autorenewal" target="_blank" rel="noreferrer">Условия автопродления</a></label></div>}<PayLinks/>{error&&<p role="alert" className={styles.error}>{error}</p>}
 {order&&<p role="status">{checkoutLabel(order)} {order.state==='reconcile'&&<SupportLink className={styles.secondary}/>}</p>}
 {unfinished(order)?<>{order?.autoRequested&&<FirstRenewalOptOut onDisabled={()=>setState(v=>v&&v.order?{...v,order:{...v.order,autoRequested:false}}:v)}/>} {order?.redirect&&<button type="button" className={styles.primary} disabled={busy} onClick={()=>resume(order)}>Продолжить оплату</button>}</>:<button type="button" className={styles.primary} disabled={busy||order?.state==='paid'} onClick={()=>void pay()}>Оплатить {moneyLabel(row.tariff.priceMinor)}</button>}</div>;
}

function FirstRenewalOptOut({onDisabled}:{onDisabled:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 return <><button type="button" className={styles.secondary} disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await api('/access/first-checkout-disable',{});onDisabled();}catch(e){setError(e instanceof Error?e.message:'Не удалось отключить автопродление.');}finally{setBusy(false);}}}>Отключить автопродление</button>{error&&<p role="alert" className={styles.error}>{error}</p>}</>;
}
export function FirstPaidRenewal(){
 const [requested,setRequested]=useState(false);
 useEffect(()=>{const c=new AbortController();void api<First>('/access/first-checkout',undefined,c.signal).then(v=>setRequested(!!v.order?.autoRequested)).catch(()=>{});return()=>c.abort();},[]);
 return requested?<div className={styles.record}><p>Автопродление начнёт действовать после регистрации. Его можно отключить сейчас или в аккаунте.</p><FirstRenewalOptOut onDisabled={()=>setRequested(false)}/></div>:null;
}
