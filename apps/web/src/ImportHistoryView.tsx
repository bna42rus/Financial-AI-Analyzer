import type {ImportHistory,ImportReport,RowCounts,TransactionCounts} from '../../../packages/imports/src/report';
import {SearchFilter} from './SearchFilter';
import {bankNames} from './finance-client';
import type {FinanceState} from './finance-client';
import common from './App.module.css';
import styles from './ServerFinance.module.css';
import layout from './Settings.module.css';

const labels={accepted:'Ожидает обработки',processing:'Обрабатывается',completed:'Завершена',partial:'Завершена с ошибками',invalidated:'Остановлена',cancelled:'Отменена'};
const statuses=[['completed','Завершённые'],['errors','С ошибками'],['cancelled','Отменённые'],['active','В обработке']] as const;
function Counts({rows,operations}:{rows:Pick<RowCounts,'rowsFound'|'removed'>&Partial<RowCounts>;operations:TransactionCounts}){
 const facts:[string,number][]=[['Найдено строк',rows.rowsFound],['Новых операций',operations.created],['Требуют внимания',operations.review],['Удалено строк',rows.removed]];
 if(operations.existing)facts.push(['Уже были загружены',operations.existing]);
 if(operations.updated)facts.push(['Обновлено операций',operations.updated]);
 if(rows.notImported)facts.push(['Не импортировано',rows.notImported]);
 if(rows.pending)facts.push(['В обработке',rows.pending]);
 return <dl className={styles.counts}>{facts.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
export function ImportHistoryView({history,report,timezone,value,onChange,onSelect,onMore,onOperations,onCancel,disabled,reasons}:{history:ImportHistory;report:ImportReport|null;accounts:FinanceState['accounts'];timezone:string;value:string[];onChange:(v:string[])=>void;onSelect:(id:string)=>void;onMore:()=>void;onOperations:(id?:string)=>void;onCancel:(id?:string)=>void;disabled:boolean;reasons:Record<string,string>}){
 const date=(value:string)=>new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:timezone}).format(new Date(value));
 return <div className={styles.importGrid}>
  <section className={layout.settingsBox} aria-label="История загрузок"><div className={layout.filterField}><span>Статус загрузки</span><SearchFilter label="Все статусы" options={statuses} value={value} onChange={onChange} disabled={disabled}/></div>
   {history.batches.length?<ul className={styles.history}>{history.batches.map(b=><li key={b.batchId}><button type="button" disabled={disabled} aria-pressed={report?.batchId===b.batchId} onClick={()=>onSelect(b.batchId)}><strong>{date(b.createdAt)}</strong><span>{labels[b.status]}</span><small>Файлов: {b.files} · строк: {b.rowsFound}</small></button></li>)}</ul>:<p>Нет загрузок по выбранным статусам.</p>}
   {history.nextCursor&&<button className={common.button} disabled={disabled} onClick={onMore}>Более ранние загрузки</button>}
  </section>
  <section className={layout.settingsBox} aria-label="Результат загрузки">{report?<>
   <h3>Загрузка от {date(report.createdAt)}</h3><p role="status" className={layout.statusPill}>{labels[report.status]}</p>
   <Counts rows={report.counts} operations={report.transactionCounts}/>
   {!!report.files.length&&<details className={layout.settingsBox}><summary>Файлы загрузки · {report.files.length}</summary><div className={layout.sublist}>{report.files.map((f,i)=><details key={f.fileId}><summary>{bankNames[f.bank]??f.bank} · Файл {i+1}{f.cancelledAt?' · Отменён':''}</summary>
    <Counts rows={f.counts} operations={f.transactionCounts}/>
    {!!f.issues.length&&<details><summary>Ошибки строк · {f.issues.length}</summary><ul>{f.issues.map(issue=><li key={issue.ordinal}>Строка {issue.ordinal}: {reasons[issue.code]??'Не удалось проверить данные'}</li>)}</ul></details>}
    {f.blocked&&<p>Проверьте файл на устройстве и загрузите заново.</p>}
    <div className={layout.cardActions}>{!!f.operationIds?.length&&<button className={common.button} disabled={disabled} onClick={()=>onOperations(f.fileId)}>Открыть операции файла</button>}{!f.cancelledAt&&<button className={common.dangerButton} disabled={disabled} onClick={()=>onCancel(f.fileId)}>Отменить файл</button>}</div>
   </details>)}</div></details>}
   <div className={layout.cardActions}>{report.transactionCounts.total>0&&<button className={common.button} disabled={disabled} onClick={()=>onOperations()}>Открыть операции</button>}{report.status!=='cancelled'&&<button className={common.dangerButton} disabled={disabled} onClick={()=>onCancel()}>Отменить загрузку</button>}</div>
  </>:<p>Выберите загрузку.</p>}</section>
 </div>;
}
