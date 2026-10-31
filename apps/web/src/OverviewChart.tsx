import {useEffect,useMemo,useRef,useState} from 'react';
import {init,use} from 'echarts/core';
import {BarChart,LineChart,PieChart} from 'echarts/charts';
import {GridComponent,TooltipComponent,LegendComponent,AriaComponent} from 'echarts/components';
import {SVGRenderer} from 'echarts/renderers';
import type {EChartsCoreOption} from 'echarts/core';
import type {WidgetResult} from '../../../packages/finance-core/src/overview';
import type {Widget,OverviewPoint} from './overview-client';
import {chartPalette} from './chart-palette';
import {pointLabel} from './overview-client';
import {widgetSeries,plotGroups} from './overview-series';
import type {PlotSeries} from './overview-series';
import styles from './Overview.module.css';
use([BarChart,LineChart,PieChart,GridComponent,TooltipComponent,LegendComponent,AriaComponent,SVGRenderer]);
export default function OverviewChart({widget,result,onPoint}:{widget:Widget;result:WidgetResult;onPoint:(point:OverviewPoint)=>void}){
 const groups=useMemo(()=>plotGroups(widgetSeries(widget,result),widget.chartLayout),[widget,result]);
 return <div className={styles.chartStack}>{groups.map((series,index)=><section key={series.map(s=>s.key).join('|')} aria-label={'График: '+series.filter(s=>!s.previous).map(s=>s.name).join(', ')}>{groups.length>1&&<h3>{series.filter(s=>!s.previous).map(s=>s.name).join(', ')}</h3>}<Plot widget={widget} result={result} series={series} onPoint={onPoint} index={index}/></section>)}</div>;
}
function Plot({widget,result,series,onPoint,index}:{widget:Widget;result:WidgetResult;series:PlotSeries[];onPoint:(p:OverviewPoint)=>void;index:number}){
 const [appearance,setAppearance]=useState(0),ref=useRef<HTMLDivElement>(null),click=useRef(onPoint);click.current=onPoint;
 useEffect(()=>{const observer=new MutationObserver(()=>setAppearance(n=>n+1));observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-text-size']});const media=matchMedia('(prefers-color-scheme: dark)'),change=()=>setAppearance(n=>n+1);media.addEventListener('change',change);return()=>{observer.disconnect();media.removeEventListener('change',change);};},[]);
 const unsafe=series.some(s=>s.values.some(v=>v!==null&&(s.unit==='percent'?!Number.isFinite(Number(v)):BigInt(v)>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(v)<-BigInt(Number.MAX_SAFE_INTEGER))));
 useEffect(()=>{if(!ref.current||unsafe)return;const root=ref.current,chart=init(root,undefined,{renderer:'svg'}),probe=document.createElement('span');root.append(probe);probe.style.color='var(--color-text)';const text=getComputedStyle(probe).color;probe.style.color='var(--color-border)';const border=getComputedStyle(probe).color;probe.remove();
 const units=[...new Set(series.map(s=>s.unit))],names={money:'₽',count:'Операций',percent:'%'},labels=result.points.map(p=>pointLabel(p,widget.grouping,result.granularity));
 const kind=result.chart==='donut'&&series.length===1&&widget.grouping!=='time'&&!series.some(s=>s.values.some(v=>v!==null&&Number(v)<0))?'donut':result.chart==='line'?'line':'bar';
 const plots=series.map((s,i)=>{const color=chartPalette[(index+i)%50],mixed=units.length>1,type=kind==='donut'?'pie':mixed&&s.unit!=='money'?'line':kind;return {id:s.key,name:s.name,type,...(kind==='donut'?{radius:['42%','70%']}:{yAxisIndex:units.indexOf(s.unit)}),data:s.values.map((v,n)=>({value:v===null?null:Number(v)/(s.unit==='money'?100:1),name:labels[n],itemStyle:{color:series.length===1?chartPalette[n%50]:color,opacity:s.previous?.45:1}})),connectNulls:false,symbolSize:7,lineStyle:{color,type:s.previous?'dashed':'solid'},itemStyle:{color},label:{show:false}};});
 const option:EChartsCoreOption={animation:!matchMedia('(prefers-reduced-motion: reduce)').matches,color:[...chartPalette],animationDuration:180,textStyle:{color:text,fontFamily:'system-ui'},aria:{enabled:true,label:{description:widget.name+'. '+result.analysis}},tooltip:{trigger:'axis',renderMode:'richText',confine:true},legend:{show:series.length>1,type:'scroll',top:0,textStyle:{color:text}},grid:{left:12,right:units.length>1?45:20,top:series.length>1?50:30,bottom:35,containLabel:true},...(kind==='donut'?{tooltip:{trigger:'item',renderMode:'richText',confine:true}}:{xAxis:{type:'category',data:labels,axisLabel:{color:text,overflow:'truncate',width:80,rotate:result.points.length>12?40:0},axisLine:{lineStyle:{color:border}}},yAxis:units.map((unit,i)=>({type:'value',name:names[unit],position:i===0?'left':'right',...(unit==='count'?{minInterval:1}:{}),axisLabel:{color:text,formatter:(v:number)=>v.toLocaleString('ru-RU')},splitLine:{show:i===0,lineStyle:{color:border}}}))}),series:plots};chart.setOption(option);root.querySelectorAll('svg').forEach(svg=>svg.setAttribute('aria-hidden','true'));chart.on('click',(p:unknown)=>{const n=(p as {dataIndex?:number}).dataIndex;if(n!==undefined&&result.points[n])click.current(result.points[n]!);});const observer=new ResizeObserver(()=>chart.resize());observer.observe(root);return()=>{observer.disconnect();chart.dispose();};
 },[widget,result,series,appearance,unsafe,index]);
 return unsafe?<p>Точные большие значения доступны в таблице «Все значения».</p>:<div ref={ref} className={styles.chart} role="img" aria-label={widget.name+'. '+series.map(s=>s.name).join(', ')+'. '+result.analysis}/>;
}
