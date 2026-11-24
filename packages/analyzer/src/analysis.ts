import {assertClosedSchema} from './closed-schema.ts';
import {dateFact,operationDay} from '../../finance-core/src/model.ts';
import {queryOperations,operationPartMatches,temporalInformationKnown} from '../../finance-core/src/operations.ts';
import type {OperationRow,OperationsCatalog} from '../../finance-core/src/operations.ts';
import {metricAmount,metricMatches} from '../../finance-core/src/metrics.ts';
import type {Metric} from '../../finance-core/src/metrics.ts';
import type {Query} from './registry.ts';
import type {WidgetResult} from '../../finance-core/src/overview.ts';
const closed=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',additionalProperties:false,properties,required});
const enumeration=(values:readonly string[])=>({type:'string',enum:values});
export const analysisOptionsSchema=closed({
 weekdays:{type:'array',maxItems:7,uniqueItems:true,items:{type:'integer',minimum:0,maximum:6}},clock:{anyOf:[closed({from:{type:'string',pattern:'^(?:[01]\\d|2[0-3]):[0-5]\\d$'},through:{type:'string',pattern:'^(?:[01]\\d|2[0-3]):[0-5]\\d$'}}),{type:'null'}]},dateBasis:enumeration(['operation','posted']),
 statistic:enumeration(['sum','mean','median','min','max']),purpose:enumeration(['summary','savings','recurring','cashflow']),
 topN:{type:'integer',minimum:1,maximum:50},direction:enumeration(['asc','desc']),granularity:enumeration(['auto','day','week','month','quarter','year']),chart:enumeration(['table','bar','line']),
 reductionPercent:{type:'integer',minimum:1,maximum:100},
 comparisonPeriod:closed({from:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},through:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'}},['from','through']),
});
export type AnalysisOptions={weekdays?:number[];clock?:{from?:string;through?:string}|null;dateBasis?:'operation'|'posted';statistic?:'sum'|'mean'|'median'|'min'|'max';purpose?:'summary'|'savings'|'recurring'|'cashflow';topN?:number;direction?:'asc'|'desc';granularity?:'auto'|'day'|'week'|'month'|'quarter'|'year';chart?:'table'|'bar'|'line';reductionPercent?:number;comparisonPeriod?:{from:string;through:string}};
export function parseAnalysisOptions(raw:unknown):AnalysisOptions{
 assertClosedSchema(raw,analysisOptionsSchema);const r=structuredClone(raw) as AnalysisOptions;
 if(r.comparisonPeriod){for(const date of Object.values(r.comparisonPeriod))dateFact({precision:'day',date});if(r.comparisonPeriod.from>r.comparisonPeriod.through)throw new TypeError('ANALYSIS_PERIOD_INVALID');}
 return r;
}
export type GroupChange={label:string;difference:string;filter:Query['filter']};
export type AnalysisResult={version:'cashneuro-analysis/1';statistic:NonNullable<AnalysisOptions['statistic']>;unit:'money'|'count';value:string|null;sum:string;count:number;mean:string|null;median:string|null;minimum:string|null;maximum:string|null;notes:string[];comparison?:{previousValue:string;difference:string;largestIncrease?:GroupChange;largestDecrease?:GroupChange};missingTemporalCount?:number;previousValue?:string|null;savings?:{label:string;baseMinor:string;reductionPercent:number;savingMinor:string;filter:Query['filter']}[];recurring?:{merchant:string;count:number;totalMinor:string;typicalMinor:string;firstDate:string;lastDate:string;intervalDays:number|null;regular:boolean;filter:Query['filter']}[]};
const rounded=(n:bigint,d:bigint)=>n<0n?-((-n+d/2n)/d):(n+d/2n)/d;
const median=(a:bigint[])=>a.length%2?a[(a.length-1)/2]!:rounded(a[a.length/2-1]!+a[a.length/2]!,2n);
export const countMetric=(m:Metric)=>m==='attention'||m==='operation_count';
/** Exactly the same effective parts and metric predicates as Overview. Never
 * read parent amounts in addition to allocated components. No raw text to AI. */
export function analyzeFinancialRows(query:Query,rows:OperationRow[],catalog:OperationsCatalog,result:WidgetResult):AnalysisResult{
 const options=query.options??{},metric=query.metric,filter=result.filter,statistic=options.statistic??'sum';
 const selected=queryOperations(rows,catalog,{filter,sort:'date',direction:'asc',group:'none'}).operations;
 const values:bigint[]=[],qualifying:OperationRow[]=[];
 for(const o of selected){const parts=o.parts.filter(p=>operationPartMatches(p,o,filter)&&(p.included||filter.includeExcluded||countMetric(metric))&&metricMatches(metric,p,o));if(!parts.length)continue;values.push(countMetric(metric)?1n:parts.reduce((n,p)=>n+metricAmount(metric,p,o),0n));qualifying.push(o);}
 const sum=values.reduce((a,b)=>a+b,0n),n=values.length;
 if(statistic==='median')values.sort((a,b)=>a<b?-1:a>b?1:0);
 const minimum=n?values.reduce((a,b)=>a<b?a:b).toString():null,maximum=n?values.reduce((a,b)=>a>b?a:b).toString():null;
 const stats={sum:sum.toString(),count:n,mean:n?rounded(sum,BigInt(n)).toString():null,median:n&&statistic==='median'?median(values).toString():null,minimum,maximum};
 if(sum!==BigInt(result.totals[metric]??'0'))throw new TypeError('ANALYSIS_TOTAL_MISMATCH');
 const value=statistic==='sum'?stats.sum:statistic==='min'?stats.minimum:statistic==='max'?stats.maximum:stats[statistic];
 const answer:AnalysisResult={version:'cashneuro-analysis/1',statistic,unit:countMetric(metric)?'count':'money',value,...stats,notes:[]};
 if(result.comparisonFilter&&statistic!=='sum')answer.previousValue=analyzeFinancialRows({...query,comparison:'none',options:{statistic}},rows,catalog,{...result,filter:result.comparisonFilter,comparisonFilter:null,totals:result.previousTotals}).value;
 if(filter.weekdays?.length||filter.timeFrom||filter.timeThrough){const relaxed={...filter,metric:query.metric};delete relaxed.weekdays;delete relaxed.timeFrom;delete relaxed.timeThrough;answer.missingTemporalCount=queryOperations(rows,catalog,{filter:relaxed,sort:'date',direction:'asc',group:'none'}).operations.filter(o=>!temporalInformationKnown(o,filter)).length;if(answer.missingTemporalCount)answer.notes.push('У '+answer.missingTemporalCount+' подходящих операций нет достаточных данных о времени/часовом поясе: они не назначены произвольно времени суток или дню недели. Использовано время, указанное банком.');}
 if(statistic!=='sum')answer.notes.push('Статистика считается по значениям выбранного показателя на операцию, после распределения частей. Среднее = сумма / число подходящих операций; чётная медиана — среднее двух центральных значений. Округление до ближайшей копейки.');
 if(metric==='difference'||options.purpose==='cashflow')answer.notes.push('Разница доходов и расходов не является остатком на счёте. Для доступных денег нужны начальный остаток, полная история движений и будущие обязательства.');
 const uncertain=selected.filter(o=>o.parts.some(p=>p.role==='unresolved'&&operationPartMatches(p,o,filter)));
 if(uncertain.length)answer.notes.push('Есть операции с неопределённым финансовым смыслом: '+uncertain.length+'. Они не назначены доходами или расходами; итог может измениться после проверки.');
 if(options.purpose==='savings'){
  if(metric!=='expenses'||query.grouping!=='category'||statistic!=='sum')throw new TypeError('SAVINGS_CATEGORY_EXPENSES_REQUIRED');
  const percent=options.reductionPercent??10;
  answer.savings=result.points.filter(p=>BigInt(p.values.expenses??'0')>0n).slice(0,5).map(p=>({label:p.label,baseMinor:p.values.expenses!,reductionPercent:percent,savingMinor:rounded(BigInt(p.values.expenses!)*BigInt(percent),100n).toString(),filter:p.filter}));
  answer.notes.push('Сценарий: уменьшение расходов выбранных категорий на '+percent+'% за такой же период. Это не прогноз и не автоматический лимит. Возможность сокращения лекарств, обязательных платежей и других необходимых расходов не предполагается. Эффекты категорий не складываются с другими пересекающимися мерами.');
 }
 if(options.purpose==='recurring'){
  const groups=new Map<string,OperationRow[]>();for(const o of qualifying){const key=o.classification.merchant.value.trim();if(!key)continue;const a=groups.get(key)??[];a.push(o);groups.set(key,a);}
  answer.recurring=[...groups].filter(([,a])=>a.length>=2).map(([merchant,a])=>{
   const dates=a.map(o=>operationDay(o.date)).sort(),unique=[...new Set(dates)],gaps=unique.slice(1).map((d,i)=>Math.round((Date.parse(d+'T00:00:00Z')-Date.parse(unique[i]!+'T00:00:00Z'))/86400000)).sort((a,b)=>a-b);
   const amounts=a.map(o=>o.parts.filter(p=>operationPartMatches(p,o,filter)&&(p.included||filter.includeExcluded)&&metricMatches(metric,p,o)).reduce((n,p)=>n+metricAmount(metric,p,o),0n)).sort((a,b)=>a<b?-1:a>b?1:0);
   const intervalDays=gaps.length?gaps[Math.floor(gaps.length/2)]!:null;
   return {merchant,count:a.length,totalMinor:amounts.reduce((n,v)=>n+v,0n).toString(),typicalMinor:median(amounts).toString(),firstDate:dates[0]!,lastDate:dates.at(-1)!,intervalDays,regular:gaps.length>=2&&intervalDays!==null&&gaps.every(g=>Math.abs(g-intervalDays)<=Math.max(3,intervalDays*.15)),filter:{...query.filter,merchant,merchantExact:true}};
  }).sort((a,b)=>BigInt(a.totalMinor)>BigInt(b.totalMinor)?-1:BigInt(a.totalMinor)<BigInt(b.totalMinor)?1:a.merchant.localeCompare(b.merchant,'ru')).slice(0,50);
  answer.notes.push('Повторные платежи — кандидаты для проверки, а не подтверждённые активные подписки. Одно списание не доказывает регулярность; повторные покупки также могут не быть подпиской.');
 }
 return answer;
}

/** Group-level statistics use the exact drill-down filter, including comparison-only buckets. */
export function decorateAnalysis(query:Query,rows:OperationRow[],catalog:OperationsCatalog,result:WidgetResult){
 const analysis=analyzeFinancialRows(query,rows,catalog,result),stat=query.options?.statistic;
 if(stat&&stat!=='sum')for(const p of new Set([...(result.points??[]),...(result.tablePoints??[])])){
  const current=analyzeFinancialRows({...query,comparison:'none',options:{statistic:stat}},rows,catalog,{...result,filter:p.filter,comparisonFilter:null,totals:p.values});
  p.values={...p.values,[query.metric]:current.value??'0'};
  if(p.previousFilter){const previous=analyzeFinancialRows({...query,comparison:'none',options:{statistic:stat}},rows,catalog,{...result,filter:p.previousFilter,comparisonFilter:null,totals:p.previous});p.previous={...p.previous,[query.metric]:previous.value??'0'};}
 }
 if(result.comparisonFilter&&analysis.value!==null){
  const previous=analysis.previousValue===undefined?result.previousTotals[query.metric]??'0':analysis.previousValue;
  if(previous!==null){
   analysis.comparison={previousValue:previous,difference:(BigInt(analysis.value)-BigInt(previous)).toString()};
   if(analysis.statistic==='sum'&&!['none','operation','time'].includes(query.grouping)){
    // The complete server-side groups include comparison-only buckets and
    // groups outside the chart's top-N. Never infer maxima from a preview.
    const points=result.tablePoints??(result.points.length===result.groupCount?result.points:[]);
    for(const p of points){const difference=BigInt(p.values[query.metric]??'0')-BigInt(p.previous[query.metric]??'0'),change={label:p.label,difference:difference.toString(),filter:p.filter};
     if(difference>0n&&(!analysis.comparison.largestIncrease||difference>BigInt(analysis.comparison.largestIncrease.difference)))analysis.comparison.largestIncrease=change;
     if(difference<0n&&(!analysis.comparison.largestDecrease||difference<BigInt(analysis.comparison.largestDecrease.difference)))analysis.comparison.largestDecrease=change;
    }
   }
  }
 }
 return analysis;
}
