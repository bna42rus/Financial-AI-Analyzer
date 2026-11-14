import {CardPicker} from './CardPicker';
import type {PaymentCard} from './CardPicker';
import {SelectField} from './SelectField';
import {useEffect,useRef,useState} from 'react';
import {api} from './server-client';
import {SupportLink} from './SupportDialog';
import {dateLabel,moneyLabel} from '../../../packages/access/src/model';
import type {AccessRequest,Tariff} from '../../../packages/access/src/model';
import type {BillingPlan} from '../../../packages/access/src/billing';
import {legalDocuments} from '../../../packages/access/src/legal';
import styles from './ServerAccess.module.css';
export type Order={id:string;reason?:string|null;purpose?:string;state:'created'|'pending'|'paid'|'cancelled'|'reconcile';mode:'once'|'enroll'|'automatic';autoRequested?:boolean;tariff:BillingPlan;plannedEnd?:string|null;redirect?:string|null};
type Renewal={cardId?:string|null;state:'active'|'off'|'changed'|'failed';tariff:BillingPlan;nextAt:string};
export type Billing={cards?:PaymentCard[];cardsEnabled?:boolean;cardResult?:string|null;isNew?:boolean;canEnable?:boolean;canBind?:boolean;enableReason?:string|null;card?:{last4:string|null}|null;trialAvailable?:boolean;trialResult?:string|null;trialOrder?:Order|null;cardOrder?:Order|null;enabled:boolean;test:boolean;accessEnd:string|null;tariffs:Tariff[];renewal:Renewal|null;order:Order|null};
type Quote={tariff:BillingPlan;startsAt:string;endsAt:string;cycleRevision:number;offerVersion:string;renewalVersion:string};
type First={enabled:boolean;test:boolean;autoAvailable?:boolean;order:Order|null};
export const unfinished=(o:Order|null|undefined)=>!!o&&['created','pending','reconcile'].includes(o.state);
const units=(t:BillingPlan,renewal=false)=>t.aiQuota.toLocaleString('ru-RU')+' единиц Анализатора'+(t.duration.kind==='calendar_months'?' в месяц':renewal?'':' за период');
function checkoutLabel(o:Order){return o.state==='paid'?'Оплата подтверждена.':o.state==='cancelled'?'Оплата отменена.':o.state==='reconcile'?'Проверяем платёж. Не оплачивайте повторно до ответа поддержки.':'';}
function PayLinks(){return <p className={styles.muted}><a href="/offer" target="_blank" rel="noreferrer">Публичная оферта</a> · <a href="/payments" target="_blank" rel="noreferrer">Оплата и возврат</a> · <a href="/privacy" target="_blank" rel="noreferrer">Конфиденциальность и данные</a></p>;}
export function paymentFailure(reason?:string|null){return reason==='insufficient_funds'?'Недостаточно денег на карте. Пополните её или выберите другую.':reason==='card_expired'?'Срок действия карты истёк. Выберите другую карту.':'Платёж не выполнен. Попробуйте ещё раз или выберите другую карту.';}
function resume(order:Order){if(order.redirect)window.location.assign(order.redirect);}
export function RenewalEnd({date,timezone='Europe/Moscow'}:{date:string;timezone?:string}){
 return <div className={styles.renewalEnd}><span>Доступ после продления</span><strong>До {new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(date))}</strong></div>;
}
export function useAccessBilling(){
 const [state,setState]=useState<Billing|null>(null),[loaded,setLoaded]=useState(false),[error,setError]=useState(false);
 async function reload(){try{const next=await api<Billing>('/access/billing',undefined,AbortSignal.timeout(12000));setState(next);setError(false);return next;}catch(e){setError(true);throw e;}finally{setLoaded(true);}}
 useEffect(()=>{let live=true;const read=()=>void api<Billing>('/access/billing',undefined,AbortSignal.timeout(12000)).then(v=>{if(live){setState(v);setError(false);}}).catch(()=>{if(live)setError(true);}).finally(()=>{if(live)setLoaded(true);});read();window.addEventListener('focus',read);window.addEventListener('cashneuro-billing',read);return()=>{live=false;window.removeEventListener('focus',read);window.removeEventListener('cashneuro-billing',read);};},[]);
 useEffect(()=>{if(![state?.order,state?.trialOrder,state?.cardOrder].some(unfinished))return;const timer=setInterval(()=>{if(document.visibilityState==='visible')void reload().catch(()=>{});},15000);return()=>clearInterval(timer);},[state?.order?.id,state?.order?.state,state?.trialOrder?.id,state?.trialOrder?.state,state?.cardOrder?.id,state?.cardOrder?.state]);
 return {state,loaded,error,reload};
}
export function PendingPayment({order,trial=false,binding=false,refresh,onRefresh}:{order:Order;trial?:boolean;binding?:boolean;refresh:()=>Promise<unknown>;onRefresh:()=>Promise<void>}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function cancel(){setBusy(true);setError('');try{const next=await api<Order>('/access/billing-cancel',{id:order.id});await refresh();window.dispatchEvent(new Event('cashneuro-billing'));if(next.state==='paid')await onRefresh();}catch(e){setError(e instanceof Error?e.message:'Не удалось отменить оплату.');}finally{setBusy(false);}}
 return <>{binding&&<p>Вы начали привязку карты. Можете продолжить проверочный платёж 1 ₽ или отменить его.</p>}{trial&&<p>Вы начали оформление пробного периода. Можете продолжить оплату или отменить её.</p>}{!trial&&!binding&&order.plannedEnd&&<RenewalEnd date={order.plannedEnd}/>}{order.state==='pending'&&!order.redirect&&<p role="status">Платёж обрабатывается. Результат обновится автоматически.</p>}{order.state==='reconcile'&&<p>Проверяем результат платежа. <SupportLink>Поддержка</SupportLink></p>}{error&&<p className={styles.error} role="alert">{error}</p>}<div className={styles.paymentActions}><button type="button" className={styles.secondary} disabled={busy||order.state==='reconcile'} onClick={()=>void cancel()}>Отменить оплату</button><button type="button" className={styles.primary} disabled={busy||!order.redirect} onClick={()=>resume(order)}>Продолжить оплату</button></div></>;
}
export function OnlineRenewal({state,refresh,onRefresh,initialTariffId=''}:{state:Billing;refresh:()=>Promise<Billing>;onRefresh:()=>Promise<void>;initialTariffId?:string}){
 const [chosen,setChosen]=useState(initialTariffId),[quote,setQuote]=useState<Quote|null>(null),[auto,setAuto]=useState(state.renewal?.state==='active'),[card,setCard]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const selected=state.tariffs.find(t=>t.id===chosen)??(!chosen?state.tariffs[0]:undefined),order=state.order,previous=useRef(unfinished(order)?order?.id:null);
 useEffect(()=>{setAuto(state.renewal?.state==='active');},[state.renewal?.state,state.renewal?.tariff.id]);
 useEffect(()=>{if(unfinished(order))previous.current=order?.id;else if(previous.current&&order?.id===previous.current&&order.state==='paid'){previous.current=null;void onRefresh();}},[order?.id,order?.state]);
 useEffect(()=>{if(!state.enabled||!selected||unfinished(order))return;let live=true;setQuote(null);void api<Quote>('/access/billing-quote',{tariffId:selected.id}).then(v=>{if(live)setQuote(v);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[selected?.id,selected?.catalogVersion,state.enabled,state.accessEnd,order?.state]);
 async function pay(){if(busy||!quote)return;setBusy(true);setError('');try{const created=await api<Order>('/access/billing-create',{id:crypto.randomUUID(),autoRenewal:auto,saveCardConsent:!card,...(card?{cardId:card}:{}),tariffId:quote.tariff.id,priceMinor:quote.tariff.priceMinor,catalogVersion:quote.tariff.catalogVersion,cycleRevision:quote.cycleRevision,offerVersion:quote.offerVersion,...(auto?{renewalVersion:quote.renewalVersion}:{})});const next=await api<Order>('/access/billing-sync',{id:created.id});await refresh();if(next.state==='paid')await onRefresh();else resume(next);}catch(e){setError(e instanceof Error?e.message:'Не удалось открыть оплату.');}finally{setBusy(false);}}
 return <section className={styles.renewalBody}><p>Текущий срок: {state.accessEnd?'до '+dateLabel(state.accessEnd):'—'}</p>{error&&<p role="alert" className={styles.error}>{error}</p>}{order?.state==='paid'&&<p role="status">Оплата подтверждена. Доступ продлён.</p>}{order?.state==='cancelled'&&order.reason&&<p role="alert" className={styles.error}>{paymentFailure(order.reason)}</p>}
 {order&&unfinished(order)?<PendingPayment order={order} refresh={refresh} onRefresh={onRefresh}/>:<form onSubmit={e=>{e.preventDefault();void pay();}}><label>{state.isNew?'Тариф':'Период продления'}<SelectField aria-label="Период продления" value={selected?.id??''} onChange={e=>{setChosen(e.target.value);setQuote(null);setError('');}}>{!selected&&<option value="">Выберите тариф</option>}{state.tariffs.map(t=><option key={t.id} value={t.id}>{t.name} — {moneyLabel(t.priceMinor)}</option>)}</SelectField></label>
 {quote&&quote.tariff.id===selected?.id&&<><RenewalEnd date={quote.endsAt}/><p>Лимит на новый период — {units(quote.tariff,true)}.</p><div className={styles.legalChoice}><input id="checkout-auto-renewal" type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/><label htmlFor="checkout-auto-renewal">Включить автопродление. <a href="/autorenewal" target="_blank" rel="noreferrer">Условия автопродления</a></label></div>{auto&&<p className={styles.muted}>{moneyLabel(quote.tariff.priceMinor)} за «{quote.tariff.name}». Следующий платёж — {dateLabel(quote.endsAt)}. Настройка применится после успешной оплаты.</p>}</>}
 <CardPicker cards={state.cards} value={card} onChange={setCard} disabled={busy}/>{!card&&<p className={styles.muted}>Карта сохранится для следующих оплат. Автопродление работает только при включённой галочке.</p>}<PayLinks/><div className={styles.paymentActions}><button className={styles.primary} disabled={busy||!state.enabled||!quote}>{quote?'Перейти к оплате · '+moneyLabel(quote.tariff.priceMinor):'Перейти к оплате'}</button></div></form>}</section>;
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
 return <div className={styles.renewalBody}><p>{units(row.tariff)}. Оплаченный период начнётся после регистрации.</p>
 {!unfinished(order)&&state.autoAvailable&&<div className={styles.legalChoice}><input id="first-autorenew" type="checkbox" checked={auto} disabled={busy} onChange={e=>setAuto(e.target.checked)}/><label htmlFor="first-autorenew">Включить автопродление. <a href="/autorenewal" target="_blank" rel="noreferrer">Условия автопродления</a></label></div>}<PayLinks/>{error&&<p role="alert" className={styles.error}>{error}</p>}
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
