import {object,choice,uuid,dateFact,operationDay,kinds} from './model.ts';
import type {BankDate,Semantics,Account,Category} from './model.ts';
import {parsePersistedMinor} from './money.ts';
import {aggregate} from './graph.ts';
import type {Projection} from './graph.ts';
import {reviewStatus} from './review.ts';
import {safeText} from '../../privacy/src/text.ts';
export const operationColumns=['date','merchant','amount','account','kind','role','category','status','bank','subcategory','counterparty','comment','confidence','source','rule','postedDate','inclusion','import','bankCategory','id'] as const;
export type Column=typeof operationColumns[number];
export const defaultColumns:Column[]=['date','merchant','amount','account','kind','role','category','status'];
export const sortFields=['date','amount','merchant','category','confidence','status'] as const;
export const groupFields=['none','date','category','subcategory','merchant','counterparty','account','kind'] as const;
export type OperationsFilter={from?:string;through?:string;accountIds?:string[];bankId?:string;categoryIds?:string[];subcategoryIds?:string[];kind?:string;role?:string;amountFrom?:string;amountThrough?:string;search?:string;merchant?:string;counterpartyIds?:string[];reason?:string;status?:string;facet?:'kind'|'role'|'category'|'subcategory';confidenceFrom?:number;confidenceThrough?:number;source?:string;inclusion?:'any'|'included'|'excluded';includeExcluded?:boolean;refund?:boolean;transfer?:boolean;linked?:boolean;comment?:string;ruleId?:string;postedFrom?:string;postedThrough?:string;batchId?:string;fileId?:string;possibleDuplicate?:boolean;attention?:boolean;uncategorized?:boolean;operationIds?:string[]};
export type OperationsQuery={filter:OperationsFilter;sort:typeof sortFields[number];direction:'asc'|'desc';group:typeof groupFields[number]};
export type OperationsView={filter:OperationsFilter;period:'all'|'fixed'|'current_month'|'previous_month'|'last_30_days';columns:Column[];widths:Partial<Record<Column,number>>;sort:OperationsQuery['sort'];direction:OperationsQuery['direction'];group:OperationsQuery['group'];density:'comfortable'|'compact'};
export type OperationRow=Projection&{classification:Semantics;comment:string;description?:string;reviewStatus?:ReturnType<typeof reviewStatus>;postedDate?:BankDate|null;bankCategory?:string;imports?:{batchId:string;fileId:string}[];linked?:boolean;groupKey?:string};
export type OperationsCatalog={accounts:Account[];categories:Category[];counterparties:{id:string;name:string}[]};
function strings(value:unknown,max=100){if(!Array.isArray(value)||value.length>max)throw new TypeError('INVALID_FILTER');const ids=value.map(uuid);if(new Set(ids).size!==ids.length)throw new TypeError('DUPLICATE_FILTER');return ids;}
export function parseOperationsFilter(value:unknown):OperationsFilter{
 const r=object(value,['from','through','accountIds','bankId','categoryIds','subcategoryIds','kind','role','amountFrom','amountThrough','search','merchant','counterpartyIds','reason','status','facet','confidenceFrom','confidenceThrough','source','inclusion','includeExcluded','refund','transfer','linked','comment','ruleId','postedFrom','postedThrough','batchId','fileId','possibleDuplicate','attention','uncategorized','operationIds']),f:OperationsFilter={};
 for(const k of ['from','through','postedFrom','postedThrough'] as const)if(k in r)f[k]=(dateFact({precision:'day',date:r[k]}) as {date:string}).date;
 if(f.from&&f.through&&f.from>f.through||f.postedFrom&&f.postedThrough&&f.postedFrom>f.postedThrough)throw new TypeError('INVALID_RANGE');
 for(const k of ['accountIds','categoryIds','subcategoryIds','counterpartyIds','operationIds'] as const)if(k in r)f[k]=strings(r[k],k==='operationIds'?1000:100);
 for(const k of ['bankId','search','merchant','comment','reason'] as const)if(k in r)f[k]=safeText(r[k],k==='comment'?1000:160);
 for(const k of ['ruleId','batchId','fileId'] as const)if(k in r)f[k]=uuid(r[k]);
 for(const k of ['amountFrom','amountThrough'] as const)if(k in r){parsePersistedMinor(r[k]);f[k]=r[k] as string;}
 if(f.amountFrom!==undefined&&f.amountThrough!==undefined&&BigInt(f.amountFrom)>BigInt(f.amountThrough))throw new TypeError('INVALID_RANGE');
 if('kind' in r)f.kind=choice(r.kind,kinds);if('role' in r)f.role=choice(r.role,['expense','income','neutral','unresolved','mixed']);
 if('status' in r)f.status=choice(r.status,['none','recommended','required','verified']);if('facet' in r)f.facet=choice(r.facet,['kind','role','category','subcategory']);
 if('source' in r)f.source=choice(r.source,['user','personal_rule','global_rule','ai','bank','deterministic_system_rule']);
 if('inclusion' in r)f.inclusion=choice(r.inclusion,['any','included','excluded']);
 for(const k of ['confidenceFrom','confidenceThrough'] as const)if(k in r){if(typeof r[k]!=='number'||!Number.isInteger(r[k])||r[k]<0||r[k]>100)throw new TypeError('INVALID_CONFIDENCE');f[k]=r[k];}
 if(f.confidenceFrom!==undefined&&f.confidenceThrough!==undefined&&f.confidenceFrom>f.confidenceThrough)throw new TypeError('INVALID_RANGE');
 for(const k of ['includeExcluded','refund','transfer','linked','possibleDuplicate','attention','uncategorized'] as const)if(k in r){if(typeof r[k]!=='boolean')throw new TypeError('INVALID_BOOLEAN');f[k]=r[k];}
 return f;
}
export function parseOperationsQuery(value:unknown):OperationsQuery{const r=object(value,['filter','sort','direction','group']);return {filter:parseOperationsFilter(r.filter??{}),sort:choice(r.sort??'date',sortFields),direction:choice(r.direction??'desc',['asc','desc']),group:choice(r.group??'none',groupFields)};}
export function parseOperationsView(value:unknown):OperationsView{const r=object(value,['filter','period','columns','widths','sort','direction','group','density']),q=parseOperationsQuery({filter:r.filter??{},sort:r.sort,direction:r.direction,group:r.group});
 if(!Array.isArray(r.columns)||!r.columns.length||r.columns.length>operationColumns.length)throw new TypeError('INVALID_COLUMNS');const columns=r.columns.map(v=>choice(v,operationColumns));if(new Set(columns).size!==columns.length||!columns.includes('merchant'))throw new TypeError('INVALID_COLUMNS');
 const w=object(r.widths??{},[...operationColumns]),widths:OperationsView['widths']={};for(const k of Object.keys(w) as Column[]){const n=w[k];if(typeof n!=='number'||!Number.isInteger(n)||n<80||n>600)throw new TypeError('INVALID_WIDTH');widths[k]=n;}
 const period=choice(r.period??'all',['all','fixed','current_month','previous_month','last_30_days']);if(period==='fixed'&&(!q.filter.from||!q.filter.through))throw new TypeError('FIXED_PERIOD_REQUIRED');
 if(period!=='fixed'){delete q.filter.from;delete q.filter.through;}
 return {...q,period,columns,widths,density:choice(r.density??'comfortable',['comfortable','compact'])};
}
export function periodFilter(view:OperationsView,now=new Date(),timezone='Europe/Moscow'):OperationsFilter{const f={...view.filter};if(view.period==='fixed'||view.period==='all')return f;const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now),part=(type:string)=>parts.find(p=>p.type===type)!.value,day=part('year')+'-'+part('month')+'-'+part('day'),d=new Date(day+'T00:00:00Z'),format=(v:Date)=>v.toISOString().slice(0,10);
 if(view.period==='last_30_days'){f.through=day;d.setUTCDate(d.getUTCDate()-29);f.from=format(d);}else{if(view.period==='previous_month')d.setUTCMonth(d.getUTCMonth()-1,1);else d.setUTCDate(1);f.from=format(d);f.through=view.period==='current_month'?day:format(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)));}return f;}
const folded=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ru').trim();
export function queryOperations(rows:OperationRow[],catalog:OperationsCatalog,q:OperationsQuery){
 const f=q.filter,accounts=new Map(catalog.accounts.map(a=>[a.id,a])),categories=new Map(catalog.categories.map(c=>[c.id,c.name])),parties=new Map(catalog.counterparties.map(p=>[p.id,p.name])),selected=f.operationIds?new Set(f.operationIds):null;
 const contains=(value:string,text:string|undefined)=>text===undefined||folded(value).includes(folded(text));
 const facet=(o:OperationRow)=>o.classification[f.facet??'category'];
 const partMatches=(p:Projection['parts'][number])=>(f.uncategorized===undefined||(p.categoryId===null)===f.uncategorized)&&(!f.categoryIds||p.categoryId!==null&&f.categoryIds.includes(p.categoryId))&&(!f.subcategoryIds||p.subcategoryId!==null&&f.subcategoryIds.includes(p.subcategoryId))&&(!f.role||f.role==='mixed'||p.role===f.role)&&(!f.inclusion||f.inclusion==='any'||p.included===(f.inclusion==='included'));
 const found=rows.filter(o=>{const day=operationDay(o.date),posted=o.postedDate?operationDay(o.postedDate):null,s=o.classification,a=accounts.get(o.accountId),amount=BigInt(o.amountMinor);
 return (!selected||selected.has(o.id))&&(!f.from||day>=f.from)&&(!f.through||day<=f.through)&&(!f.accountIds||f.accountIds.includes(o.accountId))&&(!f.bankId||a?.bankId===f.bankId)&&(!f.kind||s.kind.value===f.kind)&&(!f.role||f.role!=='mixed'||o.analyticsRole==='mixed')&&o.parts.some(partMatches)&&
 (f.amountFrom===undefined||amount>=BigInt(f.amountFrom))&&(f.amountThrough===undefined||amount<=BigInt(f.amountThrough))&&contains(s.merchant.value,f.merchant)&&(!f.counterpartyIds||s.counterparty.value!==null&&f.counterpartyIds.includes(s.counterparty.value))&&(!f.reason||o.reviewReasons.includes(f.reason))&&(f.attention===undefined||!!o.reviewReasons.length===f.attention)&&(!f.status||(o.reviewStatus??reviewStatus(o.reviewReasons,s))===f.status)&&
 (f.confidenceFrom===undefined||facet(o).confidence>=f.confidenceFrom)&&(f.confidenceThrough===undefined||facet(o).confidence<=f.confidenceThrough)&&(!f.source||facet(o).source===f.source)&&(f.transfer===undefined||['transfer_in','transfer_out','own_transfer'].includes(s.kind.value)===f.transfer)&&(f.refund===undefined||['refund','expense_reimbursement','reversal'].includes(s.kind.value)===f.refund)&&(f.linked===undefined||!!o.linked===f.linked)&&contains(o.comment,f.comment)&&(!f.ruleId||Object.values(s).some(v=>v.ruleId===f.ruleId))&&
 (!f.postedFrom||posted!==null&&posted>=f.postedFrom)&&(!f.postedThrough||posted!==null&&posted<=f.postedThrough)&&(!f.batchId||!!o.imports?.some(i=>i.batchId===f.batchId&&(!f.fileId||i.fileId===f.fileId)))&&(!f.fileId||!!o.imports?.some(i=>i.fileId===f.fileId))&&(f.possibleDuplicate===undefined||o.reviewReasons.includes('possible_duplicate')===f.possibleDuplicate)&&
 contains([s.merchant.value,o.description??'',o.comment,a?.name??'',categories.get(s.category.value??'')??'',parties.get(s.counterparty.value??'')??''].join(' '),f.search);});
 const groupKey=(o:OperationRow)=>q.group==='date'?operationDay(o.date):q.group==='category'?[...new Set(o.parts.map(p=>p.categoryId?categories.get(p.categoryId)??'Без категории':'Без категории'))].sort().join(' / '):q.group==='subcategory'?[...new Set(o.parts.map(p=>p.subcategoryId?categories.get(p.subcategoryId)??'Без подкатегории':'Без подкатегории'))].sort().join(' / '):q.group==='merchant'?o.classification.merchant.value:q.group==='counterparty'?parties.get(o.classification.counterparty.value??'')??'Без контрагента':q.group==='account'?accounts.get(o.accountId)?.name??'Счёт':q.group==='kind'?o.classification.kind.value:'';
 const compare=(a:OperationRow,b:OperationRow)=>{if(q.sort==='amount'){const x=BigInt(a.amountMinor),y=BigInt(b.amountMinor);return x<y?-1:x>y?1:0;}if(q.sort==='confidence')return facet(a).confidence-facet(b).confidence;if(q.sort==='date'){const x=operationDay(a.date),y=operationDay(b.date);return x.localeCompare(y)||((a.date.precision==='instant'?a.date.instant:'').localeCompare(b.date.precision==='instant'?b.date.instant:''));}if(q.sort==='merchant')return a.classification.merchant.value.localeCompare(b.classification.merchant.value,'ru');if(q.sort==='category')return [...new Set(a.parts.map(p=>categories.get(p.categoryId??'')??''))].sort().join(' / ').localeCompare([...new Set(b.parts.map(p=>categories.get(p.categoryId??'')??''))].sort().join(' / '),'ru');return (a.reviewStatus??reviewStatus(a.reviewReasons,a.classification)).localeCompare(b.reviewStatus??reviewStatus(b.reviewReasons,b.classification));};
 const ordered=found.map(o=>({...o,groupKey:groupKey(o)})).sort((a,b)=>(q.group!=='none'?a.groupKey.localeCompare(b.groupKey,'ru'):0)||(q.direction==='desc'?-1:1)*compare(a,b)||a.id.localeCompare(b.id));
 // Filter terminal portions, after reconciliation against the entire graph. A mixed
 // operation's unmatched part must not leak into category/role/inclusion totals.
 const summary=aggregate(found.map(o=>({...o,parts:o.parts.filter(partMatches)})),{includeExcluded:f.includeExcluded===true});
 return {operations:ordered,summary,total:ordered.length};
}
