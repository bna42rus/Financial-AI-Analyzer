import {useState} from 'react';
import {api} from './server-client';
import {useAccessBilling,OnlineRenewal} from './AccessBilling';
import type {Order} from './AccessBilling';
import {legalDocuments} from '../../../packages/access/src/legal';
import {moneyLabel,dateLabel} from '../../../packages/access/src/model';
import styles from './ServerAccess.module.css';
export function TrialStart({onRefresh}:{onRefresh:()=>Promise<void>}){
 const {state,reload}=useAccessBilling(),[busy,setBusy]=useState(false),[auto,setAuto]=useState(false),[error,setError]=useState('');
 const weekly=state?.tariffs.find(t=>t.duration.kind==='days'&&t.duration.count===7);
 async function pay(){if(busy||!weekly)return;setBusy(true);setError('');try{
  let device=localStorage.getItem('cashneuro-trial-device');if(!device){device=crypto.randomUUID();localStorage.setItem('cashneuro-trial-device',device);}
  const o=await api<{id:string}>('/access/trial-create',{id:crypto.randomUUID(),device,cardConsent:true,tariffId:weekly.id,catalogVersion:weekly.catalogVersion??0,priceMinor:weekly.priceMinor,offerVersion:legalDocuments.offer.version,...(auto?{renewalVersion:legalDocuments.renewal.version}:{})});
  const next=await api<Order>('/access/billing-sync',{id:o.id});await reload();if(next.state==='paid')await onRefresh();else if(next.redirect)location.assign(next.redirect);
 }catch(e){setError(e instanceof Error?e.message:'Не удалось проверить карту.');}finally{setBusy(false);}}
 return <div className={styles.renewalBody}><p>7 дней доступа и 2 500 единиц Анализатора. Пробный период доступен один раз.</p><p>Для проверки и сохранения карты спишем 10 ₽ и сразу отправим запрос на полный возврат. Срок зачисления зависит от банка. Пробный период начнётся после успешной проверки карты.</p>
 {state?.trialResult==='denied'&&<p role="alert">Пробный период недоступен. Платёж проверки карты будет возвращён. Вы можете выбрать платный тариф или обратиться в поддержку.</p>}
 <form onSubmit={e=>{e.preventDefault();void pay();}}><div className={styles.legalChoice}><input id="trial-save-card" type="checkbox" required disabled={busy}/><label htmlFor="trial-save-card">Согласен на проверочный платёж 10 ₽, его возврат и сохранение карты. <a href="/payments" target="_blank" rel="noreferrer">Условия</a></label></div>
 <div className={styles.legalChoice}><input id="trial-auto" type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)} disabled={busy}/><label htmlFor="trial-auto">Включить автопродление. <a href="/autorenewal" target="_blank" rel="noreferrer">Условия автопродления</a></label></div>
 {weekly&&<p>{auto?`После пробных 7 дней — ${moneyLabel(weekly.priceMinor)} каждые 7 дней. Автопродление можно выключить в аккаунте.`:'Автопродление выключено: после пробных 7 дней доступ закончится. Карта сохранится в аккаунте.'}</p>}
 {error&&<p role="alert" className={styles.error}>{error}</p>}<button className={styles.primary} disabled={busy||!state?.enabled||!state?.trialAvailable||!weekly||!!state.order&&['created','pending','reconcile'].includes(state.order.state)}>Проверить карту · 10 ₽</button></form>
 {state?.order&&['created','pending','reconcile'].includes(state.order.state)&&<OnlineRenewal state={state} refresh={reload} onRefresh={onRefresh}/>}</div>;
}
export function RenewalSettings(){
 const {state,reload}=useAccessBilling(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 if(!state?.renewal)return null;const r=state.renewal;
 return <section className={styles.record}><strong>Автопродление</strong><div className={styles.legalChoice}><input id="account-auto" type="checkbox" checked={r.state==='active'} disabled={busy||!state.card&&r.state!=='active'} onChange={async e=>{const enabled=e.target.checked;setBusy(true);setError('');try{await api(enabled?'/access/billing-enable':'/access/billing-disable',enabled?{offerVersion:legalDocuments.offer.version,renewalVersion:legalDocuments.renewal.version}:{});await reload();}catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить.');}finally{setBusy(false);}}}/><label htmlFor="account-auto">Включить автопродление. <a href="/autorenewal" target="_blank" rel="noreferrer">Условия автопродления</a></label></div>
 <p>{r.tariff.name} · {moneyLabel(r.tariff.priceMinor)}. {r.state==='active'?'Следующий платёж — '+dateLabel(r.nextAt)+'.':'Списаний не будет. Оплаченный доступ сохраняется до конца срока.'}{state.card?.last4?' Карта •••• '+state.card.last4+'.':''}</p>{error&&<p role="alert" className={styles.error}>{error}</p>}</section>;
}
