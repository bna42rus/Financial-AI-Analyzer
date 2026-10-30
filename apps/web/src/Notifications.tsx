import {createPortal} from 'react-dom';
import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {LoaderCircle,X} from 'lucide-react';
import styles from './Notifications.module.css';
export type Notice={id:string;group?:string;title:string;detail?:string;duration?:number;busy?:boolean;progress?:number;secondaryAction?:{label:string;run:()=>void};action?:{label:string;accessibleLabel?:string;run:()=>void}};
type Notices={push:(notice:Notice)=>void;dismiss:(id:string)=>void;clear:()=>void};
const Context=createContext<Notices|null>(null);
export function Notifications({children}:{children:ReactNode}){
 const [host,setHost]=useState<HTMLElement|null>(null),[items,setItems]=useState<Notice[]>([]),closed=useRef(new Set<string>());
 const dismiss=useCallback((id:string)=>{closed.current.add(id);setItems(items=>items.filter(n=>n.id!==id));},[]);
 const push=useCallback((notice:Notice)=>{if(closed.current.has(notice.id))return;setItems(items=>[...items.filter(n=>n.id!==notice.id&&(!notice.group||n.group!==notice.group)),notice].slice(-3));},[]);
 useEffect(()=>{const place=()=>{const dialogs=[...document.querySelectorAll<HTMLElement>('[role=dialog]')];setHost(dialogs.at(-1)??document.body);};const observer=new MutationObserver(place);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['role']});place();return()=>observer.disconnect();},[]);
 const clear=useCallback(()=>{closed.current.clear();setItems([]);},[]);
 const value=useMemo(()=>({push,dismiss,clear}),[push,dismiss,clear]);
 return <Context.Provider value={value}>{children}{host&&createPortal(<aside className={styles.viewport} aria-label="Уведомления">{items.map(n=><Toast key={n.id} notice={n} onClose={()=>dismiss(n.id)}/>)}</aside>,host)}</Context.Provider>;
}
function Toast({notice:n,onClose}:{notice:Notice;onClose:()=>void}){
 const [paused,setPaused]=useState(false),close=useRef(onClose);close.current=onClose;
 useEffect(()=>{if(!n.duration||paused)return;const timer=setTimeout(()=>close.current(),n.duration);return()=>clearTimeout(timer);},[n.id,n.duration,paused]);
 return <section className={styles.toast} onMouseEnter={()=>setPaused(true)} onMouseLeave={()=>setPaused(false)} onFocusCapture={()=>setPaused(true)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setPaused(false);}}><button className={styles.close} aria-label={'Закрыть уведомление: '+n.title} onClick={onClose}><X size={17}/></button><div role="status" aria-live="polite"><strong>{n.busy&&<LoaderCircle className={styles.spinner} size={17}/>} {n.title}</strong>{n.detail&&<p>{n.detail}</p>}{n.progress!==undefined&&<div className={styles.progress}><progress max={100} value={n.progress} aria-label="Ход загрузки"/><span>{n.progress}%</span></div>}{n.busy&&n.progress===undefined&&<progress className={styles.pending} aria-label="Подготовка загрузки"/>}</div>{n.action&&<button className={styles.action} aria-label={n.action.accessibleLabel??n.action.label} onClick={n.action.run}>{n.action.label}</button>}{n.secondaryAction&&<button className={styles.action} onClick={n.secondaryAction.run}>{n.secondaryAction.label}</button>}</section>;
}
export function useNotices(){return useContext(Context);}
/** Only acknowledged writes produce a success notice; errors and uncertain receipts stay in place. */
export function useMutationNotice(state:{phase:string;message:string;undoActionId:string|null;bulkResult?:{selectedCount:number;remainingReviewIds:string[]}|null},undo:(id:string)=>void,quiet=false){
 const notices=useNotices(),last=useRef(''),handler=useRef(undo);handler.current=undo;
 useEffect(()=>{if(!state.message){last.current='';return;}if(state.phase!=='idle'||quiet||!notices||!['Изменение сохранено.','Изменение отменено.','Загрузка отменена. Для восстановления выберите исходные файлы заново.'].includes(state.message))return;
  const token=state.message+':'+state.undoActionId;if(last.current===token)return;last.current=token;const id=state.undoActionId;
  notices.push({id:'mutation:'+crypto.randomUUID(),group:'mutation',title:state.message,detail:state.bulkResult?`Обработано операций: ${state.bulkResult.selectedCount}. Требуют проверки: ${state.bulkResult.remainingReviewIds.length}.`:undefined,duration:id?10000:5000,...(id?{action:{label:'Отменить',accessibleLabel:'Отменить последнее изменение',run:()=>handler.current(id)}}:{})});
 },[state.phase,state.message,state.undoActionId,state.bulkResult,quiet,notices]);
}
