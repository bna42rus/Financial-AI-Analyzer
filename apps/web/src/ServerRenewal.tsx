import {useEffect,useState} from 'react';
import {timezoneLabel} from './InterfaceSettings';
import {api} from './server-client';
import {OnlineRenewal,useAccessBilling} from './AccessBilling';
import {dateLabel,durationLabel,moneyLabel} from '../../../packages/access/src/model';
import {renewalLabel} from '../../../packages/access/src/renewal';
import type {OwnRenewal} from '../../../packages/access/src/renewal';
import styles from './ServerAccess.module.css';
export function ServerRenewal({onRefresh,embedded=false}:{onRefresh:()=>Promise<void>;embedded?:boolean}){
 const {state,loaded,error,reload}=useAccessBilling();
 if(!loaded)return <p role="status">Проверяем доступные способы продления…</p>;
 if(error&&!state)return <div className={styles.renewalBody}><p role="alert">Не удалось проверить продление.</p><button className={styles.secondary} onClick={()=>void reload().catch(()=>{})}>Повторить</button></div>;
 return state?.enabled||state?.renewal?<OnlineRenewal state={state} refresh={reload} onRefresh={onRefresh}/>:<ManualRenewal onRefresh={onRefresh} embedded={embedded}/>;
}
function ManualRenewal({onRefresh,embedded=false}:{onRefresh:()=>Promise<void>;embedded?:boolean}){
 const [data,setData]=useState<OwnRenewal|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let live=true;api<OwnRenewal>('/access/renewal').then(r=>{if(live)setData(r);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[]);
 async function run(path:string,body?:Record<string,unknown>){if(busy)return;setBusy(true);setError('');try{setData(await api<OwnRenewal>(path,body));await onRefresh();}catch(e){setError(e instanceof Error?e.message:'Не удалось обновить заявку.');}finally{setBusy(false);}}
 useEffect(()=>{if(!data?.request||data.request.renewalState!=='open')return;let live=true;const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void api<OwnRenewal>('/access/renewal').then(r=>{if(live)setData(r);}).catch(()=>{});},15000);return()=>{live=false;window.clearInterval(timer);};},[data?.request?.id,data?.request?.renewalState]);
 const row=data?.request,open=row?.renewalState==='open',editable=open&&!row.claimedAt;
 return <section className={embedded?styles.renewalBody:styles.card}>{!embedded&&<h2>Продлить доступ</h2>}{error&&<p role="alert" className={styles.error}>{error}</p>}{data&&<><p>{data.cycle.indefinite?'Доступ бессрочный. Продление не требуется; сохранённые заявки доступны для просмотра.':`Текущий срок: до ${dateLabel(data.cycle.accessEnd)}`} ({timezoneLabel(data.cycle.timezone)}).</p>
 {row&&<div className={styles.record}><strong>{renewalLabel(row)}</strong><p>{row.tariff.name} · {durationLabel(row.tariff.duration)} · {moneyLabel(row.tariff.priceMinor)}</p><p>Лимит Анализатора: {row.tariff.aiQuota.toLocaleString('ru-RU')} единиц {row.tariff.duration.kind==='days'?'за период':'в месяц'}. Досрочное продление не обнуляет использованный лимит.</p>{row.renewalState==='completed'&&<p>Оплата подтверждена. Текущая дата окончания показана выше.</p>}{row.renewalState==='rejected'&&<p>{row.decisionNote}</p>}{open&&row.status==='under_review'&&<p>Проверяем оплату.</p>}</div>}
 {!data.cycle.indefinite&&(!open?<button className={styles.primary} disabled>Продлить доступ</button>:<>
 {editable&&<form onSubmit={e=>{e.preventDefault();const d=new FormData(e.currentTarget);void run('/access/renewal-change',{requestId:row.id,expectedRevision:row.revision,tariffId:String(d.get('tariff'))});}}><label>Изменить период<select name="tariff" defaultValue={row.tariff.id}>{!data.tariffs.some(t=>t.id===row.tariff.id)&&<option value={row.tariff.id}>{row.tariff.name} — сохранённый тариф</option>}{data.tariffs.map(t=><option key={t.id} value={t.id}>{t.name} — {moneyLabel(t.priceMinor)}</option>)}</select></label><div className={styles.actions}><button className={styles.secondary} disabled={busy||!data.tariffs.length}>Сохранить период</button><button type="button" className={styles.secondary} disabled={busy} onClick={()=>void run('/access/renewal-cancel',{requestId:row.id,expectedRevision:row.revision})}>Отменить заявку</button></div></form>}
 {['awaiting_payment','needs_topup'].includes(row.status)&&<form onSubmit={e=>{e.preventDefault();const d=new FormData(e.currentTarget);void run('/access/renewal-claim',{requestId:row.id,expectedRevision:row.revision,senderName:String(d.get('sender')),senderBank:String(d.get('bank'))});}}>{row.status==='needs_topup'&&row.remainingMinor&&<p>Осталось доплатить: {moneyLabel(row.remainingMinor)}.</p>}<p>Цена сохранена в заявке. Тестовые реквизиты ещё не подключены; реальный перевод делать не нужно.</p><label>Имя отправителя<input name="sender" required maxLength={100}/></label><label>Банк отправителя<input name="bank" required maxLength={100}/></label><button className={styles.primary} disabled={busy}>Я оплатил — тестовая отметка</button></form>}</>)}
 </>}</section>;
}
