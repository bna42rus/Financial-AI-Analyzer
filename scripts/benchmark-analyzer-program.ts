/** Free synthetic core benchmark. No credentials, network, model, real rows or SQL. */
import {performance} from 'node:perf_hooks';
import {facet} from '../packages/finance-core/src/model.ts';
import type {OperationRow} from '../packages/finance-core/src/operations.ts';
import {parseWidget,calculateWidget} from '../packages/finance-core/src/overview.ts';
import {decorateAnalysis} from '../packages/analyzer/src/analysis.ts';
import type {Query} from '../packages/analyzer/src/registry.ts';
const id=(n:number)=>'00000000-0000-4000-8000-'+n.toString().padStart(12,'0');
const account=id(1),cat=id(2),catalog={accounts:[{id:account,bankId:'synthetic',name:'Synthetic',type:'bank_account' as const,analyticsEnabled:true,defaultVisible:true,loanMode:null}],categories:[{id:cat,name:'Synthetic',parentId:null,role:'expense' as const,hidden:false}],counterparties:[]};
function data(size:number):OperationRow[]{return Array.from({length:size},(_,i)=>({id:id(i+10),date:{precision:'day' as const,date:'2026-11-01'},accountId:account,amountMinor:'-100',analyticsRole:'expense' as const,decompositionActive:false,reviewReasons:[],unresolvedMinor:'0',neutralMinor:'0',excludedMinor:'0',parts:[{id:id(i+1000010),componentId:null,allocationId:null,amountMinor:'-100',role:'expense' as const,categoryId:cat,subcategoryId:null,basis:[],included:true}],classification:{kind:facet('purchase'),role:facet('expense'),category:facet(cat),subcategory:facet(null),merchant:facet('Synthetic '+i%10),counterparty:facet(null)},comment:''}));}
const q:Query={name:'query_finances',metric:'expenses',grouping:'merchant',comparison:'none',filter:{}};
const widget=parseWidget({id:id(3),name:'Synthetic',metrics:['expenses'],grouping:'merchant',filter:{},chart:'bar'});
function run(rows:OperationRow[]){const start=performance.now(),result=calculateWidget(widget,rows,catalog,{},new Date('2026-11-17T12:00:00Z'),'Europe/Moscow');const a=decorateAnalysis(q,rows,catalog,result);if(BigInt(a.sum)!==BigInt(rows.length)*100n)throw Error('BENCHMARK_TOTAL_MISMATCH');return Math.round((performance.now()-start)*100)/100;}
const percentile=(a:number[],p:number)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1];
const results=[];for(const size of [100,10000,100000]){const rows=data(size),cold=run(rows),warm=[run(rows),run(rows),run(rows)];results.push({operations:size,firstMs:cold,warmP50Ms:percentile(warm,.5),warmP95Ms:percentile(warm,.95)});}
const rows=data(10000),batches=[];for(const sessions of [1,5,20]){const start=performance.now();await Promise.all(Array.from({length:sessions},async()=>run(rows)));batches.push({sessions,totalMs:Math.round((performance.now()-start)*100)/100});}
console.log(JSON.stringify({version:1,paidModelCalls:0,costRub:'0',scope:'local synthetic CPU core only; no database, browser or model; promise batches share one JS thread',samplesPerSize:4,results,batches},null,2));
