import {SelectField} from './SelectField';
import {useId,useState} from 'react';
import type {Category,Role} from '../../../packages/finance-core/src/model';
import type {CommandState} from './workspace-command';
import type {SettingsIntent} from './settings-intents';
import {OperationField} from './OperationDialog';
import {SearchFilter} from './SearchFilter';
import {DraftFrame,useSettingsDraft} from './settings-draft';
import type {EditorProps} from './settings-draft';
import {OperationSelection} from './SettingsOperationPicker';
import common from './App.module.css';
import styles from './Workspace.module.css';

export type StructureAction='merge'|'split'|'migrate'|'move'|'delete';
export type StructureEditor={kind:'account'|'category'|'counterparty';id:string;action?:StructureAction};
const roles={expense:'Расходы',income:'Доходы',both:'Расходы и доходы'};
const covers=(to:Category['role'],from:Category['role'])=>to==='both'||to===from;

export function SettingsStructure(props:EditorProps&{editor:StructureEditor&{kind:'category'|'counterparty'};timezone:string;commandState:CommandState}){
 const draft=useSettingsDraft(props),s=draft.snapshot,{id,kind}=props.editor,action=props.editor.action??'merge',formId=useId();
 const category=kind==='category'?s.categories.find(c=>c.id===id):undefined;
 const party=kind==='counterparty'?s.counterparties.find(c=>c.id===id):undefined;
 const entity=category??party;
 const [target,setTarget]=useState(''),[donors,setDonors]=useState<string[]>([]),[selected,setSelected]=useState<string[]>([]),[ready,setReady]=useState(false),[role,setRole]=useState<Category['role']>(category?.role??'expense'),[sent,setSent]=useState(false);
 if(!entity||sent&&draft.stale)return null;
 const parent=s.categories.find(c=>c.id===category?.parentId);
 const categoryTargets=category?s.categories.filter(c=>c.id!==id&&!c.hidden&&!!c.parentId===!!category.parentId&&covers(c.role,category.role)):[];
 const moveTargets=category?.parentId?s.categories.filter(c=>!c.parentId&&!c.hidden&&c.id!==category.parentId&&covers(c.role,category.role)):[];
 const parties=s.counterparties.filter(p=>p.id!==id&&p.state==='registered');
 const mergeOptions=category?s.categories.filter(c=>c.id!==id&&!c.hidden&&!!c.parentId===!!category.parentId&&covers(category.role,c.role)):parties;
 const allowedRoles=parent?parent.role==='both'?['expense','income']:[parent.role]:['expense','income','both'];
 const [roleChoices,setRoleChoices]=useState<Record<string,Role>>({});
 const touched=new Set([id,...s.categories.filter(c=>c.parentId===id).map(c=>c.id)]);
 const related=(c:string|null,sub:string|null)=>touched.has(c??'')||touched.has(sub??'');
 const operations=s.categoryOperations??s.operations.map(o=>({id:o.id,role:o.classification.role.value,categoryId:o.classification.category.value,subcategoryId:o.classification.subcategory.value,merchant:o.classification.merchant.value,retired:false}));
 const decisions=action==='migrate'?[
  ...operations.filter(o=>related(o.categoryId,o.subcategoryId)).map((o,i)=>({kind:'operation' as const,id:o.id,role:o.role,label:`Смысл операции ${i+1}: ${o.merchant||'Операция'}`,retired:o.retired})),
  ...(s.categoryComponents??[]).filter(c=>related(c.categoryId,c.subcategoryId)).map((c,i)=>({kind:'component' as const,id:c.id,role:c.role,label:`Смысл части ${i+1}: операция`,retired:c.retired})),
 ]:[];
 const roleDecisions=decisions.flatMap(d=>{const value=roleChoices[d.kind+':'+d.id];return value?[{kind:d.kind,id:d.id,role:value}]:[];});
 const noChanges=action==='merge'&&!donors.length||action==='move'&&!target||action==='migrate'&&(!allowedRoles.includes(role)||role===category?.role)||action==='split'&&(!target||!selected.length||!ready);
 function build():SettingsIntent{
  if(category){
   if(action==='migrate'||action==='move')return {kind:'migrate_category',id,parentId:action==='move'?target:category.parentId,role:action==='move'?category.role:role,roleDecisions,childRoles:[]};
   if(action==='delete')return {kind:'delete_category',id,replacementId:target||null,roleDecisions:[],childRoles:[]};
   return {kind:'merge_categories',id,sourceIds:donors,roleDecisions:[],childRoles:[]};
  }
  if(action==='merge')return {kind:'merge_counterparties',id,sourceIds:donors};
  if(action==='delete')return {kind:'delete_counterparty',id};
  return {kind:'transfer_counterparty_operations',id,targetId:target,operationIds:selected};
 }
 const title=action==='merge'?(category?'Объединить категории':'Объединить контрагентов'):action==='split'?'Разделить':action==='migrate'?'Изменить назначение':action==='move'?'Переместить подкатегорию':'Удалить';
 const commandTitle=action==='split'?'Подтвердить перенос':action==='merge'&&category?'Объединить категории?':title+' «'+entity.name+'»';
 const requestError=sent&&props.commandState.title===commandTitle&&!props.commandState.preview?props.commandState.error:'';
 return <DraftFrame narrow={action!=='split'} title={title} wide={action==='split'} close={props.close} error={draft.error||requestError} stale={draft.stale} disabled={props.disabled} footer={<button type="submit" form={formId} className={common.primaryButton} disabled={draft.locked||noChanges}>{action==='split'?'Перенести':'Продолжить'}</button>}>
  <form id={formId} onSubmit={e=>{e.preventDefault();if(noChanges||draft.locked)return;setSent(true);draft.submit(build,commandTitle);}}><fieldset className={styles.form} disabled={draft.locked}>
   {action==='merge'&&<><p>{category?'Останется категория':'Останется карточка'} «{entity.name}». {category?'Операции и подкатегории выбранных категорий перейдут в неё.':'Операции выбранных контрагентов будут привязаны к ней.'}</p><OperationField label={category?'Какие категории присоединить':'Кого присоединить'}><SearchFilter label={category?'Выберите категории':'Выберите контрагентов'} options={mergeOptions.map(x=>[x.id,x.name] as const)} value={donors} onChange={setDonors} disabled={draft.locked||!mergeOptions.length}/></OperationField>{!mergeOptions.length&&<p>Нет подходящих карточек для объединения.</p>}</>}
   {action==='delete'&&category&&<OperationField label="Новая категория для зависимых данных"><SearchFilter label="Новая категория для зависимых данных" options={[['','Оставить без категории'],...categoryTargets.map(c=>[c.id,c.name] as const)]} value={[target]} onChange={ids=>setTarget(ids[0]??'')} disabled={draft.locked} single fullWidth/></OperationField>}
   {action==='move'&&<><p>Перемещаем «{entity.name}».</p><OperationField label="Новая родительская категория"><SearchFilter label="Выберите категорию" options={moveTargets.map(c=>[c.id,c.name] as const)} value={target?[target]:[]} onChange={ids=>setTarget(ids[0]??'')} disabled={draft.locked||!moveTargets.length} single fullWidth/></OperationField>{!moveTargets.length&&<p>Нет другой категории с подходящим назначением.</p>}</>}
   {action==='migrate'&&<><OperationField label="Использовать для"><SelectField value={allowedRoles.includes(role)?role:''} onChange={e=>setRole(e.target.value as Category['role'])}>{!allowedRoles.includes(role)&&<option value="" disabled>Выберите назначение</option>}{allowedRoles.map(r=><option key={r} value={r}>{roles[r as Category['role']]}</option>)}</SelectField></OperationField>{parent&&parent.role!=='both'&&<p>Назначение задано родительской категорией «{parent.name}».</p>}{!parent&&role!=='both'&&s.categories.some(c=>c.parentId===id)&&<p>Подкатегории получат то же назначение.</p>}</>}
   {action==='split'&&<><p>Переносим операции от «{entity.name}».</p><OperationField label="Кому перенести"><SelectField value={target} onChange={e=>setTarget(e.target.value)} disabled={!parties.length}><option value="">Выберите контрагента</option>{parties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></OperationField>{!parties.length&&<p>Нет другого сохранённого контрагента.</p>}{target&&<OperationSelection state={s} timezone={props.timezone} disabled={draft.locked} selected={selected} onSelected={setSelected} onReady={setReady} counterpartyId={id} label="Какие операции перенести"/>}</>}
   {action==='migrate'&&decisions.length>0&&<details><summary>Решения о финансовом смысле</summary><p>При изменении назначения выберите финансовый смысл зависимых операций и частей. Без выбора их смысл сохраняется; несовместимое изменение сервер отклонит.</p>{decisions.map(d=><div key={d.kind+':'+d.id}>{d.retired&&<small>Сохранённая старая версия</small>}<OperationField label={d.label}><SelectField value={roleChoices[d.kind+':'+d.id]??''} onChange={e=>setRoleChoices(v=>{const next={...v};if(e.target.value)next[d.kind+':'+d.id]=e.target.value as Role;else delete next[d.kind+':'+d.id];return next;})}><option value="">Не изменять</option>{Object.entries(roles).filter(([r])=>r!=='both'&&(role==='both'||role===r)).map(([r,label])=><option key={r} value={r}>{label}</option>)}</SelectField></OperationField></div>)}</details>}
  </fieldset></form>
 </DraftFrame>;
}
