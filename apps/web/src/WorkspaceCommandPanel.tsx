import {useMutationNotice} from './Notifications';
import * as Dialog from '@radix-ui/react-dialog';
import {useRef,useState} from 'react';
import {X} from 'lucide-react';
import {SettingsImpact} from './SettingsImpact';
import type {CommandState,WorkspaceCommand} from './workspace-command';
import {formatMoney} from './demo/overview';
import {displayBankDate} from './finance-client';
import type {CancelImportDetails,MergeDuplicateDetails,BulkDetails,FinanceState,ImpactChange} from './finance-client';
import {kindNames,roleNames} from './finance-client';
import {maskedOperationText} from './operation-display';
import {mergeFieldNames} from './DuplicateMerge';
import common from './App.module.css';
import styles from './ServerOperation.module.css';
function CancellationImpact({details}:{details:CancelImportDetails}){
 const c=details.counts,rows:[string,number|undefined][]=[['Файлы',c.files],['Операции к удалению',c.operations],['Операции, которые останутся по другим выпискам',c.sharedOperations],['Части операций',c.components],['Банковские записи',c.observations],['Связи к пересчёту',c.linksRecalculated],['Строки, обработка которых остановится',c.pendingRows],['Диалоги к удалению',c.analyzerChats],['Записи истории к удалению',c.history]];
 return <section aria-label="Последствия отмены импорта" className={styles.impactStack}><div><h3>Что изменится</h3><dl>{rows.filter(([,n])=>!!n).map(([label,n])=><div key={label}><dt>{label}</dt><dd>{n}</dd></div>)}</dl></div>
  {!!details.sourceRestorations.length&&<details><summary>Какие операции возьмут данные из другой выписки</summary><p>Операции останутся. Дата, сумма или описание будут взяты из оставшейся выписки. Ручные правки сохранятся.</p><ul>{details.sourceRestorations.map(r=><li key={r.operationId}>{displayBankDate(r.before.operationDate,'Europe/Moscow')} · {formatMoney(r.before.amountMinor)} · {r.before.merchantText||r.before.description||'Без описания'} → {displayBankDate(r.after.operationDate,'Europe/Moscow')} · {formatMoney(r.after.amountMinor)} · {r.after.merchantText||r.after.description||'Без описания'}</li>)}</ul></details>}
  <p className={styles.impactWarning}>{c.manualEdits>0&&<>Ручные правки в {c.manualEdits} удаляемых операциях исчезнут. </>}Вернуть загрузку через историю нельзя. Чтобы загрузить данные снова, выберите исходный файл.</p>
 </section>;
}
function BulkChanges({details,finance,changes}:{details:BulkDetails;finance?:FinanceState|null;changes?:ImpactChange[]}){
 const names:Record<string,string>={kind:'Тип',role:'Финансовый смысл',category:'Категория',subcategory:'Подкатегория',counterparty:'Контрагент',comment:'Комментарий',analytics_override:'Участие в аналитике',review_reasons:'Проверка'};
 const display=(k:string,v:unknown)=>k==='kind'?kindNames[String(v)]:k==='role'?roleNames[String(v)]:k==='category'?finance?.categories.find(c=>c.id===v)?.name??'Без категории':k==='subcategory'?finance?.categories.find(c=>c.id===v)?.name??'Без подкатегории':k==='counterparty'?finance?.counterparties.find(c=>c.id===v)?.name??'Без контрагента':k==='analytics_override'?({default:'По настройке счёта',include:'Включено',exclude:'Исключено'}[String(v)]??'По настройке счёта'):k==='review_reasons'?(Array.isArray(v)&&v.length?'Есть причины проверки':'Нет причин проверки'):String(v||'Нет');
 const operationNames=new Map(finance?.operations.map(o=>[o.id,o.displayName?.compositeLabel||o.classification.merchant.value]));
 const selected=new Set(details.operationIds);
 const changed=(changes??[]).flatMap(c=>{
  if(c.kind!=='operation'||!selected.has(c.id)||!c.before||!c.after)return [];
  const before=c.before.values,after=c.after.values,b=before.semantics as Record<string,{value:unknown;userVerified:boolean}>,a=after.semantics as typeof b;
  const fields=Object.keys(names).flatMap(k=>{
   if(a?.[k]&&b?.[k]){
    if(a[k]!.value!==b[k]!.value)return [[names[k],display(k,b[k]!.value)+' → '+display(k,a[k]!.value)]];
    if(a[k]!.userVerified&&!b[k]!.userVerified)return [[names[k],display(k,a[k]!.value)+' · будет подтверждено']];
    return [];
   }
   if(!Object.hasOwn(after,k)||JSON.stringify(after[k])===JSON.stringify(before[k]))return [];
   if(k==='review_reasons'){
    const previous=Array.isArray(before[k])?before[k]:[],next=Array.isArray(after[k])?after[k]:[];
    if(previous.includes('user_requested_review')!==next.includes('user_requested_review'))return [[names[k],next.includes('user_requested_review')?'Будет добавлена отметка о проверке':'Отметка о проверке будет снята']];
    return [[names[k],next.length?'Изменятся причины проверки':'Причин проверки не останется']];
   }
   return [[names[k],display(k,before[k])+' → '+display(k,after[k])]];
  });
  return fields.length?[{id:c.id,fields}]:[];
 });
 return changed.length>0?<details className={styles.bulkDetails}><summary>Подробнее</summary><ul>{changed.map(({id,fields},i)=><li key={id}><strong>{maskedOperationText(operationNames.get(id)||'Операция '+(i+1))}</strong><dl>{fields.map(([name,value])=><div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></li>)}</ul></details>:null;
}
export function WorkspaceCommandPanel({state,command,finance}:{state:CommandState;command:WorkspaceCommand|null;finance?:FinanceState|null}){
 useMutationNotice(state,id=>void command?.undo(id),state.quietSuccess);
 const cancelRef=useRef<HTMLButtonElement>(null),previousFocus=useRef<HTMLElement|null>(null);
 const [returnsToEditor,setReturnsToEditor]=useState(false);
 const merge=state.preview?.impact.details?.kind==='merge_duplicate'?state.preview.impact.details as MergeDuplicateDetails:null;
 const rulePreview=state.preview?.impact.details?.kind==='create_rule_with_history';
 const details=state.preview?.impact.details;
 const inlineError=state.title==='Применить правила к выбранным операциям';
 const rollbackBlocked=details?.kind==='restore_history'&&Array.isArray(details.conflicts)&&details.conflicts.length>0;
 const transfer=details?.kind==='transfer_counterparty_operations';
 const ruleApply=details?.kind==='apply_rules';
 const plain=['merge_counterparties','transfer_counterparty_operations','delete_counterparty','delete_rule','delete_budget','restore_history'].includes(details?.kind??'');
 const bulk=details?.kind==='bulk_operations'?details as BulkDetails:null;
 const analytics=state.preview?.impact.changes?.find(c=>c.kind==='analytics');
 const loanMode=(v:unknown)=>v==='economic'?'В расходах только проценты, комиссии и страховка':'В расходах весь платёж';
 const totals=state.preview?([['Расходы',state.preview.impact.before.netExpensesMinor,state.preview.impact.after.netExpensesMinor],['Доходы',state.preview.impact.before.incomeMinor,state.preview.impact.after.incomeMinor],['Не определено',state.preview.impact.before.unresolvedMinor,state.preview.impact.after.unresolvedMinor]] as const).filter(([,before,after])=>before!==after):[];
 const affected=bulk?state.preview!.impact.affectedOperationIds.filter(id=>bulk.operationIds.includes(id)).length:state.preview?.impact.affectedOperationIds.length??0;
 const labels:Record<string,string>={cancel_import:'Отменить загрузку',merge_categories:'Объединить категории',migrate_category:'Сохранить изменения',delete_category:'Удалить категорию',merge_counterparties:'Объединить контрагентов',split_counterparty:'Разделить контрагента',delete_counterparty:'Удалить карточку',merge_accounts:'Объединить счета',split_account:'Разъединить счета',account_settings:'Сохранить настройки',delete_rule:'Удалить правило',apply_rules:'Применить правило',create_rule_with_history:'Создать и применить',save_budget:'Сохранить бюджет',set_budget_limit:'Изменить лимит',delete_budget:'Удалить бюджет',reset_categories:'Восстановить категории',restore_history:'Отменить изменение',delete_overview_view:'Удалить представление',delete_operations_view:'Удалить представление',save_overview_view:'Сохранить представление',add_catalog_categories:'Добавить категории',set_category_binding:'Сохранить привязку',duplicate_different:'Сохранить обе операции'};
 const actionLabel=analytics?'Изменить учёт':merge?'Объединить операции':transfer?'Перенести операции':state.title==='Исключение операций'?'Исключить операции':state.title==='Привязать операции к контрагенту'?'Привязать операции':labels[details?.kind??'']??(bulk?'Изменить операции':'Сохранить');
 const destructive=['delete_category','delete_rule','delete_budget','delete_counterparty','delete_overview_view','delete_operations_view','reset_categories','cancel_import'].includes(details?.kind??'');
 return <section aria-label="Состояние изменения">
 {!state.preview&&!inlineError&&state.error&&<p role="alert" className={common.error}>{state.error}</p>}{!state.preview&&state.phase==='sending'&&<p role="status" className={styles.srOnly}>Проверяем изменение…</p>}
 {!state.preview&&state.phase==='retry'&&<button className={common.primaryButton} onClick={()=>void command?.retry()}>Повторить то же изменение</button>}{state.phase==='stale'&&<button className={common.button} onClick={()=>void command?.reload()}>Обновить данные перед правкой</button>}
 {state.preview&&<Dialog.Root open onOpenChange={open=>{if(!open&&state.phase==='preview')command?.cancel();}}><Dialog.Portal><Dialog.Overlay data-cashneuro-dialog="overlay" className={common.overlay}/><Dialog.Content data-cashneuro-dialog="content" className={common.dialog+' '+styles.operationDialog+(rulePreview||['account_settings','set_budget_limit','save_budget','delete_budget','reset_categories','cancel_import','restore_history'].includes(details?.kind??'')||state.title==='Разъединить счета'||state.title==='Объединить счета'?' '+styles.subDialog:bulk?' '+styles.bulkConfirmation:'')} aria-describedby={undefined} onOpenAutoFocus={e=>{previousFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setReturnsToEditor(document.querySelectorAll('[data-cashneuro-dialog="content"]').length>1);e.preventDefault();cancelRef.current?.focus();}} onCloseAutoFocus={e=>{e.preventDefault();if(previousFocus.current?.isConnected)previousFocus.current.focus();}}><header className={common.dialogHead+' '+styles.operationHead}><Dialog.Title>{state.title}</Dialog.Title><button className={common.iconButton} disabled={state.phase!=='preview'} aria-label="Закрыть предварительный просмотр" onClick={()=>command?.cancel()}><X size={20} aria-hidden="true"/></button></header><div className={styles.operationBody}>{state.error&&<p role="alert" className={common.error}>{state.error}</p>}{state.phase==='retry'&&<button className={common.primaryButton} onClick={()=>void command?.retry()}>Повторить то же изменение</button>}{state.phase==='sending'&&<p role="status">Сохраняем подтверждённое изменение…</p>}<div className={styles.plainPreview} aria-label="Последствия изменения">
 {analytics?.before&&analytics.after&&<dl className={styles.delta}><div><dt>Сейчас</dt><dd>{loanMode(analytics.before.values.loan_mode)}</dd></div><div><dt>После изменения</dt><dd>{loanMode(analytics.after.values.loan_mode)}</dd></div></dl>}
 {details?.kind==='account_settings'&&<SettingsImpact details={details} finance={finance} changes={state.preview.impact.changes}/>}
 {!plain&&!ruleApply&&(totals.length>0||affected>0&&details?.kind!=='create_rule_with_history')&&<dl className={styles.delta}>{totals.map(([label,before,after])=><div key={label}><dt>{label}</dt><dd>{formatMoney(before)} → {formatMoney(after)}</dd></div>)}{affected>0&&details?.kind!=='create_rule_with_history'&&<div><dt>Затронутые операции</dt><dd>{affected}</dd></div>}</dl>}
{state.preview.impact.dependencyConflicts.length>0&&<p>Связей для проверки: {state.preview.impact.dependencyConflicts.length}. Невозможные связи не участвуют в итогах.</p>}{bulk&&('ruleName'in bulk||bulk.warnings?.some(w=>w.code==='RELATED_RETURN_STILL_INCLUDED'))&&<section aria-label="Последствия массовой правки">{'ruleName'in bulk&&<p>Для будущих операций будет создано правило «{String(bulk.ruleName)}».</p>}{bulk.warnings?.some(w=>w.code==='RELATED_RETURN_STILL_INCLUDED')&&<p role="alert">Связанное поступление останется в аналитике. Чтобы исключить его, выберите и эту операцию.</p>}</section>}{state.preview.impact.details&&details?.kind!=='account_settings'&&<SettingsImpact details={state.preview.impact.details as {kind:string}&Record<string,unknown>} finance={finance} changes={state.preview.impact.changes} subjectId={state.preview.intent?.id}/>}
 {details?.kind==='reset_categories'&&<section className={styles.impactPanel}><p>Пользовательские категории будут удалены. Операции сохранятся; удалённые категории будут сняты с операций.</p><dl className={styles.delta}>{([['Добавятся',details.created],['Удалятся',details.removed],['Станут видимыми',details.unhidden]] as const).filter(([,names])=>Array.isArray(names)&&names.length).map(([label,names])=><div key={label}><dt>{label}</dt><dd>{(names as string[]).join(', ')}</dd></div>)}</dl></section>}
 {state.preview.impact.details?.kind==='cancel_import'&&<CancellationImpact details={state.preview.impact.details as CancelImportDetails}/>}{state.preview.impact.details?.kind==='duplicate_different'&&<p>Обе операции останутся. Решение будет сохранено, и эта пара больше не появится среди возможных дублей без нового основания.</p>}{merge&&<section aria-label="Последствия объединения"><p>В расчёте останется одна операция. Источников сохранится: {merge.sourcesPreserved}. Старых ID будет связано с ней: {merge.mapping.length}.</p><details><summary>Подробнее</summary><p>Частей останется: {merge.componentsKept}. Других частей в расчёте не будет: {merge.componentsRetired}. Связей перенесётся: {merge.linksMoved.length}. Уберётся вместе с зависимыми: {merge.linksDropped.length}.</p><p>Отмена доступна через историю 30 дней, пока сохранены источники и нет новых изменений.</p></details>{!!merge.conflicts.length&&<div role="alert"><p>Объединение пока нельзя применить. Закройте подтверждение, выберите значения или исправьте связи и проверьте снова.</p><ul>{merge.conflicts.map((c,i)=><li key={i}>{mergeFieldNames[c.field]??'Зависимость'}: {c.reason?({SELF_LINK:'Связь замкнётся на той же операции',COMPONENT_SUM_CONFLICT:'Сумма частей не совпадает с выбранной суммой',CATEGORY_ROLE_CONFLICT:'Категория не подходит финансовому смыслу'}[c.reason]??'Связь несовместима с выбранными данными'):'Выберите ручное значение'}</li>)}</ul></div>}</section>}</div>{bulk&&<BulkChanges details={bulk} finance={finance} changes={state.preview.impact.changes}/>} {ruleApply&&<BulkChanges details={{operationIds:Array.isArray(details.changedOperationIds)?details.changedOperationIds as string[]:[]} as BulkDetails} finance={finance} changes={state.preview.impact.changes}/>}</div><footer className={styles.operationFooter}><button ref={cancelRef} className={common.button} disabled={state.phase!=='preview'} onClick={()=>command?.cancel()}>{rollbackBlocked?'Закрыть':returnsToEditor||merge?'Назад':'Отмена'}</button>{!rollbackBlocked&&<button className={destructive?common.dangerButton:common.primaryButton} disabled={state.phase!=='preview'||!!merge?.conflicts.length||!!bulk&&!state.preview.impact.affectedOperationIds.length&&!state.preview.impact.changes?.length} onClick={()=>void command?.confirm()}>{actionLabel}</button>}</footer></Dialog.Content></Dialog.Portal></Dialog.Root>}
 </section>;
}
