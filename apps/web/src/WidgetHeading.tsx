import {metricNames} from '../../../packages/finance-core/src/overview';
import type {Widget,WidgetResult} from '../../../packages/finance-core/src/overview';
import {metricValue} from './overview-client';
import styles from './Overview.module.css';
const range=(f:{from?:string;through?:string})=>[f.from??'Начало истории',f.through??'Последняя операция'].join(' — ');
export function WidgetHeading({widget,result}:{widget:Widget;result:WidgetResult}){
 const selected=widget.headings??['total','count','comparison'],budget=widget.metrics.includes('budget');
 if(!selected.length)return null;
 return <div className={styles.widgetTotals} aria-label="Итоги виджета">{selected.includes('total')&&(budget?<span>План и факт — отдельно для каждого бюджета</span>:widget.metrics.map(m=><span key={m}><small>{widget.metrics.length===1?'Всего':metricNames[m]}: </small><strong>{metricValue(m,result.totals[m]??'0')}</strong></span>))}{selected.includes('count')&&<small>{budget?'Бюджетов':'Операций в выбранных условиях'}: <strong>{budget?result.groupCount:result.operationCount}</strong></small>}{selected.includes('comparison')&&result.comparisonFilter&&<small>Период · {range(result.filter)}<br/>Сравнение · {range(result.comparisonFilter)}<br/>{widget.metrics.map(m=>metricNames[m]+': '+metricValue(m,result.previousTotals[m]??'0')).join(' · ')}</small>}{selected.includes('period')&&<small>{budget?'Дата расчёта: '+(result.filter.through??'сегодня'):'Период: '+range(result.filter)}</small>}</div>;
}
