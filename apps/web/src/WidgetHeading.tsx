import {metricNames} from '../../../packages/finance-core/src/overview';
import type {Widget,WidgetResult} from '../../../packages/finance-core/src/overview';
import {metricValue,periodRange} from './overview-client';
import styles from './Overview.module.css';
export function WidgetHeading({widget,result}:{widget:Widget;result:WidgetResult}){
 const selected=widget.headings??['total','count','comparison'],budget=widget.metrics.includes('budget'),comparison=selected.includes('comparison')&&result.comparisonFilter;
 if(!selected.length)return null;
 const value=(m:Widget['metrics'][number],n:string)=>['operation_count','attention'].includes(m)?n:metricValue(m,n);
 const totals=(previous=false)=>!budget&&(previous||selected.includes('total'))&&widget.metrics.map(m=><span key={m}><small>{metricNames[m]}{previous?' за период сравнения':''}: </small><strong>{value(m,(previous?result.previousTotals:result.totals)[m]??'0')}</strong></span>);
 return <div className={styles.widgetTotals} data-comparison={comparison?true:undefined} aria-label="Итоги виджета">{(selected.includes('period')||comparison)&&<small className={styles.periodHeading}>{budget?'Дата расчёта: '+(result.filter.through??'сегодня'):(comparison?'Текущий период: ':'Период: ')+periodRange(result.filter)}</small>}{totals()}{selected.includes('count')&&!(selected.includes('total')&&widget.metrics.includes('operation_count'))&&<span><small>{budget?'Количество бюджетов':'Количество операций'}: </small><strong>{budget?result.groupCount:result.operationCount}</strong></span>}{comparison&&<div className={styles.comparisonTotals}><small className={styles.periodHeading}>Период сравнения: {periodRange(comparison)}</small>{totals(true)}</div>}</div>;
}
