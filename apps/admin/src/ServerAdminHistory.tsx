import {useEffect,useState} from 'react';
import {api} from '../../web/src/server-client';
import {moneyLabel} from '../../../packages/access/src/model';
import {SelectField} from '../../web/src/SelectField';
import {useAdminTime} from './admin-view';
import shell from './ServerAdmin.module.css';
import {SearchField} from '../../web/src/SearchFilter';
import styles from '../../web/src/ServerAccess.module.css';
type Change={label:string;before:unknown;after:unknown};
type Entry={changes:Change[]|null;id:string;kind:string;decision:string|null;target:string|null;actor:string|null;at:string;note:string|null;before:string|null;after:string|null;beforeIndefinite:boolean;afterIndefinite:boolean};
const names:Record<string,string>={checkout_paid:'Оплачен первый доступ',checkout_renewed:'Оплаченное продление применено',billing_refund:'Подтверждён возврат',tariff_created:'Добавлен тариф',pack_created:'Добавлен пакет Анализатора',account_deletion_withdrawn:'Заявка на удаление отозвана',user_access_status:'Изменено ограничение доступа',suspended:'Доступ приостановлен',active:'Блокировка снята',quota:'Изменён лимит Анализатора',checkout_reconciliation:'Сверка онлайн-платежа',check:'Запрошена сверка платежа',apply:'Запрошено применение результата сверки',account_deletion_completed:'Аккаунт удалён',commerce_catalog_updated:'Изменены тарифы или пакеты',extend:'Доступ продлён',set_end:'Изменена дата окончания',indefinite:'Выдан бессрочный доступ',end_now:'Доступ завершён',invite:'Выдано приглашение',cancel:'Приглашение отменено',reissue:'Приглашение заменено',review:'Сверка первого платежа',renewal:'Решение по продлению',manual_access:'Ручное изменение доступа',manual_invitation:'Изменено ручное приглашение',invitation:'Изменено приглашение',invitation_resend:'Приглашение отправлено повторно',mail_retry:'Письмо поставлено в очередь повторно',account_deletion:'Решение по удалению аккаунта',tariff:'Тариф изменён',pack:'Пакет изменён'};
export function ServerAdminHistory({refresh,initialSearch}:{refresh:number;initialSearch?:string}){
 const time=useAdminTime(),[kind,setKind]=useState('');
 const [rows,setRows]=useState<Entry[]>([]),[search,setSearch]=useState(initialSearch??''),[error,setError]=useState(''),[pending,setPending]=useState(true),[more,setMore]=useState(true);
 useEffect(()=>{if(initialSearch!==undefined)setSearch(initialSearch);},[initialSearch]);
 useEffect(()=>{const abort=new AbortController();setPending(true);setError('');const timer=setTimeout(()=>{
  void api<{entries:Entry[]}>('/control/history',{search,kind},abort.signal).then(r=>{if(!abort.signal.aborted){setRows(r.entries);setMore(r.entries.length===50);}}).catch(e=>{if(!abort.signal.aborted)setError(e.message);}).finally(()=>{if(!abort.signal.aborted)setPending(false);});
 },350);return()=>{clearTimeout(timer);abort.abort();};},[search,refresh,kind]);
 async function next(){if(pending||!rows.length)return;setPending(true);setError('');try{const last=rows.at(-1)!;const r=await api<{entries:Entry[]}>('/control/history',{search,kind,before:{at:last.at,id:last.id}});setRows(previous=>[...previous,...r.entries]);setMore(r.entries.length===50);}catch(e){setError(e instanceof Error?e.message:'Не удалось открыть историю.');}finally{setPending(false);}}
 return <section className={styles.card}><div className={shell.filters}><SearchField value={search} onValueChange={setSearch} placeholder="Адрес, решение или заметка" aria-label="Поиск по истории"/><SelectField aria-label="Событие" value={kind} onChange={e=>setKind(e.target.value)}><option value="">Все события</option><option value="account_deletion_completed">Аккаунт удалён</option><option value="account_deletion_withdrawn">Заявка отозвана</option></SelectField></div>
 {error&&<p role="alert" className={styles.error}>{error}</p>}{pending&&!rows.length&&<p role="status">Загружаем историю…</p>}{!pending&&!rows.length&&!error&&<p>Подходящих решений нет.</p>}
 <div className={shell.records}>{rows.map(r=><article key={r.id}><strong>{names[r.decision??'']??names[r.kind]??'Административное действие'}</strong>
 <p>{time.format(r.at)}{r.target?' · '+r.target:''}{r.actor?' · '+r.actor:''}</p>
 <details><summary>Подробнее</summary><div>
  {!!r.changes?.length&&<dl className={shell.detailList}>{r.changes.map((change,i)=><div key={change.label+i}><dt>{change.label}</dt><dd>{historyValue(change.before)} → {historyValue(change.after)}</dd></div>)}</dl>}
  {(r.before!==r.after||r.beforeIndefinite!==r.afterIndefinite)&&<p>Срок доступа · {r.beforeIndefinite?'Бессрочно':time.format(r.before)} → {r.afterIndefinite?'Бессрочно':time.format(r.after)}</p>}
  {r.note&&<p>Заметка · {r.note}</p>}
  {!r.changes?.length&&!r.note&&r.before===r.after&&r.beforeIndefinite===r.afterIndefinite&&<p>Событие записано без списка изменённых полей.</p>}
 </div></details></article>)}</div>
 {more&&rows.length>0&&<button className={styles.secondary} disabled={pending} onClick={()=>void next()}>Показать ещё</button>}</section>;
}

function historyValue(value:unknown):string{
 if(value==null)return '—';
 if(typeof value==='boolean')return value?'Да':'Нет';
 if(typeof value==='object'&&'limit'in value){
  const q=value as {limit:number;periodDays?:number;budgetMinor?:string};
  return q.budgetMinor!==undefined?moneyLabel(q.budgetMinor)+' в месяц':q.limit.toLocaleString('ru-RU')+' единиц'+(q.periodDays?' за период ('+q.periodDays+' дней)':' в месяц');
 }
 return typeof value==='number'?value.toLocaleString('ru-RU'):String(value);
}
