import {OperationField} from './OperationDialog';
import {validDateValue,DateInput} from './DateInput';
import {useEffect,useRef,useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {X} from 'lucide-react';
import {maskedOperationText} from './operation-display';
import {api} from './server-client';
import {DeletionFlow,emptyDeletion} from './deletion-flow';
import type {DeletionState,DeletionIntent,DeletionEpoch,DeletionPreview,DeletionReceipt} from './deletion-flow';
import type {FinanceState} from './finance-client';
import type {OperationRow} from './operations-client';
import {displayBankDate} from './finance-client';
import {formatMoney} from './demo/overview';
import common from './App.module.css';
import styles from './ShellDialogs.module.css';
import deletionStyles from './ServerDeletion.module.css';
import workspace from './Workspace.module.css';
export type DeletionSelection={kind:'operations';ids:string[]}|{kind:'period'}|{kind:'account'|'counterparty';id:string}|{kind:'reset'};
const countNames:Record<string,string>={analyzerChats:'Диалоги с зависимыми финансовыми данными',analyzerMessages:'Сообщения Анализатора',operations:'Операции',retainedOperations:'Сохранённые версии объединённых операций',observations:'Банковские источники',components:'Части, включая неактивные',links:'Связи',history:'Финансовая история и предпросмотры',importSources:'Строки источников импорта',pendingImportRowsInvalidated:'Строки незавершённых загрузок будут остановлены',duplicateCandidates:'Решения о дублях',accounts:'Счета',accountAliases:'Псевдонимы счетов',counterparties:'Контрагенты',counterpartyAliases:'Псевдонимы контрагентов',sourceBindings:'Привязки источников',preparedContexts:'Подготовленные загрузки',imports:'Загрузки',importFiles:'Файлы загрузок',importRows:'Строки загрузок',importAccounts:'Счета загрузок',categories:'Категории',rules:'Правила',operationsViews:'Представления операций',overviewViews:'Представления Обзора',budgets:'Бюджеты'};
const primaryCounts=new Set(['operations','retainedOperations','components','links','analyzerChats','accounts','counterparties','imports','categories','rules','operationsViews','overviewViews','budgets']);
function Counts({counts}:{counts:Record<string,number>}){return <dl className={deletionStyles.counts}>{Object.entries(counts).filter(([k,n])=>n>0&&primaryCounts.has(k)).map(([k,n])=><div key={k}><dt>{countNames[k]}</dt><dd>{n}</dd></div>)}</dl>;}
function DeletionOperationList({ids,state}:{ids:string[];state:FinanceState|null}){
 const [open,setOpen]=useState(false),[loaded,setLoaded]=useState<OperationRow[]|null>(null),[error,setError]=useState(false),[retry,setRetry]=useState(0);
 const operations=new Map([...(state?.operations??[]),...(loaded??[])].map(o=>[o.id,o]));
 const missing=ids.filter(id=>!operations.has(id));
 useEffect(()=>{
  if(!open||!state||!missing.length||loaded)return;
  const abort=new AbortController();
  void api<{operations:OperationRow[]}>('/finance/operations-selection',{generation:state.generation,revision:state.revision,ids:missing},abort.signal).then(result=>{if(!abort.signal.aborted)setLoaded(result.operations);}).catch(()=>{if(!abort.signal.aborted)setError(true);});
  return()=>abort.abort();
 },[open,state,ids,retry]);
 return <details className={deletionStyles.operationDetails} onToggle={e=>setOpen(e.currentTarget.open)}>
  <summary>{open?'Скрыть состав операций':'Показать состав операций'}</summary>
  {open&&<><ul className={deletionStyles.operations} aria-label="Удаляемые операции">{ids.map(id=>{const o=operations.get(id);if(!o)return null;return <li key={id}><span>{maskedOperationText(o.displayName?.compositeLabel||o.classification.merchant.value||'Сохранённая операция')}</span><small>{displayBankDate(o.date,'Europe/Moscow')} · {formatMoney(o.amountMinor)}</small></li>;})}</ul>
   {missing.length>0&&(error||loaded||!state?<div><p role="alert">Не удалось показать все операции.</p>{state&&<button type="button" className={common.button} onClick={()=>{setError(false);setLoaded(null);setRetry(n=>n+1);}}>Повторить загрузку списка</button>}</div>:<p role="status">Загружаем состав операций…</p>)}
  </>}
 </details>;
}
function Impact({impact,state}:{impact:DeletionPreview['impact'];state:FinanceState|null}){
 const {details:d,before,after}=impact;
 const operations=new Map(state?.operations.map(o=>[o.id,o]));
 const label=(id:string)=>{const o=operations.get(id);return maskedOperationText(o?.displayName?.compositeLabel||o?.classification.merchant.value||state?.categoryOperations?.find(o=>o.id===id)?.merchant||'Сохранённая операция');};
 const needsSetup=Array.isArray(d.rulesNeedSetup)?d.rulesNeedSetup.length:d.rulesNeedSetup;
 const effects:[string,string][]=[];
 if(before&&after)for(const [name,b,a] of [['Расходы',before.netExpensesMinor,after.netExpensesMinor],['Доходы',before.incomeMinor,after.incomeMinor],['Не определено',before.unresolvedMinor,after.unresolvedMinor]] as const)if(b!==a)effects.push([name,formatMoney(b)+' → '+formatMoney(a)]);
 if((d.counts.history??0)>0)effects.push(['Финансовая история и ожидающие предпросмотры','Будут очищены']);
 if((d.counts.pendingImportRowsInvalidated??0)>0)effects.push(['Затронутые незавершённые загрузки','Будут остановлены']);
 if(needsSetup&&d.kind==='delete_financial')effects.push(['Правила будут выключены до повторной настройки',String(needsSetup)]);
 if(d.survivingRelatedOperationIds?.length)effects.push(['Расчёты изменятся у сохранённых операций',d.survivingRelatedOperationIds.map(label).join(', ')]);
 if(!effects.length&&d.kind==='delete_financial')effects.push(['Удаляемые операции','Исчезнут из списка и расчётов']);
 return <section className={deletionStyles.impact} aria-label="Состав удаления">
  <div><h3>Что будет удалено</h3><Counts counts={d.counts}/></div>
  {d.kind==='delete_financial'&&<div><h3>Что изменится</h3><dl className={deletionStyles.counts}>{effects.map(([name,value])=><div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></div>}
  {d.kind==='reset_financial'&&<div><h3>Что сохранится</h3><p>Аккаунт, вход и оплаченный доступ.{!!d.preserved?.categories&&' Категорий: '+d.preserved.categories+'.'}{!!d.preserved?.rules&&' Правил: '+d.preserved.rules+'.'}{d.preserved?.interface?' Оформление сохранится.':' Оформление сбросится.'}</p>{!!needsSetup&&<p>Правил будет выключено до повторной настройки: {needsSetup}.</p>}</div>}
  {!!d.operationIds?.length&&<DeletionOperationList ids={d.operationIds} state={state}/>}
  <p role="note" className={deletionStyles.warning}>Удаление необратимо. Повторная загрузка выписки может снова создать удалённые операции.</p>
 </section>;
}
export function ServerDeletion({selection,state,onClose,onCommitted,onUnavailable}:{selection:DeletionSelection;state:FinanceState|null;onClose:()=>void;onCommitted:(receipt:DeletionReceipt)=>Promise<void>;onUnavailable:()=>void}){
 const [snapshot,setSnapshot]=useState(()=>state?structuredClone(state):null),[flowState,setFlowState]=useState<DeletionState>({...emptyDeletion}),[localError,setLocalError]=useState(''),[fields,setFields]=useState<Record<string,string>>({}),[from,setFrom]=useState(''),[through,setThrough]=useState(''),[accountMode,setAccountMode]=useState('all'),[accountIds,setAccountIds]=useState<string[]>([]),[card,setCard]=useState(''),[choices,setChoices]=useState({categories:'',rules:'',interface:''});const flow=useRef<DeletionFlow|null>(null),password=useRef<HTMLInputElement>(null),committed=useRef(onCommitted),unavailable=useRef(onUnavailable);committed.current=onCommitted;unavailable.current=onUnavailable;
 useEffect(()=>{const instance=new DeletionFlow({epoch:()=>api<DeletionEpoch>('/finance/epoch'),request:(p,b)=>api<DeletionPreview|DeletionReceipt>(p,b),committed:r=>committed.current(r),unavailable:()=>unavailable.current()},s=>{if(s.phase==='done')setSnapshot(null);setFlowState(s);});flow.current=instance;
 if(selection.kind==='operations'&&selection.ids.length>0&&selection.ids.length<=1000&&snapshot){
  queueMicrotask(()=>void instance.begin({kind:'delete_financial',scope:{kind:'operations',operationIds:[...selection.ids]}},snapshot));
 }
 return()=>{instance.dispose();flow.current=null;};},[]);
 useEffect(()=>{if(!['sending','retry'].includes(flowState.phase))return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[flowState.phase]);
 const busy=flowState.phase==='sending'||flowState.phase==='retry',stale=selection.kind!=='reset'&&!!snapshot&&!!state&&(snapshot.generation!==state.generation||snapshot.revision!==state.revision),name=selection.kind==='account'?snapshot?.accounts.find(a=>a.id===selection.id)?.name:selection.kind==='counterparty'?snapshot?.counterparties.find(p=>p.id===selection.id)?.name:null,title=selection.kind==='reset'?'Полный финансовый сброс':selection.kind==='operations'?(selection.ids.length===1?'Удаление операции':'Удаление выбранных операций'):selection.kind==='period'?'Удаление данных за период':`Удаление данных ${selection.kind==='account'?'счёта':'контрагента'}: ${name??(selection.kind==='account'?'Счёт':'Контрагент')}`;
 function preview(){
  setLocalError('');
  const errors:Record<string,string>={};let intent:DeletionIntent;
  if(selection.kind==='reset'){
   for(const key of ['categories','rules','interface'] as const)if(!choices[key])errors[key]='Выберите, что сделать.';
   intent={kind:'reset_financial',keepCategories:choices.categories==='keep',keepRules:choices.rules==='keep',keepInterface:choices.interface==='keep'};
  }else if(selection.kind==='operations'){
   if(!selection.ids.length||selection.ids.length>1000){setLocalError('Выберите от 1 до 1000 операций.');return;}
   intent={kind:'delete_financial',scope:{kind:'operations',operationIds:[...selection.ids]}};
  }else if(selection.kind==='period'){
   if(!validDateValue(from)||!from)errors.from='Укажите дату начала.';
   if(!validDateValue(through)||!through)errors.through='Укажите дату окончания.';
   else if(from&&validDateValue(from)&&from>through)errors.through='Дата окончания раньше начала.';
   if(accountMode==='selected'&&!accountIds.length)errors.accounts='Выберите хотя бы один счёт.';
   intent={kind:'delete_financial',scope:{kind:'period',from,through,...(accountMode==='selected'?{accountIds:[...accountIds]}:{})}};
  }else{
   if(selection.kind==='counterparty'&&!card)errors.card='Выберите, что сделать с контрагентом.';
   intent={kind:'delete_financial',scope:selection.kind==='account'?{kind:'account',accountId:selection.id,deleteAccount:card==='delete'}:{kind:'counterparty',counterpartyId:selection.id,deleteCard:card==='delete'}};
  }
  setFields(errors);if(Object.keys(errors).length)return;
  void flow.current?.begin(intent,snapshot??undefined);
 }
 function confirm(retry=false){const proof=password.current?.value;if(password.current)password.current.value='';void (retry?flow.current?.retry(proof):flow.current?.confirm(proof));}
 return <Dialog.Root open onOpenChange={next=>{if(!next&&!busy)onClose();}}><Dialog.Portal><Dialog.Overlay className={common.overlay}/><Dialog.Content className={`${common.dialog} ${styles.modal} ${deletionStyles.content}`} onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onPointerDownOutside={e=>e.preventDefault()} aria-describedby={undefined}><header className={common.dialogHead+' '+deletionStyles.head}><Dialog.Title>{title}</Dialog.Title><button className={common.iconButton} disabled={busy} aria-label="Закрыть окно удаления" onClick={onClose}><X size={20}/></button></header>
 <div className={deletionStyles.body}>
 {(flowState.error||localError)&&<p role="alert" className={common.error}>{flowState.error||localError}</p>}{stale&&flowState.phase==='draft'&&<p role="alert">Данные изменились после открытия. Закройте окно и обновите данные перед удалением.</p>}
 {flowState.phase==='draft'&&(selection.kind!=='operations'||flowState.error||localError)&&<form id="deletion-draft" noValidate onChange={()=>setFields({})} onSubmit={e=>{e.preventDefault();preview();}}><fieldset className={workspace.form} disabled={stale}>{selection.kind==='operations'&&<><p>Выбрано конкретных операций: {selection.ids.length}.</p><ul>{selection.ids.map(id=>{const o=snapshot?.operations.find(o=>o.id===id);return <li key={id}>{o?.classification.merchant.value||'Операция'}{o?` · ${displayBankDate(o.date,'Europe/Moscow')} · ${formatMoney(o.amountMinor)}`:''}</li>;})}</ul></>}{selection.kind==='period'&&<><OperationField label="С даты включительно" error={fields.from}><DateInput aria-label="Удалить с даты" showError={!fields.from} value={from} onValueChange={setFrom}/></OperationField><OperationField label="По дату включительно" error={fields.through}><DateInput aria-label="Удалить по дату" showError={!fields.through} value={through} onValueChange={setThrough}/></OperationField><p>Используется текущая дата операции и московский календарь. Карточки счетов сохранятся.</p><label>Счета периода<select aria-label="Счета периода" value={accountMode} onChange={e=>setAccountMode(e.target.value)}><option value="all">Все счета</option><option value="selected">Только выбранные счета</option></select></label>{accountMode==='selected'&&<fieldset aria-invalid={!!fields.accounts||undefined}><legend>Выбранные счета периода</legend>{snapshot?.accounts.map(a=><label key={a.id}><input type="checkbox" checked={accountIds.includes(a.id)} onChange={e=>setAccountIds(ids=>e.target.checked?[...ids,a.id]:ids.filter(id=>id!==a.id))}/>{a.name}</label>)}{fields.accounts&&<small role="alert" className={deletionStyles.fieldError}>{fields.accounts}</small>}</fieldset>}</>}{selection.kind==='account'&&<><p>Удалятся операции счёта и операции из привязанных к нему выписок. Сам счёт сохранится, если не отметить его ниже.</p><label className={deletionStyles.checkbox}><input type="checkbox" checked={card==='delete'} onChange={e=>setCard(e.target.checked?'delete':'keep')}/>Удалить счёт</label></>}{selection.kind==='counterparty'&&<><p>Удалятся операции с этим контрагентом и операции из связанных с ним банковских записей.</p><OperationField label="Контрагент после удаления" error={fields.card}><select aria-label="Контрагент после удаления" required value={card} onChange={e=>setCard(e.target.value)}><option value="">Выберите</option><option value="keep">Сохранить карточку</option><option value="delete">Удалить карточку вместе с данными</option></select></OperationField></>}{selection.kind==='reset'&&<>{(['categories','rules','interface'] as const).map(k=><OperationField key={k} label={{categories:'Категории',rules:'Персональные правила',interface:'Оформление интерфейса'}[k]} error={fields[k]}><select aria-label={{categories:'Категории после сброса',rules:'Правила после сброса',interface:'Оформление после сброса'}[k]} required value={choices[k]} onChange={e=>setChoices(c=>({...c,[k]:e.target.value}))}><option value="">Выберите</option><option value="keep">Сохранить</option><option value="delete">{k==='interface'?'Сбросить':'Удалить'}</option></select></OperationField>)}<p>Сброс охватывает все финансовые данные независимо от периода и счетов. Аккаунт и доступ сохранятся.</p></>}</fieldset></form>}
 {flowState.phase==='sending'&&<p role="status">{flowState.preview?(selection.kind==='operations'?'Удаляем выбранные операции…':selection.kind==='reset'?'Сбрасываем финансовые данные…':'Удаляем данные…'):(selection.kind==='operations'?'Проверяем, какие операции будут удалены…':'Проверяем, какие данные будут удалены…')}</p>}
 {flowState.preview&&<Impact key={flowState.preview.actionId} impact={flowState.preview.impact} state={snapshot}/>}
 {(flowState.phase==='preview'||flowState.phase==='retry')&&<form id="deletion-confirm" onSubmit={e=>{e.preventDefault();confirm(flowState.phase==='retry');}}>{selection.kind==='reset'&&<label>Пароль аккаунта{flowState.requiresPassword?' — требуется для подтверждения':' — если вход был более 5 минут назад'}<input ref={password} type="password" aria-label="Пароль для финансового сброса" autoComplete="current-password" maxLength={128} required={flowState.requiresPassword}/></label>}</form>}
 {flowState.phase==='done'&&<section aria-label="Удаление завершено"><p role="status">{selection.kind==='reset'?'Финансовые данные сброшены.':'Данные удалены.'} Обычная отмена недоступна.</p></section>}</div><footer className={deletionStyles.footer}><button className={common.button} disabled={busy} onClick={onClose}>{flowState.phase==='done'?'Закрыть':'Отменить'}</button>{flowState.phase==='draft'&&(selection.kind!=='operations'||flowState.error||localError)&&<button className={common.primaryButton} type="submit" form="deletion-draft" disabled={stale}>Продолжить</button>}{(flowState.phase==='preview'||flowState.phase==='retry')&&<button className={common.primaryButton} type="submit" form="deletion-confirm">{flowState.phase==='retry'?'Повторить':selection.kind==='reset'?'Подтвердить полный финансовый сброс':'Подтвердить'}</button>}</footer>
 </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
