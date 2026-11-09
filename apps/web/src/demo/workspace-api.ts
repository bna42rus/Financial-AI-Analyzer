import {aggregate,reconcile} from '../../../../packages/finance-core/src/graph';
import {facet,effective} from '../../../../packages/finance-core/src/model';
import type {Graph,Operation,Semantics,Category,Account,Link} from '../../../../packages/finance-core/src/model';
import {operationDisplayName} from '../../../../packages/finance-core/src/operation-name';
import {applyRules,ruleMatches,validateRule} from '../../../../packages/finance-core/src/rules';
import type {Rule} from '../../../../packages/finance-core/src/rules';
import {parseOperationsQuery,queryOperations} from '../../../../packages/finance-core/src/operations';
import type {OperationsFilter} from '../../../../packages/finance-core/src/operations';
import {calculateOverview,defaultOverview,parseWidget} from '../../../../packages/finance-core/src/overview';
import {budgetWindow,calendarDay,calculateBudget,parseBudgetDefinition} from '../../../../packages/finance-core/src/budgets';
import type {Budget} from '../../../../packages/finance-core/src/budgets';
import type {Chat,Answer} from '../../../../packages/analyzer/src/types';
import type {FinanceState,FinancePreview,FinanceReceipt,OperationPatch} from '../finance-client';
import {ApiError} from '../server-client';
import {formatMoney} from './overview';
import type {PartWrite,LinkIntent} from '../operation-relations';
import {demoGraph,demoParties,demoTimezone,monthStart} from './workspace-data';

type Views={id:string;name:string;definition:unknown;isDefault:boolean;dependencyStatus:'ready';revision:string;position:number;modifiedAt:string}[];
type Party=FinanceState['counterparties'][number];
type Sample={graph:Graph;rules:(Rule&{dependencyStatus:'ready'|'needs_setup'})[];parties:Party[];budgets:Budget[];views:{overview:Views;operations:Views}};
type Intent=Record<string,unknown>&{kind:string;id?:string};
type Entry={id:string;committed_at:string;revision:string;intent:Intent;operationIds:string[];changes:NonNullable<FinancePreview['impact']['changes']>;undoable:boolean;undone:boolean;rollbackStatus:string;before:Sample};
let sample:Sample, generation:string, revision:string, timezone:string, reviewId:string;
const previews=new Map<string,{revision:string;after:Sample;preview:FinancePreview;intent:Intent;undoneId?:string}>();
const receipts=new Map<string,FinanceReceipt>();
const history:Entry[]=[], chats=new Map<string,Chat>();
let skipped=new Set<string>();

export function resetDemo(){
 const graph=demoGraph();
 sample={graph,rules:[],parties:[{id:demoParties.landlord,name:'Арендодатель',state:'registered'},{id:demoParties.proposal,name:'Алексей К.',state:'discovered',hasBankIdentity:true,proposalCandidates:graph.operations.filter(op=>op.bankCounterpartyId===demoParties.proposal).map(op=>op.id)}],views:{overview:[],operations:[]},budgets:[{
  id:crypto.randomUUID(),name:'Продукты на месяц',enabled:true,dependencyStatus:'ready',revision:'1',
  definition:{filter:{categoryIds:[graph.categories[0]!.id]},period:{kind:'month'},basis:'net',timezone:demoTimezone},
  limits:[{from:monthStart(undefined,5),limitMinor:'2800000'}],
 }]};
 generation=crypto.randomUUID();revision='1';timezone=demoTimezone;reviewId=crypto.randomUUID();
 previews.clear();receipts.clear();chats.clear();history.length=0;skipped=new Set();
}
function fail(code='DEMO_UNAVAILABLE',message='Это действие доступно после входа в CashNeuro.'):never{throw new ApiError(code,message);}
function snapshot(data=sample,filter:OperationsFilter={}):FinanceState{
 const {graph,parties,rules}=data,projection=reconcile(graph);
 return {generation,revision,accounts:graph.accounts,mergedAccounts:[],categories:graph.categories,counterparties:parties,rules,
  loanMode:graph.loanMode,operationCount:graph.operations.length,summary:aggregate(projection.operations,filter),
  operations:projection.operations.map((row,i)=>{const op=graph.operations[i]!;return {...row,displayName:operationDisplayName(op,{counterparties:parties}),classification:op.semantics,comment:op.comment,description:op.source.description,postedDate:op.source.postedDate,bankCategory:op.source.bankCategory};})};
}
function changeOperation(op:Operation,patch:OperationPatch,verify:unknown){
 const keys={kind:'kind',role:'role',categoryId:'category',subcategoryId:'subcategory',merchant:'merchant',counterpartyId:'counterparty'} as const;
 for(const [field,target] of Object.entries(keys)){
  const value=patch[field as keyof typeof keys];
  if(value!==undefined)(op.semantics as unknown as Record<string,Semantics[keyof Semantics]>)[target]=facet(value,'user',true) as Semantics[keyof Semantics];
 }
 if(patch.categoryId!==undefined&&patch.subcategoryId===undefined)op.semantics.subcategory=facet(null,'user',true);
 if(patch.comment!==undefined)op.comment=patch.comment;
 if(patch.corrections!==undefined)op.corrections=patch.corrections;
 if(patch.analyticsOverride!==undefined)op.analyticsOverride=patch.analyticsOverride;
 if(patch.reviewRequested!==undefined||Array.isArray(verify)&&verify.length){
  op.reviewReasons=op.reviewReasons.filter(reason=>reason!=='user_requested_review');
  if(patch.reviewRequested)op.reviewReasons.push('user_requested_review');
 }
}
function replace<T extends {id:string}>(list:T[],row:T){const index=list.findIndex(item=>item.id===row.id);if(index===-1)list.push(row);else list[index]=row;}
function find<T extends {id:string}>(list:T[],id:unknown):T{return list.find(item=>item.id===id)??fail('NOT_FOUND','Запись не найдена.');}
function updateParts(graph:Graph,id:string,parts:PartWrite[]){
 const op=find(graph.operations,id);
 if(parts.length&&parts.reduce((sum,p)=>sum+BigInt(p.amountMinor),0n)!==BigInt(effective(op).amountMinor))fail('INVALID_COMPONENTS','Сумма частей должна совпадать с суммой операции.');
 graph.components=graph.components.filter(p=>p.transactionId!==id);
 graph.components.push(...parts.map(p=>({id:p.id,transactionId:id,type:p.type,amountMinor:p.amountMinor,role:facet(p.role??'unresolved','user',p.role!==undefined),category:facet(p.categoryId??null,'user',p.categoryId!==undefined),subcategory:facet(p.subcategoryId??null,'user',p.subcategoryId!==undefined)})));
 op.decomposition=parts.length>0;
}
function updateLink(graph:Graph,id:string,link:LinkIntent['link']){
 for(const reference of [link.sourceId,link.targetId])find(graph.operations,reference);
 replace(graph.links,{...link,id,createdBy:'user',confidence:100} as Link);
}
function ruleChange(data:Sample,op:Operation,id:string){
 const account=find(data.graph.accounts,effective(op).accountId),rule=find(data.rules,id);
 if(!rule.enabled||!ruleMatches(op,account,rule))return op;
 return applyRules(op,account,data.rules.filter(r=>r.enabled&&r.dependencyStatus==='ready'),id,data.graph.categories);
}
function makePreview(body:Record<string,unknown>){
 const actionId=String(body.actionId),existing=previews.get(actionId);
 if(existing)return existing.preview;
 if(body.generation!==generation||String(body.revision)!==revision)fail('FINANCE_CHANGED','Данные изменились. Откройте действие снова.');
 const intent=body.intent as Intent,id=String(intent.id??crypto.randomUUID());
 let data=structuredClone(sample),undoneId:string|undefined;
 const {graph}=data;
 const patch=(intent.patch??{}) as Record<string,unknown>;
 const ids=Array.isArray(intent.operationIds)?intent.operationIds.map(String):[id];
 let details:FinancePreview['impact']['details'];
 switch(intent.kind){
  case 'operation':case 'bulk_operations':
   for(const id of ids)changeOperation(find(graph.operations,id),patch as OperationPatch,intent.verify);
   if(intent.kind==='bulk_operations')details={kind:intent.kind,operationIds:ids,selectedCount:ids.length,patch,verify:intent.verify??[],atomic:true,remainingReviewIds:[],warnings:[]};
   break;
  case 'components':updateParts(graph,id,intent.parts as PartWrite[]);break;
  case 'link':updateLink(graph,id,intent.link as LinkIntent['link']);break;
  case 'operation_card':{
   if(intent.patch)changeOperation(find(graph.operations,id),patch as OperationPatch,[]);
   if(intent.components)updateParts(graph,id,intent.components as PartWrite[]);
   for(const link of (intent.links??[]) as LinkIntent[])updateLink(graph,link.id,link.link);
   break;
  }
  case 'set_exclusion':{
   const scope=intent.scope as {kind:string;operationIds?:string[];filter?:OperationsFilter};
   const state=snapshot(data);
   const selected=new Set(scope.kind==='operations'?scope.operationIds:queryOperations(state.operations,state,parseOperationsQuery({filter:scope.filter??{}})).operations.map(op=>op.id));
   if(intent.includeRelated){
    let size=0;
    while(size!==selected.size){size=selected.size;for(const l of graph.links)if(l.status==='confirmed'&&(selected.has(l.sourceId)||selected.has(l.targetId))){selected.add(l.sourceId);selected.add(l.targetId);}}
   }
   if(!selected.size)fail('EMPTY_SCOPE','По этим условиям нет операций.');
   const value=intent.value as Operation['analyticsOverride'];
   for(const id of selected)find(graph.operations,id).analyticsOverride=value;
   details={kind:intent.kind,operationIds:[...selected],changedOperationIds:[...selected],includeRelated:!!intent.includeRelated,warnings:[]};
   break;
  }
  case 'account':Object.assign(find(graph.accounts,id),patch);break;
  case 'account_settings':for(const item of intent.accounts as {id:string;patch:Partial<Account>}[])Object.assign(find(graph.accounts,item.id),item.patch);break;
  case 'analytics':graph.loanMode=intent.value==='economic'?'economic':'cashflow';break;
  case 'category':replace(graph.categories,{...(intent.create?{parentId:null,hidden:false,role:'expense'}:find(graph.categories,id)),...patch,id} as Category);break;
  case 'counterparty':{
   const party={...(intent.create?{name:'',state:'registered'}:find(data.parties,id)),...patch,id} as Party;
   replace(data.parties,party);
   if(party.state==='registered'&&party.proposalCandidates){
    for(const operationId of party.proposalOperationIds??party.proposalCandidates)changeOperation(find(graph.operations,operationId),{counterpartyId:id},[]);
    party.proposalOperationIds=null;
   }
   if(patch.rememberForFuture===true||patch.rememberForFuture===false&&party.autoRuleId){
    const old=data.rules.find(r=>r.id===party.autoRuleId);
    const autoRuleId=old?.id??String(patch.autoRuleId??crypto.randomUUID());
    const match=party.hasBankIdentity?{counterpartyBankIdentity:true as const}:{};
    party.autoRuleId=autoRuleId;
    replace(data.rules,{id:autoRuleId,name:'Контрагент · '+party.name,priority:100,conditions:old?.conditions??match,assignments:{counterpartyId:id},dependencyStatus:old?.dependencyStatus??(party.hasBankIdentity?'ready':'needs_setup'),enabled:patch.rememberForFuture===true&&(old?.dependencyStatus==='ready'||!!party.hasBankIdentity)});
   }
   break;
  }
  case 'delete_counterparty':
   data.parties=data.parties.filter(p=>p.id!==id);
   data.rules=data.rules.filter(r=>r.assignments.counterpartyId!==id);
   for(const op of graph.operations)if(op.semantics.counterparty.value===id)op.semantics.counterparty=facet(null);
   break;
  case 'rule':case 'create_rule_with_history':{
   const ruleId=String(intent.id),rule={...validateRule(intent.rule??patch),id:ruleId,dependencyStatus:'ready' as const};
   replace(data.rules,rule);
   if(intent.kind==='create_rule_with_history')graph.operations=graph.operations.map(op=>ids.includes(op.id)?ruleChange(data,op,ruleId):op);
   break;
  }
  case 'delete_rule':data.rules=data.rules.filter(rule=>rule.id!==id);break;
  case 'apply_rules':graph.operations=graph.operations.map(op=>ids.includes(op.id)?ruleChange(data,op,String(intent.ruleId)):op);break;
  case 'save_budget':case 'set_budget_limit':{
   const old=data.budgets.find(b=>b.id===id);
   const definition=intent.definition?parseBudgetDefinition(intent.definition):old?.definition??fail();
   const window=budgetWindow(definition.period,calendarDay(new Date(),definition.timezone));
   const from=intent.applyFrom==='next'?window.next:window.from;
   const limits=typeof intent.limitMinor==='string'&&from?[...(old?.limits??[]).filter(l=>l.from!==from),{from,limitMinor:intent.limitMinor}]:old?.limits??[];
   const budget={id,name:String(intent.name??old?.name),definition,enabled:Boolean(intent.enabled??old?.enabled),limits,dependencyStatus:'ready' as const,revision};
   replace(data.budgets,budget);
   details={kind:intent.kind,budgetId:id,name:budget.name,definition,enabled:budget.enabled,limits,limitMinor:intent.limitMinor,effectiveFrom:from,previousLimits:old?.limits,operationsChanged:0};
   break;
  }
  case 'delete_budget':data.budgets=data.budgets.filter(b=>b.id!==id);break;
  case 'save_operations_view':case 'save_overview_view':{
   const views=intent.kind==='save_overview_view'?data.views.overview:data.views.operations;
   if(intent.isDefault)for(const view of views)view.isDefault=false;
   replace(views,{id,name:String(intent.name),definition:intent.definition,isDefault:!!intent.isDefault,dependencyStatus:'ready',revision,position:views.find(v=>v.id===id)?.position??views.length,modifiedAt:new Date().toISOString()});
   break;
  }
  case 'delete_operations_view':data.views.operations=data.views.operations.filter(v=>v.id!==id);break;
  case 'delete_overview_view':data.views.overview=data.views.overview.filter(v=>v.id!==id);break;
  case 'reorder_operations_views':case 'reorder_overview_views':{
   const list=intent.kind==='reorder_overview_views'?data.views.overview:data.views.operations;
   for(const view of list)view.position=(intent.viewIds as string[]).indexOf(view.id);
   list.sort((a,b)=>a.position-b.position);
   break;
  }
  case 'undo':{
   const item=history.find(entry=>entry.id===intent.value&&entry.undoable&&!entry.undone)??fail('DEMO_UNDO','В демо можно отменить последнее изменение.');
   data=structuredClone(item.before);undoneId=item.id;break;
  }
  default:fail();
 }
 const before=snapshot(),after=snapshot(data),relations=reconcile(data.graph),priorLinks=new Map(reconcile(sample.graph).links.map(l=>[l.id,l.reason]));
 const original=new Map(sample.graph.operations.map(op=>[op.id,op]));
 const changes=data.graph.operations.filter(op=>JSON.stringify(original.get(op.id))!==JSON.stringify(op)).map(op=>({kind:'operation',id:op.id,before:{values:{semantics:original.get(op.id)?.semantics,comment:original.get(op.id)?.comment}},after:{values:{semantics:op.semantics,comment:op.comment}}}));
 const preview:FinancePreview={status:'previewed',actionId,intent:{id,kind:intent.kind},impact:{before:before.summary,after:after.summary,affectedOperationIds:changes.map(c=>c.id),changes,dependencyConflicts:relations.links.filter(l=>l.reason!==null&&priorLinks.get(l.id)!==l.reason),...(details?{details}:{})}};
 previews.set(actionId,{revision,after:data,preview,intent,undoneId});
 return preview;
}
function commit(actionId:string){
 const receipt=receipts.get(actionId);if(receipt)return receipt;
 const work=previews.get(actionId);if(!work||work.revision!==revision)fail('FINANCE_CHANGED','Данные изменились. Откройте действие снова.');
 for(const item of history){item.undoable=false;item.rollbackStatus='not_available';if(item.id===work.undoneId)item.undone=true;}
 revision=String(BigInt(revision)+1n);
 history.unshift({id:actionId,revision,committed_at:new Date().toISOString(),intent:work.intent,operationIds:work.preview.impact.affectedOperationIds,changes:work.preview.impact.changes??[],undoable:!work.undoneId,undone:false,rollbackStatus:work.undoneId?'not_available':'available',before:sample});
 if(history.length>30)history.pop();
 sample=work.after;
 const saved:FinanceReceipt={status:'committed',actionId,generation,revision,impact:work.preview.impact};
 receipts.set(actionId,saved);previews.clear();return saved;
}
function answer(question:string,filter:OperationsFilter):Answer{
 const text=question.toLocaleLowerCase('ru-RU'),today=calendarDay(new Date(),timezone),f={...filter};
 const month=/прошл\S* месяц/.test(text)?1:/этот месяц|текущ\S* месяц/.test(text)?0:null;
 if(month!==null){
  f.from=monthStart(today,month);
  f.through=month===0?today:new Date(Date.parse(monthStart(today))-86400000).toISOString().slice(0,10);
 }
 const category=sample.graph.categories.find(c=>text.includes(c.name.toLocaleLowerCase('ru-RU'))||c.name==='Продукты'&&text.includes('продукт'));
 if(category)f.categoryIds=[category.id];
 const state=snapshot(),income=/доход|зарплат/.test(text),expense=/расход|потрат|покупк|трат|продукт/.test(text);
 const all=queryOperations(state.operations,state,parseOperationsQuery({filter:f})),summary=all.summary;
 const result=(text:string,mode:Answer['mode']='deterministic'):Answer=>({text,mode,registryVersion:'analyzer/1'});
 if(/внимани|провер/.test(text))return result('Операций, требующих внимания за выбранный период, — '+summary.attentionIds.length+'.');
 if(/категори/.test(text)){
  const widget={...defaultOverview().widgets[0]!,grouping:'category' as const,metrics:[income?'income':'expenses'] as const};
  const totals=calculateOverview(state.operations,state,f,[{...widget,metrics:[...widget.metrics]}],new Date(),timezone).widgets[0];
  if(totals?.points.length)return result(totals.points.map(p=>p.label+' — '+formatMoney(p.values[income?'income':'expenses']??'0')).join('\n'));
 }
 if(/сравн|предыдущ/.test(text)){
  const from=f.from??monthStart(today),through=f.through??today;
  const length=Math.max(1,Math.round((Date.parse(through)-Date.parse(from))/86400000)+1);
  const previous={...f,from:new Date(Date.parse(from)-length*86400000).toISOString().slice(0,10),through:new Date(Date.parse(from)-86400000).toISOString().slice(0,10)};
  const a=queryOperations(state.operations,state,parseOperationsQuery({filter:{...f,from,through}})).summary;
  const b=queryOperations(state.operations,state,parseOperationsQuery({filter:previous})).summary;
  return result('Расходы за выбранный период — '+formatMoney(a.netExpensesMinor)+'. За предыдущий период той же длины — '+formatMoney(b.netExpensesMinor)+'. Разница — '+formatMoney(String(BigInt(a.netExpensesMinor)-BigInt(b.netExpensesMinor)))+'.');
 }
 if(income||expense)return result((income?'Доходы':'Расходы за вычетом возвратов')+(category?' · '+category.name:'')+' за выбранный период — '+formatMoney(income?summary.incomeMinor:summary.netExpensesMinor)+'.');
 return result('В демо доступны расчёты по тестовым операциям. Спросите о расходах, доходах, категориях или сравнении периодов.','clarification');
}

export function demoApi(path:string,body:Record<string,unknown>={}):unknown{
 if(!sample)resetDemo();
 switch(path){
  case '/finance/profile':if(typeof body.timezone==='string'&&!body.initialize)timezone=body.timezone;return {timezone};
  case '/finance/summary':case '/finance/state':return snapshot(sample,body);
  case '/finance/overview-views':return {views:sample.views.overview};
  case '/finance/operations-views':return {views:sample.views.operations};
  case '/finance/overview':{
   const state=snapshot(),filter=(body.filter??{}) as OperationsFilter,budgets=sample.budgets,table=body.table as {widgetId:string;offset:number;limit:number}|undefined;
   const result=calculateOverview(state.operations,{...state,budgets},filter,Array.isArray(body.widgets)?body.widgets.map(parseWidget):defaultOverview().widgets,new Date(),timezone,!!table);
   if(table)result.widgets=result.widgets.map(({tablePoints,...widget})=>widget.id!==table.widgetId?widget:{...widget,tablePoints:tablePoints?.slice(table.offset,table.offset+table.limit),tableOffset:table.offset,tableNextOffset:tablePoints&&table.offset+table.limit<tablePoints.length?table.offset+table.limit:null});
   return {...result,generation,revision,timezone,budgetOptions:budgets.map(({id,name})=>({id,name})),warnings:[]};
  }
  case '/finance/operations-page':case '/finance/operations-selection':{
   const state=snapshot(),result=queryOperations(state.operations,state,parseOperationsQuery(body.query??{}));
   if(path.endsWith('selection'))return {generation,revision,total:result.total,operationIds:result.operations.map(op=>op.id),reviewIds:result.operations.filter(op=>op.reviewReasons.length).map(op=>op.id),operations:state.operations.filter(op=>Array.isArray(body.ids)&&body.ids.includes(op.id))};
   const size=body.displayLimit==='all'?Math.max(1,result.total):Number(body.displayLimit??body.limit??50);
   const offset=(body.cursor as {offset?:number}|undefined)?.offset??(Math.min(Number(body.page??1),Math.max(1,Math.ceil(result.total/size)))-1)*size;
   return {...result,generation,revision,workspaceTotal:state.operationCount,offset,operations:result.operations.slice(offset,offset+size),nextCursor:offset+size<result.total?{generation,revision,offset:offset+size,queryHash:'demo'}:null};
  }
  case '/finance/operation':{
   const op=find(sample.graph.operations,body.id);
   const links=sample.graph.links.filter(link=>link.sourceId===op.id||link.targetId===op.id),linkIds=new Set(links.map(link=>link.id));
   return {...op,generation,revision,displayName:operationDisplayName(op,{counterparties:sample.parties}),projection:find(snapshot().operations,op.id),components:sample.graph.components.filter(part=>part.transactionId===op.id),links,linkStates:reconcile(sample.graph).links.filter(link=>linkIds.has(link.id))};
  }
  case '/finance/budgets':{
   const state=snapshot();
   return {generation,revision,budgets:sample.budgets.map(b=>{const at=String(body.at??calendarDay(new Date(),b.definition.timezone));return {...b,at,settingsKnown:true,calculation:calculateBudget(b,state.operations,state,at)};})};
  }
  case '/finance/imports':return {batches:[],nextCursor:null};
  case '/finance/classification':if(body.start)fail();return {enabled:false,state:'idle',calls:0,applied:0,uncertain:0,canStart:false,sourceKey:'',passId:null,last:null};
  case '/finance/review-sessions':return {generation,sessions:[]};
  case '/finance/review-queue':{
   if(body.refresh)skipped.clear();if(typeof body.skip==='string')skipped.add(body.skip);
   const pending=snapshot().operations.filter(op=>op.reviewReasons.length);
   const op=pending.find(op=>!skipped.has(op.id))??pending[0];
   if(op&&skipped.has(op.id))skipped.clear();
   return {id:reviewId,generation,financeRevision:revision,revision,remaining:pending.length,anchor:op?.id,operations:op?[op]:[],similar:op?[op.id]:[]};
  }
  case '/finance/rule-candidates':{
   const ids=sample.graph.operations.filter(op=>JSON.stringify(ruleChange(sample,op,String(body.ruleId)))!==JSON.stringify(op));
   return {revision,total:ids.length,operationIds:ids.map(op=>op.id),rows:ids.map(op=>({id:op.id,date:effective(op).operationDate,amountMinor:effective(op).amountMinor,name:op.semantics.merchant.value||op.source.description}))};
  }
  case '/finance/preview':return makePreview(body);
  case '/finance/commit':return commit(String(body.actionId));
  case '/finance/edit':makePreview(body);return commit(String(body.actionId));
  case '/finance/history':case '/finance/history-query':{
   const query=String(body.search??'').toLocaleLowerCase('ru-RU');
   const actions=history.filter(e=>(!Array.isArray(body.operationIds)||e.operationIds.some(id=>(body.operationIds as string[]).includes(id)))&&(!Array.isArray(body.kinds)||body.kinds.includes(e.intent.kind))&&JSON.stringify(e.intent).toLocaleLowerCase('ru-RU').includes(query)).map(({before:_,...entry})=>entry);
   return {actions,nextBeforeRevision:null};
  }
  case '/finance/analyzer-state':{
   const search=String(body.search??'').toLocaleLowerCase('ru-RU');
   return {chats:[...chats.values()].reverse().filter(c=>!search||c.id===body.chatId||c.title.toLocaleLowerCase('ru-RU').includes(search)||c.messages.some(m=>m.question.toLocaleLowerCase('ru-RU').includes(search))),quota:{available:false,limit:null,used:0,remaining:null,periodStart:null,resetAt:null,warning:null},providerAvailable:false,registryVersion:'analyzer/1'};
  }
  case '/finance/analyzer-chat':{
   const id=String(body.id),now=new Date().toISOString();
   if(body.create){chats.set(id,{id,title:'Новый диалог',pinned:false,createdAt:now,modifiedAt:now,messages:[]});return {id};}
   const chat=chats.get(id);if(!chat)fail('NOT_FOUND','Диалог не найден.');
   if(body.delete)chats.delete(id);else Object.assign(chat,{...(typeof body.title==='string'?{title:body.title}:{}),...(typeof body.pinned==='boolean'?{pinned:body.pinned}:{}),modifiedAt:now});
   return {id};
  }
  case '/finance/analyzer-query':{
   const chat=chats.get(String(body.chatId));if(!chat)fail('NOT_FOUND','Диалог не найден.');
   const question=String(body.text),now=new Date().toISOString(),id=String(body.id);
   if(!chat.messages.some(m=>m.id===id)){
    if(!chat.messages.length)chat.title=question.slice(0,65);
    chat.messages.push({id,question,answer:answer(question,(body.filter??{}) as OperationsFilter),createdAt:now,actionId:null});
    chat.modifiedAt=now;
   }
   return {id};
  }
  default:fail();
 }
}
