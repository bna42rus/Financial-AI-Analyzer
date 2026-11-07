import {api} from './server-client';
import {foldSearch,SearchField} from './SearchFilter';
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
import layout from './Settings.module.css';
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
type CandidateRows={operationIds:string[];total:number;rows?:{id:string;date:Parameters<typeof displayBankDate>[0];amountMinor:string;name:string}[]};
function RuleHistory(props:EditorProps&{id:string;mode:'apply'|'delete'|'inspect';commandState:CommandState}){
 const draft=useSettingsDraft(props),s=draft.snapshot,rule=s.rules.find(r=>r.id===props.id)!,[candidates,setCandidates]=useState<CandidateRows|null>(null),[loadError,setLoadError]=useState(''),[selected,setSelected]=useState<string[]>([]),available=rule.enabled&&rule.dependencyStatus!=='needs_setup';
 const matching=candidates?.operationIds??[];
 useEffect(()=>{if(props.mode==='delete')return;const abort=new AbortController();
  void api<CandidateRows&{revision:string}>('/finance/rule-candidates',{ruleId:rule.id},abort.signal).then(r=>{if(abort.signal.aborted)return;if(r.revision!==s.revision)throw new Error('Данные изменились. Откройте правило заново.');setCandidates(r);}).catch(e=>{if(!abort.signal.aborted)setLoadError(e instanceof Error?e.message:'Не удалось загрузить операции.');});return()=>abort.abort();
 },[rule.id,s.revision,props.mode]);
 const title=props.mode==='delete'?'Удаление правила: '+rule.name:'Применить к загруженным операциям · '+rule.name;
 const forApply=props.mode==='apply',forDelete=props.mode==='delete',commandTitle='Применить правила к выбранным операциям';
 useEffect(()=>{if(draft.stale)props.close();},[draft.stale]);
 const footer=forDelete?<button className={common.dangerButton} disabled={draft.locked} onClick={()=>draft.submit(()=>({kind:'delete_rule',id:rule.id}),'Удалить правило «'+rule.name+'»')}>Продолжить</button>:forApply?<button className={common.primaryButton} disabled={draft.locked||!available||!selected.length} onClick={()=>draft.submit(()=>({kind:'apply_rules',ruleId:rule.id,operationIds:[...selected]}),commandTitle)}>Продолжить</button>:null;
 return <DraftFrame title={title} close={props.close} stale={draft.stale} error={draft.error||loadError||(props.commandState.title===commandTitle?props.commandState.error:'')} disabled={props.disabled} footer={footer}>{forDelete?<p>Правило перестанет работать на новых загрузках. Прошлые операции сохранятся.</p>:<>
  {candidates?<p>{candidates.total?'Подходящих операций: '+candidates.total+'.':'Нет операций, которые изменит это правило.'} {candidates.total>matching.length&&'За один раз можно изменить до 1 000 операций.'}</p>:!loadError&&<p role="status">Проверяем операции…</p>}{forApply&&!available&&<p>Сначала включите правило.</p>}
  {forApply&&<div className={layout.cardActions}><button className={common.button} disabled={draft.locked||!available||!matching.length||matching.length>1000} onClick={()=>setSelected([...matching])}>Выбрать все</button><button className={common.button} disabled={draft.locked||!selected.length} onClick={()=>setSelected([])}>Снять выбор</button><small role="status">Выбрано: {selected.length}</small></div>}
  {matching.length>0&&<div className={layout.reviewList}>{matching.map((id,i)=>{const op=s.operations.find(o=>o.id===id),candidate=candidates?.rows?.find(o=>o.id===id);return <label className={layout.checkboxRow} key={id}>{forApply&&<input aria-label={`Операция правила ${i+1}`} type="checkbox" disabled={draft.locked||!available||!selected.includes(id)&&selected.length>=1000} checked={selected.includes(id)} onChange={e=>setSelected(v=>e.target.checked?[...v,id]:v.filter(x=>x!==id))}/>}<span>{candidate?.name??operationName(s,id)}{(candidate??op)&&' · '+displayBankDate((candidate??op)!.date,'Europe/Moscow')+' · '+formatMoney((candidate??op)!.amountMinor)}</span></label>;})}</div>}
 </>}</DraftFrame>;
}
export function SettingsRules(props:Omit<EditorProps,'close'>&{commandState:CommandState}){
 const [editor,setEditor]=useState<{id:string|null;mode:'edit'|'apply'|'delete'|'inspect';serial:number}|null>(null);
 const [query,setQuery]=useState(''),[filter,setFilter]=useState('all');
 const visible=props.state.rules.filter(r=>foldSearch(r.name).includes(foldSearch(query))&&(filter==='all'||r.enabled===(filter==='on')));
 const open=(id:string|null,mode:'edit'|'apply'|'delete'|'inspect')=>setEditor({id,mode,serial:Date.now()});
 return <div className={layout.settingsStack}><div className={layout.listToolbar}><SearchField aria-label="Поиск правил" placeholder="Найти правило" value={query} onValueChange={setQuery}/><select aria-label="Статус правила" value={filter} onChange={e=>setFilter(e.target.value)} disabled={props.disabled}><option value="all">Все правила</option><option value="on">Включённые</option><option value="off">Выключенные</option></select><button className={common.primaryButton} disabled={props.disabled} onClick={()=>open(null,'edit')}>Создать правило</button></div>
 {editor&&(editor.mode==='edit'?<RuleEditor key={editor.serial} {...props} id={editor.id} close={()=>setEditor(null)}/>:<RuleHistory key={editor.serial} {...props} id={editor.id!} mode={editor.mode} close={()=>setEditor(null)}/>)}
 {visible.length?visible.sort((a,b)=>Object.keys(b.conditions).length-Object.keys(a.conditions).length||b.priority-a.priority||a.name.localeCompare(b.name,'ru')).map(r=><article key={r.id} className={layout.settingsBox}><div className={layout.settingsRow}><div><h3>{r.name}</h3><small>{r.dependencyStatus==='needs_setup'?'Требуется настройка · ':''}Приоритет {r.priority} · Условий {Object.keys(r.conditions).length}</small></div><label className={layout.checkboxRow}><input type="checkbox" role="switch" checked={r.enabled} disabled={props.disabled||r.dependencyStatus==='needs_setup'} onChange={()=>void props.command?.begin({kind:'rule',id:r.id,patch:{...rulePatch(r),enabled:!r.enabled},create:false},(r.enabled?'Выключить':'Включить')+' правило «'+r.name+'»',false,props.state)}/>Правило включено</label></div><div className={styles.actions}><button className={common.button} disabled={props.disabled} onClick={()=>open(r.id,'edit')} aria-label={'Изменить правило: '+r.name}>Изменить</button><button className={common.button} disabled={props.disabled||!r.enabled||r.dependencyStatus==='needs_setup'} onClick={()=>open(r.id,'apply')}>Применить к загруженным операциям</button><button className={common.dangerButton+' '+layout.trailingAction} disabled={props.disabled} onClick={()=>void props.command?.begin({kind:'delete_rule',id:r.id},'Удалить правило «'+r.name+'»?',true)}>Удалить</button></div></article>):<p className={layout.emptyState}>{props.state.rules.length?'Правила по этим условиям не найдены.':'Правил пока нет.'}</p>}</div>;
}
