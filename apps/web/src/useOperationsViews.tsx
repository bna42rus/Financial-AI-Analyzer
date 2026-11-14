import {useEffect,useRef,useState} from 'react';
import {defaultOperationsView,parseOperationsView,standardOperationsViewId,standardOperationsViewName} from '../../../packages/finance-core/src/operations';
import type {OperationsView} from '../../../packages/finance-core/src/operations';
import {safeText,sanitizeText} from '../../../packages/privacy/src/text';
import type {FinanceState} from './finance-client';
import type {SavedOperationsView} from './operations-client';
import type {CommandState,WorkspaceCommand,WorkspaceIntent} from './workspace-command';
import {advancedOperationFilters} from './OperationsFilters';
import {operationPageSize} from './OperationListSettings';
import {OverviewDialog} from './OverviewDialogs';
import {OverviewViewsMenu} from './OverviewViewsMenu';
import {copyViewName,viewNameKey} from './overview-views';
import {api} from './server-client';
import common from './App.module.css';
import styles from './Overview.module.css';

const visual=(config:OperationsView)=>JSON.stringify([config.columns,config.columns.map(c=>config.widths[c]??null),config.sort,config.direction,config.group,operationPageSize(config.pageSize)]);
const normalize=(config:OperationsView)=>({...config,pageSize:operationPageSize(config.pageSize),filter:advancedOperationFilters(config.filter),period:'all' as const,density:'comfortable' as const});
const builtIn=():SavedOperationsView=>({id:standardOperationsViewId,name:standardOperationsViewName,definition:defaultOperationsView(),isDefault:true,dependencyStatus:'ready',revision:'',position:0,modifiedAt:''});
type Sheet={kind:'new'|'copy'|'rename'|'delete';view?:SavedOperationsView;name:string;revision:string};
type Snapshot={active:SavedOperationsView;config:OperationsView};
type Pending={id:string;kind:'select'|'metadata'|'delete';previousUndo:string|null;after?:()=>void;snapshot:Snapshot};
export function useOperationsViews({state,config,onConfig,disabled,invalid,command,commandState,onAccessError,onNavigationGuard,applyDefaultFilters}:{applyDefaultFilters:boolean;state:FinanceState;config:OperationsView;onConfig:(v:OperationsView,replaceFilters:boolean)=>void;disabled:boolean;invalid:boolean;command:WorkspaceCommand|null;commandState:CommandState;onAccessError:(e:unknown)=>boolean;onNavigationGuard?:(guard:((action:()=>void)=>boolean)|null)=>void}){
 const [active,setActive]=useState(builtIn),[views,setViews]=useState<SavedOperationsView[]>([]),[loaded,setLoaded]=useState(''),[reload,setReload]=useState(0),[sheet,setSheet]=useState<Sheet|null>(null),[name,setName]=useState(''),[error,setError]=useState(''),[leave,setLeave]=useState<(()=>void)|null>(null);
 const current=useRef({active,config,disabled,onConfig,onAccessError,state});current.current={active,config,disabled,onConfig,onAccessError,state};
 const pending=useRef<Pending|null>(null),first=useRef(true),history=useRef(new Map<string,Snapshot>()),appliedUndo=useRef<string|null>(null);
 const dirty=visual(config)!==visual(active.definition),stale=active.revision!==''&&views.some(v=>v.id===active.id&&v.revision!==active.revision&&(visual(v.definition)!==visual(active.definition)||JSON.stringify(advancedOperationFilters(v.definition.filter))!==JSON.stringify(advancedOperationFilters(active.definition.filter))));
 const ready=loaded===state.revision;
 function activate(v:SavedOperationsView){setActive(v);current.current.onConfig(normalize(v.definition),true);setError('');}
 useEffect(()=>{
  let live=true;
  void api<{views:SavedOperationsView[]}>('/finance/operations-views',{}).then(r=>{
   if(!live)return;
   const next=r.views.length?[...r.views]:[builtIn()];
   if(!next.some(v=>v.isDefault)&&next[0])next[0]={...next[0],isDefault:true};
   setViews(next);setLoaded(state.revision);
   const c=current.current,p=pending.current;
   if(p&&commandState.phase==='idle'&&commandState.undoActionId&&commandState.undoActionId!==p.previousUndo){
    history.current.set(commandState.undoActionId,p.snapshot);pending.current=null;setSheet(null);setError('');
    const v=next.find(v=>v.id===p.id);
    if(p.kind==='select'&&v){setActive(v);c.onConfig(normalize(v.definition),true);}
    else if(p.kind==='delete'&&c.active.id===p.id)activate(next.find(v=>v.isDefault)??next[0]!);
    else if(p.kind==='metadata'){const refreshed=next.find(v=>v.id===c.active.id);if(refreshed)setActive(refreshed);}
    p.after?.();return;
   }
   if(first.current){first.current=false;const chosen=next.find(v=>v.isDefault&&v.dependencyStatus==='ready')??next[0]!;if(visual(c.config)===visual(c.active.definition)){setActive(chosen);c.onConfig({...normalize(chosen.definition),...(!applyDefaultFilters?{filter:c.config.filter}:{})},true);}else setActive(chosen);return;}
   const found=next.find(v=>v.id===c.active.id);
   if(!found&&visual(c.config)===visual(c.active.definition))activate(next.find(v=>v.isDefault)??next[0]!);
   else if(found&&visual(c.config)===visual(c.active.definition)&&found.revision!==c.active.revision&&!p){setActive(found);c.onConfig({...normalize(found.definition),filter:c.config.filter},false);}
  }).catch(e=>{if(live&&!current.current.onAccessError(e))setError('Не удалось загрузить представления.');});
  return()=>{live=false;};
 },[state.revision,reload]);
 useEffect(()=>{
  const id=commandState.undoneActionId;
  if(commandState.phase==='idle'&&id&&appliedUndo.current!==id&&history.current.has(id)){
   appliedUndo.current=id;const old=history.current.get(id)!;setActive(old.active);onConfig(old.config,true);setReload(n=>n+1);return;
  }
  if(!pending.current||commandState.phase!=='idle')return;
  if(commandState.undoActionId&&commandState.undoActionId!==pending.current.previousUndo)setReload(n=>n+1);
  else if(commandState.error)pending.current=null;
 },[commandState.phase,commandState.undoActionId,commandState.undoneActionId,commandState.error]);
 function guard(action:()=>void){if(!dirty)return true;setLeave(()=>action);return false;}
 useEffect(()=>{onNavigationGuard?.(guard);return()=>onNavigationGuard?.(null);});
 useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};addEventListener('beforeunload',warn);return()=>removeEventListener('beforeunload',warn);},[dirty]);
 function begin(intent:WorkspaceIntent,kind:Pending['kind'],id:string,after?:()=>void){
  if(disabled||!ready||!command||commandState.phase!=='idle')return;
  pending.current={id,kind,previousUndo:commandState.undoActionId,snapshot:structuredClone({active,config}),after};
  void command.begin(intent,'Представление операций',false,{generation:state.generation,revision:state.revision});
 }
 function write(v:SavedOperationsView,configToSave:OperationsView,create:boolean,kind:Pending['kind'],after?:()=>void){
  try{
   const definition=parseOperationsView(normalize(configToSave));
   begin({kind:'save_operations_view',id:v.id,name:v.name,definition,isDefault:v.isDefault,create,...(create&&v.id!==standardOperationsViewId&&views.some(v=>v.id===standardOperationsViewId&&!v.revision)?{preserveStandard:true}:{})},kind,v.id,after);
  }catch{setError('Проверьте дополнительные фильтры и настройки списка.');}
 }
 function save(after?:()=>void){if(invalid||stale)return;write(active,config,!active.revision,'select',after);}
 function open(kind:Sheet['kind'],view?:SavedOperationsView){const name=kind==='copy'?copyViewName(view?.name??active.name,views.map(v=>v.name)):kind==='new'?'Новое представление':view?.name??active.name;setName(name);setError('');setSheet({kind,view,name,revision:state.revision});}
 function submit(){
  if(!sheet||sheet.revision!==state.revision)return;
  if(sheet.kind==='delete'){const id=sheet.view!.id;begin({kind:'delete_operations_view',id},'delete',id);return;}
  try{
   const clean=safeText(sanitizeText(name),160).trim();
   if(!clean||views.some(v=>viewNameKey(v.name)===viewNameKey(clean)&&!(sheet.kind==='rename'&&v.id===sheet.view?.id))){setError(clean?'Представление с таким названием уже есть.':'Введите название.');return;}
   if(sheet.kind==='rename'){const v={...sheet.view!,name:clean};write(v,v.definition,!v.revision,'metadata');return;}
   const definition=sheet.kind==='new'?defaultOperationsView():!sheet.view||sheet.view.id===active.id?config:sheet.view.definition;
   write({...builtIn(),id:crypto.randomUUID(),name:clean,isDefault:false},definition,true,'select');
  }catch{setError('Проверьте название.');}
 }
 const menu=<OverviewViewsMenu label="Представления операций" name={active.name} id={active.id} views={views} ready={ready} disabled={disabled}
  extra={!dirty&&JSON.stringify(config.filter)!==JSON.stringify(advancedOperationFilters(active.definition.filter))?<button type="button" className={common.button} data-close-popover disabled={disabled||!ready||invalid||stale} onClick={()=>save()}>Сохранить дополнительные фильтры</button>:null}
  onSelect={v=>{if(v&&v.id!==active.id&&guard(()=>activate(v)))activate(v);}} onCreate={()=>{if(guard(()=>open('new')))open('new');}} onCopy={v=>{if(v&&v.id!==active.id){if(guard(()=>open('copy',v)))open('copy',v);}else open('copy',v??undefined);}}
  onRename={v=>open('rename',v)} onDefault={v=>{if(v)write({...v,isDefault:true},v.definition,!v.revision,'metadata');}} onDelete={v=>open('delete',v)}/>;
 const toolbar=dirty?<div className={styles.draftBar}><span role="status">Есть несохранённые изменения</span><button className={common.button} disabled={disabled} onClick={()=>onConfig({...normalize(active.definition),filter:config.filter},false)}>Сбросить</button><button className={common.button} disabled={disabled||!ready||invalid} onClick={()=>open('copy')}>Сохранить как новое</button><button className={common.primaryButton} aria-label="Сохранить представление операций" disabled={disabled||!ready||invalid||stale} onClick={()=>save()}>Сохранить</button></div>:null;
 const deleting=sheet?.kind==='delete',busy=commandState.phase==='sending'||commandState.phase==='retry';
 const dialogs=<>{leave&&<OverviewDialog compact title="Изменения не сохранены" description="Сохранить представление перед переходом?" onClose={()=>setLeave(null)}><div className={styles.controls}><button className={common.button} onClick={()=>setLeave(null)}>Остаться</button><button className={common.button} onClick={()=>{const next=leave;setLeave(null);onConfig({...normalize(active.definition),filter:config.filter},false);next();}}>Не сохранять</button><button className={common.primaryButton} disabled={disabled||!ready||invalid||stale} onClick={()=>{const next=leave;setLeave(null);save(next);}}>Сохранить</button></div></OverviewDialog>}
 {sheet&&<OverviewDialog compact title={deleting?'Удалить представление?':sheet.kind==='new'?'Создать представление':sheet.kind==='copy'?'Создать копию представления':'Переименовать представление'} description={deleting?'Будет удалено представление «'+sheet.name+'». Операции сохранятся.':undefined} onClose={()=>{if(!busy){setSheet(null);setError('');}}}>
 <form onSubmit={e=>{e.preventDefault();submit();}}>{!deleting&&<label className={styles.pickerLabel}>Название представления<input aria-label="Название при сохранении" maxLength={160} value={name} disabled={disabled} onChange={e=>{setName(e.target.value);setError('');}} required/></label>}
 {(error||commandState.error)&&<p role="alert" className={common.error}>{error||commandState.error}</p>}{sheet.revision!==state.revision&&<p role="alert">Данные изменились. Откройте действие заново.</p>}{commandState.phase==='sending'&&<p role="status">{deleting?'Удаляем представление…':'Сохраняем представление…'}</p>}{commandState.phase==='retry'&&<button type="button" className={common.primaryButton} onClick={()=>void command?.retry()}>{deleting?'Повторить удаление':'Повторить то же сохранение'}</button>}
 <div className={styles.dialogFooter}><button type="button" className={common.button} disabled={busy} onClick={()=>{setSheet(null);setError('');}}>Отмена</button><button className={common.primaryButton} disabled={disabled||!ready||sheet.revision!==state.revision}>{deleting?'Удалить':'Сохранить'}</button></div></form></OverviewDialog>}
 {!sheet&&error&&<p className={common.error} role="alert">{error}</p>}{stale&&dirty&&<p role="alert">Представление изменилось в другом окне. Сохраните как новое или сбросьте изменения.</p>}</>;
 return {menu,toolbar,dialogs,viewId:active.id,needsSetup:active.dependencyStatus==='needs_setup'};
}
