import {metricNames} from '../../../packages/finance-core/src/overview';
import type {Widget,WidgetResult} from '../../../packages/finance-core/src/overview';
import {metricValue} from './overview-client';
import styles from './Overview.module.css';
const range=(f:{from?:string;through?:string})=>[f.from??'Начало истории',f.through??'Последняя операция'].join(' — ');
export function WidgetHeading({widget,result}:{widget:Widget;result:WidgetResult}){
 const selected=widget.headings??['total','count','comparison'],budget=widget.metrics.includes('budget'),comparison=selected.includes('comparison')&&result.comparisonFilter;
 if(!selected.length)return null;
 return <div className={styles.widgetTotals} aria-label="Итоги виджета">{(selected.includes('period')||comparison)&&<small>{budget?'Дата расчёта: '+(result.filter.through??'сегодня'):(comparison?'Текущий период: ':'Период: ')+range(result.filter)}</small>}{selected.includes('total')&&(budget?<span>План и факт — отдельно для каждого бюджета</span>:widget.metrics.map(m=><span key={m}><small>{widget.metrics.length===1&&!comparison?'Всего':metricNames[m]}: </small><strong>{metricValue(m,result.totals[m]??'0')}</strong></span>))}{selected.includes('count')&&<small>{budget?'Бюджетов':'Операций'}: <strong>{budget?result.groupCount:result.operationCount}</strong></small>}{comparison&&<div className={styles.comparisonTotals}><small>Период сравнения: {range(comparison)}</small>{widget.metrics.map(m=><span key={m}><small>{metricNames[m]} за период сравнения: </small><strong>{metricValue(m,result.previousTotals[m]??'0')}</strong></span>)}</div>}</div>;
}
