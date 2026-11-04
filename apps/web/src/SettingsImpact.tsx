import {accountTypes,loanModes} from './SettingsAccounts';
import type {ImpactChange} from './finance-client';
import type {FinanceState} from './finance-client';
import {formatMoney} from './demo/overview';
import {roleNames} from './finance-client';
const labels:Record<string,string>={merge_accounts:'Объединение счетов',split_account:'Разделение счёта',merge_categories:'Объединение категорий',delete_category:'Удаление категории',migrate_category:'Перенос категории',merge_counterparties:'Объединение контрагентов',split_counterparty:'Разделение контрагента',delete_counterparty:'Удаление контрагента',delete_rule:'Удаление правила',apply_rules:'Применение правил к прошлым операциям'};
const array=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const rows=(v:unknown)=>array(v).filter((r):r is Record<string,unknown>=>!!r&&typeof r==='object');
export function SettingsImpact({details:d,finance:s,changes}:{changes?:ImpactChange[];details:{kind:string}&Record<string,unknown>;finance?:FinanceState|null}){
 if(d.kind==='account_settings'){
  const fields={display_name:'Название',account_type:'Тип счёта',analytics_enabled:'Участие в аналитике',loan_mode:'Учёт кредита'};
  const value=(key:keyof typeof fields,v:unknown)=>key==='account_type'?accountTypes[v as keyof typeof accountTypes]:key==='analytics_enabled'?(v?'Да':'Нет'):key==='loan_mode'?(loanModes[v as keyof typeof loanModes]??'Общая настройка'):String(v);
  return <section aria-label="Изменения счетов">{changes?.filter(c=>c.kind==='account'&&c.before&&c.after).map(c=><div key={c.id}><h3>{String(c.before!.values.display_name)}</h3><dl>{(Object.keys(fields) as (keyof typeof fields)[]).filter(k=>c.before!.values[k]!==c.after!.values[k]).map(k=><div key={k}><dt>{fields[k]}</dt><dd>{value(k,c.before!.values[k])} → {value(k,c.after!.values[k])}</dd></div>)}</dl></div>)}</section>;
 }
 if(d.kind==='restore_history'){
  const restored=changes?.filter(c=>c.kind==='account'&&c.before?.values.merged_into_id&&c.after?.values.merged_into_id===null)??[];
  const conflicts=array(d.conflicts);
  return <section aria-label="Последствия отмены">{conflicts.length?<p role="alert">Отмена недоступна: есть более поздние изменения или связанные данные.</p>:<dl>{restored.length>0&&<div><dt>Будут восстановлены счета</dt><dd>{restored.map(c=>c.after!.values.display_name).join(', ')}</dd></div>}{array(d.objects).length>0&&<div><dt>Изменятся записи</dt><dd>{array(d.objects).length}</dd></div>}</dl>}</section>;
 }
 if(['save_overview_view','delete_overview_view','reorder_overview_views'].includes(d.kind))return <section aria-label="Последствия настройки Обзора"><h3>Представление Обзора</h3><p>{d.kind==='delete_overview_view'?'Настройка представления будет удалена.':d.kind==='reorder_overview_views'?'Изменится порядок представлений.':'Сохраняется представление «'+String(d.name)+'». Виджетов: '+String(d.widgets)+'. Компьютер и телефон сохраняют отдельное расположение блоков.'}</p><p>Изменение записывается в историю. Его можно отменить 30 дней, пока нет конфликтующих новых решений.</p></section>;
 if(['save_budget','set_budget_limit','delete_budget'].includes(d.kind)){
  const change=changes?.find(c=>c.kind==='budget'),previous=change?.before?.values,next=change?.after?.values;
  const definition=d.definition as {basis?:string}|undefined;
  const initial=!change?.before&&d.kind==='save_budget';
  const limit=d.limitMinor??(initial?rows(d.limits).at(-1)?.limitMinor:undefined);
  const enabledChanged=initial||previous?.enabled!==next?.enabled;
  const definitionChanged=initial||JSON.stringify(previous?.definition)!==JSON.stringify(next?.definition);
  const nameChanged=!!previous&&!!next&&previous.name!==next.name;
  return <section aria-label="Последствия изменения бюджета">{d.kind==='delete_budget'?<p>Бюджет «{String(d.name)}» будет удалён. Операции сохранятся.</p>:<dl>
   {nameChanged&&<div><dt>Название</dt><dd>{String(previous.name)} → {String(next.name)}</dd></div>}
   {limit!==undefined&&<div><dt>Лимит</dt><dd>{formatMoney(String(limit))}{d.effectiveFrom?' с '+String(d.effectiveFrom):''}</dd></div>}
   {d.kind==='save_budget'&&enabledChanged&&<div><dt>Статус</dt><dd>{d.enabled?'Активен':'Приостановлен'}</dd></div>}
   {d.kind==='save_budget'&&definitionChanged&&<div><dt>Расходы</dt><dd>{definition?.basis==='gross'?'До возвратов':'За вычетом возвратов'}</dd></div>}
   {d.kind==='save_budget'&&definitionChanged&&!initial&&<div><dt>Условия расчёта</dt><dd>Обновятся</dd></div>}
  </dl>}</section>;
 }
 if(d.kind==='set_category_binding')return <section aria-label="Привязка категории"><h3>{d.removed?'Убрать привязку':'Своя категория'}</h3><p>{String(d.targetLabel)} → {d.removed?'Автоматический выбор по собственной структуре':s?.categories.find(c=>c.id===d.categoryId)?.name??'Выбранная категория'}{d.subcategoryId?' / '+(s?.categories.find(c=>c.id===d.subcategoryId)?.name??'Подкатегория'):''}</p><p>Применяется при следующих загрузках.</p></section>;
 if(d.kind==='merge_accounts'){
  const kept=String((d.canonicalSettings as {name?:string})?.name??'Выбранный счёт'),moved=array(d.sourceAccountIds).map(id=>s?.accounts.find(a=>a.id===id)?.name).filter(Boolean);
  return <section aria-label="Последствия настроек и правил"><dl><div><dt>Останется счёт</dt><dd>{kept}</dd></div>{moved.length>0&&<div><dt>Объединятся со счётом</dt><dd>{moved.join(', ')}</dd></div>}{Number(d.observationsMoved)>0&&<div><dt>Источники операций</dt><dd>{String(d.observationsMoved)}</dd></div>}{Number(d.aliasesMoved)>0&&<div><dt>Банковские привязки</dt><dd>{String(d.aliasesMoved)}</dd></div>}{array(d.rulesMoved).length>0&&<div><dt>Изменятся условия правил</dt><dd>{array(d.rulesMoved).length}</dd></div>}</dl></section>;
 }
 if(d.kind==='add_catalog_categories')return <section aria-label="Добавление категорий"><h3>Дополнительные категории</h3><ul>{rows(d.categoryDecisions).map((r,i)=><li key={i}>{String(r.label)} · {r.status==='create'?'Будет добавлена':r.status==='present'?'Используется существующая':r.status==='hidden'?'Пропущена: скрыта пользователем':'Пропущена: неоднозначная структура'}</li>)}</ul></section>;
 if(d.kind==='create_rule_with_history'){
  const matched=Number(d.selectedCount),changed=array(d.changedOperationIds).length,protectedCount=array(d.protectedOperationIds).length,conflicts=array(d.conflictingOperationIds).length;
  return <section aria-label="Правило и прошлые операции">{matched?<dl><div><dt>Подходят по условиям за всю историю</dt><dd>{matched}</dd></div><div><dt>Изменятся</dt><dd>{changed}</dd></div>{matched>changed&&<div><dt>Останутся без изменений</dt><dd>{matched-changed}</dd></div>}</dl>:<p>Среди прошлых операций совпадений нет.</p>}{protectedCount>0&&<p>У {protectedCount} операций сохранятся ручные решения.</p>}{conflicts>0&&<p>Конфликты правил требуют проверки: {conflicts}.</p>}</section>;
 }
 if(!(d.kind in labels))return null;
 const names=(ids:unknown)=>array(ids).map(id=>s?.accounts.find(a=>a.id===id)?.name??s?.categories.find(c=>c.id===id)?.name??s?.counterparties.find(p=>p.id===id)?.name??s?.rules.find(r=>r.id===id)?.name??'Карточка');
 const destination=(id:unknown)=>s?.accounts.find(a=>a.id===id)?.name??s?.counterparties.find(p=>p.id===id)?.name??rows(d.newAccounts??d.newParties).find(r=>r.id===id)?.name??(id===null?'Без контрагента':'Выбранная карточка');
 const movedRules=array(d.rulesMoved),setup=array(d.rulesNeedSetup),removed=names(d.sourceAccountIds??d.counterpartiesRedirected??d.categoriesRemoved??d.counterpartiesRemoved);
 return <section aria-label="Последствия настроек и правил"><h3>{labels[d.kind]}</h3>{!!d.canonicalSettings&&typeof d.canonicalSettings==='object'&&<p>Сохраняется карточка «{String((d.canonicalSettings as Record<string,unknown>).name??'Выбранная карточка')}» и её настройки.</p>}{removed.length>0&&<p>Объединяются или убираются карточки: {removed.join(', ')}.</p>}{d.observationsMoved!==undefined&&<p>Источников переносится: {String(d.observationsMoved)}. Банковских псевдонимов: {String(d.aliasesMoved??0)}.</p>}{d.aliasesRemoved!==undefined&&<p>Привязок псевдонимов будет удалено: {String(d.aliasesRemoved)}. Финансовые операции остаются.</p>}{movedRules.length>0&&<p>Переносится правил: {movedRules.length} · {names(movedRules).join(', ')}.</p>}{setup.length>0&&<p role="alert">Будет выключено правил до повторной настройки: {setup.length} · {names(setup).join(', ')}.</p>}{array(d.linkDependencies).length>0&&<p>Проверено зависимых связей: {array(d.linkDependencies).length}. Совместимость и итоги показаны в расчёте выше.</p>}{d.sourceFactsPreserved===true&&<p>Банковские оригиналы и прошлые версии источников сохранятся.</p>}{d.financialRolesUnchanged===true&&<p>Финансовый смысл операций сохранится.</p>}{d.financialOperationsDeleted===0&&<p>Финансовых операций будет удалено: 0.</p>}
 {array(d.operationDependencies).length>0&&<p>Операций с изменяемыми зависимостями, включая старые версии: {array(d.operationDependencies).length}. Частей: {array(d.componentDependencies).length}.</p>}
 {rows(d.roleDecisions).length>0&&<details><summary>Изменение финансового смысла зависимых записей</summary><ul>{rows(d.roleDecisions).map((r,i)=>{const op=s?.categoryOperations?.find(o=>o.id===r.id),part=s?.categoryComponents?.find(c=>c.id===r.id),active=s?.operations.find(o=>o.id===r.id),before=r.kind==='operation'?op?.role??active?.classification.role.value:part?.role;return <li key={i}>{r.kind==='operation'?'Операция':'Часть'} {i+1} · {op?.merchant??active?.classification.merchant.value??s?.categoryOperations?.find(o=>o.id===part?.transactionId)?.merchant??'Сохранённая запись'}: {roleNames[String(before)]??'Текущий смысл'} → {roleNames[String(r.role)]??'Выбранный смысл'}{op?.retired||part?.retired?' · Сохранённая старая версия':''}</li>;})}</ul></details>}
 {rows(d.categoriesChanged).length>0&&<details><summary>Структура категорий после изменения</summary><ul>{rows(d.categoriesChanged).map((c,i)=><li key={i}>{String(c.name)} · {c.role==='both'?'Расходы и доходы':roleNames[String(c.role)]} · {c.parentId===null?'Корневая':s?.categories.find(p=>p.id===c.parentId)?.name??'Выбранный родитель'}</li>)}</ul></details>}
 {rows(d.operations).length>0&&<details><summary>Распределение операций</summary><ul>{rows(d.operations).map((r,i)=><li key={i}>{s?.operations.find(o=>o.id===r.id)?.classification.merchant.value||`Операция ${i+1}`} → {String(destination(r.accountId??r.counterpartyId))}</li>)}</ul></details>}
 {(['observations','aliases'] as const).map(k=>rows(d[k]).length>0&&<details key={k}><summary>{k==='observations'?'Распределение источников':'Распределение банковских псевдонимов'} ({rows(d[k]).length})</summary><ul>{rows(d[k]).map((r,i)=><li key={i}>{k==='observations'?'Источник':'Псевдоним'} {i+1} → {String(destination(r.accountId??r.counterpartyId))}</li>)}</ul></details>)}
 {d.kind==='delete_rule'&&<p>Правило «{String(d.ruleName)}» перестанет работать на новых загрузках. Классификация прошлых операций сохранится; операций со ссылкой на это правило: {array(d.operationDependencies).length}.</p>}
 {d.kind==='apply_rules'&&<><p>Фиксированная выборка: {String(d.selectedCount)} операций. Изменятся: {array(d.changedOperationIds).length}. Применение атомарное; новые операции не добавляются.</p><p>Учитываются включённые правила: {names(d.ruleIds).join(', ')}. Ручные подтверждения и надёжный банковский тип сохраняются.</p><p>Операций с защищёнными ручными решениями: {array(d.protectedOperationIds).length}. Противоречий правил для проверки: {array(d.conflictingOperationIds).length}.</p><details><summary>Выбранные прошлые операции</summary><ul>{array(d.operationIds).map((id,i)=><li key={i}>{s?.operations.find(o=>o.id===id)?.classification.merchant.value||`Операция ${i+1}`}</li>)}</ul></details></>}
 <p>Изменение записывается в историю. Отмена доступна 30 дней, пока нет зависимых новых решений.</p></section>;
}
