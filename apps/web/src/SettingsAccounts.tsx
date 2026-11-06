import {useEffect,useId,useRef,useState} from 'react';
import type {Account} from '../../../packages/finance-core/src/model';
import {safeText,sanitizeText} from '../../../packages/privacy/src/text';
import type {FinanceState} from './finance-client';
import {bankNames} from './finance-client';
import {api} from './server-client';
import {OperationDialog,OperationField} from './OperationDialog';
import type {CommandState,WorkspaceCommand} from './workspace-command';
import common from './App.module.css';
import operationStyles from './ServerOperation.module.css';
import styles from './Settings.module.css';

export const accountTypes:Record<Account['type'],string>={debit_card:'Дебетовая карта',credit_card:'Кредитная карта',bank_account:'Текущий счёт',loan:'Кредит',savings:'Накопительный счёт',deposit:'Вклад',other:'Другой'};
export const loanModes={cashflow:'Весь платёж как расход',economic:'Проценты и сопутствующие расходы'};
type Fields=Pick<Account,'name'|'type'|'analyticsEnabled'|'loanMode'>;
const bank=(a:Account)=>bankNames[a.bankId]??a.bankId;
const shortName=(a:Account)=>a.name.startsWith(bank(a)+' · ')?a.name.slice(bank(a).length+3):a.name;
const original=(a:Account):Fields=>({name:shortName(a),type:a.type,analyticsEnabled:a.analyticsEnabled,loanMode:a.loanMode});

export function SettingsAccounts({state,disabled,command,commandState,openOperations,openStructure,openDeletion,onNavigationGuard}:{onNavigationGuard:(guard:((action:()=>void)=>boolean)|null)=>void;state:FinanceState;disabled:boolean;command:WorkspaceCommand|null;commandState:CommandState;openOperations:(id:string)=>void;openStructure:(id:string)=>void;openDeletion:(id:string)=>void}){
 const [draft,setDraft]=useState<Record<string,{base:Fields;value:Fields}>>({}),[errors,setErrors]=useState<Record<string,string>>({});
 useEffect(()=>{setDraft({});setErrors({});},[state.generation]);
 const title='Сохранить настройки счетов',sent=useRef<{actionId:string|null}|null>(null);
 useEffect(()=>{
  if(!sent.current||commandState.title!==title)return;
  if(commandState.preview)sent.current.actionId=commandState.preview.actionId;
  if(commandState.phase==='idle'){
   if(sent.current.actionId&&sent.current.actionId===commandState.undoActionId){setDraft({});setErrors({});}
   sent.current=null;
  }
 },[commandState]);
 const [leave,setLeave]=useState<(()=>void)|null>(null);
 const groups=new Map<string,Account[]>();
 const accounts=[...state.accounts].sort((a,b)=>bank(a).localeCompare(bank(b),'ru')||shortName(a).localeCompare(shortName(b),'ru',{numeric:true}));
 for(const a of accounts){const rows=groups.get(a.bankId)??[];rows.push(a);groups.set(a.bankId,rows);}
 const keys=['name','type','analyticsEnabled','loanMode'] as const;
 const conflicting=(a:Account)=>{
  const edit=draft[a.id],current=original(a);return edit?keys.filter(k=>edit.value[k]!==edit.base[k]&&current[k]!==edit.base[k]&&current[k]!==edit.value[k]):[];
 };
 const hasConflict=accounts.some(a=>conflicting(a).length>0);
 const pending=accounts.flatMap(a=>{
  const edit=draft[a.id];if(!edit)return [];
  const current=original(a),patch=Object.fromEntries(keys.flatMap(k=>edit.value[k]!==edit.base[k]&&edit.value[k]!==current[k]?[[k,edit.value[k]]]:[])) as Partial<Fields>;
  return Object.keys(patch).length?[{id:a.id,patch}]:[];
 });
 useEffect(()=>{onNavigationGuard(action=>{if(!pending.length)return true;setLeave(()=>action);return false;});return()=>onNavigationGuard(null);},[onNavigationGuard,pending.length]);
 function change(a:Account,patch:Partial<Fields>){
  setDraft(values=>{const stored=values[a.id]??{base:original(a),value:original(a)};const current=original(a),nextBase={...stored.base,...Object.fromEntries(keys.flatMap(k=>k in patch&&stored.value[k]===stored.base[k]?[[k,current[k]]]:[]))};return {...values,[a.id]:{base:nextBase,value:{...stored.value,...patch}}};});
  if('name'in patch)setErrors(values=>({...values,[a.id]:''}));
 }
 function keepCurrent(a:Account){
  const current=original(a),conflicts=conflicting(a);
  const patch=Object.fromEntries(conflicts.map(k=>[k,current[k]]));
  setDraft(values=>{const stored=values[a.id];return stored?{...values,[a.id]:{base:{...stored.base,...patch},value:{...stored.value,...patch}}}:values;});
 }
 function apply(){
  if(disabled||!command||hasConflict||!pending.length)return;
  const issues:Record<string,string>={};
  for(const {id,patch} of pending)if(patch.name!==undefined){
   const name=safeText(sanitizeText(patch.name),160).trim();
   if(!name)issues[id]='Укажите название счёта.';
   else if(name===shortName(accounts.find(a=>a.id===id)!))delete patch.name;
   else patch.name=name;
  }
  setErrors(issues);
  if(Object.keys(issues).length)return;
  const changes=pending.filter(({patch})=>Object.keys(patch).length);
  if(!changes.length){setDraft({});return;}
  sent.current={actionId:null};
  void command.begin({kind:'account_settings',id:crypto.randomUUID(),accounts:changes},title,true,state);
 }
 if(!accounts.length)return <p className={styles.emptyState}>Счета появятся после первой загрузки выписки.</p>;
 return <form className={styles.settingsStack} noValidate onSubmit={e=>{e.preventDefault();apply();}}>
  {[...groups].map(([id,rows])=><section key={id} className={styles.bankGroup}><h3>{bank(rows[0]!)}</h3>
   {rows.map(a=>{const current=original(a),edit=draft[a.id],conflict=conflicting(a);
   const value=edit?{...current,...Object.fromEntries(keys.flatMap(k=>edit.value[k]!==edit.base[k]?[[k,edit.value[k]]]:[]))} as Fields:current;return <article key={a.id} aria-label={a.name} className={styles.accountCard}>
    <fieldset className={styles.accountFields} disabled={disabled}>
     <div className={styles.fullRow}><OperationField label="Название счёта" error={conflict.includes('name')?'Название изменилось. Черновик сохранён.':errors[a.id]}><input aria-label={'Название счёта: '+a.name} value={value.name} maxLength={160} onChange={e=>change(a,{name:e.target.value})}/></OperationField></div>
     <OperationField label="Тип счёта" error={conflict.includes('type')?'Тип счёта изменился.':undefined}><select aria-label={'Тип счёта: '+a.name} value={value.type} onChange={e=>change(a,{type:e.target.value as Account['type']})}>{Object.entries(accountTypes).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></OperationField>
     <OperationField label="Участие в аналитике" error={conflict.includes('analyticsEnabled')?'Участие в аналитике изменилось.':undefined}><select aria-label={'Участие в аналитике: '+a.name} value={String(value.analyticsEnabled)} onChange={e=>change(a,{analyticsEnabled:e.target.value==='true'})}><option value="true">Да</option><option value="false">Нет</option></select></OperationField>
     {value.type==='loan'&&<OperationField label="Учёт кредита" error={conflict.includes('loanMode')?'Учёт кредита изменился.':undefined}><select value={value.loanMode??''} onChange={e=>change(a,{loanMode:(e.target.value||null) as Account['loanMode']})}><option value="">Общая настройка</option>{Object.entries(loanModes).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></OperationField>}
    </fieldset>
    {conflict.length>0&&<div className={styles.cardActions}><button type="button" className={common.button} onClick={()=>keepCurrent(a)}>Использовать сохранённые значения</button></div>}
    <div className={styles.cardActions}><button type="button" className={common.button} disabled={disabled} onClick={()=>openOperations(a.id)}>Операции счёта</button><button type="button" className={common.button} disabled={disabled} onClick={()=>openStructure(a.id)}>Объединить счёт с другим</button><button type="button" className={common.dangerButton} disabled={disabled} onClick={()=>openDeletion(a.id)}>Удалить данные счёта</button></div>
   </article>;})}
  </section>)}
  <div className={styles.saveBar}><button type="button" className={styles.textButton} disabled={disabled||!pending.length} onClick={()=>{setDraft({});setErrors({});}}>Сбросить</button><button className={common.primaryButton} disabled={disabled||hasConflict||!pending.length}>Применить</button></div>
 {leave&&<OperationDialog title="Оставить изменения без сохранения?" compact onClose={()=>setLeave(null)} footer={<><button type="button" className={common.button} onClick={()=>setLeave(null)}>Остаться</button><button type="button" className={common.primaryButton} onClick={()=>{const next=leave;setLeave(null);setDraft({});setErrors({});next();}}>Не сохранять</button></>}><p>Черновик настроек счетов будет сброшен.</p></OperationDialog>}
 </form>;
}

type MergeRecord={id:string;undoable:boolean;intent:{sourceIds?:string[]};changes:{kind:string;id:string;before:{values:Record<string,unknown>}|null;after:{values:Record<string,unknown>}|null}[]};
export function AccountStructure({state,id,close,command,commandState,disabled,onAccessError}:{state:FinanceState;id:string;close:()=>void;command:WorkspaceCommand|null;commandState:CommandState;disabled:boolean;onAccessError:(error:unknown)=>void}){
 const account=state.accounts.find(a=>a.id===id);
 const formId=useId(),[epoch]=useState(()=>({generation:state.generation,revision:state.revision}));
 const [donors,setDonors]=useState<string[]>([]),[mode,setMode]=useState<'merge'|'undo'>('merge'),[error,setError]=useState(''),[loadError,setLoadError]=useState(false),[merge,setMerge]=useState<MergeRecord|null>(null),[loading,setLoading]=useState(true),[reload,setReload]=useState(0);
 const stale=state.revision!==epoch.revision||state.generation!==epoch.generation;
 const candidates=state.accounts.filter(a=>a.id!==id).sort((a,b)=>bank(a).localeCompare(bank(b),'ru')||a.name.localeCompare(b.name,'ru',{numeric:true}));
 useEffect(()=>{const abort=new AbortController();setLoading(true);setLoadError(false);
  void api<{actions:MergeRecord[]}>('/finance/history-query',{mergeTargetId:id,limit:1},abort.signal).then(r=>{if(!abort.signal.aborted)setMerge(r.actions[0]??null);}).catch(e=>{if(!abort.signal.aborted){onAccessError(e);setLoadError(true);}}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});
  return()=>abort.abort();
 },[id,epoch.revision,onAccessError,reload]);
 useEffect(()=>{if(stale)close();},[stale,close]);
 if(!account)return null;
 const earlier=state.mergedAccounts.some(a=>a.mergedIntoId===id);
 const restoredNames=merge?.changes.flatMap(c=>c.kind==='account'&&c.after?.values.merged_into_id===id&&c.before?[String(c.before.values.display_name)]:[])??[];
 function apply(){
  setError('');
  if(mode==='merge'){
   if(!donors.length){setError('Выберите хотя бы один счёт.');return;}
   void command?.begin({kind:'merge_accounts',id,sourceIds:donors},'Объединить счета',true,epoch);
  }else if(merge?.undoable)void command?.begin({kind:'undo',id:crypto.randomUUID(),value:merge.id},'Разъединить счета',true,epoch);
 }
 return <OperationDialog title="Объединение счетов" compact onClose={()=>{if(!disabled)close();}} footer={<><button type="button" className={styles.textButton+' '+operationStyles.leftAction} disabled={disabled||!donors.length&&mode==='merge'} onClick={()=>{setDonors([]);setError('');setMode('merge');}}>Сбросить</button><button type="submit" form={formId} className={common.primaryButton} disabled={disabled||stale||(mode==='merge'?!candidates.length:!merge?.undoable)}>Продолжить</button></>}>
  <form id={formId} className={styles.settingsStack} onSubmit={e=>{e.preventDefault();apply();}}>
   <p className={styles.muted}>{account.name}</p>
   {merge&&<OperationField label="Действие"><select value={mode} disabled={disabled} onChange={e=>{setMode(e.target.value as typeof mode);setError('');}}><option value="merge">Объединить счета</option><option value="undo">Разъединить счета</option></select></OperationField>}
   {mode==='merge'?(candidates.length?<fieldset className={styles.choiceGroup} aria-invalid={!!error||undefined} disabled={disabled}><legend>Счета для объединения</legend><p>Операции перейдут в «{account.name}».</p>{candidates.map(a=><label className={styles.checkboxRow} key={a.id}><input type="checkbox" checked={donors.includes(a.id)} onChange={e=>{setError('');setDonors(v=>e.target.checked?[...v,a.id]:v.filter(x=>x!==a.id));}}/><span>{bank(a)} · {shortName(a)}</span></label>)}{error&&<small className={styles.inlineError} role="alert">{error}</small>}</fieldset>:<p>Других счетов для объединения нет.</p>):<section className={styles.choiceGroup}><h3>Счета к восстановлению</h3>{restoredNames.length>0&&<ul>{restoredNames.map((name,i)=><li key={i}>{name}</li>)}</ul>}{!merge?.undoable&&<p>Последнее объединение уже нельзя отменить из-за более поздних изменений.</p>}</section>}
   {!loading&&!loadError&&!merge&&earlier&&<p className={styles.muted}>Предыдущее объединение больше нельзя отменить через историю.</p>}
   {loading&&<small role="status" className={styles.muted}>Проверяем историю объединений…</small>}
   {loadError&&<div><p role="alert">Не удалось проверить историю объединений.</p><button type="button" className={common.button} onClick={()=>setReload(v=>v+1)}>Повторить</button></div>}
   {commandState.error&&!commandState.preview&&<p className={styles.inlineError} role="alert">{commandState.error}</p>}
  </form>
 </OperationDialog>;
}
