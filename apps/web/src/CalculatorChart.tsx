import type {CalculatorResult} from '../../../packages/analyzer/src/calculators';
import {formatMoney} from './demo/overview';
import styles from './ServerAnalyzer.module.css';

/** Coordinates alone use Number; labels and arithmetic retain exact kopecks. */
export function CalculatorChart({value}:{value:CalculatorResult}){
 if(value.kind==='real_return'||value.rows.length<2)return null;
 const loan=value.kind==='loan',rows=value.rows;
 const series=rows.map(r=>({month:r.month,total:loan&&'paymentMinor'in r?(BigInt(r.paymentMinor)+BigInt(r.extraMinor)).toString():r.closingMinor,principal:'principalMinor'in r?r.principalMinor:'0',interest:'interestMinor'in r?r.interestMinor:'0',extra:'extraMinor'in r?r.extraMinor:'0'}));
 if(series.some(p=>Object.values(p).some(n=>typeof n==='string'&&(BigInt(n)>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(n)<0n))))return null;
 const max=series.reduce((a,r)=>BigInt(r.total)>a?BigInt(r.total):a,1n),x=(i:number)=>100+i*550/(series.length-1),y=(n:string)=>220-Number(n)*190/Number(max);
 const line=(values:string[])=>values.map((n,i)=>(i?'L':'M')+x(i).toFixed(2)+','+y(n).toFixed(2)).join(' ');
 const area=(upper:string[],lower:string[])=>line(upper)+lower.map((_,i)=>{const j=lower.length-1-i;return ' L'+x(j).toFixed(2)+','+y(lower[j]!).toFixed(2);}).join('')+' Z';
 const total=series.map(r=>r.total),principal=series.map(r=>r.principal),regular=series.map(r=>(BigInt(r.principal)+BigInt(r.interest)).toString()),extra=series.some(r=>BigInt(r.extra)>0n),title=loan?'Ежемесячные платежи: основной долг и проценты':'Сумма по месяцам';
 return <figure className={styles.calculatorChart}><figcaption>{title}</figcaption><svg viewBox="0 0 680 258" role="img" aria-label={title+'. '+formatMoney(total[0]!)+' в первый месяц, '+formatMoney(total.at(-1)!)+' в последний. Точные суммы по месяцам доступны в таблице.'}>
  {[0n,1n,2n,3n].map(i=>{const n=(max*i/3n).toString();return <g key={String(i)}><path d={'M100,'+y(n)+' H650'} className={styles.chartAxis}/><text x="90" y={y(n)+5} textAnchor="end">{formatMoney(n)}</text></g>;})}
  {loan&&<><path d={area(principal,series.map(()=>'0'))} className={styles.chartPrincipal}/><path d={area(regular,principal)} className={styles.chartInterest}/>{extra&&<path d={area(total,regular)} className={styles.chartExtra}/>}</>}
  <path d={line(total)} className={styles.chartLine}/><text x="100" y="248">1-й месяц</text><text x="650" y="248" textAnchor="end">{series.length}-й месяц</text>
 </svg>{loan&&<div className={styles.chartLegend}><span><i className={styles.legendPrincipal}/>Основной долг</span><span><i className={styles.legendInterest}/>Проценты</span>{extra&&<span><i className={styles.legendExtra}/>Досрочно</span>}<span>Линия — весь платёж за месяц</span></div>}</figure>;
}
