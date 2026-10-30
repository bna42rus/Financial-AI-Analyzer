import {Ellipsis,LoaderCircle} from 'lucide-react';
import {OverviewPopover} from './OverviewDialogs';
import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from './server-client';
import {useNotices} from './Notifications';
import type {OperationsFilter} from '../../../packages/finance-core/src/operations';
import common from './App.module.css';
import styles from './Overview.module.css';
import noticeStyles from './Notifications.module.css';
type Summary={id:string;scanned:number;defined:number;newlyAssigned:number;changed:number;refined:number;unchanged:number;unresolved:number;needsReview:number;unresolvedIds?:string[]};
type Status={enabled:boolean;state:'idle'|'queued'|'completed'|'blocked';calls:number;applied:number;uncertain:number;canStart:boolean;sourceKey:string;passId:string|null;last:Summary|null};
export function ServerClassification({revision,disabled,onChanged,onAccessError,onUnresolved,visible=true}:{revision:string;disabled:boolean;onChanged:()=>void;onAccessError:(e:unknown)=>void;onUnresolved:(filter:OperationsFilter)=>void;visible?:boolean}){
 const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[summary,setSummary]=useState<Summary|null>(null),notices=useNotices();
 const callbacks=useRef({onChanged,onAccessError,onUnresolved});callbacks.current={onChanged,onAccessError,onUnresolved};
 const previous=useRef<number|null>(null),mounted=useRef(false),watching=useRef(false),source=useRef(''),turn=useRef(0),currentRevision=useRef(revision);currentRevision.current=revision;
 async function read(start=false){const version=++turn.current,observedRevision=currentRevision.current;
  try{const value=await api<Status>('/finance/classification',start?{start:true}:{});if(!mounted.current||version!==turn.current||!start&&observedRevision!==currentRevision.current)return;
   if(value.canStart&&source.current!==value.sourceKey)setSummary(null);source.current=value.sourceKey;
   if(value.state==='queued'){watching.current=true;setSummary(null);}
   else if(watching.current){watching.current=false;if(value.last)setSummary(value.last);}
   setStatus(value);if(previous.current!==null&&value.applied!==previous.current)callbacks.current.onChanged();previous.current=value.applied;
  }catch(e){if(!mounted.current||version!==turn.current)return;if(e instanceof ApiError&&['AUTH_REQUIRED','FINANCE_ACCESS_REQUIRED','ACCESS_EXPIRED','SUSPENDED','GENERATION_CHANGED'].includes(e.code))callbacks.current.onAccessError(e);else notices?.push({id:'classification-error:'+crypto.randomUUID(),group:'classification-error',title:start?'Не удалось запустить распределение категорий':'Не удалось обновить состояние обработки',duration:5000});}
 }
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;++turn.current;};},[]);
 useEffect(()=>{void read();},[revision]);
 useEffect(()=>{if(status?.state!=='queued')return;const timer=window.setInterval(()=>void read(),2000);return()=>window.clearInterval(timer);},[status?.state]);
 if(!visible||!status||!status.enabled&&!summary||!status.canStart&&status.state!=='queued'&&!summary)return null;
 async function start(){if(!status?.canStart||busy)return;setBusy(true);setSummary(null);watching.current=true;try{await read(true);}finally{if(mounted.current)setBusy(false);}}
 return <OverviewPopover label="Определение категорий с помощью ИИ" icon={<Ellipsis size={19}/>}><section aria-label="Распределение категорий">
 <button className={common.button} disabled={disabled||busy||!status.canStart} onClick={()=>void start()}>Распределить категории</button>
 {(busy||status.state==='queued')?<div role="status" className={styles.classificationBusy}><LoaderCircle className={noticeStyles.spinner} size={22}/><span>Определяем категории…</span></div>:summary&&<section aria-label="Последняя обработка категорий"><dl className={styles.classificationStats}>{[['Обработано операций',summary.scanned],['Всего с категорией',summary.defined],['Назначено впервые',summary.newlyAssigned],['Изменено назначений',summary.changed],['Из них уточнено',summary.refined],['Без изменений',summary.unchanged],['Без категории',summary.unresolved],['Требуют проверки',summary.needsReview]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{summary.unresolved>0&&<button className={common.button} data-close-popover onClick={()=>callbacks.current.onUnresolved({uncategorized:true,...(summary.unresolvedIds?{operationIds:summary.unresolvedIds}:{})})}>{summary.unresolvedIds?'Разобрать неопределённые операции':'Все операции без категории'}</button>}</section>}
 </section></OverviewPopover>;
}
