import {SelectField} from './SelectField';
import {bankNames} from './finance-client';
import {SearchFilter} from './SearchFilter';
import type {StructureAction} from './SettingsStructure';
import {useEffect,useId,useState} from 'react';
import {safeText,sanitizeText} from '../../../packages/privacy/src/text';
import {OperationDialog,OperationField} from './OperationDialog';
import type {FinanceState} from './finance-client';
import type {CommandState,WorkspaceCommand} from './workspace-command';
import common from './App.module.css';
import operationStyles from './ServerOperation.module.css';
import styles from './Settings.module.css';

export type EntityEditor={kind:'category'|'counterparty';id?:string;add?:boolean};
const nameKey=(name:string)=>name.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('ru-RU');
const categoryRoles={expense:'Расходы',income:'Доходы',both:'Расходы и доходы'};
export function SettingsEntityDialog({editor,state,command,commandState,disabled,close,onStructure,onOperations,onAddOperations,onProposalOperations,proposalSelectionRevision,onRule}:{onProposalOperations:(id:string)=>void;proposalSelectionRevision:string|null;onRule:(id:string)=>void;onStructure:(id:string,action:StructureAction)=>void;onOperations:(id:string,name:string)=>void;onAddOperations:(id:string)=>void;editor:EntityEditor;state:FinanceState;command:WorkspaceCommand|null;commandState:CommandState;disabled:boolean;close:()=>void}){
 const category=state.categories.find(c=>c.id===editor.id),party=state.counterparties.find(c=>c.id===editor.id);
 const entity=category??party,editing=!!entity,forCategory=editor.kind==='category';
 const linkedRule=party?.autoRuleId?state.rules.find(r=>r.id===party.autoRuleId):undefined;
 const canRemember=editor.kind==='counterparty'&&!!party&&(party.state==='registered'||!!editor.add);
 const initial={name:entity?.name??'',role:category?.role??'expense',parentId:category?.parentId??'',hidden:category?.hidden??false,isSelf:party?.isSelf??false,remember:linkedRule?.enabled??false,ruleBank:'',ruleDirection:'',ruleDescription:''};
 const [values,set]=useState(initial),[error,setError]=useState(''),[sent,setSent]=useState<string|null>(null);
 const form=useId(),[autoRuleId]=useState(()=>crypto.randomUUID()),[openedAt]=useState(()=>({generation:state.generation,revision:state.revision}));
 const epoch={...openedAt,revision:proposalSelectionRevision??openedAt.revision};
 const stale=epoch.generation!==state.generation||epoch.revision!==state.revision;
 const title=forCategory?(editing?'Изменить категорию':'Новая категория'):(editor.add?'Добавить контрагента':editing?'Изменить контрагента':'Новый контрагент');
 const changed=JSON.stringify(values)!==JSON.stringify(initial);
 const configureRule=canRemember&&values.remember&&!linkedRule&&!party?.hasBankIdentity;
 const ruleReady=!configureRule||!!values.ruleDirection&&!!values.ruleDescription.trim();
 const serverError=sent&&commandState.title===sent&&!commandState.preview?commandState.error:'';
 useEffect(()=>{if(sent&&stale&&commandState.phase==='idle'&&!commandState.error)close();},[sent,stale,commandState.phase,commandState.error]);
 function apply(){
  const name=safeText(sanitizeText(values.name),160).trim();
  if(!name){setError('Укажите название.');return;}
  if(!forCategory&&(!editing||editor.add||party?.state==='registered'&&name!==initial.name)&&state.counterparties.some(p=>p.id!==editor.id&&p.state==='registered'&&nameKey(p.name)===nameKey(name))){setError('Контрагент с таким именем уже существует.');return;}
  const patch:Record<string,unknown>=editing?{}:{name};
  if(name!==initial.name)patch.name=name;
  if(forCategory){
   if(!editing)Object.assign(patch,{role:values.role,parentId:values.parentId||null});
   if(!editing||values.hidden!==initial.hidden)patch.hidden=values.hidden;
  }else{
   if(!editing||editor.add)patch.state='registered';
   if(canRemember&&values.remember!==initial.remember){
    if(!ruleReady){setError('Укажите направление и текст для правила.');return;}
    patch.rememberForFuture=values.remember;
    if(values.remember&&!linkedRule)patch.autoRuleId=autoRuleId;
    if(configureRule)patch.ruleConditions={...(values.ruleBank?{bankId:values.ruleBank}:{}),direction:values.ruleDirection,descriptionContains:safeText(sanitizeText(values.ruleDescription),160)};
   }
   if(!editing||values.isSelf!==initial.isSelf)patch.isSelf=values.isSelf;
  }
  if(!Object.keys(patch).length){close();return;}
  setSent(title);void command?.begin({kind:editor.kind,id:editor.id??crypto.randomUUID(),patch,create:!editing},title,editing&&('isSelf'in patch||'state'in patch||'rememberForFuture'in patch),epoch);
 }
 return <OperationDialog compact={!forCategory} title={title} onClose={()=>{if(!disabled)close();}} footer={<><button type="button" className={styles.textButton+' '+operationStyles.leftAction} disabled={disabled||!changed} onClick={()=>{set(initial);setError('');}}>Сбросить</button><button type="submit" form={form} className={common.primaryButton} disabled={disabled||stale||!ruleReady||editing&&!changed&&!editor.add}>{editor.add?'Добавить':editing?'Сохранить':'Создать'}</button></>}>
  <form id={form} className={styles.settingsStack+' '+styles.entityForm} noValidate onSubmit={e=>{e.preventDefault();apply();}}>
   <OperationField label={forCategory?"Название":"Имя контрагента"} error={error||(!forCategory&&serverError.includes("таким именем")?serverError:undefined)}><input value={values.name} maxLength={160} disabled={disabled} onChange={e=>{set({...values,name:e.target.value});setError('');}}/></OperationField>
   {forCategory&&(!editing?<><OperationField label="Родительская категория"><SearchFilter label="Родительская категория" single fullWidth value={[values.parentId]} disabled={disabled} onChange={([parentId=''])=>{const root=state.categories.find(c=>c.id===parentId);set({...values,parentId,role:root?(root.role!=='both'?root.role:values.role==='both'?'expense':values.role):values.role});}}
    options={[['','Без родительской категории'],...state.categories.filter(c=>!c.parentId&&!c.hidden).map(c=>[c.id,c.name] as const)]}/></OperationField><OperationField label="Использовать для"><SearchFilter label="Использовать для" single fullWidth disabled={disabled} value={[values.role]}
    onChange={([role])=>{if(role)set({...values,role:role as typeof values.role});}}
    options={Object.entries(categoryRoles).filter(([v])=>!values.parentId||state.categories.some(c=>c.id===values.parentId&&(c.role==='both'?v!=='both':c.role===v)))}/></OperationField></>:<label className={styles.checkboxRow}><input type="checkbox" checked={values.hidden} disabled={disabled} onChange={e=>set({...values,hidden:e.target.checked})}/>Скрыть из выбора категорий</label>)}
   {!forCategory&&<div className={styles.selfField}><label className={styles.checkboxRow}><input type="checkbox" checked={values.isSelf} disabled={disabled} onChange={e=>set({...values,isSelf:e.target.checked})}/>Это я</label><p className={styles.muted}>Отметьте, если это ваш счёт. Так CashNeuro распознает переводы между вашими счетами.</p></div>}
   {canRemember&&<div className={styles.selfField}>
    <label className={styles.checkboxRow}><input type="checkbox" checked={values.remember} disabled={disabled||linkedRule?.dependencyStatus==='needs_setup'} onChange={e=>set({...values,remember:e.target.checked})}/>Запомнить для будущих операций</label>
    {linkedRule&&<button type="button" className={common.linkButton} disabled={disabled} onClick={()=>onRule(linkedRule.id)}>Открыть правило</button>}
    {configureRule&&<fieldset className={operationStyles.ruleGroup}><legend>Условия для будущих операций</legend>
     <OperationField label="Банк"><SelectField value={values.ruleBank} onChange={e=>set({...values,ruleBank:e.target.value})}><option value="">Любой банк</option>{Object.entries(bankNames).map(([id,label])=><option key={id} value={id}>{label}</option>)}</SelectField></OperationField>
     <OperationField label="Направление"><SelectField value={values.ruleDirection} onChange={e=>set({...values,ruleDirection:e.target.value})}><option value="">Выберите направление</option><option value="in">Поступление</option><option value="out">Списание</option></SelectField></OperationField>
     <OperationField label="Описание содержит"><input value={values.ruleDescription} maxLength={160} onChange={e=>set({...values,ruleDescription:e.target.value})}/></OperationField>
    </fieldset>}
   </div>}
   {editor.add&&party&&<p>Операций будет привязано: {(party.proposalOperationIds??party.proposalCandidates?.slice(0,1000)??[]).filter(id=>party.proposalCandidates?.includes(id)).length}.</p>}
   {editing&&editor.id&&(forCategory?<div className={styles.categoryActions}>
    <button type="button" className={common.button} disabled={disabled} onClick={()=>onStructure(editor.id!,'merge')}>Объединить</button>
    <button type="button" className={common.button} disabled={disabled} onClick={()=>onStructure(editor.id!,'migrate')}>Изменить назначение</button>
    {category?.parentId&&<button type="button" className={common.button} disabled={disabled} onClick={()=>onStructure(editor.id!,'move')}>Переместить</button>}
    <button type="button" className={common.dangerButton} disabled={disabled} onClick={()=>onStructure(editor.id!,'delete')}>Удалить</button>
   </div>:party&&<><div><strong>Операции</strong><div className={styles.cardActions}>
    <button type="button" className={common.button} disabled={disabled||stale} onClick={()=>party.state==='registered'?onOperations(party.id,party.name):onProposalOperations(party.id)}>Посмотреть операции</button>
    {party.state==='registered'&&<button type="button" className={common.button} disabled={disabled} onClick={()=>onAddOperations(party.id)}>Привязать операции</button>}
   </div></div>
   {party.state==='registered'&&<div><strong>Карточка</strong><div className={styles.cardActions}>
    <button type="button" className={common.button} disabled={disabled} onClick={()=>onStructure(party.id,'merge')}>Объединить</button>
    <button type="button" className={common.button} disabled={disabled} onClick={()=>onStructure(party.id,'split')}>Разделить</button>
   </div></div>}</>)}{stale&&<p role="alert">Данные изменились. Откройте окно заново.</p>}{serverError&&!serverError.includes('таким именем')&&<p role="alert" className={styles.inlineError}>{serverError}</p>}
  </form>
 </OperationDialog>;
}
