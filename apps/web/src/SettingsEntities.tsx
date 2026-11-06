import type {StructureAction} from './SettingsStructure';
import {useEffect,useId,useState} from 'react';
import {safeText,sanitizeText} from '../../../packages/privacy/src/text';
import {OperationDialog,OperationField} from './OperationDialog';
import type {FinanceState} from './finance-client';
import type {CommandState,WorkspaceCommand} from './workspace-command';
import common from './App.module.css';
import operationStyles from './ServerOperation.module.css';
import styles from './Settings.module.css';

export type EntityEditor={kind:'category'|'counterparty';id?:string};
const categoryRoles={expense:'Расходы',income:'Доходы',both:'Расходы и доходы'};
export function SettingsEntityDialog({editor,state,command,commandState,disabled,close,onStructure,onOperations,onAddOperations}:{onStructure:(id:string,action:StructureAction)=>void;onOperations:(id:string,name:string)=>void;onAddOperations:(id:string)=>void;editor:EntityEditor;state:FinanceState;command:WorkspaceCommand|null;commandState:CommandState;disabled:boolean;close:()=>void}){
 const category=state.categories.find(c=>c.id===editor.id),party=state.counterparties.find(c=>c.id===editor.id);
 const entity=category??party,editing=!!entity,forCategory=editor.kind==='category';
 const initial={name:entity?.name??'',role:category?.role??'expense',parentId:category?.parentId??'',hidden:category?.hidden??false,state:party?.state==='ignored'?'ignored':'registered',isSelf:party?.isSelf??false};
 const [values,set]=useState(initial),[error,setError]=useState(''),[sent,setSent]=useState<string|null>(null);
 const form=useId(),[epoch]=useState(()=>({generation:state.generation,revision:state.revision})),stale=epoch.generation!==state.generation||epoch.revision!==state.revision;
 const title=forCategory?(editing?'Изменить категорию':'Новая категория'):(editing?'Изменить контрагента':'Новый контрагент');
 const changed=JSON.stringify(values)!==JSON.stringify(initial);
 const serverError=sent&&commandState.title===sent&&!commandState.preview?commandState.error:'';
 useEffect(()=>{if(sent&&stale&&commandState.phase==='idle'&&!commandState.error)close();},[sent,stale,commandState.phase,commandState.error]);
 function apply(){
  const name=safeText(sanitizeText(values.name),160).trim();
  if(!name){setError('Укажите название.');return;}
  const patch:Record<string,unknown>=editing?{}:{name};
  if(name!==initial.name)patch.name=name;
  if(forCategory){
   if(!editing)Object.assign(patch,{role:values.role,parentId:values.parentId||null});
   if(!editing||values.hidden!==initial.hidden)patch.hidden=values.hidden;
  }else{
   if(!editing||values.state!==initial.state||party?.state==='discovered')patch.state=values.state;
   if(!editing||values.isSelf!==initial.isSelf)patch.isSelf=values.isSelf;
  }
  if(!Object.keys(patch).length){close();return;}
  setSent(title);void command?.begin({kind:editor.kind,id:editor.id??crypto.randomUUID(),patch,create:!editing},title,editing&&('isSelf'in patch||'state'in patch),epoch);
 }
 return <OperationDialog compact title={title} onClose={()=>{if(!disabled)close();}} footer={<><button type="button" className={styles.textButton+' '+operationStyles.leftAction} disabled={disabled||!changed} onClick={()=>{set(initial);setError('');}}>Сбросить</button><button type="submit" form={form} className={common.primaryButton} disabled={disabled||stale||editing&&!changed&&party?.state!=='discovered'}>{editing?'Сохранить':'Создать'}</button></>}>
  <form id={form} className={styles.settingsStack+' '+styles.entityForm} noValidate onSubmit={e=>{e.preventDefault();apply();}}>
   <OperationField label="Название" error={error}><input value={values.name} maxLength={160} disabled={disabled} onChange={e=>{set({...values,name:e.target.value});setError('');}}/></OperationField>
   {forCategory&&(!editing?<><OperationField label="Родительская категория"><select value={values.parentId} disabled={disabled} onChange={e=>{const root=state.categories.find(c=>c.id===e.target.value);set({...values,parentId:e.target.value,role:root&&root.role!=='both'?root.role:values.role});}}><option value="">Без родительской категории</option>{state.categories.filter(c=>!c.parentId&&!c.hidden).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></OperationField><OperationField label="Использовать для"><select disabled={disabled} value={values.role} onChange={e=>set({...values,role:e.target.value as typeof values.role})}>{Object.entries(categoryRoles).filter(([v])=>!values.parentId||state.categories.some(c=>c.id===values.parentId&&(c.role==='both'||c.role===v))).map(([v,n])=><option key={v} value={v}>{n}</option>)}</select></OperationField></>:<label className={styles.checkboxRow}><input type="checkbox" checked={values.hidden} disabled={disabled} onChange={e=>set({...values,hidden:e.target.checked})}/>Скрыть из выбора категорий</label>)}
   {!forCategory&&<><OperationField label="Показ в списке"><select value={values.state} disabled={disabled} onChange={e=>set({...values,state:e.target.value})}><option value="registered">Показывать в списке</option><option value="ignored">Скрывать из списка</option></select></OperationField><label className={styles.checkboxRow}><input type="checkbox" checked={values.isSelf} disabled={disabled} onChange={e=>set({...values,isSelf:e.target.checked})}/>Мой получатель</label><p className={styles.muted}>Отметьте, если переводите деньги себе. Это помогает распознавать переводы между своими счетами.</p></>}
   {editing&&editor.id&&<div className={styles.cardActions}><button type="button" className={common.button} disabled={disabled} onClick={()=>onStructure(editor.id!,'merge')}>Объединить</button><button type="button" className={common.button} disabled={disabled} onClick={()=>onStructure(editor.id!,forCategory?'migrate':'split')}>{forCategory?'Изменить смысл или родителя':'Разделить'}</button>{forCategory?<button type="button" className={common.dangerButton} disabled={disabled} onClick={()=>onStructure(editor.id!,'delete')}>Удалить</button>:<><button type="button" className={common.button} disabled={disabled} onClick={()=>onOperations(editor.id!,entity!.name)}>Операции контрагента</button><button type="button" className={common.button} disabled={disabled} onClick={()=>onAddOperations(editor.id!)}>Добавить операции</button></>}</div>}{stale&&<p role="alert">Данные изменились. Откройте окно заново.</p>}{serverError&&<p role="alert" className={styles.inlineError}>{serverError}</p>}
  </form>
 </OperationDialog>;
}
