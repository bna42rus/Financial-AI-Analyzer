import {missingCategoryLabel} from '../../../packages/finance-core/src/review';
import {useEffect,useRef,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {api} from './server-client';
import type {FinanceState,OperationPatch} from './finance-client';
import {displayBankDate,kindNames,reviewNames} from './finance-client';
import {formatMoney} from './demo/overview';
import {ReviewIssues,emptyReviewEdits} from './ReviewIssues';
import type {ReviewEdits} from './ReviewIssues';
import {QuickReviewFields} from './QuickReviewFields';
import type {WorkspaceCommand} from './workspace-command';
import common from './App.module.css';
import styles from './Settings.module.css';

type Queue={id:string;generation:string;revision:string;financeRevision:string;remaining:number;anchor?:string;operations:FinanceState['operations'];similar:string[]};
export function ServerReview({state,refreshKey,command,disabled,timezone,onOpen,onAccessError,onBusy}:{state:FinanceState;refreshKey:number;command:WorkspaceCommand|null;disabled:boolean;timezone:string;onOpen:(id:string)=>void;onAccessError:(e:unknown)=>boolean;onBusy:(v:boolean)=>void}){
 const [queue,setQueue]=useState<Queue|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[applySimilar,setApplySimilar]=useState(false),[selected,setSelected]=useState<string[]>([]);
 const [edits,setEdits]=useState<ReviewEdits>(emptyReviewEdits),[fieldsDirty,setFieldsDirty]=useState(false),[fieldPatch,setFieldPatch]=useState<OperationPatch>({});
 const applying=useRef<string|null>(null);const turn=useRef(0),seenRefresh=useRef(refreshKey);
 useEffect(()=>{setEdits(emptyReviewEdits());setFieldsDirty(false);},[queue?.anchor,queue?.id]);
 useEffect(()=>{if(applying.current&&state.revision!==applying.current&&command?.snapshot().phase==='idle'&&!command.snapshot().error){setEdits(emptyReviewEdits());applying.current=null;}},[state.revision,command]);
 async function load(params:Record<string,unknown>={}){
  const version=++turn.current;setBusy(true);setError('');
  try{const data=await api<Queue>('/finance/review-queue',{generation:state.generation,...params});if(version!==turn.current)return;setQueue(data);}
  catch(e){if(version===turn.current&&!onAccessError(e))setError(e instanceof Error?e.message:'Не удалось открыть список проверки.');}
  finally{if(version===turn.current){setBusy(false);onBusy(false);}}
 }
 useEffect(()=>{if(disabled)return;const refresh=seenRefresh.current!==refreshKey;seenRefresh.current=refreshKey;void load(refresh?{refresh:true}:{});return()=>{++turn.current;onBusy(false);};},[state.generation,state.revision,refreshKey,disabled]);
 useEffect(()=>{setApplySimilar(false);setSelected([]);},[queue?.id,queue?.anchor,queue?.financeRevision]);
 const op=queue?.operations.find(o=>o.id===queue.anchor),similar=(queue?.similar??[]).filter(id=>id!==op?.id),items=new Map(queue?.operations.map(o=>[o.id,o])),locked=disabled||busy||queue?.financeRevision!==state.revision;
 const name=(item:FinanceState['operations'][number])=>item.displayName?.compositeLabel||item.classification.merchant.value||kindNames[item.classification.kind.value];
 const values=(item:FinanceState['operations'][number])=>displayBankDate(item.date,timezone)+' · '+formatMoney(item.amountMinor)+' · '+(state.accounts.find(a=>a.id===item.accountId)?.name??'Счёт');
 return <section className={styles.reviewPanel} aria-label="Нужно проверить">
  <div className={styles.reviewHead}><h3>{queue?'Осталось разобрать: '+queue.remaining:'Нужно проверить'}</h3><button className={common.iconButton} disabled={busy||disabled} title="Обновить список проверки" aria-label="Обновить список проверки" onClick={()=>void load({refresh:true})}><RefreshCw size={18}/></button></div>
  {error&&<p role="alert" className={common.error}>{error}</p>}{command?.snapshot().title.startsWith('Решение при проверке')&&command.snapshot().error&&command.snapshot().phase!=='preview'&&<p role="alert" className={common.error}>{command.snapshot().error}</p>}
  {queue?.remaining===0&&<p className={styles.muted}>Все операции проверены.</p>}
  {queue&&op&&<div className={styles.settingsStack}>
   <div className={styles.currentReview}><button className={common.linkButton} onClick={()=>onOpen(op.id)}>{name(op)}</button><p className={styles.muted}>{values(op)}</p><p>{op.reviewReasons.map(r=>r==='category_not_defined'?missingCategoryLabel(op.parts):reviewNames[r]??'Нужно проверить').join(' · ')}</p></div>
   <ReviewIssues key={'issues:'+op.id} op={op} state={state} command={command} disabled={locked} timezone={timezone} onAccessError={onAccessError} edits={edits} onStage={setEdits} fieldsDirty={fieldsDirty} fieldPatch={fieldPatch}/>
   <QuickReviewFields key={queue.id+':'+op.id} op={op} state={state} onDirty={setFieldsDirty} onDraft={setFieldPatch} extraReady={!!edits.components||edits.links.length>0||Object.keys(edits.patch).length>0} similarIds={applySimilar?selected.filter(id=>similar.includes(id)):[]} requireSimilarSelection={applySimilar} similarControls={<>
    <label><input type="checkbox" checked={applySimilar} disabled={locked||!similar.length} onChange={e=>setApplySimilar(e.target.checked)}/>Применить к похожим операциям ({similar.length})</label>
    {applySimilar&&similar.length>0&&<section className={styles.similarReview} aria-label="Похожие операции">
     <div className={styles.similarToolbar}>
      <button type="button" className={common.button} disabled={locked||similar.every(id=>selected.includes(id))} onClick={()=>setSelected(similar)}>Выбрать все</button>
      <button type="button" className={common.button} disabled={locked||!selected.length} onClick={()=>setSelected([])}>Снять выбор</button>
      <span role="status">Выбрано: {selected.filter(id=>similar.includes(id)).length}/{similar.length}</span>
     </div>
     <ul className={styles.reviewList}>{similar.map(id=>{const item=items.get(id);return item&&<li key={id}><label className={styles.reviewChoice}><input type="checkbox" checked={selected.includes(id)} disabled={locked} onChange={e=>setSelected(ids=>e.target.checked?[...ids,id]:ids.filter(v=>v!==id))}/><span>{name(item)}<small>{values(item)}</small></span></label></li>;})}</ul>
    </section>}
   </>} disabled={locked||!command} canSkip={queue.remaining>1} onOpen={()=>onOpen(op.id)} onSkip={()=>{onBusy(true);void load({skip:op.id,revision:queue.revision});}} onApply={intent=>{const review={...intent,reviewScope:{sessionId:queue.id,revision:queue.revision,anchorId:op.id}},staged=!!edits.components||edits.links.length>0||Object.keys(edits.patch).length>0;applying.current=state.revision;void command?.begin(staged?{kind:'operation_card',id:op.id,...(Object.keys(edits.patch).length?{patch:edits.patch}:{}),...(edits.components?{components:edits.components.parts}:{}),links:edits.links,...(Object.keys(intent.patch??{}).length?{review}:{})}:review,'Решение при проверке',staged||!!intent.rememberRule||intent.operationIds.length>1,{generation:queue.generation,revision:queue.financeRevision});}}/>
  </div>}
 </section>;
}
