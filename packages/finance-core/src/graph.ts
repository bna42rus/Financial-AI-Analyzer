import {assertComponentSum,parsePersistedMinor,sumMinor} from './money.ts';
import {effective,operationDay} from './model.ts';
import {allocationOrder,allocationParents} from './allocation-graph.ts';
import type {Graph,Operation,Facet,Role,Link} from './model.ts';

type Node={id:string;operation:Operation;componentId:string|null;amount:bigint;role:Facet<Role>;category:Facet<string|null>;subcategory:Facet<string|null>;allocationId?:string|null;basis?:string[]};
export type Part={id:string;componentId:string|null;allocationId:string|null;amountMinor:string;role:Role;categoryId:string|null;subcategoryId:string|null;basis:string[];included:boolean};
export type Projection={id:string;date:ReturnType<typeof effective>['operationDate'];accountId:string;amountMinor:string;analyticsRole:Role|'mixed';parts:Part[];reviewReasons:string[];decompositionActive:boolean;unresolvedMinor:string;neutralMinor:string;excludedMinor:string};
export type LinkOutcome={id:string;active:boolean;reason:string|null};
const abs=(n:bigint)=>n<0n?-n:n;
const family=(l:Link)=>['refund','expense_reimbursement','reversal'].includes(l.kind)?'return':l.kind;

/** Rebuild from the current source + decisions on every revision. Invalid decisions are retained,
 * but never used as a calculation basis. No DB/network/AI or silent allocation clipping. */
export function reconcile(graph:Graph):{operations:Projection[];links:LinkOutcome[]} {
 const accounts=new Map(graph.accounts.map(a=>[a.id,a])),cats=new Map(graph.categories.map(c=>[c.id,c]));
 const nodes=new Map<string,Node[]>(),reasons=new Map<string,Set<string>>(),invalid=new Map<string,string>();
 const addReason=(id:string,reason:string)=>reasons.get(id)?.add(reason);
 const compatible=(role:Role,catId:string|null,subId:string|null)=>{
  if(subId&&!catId)return false;
  const cat=catId?cats.get(catId):null,sub=subId?cats.get(subId):null;
  return (!catId||!!cat&&cat.parentId===null&&(role!=='expense'&&role!=='income'||cat.role==='both'||cat.role===role))&&(!subId||!!sub&&sub.parentId===catId&&(role!=='expense'&&role!=='income'||sub.role==='both'||sub.role===role));
 };
 for(const op of graph.operations){
  const fact=effective(op),amount=parsePersistedMinor(fact.amountMinor),parts=graph.components.filter(c=>c.transactionId===op.id);
  reasons.set(op.id,new Set(op.reviewReasons));
  if(!accounts.has(fact.accountId))throw new TypeError('MISSING_ACCOUNT');
  let base:Node[];
  if(op.decomposition){
   try {assertComponentSum(amount,parts.map(c=>parsePersistedMinor(c.amountMinor)));base=parts.map(c=>{
    let role=c.role;
    if(op.semantics.kind.value==='loan_payment'&&!role.userVerified){const mode=accounts.get(fact.accountId)!.loanMode??graph.loanMode;role={...role,value:mode==='cashflow'?'expense':c.type==='principal'?'neutral':['interest','fee','insurance'].includes(c.type)?'expense':role.value};}
    return {id:op.id+':component:'+c.id,operation:op,componentId:c.id,amount:parsePersistedMinor(c.amountMinor),role,category:c.category,subcategory:c.subcategory};
   });}
   catch {addReason(op.id,'component_conflict');base=[{id:op.id+':root',operation:op,componentId:null,amount,role:{...op.semantics.role,value:'unresolved',userVerified:false},category:op.semantics.category,subcategory:op.semantics.subcategory}];}
  } else {
   let role=op.semantics.role;
   if(op.semantics.kind.value==='loan_payment'&&!role.userVerified&&(accounts.get(fact.accountId)!.loanMode??graph.loanMode)==='economic') {role={...role,value:'unresolved'};addReason(op.id,'incomplete_credit_data');}
   base=[{id:op.id+':root',operation:op,componentId:null,amount,role,category:op.semantics.category,subcategory:op.semantics.subcategory}];
  }
  for(const n of base){
   if(!n.category.userVerified&&n.category.confidence<90){addReason(op.id,'low_category_confidence');if(n.category.confidence<70){n.category={...n.category,value:null};n.subcategory={...n.subcategory,value:null};}}
   if(!compatible(n.role.value,n.category.value,n.subcategory.value)){
    addReason(op.id,'category_conflict');
    if(!compatible(n.role.value,n.category.value,null)){n.category={...n.category,value:null};n.subcategory={...n.subcategory,value:null};}
    else n.subcategory={...n.subcategory,value:null};
   }
  }
  nodes.set(op.id,base);
 }
 type Valid={link:Link;source:Node;target:Node;amount:bigint};
 const proposed:Valid[]=[],generated=new Map<string,Map<string,Node>>(),byId=new Map(graph.links.map(l=>[l.id,l]));
 const baseEndpoint=(opId:string,id:string|null)=>{const list=nodes.get(opId);return id?list?.find(n=>n.componentId===id):list?.length===1&&list[0]!.componentId===null?list[0]:undefined;};
 const endpoint=(opId:string,component:string|null,allocation:string|null|undefined)=>allocation?generated.get(allocation)?.get(opId):baseEndpoint(opId,component);
 const neutral=(link:Link)=>['own_transfer','debt_repayment','credit_card_repayment'].includes(link.kind);
 const transformsTarget=(link:Link)=>['own_transfer','debt_repayment'].includes(link.kind);
 const ordered=allocationOrder(graph.links);
 for(const id of ordered.cyclic)invalid.set(id,'CYCLIC_DEPENDENCY');
 for(const link of ordered.order){
  if(link.status!=='confirmed')continue;
  const s=endpoint(link.sourceId,link.sourceComponentId,link.sourceAllocationId),t=endpoint(link.targetId,link.targetComponentId,link.targetAllocationId),amount=parsePersistedMinor(link.amountMinor);
  let error:string|null=null;
  if(!s||!t||link.sourceId===link.targetId||amount<=0n||link.sourceComponentId&&link.sourceAllocationId||link.targetComponentId&&link.targetAllocationId||allocationParents(link).some(id=>!byId.has(id)||invalid.has(id))||reasons.get(link.sourceId)?.has('component_conflict')||reasons.get(link.targetId)?.has('component_conflict'))error='DEPENDENCY_CONFLICT';
  else if(link.sourceAllocationId&&transformsTarget(byId.get(link.sourceAllocationId)!))error='SOURCE_ALREADY_PAIRED';
  else if(amount>abs(s.amount)||amount>abs(t.amount))error='CAPACITY_CONFLICT';
  else if(['refund','expense_reimbursement'].includes(link.kind)&&(s.amount<=0n||t.amount>=0n||t.role.value!=='expense'))error='INCOMPATIBLE_RETURN';
  else if(link.kind==='reversal'&&(s.amount*t.amount>=0n||t.role.value==='unresolved'))error='INCOMPATIBLE_REVERSAL';
  else if(['own_transfer','debt_repayment'].includes(link.kind)&&s.amount*t.amount>=0n)error='INCOMPATIBLE_TRANSFER';
  else if(link.kind==='credit_card_repayment'&&(s.operation.semantics.kind.value!=='credit_card_repayment'||!(t.operation.semantics.kind.value==='credit_card_repayment'||accounts.get(effective(t.operation).accountId)?.type==='credit_card'&&t.role.value==='expense')))error='INCOMPATIBLE_REPAYMENT';
  if(!error&&s&&t){
   const desired=neutral(link)?'neutral':t.role.value;
   if(s.role.userVerified&&s.role.value!==desired||transformsTarget(link)&&t.role.userVerified&&t.role.value!=='neutral')error='VERIFIED_FACET_CONFLICT';
   const cat=s.category.userVerified?s.category.value:t.category.value,sub=s.subcategory.userVerified?s.subcategory.value:s.category.userVerified&&s.category.value!==t.category.value?null:t.subcategory.value;
   if(!compatible(desired,cat,sub))error='CATEGORY_CONFLICT';
  }
  if(error){invalid.set(link.id,error);continue;}
  const v={link,source:s!,target:t!,amount};proposed.push(v);
  const parts=new Map<string,Node>();
  for(const node of [v.source,...(transformsTarget(link)?[v.target]:[])]){
   const isNeutral=neutral(link),category=node.category.userVerified||isNeutral?node.category.value:v.target.category.value,subcategory=node.subcategory.userVerified||isNeutral?node.subcategory.value:node.category.userVerified&&node.category.value!==v.target.category.value?null:v.target.subcategory.value;
   parts.set(node.operation.id,{...node,id:link.id+':'+node.operation.id+':allocation',allocationId:link.id,amount:node.amount<0n?-amount:amount,
    role:{...node.role,value:isNeutral?'neutral':v.target.role.value},category:{...node.category,value:category},subcategory:{...node.subcategory,value:subcategory},
    basis:[...new Set([link.id,...allocationParents(link),...(!isNeutral?[v.target.operation.id]:[])])]});
  }
  generated.set(link.id,parts);
 }
 // Reject all members of an oversubscribed pool. Order cannot pick an arbitrary winner.
 const pools=new Map<string,{capacity:bigint;entries:Valid[]}>();
 const put=(key:string,node:Node,v:Valid)=>{const p=pools.get(key)??{capacity:abs(node.amount),entries:[]};p.entries.push(v);pools.set(key,p);};
 for(const v of proposed){put('source:'+v.source.id,v.source,v);put('target:'+family(v.link)+':'+v.target.id,v.target,v);}
 for(const p of pools.values())if(sumMinor(p.entries.map(v=>v.amount))>p.capacity)for(const v of p.entries)invalid.set(v.link.id,'CAPACITY_CONFLICT');
 // Neutralized target portions and source allocations cannot cover the same signed money twice.
 const effects=new Map<string,Valid[]>();
 for(const v of proposed)for(const n of [v.source,...(transformsTarget(v.link)?[v.target]:[])]){const p=effects.get(n.id)??[];p.push(v);effects.set(n.id,p);}
 for(const [id,p]of effects){const node=p[0]!.source.id===id?p[0]!.source:p[0]!.target;if(sumMinor(p.map(v=>v.amount))>abs(node.amount))for(const v of p)invalid.set(v.link.id,'CAPACITY_CONFLICT');}
 // A transformed portion must be named explicitly, rather than borrowing the original root meaning.
 const ambiguous=new Set<string>();
 for(const v of proposed)if(!invalid.has(v.link.id)&&(effects.get(v.target.id)??[]).some(other=>other.link.id!==v.link.id&&!invalid.has(other.link.id)))ambiguous.add(v.link.id);
 // Evaluate against one snapshot: marking the first conflict must not turn the
 // other conflicting interpretation into an input-order-dependent winner.
 for(const id of ambiguous)invalid.set(id,'AMBIGUOUS_ENDPOINT');
 // A rejected ancestor makes every dependent interpretation unusable, while preserving decisions.
 for(const v of proposed)if(!invalid.has(v.link.id)&&allocationParents(v.link).some(id=>invalid.has(id)))invalid.set(v.link.id,'DEPENDENCY_CONFLICT');
 for(const link of graph.links)if(invalid.has(link.id)){addReason(link.sourceId,'dependency_conflict');addReason(link.targetId,'dependency_conflict');}
 const activeEffects=new Map<string,Node[]>();
 for(const v of proposed)if(!invalid.has(v.link.id))for(const n of [v.source,...(transformsTarget(v.link)?[v.target]:[])]){
  const list=activeEffects.get(n.id)??[];list.push(generated.get(v.link.id)!.get(n.operation.id)!);activeEffects.set(n.id,list);
 }
 const result:Projection[]=[];
 for(const op of graph.operations){
  const fact=effective(op),output:Part[]=[];
  const stack=[...nodes.get(op.id)!].reverse();
  while(stack.length){
   const node=stack.pop()!,children=(activeEffects.get(node.id)??[]).sort((a,b)=>a.id.localeCompare(b.id)),remaining=node.amount-sumMinor(children.map(n=>n.amount));
   // Only terminal portions participate; ancestors and parent transactions are never added again.
   if(remaining!==0n||children.length===0)output.push({id:node.allocationId&&children.length===0?node.id:node.id+':remainder',componentId:node.componentId,allocationId:node.allocationId??null,amountMinor:remaining.toString(),role:node.role.value,categoryId:node.category.value,subcategoryId:node.subcategory.value,basis:node.basis??[],included:true});
   for(let i=children.length-1;i>=0;i--)stack.push(children[i]!);
  }
  let unresolved=0n,neutral=0n,excluded=0n;
  for(const p of output){
   const amount=parsePersistedMinor(p.amountMinor);
   const category=p.categoryId?cats.get(p.categoryId):null;
   // Incompatible category is reviewable, without hiding a reliably known expense.
   if(category&&p.role!=='neutral'&&p.role!=='unresolved'&&category.role!=='both'&&category.role!==p.role){p.categoryId=null;p.subcategoryId=null;addReason(op.id,'category_conflict');}
   if((p.role==='expense'||p.role==='income')&&p.categoryId===null)addReason(op.id,'category_not_defined');
   if(p.role==='unresolved'){unresolved+=abs(amount);addReason(op.id,'unresolved_role');}
   if(p.role==='neutral')neutral+=abs(amount);
   p.included=op.analyticsOverride==='include'||op.analyticsOverride!=='exclude'&&accounts.get(fact.accountId)!.analyticsEnabled;
   if(!p.included)excluded+=abs(amount);
  }
  if(op.semantics.kind.value==='refund'&&output.some(p=>p.role==='unresolved'))addReason(op.id,'unlinked_refund');
  if(op.semantics.kind.value==='credit_card_repayment'&&!graph.operations.some(p=>accounts.get(effective(p).accountId)?.type==='credit_card'&&p.semantics.kind.value==='purchase'))addReason(op.id,'incomplete_credit_data');
  if(['transfer_in','transfer_out'].includes(op.semantics.kind.value)&&output.some(p=>p.role==='unresolved'))addReason(op.id,'unresolved_transfer');
  assertComponentSum(parsePersistedMinor(fact.amountMinor),output.map(p=>parsePersistedMinor(p.amountMinor)));
  const roles=[...new Set(output.map(p=>p.role))];
  result.push({id:op.id,date:fact.operationDate,accountId:fact.accountId,amountMinor:fact.amountMinor,analyticsRole:roles.length>1?'mixed':roles[0]!,parts:output,reviewReasons:[...reasons.get(op.id)!].sort(),decompositionActive:op.decomposition||output.length>1,unresolvedMinor:unresolved.toString(),neutralMinor:neutral.toString(),excludedMinor:excluded.toString()});
 }
 return {operations:result,links:graph.links.map(l=>({id:l.id,active:l.status==='confirmed'&&!invalid.has(l.id),reason:invalid.get(l.id)??null}))};
}
export type Filter={from?:string;through?:string;accountIds?:string[];categoryIds?:string[];includeExcluded?:boolean};
export function aggregate(projections:Projection[],filter:Filter={}){
 let gross=0n,reductions=0n,income=0n,unresolved=0n,neutral=0n,excluded=0n;const category=new Map<string|null,{gross:bigint;reductions:bigint;income:bigint}>(),ids:string[]=[],attention:string[]=[];
 for(const op of projections){
  const day=operationDay(op.date);if(filter.from&&day<filter.from||filter.through&&day>filter.through||filter.accountIds&&!filter.accountIds.includes(op.accountId))continue;
  let selected=false;
  for(const p of op.parts){if(filter.categoryIds&&(!p.categoryId||!filter.categoryIds.includes(p.categoryId)))continue;selected=true;const amount=parsePersistedMinor(p.amountMinor);
   if(!p.included&&!filter.includeExcluded){excluded+=abs(amount);continue;}
   if(p.role==='neutral'){neutral+=abs(amount);continue;}if(p.role==='unresolved'){unresolved+=abs(amount);continue;}
   const c=category.get(p.categoryId)??{gross:0n,reductions:0n,income:0n};
   if(p.role==='income'){income+=amount;c.income+=amount;}else if(amount<0n){gross-=amount;c.gross-=amount;}else{reductions+=amount;c.reductions+=amount;}
   category.set(p.categoryId,c);
  }
  if(selected){ids.push(op.id);if(op.reviewReasons.length)attention.push(op.id);}
 }
 const net=gross-reductions;return {grossExpensesMinor:gross.toString(),expenseReductionsMinor:reductions.toString(),netExpensesMinor:net.toString(),incomeMinor:income.toString(),differenceMinor:(income-net).toString(),unresolvedMinor:unresolved.toString(),neutralMinor:neutral.toString(),excludedMinor:excluded.toString(),operationIds:ids,attentionIds:attention,categories:[...category].map(([id,c])=>({id,grossExpensesMinor:c.gross.toString(),expenseReductionsMinor:c.reductions.toString(),netExpensesMinor:(c.gross-c.reductions).toString(),incomeMinor:c.income.toString()}))};
}
