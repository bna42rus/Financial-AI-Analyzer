import {useRef} from 'react';
import type {PointerEvent} from 'react';
import {operationColumns} from '../../../packages/finance-core/src/operations';
import type {Column,OperationsQuery,OperationsView} from './operations-client';
import {columnNames,groupingNames} from './operations-client';
import {WidgetSelect} from './WidgetSelect';
import common from './App.module.css';
import styles from './OperationsTable.module.css';

export const operationPageSizes=[10,50,100,500] as const;
export const operationPageSize=(value:OperationsView['pageSize'])=>operationPageSizes.find(size=>size===value)??50;
export const operationColumnWidth=(config:OperationsView,c:Column)=>config.widths[c]??(c==='merchant'?200:c==='amount'?130:120);
function move(columns:Column[],from:Column,to:Column){const a=columns.indexOf(from),b=columns.indexOf(to);if(a<0||b<0||a===b)return columns;const next=[...columns];next.splice(a,1);next.splice(b,0,from);return next;}
type Settings={config:OperationsView;disabled:boolean;onChange:(patch:Partial<OperationsView>)=>void};
export function OperationListSettings({config,disabled,onChange}:Settings){
 const dragging=useRef<Column|null>(null);
 const columns=[...config.columns,...operationColumns.filter(c=>!config.columns.includes(c))];
 return <details className={styles.options}><summary>Вид списка</summary><div className={styles.advanced}>
 <label>Сортировка<WidgetSelect aria-label="Сортировка операций" value={config.sort} disabled={disabled} onChange={e=>onChange({sort:e.target.value as OperationsQuery['sort']})}>{['date','amount','merchant','category','confidence','status'].map(c=><option key={c} value={c}>{columnNames[c as Column]}</option>)}</WidgetSelect></label>
 <label>Порядок<WidgetSelect aria-label="Порядок сортировки" value={config.direction} disabled={disabled} onChange={e=>onChange({direction:e.target.value as 'asc'|'desc'})}><option value="desc">По убыванию</option><option value="asc">По возрастанию</option></WidgetSelect></label>
 <label>Группировка<WidgetSelect aria-label="Группировка операций" value={config.group} disabled={disabled} onChange={e=>onChange({group:e.target.value as OperationsQuery['group']})}>{Object.entries(groupingNames).map(([v,n])=><option key={v} value={v}>{n}</option>)}</WidgetSelect></label>
 <label>Операций за раз<WidgetSelect aria-label="Операций за раз" value={operationPageSize(config.pageSize)} disabled={disabled} onChange={e=>onChange({pageSize:Number(e.target.value)})}>{operationPageSizes.map(n=><option key={n} value={n}>{n}</option>)}</WidgetSelect></label>
 <details className={styles.columnSettings}><summary>Колонки таблицы</summary><fieldset disabled={disabled}><legend>Состав и порядок</legend>{columns.map(c=>{const i=config.columns.indexOf(c);return <div key={c} className={styles.columnChoice} draggable={!disabled&&i>=0} onDragStart={e=>{dragging.current=c;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',c);}} onDragEnd={()=>{dragging.current=null;}} onDragOver={e=>{if(i>=0&&dragging.current)e.preventDefault();}} onDrop={e=>{e.preventDefault();if(dragging.current)onChange({columns:move(config.columns,dragging.current,c)});dragging.current=null;}}>
 <label className={styles.columnCheck}><input type="checkbox" aria-label={`Колонка: ${columnNames[c]}`} checked={i>=0} disabled={c==='merchant'} onChange={e=>onChange({columns:e.target.checked?[...config.columns,c]:config.columns.filter(x=>x!==c)})}/>{columnNames[c]}</label>
 {i>=0&&<div><button className={common.iconButton} type="button" aria-label={`Выше: ${columnNames[c]}`} disabled={i===0} onClick={()=>onChange({columns:move(config.columns,c,config.columns[i-1]!)})}>↑</button><button className={common.iconButton} type="button" aria-label={`Ниже: ${columnNames[c]}`} disabled={i===config.columns.length-1} onClick={()=>onChange({columns:move(config.columns,c,config.columns[i+1]!)})}>↓</button></div>}
 </div>;})}</fieldset></details>
 </div></details>;
}
export function OperationTableHeader({config,disabled,onChange}:Settings){
 const dragged=useRef<Column|null>(null);
 function resize(e:PointerEvent<HTMLButtonElement>){if(disabled||e.button!==0)return;e.preventDefault();e.stopPropagation();const handle=e.currentTarget,start=Number(handle.dataset.width),x=e.clientX,id=e.pointerId,c=handle.dataset.column as Column;
  handle.setPointerCapture(id);
  const update=(ev:globalThis.PointerEvent)=>{if(ev.pointerId===id)onChange({widths:{...config.widths,[c]:Math.max(80,Math.min(600,Math.round(start+ev.clientX-x)))}});};
  const end=()=>{handle.removeEventListener('pointermove',update);handle.removeEventListener('lostpointercapture',end);};
  handle.addEventListener('pointermove',update);handle.addEventListener('lostpointercapture',end);
 }
 return <div className={styles.header} role="group" aria-label="Колонки операций"><span/>{config.columns.map((c,i)=><div key={c} className={styles.columnHeader} onDragOver={e=>{if(dragged.current&&!disabled)e.preventDefault();}} onDrop={e=>{e.preventDefault();if(dragged.current&&!disabled)onChange({columns:move(config.columns,dragged.current,c)});dragged.current=null;}}>
  <button className={styles.columnGrip} type="button" draggable={!disabled} disabled={disabled} title="Перетащите, чтобы поменять порядок" onDragStart={e=>{dragged.current=c;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',c);}} onDragEnd={()=>{dragged.current=null;}} onKeyDown={e=>{const to=e.key==='ArrowLeft'?config.columns[i-1]:e.key==='ArrowRight'?config.columns[i+1]:undefined;if(to){e.preventDefault();onChange({columns:move(config.columns,c,to)});}}}>{columnNames[c]}</button>
  <button className={styles.columnResize} type="button" aria-label={`Изменить ширину: ${columnNames[c]}`} disabled={disabled} data-width={operationColumnWidth(config,c)} data-column={c} onPointerDown={resize} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();onChange({widths:{...config.widths,[c]:Math.max(80,Math.min(600,operationColumnWidth(config,c)+(e.key==='ArrowLeft'?-10:10)))}});}}}/>
 </div>)}</div>;
}
