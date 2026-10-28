import {object,choice,uuid,dateFact,operationDay} from './model.ts';
import {safeText} from '../../privacy/src/text.ts';
import {parseOperationsFilter,periodFilter,queryOperations,operationPartMatches} from './operations.ts';
import type {OperationsFilter,OperationRow,OperationsCatalog,OperationsView} from './operations.ts';
import {metrics,metricMatches,metricAmount} from './metrics.ts';
import type {Metric} from './metrics.ts';
import {calculateBudget,calendarDay} from './budgets.ts';
import type {Budget} from './budgets.ts';
export {metrics};export type {Metric};
export const groupings=['time','category','subcategory','account','bank','kind','role','counterparty','merchant','operation','none'] as const;
export const granularities=['auto','day','week','month','quarter','year'] as const;
export const chartTypes=['bar','line','donut','table'] as const;
export const periods=['global','all','fixed','current_month','previous_month','last_30_days'] as const;
export type Comparison={kind:'none'|'previous_same'|'previous_month'|'previous_year'}|{kind:'custom';from:string;through:string};
export type Widget={id:string;name:string;metrics:Metric[];grouping:typeof groupings[number];granularity:typeof granularities[number];period:typeof periods[number];filter:OperationsFilter;comparison:Comparison;topN:number;sort:'amount'|'label';direction:'asc'|'desc';chart:typeof chartTypes[number];graph:boolean;text:boolean;labels:boolean;legend:boolean;excludedCategoryIds:string[];budgetIds:string[]};
export type LayoutItem={id:string;width:1|2;size:'compact'|'regular'|'tall';hidden:boolean};
export type OverviewView={filter:OperationsFilter;period:Exclude<Widget['period'],'global'>;widgets:Widget[];desktop:LayoutItem[];mobile:LayoutItem[]};
export type OverviewCatalog=OperationsCatalog&{budgets?:Budget[]};
const day=(v:unknown)=>(dateFact({precision:'day',date:v}) as {date:string}).date;
const abs=(v:bigint)=>v<0n?-v:v;
const date=(v:string)=>new Date(v+'T00:00:00Z');
const iso=(v:Date)=>day(v.toISOString().slice(0,10));
const addDays=(v:string,n:number)=>{const d=date(v);d.setUTCDate(d.getUTCDate()+n);return iso(d);};
const daysBetween=(a:string,b:string)=>Math.round((date(b).getTime()-date(a).getTime())/86400000);
function strings(v:unknown,max=100){if(!Array.isArray(v)||v.length>max)throw new TypeError('INVALID_IDS');const result=v.map(uuid);if(new Set(result).size!==result.length)throw new TypeError('DUPLICATE_IDS');return result;}
function boolean(v:unknown,fallback:boolean){if(v===undefined)return fallback;if(typeof v!=='boolean')throw new TypeError('INVALID_BOOLEAN');return v;}
export function parseComparison(v:unknown):Comparison{const r=object(v??{kind:'none'},['kind','from','through']),kind=choice(r.kind,['none','previous_same','previous_month','previous_year','custom']);if(kind==='custom'){const from=day(r.from),through=day(r.through);if(from>through)throw new TypeError('INVALID_RANGE');return {kind,from,through};}object(r,['kind']);return {kind};}
export function parseWidget(v:unknown):Widget{
 const r=object(v,['id','name','metrics','grouping','granularity','period','filter','comparison','topN','sort','direction','chart','graph','text','labels','legend','excludedCategoryIds','budgetIds']);
 const name=safeText(r.name,160).trim();if(!name)throw new TypeError('EMPTY_NAME');if(!Array.isArray(r.metrics)||!r.metrics.length||r.metrics.length>3)throw new TypeError('INVALID_METRICS');const selected=r.metrics.map(m=>choice(m,metrics));if(new Set(selected).size!==selected.length||selected.includes('budget')&&selected.length!==1)throw new TypeError('INVALID_METRICS');
 const graph=boolean(r.graph,true),text=boolean(r.text,true);if(!graph&&!text)throw new TypeError('DISPLAY_REQUIRED');
 const topN=r.topN??10;if(typeof topN!=='number'||!Number.isInteger(topN)||topN<1||topN>50)throw new TypeError('INVALID_TOP');
 const filter=parseOperationsFilter(r.filter??{}),period=choice(r.period??'global',periods);if(period==='fixed'&&(!filter.from||!filter.through))throw new TypeError('FIXED_PERIOD_REQUIRED');
 // A local metric is chosen separately; accepting it in filters would produce inconsistent charts.
 if(filter.metric)throw new TypeError('METRIC_FILTER_CONFLICT');
 return {id:uuid(r.id),name,metrics:selected,grouping:choice(r.grouping??'category',groupings),granularity:choice(r.granularity??'auto',granularities),period,filter,comparison:parseComparison(r.comparison),topN,sort:choice(r.sort??'amount',['amount','label']),direction:choice(r.direction??'desc',['asc','desc']),chart:choice(r.chart??'bar',chartTypes),graph,text,labels:boolean(r.labels,false),legend:boolean(r.legend,true),excludedCategoryIds:strings(r.excludedCategoryIds??[]),budgetIds:strings(r.budgetIds??[])};
}
export function parseOverviewView(v:unknown):OverviewView{
 const r=object(v,['filter','period','widgets','desktop','mobile']),filter=parseOperationsFilter(r.filter??{}),period=choice(r.period??'all',['all','fixed','current_month','previous_month','last_30_days']);if(filter.metric)throw new TypeError('METRIC_FILTER_CONFLICT');if(period==='fixed'&&(!filter.from||!filter.through))throw new TypeError('FIXED_PERIOD_REQUIRED');if(period!=='fixed'){delete filter.from;delete filter.through;}
 if(!Array.isArray(r.widgets)||r.widgets.length>30)throw new TypeError('INVALID_WIDGETS');const widgets=r.widgets.map(parseWidget),ids=widgets.map(w=>w.id);if(new Set(ids).size!==ids.length)throw new TypeError('DUPLICATE_WIDGETS');
 const layout=(v:unknown,mobile=false):LayoutItem[]=>{if(!Array.isArray(v)||v.length!==widgets.length)throw new TypeError('INVALID_LAYOUT');const result=v.map(v=>{const i=object(v,['id','width','size','hidden']),id=uuid(i.id);if(!ids.includes(id)||![1,2].includes(i.width as number)||mobile&&i.width!==1)throw new TypeError('INVALID_LAYOUT');return {id,width:i.width as 1|2,size:choice(i.size,['compact','regular','tall']),hidden:boolean(i.hidden,false)};});if(new Set(result.map(i=>i.id)).size!==ids.length)throw new TypeError('INVALID_LAYOUT');return result;};
 return {filter,period,widgets,desktop:layout(r.desktop),mobile:layout(r.mobile,true)};
}
export function overviewPeriod(filter:OperationsFilter,period:OverviewView['period'],now:Date,timezone:string):OperationsFilter{const f={...filter};if(period!=='fixed'){delete f.from;delete f.through;}return periodFilter({filter:f,period} as OperationsView,now,timezone);}
function shiftMonth(v:string,n:number){const d=date(v),original=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+n);const end=new Date(d);end.setUTCMonth(end.getUTCMonth()+1,0);d.setUTCDate(Math.min(original,end.getUTCDate()));return iso(d);}
export function comparisonWindow(c:Comparison,f:OperationsFilter):{from:string;through:string}|null{
 if(c.kind==='none')return null;if(c.kind==='custom')return {from:c.from,through:c.through};if(!f.from||!f.through)return null;
 if(c.kind==='previous_same'){const n=daysBetween(f.from,f.through)+1;return {from:addDays(f.from,-n),through:addDays(f.through,-n)};}
 const n=c.kind==='previous_year'?-12:-1;return {from:shiftMonth(f.from,n),through:shiftMonth(f.through,n)};
}
export function percentageChange(current:string,previous:string):string|null{const a=BigInt(current),b=BigInt(previous);if(b<=0n)return null;const n=(a-b)*10000n/b,negative=n<0n,s=abs(n);return `${negative?'-':''}${s/100n}.${(s%100n).toString().padStart(2,'0')}`;}
export type OverviewPoint={key:string;label:string;values:Partial<Record<Metric,string>>;previous:Partial<Record<Metric,string>>;filter:OperationsFilter;previousFilter:OperationsFilter|null;operationId?:string;budget?:ReturnType<typeof calculateBudget>&{id:string;name:string;enabled:boolean;dependencyStatus:string}};
export type WidgetResult={id:string;filter:OperationsFilter;comparisonFilter:OperationsFilter|null;granularity:string;points:OverviewPoint[];totals:Partial<Record<Metric,string>>;previousTotals:Partial<Record<Metric,string>>;operationCount:number;previousOperationCount:number;groupCount:number;chart:Widget['chart'];chartNotice:string|null;analysis:string;warning:string|null};
const measure=(rows:OperationRow[],selected:Metric[],includeExcluded:boolean)=>{const totals:Partial<Record<Metric,bigint>>={};for(const m of selected){let n=0n;for(const o of rows){const parts=o.parts.filter(p=>(p.included||includeExcluded||m==='attention'||m==='operation_count')&&metricMatches(m,p,o));n+=m==='operation_count'||m==='attention'?(parts.length?1n:0n):parts.reduce((s,p)=>s+metricAmount(m,p,o),0n);}totals[m]=n;}return Object.fromEntries(Object.entries(totals).map(([m,n])=>[m,String(n)])) as Partial<Record<Metric,string>>;};
const format=(v:string)=>{const n=BigInt(v),s=abs(n);return `${n<0n?'−':''}${(s/100n).toLocaleString('ru-RU')}${s%100n?','+(s%100n).toString().padStart(2,'0'):''} ₽`;};
export const metricNames:Record<Metric,string>={expenses:'Расходы',gross_expenses:'Расходы до возвратов',income:'Доходы',difference:'Разница',refunds:'Возвраты',reimbursements:'Компенсации расходов',expense_reductions:'Возвраты и компенсации',own_transfers:'Собственные переводы (исходящие части)',transfers:'Переводы (поступления минус списания)',loan_payments:'Платежи по кредитам',loan_costs:'Стоимость кредитов',fees:'Комиссии',cash:'Наличные (внесения минус снятия)',operation_count:'Количество операций',attention:'Требуют внимания',budget:'Бюджеты'};
function bucketWindow(at:string,g:string){const d=date(at);if(g==='week')d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);else if(g==='month')d.setUTCDate(1);else if(g==='quarter'){d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()-d.getUTCMonth()%3);}else if(g==='year'){d.setUTCDate(1);d.setUTCMonth(0);}const from=iso(d),next=g==='day'?addDays(from,1):g==='week'?addDays(from,7):shiftMonth(from,g==='month'?1:g==='quarter'?3:12);return {from,through:addDays(next,-1),next};}
function granularity(w:Widget,f:OperationsFilter){if(w.granularity!=='auto')return w.granularity;const n=f.from&&f.through?daysBetween(f.from,f.through):99999;return n<=60?'day':n<=210?'week':n<=1460?'month':n<=3650?'quarter':'year';}
const clipped=(a:string|undefined,b:string,maximum:boolean)=>a?(maximum?(a>b?a:b):(a<b?a:b)):b;
function selectedRows(rows:OperationRow[],catalog:OperationsCatalog,f:OperationsFilter,excludedIds:string[]){const filter={...f,...(excludedIds.length?{excludedCategoryIds:[...new Set([...(f.excludedCategoryIds??[]),...excludedIds])]}:{})};const found=queryOperations(rows,catalog,{filter,sort:'date',direction:'asc',group:'none'}).operations;return found.map(o=>({...o,parts:o.parts.filter(p=>operationPartMatches(p,o,filter))})).filter(o=>o.parts.length);}
export function calculateWidget(w:Widget,rows:OperationRow[],catalog:OverviewCatalog,global:OperationsFilter,now=new Date(),timezone='Europe/Moscow'):WidgetResult{
 let filter:OperationsFilter={...global,...w.filter,...(w.excludedCategoryIds.length?{excludedCategoryIds:[...new Set([...(w.filter.excludedCategoryIds??global.excludedCategoryIds??[]),...w.excludedCategoryIds])]}:{})};if(w.period!=='global')filter=overviewPeriod(filter,w.period,now,timezone);
 if(w.metrics[0]==='budget'){
  const at=filter.through??calendarDay(now,timezone),budgets=(catalog.budgets??[]).filter(b=>(w.budgetIds.length?w.budgetIds.includes(b.id):b.enabled));
  const points:OverviewPoint[]=budgets.map(b=>{const calculation=calculateBudget(b,rows,catalog,at);return {key:b.id,label:b.name,values:{budget:calculation.indicator?.usedMinor??'0'},previous:{},filter:calculation.filter,previousFilter:null,budget:{...calculation,id:b.id,name:b.name,enabled:b.enabled,dependencyStatus:b.dependencyStatus}};});
  return {id:w.id,filter,comparisonFilter:null,granularity:'none',points:points.slice(0,w.topN),totals:{},previousTotals:{},operationCount:0,previousOperationCount:0,groupCount:points.length,chart:'table',chartNotice:null,analysis:'Каждый бюджет использует свои условия и период на '+at+'. Общие фильтры не меняют условия бюджета. Расходы разных бюджетов не складываются; остаток не переносится.',warning:w.budgetIds.some(id=>!(catalog.budgets??[]).some(b=>b.id===id))?'Выбранный бюджет удалён. Проверьте настройки виджета.':null};
 }
 const comparison=comparisonWindow(w.comparison,filter),previousFilter=comparison?{...filter,...comparison}:null,current=selectedRows(rows,catalog,filter,w.excludedCategoryIds),previous=previousFilter?selectedRows(rows,catalog,previousFilter,w.excludedCategoryIds):[],g=granularity(w,filter),category=new Map(catalog.categories.map(c=>[c.id,c.name])),accounts=new Map(catalog.accounts.map(a=>[a.id,a])),parties=new Map(catalog.counterparties.map(p=>[p.id,p.name]));
 type Bucket={key:string;label:string;rows:Map<string,OperationRow>;filter:OperationsFilter};
 const group=(input:OperationRow[],f:OperationsFilter)=>{
  const buckets=new Map<string,Bucket>();
  const insert=(key:string,label:string,op:OperationRow|null,part:OperationRow['parts'][number]|null,context:OperationsFilter)=>{let b=buckets.get(key);if(!b){b={key,label,rows:new Map(),filter:context};buckets.set(key,b);}if(op&&part){const own=b.rows.get(op.id)??{...op,parts:[]};own.parts.push(part);b.rows.set(op.id,own);}};
  for(const op of input)for(const p of op.parts){if(!w.metrics.some(m=>metricMatches(m,p,op)))continue;let key='',label='Всего',context={...f};
   switch(w.grouping){
    case 'time':{const window=bucketWindow(operationDay(op.date),g);key=window.from;label=window.from;context={...f,from:clipped(f.from,window.from,true),through:clipped(f.through,window.through,false)};break;}
    case 'category':key=p.categoryId??'uncategorized';label=category.get(key)??'Без категории';context={...f,...(p.categoryId?{categoryIds:[p.categoryId]}:{uncategorized:true})};break;
    case 'subcategory':key=p.subcategoryId??'no_subcategory';label=category.get(key)??'Без подкатегории';context={...f,...(p.subcategoryId?{subcategoryIds:[p.subcategoryId]}:{noSubcategory:true})};break;
    case 'account':key=op.accountId;label=accounts.get(key)?.name??'Счёт';context={...f,accountIds:[key]};break;
    case 'bank':key=accounts.get(op.accountId)?.bankId??'';label=key;context={...f,bankId:key};delete context.accountIds;if(f.accountIds)context.accountIds=f.accountIds.filter(id=>accounts.get(id)?.bankId===key);break;
    case 'kind':key=op.classification.kind.value;label=key;context={...f,kind:key};break;
    case 'role':key=p.role;label=key;context={...f,role:key};break;
    case 'counterparty':key=op.classification.counterparty.value??'no_counterparty';label=parties.get(key)??'Без контрагента';context={...f,...(op.classification.counterparty.value?{counterpartyIds:[key]}:{noCounterparty:true})};break;
    case 'merchant':key=op.classification.merchant.value;label=op.displayName?.title||key||'Без получателя';context={...f,merchant:key,merchantExact:true};break;
    case 'operation':key=op.id;label=op.displayName?.compositeLabel||op.classification.merchant.value||'Операция';context={...f,operationIds:[key]};break;
    case 'none':break;
   }
   insert(key,label,op,p,context);
  }
  // Zero buckets retain gaps. For very long explicit ranges, fall back to observed buckets.
  if(w.grouping==='time'&&f.from&&f.through){let at=bucketWindow(f.from,g).from,steps=0;const windows:ReturnType<typeof bucketWindow>[]=[];while(at<=f.through&&steps++<=370){const window=bucketWindow(at,g);windows.push(window);at=window.next;}if(steps<=370)for(const window of windows)insert(window.from,window.from,null,null,{...f,from:clipped(f.from,window.from,true),through:clipped(f.through,window.through,false)});}
  return [...buckets.values()].sort((a,b)=>a.key.localeCompare(b.key));
 };
 const a=group(current,filter),b=previousFilter?group(previous,previousFilter):[],comparisonByKey=new Map(b.map(p=>[p.key,p])),result:OverviewPoint[]=[];
 for(let i=0;i<a.length;i++){const point=a[i]!,prev=w.grouping==='time'?b[i]:comparisonByKey.get(point.key);if(prev)comparisonByKey.delete(prev.key);result.push({key:point.key,label:point.label,values:measure([...point.rows.values()],w.metrics,filter.includeExcluded===true),previous:measure([...(prev?.rows.values()??[])],w.metrics,filter.includeExcluded===true),filter:{...point.filter,...(w.metrics.length===1?{metric:w.metrics[0]}:{})},previousFilter:prev?{...prev.filter,...(w.metrics.length===1?{metric:w.metrics[0]}:{})}:null,...(w.grouping==='operation'?{operationId:point.key}:{})});}
 if(w.grouping!=='time')for(const prev of comparisonByKey.values())result.push({key:prev.key,label:prev.label,values:measure([],w.metrics,false),previous:measure([...prev.rows.values()],w.metrics,filter.includeExcluded===true),filter:{...prev.filter,...(filter.from?{from:filter.from}:{}),...(filter.through?{through:filter.through}:{}),...(w.metrics.length===1?{metric:w.metrics[0]}:{})},previousFilter:{...prev.filter,...(w.metrics.length===1?{metric:w.metrics[0]}:{})}});
 const first=w.metrics[0]!,sorted=w.grouping==='time'?result:result.sort((a,b)=>{if(w.sort==='label')return (w.direction==='desc'?-1:1)*a.label.localeCompare(b.label,'ru');const x=BigInt(a.values[first]??'0'),y=BigInt(b.values[first]??'0');return (w.direction==='desc'?-1:1)*(x<y?-1:x>y?1:0)||a.key.localeCompare(b.key);});
 const totals=measure(current,w.metrics,filter.includeExcluded===true),previousTotals=measure(previous,w.metrics,filter.includeExcluded===true),unit=(m:Metric,n:string)=>['operation_count','attention'].includes(m)?n+' операций':format(n),n=totals[first]??'0',prior=previousTotals[first]??'0',change=percentageChange(n,prior);
 let analysis=w.metrics.map(m=>metricNames[m]+': '+unit(m,totals[m]??'0')).join('. ')+'. Операций в контексте: '+current.length+'.';if(previousFilter&&previous.length===0)analysis+=' В периоде сравнения нет операций по условиям. Это не подтверждает отсутствие расходов; процент не рассчитывается.';else if(previousFilter)analysis+=' Сравнение: '+unit(first,prior)+'. Изменение: '+unit(first,(BigInt(n)-BigInt(prior)).toString())+(change===null?' (процент не рассчитывается при нулевой или отрицательной базе).':' ('+change.replace('.',',')+'%).');
 const countMetric=w.metrics.some(m=>['operation_count','attention'].includes(m)),moneyMetric=w.metrics.some(m=>!['operation_count','attention'].includes(m)),negative=result.some(p=>w.metrics.some(m=>BigInt(p.values[m]??'0')<0n));let chart=w.chart,chartNotice:string|null=null;
 if(w.chart==='donut'&&(negative||w.metrics.length!==1||previousFilter||w.grouping==='time')){chart='bar';chartNotice='Для отрицательных значений, сравнения или нескольких метрик используется столбчатый график.';}if(countMetric&&moneyMetric){chart='table';chartNotice='Деньги и количество показаны таблицей с отдельными единицами.';}
 const points=w.grouping==='time'?sorted:sorted.slice(0,w.topN);if(w.grouping==='time'&&points.length>370){chart='table';chartNotice='Слишком много интервалов. Увеличьте шаг времени; показаны последние 370 интервалов.';points.splice(0,points.length-370);}
 if(w.grouping!=='time'&&result.length>points.length)analysis+=' Показаны '+points.length+' из '+result.length+' групп. Итог учитывает все группы.';
 return {id:w.id,filter,comparisonFilter:previousFilter,granularity:g,points,totals,previousTotals,operationCount:current.length,previousOperationCount:previous.length,groupCount:result.length,chart,chartNotice,analysis,warning:w.comparison.kind!=='none'&&!previousFilter?'Для этого сравнения задайте начало и конец периода.':null};
}
export function calculateOverview(rows:OperationRow[],catalog:OverviewCatalog,filter:OperationsFilter,widgets:Widget[],now=new Date(),timezone='Europe/Moscow'){
 const f={...filter},result=queryOperations(rows,catalog,{filter:f,sort:'date',direction:'desc',group:'none'}),selected=selectedRows(rows,catalog,f,[]),totals=measure(selected,['refunds','reimbursements'],f.includeExcluded===true);
 return {filter:f,workspaceTotal:rows.length,summary:{...result.summary,operationIds:[],attentionIds:[],operationCount:result.total,attentionCount:result.summary.attentionIds.length,refundsMinor:totals.refunds??'0',reimbursementsMinor:totals.reimbursements??'0'},widgets:widgets.map(w=>calculateWidget(w,rows,catalog,f,now,timezone))};
}
export function defaultOverview():OverviewView{
 const specs:[string,Metric,Widget['grouping'],Widget['chart']][]=[['Расходы по категориям','expenses','category','bar'],['Доходы по категориям','income','category','bar'],['Динамика расходов','expenses','time','line'],['Сравнение периодов','expenses','category','bar'],['Крупнейшие категории','expenses','category','bar'],['Крупнейшие операции','expenses','operation','table'],['Бюджеты','budget','none','table'],['Требуют внимания','attention','category','table'],['Крупнейшие получатели','expenses','merchant','bar']];
 const widgets=specs.map(([name,metric,grouping,chart],index)=>parseWidget({id:'10000000-0000-4000-8000-'+String(index+1).padStart(12,'0'),name,metrics:[metric],grouping,chart,topN:index===4?5:10,...(index===3?{comparison:{kind:'previous_same'}}:{})}));const desktop=widgets.map(w=>({id:w.id,width:1 as const,size:'regular' as const,hidden:false}));return {filter:{},period:'all',widgets,desktop,mobile:desktop.map(i=>({...i}))};
}
