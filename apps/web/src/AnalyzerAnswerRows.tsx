import {useState} from 'react';
import type {OverviewPoint,WidgetResult} from '../../../packages/finance-core/src/overview';
import type {Query} from '../../../packages/analyzer/src/registry';
import type {OperationsFilter} from '../../../packages/finance-core/src/operations';
import {formatMoney} from './demo/overview';
import {api} from './server-client';
import common from './App.module.css';
import styles from './ServerAnalyzer.module.css';

export function AnalyzerAnswerRows({id,query,result,onOpen}:{id:string;query:Query;result:WidgetResult;onOpen:(filter:OperationsFilter,name:string)=>void}){
 const [points,setPoints]=useState(result.points),[next,setNext]=useState<number|null>(result.points.length<result.groupCount?result.points.length:null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function more(){if(next===null||busy)return;setBusy(true);setError('');try{const data=await api<{points:OverviewPoint[];nextOffset:number|null}>('/finance/analyzer-answer-rows',{answerId:id,offset:next});setPoints(old=>[...old,...data.points]);setNext(data.nextOffset);}catch(e){setError(e instanceof Error?e.message:'Не удалось показать остальные строки.');}finally{setBusy(false);}}
 const display=(value:string|undefined)=>query.metric==='attention'?(value??'0'):formatMoney(value??'0');
 return <div className={styles.tableWrap}>
  <table><thead><tr><th>{query.grouping==='operation'?'Операция':'Категория'}</th><th>Значение</th>{result.comparisonFilter&&<th>Прошлый период</th>}</tr></thead>
  <tbody>{points.map(p=><tr key={p.key}><td><button className={common.linkButton} onClick={()=>onOpen(p.filter,p.label)}>{p.label}</button></td><td>{display(p.values[query.metric])}</td>{result.comparisonFilter&&<td>{display(p.previous[query.metric])}</td>}</tr>)}</tbody></table>
  {next!==null&&<div className={styles.answerRowsFooter}><span>Показано {points.length} из {result.groupCount}</span><button type="button" className={common.button} disabled={busy} onClick={()=>void more()}>{busy?'Загружаем…':'Показать ещё'}</button></div>}
  {error&&<p className={common.error} role="alert">{error}</p>}
 </div>;
}
