import {useEffect,useId,useState} from 'react';
import {initialSemantics} from '../../../packages/finance-core/src/model';
import type {Operation} from '../../../packages/finance-core/src/model';
import {ruleMatches,validateRule} from '../../../packages/finance-core/src/rules';
import type {Rule} from '../../../packages/finance-core/src/rules';
import {safeText,sanitizeText} from '../../../packages/privacy/src/text';
import {kindNames,roleNames,bankNames,rublesToMinor,minorToRubles,displayBankDate} from './finance-client';
import type {FinanceState} from './finance-client';
import {formatMoney} from './demo/overview';
import {DraftFrame,useSettingsDraft,operationName} from './settings-draft';
import type {EditorProps} from './settings-draft';
import {OperationDialog,OperationField} from './OperationDialog';
import type {CommandState} from './workspace-command';
import operationStyles from './ServerOperation.module.css';
import common from './App.module.css';
import styles from './Workspace.module.css';
const conditionNames:Record<string,string>={merchantEquals:'Магазин точно совпадает',merchantContains:'Магазин содержит',descriptionContains:'Описание содержит',accountId:'Счёт условия',bankId:'Банк условия',counterpartyId:'Контрагент условия',direction:'Направление',kind:'Тип операции в условии',amountFromMinor:'Сумма от, ₽',amountThroughMinor:'Сумма до, ₽'};
const actionNames:Record<string,string>={role:'Назначить финансовый смысл',kind:'Назначить тип операции',categoryId:'Назначить категорию',subcategoryId:'Назначить подкатегорию',merchant:'Нормализованное название магазина',counterpartyId:'Назначить контрагента',analyticsOverride:'Участие операции в аналитике'};
export function ruleOperationIds(state:FinanceState,rule:Rule):string[]{return state.operations.filter(p=>{const account=state.accounts.find(a=>a.id===p.accountId);if(!account)return false;const op:Operation={id:p.id,source:{accountId:p.accountId,operationDate:p.date,postedDate:null,amountMinor:p.amountMinor,currency:'RUB',merchantText:p.classification.merchant.value,description:p.description??'',bankCategory:'',bankRefHmac:null,versions:{parser:'projection',normalizer:'projection',sanitizer:'projection'}},corrections:{},semantics:p.classification??initialSemantics('other'),comment:p.comment,analyticsOverride:'default',decomposition:false,reviewReasons:p.reviewReasons};return ruleMatches(op,account,rule);}).map(p=>p.id);}
function rulePatch(r:Rule):Omit<Rule,'id'>{return {name:r.name,enabled:r.enabled,priority:r.priority,conditions:r.conditions,assignments:r.assignments};}
export function RuleEditor(props:EditorProps&{id:string|null;seed?:Rule;commandState?:CommandState;allowHistory?:boolean}){
 const draft=useSettingsDraft(props),s=draft.snapshot,persisted=s.rules.find(r=>r.id===props.id),existing=persisted??props.seed;
 const [id]=useState(()=>existing?.id??crypto.randomUUID()),formId=useId();
 const [initial]=useState(()=>({name:existing?.name??'',priority:String(existing?.priority??100),conditions:Object.fromEntries(Object.entries(existing?.conditions??{}).map(([k,v])=>[k,k.startsWith('amount')?minorToRubles(String(v)):String(v)])),assignments:Object.fromEntries(Object.entries(existing?.assignments??{}).map(([k,v])=>[k,v===null?'clear':String(v)])),history:false}));
 const [values,setValues]=useState(initial),[errors,setErrors]=useState<Record<string,string>>({}),[attempt,setAttempt]=useState<{title:string;receipt:string|null}|null>(null);
 const {name,priority,conditions,assignments,history}=values;
 const title=persisted?'Изменение правила':'Создание правила';
 const serverError=attempt&&props.commandState?.title===attempt.title?props.commandState.error:'';
 useEffect(()=>{if(attempt&&props.commandState?.phase==='idle'&&props.commandState.undoActionId&&props.commandState.undoActionId!==attempt.receipt&&!serverError)props.close();},[attempt,props.commandState?.phase,props.commandState?.undoActionId,serverError]);
 function submit(){
  if(draft.locked)return;
  const c:Record<string,unknown>={},a:Record<string,unknown>={},problems:Record<string,string>={};
  const clean=(v:string)=>safeText(sanitizeText(v.trim()),160);
  for(const [k,v] of Object.entries(conditions))if(v.trim()){
   if(k.startsWith('amount')){try{c[k]=rublesToMinor(v);}catch{problems['c.'+k]='Введите сумму в рублях, до двух знаков после запятой.';}}
   else if(['merchantEquals','merchantContains','descriptionContains'].includes(k)){const text=clean(v);if(text)c[k]=text;else problems['c.'+k]='Введите текст условия.';}
   else c[k]=v;
  }
  for(const [k,v] of Object.entries(assignments))if(v!==''){
   if(k==='merchant'){const text=clean(v);if(text)a[k]=text;else problems['a.'+k]='Введите название магазина.';}
   else a[k]=v==='clear'&&['categoryId','subcategoryId','counterpartyId'].includes(k)?null:v;
  }
  const cleanName=clean(name);
  if(!cleanName)problems.name='Укажите название правила.';
  if(!/^-?\d+$/.test(priority)||Math.abs(Number(priority))>10000)problems.priority='Введите целое число от −10000 до 10000.';
  if(!Object.keys(c).length&&!Object.keys(problems).some(k=>k.startsWith('c.')))problems.conditions='Укажите хотя бы одно условие.';
  if(!Object.keys(a).length&&!Object.keys(problems).some(k=>k.startsWith('a.')))problems.assignments='Укажите хотя бы одно действие.';
  if(typeof c.amountFromMinor==='string'&&typeof c.amountThroughMinor==='string'&&BigInt(c.amountFromMinor)>BigInt(c.amountThroughMinor))problems['c.amountThroughMinor']='Верхняя граница должна быть не меньше нижней.';
  const compatible=(role:string)=>!['expense','income'].includes(String(a.role))||role==='both'||role===a.role;
  const cat=s.categories.find(v=>v.id===a.categoryId),sub=s.categories.find(v=>v.id===a.subcategoryId);
  if(typeof a.categoryId==='string'&&(!cat||cat.parentId!==null||!compatible(cat.role)))problems['a.categoryId']='Выберите категорию, подходящую финансовому смыслу.';
  if(typeof a.subcategoryId==='string'&&(!sub||sub.parentId!==cat?.id||!compatible(sub.role)))problems['a.subcategoryId']='Выберите подкатегорию выбранной категории.';
  setErrors(problems);if(Object.keys(problems).length)return;
  try{
   const patch=validateRule({name:cleanName,enabled:persisted?.enabled??true,priority:Number(priority),conditions:c,assignments:a});
   const requestTitle=(persisted?'Изменить правило':history?'Создать и применить правило':'Создать правило')+' «'+patch.name+'»';
   setAttempt({title:requestTitle,receipt:props.commandState?.undoActionId??null});
   void props.command?.begin(history&&!persisted?{kind:'create_rule_with_history',id,patch}:{kind:'rule',id,patch,create:!persisted},requestTitle,history&&!persisted,s);
  }catch{setErrors({form:'Проверьте условия и действия правила.'});}
 }
 function control(k:string,action=false){const group=action?'assignments':'conditions',label=(action?actionNames:conditionNames)[k]!,v=values[group][k]??'';
  let options:Record<string,string>|null=null;
  if(k==='accountId')options=Object.fromEntries(s.accounts.map(a=>[a.id,a.name]));else if(k==='bankId')options={...bankNames,...Object.fromEntries(s.accounts.map(a=>[a.bankId,bankNames[a.bankId]??a.bankId]))};else if(k==='counterpartyId')options=Object.fromEntries(s.counterparties.map(p=>[p.id,p.name]));else if(k==='kind')options=kindNames;else if(k==='role')options=Object.fromEntries(Object.entries(roleNames).filter(([k])=>k!=='mixed'));else if(k==='direction')options={in:'Поступление',out:'Списание'};else if(k==='analyticsOverride')options={default:'По настройкам',include:'Включить',exclude:'Исключить'};else if(k==='categoryId')options=Object.fromEntries(s.categories.filter(c=>c.parentId===null).map(c=>[c.id,c.name+(c.hidden?' · Скрыта':'')]));else if(k==='subcategoryId')options=Object.fromEntries(s.categories.filter(c=>c.parentId!==null&&c.parentId===assignments.categoryId).map(c=>[c.id,c.name+(c.hidden?' · Скрыта':'')]));
  const update=(value:string)=>setValues(previous=>({...previous,[group]:{...previous[group],[k]:value,...(action&&k==='categoryId'?{subcategoryId:''}:{})}}));
  return <OperationField key={k} label={label} error={errors[(action?'a.':'c.')+k]}>{options?<select value={v} onChange={e=>update(e.target.value)}><option value="">{action?'Не изменять':'Любое значение'}</option>{action&&['categoryId','subcategoryId','counterpartyId'].includes(k)&&<option value="clear">Снять назначение</option>}{Object.entries(options).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>:<input value={v} maxLength={k.startsWith('amount')?24:160} inputMode={k.startsWith('amount')?'decimal':undefined} onChange={e=>update(e.target.value)}/>}</OperationField>;
 }
 const problem=(key:string)=>errors[key]&&<small className={operationStyles.fieldError} role="alert">{errors[key]}</small>;
 return <OperationDialog title={title} onClose={()=>{if(!props.disabled)props.close();}} footer={<><button type="button" className={operationStyles.quietButton} disabled={draft.locked} onClick={()=>{setValues(initial);setErrors({});setAttempt(null);}}>Сбросить</button><button form={formId} type="submit" className={common.primaryButton+' '+operationStyles.rightAction} disabled={draft.locked}>{persisted?'Сохранить':history?'Создать и применить правило':'Создать правило'}</button></>}>
  {draft.stale&&<p role="alert" className={operationStyles.fieldError}>Данные изменились. Откройте редактор заново.</p>}
  {serverError&&<p role="alert" className={operationStyles.fieldError}>{serverError}</p>}
  <form id={formId} onSubmit={e=>{e.preventDefault();submit();}}>
   <fieldset className={operationStyles.form} disabled={draft.locked}>
    <OperationField label="Название правила" error={errors.name}><input value={name} maxLength={160} onChange={e=>setValues(v=>({...v,name:e.target.value}))}/></OperationField>
    <div><OperationField label="Приоритет правила" error={errors.priority}><input value={priority} inputMode="text" aria-describedby={formId+'-priority'} onChange={e=>{const next=e.target.value.replace(/^−/,'-');if(/^-?\d*$/.test(next))setValues(v=>({...v,priority:next}));}}/></OperationField><small id={formId+'-priority'}>Сначала побеждает правило с большим числом условий. Если условий поровну, побеждает больший приоритет.</small></div>
    <fieldset className={operationStyles.ruleGroup} aria-invalid={!!errors.conditions||undefined}><legend>Условия: должны выполняться все</legend>{Object.keys(conditionNames).map(k=>control(k))}{problem('conditions')}</fieldset>
    <fieldset className={operationStyles.ruleGroup} aria-invalid={!!errors.assignments||undefined}><legend>Действия</legend>{Object.keys(actionNames).map(k=>control(k,true))}{problem('assignments')}</fieldset>
    {!persisted&&props.allowHistory!==false&&<label className={operationStyles.inlineCheck}><input type="checkbox" checked={history} onChange={e=>setValues(v=>({...v,history:e.target.checked}))}/>Применить к уже загруженным операциям</label>}
    {problem('form')}
   </fieldset>
  </form>
 </OperationDialog>;
}
function RuleHistory(props:EditorProps&{id:string;mode:'apply'|'delete'|'inspect'}){
 const draft=useSettingsDraft(props),s=draft.snapshot,rule=s.rules.find(r=>r.id===props.id)!,matching=ruleOperationIds(s,rule),[selected,setSelected]=useState<string[]>([]),available=rule.enabled&&rule.dependencyStatus!=='needs_setup';
 const title=props.mode==='delete'?'Удаление правила: '+rule.name:'Операции правила: '+rule.name;
 return <DraftFrame title={title} close={props.close} stale={draft.stale} error={draft.error}>{props.mode==='delete'?<><p>Правило будет удалено. Сохранённая классификация прошлых операций останется. Удаление доступно в истории и может быть отменено, пока нет зависимых изменений.</p><button className={common.primaryButton} disabled={draft.locked} onClick={()=>draft.submit(()=>({kind:'delete_rule',id:rule.id}),'Удалить правило «'+rule.name+'»')}>Показать последствия удаления правила</button></>:<><p>Условиям соответствуют: {matching.length} операций за всю историю. Общий фильтр периода сюда не применяется.</p><p>Для прошлых операций применяются все включённые правила с учётом конкретности и приоритета. Подтверждённые поля сохраняются; противоречия попадут в проверку. Классификация отдельных частей операции не изменится. Новые операции не добавятся в выбранный набор.</p>{!available&&<p>Правило выключено или требует настройки. Сначала исправьте его и включите.</p>}{props.mode==='apply'&&<><button className={common.button} disabled={draft.locked||!available||!matching.length||matching.length>1000} onClick={()=>setSelected([...matching])}>Выбрать все соответствующие операции</button><button className={common.button} disabled={draft.locked} onClick={()=>setSelected([])}>Снять выбор операций правила</button><p role="status">Выбрано для применения: {selected.length} из 1000 максимум.</p></>}<div className={styles.form}>{matching.map((id,i)=>{const op=s.operations.find(o=>o.id===id)!;return <label key={id}>{props.mode==='apply'&&<input aria-label={`Операция правила ${i+1}`} type="checkbox" disabled={draft.locked||!available||!selected.includes(id)&&selected.length>=1000} checked={selected.includes(id)} onChange={e=>setSelected(v=>e.target.checked?[...v,id]:v.filter(x=>x!==id))}/>} {operationName(s,id)} · {displayBankDate(op.date,'Europe/Moscow')} · {formatMoney(op.amountMinor)}</label>;})}</div>{props.mode==='apply'&&<button className={common.primaryButton} disabled={draft.locked||!available||!selected.length} onClick={()=>draft.submit(()=>({kind:'apply_rules',ruleId:rule.id,operationIds:[...selected]}),'Применить правила к выбранным прошлым операциям')}>Показать последствия применения правил</button>}</>}</DraftFrame>;
}
export function SettingsRules(props:Omit<EditorProps,'close'>&{commandState:CommandState}){
 const [editor,setEditor]=useState<{id:string|null;mode:'edit'|'apply'|'delete'|'inspect';serial:number}|null>(null);
 const open=(id:string|null,mode:'edit'|'apply'|'delete'|'inspect')=>setEditor({id,mode,serial:Date.now()});
 return <><p>Личные правила применяются к новым загрузкам. Разовая правка операции сама по себе не создаёт правило.</p><button className={common.primaryButton} disabled={props.disabled} onClick={()=>open(null,'edit')}>Создать персональное правило</button>{editor&&(editor.mode==='edit'?<RuleEditor key={editor.serial} {...props} id={editor.id} close={()=>setEditor(null)}/>:<RuleHistory key={editor.serial} {...props} id={editor.id!} mode={editor.mode} close={()=>setEditor(null)}/>)}{props.state.rules.length?props.state.rules.slice().sort((a,b)=>Object.keys(b.conditions).length-Object.keys(a.conditions).length||b.priority-a.priority||a.name.localeCompare(b.name,'ru')).map(r=><article key={r.id} className={styles.item}><h3>{r.name}</h3><p>{r.dependencyStatus==='needs_setup'?'Требуется настройка':r.enabled?'Включено':'Выключено'} · Личное правило · Приоритет {r.priority} · Условий {Object.keys(r.conditions).length}</p><div className={styles.actions}><button className={common.button} disabled={props.disabled} onClick={()=>open(r.id,'edit')}>Изменить правило: {r.name}</button><button className={common.button} disabled={props.disabled||r.dependencyStatus==='needs_setup'} onClick={()=>void props.command?.begin({kind:'rule',id:r.id,patch:{...rulePatch(r),enabled:!r.enabled},create:false},(r.enabled?'Выключить':'Включить')+' правило «'+r.name+'»',false,props.state)}>{r.enabled?'Выключить':'Включить'} правило: {r.name}</button><button className={common.button} disabled={props.disabled} onClick={()=>open(r.id,'inspect')}>Операции правила: {r.name}</button><button className={common.button} disabled={props.disabled||!r.enabled||r.dependencyStatus==='needs_setup'} onClick={()=>open(r.id,'apply')}>Применить к прошлым: {r.name}</button><button className={common.button} disabled={props.disabled} onClick={()=>open(r.id,'delete')}>Удалить правило: {r.name}</button></div></article>):<p>Личных правил пока нет. Можно создать правило до первой загрузки.</p>}<p className={styles.notice}>Повторяющиеся шаблоны и предложения AI ещё не подключены. Правило для конкретной операции можно создать из её меню.</p></>;
}
