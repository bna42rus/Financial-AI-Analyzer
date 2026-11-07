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
const nameKey=(name:string)=>name.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('ru-RU');
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
  if(!forCategory&&name!==initial.name&&state.counterparties.some(p=>p.id!==editor.id&&nameKey(p.name)===nameKey(name))){setError('Контрагент с таким именем уже существует.');return;}
  const patch:Record<string,unknown>=editing?{}:{name};
  if(name!==initial.name)patch.name=name;
  if(forCategory){
   if(!editing)Object.assign(patch,{role:values.role,parentId:values.parentId||null});
   if(!editing||values.hidden!==initial.hidden)patch.hidden=values.hidden;
  }else{
   if(!editing||values.state!==initial.state||party?.state==='discovered')patch.state='registered';
   if(!editing||values.isSelf!==initial.isSelf)patch.isSelf=values.isSelf;
  }
  if(!Object.keys(patch).length){close();return;}
  setSent(title);void command?.begin({kind:editor.kind,id:editor.id??crypto.randomUUID(),patch,create:!editing},title,editing&&('isSelf'in patch||'state'in patch),epoch);
 }
 return <OperationDialog compact={!forCategory} title={title} onClose={()=>{if(!disabled)close();}} footer={<><button type="button" className={styles.textButton+' '+operationStyles.leftAction} disabled={disabled||!changed} onClick={()=>{set(initial);setError('');}}>Сбросить</button><button type="submit" form={form} className={common.primaryButton} disabled={disabled||stale||editing&&!changed&&party?.state!=='discovered'}>{editing?'Сохранить':'Создать'}</button></>}>
  <form id={form} className={styles.settingsStack+' '+styles.entityForm} noValidate onSubmit={e=>{e.preventDefault();apply();}}>
   <OperationField label={forCategory?"Название":"Имя контрагента"} error={error||(!forCategory&&serverError.includes("таким именем")?serverError:undefined)}><input value={values.name} maxLength={160} disabled={disabled} onChange={e=>{set({...values,name:e.target.value});setError('');}}/></OperationField>
   {forCategory&&(!editing?<><OperationField label="Родительская категория"><select value={values.parentId} disabled={disabled} onChange={e=>{const root=state.categories.find(c=>c.id===e.target.value);set({...values,parentId:e.target.value,role:root?(root.role!=='both'?root.role:values.role==='both'?'expense':values.role):values.role});}}><option value="">Без родительской категории</option>{state.categories.filter(c=>!c.parentId&&!c.hidden).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></OperationField><OperationField label="Использовать для"><select disabled={disabled} value={values.role} onChange={e=>set({...values,role:e.target.value as typeof values.role})}>{Object.entries(categoryRoles).filter(([v])=>!values.parentId||state.categories.some(c=>c.id===values.parentId&&(c.role==='both'?v!=='both':c.role===v))).map(([v,n])=><option key={v} value={v}>{n}</option>)}</select></OperationField></>:<label className={styles.checkboxRow}><input type="checkbox" checked={values.hidden} disabled={disabled} onChange={e=>set({...values,hidden:e.target.checked})}/>Скрыть из выбора категорий</label>)}
   {!forCategory&&<div className={styles.selfField}><label className={styles.checkboxRow}><input type="checkbox" checked={values.isSelf} disabled={disabled} onChange={e=>set({...values,isSelf:e.target.checked})}/>Это я</label><p className={styles.muted}>Отметьте, если это ваш счёт. Так CashNeuro распознает переводы между вашими счетами.</p></div>}
   {editing&&editor.id&&(forCategory?<div className={styles.categoryActions}>
    <button type="button" className={common.button} disabled={disabled} onClick={()=>onStructure(editor.id!,'merge')}>Объединить</button>
    <button type="button" className={common.button} disabled={disabled} onClick={()=>onStructure(editor.id!,'migrate')}>Изменить назначение</button>
    {category?.parentId&&<button type="button" className={common.button} disabled={disabled} onClick={()=>onStructure(editor.id!,'move')}>Переместить</button>}
    <button type="button" className={common.dangerButton} disabled={disabled} onClick={()=>onStructure(editor.id!,'delete')}>Удалить</button>
   </div>:party?.state==='registered'&&<><div><strong>Операции</strong><div className={styles.cardActions}><button type="button" className={common.button} disabled={disabled} onClick={()=>onOperations(editor.id!,entity!.name)}>Посмотреть операции</button><button type="button" className={common.button} disabled={disabled} onClick={()=>onAddOperations(editor.id!)}>Привязать операции</button></div></div><div><strong>Карточка</strong><div className={styles.cardActions}><button type="button" className={common.button} disabled={disabled} onClick={()=>onStructure(editor.id!,'merge')}>Объединить</button><button type="button" className={common.button} disabled={disabled} onClick={()=>onStructure(editor.id!,'split')}>Разделить</button></div></div></>)}{stale&&<p role="alert">Данные изменились. Откройте окно заново.</p>}{serverError&&!serverError.includes('таким именем')&&<p role="alert" className={styles.inlineError}>{serverError}</p>}
  </form>
 </OperationDialog>;
}
