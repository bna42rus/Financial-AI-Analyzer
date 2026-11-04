import {useEffect,useId,useState} from 'react';
import {safeText,sanitizeText} from '../../../packages/privacy/src/text';
import type {Category,Role} from '../../../packages/finance-core/src/model';
import type {SettingsIntent} from './settings-intents';
import {roleNames,displayBankDate} from './finance-client';
import {formatMoney} from './demo/overview';
import {DraftFrame,useSettingsDraft,operationName} from './settings-draft';
import type {EditorProps} from './settings-draft';
import common from './App.module.css';
import styles from './Workspace.module.css';
export type StructureEditor={kind:'account'|'category'|'counterparty';id:string};
const roles={expense:'Расходы',income:'Доходы',both:'Расходы и доходы'};
const text=(v:unknown)=>{const s=safeText(sanitizeText(String(v??'')),160);if(!s.trim())throw new Error('Укажите название нового контрагента.');return s;};
export function SettingsStructure(props:EditorProps&{editor:StructureEditor&{kind:'category'|'counterparty'}}){
 const draft=useSettingsDraft(props),s=draft.snapshot,{kind,id}=props.editor;
 const formId=useId();
 useEffect(()=>{if(draft.stale)props.close();},[draft.stale]);
 const items=kind==='category'?s.categories:s.counterparties,entity=items.find(x=>x.id===id)!;
 const [action,setAction]=useState('merge');
 const category=kind==='category'?s.categories.find(c=>c.id===id)!:null;
 const [target,setTarget]=useState(''),[role,setRole]=useState<Category['role']>(category?.role??'expense'),[parent,setParent]=useState(category?.parentId??''),[donors,setDonors]=useState<string[]>([]);
 const [newItems,setNewItems]=useState([{id:crypto.randomUUID(),name:'',state:'registered' as 'registered'|'ignored',isSelf:false}]);
 const [distribution,setDistribution]=useState<Record<string,string>>({}),[roleChoices,setRoleChoices]=useState<Record<string,string>>({}),[childChoices,setChildChoices]=useState<Record<string,Category['role']>>({});
 const sources=(s.counterpartySources??[]).filter(r=>r.counterpartyId===id).map(r=>({id:r.observationId,operationId:r.transactionId,aliasId:r.aliasId}));
 const aliases=(s.counterpartyAliases??[]).filter(a=>a.counterpartyId===id);
 const bound=new Set(sources.map(r=>r.operationId)),operations=s.operations.filter(o=>bound.has(o.id)||o.classification.counterparty.value===id);
 const splitSupported=s.counterpartySources!==undefined&&s.counterpartyAliases!==undefined;
 const categoryTarget=action==='merge'?category:action==='delete'?s.categories.find(c=>c.id===target):category;
 const categoryIds=new Set([id,...(action==='merge'?donors:[]),...(action==='delete'&&target?[target]:[])]);
 const touched=new Set([...categoryIds,...s.categories.filter(c=>c.parentId&&categoryIds.has(c.parentId)).map(c=>c.id)]);
 const categoryOperations=(s.categoryOperations??s.operations.map(o=>({id:o.id,role:o.classification.role.value,categoryId:o.classification.category.value,subcategoryId:o.classification.subcategory.value,merchant:o.classification.merchant.value,retired:false}))).filter(o=>touched.has(o.categoryId??'')||touched.has(o.subcategoryId??''));
 const categoryParts=(s.categoryComponents??[]).filter(c=>touched.has(c.categoryId??'')||touched.has(c.subcategoryId??''));
 const childCategories=categoryTarget?s.categories.filter(c=>c.parentId===categoryTarget.id||(action==='merge'&&c.parentId&&donors.includes(c.parentId))||(action==='delete'&&c.parentId===id)):[];
 function build():SettingsIntent {
  if(action==='merge'&&!donors.length)throw new Error('Выберите хотя бы одну запись для объединения.');
  if(kind==='category'){
   if(s.categoryComponents===undefined)throw new Error('Данные зависимых частей не получены. Обновите данные.');
   const roleDecisions=[...categoryOperations.map(o=>({kind:'operation' as const,id:o.id})),...categoryParts.map(c=>({kind:'component' as const,id:c.id}))].flatMap(r=>roleChoices[r.kind+':'+r.id]?[{...r,role:roleChoices[r.kind+':'+r.id] as Role}]:[]);
   const childRoles=childCategories.filter(c=>childChoices[c.id]&&childChoices[c.id]!==c.role).map(c=>({id:c.id,role:childChoices[c.id]!}));
   if(action==='migrate')return {kind:'migrate_category',id,parentId:parent||null,role,roleDecisions,childRoles};
   if(action==='delete')return {kind:'delete_category',id,replacementId:target||null,...(target?{targetRole:role}:{}),roleDecisions,childRoles};
   return {kind:'merge_categories',id,sourceIds:donors,targetRole:role,roleDecisions,childRoles};
  }
  if(action==='delete')return {kind:'delete_counterparty',id};
  if(action==='merge')return {kind:'merge_counterparties',id,sourceIds:donors};
  if(!splitSupported)throw new Error('Привязки источников не получены. Обновите данные.');
  const get=(type:string,rowId:string)=>{const value=distribution[type+':'+rowId];if(value===undefined||value==='')throw new Error('Распределите каждый источник, банковский псевдоним и операцию явно.');return value;};
  for(const r of sources)if(r.aliasId&&get('source',r.id)!==get('alias',r.aliasId))throw new Error('Источники одного банковского псевдонима должны относиться к одному контрагенту. Проверьте распределение.');
  return {kind:'split_counterparty',id,newParties:newItems.map(p=>({id:p.id,name:text(p.name),state:p.state,isSelf:p.isSelf})),observations:sources.map(r=>({id:r.id,counterpartyId:get('source',r.id)})),aliases:aliases.map(a=>({id:a.id,counterpartyId:get('alias',a.id)})),operations:operations.map(o=>({id:o.id,counterpartyId:get('operation',o.id)==='none'?null:get('operation',o.id)}))};
 }
 function assignment(type:string,rowId:string,label:string,operation=false){const choices=operation?items:items.filter(x=>x.id===id);return <label key={rowId}>{label}<select aria-label={label} value={distribution[type+':'+rowId]??''} onChange={e=>setDistribution(v=>({...v,[type+':'+rowId]:e.target.value}))}><option value="">Выберите явно</option>{operation&&<option value="none">Без контрагента</option>}{choices.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}{newItems.map((a,i)=><option key={a.id} value={a.id}>{a.name.trim()||`Новый контрагент ${i+1}`}</option>)}</select></label>;}
 const title='Структура: '+entity.name;
 return <DraftFrame title={title} close={props.close} error={draft.error} stale={draft.stale} disabled={props.disabled} footer={<button type="submit" form={formId} className={common.primaryButton} disabled={draft.locked||action==='split'&&!splitSupported}>Продолжить</button>}><form id={formId} onSubmit={e=>{e.preventDefault();draft.submit(build,({merge:'Объединение',split:'Разделение',migrate:'Перенос категории',delete:'Удаление'}[action]??'Изменение')+' «'+entity.name+'»');}}><fieldset className={styles.form} disabled={draft.locked}><label>Действие<select aria-label="Действие" value={action} onChange={e=>{setAction(e.target.value);setDonors([]);setRoleChoices({});setChildChoices({});setTarget('');setRole(category?.role??'expense');}}><option value="merge">Объединить</option>{kind==='category'?<option value="migrate">Изменить роль или родителя</option>:<option value="split">Разделить</option>}<option value="delete">Удалить</option></select></label>
 {action==='merge'&&<><p>Записи будут объединены с «{entity.name}».</p><fieldset className={styles.form}><legend>Выберите записи</legend>{items.filter(x=>x.id!==id&&(kind!=='category'||!!(x as Category).parentId===!!category!.parentId)).map(x=><label key={x.id}><input type="checkbox" checked={donors.includes(x.id)} onChange={e=>setDonors(v=>e.target.checked?[...v,x.id]:v.filter(i=>i!==x.id))}/>{x.name}</label>)}</fieldset></>}
 {kind==='category'&&<>{action==='delete'&&<label>Новая категория для зависимых данных<select aria-label="Новая категория для зависимых данных" value={target} onChange={e=>{setTarget(e.target.value);setRole(s.categories.find(c=>c.id===e.target.value)?.role??category!.role);setChildChoices({});setRoleChoices({});}}><option value="">Оставить без категории</option>{s.categories.filter(c=>c.id!==id&&!!c.parentId===!!category!.parentId).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}{action==='migrate'&&<label>Новый родитель<select aria-label="Новый родитель" value={parent} onChange={e=>setParent(e.target.value)}><option value="">Корневая категория</option>{s.categories.filter(c=>c.parentId===null&&c.id!==id).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}{(action!=='delete'||target)&&<label>Допустимая роль категории<select aria-label="Допустимая роль категории" value={role} onChange={e=>setRole(e.target.value as Category['role'])}>{Object.entries(roles).map(([v,n])=><option key={v} value={v}>{n}</option>)}</select></label>}
 {childCategories.length>0&&<details><summary>Роли зависимых подкатегорий ({childCategories.length})</summary>{childCategories.map(c=><label key={c.id}>Роль подкатегории: {c.name}<select aria-label={`Роль подкатегории: ${c.name}`} value={childChoices[c.id]??c.role} onChange={e=>setChildChoices(v=>({...v,[c.id]:e.target.value as Category['role']}))}>{Object.entries(roles).map(([v,n])=><option key={v} value={v}>{n}</option>)}</select></label>)}</details>}
 <p>Если новая категория не подходит операции, выберите для неё финансовый смысл.</p>
 {(categoryOperations.length>0||categoryParts.length>0)&&<details><summary>Решения о финансовом смысле</summary>{[...categoryOperations.map((o,i)=>({kind:'operation',id:o.id,label:`Смысл операции ${i+1}: ${o.merchant||operationName(s,o.id)}${o.retired?' · Сохранённая старая версия':''}`,current:o.role})),...categoryParts.map((c,i)=>({kind:'component',id:c.id,label:`Смысл части ${i+1}: ${s.categoryOperations?.find(o=>o.id===c.transactionId)?.merchant||operationName(s,c.transactionId)}${c.retired?' · Сохранённая старая версия':''}`,current:c.role}))].map(r=><label key={r.kind+r.id}>{r.label}<select aria-label={r.label} value={roleChoices[r.kind+':'+r.id]??''} onChange={e=>setRoleChoices(v=>({...v,[r.kind+':'+r.id]:e.target.value}))}><option value="">Сохранить: {roleNames[r.current]}</option>{Object.entries(roleNames).filter(([v])=>v!=='mixed').map(([v,n])=><option key={v} value={v}>{n}</option>)}</select></label>)}</details>}</>}
 {action==='delete'&&kind==='counterparty'&&<p>Удалится контрагент и его настройки. Операции сохранятся.</p>}
 {action==='split'&&<><p>Распределите операции и их банковские источники между контрагентами.</p>{!splitSupported&&<p role="alert">Данные привязок не получены. Обновите данные перед разделением.</p>}{newItems.map((a,i)=><fieldset className={styles.form} key={a.id}><legend>Новый контрагент {i+1}</legend><label>Название нового контрагента {i+1}<input value={a.name} maxLength={160} required onChange={e=>setNewItems(v=>v.map(x=>x.id===a.id?{...x,name:e.target.value}:x))}/></label><label>Статус нового контрагента {i+1}<select aria-label={`Статус нового контрагента ${i+1}`} value={a.state} onChange={e=>setNewItems(v=>v.map(x=>x.id===a.id?{...x,state:e.target.value as typeof a.state}:x))}><option value="registered">Зарегистрирован</option><option value="ignored">Игнорируется</option></select></label><label><input type="checkbox" checked={a.isSelf} onChange={e=>setNewItems(v=>v.map(x=>x.id===a.id?{...x,isSelf:e.target.checked}:x))}/>Новый контрагент {i+1} — это я</label></fieldset>)}<button type="button" className={common.button} disabled={newItems.length>=9} onClick={()=>setNewItems(v=>[...v,{...v[0]!,id:crypto.randomUUID(),name:''}])}>Добавить контрагента</button>
 <details open><summary>Источники ({sources.length})</summary>{sources.map((r,i)=>assignment('source',r.id,`Источник ${i+1}: ${operationName(s,r.operationId)}`))}</details><details open><summary>Банковские псевдонимы ({aliases.length})</summary>{aliases.map((a,i)=>assignment('alias',a.id,`Псевдоним ${i+1}: ${a.type}`))}</details><details open><summary>Операции ({operations.length})</summary>{operations.map((o,i)=>assignment('operation',o.id,`Операция ${i+1}: ${operationName(s,o.id)} · ${displayBankDate(o.date,'Europe/Moscow')} · ${formatMoney(o.amountMinor)}`,true))}</details></>}
 </fieldset></form></DraftFrame>;
}
