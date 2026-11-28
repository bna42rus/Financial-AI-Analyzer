/** Isolated deterministic prototype. No provider, persistence, mutations or API route.
 * State/env are server-owned values, not a deserialization or authorization API.
 */
import {parseIntent} from './intent.ts';
import type {Intent,Presentation,Binding,CalculationParameters} from './intent.ts';
import {emptyTaskBook,globalSnapshot,resolveTaskDecision,acceptTaskResult,conditionFields} from '../task-context.ts';
import type {TaskBook,TaskNode,TaskScope,GlobalSnapshot,ConditionEdit,TaskDecision,Condition} from '../task-context.ts';
import {parseTool} from '../registry.ts';
import type {Query} from '../registry.ts';
import {parseOperationsFilter} from '../../../finance-core/src/operations.ts';
import type {OperationsFilter} from '../../../finance-core/src/operations.ts';
import {uuid} from '../../../finance-core/src/model.ts';
import type {WidgetResult} from '../../../finance-core/src/overview.ts';
import type {Catalog} from '../yandex-contract.ts';
import {questionQuote} from '../task-literals.ts';
import {periodExpression} from './period.ts';
import {sourceNameIndex} from './source-literals.ts';
import {normalizeReadBinding} from './read-binding.ts';
import {comparisonPeriodOrder} from './comparison-periods.ts';
import {normalizeSourceIntent,sourcePeriodEdit} from './source-intent.ts';
import {assistantAmountLiteral} from '../assistant-money.ts';
import {calculateFinancial,parseCalculatorInput,calculatorRublesMinor} from '../calculators.ts';
import type {LoanInput,CalculatorResult} from '../calculators.ts';

type LoanResult=Extract<CalculatorResult,{kind:'loan'}>;
type LoanDraft=Partial<Omit<LoanInput,'kind'>>;
type Draft={kind:'read';metric:Query['metric']|null;grouping:Query['grouping'];comparison:Query['comparison'];filter:OperationsFilter;options:NonNullable<Query['options']>;global:GlobalSnapshot}
  |{kind:'loan';input:LoanDraft;unresolvedFields?:string[]};
type Base={handle:string;requestId:string;dataRevision:string};
export type ReadTask=Base&{kind:'read';node:TaskNode;result:WidgetResult};
export type LoanTask=Base&{kind:'loan';input:LoanDraft;results:LoanResult[];unresolvedFields?:string[];comparison?:Extract<Outcome,{kind:'loan_comparison'}>};
export type StoredTask=ReadTask|LoanTask;
export type State={version:'cashneuro-task-state-prototype/1';scope:TaskScope;revision:number;book:TaskBook;history:StoredTask[];active:string|null;
  pending:{handle:string;draft:Draft;parent:string|null}|null;running:{requestId:string;revision:number}|null;failure:string|null};
export type Environment={scope:TaskScope;requestId:string;question:string;date:string;global:GlobalSnapshot;dataRevision:string;accessRevision:string;catalog:Catalog};
type Header={requestId:string;scope:TaskScope;revision:number;dataRevision:string;accessRevision:string;presentation:Presentation;parent:string|null};
type Work=
  {kind:'read';node:TaskNode}|
  {kind:'loan';input:LoanDraft;inputs:LoanInput[]}|
  {kind:'loan_comparison';inputs:LoanInput[];criterion:'interest'|'total_paid'|'payment';objective:'min'|'max'};
export type Prepared=Header&Work;
export type Outcome={kind:'read';result:WidgetResult}|{kind:'loan';results:LoanResult[]}|
  {kind:'loan_comparison';results:LoanResult[];valuesMinor:string[];deltasFromFirstMinor:string[];winnerIndexes:number[]};
export type Preparation={status:'ready';state:State;task:Prepared}|
  {status:'waiting';state:State;code:string;missing:string[]}|
  {status:'explanation';state:State;subject:Extract<Intent,{action:'explain'}>['parameters']['subject'];historical:StoredTask|null}|
  {status:'unsupported';state:State;code:string};
export class PreparationError extends TypeError {readonly code:string;constructor(code:string){super(code);this.code=code;}}
function fail(code:string):never{throw new PreparationError(code);}
const clone=<T>(value:T):T=>structuredClone(value);
const sameScope=(a:TaskScope,b:TaskScope)=>Object.keys(a).every(k=>a[k as keyof TaskScope]===b[k as keyof TaskScope]);
function check(state:State,env:Environment){
 const scope=emptyTaskBook(env.scope).scope;
 if(state.version!=='cashneuro-task-state-prototype/1'||!sameScope(state.scope,scope))fail('TASK_SCOPE_MISMATCH');
 uuid(env.requestId);globalSnapshot(env.global);parseOperationsFilter({from:env.date,through:env.date});
 if(!env.dataRevision||!env.accessRevision||!env.question||env.question.length>2000)fail('TASK_ENV_INVALID');
}
export function emptyState(scope:TaskScope):State {
 const book=emptyTaskBook(scope);return {version:'cashneuro-task-state-prototype/1',scope:book.scope,revision:0,book,history:[],active:null,pending:null,running:null,failure:null};
}
function lookup(state:State,handle:string):{task:StoredTask;variant:number|null}{
 const match=/^(t[1-9][0-9]*)(?:_v([1-9][0-9]*))?$/.exec(handle);if(!match)fail('TASK_REFERENCE_INVALID');
 const task=state.history.find(t=>t.handle===match[1]);if(!task)fail('TASK_REFERENCE_INVALID');
 const variant=match[2]?Number(match[2])-1:null;
 if(variant!==null&&(task.kind!=='loan'||!task.results[variant]))fail('TASK_REFERENCE_INVALID');
 return {task,variant};
}
function selected(state:State,binding:Binding):StoredTask|null{
 if(binding.mode==='new')return null;
 if(binding.mode==='answer'){
  if(!state.pending||state.pending.handle!==binding.clarification||binding.option!==null)fail('TASK_CLARIFICATION_REFERENCE_INVALID');
  return state.pending.parent?lookup(state,state.pending.parent).task:null;
 }
 const handle=binding.mode==='reference'?binding.handle:state.active;
 if(!handle)fail('TASK_CONTEXT_MISSING');return lookup(state,handle).task;
}
function wait(state:State,env:Environment,draft:Draft,parent:string|null,code:string,missing:string[]):Preparation{
 const next=clone(state);next.revision++;next.pending={handle:'q'+next.revision,draft:clone(draft),parent};next.running=null;next.failure=null;
 if(parent===null)next.active=null;
 return {status:'waiting',state:next,code,missing};
}
function start(state:State,env:Environment,body:Work,presentation:Presentation,parent:string|null):Preparation{
 const next=clone(state);next.revision++;next.pending=null;next.failure=null;next.running={requestId:env.requestId,revision:next.revision};
 if(parent===null)next.active=null;
 const task={...body,requestId:env.requestId,scope:clone(env.scope),revision:next.revision,dataRevision:env.dataRevision,accessRevision:env.accessRevision,presentation:clone(presentation),parent} as Prepared;
 return {status:'ready',state:next,task};
}
const pick=(filter:OperationsFilter,field:Condition)=>Object.fromEntries(conditionFields[field].filter(k=>Object.hasOwn(filter,k)).map(k=>[k,filter[k]])) as OperationsFilter;
function mergeDraft(filter:OperationsFilter,before:GlobalSnapshot,current:GlobalSnapshot):OperationsFilter{
 if(current.revision<before.revision)fail('TASK_GLOBAL_VERSION_INVALID');
 const result=clone(filter);
 for(const field of Object.keys(conditionFields) as Condition[]){
  const changed=canonical(pick(before.filter,field))!==canonical(pick(current.filter,field))||(before.touched[field]??0)!==(current.touched[field]??0);
  if((current.touched[field]??0)<(before.touched[field]??0)||changed&&current.revision===before.revision)fail('TASK_GLOBAL_VERSION_INVALID');
  if(changed){for(const key of conditionFields[field])delete result[key];Object.assign(result,pick(current.filter,field));}
 }
 return result;
}
function readBase(state:State,env:Environment,previous:ReadTask|null,pin:boolean,metric:Query['metric']|null,grouping:Query['grouping']|null,comparison:Query['comparison']|null,edits:ConditionEdit[],initial?:OperationsFilter){
 const index=previous?state.book.nodes.findIndex(n=>n.messageId===previous.requestId):-1;
 if(previous&&index<0)fail('TASK_REFERENCE_INVALID');
 const keep={op:'keep'} as const;
 const decision:TaskDecision={binding:previous?{kind:'reference',handle:'t'+(index+1)}:{kind:'new'},metric:metric?{op:'set',value:metric}:keep,
  grouping:grouping?{op:'set',value:grouping}:keep,comparison:comparison?{op:'set',value:comparison}:keep,edits};
 if(previous)mergeDraft(previous.node.query.filter,previous.node.global,env.global); // validate even for pin
 const global=initial?{...env.global,filter:initial}:pin&&previous?previous.node.global:env.global;
 const resolved=resolveTaskDecision(state.book,env.scope,global,decision,env.requestId);
 if(resolved.status!=='resolved')fail('TASK_'+resolved.reason.toUpperCase());
 // Pinned semantic conditions never pin authority or widen fixed operation IDs.
 const current=env.global.filter.operationIds;
 if(current)resolved.query.filter.operationIds=(resolved.query.filter.operationIds??current).filter(id=>current.includes(id));
 resolved.node.query=resolved.query;resolved.node.global=clone(env.global);
 return resolved.node;
}
function expressionEdit(field:Condition,expression:string,env:Environment,base:Query,reference:OperationsFilter={}):ConditionEdit{
 if(field==='amount'&&!env.question.includes(expression))fail('TASK_AMOUNT_LITERAL_REQUIRED');
 if(!['period','postedPeriod','accounts','categories','counterparties'].includes(field))questionQuote(expression,env.question);
 let value:OperationsFilter;
 if(field==='period'||field==='postedPeriod'){
  let period;
  try{period=periodExpression(expression,env.question,env.date,{from:field==='period'?base.filter.from:base.filter.postedFrom,through:field==='period'?base.filter.through:base.filter.postedThrough},{from:field==='period'?reference.from:reference.postedFrom,through:field==='period'?reference.through:reference.postedThrough});}
  catch(error){if(error instanceof TypeError&&/^(?:TASK_|INVALID_)[A-Z_]+$/.test(error.message))fail(error.message);throw error;}
  value=field==='period'?period:{postedFrom:period.from,postedThrough:period.through};
 }else if(field==='amount')value=assistantAmountLiteral(expression,'absolute_operation');
 else if(['accounts','categories','counterparties'].includes(field)){
  const group=field as 'accounts'|'categories'|'counterparties';let index:number;
  try{index=sourceNameIndex(group,expression,env.question,env.catalog[group].map(item=>item.name));}catch(e){if(e instanceof TypeError&&/^TASK_[A-Z_]+$/.test(e.message))fail(e.message);throw e;}
  const item=env.catalog[group][index]!;
  if(group==='categories'){
   const category=item as Catalog['categories'][number];
   value=category.parentId?{categoryIds:[category.parentId],subcategoryIds:[category.id]}:{categoryIds:[category.id]};
  }else value=group==='accounts'?{accountIds:[item.id]}:{counterpartyIds:[item.id]};
 }else if(field==='merchant')value={merchant:expression};
 else fail('TASK_CONDITION_ADAPTER_MISSING');
 return {field,op:'set',value:parseOperationsFilter(value)};
}
function loanInputs(input:LoanDraft):LoanInput[]{
 const payments=input.payment?[input.payment]:['annuity','differentiated'] as const;
 return payments.map(payment=>parseCalculatorInput({kind:'loan',...input,payment,prepayments:input.prepayments??[],rateChanges:input.rateChanges??[]}) as LoanInput);
}
function prepareLoan(state:State,env:Environment,intent:Extract<Intent,{action:'calculate'}>,previous:StoredTask|null):Preparation{
 const params=intent.parameters as Extract<CalculationParameters,{calculator:'loan'}>;
 const pending=intent.binding.mode==='answer'?state.pending?.draft:null;
 if(pending&&pending.kind!=='loan'||previous&&previous.kind!=='loan')fail('TASK_CONTEXT_INCOMPATIBLE');
 let input:LoanDraft=pending?.kind==='loan'?clone(pending.input):previous?.kind==='loan'?clone(previous.input):{};
 let unresolved=pending?.kind==='loan'?[...pending.unresolvedFields??[]]:previous?.kind==='loan'?[...previous.unresolvedFields??[]]:[];
 if(intent.binding.mode==='reference'){
  const target=lookup(state,intent.binding.handle);
  if(target.variant!==null&&target.task.kind==='loan'){input=clone(target.task.results[target.variant]!.input);unresolved=[];}
 }
 const draft=input as Record<string,unknown>;
 for(const edit of params.edits){
  unresolved=unresolved.filter(field=>field!==edit.field);
  if(edit.op==='clear')delete draft[edit.field];else {questionQuote(edit.quote,env.question);draft[edit.field]=clone(edit.value);}
 }
 delete draft.kind;
 const parent=previous?.handle??null,missing=[...new Set([...['principalRubles','annualRatePercent','months'].filter(key=>draft[key]===undefined),...unresolved])];
 if(missing.length)return wait(state,env,{kind:'loan',input,unresolvedFields:unresolved},parent,'TASK_INPUT_REQUIRED',missing);
 let inputs:LoanInput[];
 try{inputs=loanInputs(input);}catch{return wait(state,env,{kind:'loan',input},parent,'TASK_LOAN_CONDITION_CONFLICT',['loan_conditions']);}
 return start(state,env,{kind:'loan',input,inputs},intent.presentation,parent);
}
export function prepareTask(state:State,env:Environment,raw:unknown):Preparation{
 check(state,env);let intent=parseIntent(raw);
 try{intent=normalizeSourceIntent(intent,state,env);}catch(error){if(error instanceof TypeError&&/^TASK_[A-Z_]+$/.test(error.message))fail(error.message);throw error;}
 const active=state.history.find(t=>t.handle===state.active);
 try{intent=normalizeReadBinding(intent,active?.kind==='read'?active.node.query:null,env.question,env.date,!!(state.pending||state.running),{accounts:env.catalog.accounts.map(v=>v.name),categories:env.catalog.categories.map(v=>v.name),counterparties:env.catalog.counterparties.map(v=>v.name),merchant:active?.kind==='read'?(active.node.query.grouping==='merchant'?active.result.points.map(p=>p.label):active.node.query.filter.merchant?[active.node.query.filter.merchant]:[]):[]});}
 catch(error){if(error instanceof TypeError&&/^TASK_[A-Z_]+$/.test(error.message))fail(error.message);throw error;}
 if(state.history.some(t=>t.requestId===env.requestId)||state.running?.requestId===env.requestId)fail('TASK_REQUEST_REUSED');
 if(intent.action==='explain'){
  const historical=intent.parameters.subject.kind==='result'?lookup(state,intent.parameters.subject.handle).task:null;
  return {status:'explanation',state:clone(state),subject:clone(intent.parameters.subject),historical:clone(historical)};
 }
 if(intent.action==='compare'){
  if(intent.binding.mode!=='new')selected(state,intent.binding);
  const refs=intent.parameters.scenarios.map(handle=>lookup(state,handle));
  if(refs.every(r=>r.task.kind==='read')&&intent.parameters.criterion==='value'){
   if(refs.length!==2)fail('TASK_COMPARISON_REQUIRES_TWO');
   const reads=refs.map(r=>r.task as ReadTask);
   let order:[number,number];
   try{order=comparisonPeriodOrder([reads[0]!.node.query.filter,reads[1]!.node.query.filter],env.question,env.date);}
   catch(error){if(error instanceof TypeError&&/^TASK_[A-Z_]+$/.test(error.message))fail(error.message);throw error;}
   const a=reads[order[0]]!,b=reads[order[1]]!,base=clone(a.node.query),target=clone(b.node.query);
   const signature=(query:Query)=>{const filter={...query.filter};delete filter.from;delete filter.through;const options={...query.options};delete options.comparisonPeriod;return canonical({metric:query.metric,grouping:query.grouping,filter,options});};
   if(signature(base)!==signature(target)||!base.filter.from||!base.filter.through||!target.filter.from||!target.filter.through)fail('TASK_COMPARISON_SCOPE_MISMATCH');
   const node=readBase(state,env,b!,true,target.metric,target.grouping,'custom',[]);
   node.query={...node.query,options:{...target.options,comparisonPeriod:{from:base.filter.from,through:base.filter.through}}};
   return start(state,env,{kind:'read',node},intent.presentation,b!.handle);
  }
  if(!refs.every(r=>r.task.kind==='loan')||!['interest','total_paid','payment'].includes(intent.parameters.criterion))fail('TASK_COMPARISON_INCOMPATIBLE');
  const inputs=refs.flatMap(r=>{const results=(r.task as LoanTask).results;return r.variant===null?results.map(v=>v.input):[results[r.variant]!.input];});
  if(inputs.length<2||inputs.length>6||new Set(inputs.map(v=>canonical(v))).size!==inputs.length)fail('TASK_COMPARISON_AMBIGUOUS');
  if(new Set(inputs.map(v=>calculatorRublesMinor(v.principalRubles))).size!==1)fail('TASK_COMPARISON_BASIS_MISMATCH');
  return start(state,env,{kind:'loan_comparison',inputs,criterion:intent.parameters.criterion as 'interest'|'total_paid'|'payment',objective:intent.parameters.objective},intent.presentation,state.active);
 }
 if(intent.action!=='read'&&intent.action!=='calculate')return {status:'unsupported',state:clone(state),code:'TASK_ADAPTER_NOT_IN_PILOT'};
 if(intent.action==='calculate'&&intent.parameters.calculator!=='loan')return {status:'unsupported',state:clone(state),code:'TASK_ADAPTER_NOT_IN_PILOT'};
 const previous=selected(state,intent.binding);
 if(intent.action==='calculate')return prepareLoan(state,env,intent,previous);
 const pending=intent.binding.mode==='answer'?state.pending?.draft:null;
 if(pending&&pending.kind!=='read'||previous&&previous.kind!=='read')fail('TASK_CONTEXT_INCOMPATIBLE');
 // Read-metric clarification is deliberately separate from the loan draft.
 const p=intent.parameters,prior=previous as ReadTask|null;
 const metric=p.metric??(pending?.kind==='read'?pending.metric:null)??prior?.node.query.metric??null;
 const pin=intent.binding.mode==='reference'||intent.binding.mode==='continue'&&intent.binding.conditions==='pin';
 const initial=pending?.kind==='read'?mergeDraft(pending.filter,pending.global,env.global):undefined;
 const grouping=p.grouping??(pending?.kind==='read'?pending.grouping:null),comparison=p.comparison??(pending?.kind==='read'?pending.comparison:null);
 let node=readBase(state,env,prior,pin,metric??'expenses',grouping,'none',[],initial);
 const conditions=[...p.conditions],yearReference=prior?.node.query.filter??(pending?.kind==='read'?pending.filter:{});
 if(!conditions.some(e=>e.field==='period'||e.field==='postedPeriod')&&(p.options.dateBasis??prior?.node.query.options?.dateBasis)!=='posted'){
  try{const edit=sourcePeriodEdit(env.question,env.date,node.query,yearReference);if(edit)conditions.push(edit);}catch(error){if(error instanceof TypeError&&/^TASK_[A-Z_]+$/.test(error.message))fail(error.message);throw error;}
 }
 const edits:ConditionEdit[]=conditions.map(edit=>{
  if(edit.op==='set')return expressionEdit(edit.field,edit.expression,env,node.query,yearReference);
  if(edit.op==='clear')return {field:edit.field,op:'clear'};
  const value=pick(env.global.filter,edit.field);return Object.keys(value).length?{field:edit.field,op:'set',value}:{field:edit.field,op:'clear'};
 });
 node=readBase(state,env,prior,pin,metric??'expenses',grouping,comparison,edits,initial);
 node.query=parseTool({...node.query,options:{...(pending?.kind==='read'?pending.options:prior?.node.query.options),...p.options}}) as Query;
 if(node.query.comparison==='custom'&&!node.query.options?.comparisonPeriod)fail('TASK_COMPARISON_PERIOD_REQUIRED');
 if(!metric)return wait(state,env,{kind:'read',metric:null,grouping:node.query.grouping,comparison:node.query.comparison,filter:node.query.filter,options:node.query.options??{},global:clone(env.global)},null,'TASK_INPUT_REQUIRED',['metric']);
 return start(state,env,{kind:'read',node},intent.presentation,prior?.handle??null);
}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).sort().join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
 return JSON.stringify(value)??'null';
}
/** Caller must authorize before exposing state/aliases; guard also checks the
 * expected access/data revisions at execution. A future DB adapter must make
 * that check and its read one consistent snapshot. No permissive default. */
export async function executeTask(task:Prepared,services:{guard:(task:Prepared)=>Promise<void>;read:(query:Query,task:Prepared)=>Promise<WidgetResult>}):Promise<Outcome>{
 await services.guard(clone(task));
 if(task.kind==='read'){
  const result=await services.read(clone(task.node.query),clone(task));await services.guard(clone(task));
  return {kind:'read',result:clone(result)};
 }
 const results=task.inputs.map(input=>calculateFinancial(input) as LoanResult);
 if(task.kind==='loan')return {kind:'loan',results};
 const valuesMinor=results.map(r=>task.criterion==='interest'?r.interestMinor:task.criterion==='total_paid'?r.totalPaidMinor:r.regularPaymentMinor);
 const values=valuesMinor.map(BigInt),best=values.reduce((a,b)=>task.objective==='min'?(a<b?a:b):(a>b?a:b));
 return {kind:'loan_comparison',results,valuesMinor,deltasFromFirstMinor:values.map(v=>(v-values[0]!).toString()),winnerIndexes:values.flatMap((v,i)=>v===best?[i]:[])};
}
export function finishTask(state:State,env:Environment,task:Prepared,outcome:Outcome|{kind:'failed';code:string}):{applied:boolean;state:State}{
 check(state,env);
 if(!sameScope(task.scope,env.scope)||state.running?.requestId!==task.requestId||state.running.revision!==task.revision||state.revision!==task.revision)return {applied:false,state:clone(state)};
 const next=clone(state);next.revision++;next.running=null;
 if(task.accessRevision!==env.accessRevision||task.dataRevision!==env.dataRevision||outcome.kind==='failed'){
  next.failure=outcome.kind==='failed'?outcome.code:'TASK_RESULT_STALE';return {applied:true,state:next};
 }
 if(task.kind!==outcome.kind)fail('TASK_RESULT_KIND_MISMATCH');
 if(next.history.length>=100)fail('TASK_HISTORY_LIMIT');
 const common={handle:'t'+(next.history.length+1),requestId:task.requestId,dataRevision:task.dataRevision};
 let stored:StoredTask;
 if(task.kind==='read'&&outcome.kind==='read'){
  next.book=acceptTaskResult(next.book,{status:'resolved',query:task.node.query,node:task.node,inheritedFrom:task.node.parent});
  stored={...common,kind:'read',node:clone(task.node),result:clone(outcome.result)};
 }else if(task.kind==='loan'&&outcome.kind==='loan')stored={...common,kind:'loan',input:clone(task.input),results:clone(outcome.results)};
 else if(task.kind==='loan_comparison'&&outcome.kind==='loan_comparison'){
  // Keep the comparison as a checked result. Common conditions can continue;
  // divergent conditions require a choice, never an arbitrary first variant.
  const input:LoanDraft={},unresolvedFields:string[]=[];
  for(const field of ['principalRubles','annualRatePercent','months','payment','prepayments','rateChanges'] as const){
   const values=task.inputs.map(v=>v[field]);
   const identity=(value:typeof values[number])=>typeof value==='string'&&(field==='principalRubles'||field==='annualRatePercent')?calculatorRublesMinor(value):canonical(value);
   if(values.every(v=>identity(v)===identity(values[0]))){if(values[0]!==undefined)Object.assign(input,{[field]:clone(values[0])});}
   else if(field!=='payment')unresolvedFields.push(field);
  }
  stored={...common,kind:'loan',input,results:clone(outcome.results),unresolvedFields,comparison:clone(outcome)};
 }else return fail('TASK_RESULT_KIND_MISMATCH');
 next.history.push(stored);next.active=stored.handle;next.failure=null;return {applied:true,state:next};
}
export function taskProjection(state:State){
 const pending=state.pending;
 const missing=pending?.draft.kind==='loan'?[...new Set([...['principalRubles','annualRatePercent','months'].filter(k=>(pending.draft as {input:Record<string,unknown>}).input[k]===undefined),...pending.draft.unresolvedFields??[]])]:['metric'];
 return {active:state.active,pending:pending?{handle:pending.handle,kind:pending.draft.kind,missing}:null,tasks:state.history.map(task=>task.kind==='read'?{handle:task.handle,kind:task.kind,metric:task.node.query.metric,grouping:task.node.query.grouping,comparison:task.node.query.comparison,period:{from:task.node.query.filter.from,through:task.node.query.filter.through}}:
  {handle:task.handle,kind:task.kind,variants:task.results.map((r,i)=>({handle:task.handle+'_v'+(i+1),input:clone(r.input)}))})};
}
