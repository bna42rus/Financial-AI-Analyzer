import {useEffect,useState} from 'react';
import {timezoneLabel} from './InterfaceSettings';
import {api} from './server-client';
import {OnlineRenewal,useAccessBilling} from './AccessBilling';
import {moneyLabel} from '../../../packages/access/src/model';
import type {OwnRenewal} from '../../../packages/access/src/renewal';
import styles from './ServerAccess.module.css';

export function ServerRenewal({onRefresh,embedded=false,initialTariffId=''}:{onRefresh:()=>Promise<void>;embedded?:boolean;initialTariffId?:string}){
 const {state,loaded,error,reload}=useAccessBilling();
 if(!loaded)return <p role="status">Проверяем продление…</p>;
 if(error&&!state)return <div className={styles.renewalBody}><p role="alert" className={styles.error}>Не удалось проверить продление.</p><button className={styles.secondary} onClick={()=>void reload().catch(()=>{})}>Повторить</button></div>;
 return state?.enabled||state?.order&&['created','pending','reconcile'].includes(state.order.state)
  ?<OnlineRenewal state={state} refresh={reload} onRefresh={onRefresh} initialTariffId={initialTariffId}/>
  :<RenewalPreview embedded={embedded} initialTariffId={initialTariffId}/>;
}

function RenewalPreview({embedded,initialTariffId}:{embedded:boolean;initialTariffId:string}){
 const [data,setData]=useState<OwnRenewal|null>(null),[error,setError]=useState(''),[chosen,setChosen]=useState(initialTariffId),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  const abort=new AbortController();
  void api<OwnRenewal>('/access/renewal',undefined,AbortSignal.any([abort.signal,AbortSignal.timeout(8000)]))
   .then(value=>{if(!abort.signal.aborted)setData(value);})
   .catch(e=>{if(!abort.signal.aborted)setError(e.message);});
  return ()=>abort.abort();
 },[attempt]);
 const tariff=data?.tariffs.find(t=>t.id===chosen)??data?.tariffs[0],plannedEnd=tariff&&data?.plannedEnds?.[tariff.id];
 const date=(value:string)=>new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:data?.cycle.timezone??'Europe/Moscow'}).format(new Date(value));
 return <section className={embedded?styles.renewalBody:styles.card}>
  {!embedded&&<h2>Продлить доступ</h2>}
  {error&&<><p role="alert" className={styles.error}>{error}</p><button className={styles.secondary} onClick={()=>{setError('');setAttempt(v=>v+1);}}>Повторить</button></>}
  {!data&&!error&&<p role="status">Загружаем периоды продления…</p>}
  {data&&<>
   <p>{data.cycle.indefinite?'Доступ бессрочный.':data.cycle.accessEnd?('Текущий срок — до '+date(data.cycle.accessEnd)+' ('+timezoneLabel(data.cycle.timezone)+').'):'Текущий срок не задан.'}</p>
   {data.request?.renewalState==='open'&&['under_review','needs_topup'].includes(data.request.status)&&<p role="status">Проверяем ранее начатый платёж.</p>}
   {!data.cycle.indefinite&&tariff&&<>
    <label>Период продления<select aria-label="Период продления" value={tariff.id} onChange={e=>setChosen(e.target.value)}>
     {data.tariffs.map(t=><option key={t.id} value={t.id}>{t.name} — {moneyLabel(t.priceMinor)}</option>)}
    </select></label>
    {plannedEnd&&<p>После продления — до {date(plannedEnd)}.</p>}
    <p>Лимит Анализатора на новый период — {tariff.aiQuota.toLocaleString('ru-RU')} единиц {tariff.duration.kind==='days'?'за период':'в месяц'}. Досрочное продление сохраняет текущий остаток.</p>
    <button type="button" className={styles.primary} disabled>Перейти к оплате · {moneyLabel(tariff.priceMinor)}</button>
   </>}
  </>}
 </section>;
}
