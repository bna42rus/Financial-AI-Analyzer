import {useEffect,useRef,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {api} from './server-client';
import type {FinanceState} from './finance-client';
import {displayBankDate,kindNames,reviewNames} from './finance-client';
import {formatMoney} from './demo/overview';
import {QuickReviewFields} from './QuickReviewFields';
import type {WorkspaceCommand} from './workspace-command';
import common from './App.module.css';
import styles from './Settings.module.css';

type Queue={id:string;generation:string;revision:string;financeRevision:string;remaining:number;anchor?:string;operations:FinanceState['operations'];similar:string[]};
export function ServerReview({state,refreshKey,command,disabled,timezone,onOpen,onAccessError,onBusy}:{state:FinanceState;refreshKey:number;command:WorkspaceCommand|null;disabled:boolean;timezone:string;onOpen:(id:string)=>void;onAccessError:(e:unknown)=>boolean;onBusy:(v:boolean)=>void}){
 const [queue,setQueue]=useState<Queue|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[show,setShow]=useState(false),[selected,setSelected]=useState<string[]>([]);
 const turn=useRef(0),seenRefresh=useRef(refreshKey);
 async function load(params:Record<string,unknown>={}){
  const version=++turn.current;setBusy(true);setError('');
  try{const data=await api<Queue>('/finance/review-queue',{generation:state.generation,...params});if(version!==turn.current)return;setQueue(data);}
  catch(e){if(version===turn.current&&!onAccessError(e))setError(e instanceof Error?e.message:'Не удалось открыть список проверки.');}
  finally{if(version===turn.current){setBusy(false);onBusy(false);}}
 }
 useEffect(()=>{if(disabled)return;const refresh=seenRefresh.current!==refreshKey;seenRefresh.current=refreshKey;void load(refresh?{refresh:true}:{});return()=>{++turn.current;onBusy(false);};},[state.generation,state.revision,refreshKey,disabled]);
 useEffect(()=>{setShow(false);setSelected([]);},[queue?.anchor]);
 const op=queue?.operations.find(o=>o.id===queue.anchor),similar=(queue?.similar??[]).filter(id=>id!==op?.id),items=new Map(queue?.operations.map(o=>[o.id,o])),locked=disabled||busy||queue?.financeRevision!==state.revision;
 const name=(item:FinanceState['operations'][number])=>item.displayName?.compositeLabel||item.classification.merchant.value||kindNames[item.classification.kind.value];
 const values=(item:FinanceState['operations'][number])=>displayBankDate(item.date,timezone)+' · '+formatMoney(item.amountMinor)+' · '+(state.accounts.find(a=>a.id===item.accountId)?.name??'Счёт');
 const ruleHint=op?.classification.kind.value==='purchase'&&op.classification.merchant.value&&BigInt(op.amountMinor)<0n?'Новые покупки: '+op.classification.merchant.value+' · '+(state.accounts.find(a=>a.id===op.accountId)?.name??'тот же счёт'):undefined;
 return <section className={styles.reviewPanel} aria-label="Нужно проверить">
  <div className={styles.reviewHead}><h3>{queue?'Осталось разобрать: '+queue.remaining:'Нужно проверить'}</h3><button className={common.iconButton} disabled={busy||disabled} title="Обновить список проверки" aria-label="Обновить список проверки" onClick={()=>void load({refresh:true})}><RefreshCw size={18}/></button></div>
  {error&&<p role="alert" className={common.error}>{error}</p>}
  {queue?.remaining===0&&<p className={styles.muted}>Все операции проверены.</p>}
  {queue&&op&&<div className={styles.settingsStack}>
   <div className={styles.currentReview}><button className={common.linkButton} onClick={()=>onOpen(op.id)}>{name(op)}</button><p className={styles.muted}>{values(op)}</p><p>{op.reviewReasons.map(r=>reviewNames[r]??'Нужно проверить').join(' · ')}</p></div>
   {similar.length>0&&<details className={styles.similarReview} open={show} onToggle={e=>setShow(e.currentTarget.open)}><summary>Похожие операции: {similar.length}</summary><label className={styles.reviewChoice}><input type="checkbox" checked={similar.every(id=>selected.includes(id))} disabled={locked} onChange={e=>setSelected(e.target.checked?similar:[])}/>Выбрать все похожие</label><ul className={styles.reviewList}>{similar.map(id=>{const item=items.get(id);return item&&<li key={id}><label className={styles.reviewChoice}><input type="checkbox" checked={selected.includes(id)} disabled={locked} onChange={e=>setSelected(ids=>e.target.checked?[...ids,id]:ids.filter(v=>v!==id))}/><span>{name(item)}<small>{values(item)}</small></span></label></li>;})}</ul></details>}
   <QuickReviewFields key={queue.id+':'+op.id+':'+queue.financeRevision} op={op} state={state} similarIds={selected.filter(id=>similar.includes(id))} disabled={locked||!command} ruleHint={ruleHint} canSkip={queue.remaining>1} onOpen={()=>onOpen(op.id)} onSkip={()=>{onBusy(true);void load({skip:op.id,revision:queue.revision});}} onApply={intent=>void command?.begin({...intent,reviewScope:{sessionId:queue.id,revision:queue.revision,anchorId:op.id}},'Решение при проверке',!!intent.rememberRule,{generation:queue.generation,revision:queue.financeRevision})}/>
  </div>}
 </section>;
}
