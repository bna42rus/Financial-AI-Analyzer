import {useMutationNotice} from './Notifications';
import * as Dialog from '@radix-ui/react-dialog';
import {useRef} from 'react';
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
 return <section aria-label="Последствия отмены импорта"><p>Отменяемых файлов: {details.counts.files}. Физически удалится операций: {details.counts.operations}. Останутся благодаря другим источникам: {details.counts.sharedOperations}.</p>
 <p>Источников будет удалено: {details.counts.observations}. Частей операций: {details.counts.components}.</p><p>Связей для пересчёта: {details.counts.linksRecalculated}. Остановится строк выбранных файлов: {details.counts.pendingRows}.</p>
 {details.counts.manualEdits>0&&<p role="alert">Удаляемых операций с ручными правками: {details.counts.manualEdits}. Эти правки исчезнут вместе с операциями.</p>}
 {details.counts.analyzerChats!==undefined&&<p>Зависимых диалогов будет удалено: {details.counts.analyzerChats}.</p>}<p>Записей финансовой истории будет очищено: {details.counts.history}. Отмена необратима через Undo; восстановление — повторной загрузкой исходного файла. Пустые счета сохранятся.</p>
 {!!details.sourceRestorations.length&&<details><summary>Какие банковские данные восстановятся</summary><ul>{details.sourceRestorations.map((r,i)=><li key={r.operationId}>Операция {i+1}: {displayBankDate(r.before.operationDate,'Europe/Moscow')} · {formatMoney(r.before.amountMinor)} · {r.before.merchantText||r.before.description||'Без описания'} → {displayBankDate(r.after.operationDate,'Europe/Moscow')} · {formatMoney(r.after.amountMinor)} · {r.after.merchantText||r.after.description||'Без описания'}. Ручные правки сохранятся.</li>)}</ul></details>}
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
 return changed.length>0?<details className={styles.preview+' '+styles.bulkDetails} open={changed.length===1}><summary>Что изменится</summary><ul>{changed.map(({id,fields},i)=><li key={id}><strong>{maskedOperationText(operationNames.get(id)||'Операция '+(i+1))}</strong><dl>{fields.map(([name,value])=><div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></li>)}</ul></details>:null;
}
export function WorkspaceCommandPanel({state,command,finance}:{state:CommandState;command:WorkspaceCommand|null;finance?:FinanceState|null}){
 useMutationNotice(state,id=>void command?.undo(id),state.quietSuccess);
 const cancelRef=useRef<HTMLButtonElement>(null),previousFocus=useRef<HTMLElement|null>(null);
 const merge=state.preview?.impact.details?.kind==='merge_duplicate'?state.preview.impact.details as MergeDuplicateDetails:null;
 const rulePreview=state.preview?.impact.details?.kind==='create_rule_with_history';
 const details=state.preview?.impact.details;
 const rollbackBlocked=details?.kind==='restore_history'&&Array.isArray(details.conflicts)&&details.conflicts.length>0;
 const bulk=state.preview?.impact.details?.kind==='bulk_operations'?state.preview.impact.details as BulkDetails:null;
 return <section aria-label="Состояние изменения">
 {!state.preview&&state.error&&<p role="alert" className={common.error}>{state.error}</p>}{!state.preview&&state.phase==='sending'&&<p role="status" className={styles.srOnly}>Проверяем изменение…</p>}
 {!state.preview&&state.phase==='retry'&&<button className={common.primaryButton} onClick={()=>void command?.retry()}>Повторить то же изменение</button>}{state.phase==='stale'&&<button className={common.button} onClick={()=>void command?.reload()}>Обновить данные перед правкой</button>}
 {state.preview&&<Dialog.Root open onOpenChange={open=>{if(!open&&state.phase==='preview')command?.cancel();}}><Dialog.Portal><Dialog.Overlay className={common.overlay}/><Dialog.Content className={common.dialog+' '+styles.operationDialog+(rulePreview||state.preview.impact.details?.kind==='account_settings'||state.title==='Разъединить счета'||state.title==='Объединить счета'?' '+styles.subDialog:bulk?' '+styles.bulkConfirmation:'')} aria-describedby={undefined} onOpenAutoFocus={e=>{previousFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;e.preventDefault();cancelRef.current?.focus();}} onCloseAutoFocus={e=>{e.preventDefault();if(previousFocus.current?.isConnected)previousFocus.current.focus();}}><header className={common.dialogHead+' '+styles.operationHead}><Dialog.Title>{state.title}</Dialog.Title><button className={common.iconButton} disabled={state.phase!=='preview'} aria-label="Закрыть предварительный просмотр" onClick={()=>command?.cancel()}><X size={20} aria-hidden="true"/></button></header><div className={styles.operationBody}>{state.error&&<p role="alert" className={common.error}>{state.error}</p>}{state.phase==='retry'&&<button className={common.primaryButton} onClick={()=>void command?.retry()}>Повторить то же изменение</button>}{state.phase==='sending'&&<p role="status">Сохраняем подтверждённое изменение…</p>}<div className={styles.preview} aria-label="Последствия изменения">{!bulk&&state.preview.impact.details?.kind!=='create_rule_with_history'&&state.preview.impact.affectedOperationIds.length>0&&<p>Затронуто операций: {state.preview.impact.affectedOperationIds.length}.</p>}<dl>{[['Расходы',state.preview.impact.before.netExpensesMinor,state.preview.impact.after.netExpensesMinor],['Доходы',state.preview.impact.before.incomeMinor,state.preview.impact.after.incomeMinor],['Не определено',state.preview.impact.before.unresolvedMinor,state.preview.impact.after.unresolvedMinor]].filter(([,b,a])=>b!==a).map(([n,b,a])=><div key={n}><dt>{n}</dt><dd>{formatMoney(b!)} → {formatMoney(a!)}</dd></div>)}</dl>{state.preview.impact.dependencyConflicts.length>0&&<p>Связей для проверки: {state.preview.impact.dependencyConflicts.length}. Невозможные связи не участвуют в итогах.</p>}{bulk&&<section aria-label="Последствия массовой правки"><dl><div><dt>Выбрано операций</dt><dd>{bulk.selectedCount}</dd></div><div><dt>Изменятся</dt><dd>{state.preview.impact.affectedOperationIds.filter(id=>bulk.operationIds.includes(id)).length}</dd></div></dl>{bulk.warnings?.some(w=>w.code==='RELATED_RETURN_STILL_INCLUDED')&&<p role="alert">Связанное поступление останется в аналитике. Чтобы исключить его, выберите и эту операцию.</p>}</section>}{state.preview.impact.details&&<SettingsImpact details={state.preview.impact.details as {kind:string}&Record<string,unknown>} finance={finance} changes={state.preview.impact.changes}/>}
 {state.preview.impact.details?.kind==='cancel_import'&&<CancellationImpact details={state.preview.impact.details as CancelImportDetails}/>}{state.preview.impact.details?.kind==='duplicate_different'&&<p>Обе операции останутся. Решение будет сохранено, и эта пара больше не появится среди возможных дублей без нового основания.</p>}{merge&&<section aria-label="Последствия объединения"><p>В расчёте останется одна операция. Источников сохранится: {merge.sourcesPreserved}. Старых ID будет связано с ней: {merge.mapping.length}.</p><p>Частей останется: {merge.componentsKept}; других частей в расчёте не будет: {merge.componentsRetired}. Связей перенесётся: {merge.linksMoved.length}; явно уберётся вместе с зависимыми: {merge.linksDropped.length}.</p>{!!merge.conflicts.length&&<div role="alert"><p>Объединение пока нельзя применить. Нажмите «Не применять», выберите значения или исправьте связи и проверьте снова.</p><ul>{merge.conflicts.map((c,i)=><li key={i}>{mergeFieldNames[c.field]??'Зависимость'}: {c.reason?({SELF_LINK:'Связь замкнётся на той же операции',COMPONENT_SUM_CONFLICT:'Сумма частей не совпадает с выбранной суммой',CATEGORY_ROLE_CONFLICT:'Категория не подходит финансовому смыслу'}[c.reason]??'Связь несовместима с выбранными данными'):'Выберите ручное значение'}</li>)}</ul></div>}<p>Отмена доступна через историю 30 дней, пока сохранены источники и нет новых изменений.</p></section>}</div>{bulk&&<BulkChanges details={bulk} finance={finance} changes={state.preview.impact.changes}/>}</div><footer className={styles.operationFooter}><button ref={cancelRef} className={common.button} disabled={state.phase!=='preview'} onClick={()=>command?.cancel()}>Не применять</button><button className={common.primaryButton} disabled={state.phase!=='preview'||rollbackBlocked||!!merge?.conflicts.length||!!bulk&&!state.preview.impact.affectedOperationIds.length&&!state.preview.impact.changes?.length} onClick={()=>void command?.confirm()}>{state.preview.impact.details?.kind==='cancel_import'?'Подтвердить отмену импорта':merge?'Подтвердить объединение':bulk?'Применить массовую правку':state.preview.impact.details?.kind==='create_rule_with_history'?'Создать и применить':'Применить изменение'}</button></footer></Dialog.Content></Dialog.Portal></Dialog.Root>}
 </section>;
}
