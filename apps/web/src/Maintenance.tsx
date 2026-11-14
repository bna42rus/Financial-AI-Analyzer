import {useCallback,useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {CheckCircle2,Clock3,RefreshCw,Wrench,X} from 'lucide-react';
import {maintenanceWarning} from '../../../packages/access/src/maintenance';
import type {Maintenance} from '../../../packages/access/src/maintenance';
import {api} from './server-client';
import {Brand} from './Brand';
import {LegalFooter} from './LegalPages';
import {SupportLink} from './SupportDialog';
import {setMaintenanceActive} from './maintenance-state';
import common from './App.module.css';
import styles from './Maintenance.module.css';
const cacheKey='cashneuro-public-maintenance';
function valid(v:unknown):v is Maintenance{if(!v||typeof v!=='object')return false;const m=v as Maintenance;return Number.isSafeInteger(m.revision)&&m.revision>=0&&['none','scheduled','completed','cancelled'].includes(m.state)&&['none','scheduled','active','completed','cancelled'].includes(m.phase)&&typeof m.title==='string'&&typeof m.message==='string'&&[m.now,m.updatedAt].every(d=>typeof d==='string'&&Number.isFinite(Date.parse(d)))&&[m.startsAt,m.endsAt].every(d=>d===null||typeof d==='string'&&Number.isFinite(Date.parse(d)))&&(m.phase!=='active'&&m.phase!=='scheduled'||!!m.startsAt&&!!m.endsAt);}
function cached():Maintenance|null{try{const v=JSON.parse(localStorage.getItem(cacheKey)??'null');return valid(v)?v:null;}catch{return null;}}
const date=(v:string)=>new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Moscow'}).format(new Date(v));
export function MaintenanceBoundary({children}:{children:ReactNode}){
 const [status,setStatus]=useState<Maintenance|null>(cached),[loaded,setLoaded]=useState(false),[unavailable,setUnavailable]=useState(false),[held,setHeld]=useState(false),[dismissed,setDismissed]=useState('');
 const visited=useRef(false),running=useRef(false),mounted=useRef(false);
 const update=useCallback(async()=>{
  if(running.current)return;running.current=true;
  try{const next=await api<Maintenance>('/public/maintenance',undefined,AbortSignal.timeout(7000));if(!valid(next))throw Error('Invalid maintenance status');if(mounted.current){setStatus(next);setUnavailable(false);try{localStorage.setItem(cacheKey,JSON.stringify(next));}catch{}}}
  catch{if(mounted.current)setUnavailable(true);}
  finally{running.current=false;if(mounted.current)setLoaded(true);}
 },[]);
 useEffect(()=>{
  mounted.current=true;void update();
  const tick=()=>{if(document.visibilityState!=='hidden')void update();},changed=(e:Event)=>{const next=(e as CustomEvent<Maintenance>).detail;if(valid(next)){setStatus(next);setUnavailable(false);setLoaded(true);}};
  const timer=window.setInterval(tick,30000);window.addEventListener('focus',tick);window.addEventListener('cashneuro-maintenance',changed);
  return()=>{mounted.current=false;window.clearInterval(timer);window.removeEventListener('focus',tick);window.removeEventListener('cashneuro-maintenance',changed);};
 },[update]);
 const active=status?.phase==='active',blocked=active||unavailable||held;
 useEffect(()=>{if(active||unavailable)setHeld(true);},[active,unavailable]);
 useEffect(()=>{setMaintenanceActive(blocked);return()=>setMaintenanceActive(false);},[blocked]);
 if(loaded&&!blocked)visited.current=true;
 const ready=loaded&&!active&&!unavailable,warning=status?maintenanceWarning(status):0,key=status?.revision+':'+warning;
 const cancelled=status?.phase==='cancelled'&&Date.parse(status.now)-Date.parse(status.updatedAt)<86400000;
 return <>
  {!blocked&&loaded&&status&&(warning||cancelled)&&dismissed!==key&&<aside className={styles.banner} role="status"><Clock3 size={18}/><span>{cancelled?'Объявленные технические работы отменены.':`Плановые технические работы ${date(status.startsAt!)} — ${date(status.endsAt!)} МСК. В это время сервис будет недоступен.`}</span><button className={common.iconButton} aria-label="Скрыть предупреждение о работах" onClick={()=>setDismissed(key)}><X size={17}/></button></aside>}
  {visited.current&&<div hidden={blocked}>{children}</div>}
  {(blocked||!loaded)&&<div className={styles.page}>
   <header className={styles.header}><a href="/" aria-label="CashNeuro — на главную"><Brand/></a><SupportLink showIcon/></header>
   <main className={styles.main}>
    <div className={styles.art} aria-hidden="true"><span/><span/><div>{ready?<CheckCircle2 size={48}/>:<Wrench size={46}/>}</div></div>
    <div className={styles.pill}>{ready?'Снова на связи':!loaded?'Проверяем доступность':active?'Технические работы':'Временный перерыв'}</div>
    <h1>{ready?'CashNeuro снова доступен':active?status.title:unavailable?'Скоро вернёмся':'Открываем CashNeuro'}</h1>
    <p className={styles.lead}>{ready?'Работы завершены. Можно продолжить с того места, где остановились.':active?(status.message||'Обновляем сервис, чтобы работать с финансами было ещё удобнее.'):unavailable?'Сервис временно недоступен. Проверяем соединение и ждём восстановления.':'Проверяем состояние сервиса. Это займёт немного времени.'}</p>
    {(active||unavailable)&&<div className={styles.details}>{status?.startsAt&&<div><span>Начало работ</span><strong>{date(status.startsAt)} МСК</strong></div>}{status?.endsAt&&<div><span>Планируем завершить</span><strong>{Date.parse(status.endsAt)>Date.parse(status.now)?date(status.endsAt)+' МСК':'Работы продолжаются. Уточняем время.'}</strong></div>}<p>Ваши данные и история сохраняются.</p></div>}
    <div className={styles.actions}>{ready?<button className={common.primaryButton} onClick={()=>setHeld(false)}>Вернуться в CashNeuro</button>:<button className={common.button} onClick={()=>void update()}><RefreshCw size={17}/>Проверить доступность</button>}<SupportLink/></div>
    {status&&(active||unavailable)&&<small className={styles.updated}>Обновлено {date(status.updatedAt)} МСК</small>}
   </main><LegalFooter/>
  </div>}
 </>;
}
