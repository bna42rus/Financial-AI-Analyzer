import {object,choice,uuid} from '../../finance-core/src/model.ts';
import {parseOperationsFilter} from '../../finance-core/src/operations.ts';
import type {OperationsFilter} from '../../finance-core/src/operations.ts';
import {safeText} from '../../privacy/src/text.ts';

export const registryVersion='analyzer/1';
export const registry=[
 {name:'query_finances',version:1,principal:'owner',access:'active_entitlement',scope:'filtered_current_finances',confirmation:'none'},
 {name:'set_inclusion',version:1,principal:'owner',access:'active_entitlement',scope:'fixed_answer_operations',confirmation:'preview_then_explicit_commit'},
] as const;
export type Query={name:'query_finances';metric:'expenses'|'income'|'attention';grouping:'none'|'category'|'operation';comparison:'none'|'previous_same';filter:OperationsFilter};
export type Tool=Query|{name:'set_inclusion';answerId:string;value:'include'|'exclude'};
export function parseTool(value:unknown):Tool {
 const r=object(value,['name','metric','grouping','comparison','filter','answerId','value']);
 if(r.name==='set_inclusion'){object(value,['name','answerId','value']);return {name:r.name,answerId:uuid(r.answerId),value:choice(r.value,['include','exclude'])};}
 object(value,['name','metric','grouping','comparison','filter']);if(r.name!=='query_finances')throw new TypeError('UNKNOWN_ANALYZER_TOOL');
 const filter=parseOperationsFilter(r.filter??{});if(filter.metric)throw new TypeError('METRIC_FILTER_CONFLICT');
 return {name:r.name,metric:choice(r.metric,['expenses','income','attention']),grouping:choice(r.grouping??'none',['none','category','operation']),comparison:choice(r.comparison??'none',['none','previous_same']),filter};
}
export type Relevance='financial'|'adjacent'|'ambiguous'|'unrelated';
export type Interpretation={relevance:Relevance;query?:Query;periodFromQuestion:boolean;followUp:boolean};
const months=['январ','феврал','март','апрел','ма[йя]','июн','июл','август','сентябр','октябр','ноябр','декабр'];
/** Finite deterministic commands are explicitly separate from an AI classifier. */
export function interpret(text:string,global:OperationsFilter,context?:Query,now=new Date()):Interpretation {
 const q=safeText(text,2000).toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[?!.,]+$/g,'').trim();
 const financial=/(расход|доход|потрат|деньг|операци|категори|кредит|вклад|счет|банк|финанс|ставк|курс|налог|тариф|бюджет)/u.test(q);
 const followUp=/^а (по категориям|за .+)$/u.test(q);
 let metric:Query['metric']='expenses',grouping:Query['grouping']='none',comparison:Query['comparison']='none';
 let stem=q;
 const date=/ за (\d{4}-\d{2}-\d{2}) (?:по|—|до) (\d{4}-\d{2}-\d{2})$/u.exec(q);
 const month=new RegExp(' за ('+months.map(m=>m+'[а-я]*').join('|')+')(?: (20\\d{2}))?$','u').exec(q);
 const periodSuffix=date?.[0]??month?.[0];if(periodSuffix)stem=q.slice(0,-periodSuffix.length);
 if(followUp&&context){metric=context.metric;grouping=stem==='а по категориям'?'category':context.grouping;comparison=context.comparison;}
 else if(/^(сколько я потратил(?: за выбранный период)?|мои расходы|покажи расходы)$/u.test(stem)){}
 else if(/^(на что ушли деньги|расходы по категориям|покажи расходы по категориям)$/u.test(stem))grouping='category';
 else if(/^(мои доходы|покажи доходы|сколько я заработал)$/u.test(stem))metric='income';
 else if(/^(какие операции требуют внимания|операции требуют внимания|покажи операции для проверки)$/u.test(stem)){metric='attention';grouping='operation';}
 else if(/^(покажи крупные расходы|крупнейшие расходы)$/u.test(stem))grouping='operation';
 else if(/^сравни расходы с предыдущим периодом$/u.test(stem))comparison='previous_same';
 else return {relevance:followUp||q.length<8?'ambiguous':financial?'financial':'unrelated',periodFromQuestion:false,followUp:false};
 let filter:OperationsFilter=structuredClone(followUp&&context?context.filter:global);
 if(date)filter={...filter,from:date[1],through:date[2]};
 if(month){const n=months.findIndex(m=>new RegExp('^'+m).test(month[1]!)),year=Number(month[2]??new Intl.DateTimeFormat('en',{timeZone:'Europe/Moscow',year:'numeric'}).format(now));filter={...filter,from:`${year}-${String(n+1).padStart(2,'0')}-01`,through:new Date(Date.UTC(year,n+1,0)).toISOString().slice(0,10)};}
 filter=parseOperationsFilter(filter);
 if(comparison!=='none'&&(!filter.from||!filter.through))return {relevance:'ambiguous',periodFromQuestion:false,followUp:false};
 return {relevance:'financial',query:{name:'query_finances',metric,grouping,comparison,filter},periodFromQuestion:!!periodSuffix,followUp};
}
/** No provider SQL, transcripts, credentials or transaction dump in this contract. */
export interface AnalyzerAdapter {readonly id:string;readonly model:string;readonly version:string;plan(input:{text:string;context?:Query;query:Query;registryVersion:string}):Promise<{tool:unknown;inputTokens:number;outputTokens:number}>}
export function tokenUsage(value:unknown){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>1000000)throw new TypeError('INVALID_PROVIDER_USAGE');return value;}
