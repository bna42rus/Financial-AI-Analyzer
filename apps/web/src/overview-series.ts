import {metricNames} from '../../../packages/finance-core/src/overview';
import type {Widget,WidgetResult} from '../../../packages/finance-core/src/overview';
export type PlotSeries={key:string;name:string;unit:'money'|'count'|'percent';values:(string|null)[];previous:boolean};
export const budgetMeasureNames={plan:'Запланировано',used:'Потрачено по бюджету',remaining:'Осталось',overrun:'Превышение',percent:'Выполнение'};
export function widgetSeries(widget:Widget,result:WidgetResult):PlotSeries[]{
 const out:PlotSeries[]=[];
 for(const m of widget.metrics){
  if(m==='budget'){
   for(const key of widget.budgetMeasures??['plan','used'])out.push({key:'budget_'+key,name:budgetMeasureNames[key],unit:key==='percent'?'percent':'money',previous:false,values:result.points.map(p=>{const indicator=p.budget?.indicator;if(!indicator)return null;return key==='percent'?indicator.percentage:key==='plan'?indicator.limitMinor:key==='used'?indicator.usedMinor:key==='remaining'?(BigInt(indicator.remainingMinor)<0n?'0':indicator.remainingMinor):indicator.overMinor;})});
  }else{
   const unit=['operation_count','attention'].includes(m)?'count' as const:'money' as const;
   out.push({key:m,name:metricNames[m],unit,previous:false,values:result.points.map(p=>widget.grouping==='time'&&result.comparisonFilter&&p.key.startsWith('comparison-only:')?null:p.values[m]??'0')});
   if(result.comparisonFilter)out.push({key:m+'_previous',name:metricNames[m]+' · сравнение',unit,previous:true,values:result.points.map(p=>widget.grouping==='time'&&!p.previousFilter?null:p.previous[m]??'0')});
  }
 }
 return out;
}
export function plotGroups(series:PlotSeries[],mode:'auto'|'combined'|'separate'='auto'){
 if(mode==='separate'||mode==='auto'&&series.filter(s=>!s.previous).length>4)return series.filter(s=>!s.previous).map(s=>series.filter(x=>x.key===s.key||x.key===s.key+'_previous'));
 const units=[...new Set(series.map(s=>s.unit))];return units.length>2?[series.filter(s=>s.unit==='money'),series.filter(s=>s.unit==='count'),series.filter(s=>s.unit==='percent')].filter(g=>g.length):[series];
}
