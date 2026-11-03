import {useState} from 'react';
import {operationFilterKinds,searchExpressionError} from '../../../packages/finance-core/src/operations';
import type {OperationsFilter} from '../../../packages/finance-core/src/operations';
import type {FinanceState} from './finance-client';
import {kindNames,roleNames,reviewNames,reviewStatusNames,rublesToMinor,minorToRubles} from './finance-client';
import {metricNames} from '../../../packages/finance-core/src/overview';
import {sourceNames} from './operations-client';
import {OverviewPopover} from './OverviewDialogs';
import {WidgetSelect} from './WidgetSelect';
import filterStyles from './CompactFilters.module.css';
import styles from './OperationsTable.module.css';
const kindOrder=['purchase','refund','expense_reimbursement','reversal','cashback','transfer_in','transfer_out','own_transfer','cash_deposit','cash_withdrawal','loan_disbursement','loan_payment','credit_card_repayment','interest','fee','insurance','other'];
const facets:[string,string][]=[['kind','Тип'],['role','Финансовый смысл'],['category','Категория'],['subcategory','Подкатегория'],['merchant','Магазин'],['counterparty','Контрагент']];
const advancedKeys=['reasons','statuses','attention','uncategorized','refund','transfer','linked','possibleDuplicate','inclusion','kinds','roles','amountFrom','amountThrough','amountBasis','description','merchant','merchantExact','comment','facets','sources','confidenceFrom','confidenceThrough','ruleIds','counterpartyIds'] as const;
export function advancedOperationFilters(f:OperationsFilter):OperationsFilter {
 const next=Object.fromEntries(advancedKeys.filter(k=>f[k]!==undefined).map(k=>[k,f[k]])) as OperationsFilter;
 if(!next.reasons&&f.reason)next.reasons=[f.reason];
 if(!next.statuses&&f.status)next.statuses=[f.status] as OperationsFilter['statuses'];
 if(!next.kinds&&f.kind)next.kinds=[f.kind] as OperationsFilter['kinds'];
 if(f.refund!==undefined||f.transfer!==undefined){
  const refunds=['refund','expense_reimbursement','reversal'],transfers=['transfer_in','transfer_out','own_transfer'];
  const permitted=(next.kinds??operationFilterKinds).filter(k=>(f.refund===undefined||refunds.includes(k)===f.refund)&&(f.transfer===undefined||transfers.includes(k)===f.transfer));
  if(permitted.length){next.kinds=permitted;delete next.refund;delete next.transfer;}
 }

 if(!next.roles&&f.role)next.roles=[f.role] as OperationsFilter['roles'];
 if(!next.facets&&f.facet)next.facets=[f.facet];
 if(!next.sources&&f.source)next.sources=[f.source] as OperationsFilter['sources'];
 if(!next.ruleIds&&f.ruleId)next.ruleIds=[f.ruleId];
 return next;
}
export function invalidAdvancedFilter(value:OperationsFilter){return ['description','merchant','comment'].some(k=>!!(k!=='merchant'||!value.merchantExact)&&!!searchExpressionError(value[k as 'description'|'merchant'|'comment']));}
function Multiple({label,options,value,onChange,disabled}:{label:string;options:[string,string][];value:string[];onChange:(values:string[])=>void;disabled:boolean}){
 const [search,setSearch]=useState('');
 return <div className={styles.multiField}><span>{label}</span><OverviewPopover label={label} triggerText={value.length>1?'Выбрано несколько':value.length?options.find(([id])=>id===value[0])?.[1]??'Недоступное значение':'Любое значение'} triggerClassName={styles.filterPick} disabled={disabled} toolbar={<div className={filterStyles.searchRow}>
 <input type="search" aria-label={'Найти: '+label} placeholder="Найти" value={search} onChange={e=>setSearch(e.target.value)}/>
 <button type="button" className={filterStyles.clear} onClick={()=>{onChange([]);setSearch('');}}>Сбросить</button></div>}>
 {options.filter(([,name])=>name.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru'))).map(([id,name])=><label key={id} className={filterStyles.choice+' '+styles.normalChoice}><input type="checkbox" checked={value.includes(id)} onChange={e=>onChange(e.target.checked?[...value,id]:value.filter(v=>v!==id))}/><span>{name}</span></label>)}
 </OverviewPopover></div>;
}
type NumericKey='amountFrom'|'amountThrough'|'confidenceFrom'|'confidenceThrough';
export function OperationsFilters({state,value,contextFilter,onChange,disabled,onInvalid}:{state:FinanceState;value:OperationsFilter;contextFilter?:OperationsFilter;onChange:(v:OperationsFilter)=>void;disabled:boolean;onInvalid:(invalid:boolean)=>void}){
 const [raw,setRaw]=useState<Partial<Record<NumericKey,string>>>({}),[errors,setErrors]=useState<Partial<Record<NumericKey,string>>>({});
 function change(key:keyof OperationsFilter,v:unknown){const next={...value};if(key==='merchant')delete next.merchantExact;if(key==='kinds'){delete next.refund;delete next.transfer;}if(v===''||v===undefined||Array.isArray(v)&&!v.length)delete next[key];else Object.assign(next,{[key]:v});onChange(next);}
 function number(key:NumericKey,text:string,commit:boolean){
  if(commit&&raw[key]===undefined)return;
  const values={...raw,[key]:text};
  const next={...value},problems:typeof errors={};
  for(const [k,v] of Object.entries(values) as [NumericKey,string][]){try{
   if(!v.trim())delete next[k];
   else if(k.startsWith('amount'))Object.assign(next,{[k]:rublesToMinor(v)});
   else if(!/^\d{1,3}$/.test(v)||Number(v)>100)problems[k]='Введите целое число от 0 до 100.';
   else Object.assign(next,{[k]:Number(v)});
  }catch{problems[k]='Укажите сумму с точностью до копеек.';}}
  if(!problems.amountFrom&&!problems.amountThrough&&next.amountFrom!==undefined&&next.amountThrough!==undefined&&BigInt(next.amountFrom)>BigInt(next.amountThrough))problems[key.startsWith('amount')?key:'amountThrough']='Нижняя граница выше верхней.';
  if(!problems.confidenceFrom&&!problems.confidenceThrough&&next.confidenceFrom!==undefined&&next.confidenceThrough!==undefined&&next.confidenceFrom>next.confidenceThrough)problems[key.startsWith('confidence')?key:'confidenceThrough']='Нижняя граница выше верхней.';
  setRaw(values);setErrors(problems);onInvalid(!!Object.keys(problems).length);
  if(commit&&!Object.keys(problems).length){onChange(next);setRaw({});}
 }
 const select=(key:keyof OperationsFilter,name:string,items:[string,string][])=> <label>{name}<WidgetSelect aria-label={name} value={String(value[key]??'')} onChange={e=>change(key,e.target.value)}><option value="">Любое значение</option>{items.map(([id,n])=><option key={id} value={id}>{n}</option>)}</WidgetSelect></label>;
 const summaries:{name:string;labels:string[]}[]=[];
 const context=contextFilter;
 if(value.refund!==undefined||value.transfer!==undefined)summaries.push({name:'Тип операции',labels:['Условия старого представления несовместимы. Выберите тип заново.']});
 if(context?.metric)summaries.push({name:'Показатель из Обзора',labels:[metricNames[context.metric]]});
 if(context?.operationIds)summaries.push({name:'Заданный набор операций',labels:[String(context.operationIds.length)]});
 if(context?.batchId)summaries.push({name:'Источник',labels:[context.fileId?'Выбранный файл загрузки':'Выбранная загрузка']});
 if(context?.subcategoryIds)summaries.push({name:'Подкатегории',labels:context.subcategoryIds.map(id=>state.categories.find(c=>c.id===id)?.name??'Недоступная подкатегория')});
 if(context?.excludedCategoryIds)summaries.push({name:'Исключённые категории',labels:context.excludedCategoryIds.map(id=>state.categories.find(c=>c.id===id)?.name??'Недоступная категория')});
 if(context?.noSubcategory)summaries.push({name:'Подкатегория',labels:['Без подкатегории']});
 if(context?.noCounterparty)summaries.push({name:'Контрагент',labels:['Без контрагента']});
 const multi=(key:'reasons'|'statuses'|'kinds'|'roles'|'facets'|'sources'|'ruleIds'|'counterpartyIds',name:string,options:[string,string][])=>{const selected=value[key]??[];if(selected.length>1)summaries.push({name,labels:selected.map(id=>options.find(([v])=>v===id)?.[1]??'Недоступное значение')});return <Multiple label={name} options={options} value={selected} onChange={v=>change(key,v)} disabled={disabled}/>;};
 const flag=(key:'attention'|'uncategorized'|'refund'|'transfer'|'linked'|'possibleDuplicate',label:string)=> <label>{label}<WidgetSelect aria-label={label} disabled={disabled} value={String(value[key]??'')} onChange={e=>change(key,e.target.value===''?undefined:e.target.value==='true')}><option value="">Любое значение</option><option value="true">Да</option><option value="false">Нет</option></WidgetSelect></label>;
 const inputNumber=(key:NumericKey,label:string,accessibleName=label)=>{const v=value[key];return <label>{label}<input aria-label={accessibleName} aria-invalid={!!errors[key]||undefined} inputMode={key.startsWith('amount')?'decimal':'numeric'} value={raw[key]??(v===undefined?'':key.startsWith('amount')?minorToRubles(String(v)):String(v))} onChange={e=>number(key,e.target.value,false)} onBlur={e=>number(key,e.target.value,true)}/>{errors[key]&&<small role="alert">{errors[key]}</small>}</label>;};
 const field=(key:'description'|'merchant'|'comment',label:string)=>{const message=key==='merchant'&&value.merchantExact?undefined:searchExpressionError(value[key]);return <label>{label}<input maxLength={key==='comment'?1000:160} aria-invalid={!!message||undefined} value={value[key]??''} onChange={e=>change(key,e.target.value)}/>{message&&<small role="alert">{message}</small>}</label>;};
 const reasons=[...new Set([...Object.keys(reviewNames),...state.operations.flatMap(o=>o.reviewReasons)])];
 return <details className={styles.options}><summary>Дополнительные фильтры{Object.keys(value).length>0&&<small> · {Object.keys(value).length}</small>}</summary>
 <fieldset disabled={disabled} className={styles.advanced}><legend className={filterStyles.srOnly}>Дополнительные фильтры операций</legend>
 {multi('statuses','Состояние проверки',Object.entries(reviewStatusNames))}{multi('reasons','Причина проверки',reasons.map(r=>[r,reviewNames[r]??r]))}
 {multi('kinds','Тип операции',kindOrder.map(k=>[k,k==='expense_reimbursement'?'Компенсация расхода':kindNames[k]??k]))}{multi('roles','Финансовый смысл',Object.entries(roleNames))}
 {inputNumber('amountFrom','Сумма от, ₽','Сумма фильтра от, ₽')}{inputNumber('amountThrough','Сумма до, ₽','Сумма фильтра до, ₽')}
 {field('description','Описание операции содержит')}{field('merchant','Магазин содержит')}{field('comment','Комментарий содержит')}
 {multi('counterpartyIds','Контрагенты',state.counterparties.map(p=>[p.id,p.name]))}
 {multi('facets','Поле классификации',facets)}{multi('sources','Источник классификации',Object.entries(sourceNames))}
 {inputNumber('confidenceFrom','Уверенность от, %')}{inputNumber('confidenceThrough','Уверенность до, %')}
 {multi('ruleIds','Применённое правило',state.rules.map(r=>[r.id,r.name]))}{select('inclusion','Участие в аналитике',[['included','Включено'],['excluded','Исключено']])}
  {flag('attention','Требуют внимания')}{flag('uncategorized','Без категории')}

 {(value.linked!==undefined||value.possibleDuplicate!==undefined)&&<>{flag('linked','Есть связь')}{flag('possibleDuplicate','Возможный дубль')}</>}
 {summaries.length>0&&<dl className={styles.filterSummary}>{summaries.map(({name,labels})=><div key={name}><dt>{name}</dt><dd>{labels.join(', ')}</dd></div>)}</dl>}
 <p>В поиске & означает «и», | — «или». Например: такси & аэропорт | поезд.</p>
 <button type="button" className={filterStyles.reset} onClick={()=>{setRaw({});setErrors({});onInvalid(false);onChange({});}}>Сбросить дополнительные фильтры</button>
 </fieldset></details>;
}
