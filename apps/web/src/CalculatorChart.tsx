import type {CalculatorResult} from '../../../packages/analyzer/src/calculators';
import {formatMoney} from './demo/overview';
import styles from './ServerAnalyzer.module.css';
/** Coordinates are presentation only. Labels and the underlying table retain
 * exact minor-unit strings; large values fall back to that table. */
export function CalculatorChart({value}:{value:CalculatorResult}){
 if(value.kind==='real_return'||!value.rows.length)return null;
 const rows=value.rows,series=rows.map(r=>({month:r.month,value:r.closingMinor}));
 if(series.length<2||series.some(p=>BigInt(p.value)>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(p.value)<-BigInt(Number.MAX_SAFE_INTEGER)))return null;
 const values=series.map(p=>Number(p.value)),min=Math.min(0,...values),max=Math.max(0,...values),range=Math.max(1,max-min),x=(i:number)=>38+i*504/(series.length-1),y=(n:number)=>160-(n-min)*135/range;
 const d=series.map((p,i)=>(i?'L':'M')+x(i).toFixed(2)+','+y(Number(p.value)).toFixed(2)).join(' '),loan=value.kind==='loan'||value.kind==='loan_term',title=loan?'Остаток долга по месяцам':'Сумма по месяцам';
 return <figure className={styles.calculatorChart}><figcaption>{title}</figcaption><svg viewBox="0 0 580 198" role="img" aria-label={title+': с '+formatMoney(series[0]!.value)+' до '+formatMoney(series.at(-1)!.value)+'. Точные значения в таблице расчёта.'}><path d={'M38,'+y(0)+' H542'} className={styles.chartAxis}/><path d={d} className={styles.chartLine}/><text x="38" y="188">1-й месяц</text><text x="542" y="188" textAnchor="end">{series.length}-й месяц</text></svg></figure>;
}
