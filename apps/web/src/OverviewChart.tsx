import {useEffect,useRef,useState} from 'react';
import {init,use} from 'echarts/core';
import {BarChart,LineChart,PieChart} from 'echarts/charts';
import {GridComponent,TooltipComponent,LegendComponent,AriaComponent} from 'echarts/components';
import {SVGRenderer} from 'echarts/renderers';
import type {EChartsCoreOption} from 'echarts/core';
import type {WidgetResult} from '../../../packages/finance-core/src/overview';
import {metricNames} from '../../../packages/finance-core/src/overview';
import type {Widget,OverviewPoint} from './overview-client';
import {chartPalette} from './chart-palette';
import {metricValue,pointLabel} from './overview-client';
import styles from './Overview.module.css';
use([BarChart,LineChart,PieChart,GridComponent,TooltipComponent,LegendComponent,AriaComponent,SVGRenderer]);
export default function OverviewChart({widget,result,onPoint}:{widget:Widget;result:WidgetResult;onPoint:(point:OverviewPoint)=>void}){
 const [appearance,setAppearance]=useState(0);useEffect(()=>{const observer=new MutationObserver(()=>setAppearance(n=>n+1));observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-text-size']});const media=matchMedia('(prefers-color-scheme: dark)'),change=()=>setAppearance(n=>n+1);media.addEventListener('change',change);return()=>{observer.disconnect();media.removeEventListener('change',change);};},[]);
 const ref=useRef<HTMLDivElement>(null),click=useRef(onPoint);click.current=onPoint;
 useEffect(()=>{if(!ref.current)return;const root=ref.current,chart=init(root,undefined,{renderer:'svg'}),probe=document.createElement('span');root.append(probe);const color=(v:string)=>{probe.style.color='var('+v+')';return getComputedStyle(probe).color;},text=color('--color-text'),border=color('--color-border');probe.remove();
 const max=result.points.reduce((n,p)=>widget.metrics.reduce((n,m)=>{const v=BigInt(p.values[m]??'0'),prior=BigInt(p.previous[m]??'0');return [v<0n?-v:v,prior<0n?-prior:prior].reduce((n,v)=>v>n?v:n,n);},n),0n),safe=max<=BigInt(Number.MAX_SAFE_INTEGER);
 if(!safe){chart.dispose();return;}
 const count=(m:string)=>['operation_count','attention'].includes(m),value=(v:string,m:string)=>Number(v)/(count(m)?1:100),labels=result.points.map(p=>pointLabel(p,widget.grouping,result.granularity)),kind=result.chart==='table'?'bar':result.chart,dual=widget.metrics.some(count)&&widget.metrics.some(m=>!count(m));
 const series=widget.metrics.flatMap((m,index)=>[{name:metricNames[m],type:kind==='donut'?'pie':kind,...(kind!=='donut'?{yAxisIndex:dual&&count(m)?1:0}:{}),data:result.points.map((p,n)=>({...(kind==='donut'?{name:labels[n]}:{}),value:value(p.values[m]??'0',m),itemStyle:{color:chartPalette[n%50],opacity:widget.metrics.length===1?1:1-index*.2}})),...(kind==='donut'?{radius:['42%','70%'],center:['50%','48%']}:{smooth:false}),label:{show:false},...(kind==='line'?{connectNulls:false,itemStyle:{color:chartPalette[index]},lineStyle:{color:chartPalette[index]}}:{})},...(result.comparisonFilter?[{name:metricNames[m]+' · сравнение',type:kind==='donut'?'bar':kind,yAxisIndex:dual&&count(m)?1:0,data:result.points.map((p,n)=>({value:value(p.previous[m]??'0',m),itemStyle:{color:chartPalette[n%50],opacity:.4}})),lineStyle:{type:'dashed'}}]:[])]);
 const option:EChartsCoreOption={animation:!matchMedia('(prefers-reduced-motion: reduce)').matches,animationDuration:180,color:[...chartPalette],textStyle:{color:text,fontFamily:'system-ui'},aria:{enabled:true,label:{description:widget.name+'. '+result.analysis},decal:{show:kind==='donut'}},tooltip:{trigger:'item',renderMode:'richText',confine:true,formatter:(p:{dataIndex:number;seriesName:string})=>{const point=result.points[p.dataIndex];return point?pointLabel(point,widget.grouping,result.granularity)+'\n'+widget.metrics.map(m=>metricNames[m]+': '+metricValue(m,point.values[m]??'0')).join('\n')+(result.comparisonFilter?'\nСравнение\n'+widget.metrics.map(m=>metricNames[m]+': '+metricValue(m,point.previous[m]??'0')).join('\n'):''):'';}},legend:{show:false},grid:{left:15,right:dual?45:20,top:30,bottom:35,containLabel:true},...(kind==='donut'?{}:{xAxis:{type:'category',data:labels,axisLabel:{color:text,overflow:'truncate',width:80,rotate:result.points.length>12?40:0},axisLine:{lineStyle:{color:border}}},yAxis:dual?[{type:'value',name:'₽',position:'left',axisLabel:{color:text},splitLine:{lineStyle:{color:border}}},{type:'value',name:'Операций',position:'right',minInterval:1,axisLabel:{color:text},splitLine:{show:false}}]:{type:'value',name:widget.metrics.every(count)?'Операций':'₽',...(widget.metrics.every(count)?{minInterval:1}:{}),axisLabel:{color:text,formatter:(v:number)=>v.toLocaleString('ru-RU')},splitLine:{lineStyle:{color:border}}}}),series};
 chart.setOption(option);root.querySelectorAll('svg').forEach(svg=>svg.setAttribute('aria-hidden','true'));chart.on('click',(p:unknown)=>{const index=(p as {dataIndex?:number}).dataIndex;if(index!==undefined&&result.points[index])click.current(result.points[index]!);});const resize=new ResizeObserver(()=>chart.resize());resize.observe(root);
 return()=>{resize.disconnect();chart.dispose();};
 },[widget,result,appearance]);
 return <div ref={ref} className={styles.chart} role="img" aria-label={widget.name+'. '+result.analysis}/>;
}
