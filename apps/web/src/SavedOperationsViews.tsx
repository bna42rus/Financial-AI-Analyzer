import {useEffect,useId,useState} from 'react';
import {ArrowDown,ArrowUp} from 'lucide-react';
import {safeText,sanitizeText} from '../../../packages/privacy/src/text';
import {api} from './server-client';
import {OperationDialog,OperationField} from './OperationDialog';
import type {SavedOperationsView} from './operations-client';
import type {SavedOverviewView} from './overview-client';
import type {FinanceState} from './finance-client';
import type {CommandState,WorkspaceCommand,WorkspaceIntent} from './workspace-command';
import common from './App.module.css';
import layout from './Settings.module.css';

type View={screen:'operations';value:SavedOperationsView}|{screen:'overview';value:SavedOverviewView};
export function SavedOperationsViews({state,command,commandState,disabled,timezone,onAccessError,onOpen}:{state:FinanceState;command:WorkspaceCommand|null;commandState:CommandState;disabled:boolean;timezone:string;onAccessError:(e:unknown)=>void;onOpen:(screen:'overview'|'operations')=>void}){
 const [views,setViews]=useState<View[]>([]),[errors,setErrors]=useState<Record<string,string>>({}),[rename,setRename]=useState<{view:View;revision:string}|null>(null),[name,setName]=useState(''),[nameError,setNameError]=useState(''),[reload,setReload]=useState(0),[sent,setSent]=useState(false),[loaded,setLoaded]=useState<string[]>([]);
 const form=useId();
 useEffect(()=>{const abort=new AbortController();
  async function load(screen:'overview'|'operations'){
   try{const data=screen==='overview'
    ?(await api<{views:SavedOverviewView[]}>('/finance/overview-views',{},abort.signal)).views.map((value):View=>({screen,value}))
    :(await api<{views:SavedOperationsView[]}>('/finance/operations-views',{},abort.signal)).views.map((value):View=>({screen,value}));
    if(!abort.signal.aborted){setErrors(e=>({...e,[screen]:''}));setLoaded(v=>[...new Set([...v,screen])]);setViews(v=>[...v.filter(x=>x.screen!==screen),...data]);}
   }catch(e){if(!abort.signal.aborted){onAccessError(e);setErrors(previous=>({...previous,[screen]:'Не удалось загрузить представления.'}));}}
  }
  void load('overview');void load('operations');return()=>abort.abort();
 },[state.generation,state.revision,reload,onAccessError]);
 useEffect(()=>{if(sent&&rename&&state.revision!==rename.revision&&commandState.phase==='idle'&&!commandState.error)setRename(null);},[sent,rename,state.revision,commandState.phase,commandState.error]);
 function save(v:View,patch:{name?:string;isDefault?:boolean},duplicate=false){
  const values={...(duplicate?{}:{id:v.value.id}),name:patch.name??v.value.name,isDefault:patch.isDefault??(duplicate?false:v.value.isDefault),create:duplicate};
  const intent:WorkspaceIntent=v.screen==='overview'?{kind:'save_overview_view',definition:v.value.definition,...values}:{kind:'save_operations_view',definition:v.value.definition,...values};
  void command?.begin(intent,duplicate?'Копировать представление':'Настройка представления',false,state);
 }
 function move(screen:View['screen'],ordered:View[],index:number,delta:number){const ids=ordered.map(v=>v.value.id);[ids[index],ids[index+delta]]=[ids[index+delta]!,ids[index]!];void command?.begin({kind:screen==='overview'?'reorder_overview_views':'reorder_operations_views',viewIds:ids},'Порядок представлений',false,state);}
 return <div className={layout.settingsStack}>
  {(['overview','operations'] as const).map(screen=>{const entries=views.filter(v=>v.screen===screen),label=screen==='overview'?'Обзор':'Операции';return <section key={screen} className={layout.settingsBox} aria-label={'Представления: '+label}>
   <div className={layout.settingsRow}><h3>{screen==='overview'?'Представления Обзора':'Представления операций'}</h3><button className={common.button} disabled={disabled} onClick={()=>onOpen(screen)}>Открыть {label}</button></div>
   {errors[screen]?<div><p role="alert">{errors[screen]}</p><button className={common.button} onClick={()=>setReload(v=>v+1)}>Повторить</button></div>:loaded.includes(screen)&&!entries.length&&<p className={layout.muted}>Сохранённых представлений пока нет.</p>}
   {entries.map((v,i)=><article key={v.value.id} className={layout.settingsRow}><div><strong>{v.value.name}</strong><small>{v.value.isDefault?'По умолчанию · ':''}{v.value.dependencyStatus==='needs_setup'?'Проверьте фильтры · ':''}{v.value.modifiedAt?new Date(v.value.modifiedAt).toLocaleString('ru-RU',{timeZone:timezone}):''}</small></div>
    <div className={layout.cardActions}><button className={common.button} disabled={disabled} onClick={()=>{setName(v.value.name);setNameError('');setSent(false);setRename({view:v,revision:state.revision});}}>Переименовать</button><button className={common.button} disabled={disabled||v.value.dependencyStatus!=='ready'} onClick={()=>save(v,{isDefault:!v.value.isDefault})}>{v.value.isDefault?'Снять по умолчанию':'По умолчанию'}</button><button className={common.button} disabled={disabled} onClick={()=>save(v,{name:(v.value.name+' — копия').slice(0,160)},true)}>Дублировать</button><button className={common.iconButton} aria-label={'Выше: '+v.value.name} disabled={disabled||i===0} onClick={()=>move(screen,entries,i,-1)}><ArrowUp size={16}/></button><button className={common.iconButton} aria-label={'Ниже: '+v.value.name} disabled={disabled||i===entries.length-1} onClick={()=>move(screen,entries,i,1)}><ArrowDown size={16}/></button><button className={common.dangerButton} disabled={disabled} onClick={()=>void command?.begin({kind:screen==='overview'?'delete_overview_view':'delete_operations_view',id:v.value.id},'Удалить представление «'+v.value.name+'»?',true,state)}>Удалить</button></div>
   </article>)}
  </section>;})}
  {rename&&<OperationDialog compact title="Переименовать представление" onClose={()=>{if(!disabled)setRename(null);}} footer={<><button className={common.button} disabled={disabled} onClick={()=>setRename(null)}>Отменить</button><button type="submit" form={form} className={common.primaryButton} disabled={disabled||state.revision!==rename.revision||name===rename.view.value.name}>Сохранить</button></>}>
   <form id={form} className={layout.settingsStack+' '+layout.entityForm} onSubmit={e=>{e.preventDefault();const cleaned=safeText(sanitizeText(name),160).trim();if(!cleaned){setNameError('Укажите название.');return;}setSent(true);save(rename.view,{name:cleaned});}}><OperationField label="Название" error={nameError||(sent&&commandState.title==='Настройка представления'?commandState.error:'')}><input value={name} maxLength={160} disabled={disabled} onChange={e=>{setName(e.target.value);setNameError('');}}/></OperationField>{state.revision!==rename.revision&&<p role="alert">Представления изменились. Откройте окно заново.</p>}</form>
  </OperationDialog>}
 </div>;
}
