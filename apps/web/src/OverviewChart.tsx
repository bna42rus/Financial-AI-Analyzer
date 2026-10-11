import {useEffect,useRef,useState} from 'react';
import {init,use} from 'echarts/core';
import {BarChart,LineChart,PieChart} from 'echarts/charts';
import {GridComponent,TooltipComponent,LegendComponent,AriaComponent} from 'echarts/components';
import {SVGRenderer} from 'echarts/renderers';
import type {EChartsCoreOption} from 'echarts/core';
import type {WidgetResult} from '../../../packages/finance-core/src/overview';
import {metricNames} from '../../../packages/finance-core/src/overview';
import type {Widget,OverviewPoint} from './overview-client';
import {metricValue,pointLabel} from './overview-client';
import styles from './Overview.module.css';
use([BarChart,LineChart,PieChart,GridComponent,TooltipComponent,LegendComponent,AriaComponent,SVGRenderer]);
export default function OverviewChart({widget,result,onPoint}:{widget:Widget;result:WidgetResult;onPoint:(point:OverviewPoint)=>void}){
 const [appearance,setAppearance]=useState(0);useEffect(()=>{const observer=new MutationObserver(()=>setAppearance(n=>n+1));observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-text-size']});const media=matchMedia('(prefers-color-scheme: dark)'),change=()=>setAppearance(n=>n+1);media.addEventListener('change',change);return()=>{observer.disconnect();media.removeEventListener('change',change);};},[]);
 const ref=useRef<HTMLDivElement>(null),click=useRef(onPoint);click.current=onPoint;
 useEffect(()=>{if(!ref.current)return;const root=ref.current,chart=init(root,undefined,{renderer:'svg'}),probe=document.createElement('span');root.append(probe);const color=(v:string)=>{probe.style.color='var('+v+')';return getComputedStyle(probe).color;},text=color('--color-text'),border=color('--color-border'),primary=color('--color-chart');probe.remove();
 const max=result.points.reduce((n,p)=>widget.metrics.reduce((n,m)=>{const v=BigInt(p.values[m]??'0'),prior=BigInt(p.previous[m]??'0');return [v<0n?-v:v,prior<0n?-prior:prior].reduce((n,v)=>v>n?v:n,n);},n),0n),safe=max<=BigInt(Number.MAX_SAFE_INTEGER);
 if(!safe){chart.dispose();return;}
 const count=(m:string)=>['operation_count','attention'].includes(m),value=(v:string,m:string)=>Number(v)/(count(m)?1:100),labels=result.points.map(p=>pointLabel(p,widget.grouping,result.granularity)),series=widget.metrics.flatMap((m,index)=>[{name:metricNames[m],type:result.chart==='donut'?'pie':result.chart,data:result.points.map(p=>result.chart==='donut'?{name:p.label,value:value(p.values[m]??'0',m)}:value(p.values[m]??'0',m)),...(result.chart==='donut'?{radius:['42%','70%'],center:['50%','48%']}:{smooth:false}),label:{show:widget.labels,formatter:(v:{dataIndex:number})=>metricValue(m,result.points[v.dataIndex]?.values[m]??'0')},...(result.chart==='donut'?{}:{itemStyle:{color:index===0?primary:undefined}}),...(result.chart==='line'?{connectNulls:false}:{}),...(!result.comparisonFilter?{}:{})},...(result.comparisonFilter?[{name:metricNames[m]+' · сравнение',type:result.chart==='donut'?'bar':result.chart,data:result.points.map(p=>value(p.previous[m]??'0',m)),itemStyle:{color:'#b79855'},lineStyle:{type:'dashed'}}]:[])]);
 const option:EChartsCoreOption={animation:false,color:[primary,'#8c82c7','#b79855'],textStyle:{color:text,fontFamily:'system-ui'},aria:{enabled:true,label:{description:widget.name+'. '+result.analysis},decal:{show:result.chart==='donut'}},tooltip:{trigger:'item',renderMode:'richText',confine:true,formatter:(p:{dataIndex:number;seriesName:string})=>{const point=result.points[p.dataIndex];return point?pointLabel(point,widget.grouping,result.granularity)+'\n'+widget.metrics.map(m=>metricNames[m]+': '+metricValue(m,point.values[m]??'0')).join('\n')+(result.comparisonFilter?'\nСравнение\n'+widget.metrics.map(m=>metricNames[m]+': '+metricValue(m,point.previous[m]??'0')).join('\n'):''):'';}},legend:{show:widget.legend,type:'scroll',bottom:0,textStyle:{color:text}},grid:{left:15,right:20,top:20,bottom:widget.legend?65:35,containLabel:true},...(result.chart==='donut'?{}:{xAxis:{type:'category',data:labels,axisLabel:{color:text,overflow:'truncate',width:80,rotate:result.points.length>12?40:0},axisLine:{lineStyle:{color:border}}},yAxis:{type:'value',axisLabel:{color:text,formatter:(v:number)=>v.toLocaleString('ru-RU')},splitLine:{lineStyle:{color:border}}}}),series};
 chart.setOption(option);root.querySelectorAll('svg').forEach(svg=>svg.setAttribute('aria-hidden','true'));chart.on('click',(p:unknown)=>{const index=(p as {dataIndex?:number}).dataIndex;if(index!==undefined&&result.points[index])click.current(result.points[index]!);});const resize=new ResizeObserver(()=>chart.resize());resize.observe(root);
 return()=>{resize.disconnect();chart.dispose();};
 },[widget,result,appearance]);
 return <div ref={ref} className={styles.chart} role="img" aria-label={widget.name+'. '+result.analysis}/>;
}
