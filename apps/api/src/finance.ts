import {parseCounterpartyRuleConditions,parseProposalOperations,saveCounterpartyOptions} from './counterparty-proposals.ts';
import {parseCategoryBinding,applyCategoryBinding} from './category-bindings.ts';
import type {CategoryBindingIntent} from './category-bindings.ts';
import {initialBankSemantics,refreshBankSemantics,applyFinancialRecognition} from '../../../packages/finance-core/src/financial-evidence.ts';
import {parseSelectedCategories,applySelectedCategories} from './selected-categories.ts';
import type {SelectedCategoryIntent} from './selected-categories.ts';
import {operationDisplayName} from '../../../packages/finance-core/src/operation-name.ts';
import {cleanBankText} from '../../../packages/imports/src/bank-description.ts';
import {parseOverviewIntent,applyOverviewIntent} from './overview.ts';
import type {OverviewIntent} from './overview.ts';
import {parseBudgetIntent,applyBudgetIntent} from './budgets.ts';
import type {BudgetIntent} from './budgets.ts';
import {parseViewIntent,applyViewIntent,repairOperationsViews} from './operations.ts';
import type {ViewIntent} from './operations.ts';
import {parseRuleIntent,applyRuleIntent} from './finance-rules.ts';
import type {RuleIntent} from './finance-rules.ts';
import {createHash,randomUUID} from 'node:crypto';
import {sourceEvidence,resolveSourceText} from './import-source.ts';
import {parseCancelImport,cancelImport} from './import-cancellation.ts';
import type {CancelImportIntent} from './import-cancellation.ts';
import {parseMergeDuplicate,mergeDuplicate} from './duplicate-merge.ts';
import type {MergeDuplicateIntent} from './duplicate-merge.ts';
import {parseBulkIntent,parseOperationPatch,bulkPatches} from './finance-bulk.ts';
import type {BulkIntent} from './finance-bulk.ts';
import {reviewStatus} from '../../../packages/finance-core/src/review.ts';
import {assertReviewGroup} from './finance-review-group.ts';
import type {PoolClient} from 'pg';
import {drizzle,eq} from '../../../packages/database/src/finance.ts';
import * as tables from '../../../packages/database/src/finance.ts';
import {allowedOperationRoles,object,choice,uuid,dateFact,correction,effective,facet,normalizeEmptyCategoryConfidence,kinds,linkKinds} from '../../../packages/finance-core/src/model.ts';
import type {Graph,BankFact,Kind,Component,Link,Semantics,Operation} from '../../../packages/finance-core/src/model.ts';
import {parsePersistedMinor} from '../../../packages/finance-core/src/money.ts';
import {allocationOrder,allocationParents} from '../../../packages/finance-core/src/allocation-graph.ts';
import {reconcile,aggregate} from '../../../packages/finance-core/src/graph.ts';
import type {Filter} from '../../../packages/finance-core/src/graph.ts';
import {starterCategories,isMarketplaceName} from '../../../packages/finance-core/src/starter.ts';
import {applyRules,ruleMatches,validateRule} from '../../../packages/finance-core/src/rules.ts';
import type {Rule} from '../../../packages/finance-core/src/rules.ts';
import {safeText} from '../../../packages/privacy/src/text.ts';
import {HttpError,LinkEditError} from './types.ts';
import type {Sealer} from './types.ts';
import {previewReset,commitReset} from './finance-reset.ts';
import {assertImportEpoch,assertPreparedContext} from './pseudonym-context.ts';
import type {ImportEpoch,PreparedImportContext} from './pseudonym-context.ts';
export {importEpoch,prepareImportContext} from './pseudonym-context.ts';
import {isStructural,parseStructuralIntent,applyStructural,restoreStructure,canonicalAccount,activeAccount} from './finance-structure.ts';
import type {StructuralIntent,StructuralUndo} from './finance-structure.ts';
import {isEntityKind,parseEntityIntent,applyEntity,restoreEntities,partyRows,activeParty,canonicalParty,counterpartyNameKey} from './finance-entities.ts';
import type {EntityIntent,EntityUndo} from './finance-entities.ts';
import {parseExclusionIntent,applyExclusion} from './finance-exclusions.ts';
import type {ExclusionIntent,BatchUndo} from './finance-exclusions.ts';
import {parseRestoreIntent,restoreHistory,captureHistory,historyDelta,publicChanges,associatedOperations,stableJSON} from './finance-history.ts';
import type {RestoreIntent,HistoryUndo,Change} from './finance-history.ts';
export {queryHistory} from './finance-history.ts';

const bool=(v:unknown)=>{if(typeof v!=='boolean')throw new TypeError('INVALID_BOOLEAN');return v;};
const ref=(v:unknown)=>v===null?null:uuid(v);
function stable(value:unknown):string {return JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
function revision(v:unknown){if(typeof v!=='string'||!/^(0|[1-9]\d*)$/.test(v))throw new TypeError('INVALID_REVISION');return v;}
export async function prepareFinance(db:PoolClient,userId:string){
 await db.query("SELECT set_config('app.user_id',$1,true)",[userId]);
 // Stable lock order shared with access mutations. No entitlement can change during this stage.
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['access-cycle:'+userId]);
 const state=(await db.query(`SELECT u.email_verified,s.status,CASE WHEN c.user_id IS NOT NULL THEN c.indefinite ELSE s.indefinite END AS indefinite,
 CASE WHEN c.user_id IS NOT NULL THEN c.access_end ELSE s.access_end END AS access_end,clock_timestamp() AS now
 FROM identity.auth_user u JOIN identity.security_state s ON s.user_id=u.id LEFT JOIN commerce.access_cycle c ON c.user_id=u.id WHERE u.id=$1 FOR SHARE OF u,s`,[userId])).rows[0];
 if(!state?.email_verified||state.status!=='active'||!state.indefinite&&!(state.access_end>state.now))throw new HttpError(403,'FINANCE_ACCESS_REQUIRED');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['finance-workspace:'+userId]);
 const created=await db.query('INSERT INTO finance.workspace(user_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING generation',[userId]);
 if(created.rowCount)for(const role of ['expense','income']as const)for(const names of starterCategories[role]){
  const parent=randomUUID();await db.query('INSERT INTO finance.category(user_id,id,name,role) VALUES($1,$2,$3,$4)',[userId,parent,names[0],role]);
  for(const name of names.slice(1))await db.query('INSERT INTO finance.category(user_id,id,parent_id,name,role) VALUES($1,$2,$3,$4,$5)',[userId,randomUUID(),parent,name,role]);
 }
 let workspace=(await db.query('SELECT * FROM finance.workspace WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
 if(!workspace.marketplace_catalog_initialized){
  const categories=(await db.query("SELECT name FROM finance.category WHERE user_id=$1 AND role IN ('expense','both')",[userId])).rows;
  const missing=!categories.some(c=>isMarketplaceName(c.name));
  if(missing)await db.query("INSERT INTO finance.category(user_id,id,name,role) VALUES($1,$2,'Маркетплейсы','expense')",[userId,randomUUID()]);
  workspace=(await db.query('UPDATE finance.workspace SET marketplace_catalog_initialized=true,revision=revision+$2 WHERE user_id=$1 RETURNING *',[userId,missing?1:0])).rows[0];
 }
 return workspace as {generation:string;revision:string;loan_mode:'cashflow'|'economic';key_version:string;interface_epoch:string;config_revision:string};
}
export async function loadFinance(db:PoolClient,userId:string){
 const orm=drizzle(db),a=await orm.select().from(tables.accounts).where(eq(tables.accounts.userId,userId)).orderBy(tables.accounts.id),c=await orm.select().from(tables.categories).where(eq(tables.categories.userId,userId)).orderBy(tables.categories.id),t=await orm.select().from(tables.transactions).where(eq(tables.transactions.userId,userId)).orderBy(tables.transactions.id),o=await orm.select().from(tables.observations).where(eq(tables.observations.userId,userId)).orderBy(tables.observations.id),p=await orm.select().from(tables.components).where(eq(tables.components.userId,userId)).orderBy(tables.components.id),l=await orm.select().from(tables.links).where(eq(tables.links.userId,userId)).orderBy(tables.links.id);
 const sourceMap=(await db.query<{observationId:string;transactionId:string;originalAccountId:string;assignedAccountId:string}>(`SELECT b.observation_id AS "observationId",finance.canonical_operation(o.user_id,o.transaction_id) AS "transactionId",o.account_id AS "originalAccountId",b.account_id AS "assignedAccountId" FROM finance.observation_account b JOIN finance.source_observation o ON (o.user_id,o.id)=(b.user_id,b.observation_id) WHERE b.user_id=$1 ORDER BY b.observation_id`,[userId])).rows;
 const assignments=new Map(sourceMap.map(r=>[r.observationId,r.assignedAccountId])),observations=new Map(o.map(r=>[r.id,r])),state=(await db.query('SELECT generation,revision,loan_mode,key_version,interface_epoch FROM finance.workspace WHERE user_id=$1',[userId])).rows[0];
 const evidence=await sourceEvidence(db,userId),evidenceByOperation=new Map<string,typeof evidence>();
 for(const row of evidence){const own=evidenceByOperation.get(row.transaction_id)??[];own.push(row);evidenceByOperation.set(row.transaction_id,own);}
 const transactionById=new Map(t.map(r=>[r.id,r]));
 const bindings=(await db.query('SELECT target_key,category_id,subcategory_id FROM finance.category_binding WHERE user_id=$1 ORDER BY target_key',[userId])).rows;
 const categoryBindings=Object.fromEntries(bindings.map(b=>[b.target_key,{categoryId:b.category_id,subcategoryId:b.subcategory_id}]));
 const bankParties=new Map<string,Set<string>>();
 const partyEvidence=(await db.query<{transaction_id:string;counterparty_id:string}>(
  `SELECT DISTINCT finance.canonical_operation(o.user_id,o.transaction_id) AS transaction_id,b.counterparty_id
   FROM finance.observation_counterparty b JOIN finance.source_observation o ON (o.user_id,o.id)=(b.user_id,b.observation_id)
   WHERE b.user_id=$1 AND b.alias_id IS NOT NULL AND o.versions->>'counterpartyEvidence'='counterparty-identity/1'`,[userId])).rows;
 for(const entry of partyEvidence){
  const ids=bankParties.get(entry.transaction_id)??new Set<string>();
  ids.add(entry.counterparty_id);bankParties.set(entry.transaction_id,ids);
 }
 const graph:Graph={categoryBindings,accounts:a.map(({userId,revision,systemName,...r})=>r),categories:c.map(({userId,revision,...r})=>r),operations:t.filter(r=>!r.mergedIntoId).map(r=>{
  const source=observations.get(r.sourceObservationId!);if(!source)throw new TypeError('SOURCE_MISSING');
  const assignment=assignments.get(source.id);if(!assignment)throw new TypeError('ACCOUNT_ASSIGNMENT_MISSING');
  const {userId,id,transactionId,...fact}=source;return {id:r.id,source:resolveSourceText({...fact,amountMinor:fact.amountMinor.toString(),operationAmountMinor:fact.operationAmountMinor?.toString()??null},r.id,source.id,evidenceByOperation.get(r.id)??[]),accountAssignmentId:assignment,bankCounterpartyId:bankParties.get(r.id)?.size===1?bankParties.get(r.id)?.values().next().value:undefined,corrections:r.corrections,semantics:normalizeEmptyCategoryConfidence({...r.semantics,merchant:{...r.semantics.merchant,value:cleanBankText(r.semantics.merchant.value,160)}}),comment:r.comment,analyticsOverride:r.analyticsOverride,decomposition:r.decomposition,reviewReasons:r.reviewReasons};
 }),components:p.filter(r=>r.active&&!!transactionById.get(r.transactionId)&&!transactionById.get(r.transactionId)!.mergedIntoId).map(({userId,active,...r})=>({...r,amountMinor:r.amountMinor.toString()})),links:l.map(({userId,revision,...r})=>({...r,amountMinor:r.amountMinor.toString()})),loanMode:state.loan_mode};
 return {graph,state,sourceMap,categoryOperations:t.map(r=>({id:r.id,role:r.semantics.role.value,categoryId:r.semantics.category.value,subcategoryId:r.semantics.subcategory.value,merchant:cleanBankText(r.semantics.merchant.value,160),retired:!!r.mergedIntoId})),categoryComponents:p.map(c=>({id:c.id,transactionId:c.transactionId,role:c.role.value,categoryId:c.category.value,subcategoryId:c.subcategory.value,retired:!c.active||!!transactionById.get(c.transactionId)?.mergedIntoId})),aliases:(await db.query('SELECT id,account_id AS "accountId",alias_type AS type FROM finance.account_alias WHERE user_id=$1 ORDER BY id',[userId])).rows as {id:string;accountId:string;type:string}[],parties:(await orm.select().from(tables.counterparties).where(eq(tables.counterparties.userId,userId)).orderBy(tables.counterparties.id)).map(({userId,revision,...r})=>({...r,revision:revision.toString()})),rules:(await db.query('SELECT id,name,enabled,priority,conditions,assignments,revision,dependency_status AS "dependencyStatus" FROM finance.rule WHERE user_id=$1 ORDER BY id',[userId])).rows as (Rule&{revision:string;dependencyStatus:string})[]};
}
export async function financeView(db:PoolClient,userId:string,filter:Filter={},compact=false){
 const {graph,state,parties,rules,sourceMap,aliases,categoryOperations,categoryComponents}=await loadFinance(db,userId),projection=reconcile(graph);
 const operationsById=new Map(graph.operations.map(o=>[o.id,o]));
 const counterpartySources=(await db.query('SELECT b.observation_id AS "observationId",finance.canonical_operation(o.user_id,o.transaction_id) AS "transactionId",b.counterparty_id AS "counterpartyId",b.alias_id AS "aliasId" FROM finance.observation_counterparty b JOIN finance.source_observation o ON (o.user_id,o.id)=(b.user_id,b.observation_id) WHERE b.user_id=$1 ORDER BY b.observation_id',[userId])).rows;
 const counterpartyAliases=(await db.query('SELECT id,counterparty_id AS "counterpartyId",alias_type AS type FROM finance.counterparty_alias WHERE user_id=$1 ORDER BY id',[userId])).rows;
 const partyIdentityIds=new Set(counterpartyAliases.map(row=>row.counterpartyId)),proposalIds=new Map<string,string[]>();
 for(const op of graph.operations)for(const id of new Set([op.bankCounterpartyId,op.semantics.counterparty.value]))if(id){
  const ids=proposalIds.get(id)??[];ids.push(op.id);proposalIds.set(id,ids);
 }
 const tombstones=(await db.query('SELECT id,merged_into_id AS "canonicalId" FROM finance.transaction WHERE user_id=$1 AND merged_into_id IS NOT NULL ORDER BY id',[userId])).rows;
 const summary=aggregate(projection.operations,filter);
 const duplicateCandidates=(await db.query<{id:string;leftId:string;rightId:string}>("SELECT id,left_id AS \"leftId\",right_id AS \"rightId\" FROM finance.duplicate_candidate WHERE user_id=$1 AND status='candidate' ORDER BY id",[userId])).rows;
 // Ambiguous repeat imports remain separate operations. They do not establish
 // a second independent transfer until the user confirms they are different.
 const ambiguousRepeats=new Set<string>();
 for(const pair of duplicateCandidates){
  const first=operationsById.get(pair.leftId)?.bankCounterpartyId;
  if(first&&first===operationsById.get(pair.rightId)?.bankCounterpartyId)ambiguousRepeats.add(pair.rightId);
 }
 return {categoryBindings:graph.categoryBindings,operationAliases:tombstones,duplicateCandidates,generation:state.generation,revision:state.revision,loanMode:graph.loanMode,keyVersion:state.key_version,interfaceEpoch:state.interface_epoch,accounts:graph.accounts.filter(a=>!a.mergedIntoId),mergedAccounts:graph.accounts.filter(a=>a.mergedIntoId),accountSources:compact?[]:sourceMap,accountAliases:compact?[]:aliases,categories:graph.categories,counterparties:parties.filter(p=>!p.mergedIntoId&&(p.state!=='discovered'||!partyIdentityIds.has(p.id)||(proposalIds.get(p.id)?.filter(id=>!ambiguousRepeats.has(id)).length??0)>=2)).map(p=>({...p,hasBankIdentity:partyIdentityIds.has(p.id),...(p.state==='registered'?{}:{proposalCandidates:(proposalIds.get(p.id)??[]).slice(0,1000)})})),mergedCounterparties:parties.filter(p=>p.mergedIntoId),counterpartySources:compact?[]:counterpartySources,counterpartyAliases:compact?[]:counterpartyAliases,categoryOperations:compact?[]:categoryOperations,categoryComponents:compact?[]:categoryComponents,rules,operationCount:projection.operations.length,operations:(compact?projection.operations.slice(0,100):projection.operations).map(p=>{const o=operationsById.get(p.id)!;return {...p,displayName:operationDisplayName(o,{counterparties:parties}),classification:o.semantics,comment:o.comment,description:o.source.description,postedDate:Object.hasOwn(o.corrections,'postedDate')?o.corrections.postedDate!:o.source.postedDate,bankCategory:o.source.bankCategory,reviewStatus:reviewStatus(p.reviewReasons,o.semantics)};}),links:projection.links,summary:compact?{...summary,operationIds:summary.operationIds.slice(0,100),attentionIds:summary.attentionIds.slice(0,100),operationCount:summary.operationIds.length,attentionCount:summary.attentionIds.length}:summary};
}
export function parseFilter(value:unknown):Filter{
 const r=object(value,['from','through','accountIds','categoryIds','includeExcluded','compact']),f:Filter={};
 for(const k of ['from','through']as const)if(k in r){const date=dateFact({precision:'day',date:r[k]});f[k]=(date as {date:string}).date;}
 if(f.from&&f.through&&f.from>f.through)throw new TypeError('INVALID_RANGE');
 for(const k of ['accountIds','categoryIds']as const)if(k in r){if(!Array.isArray(r[k])||r[k].length>100)throw new TypeError('INVALID_FILTER');f[k]=(r[k]as unknown[]).map(uuid);}
 if('compact'in r)bool(r.compact);
 if('includeExcluded'in r)f.includeExcluded=bool(r.includeExcluded);return f;
}
export async function operationView(db:PoolClient,userId:string,id:unknown){
 const requested=uuid(id),canonical=(await db.query('SELECT finance.canonical_operation($1,$2) AS id',[userId,requested])).rows[0].id;
 const {graph,state,parties}=await loadFinance(db,userId),op=graph.operations.find(o=>o.id===canonical);if(!op)throw new HttpError(404,'NOT_FOUND');
 const resolved=reconcile(graph),related=(l:{sourceId:string;targetId:string})=>l.sourceId===op.id||l.targetId===op.id;
 const links=graph.links.filter(related),linkIds=new Set(links.map(l=>l.id));
 const {bankRefHmac,...source}=op.source,{bankCounterpartyId,...publicOp}=op;return {...publicOp,source,displayName:operationDisplayName(op,{counterparties:parties}),generation:state.generation,revision:state.revision,projection:resolved.operations.find(p=>p.id===op.id),components:graph.components.filter(c=>c.transactionId===op.id),links,linkStates:resolved.links.filter(l=>linkIds.has(l.id))};
}
type BaseIntent={kind:'operation'|'components'|'link'|'account'|'category'|'counterparty'|'rule'|'analytics'|'undo';id:string;patch?:Record<string,unknown>;parts?:Component[];link?:Link;create?:boolean;value?:unknown};
type OperationCardIntent={kind:'operation_card';id:string;patch?:BaseIntent;components?:BaseIntent;links:BaseIntent[]};
type CreateHistoricalRuleIntent={kind:'create_rule_with_history';id:string;patch:Omit<Rule,'id'>};
type AccountSettingsIntent={kind:'account_settings';id:string;accounts:BaseIntent[]};
type Intent={kind:'reset_categories';id:string}|AccountSettingsIntent|OperationCardIntent|CreateHistoricalRuleIntent|CategoryBindingIntent|SelectedCategoryIntent|OverviewIntent|BudgetIntent|ViewIntent|RuleIntent|BaseIntent|BulkIntent|StructuralIntent|EntityIntent|ExclusionIntent|RestoreIntent|CancelImportIntent|MergeDuplicateIntent|{kind:'duplicate_different';id:string};
export function parseIntent(value:unknown):Intent {
 if(value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='set_category_binding')return parseCategoryBinding(value);
 if(value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='add_catalog_categories')return parseSelectedCategories(value);
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  if((value as Record<string,unknown>).kind==='reset_categories'){const r=object(value,['kind','id']);return {kind:'reset_categories',id:uuid(r.id)};}
  const k=(value as Record<string,unknown>).kind;if(['save_overview_view','delete_overview_view','reorder_overview_views'].includes(k as string))return parseOverviewIntent(value);if(k==='save_budget'||k==='set_budget_limit'||k==='delete_budget')return parseBudgetIntent(value);if(k==='save_operations_view'||k==='delete_operations_view'||k==='reorder_operations_views')return parseViewIntent(value);if(k==='delete_rule'||k==='apply_rules')return parseRuleIntent(value);if(k==='bulk_operations')return parseBulkIntent(value);if(k==='cancel_import')return parseCancelImport(value);
  if(k==='account_settings'){
   const r=object(value,['kind','id','accounts']);
   if(!Array.isArray(r.accounts)||!r.accounts.length||r.accounts.length>500)throw new TypeError('INVALID_ACCOUNTS');
   const accounts=r.accounts.map(raw=>{const a=object(raw,['id','patch']);object(a.patch,['name','type','analyticsEnabled','loanMode']);return parseIntent({kind:'account',id:uuid(a.id),patch:a.patch}) as BaseIntent;});
   if(new Set(accounts.map(a=>a.id)).size!==accounts.length)throw new TypeError('INVALID_ACCOUNTS');
   return {kind:k,id:uuid(r.id),accounts};
  }
  if(k==='create_rule_with_history'){const r=object(value,['kind','id','patch']);return {kind:k,id:uuid(r.id),patch:{...validateRule(r.patch),enabled:true}};}
  if(k==='operation_card'){
   const r=object(value,['kind','id','patch','components','links']),id=uuid(r.id);
   if(!Array.isArray(r.links)||r.links.length>50||!r.links.length&&r.patch===undefined&&r.components===undefined)throw new TypeError('INVALID_INTENT');
   const patch=r.patch===undefined?undefined:parseIntent({kind:'operation',id,patch:r.patch}) as BaseIntent;
   const components=r.components===undefined?undefined:parseIntent({kind:'components',id,parts:r.components}) as BaseIntent;
   const links=r.links.map(raw=>{
    const l=object(raw,['kind','id','link']);if(l.kind!=='link')throw new TypeError('INVALID_INTENT');
    const intent=parseIntent({...l,id:uuid(l.id)}) as BaseIntent;
    if(intent.link!.sourceId===intent.link!.targetId||![intent.link!.sourceId,intent.link!.targetId].includes(id))throw new TypeError('INVALID_INTENT');
    return intent;
   });
   if(new Set(links.map(l=>l.id)).size!==links.length)throw new TypeError('INVALID_INTENT');
   return {kind:k,id,patch,components,links};
  }
  if(k==='merge_duplicate')return parseMergeDuplicate(value);
  if(k==='duplicate_different'){const r=object(value,['kind','id']);return {kind:k,id:uuid(r.id)};}
 }
 if(value&&typeof value==='object'&&!Array.isArray(value)){const k=(value as Record<string,unknown>).kind;if(['save_overview_view','delete_overview_view','reorder_overview_views'].includes(k as string))return parseOverviewIntent(value);if(k==='set_exclusion')return parseExclusionIntent(value);if(k==='restore_history')return parseRestoreIntent(value);}
 if(value&&typeof value==='object'&&!Array.isArray(value)&&isStructural((value as Record<string,unknown>).kind as string))return parseStructuralIntent(value);
 if(value&&typeof value==='object'&&!Array.isArray(value)&&isEntityKind((value as Record<string,unknown>).kind as string))return parseEntityIntent(value);
 const r=object(value,['kind','id','patch','parts','link','create','value']),kind=choice(r.kind,['operation','components','link','account','category','counterparty','rule','analytics','undo']as const),intent:BaseIntent={kind,id:r.id===undefined?randomUUID():uuid(r.id)};
 const required=kind==='components'?['parts']:kind==='link'?['link']:['analytics','undo'].includes(kind)?['value']:['patch'];
 if(Object.keys(r).some(k=>!['kind','id',...required,...(['category','counterparty','rule'].includes(kind)?['create']:[])].includes(k))||required.some(k=>!(k in r)))throw new TypeError('INVALID_INTENT');
 if(['operation','components','account','undo'].includes(kind)&&r.id===undefined)throw new TypeError('MISSING_ID');
 if(kind==='operation'){
  intent.patch=parseOperationPatch(r.patch);
 }else if(kind==='components'){
  if(!Array.isArray(r.parts)||r.parts.length>50)throw new TypeError('INVALID_COMPONENTS');
  intent.parts=r.parts.map(v=>{const p=object(v,['id','type','amountMinor','role','categoryId','subcategoryId']);parsePersistedMinor(p.amountMinor);return {id:p.id===undefined?randomUUID():uuid(p.id),transactionId:intent.id,type:choice(p.type,['principal','interest','fee','insurance','other']),amountMinor:p.amountMinor as string,role:p.role===undefined?facet('unresolved'):facet(choice(p.role,['expense','income','neutral','unresolved']),'user',true),category:p.categoryId===undefined?facet(null):facet(ref(p.categoryId),'user',true),subcategory:p.subcategoryId===undefined?facet(null):facet(ref(p.subcategoryId),'user',true)};});
  if(new Set(intent.parts.map(p=>p.id)).size!==intent.parts.length)throw new TypeError('DUPLICATE_COMPONENT');
 }else if(kind==='link'){
  const p=object(r.link,['sourceId','targetId','sourceComponentId','targetComponentId','sourceAllocationId','targetAllocationId','kind','amountMinor','status']);if(parsePersistedMinor(p.amountMinor)<=0n)throw new TypeError('INVALID_ALLOCATION');
  intent.link={id:intent.id,sourceId:uuid(p.sourceId),targetId:uuid(p.targetId),sourceComponentId:p.sourceComponentId===undefined?null:ref(p.sourceComponentId),targetComponentId:p.targetComponentId===undefined?null:ref(p.targetComponentId),sourceAllocationId:p.sourceAllocationId===undefined?null:ref(p.sourceAllocationId),targetAllocationId:p.targetAllocationId===undefined?null:ref(p.targetAllocationId),kind:choice(p.kind,linkKinds),amountMinor:p.amountMinor as string,status:choice(p.status,['candidate','confirmed','rejected']),confidence:100,createdBy:'user'};
  if(intent.link.sourceComponentId&&intent.link.sourceAllocationId||intent.link.targetComponentId&&intent.link.targetAllocationId)throw new TypeError('AMBIGUOUS_ENDPOINT_SELECTOR');
  if(allocationParents(intent.link).includes(intent.id))throw new TypeError('SELF_ALLOCATION_REFERENCE');
 }else if(kind==='account'){
  const p=object(r.patch,['name','type','analyticsEnabled','defaultVisible','loanMode']),out:Record<string,unknown>={};if('name'in p)out.name=safeText(p.name,160);
  if('type'in p)out.type=choice(p.type,['debit_card','credit_card','bank_account','loan','savings','deposit','other']);for(const k of ['analyticsEnabled','defaultVisible']as const)if(k in p)out[k]=bool(p[k]);
  if('loanMode'in p)out.loanMode=p.loanMode===null?null:choice(p.loanMode,['cashflow','economic']);intent.patch=out;
 }else if(kind==='category'){
  const p=object(r.patch,['name','role','parentId','hidden']),out:Record<string,unknown>={};if('name'in p)out.name=safeText(p.name,160);if('role'in p)out.role=choice(p.role,['expense','income','both']);if('parentId'in p)out.parentId=ref(p.parentId);if('hidden'in p)out.hidden=bool(p.hidden);intent.patch=out;intent.create=r.create===undefined?false:bool(r.create);
 }else if(kind==='counterparty'){
  const p=object(r.patch,['name','state','isSelf','proposalOperationIds','rememberForFuture','ruleConditions','autoRuleId']),out:Record<string,unknown>={};if('name'in p)out.name=safeText(p.name,160);if('state'in p)out.state=choice(p.state,['registered','ignored']);if('isSelf'in p)out.isSelf=bool(p.isSelf);if('proposalOperationIds'in p)out.proposalOperationIds=parseProposalOperations(p.proposalOperationIds);if('rememberForFuture'in p)out.rememberForFuture=bool(p.rememberForFuture);if('ruleConditions'in p)out.ruleConditions=parseCounterpartyRuleConditions(p.ruleConditions,intent.id);if('autoRuleId'in p)out.autoRuleId=uuid(p.autoRuleId);if(('autoRuleId'in p||'ruleConditions'in p)&&out.rememberForFuture!==true)throw new TypeError('INVALID_COUNTERPARTY_CONDITION');intent.patch=out;intent.create=r.create===undefined?false:bool(r.create);
 }else if(kind==='rule'){intent.patch=validateRule(r.patch) as unknown as Record<string,unknown>;intent.create=r.create===undefined?false:bool(r.create);
 }else if(kind==='analytics')intent.value=choice(r.value,['cashflow','economic']);else intent.value=uuid(r.value);
 if(intent.patch&&Object.keys(intent.patch).length===0)throw new TypeError('EMPTY_PATCH');
 if(intent.patch&&'name'in intent.patch&&!intent.patch.name)throw new TypeError('EMPTY_NAME');
 if(['category','counterparty','rule'].includes(kind)&&!intent.create&&r.id===undefined)throw new TypeError('MISSING_ID');return intent;
}
const columns={transaction:['corrections','semantics','comment','analytics_override','decomposition','review_reasons'],account:['display_name','account_type','analytics_enabled','default_visible','loan_mode','merged_into_id'],category:['name','role','parent_id','hidden'],counterparty:['name','state','is_self','proposal_operation_ids','auto_rule_id'],rule:['name','enabled','priority','conditions','assignments','dependency_status'],link:['source_id','target_id','source_component_id','target_component_id','source_allocation_id','target_allocation_id','kind','amount_minor','status','confidence','created_by']}as const;
type Undo={table:keyof typeof columns|'components'|'workspace';id:string;before:Record<string,unknown>|Record<string,unknown>[]|null}|StructuralUndo|EntityUndo|BatchUndo|HistoryUndo;
const jsonColumns=new Set(['corrections','semantics','review_reasons','conditions','assignments','role','category','subcategory']);
async function update(db:PoolClient,userId:string,table:keyof typeof columns,id:string,values:Record<string,unknown>){
 const keys=Object.keys(values);if(!keys.length||keys.some(k=>!(columns[table]as readonly string[]).includes(k)))throw new TypeError('INVALID_INTERNAL_PATCH');
 const params=keys.map(k=>jsonColumns.has(k)&&!(table==='category'&&k==='role')?JSON.stringify(values[k]):values[k]);await db.query(`UPDATE finance.${table} SET ${keys.map((k,i)=>k+'=$'+(i+3)).join(',')},revision=revision+1 WHERE user_id=$1 AND id=$2`,[userId,id,...params]);
}
async function row(db:PoolClient,userId:string,table:keyof typeof columns,id:string){const r=(await db.query(`SELECT * FROM finance.${table} WHERE user_id=$1 AND id=$2`,[userId,id])).rows[0];if(!r)throw new HttpError(404,'NOT_FOUND');if(table==='transaction'&&r.merged_into_id)throw new HttpError(409,'OPERATION_MERGED');return r;}
function ownRefs(graph:Graph,parties:{id:string;mergedIntoId:string|null}[],p:Record<string,unknown>){
 if(p.accountId!==undefined&&p.accountId!==null)activeAccount(graph,p.accountId as string);
 if(p.counterpartyId!==undefined&&p.counterpartyId!==null&&parties.some(a=>a.id===p.counterpartyId&&a.mergedIntoId))throw new HttpError(409,'COUNTERPARTY_MERGED');
 for(const [key,items]of [['accountId',graph.accounts],['categoryId',graph.categories],['subcategoryId',graph.categories],['counterpartyId',parties]]as const)if(p[key]!==undefined&&p[key]!==null&&!items.some(i=>i.id===p[key]))throw new HttpError(404,'NOT_FOUND');
}
function categoryCompatible(graph:Graph,role:string,categoryId:string|null,subcategoryId:string|null){
 const category=graph.categories.find(c=>c.id===categoryId),sub=graph.categories.find(c=>c.id===subcategoryId),allows=(r:string)=>!['expense','income'].includes(role)||r==='both'||r===role;
 if(category&&(category.parentId!==null||!allows(category.role))||sub&&(sub.parentId!==category?.id||!allows(sub.role)))throw new HttpError(409,'CATEGORY_ROLE_CONFLICT');
}
async function apply(db:PoolClient,userId:string,intent:Intent,currentRevision:string,actionId:string):Promise<Undo>{
 if(intent.kind==='account_settings'){
  const loaded=await loadFinance(db,userId);
  for(const edit of intent.accounts)await applyBase(db,userId,edit,currentRevision,loaded);
  return {table:'batch',id:intent.id,before:null,details:{kind:intent.kind}};
 }
 if(intent.kind==='set_category_binding')return applyCategoryBinding(db,userId,intent,(await loadFinance(db,userId)).graph);
 if(intent.kind==='reset_categories'){
  const {graph}=await loadFinance(db,userId),keep=new Set<string>(),created:string[]=[],removed:string[]=[],unhidden:string[]=[],rulesNeedSetup=new Set<string>();
  const fold=(name:string)=>name.normalize('NFKC').trim().toLocaleLowerCase('ru').replaceAll('ё','е');
  function stableId(path:string){const h=createHash('sha256').update(intent.id+':'+path).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);}
  for(const role of ['expense','income'] as const)for(const [root,...children] of starterCategories[role]){
   async function ensure(name:string,parentId:string|null){
    const match=graph.categories.find(c=>c.parentId===parentId&&c.role===role&&fold(c.name)===fold(name));
    const id=match?.id??stableId(role+':'+(parentId??'')+':'+name);keep.add(id);
    if(match){if(match.hidden||match.name!==name){await db.query('UPDATE finance.category SET hidden=false,name=$3,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,id,name]);if(match.hidden)unhidden.push(name);}}
    else {await db.query('INSERT INTO finance.category(user_id,id,name,role,parent_id) VALUES($1,$2,$3,$4,$5)',[userId,id,name,role,parentId]);created.push(name);}
    return id;
   }
   const parent=await ensure(root,null);for(const child of children)await ensure(child,parent);
  }
  let current=graph;
  for(const c of graph.categories.filter(c=>!keep.has(c.id)&&(!c.parentId||keep.has(c.parentId)))){
   const effect=await applyEntity(db,userId,{kind:'delete_category',id:c.id,replacementId:null,childRoles:[],roleDecisions:[]},current);
   for(const id of effect.details.categoriesRemoved as string[]){const name=graph.categories.find(c=>c.id===id)?.name;if(name)removed.push(name);await repairOperationsViews(db,userId,{kind:'delete_category',id});}
   for(const id of effect.details.rulesNeedSetup as string[])rulesNeedSetup.add(id);
   current={...current,categories:current.categories.filter(c=>!(effect.details.categoriesRemoved as string[]).includes(c.id))};
  }
  return {table:'batch',id:intent.id,before:null,details:{kind:intent.kind,created,removed,unhidden,rulesNeedSetup:[...rulesNeedSetup],financialOperationsDeleted:0}};
 }
 if(intent.kind==='add_catalog_categories')return applySelectedCategories(db,userId,intent,(await loadFinance(db,userId)).graph);
 if(intent.kind==='save_overview_view'||intent.kind==='delete_overview_view'||intent.kind==='reorder_overview_views')return applyOverviewIntent(db,userId,intent);
 if(intent.kind==='save_budget'||intent.kind==='set_budget_limit'||intent.kind==='delete_budget')return applyBudgetIntent(db,userId,intent);
 if(intent.kind==='save_operations_view'||intent.kind==='delete_operations_view'||intent.kind==='reorder_operations_views')return applyViewIntent(db,userId,intent);
 if(intent.kind==='delete_rule'||intent.kind==='apply_rules'){const {graph,rules}=await loadFinance(db,userId);return applyRuleIntent(db,userId,intent,graph,rules);}
 if(intent.kind==='create_rule_with_history'){
  await applyBase(db,userId,{kind:'rule',id:intent.id,patch:intent.patch as unknown as Record<string,unknown>,create:true},currentRevision);
  const {graph,rules}=await loadFinance(db,userId),rule={...intent.patch,id:intent.id};
  const accounts=new Map(graph.accounts.map(account=>[account.id,account]));
  const operationIds=graph.operations.filter(op=>{const account=accounts.get(effective(op).accountId);return !!account&&ruleMatches(op,account,rule);}).map(op=>op.id).sort();
  const result=await applyRuleIntent(db,userId,{kind:'apply_rules',id:intent.id,ruleId:intent.id,operationIds},graph,rules);
  return {...result,details:{...result.details,kind:intent.kind}};
 }
 if(intent.kind==='operation_card'){
  await row(db,userId,'transaction',intent.id);
  if(intent.patch)await applyBase(db,userId,structuredClone(intent.patch),currentRevision);
  if(intent.components)await applyBase(db,userId,structuredClone(intent.components),currentRevision);
  for(const [linkIndex,edit] of intent.links.entries()){
   const previous=(await db.query('SELECT source_id,target_id FROM finance.link WHERE user_id=$1 AND id=$2',[userId,edit.id])).rows[0];
   if(previous&&previous.source_id!==intent.id&&previous.target_id!==intent.id)throw new HttpError(404,'NOT_FOUND');
   try{await applyBase(db,userId,edit,currentRevision);}catch(error){if(error instanceof HttpError)throw new LinkEditError(error.status,error.code,linkIndex);throw error;}
  }
  if(intent.links.some(edit=>edit.link!.status==='confirmed')){
   const outcomes=new Map(reconcile((await loadFinance(db,userId)).graph).links.map(link=>[link.id,link]));
   for(const [linkIndex,edit] of intent.links.entries())if(edit.link!.status==='confirmed'&&!outcomes.get(edit.id)?.active)throw new LinkEditError(409,outcomes.get(edit.id)?.reason??'LINK_CONFLICT',linkIndex);
  }
  return {table:'batch',id:intent.id,before:null,details:{kind:intent.kind}};
 }
 if(intent.kind==='bulk_operations'){
  const review=intent.reviewScope?await assertReviewGroup(db,userId,intent.reviewScope,intent.operationIds,(await financeView(db,userId)).operations):null;
  const loaded=await loadFinance(db,userId),patches=bulkPatches(intent,loaded.graph);let warnings:unknown[]=[];
  if('analyticsOverride'in intent.patch){const result=await applyExclusion(db,userId,{kind:'set_exclusion',id:intent.id,scope:{kind:'operations',operationIds:intent.operationIds},value:intent.patch.analyticsOverride as 'default'|'include'|'exclude',includeRelated:false},loaded.graph);warnings=result.details.warnings as unknown[];}
  for(const item of patches){delete item.patch.analyticsOverride;if(Object.keys(item.patch).length)await applyBase(db,userId,{kind:'operation',id:item.id,patch:item.patch},currentRevision,loaded);}
  let ruleName:string|undefined;
  if(intent.rememberRule){
   const anchor=loaded.graph.operations.find(o=>o.id===intent.reviewScope?.anchorId),merchant=anchor?.semantics.merchant.value.trim();
   if(!review?.liveQueue||!anchor||!merchant||anchor.semantics.kind.value!=='purchase'||BigInt(effective(anchor).amountMinor)>=0n)throw new HttpError(409,'REVIEW_GROUP_CHANGED');
   const conditions={merchantEquals:merchant,accountId:effective(anchor).accountId,direction:'out' as const,kind:'purchase' as const},assignments=intent.patch as Rule['assignments'];
   const matching=loaded.rules.filter(r=>r.enabled&&stableJSON(r.conditions)===stableJSON(conditions));
   if(matching.some(r=>Object.entries(assignments).some(([key,value])=>key in r.assignments&&stableJSON((r.assignments as Record<string,unknown>)[key])!==stableJSON(value))))throw new HttpError(409,'REVIEW_RULE_CONFLICT');
   if(!matching.some(r=>stableJSON(r.assignments)===stableJSON(assignments))){
    ruleName=safeText('Правило: '+merchant,160);
    const patch={name:ruleName,enabled:true,priority:0,conditions,assignments};
    await applyBase(db,userId,{kind:'rule',id:intent.id,create:true,patch},currentRevision,loaded);
   }
  }
  const after=await financeView(db,userId);
  if(review?.liveQueue&&intent.reviewScope&&after.operations.some(o=>o.id===intent.reviewScope!.anchorId&&o.reviewReasons.length)){
   const scope=intent.reviewScope;
   await db.query('UPDATE finance.review_session SET operation_ids=array_remove(operation_ids,$3::uuid)||ARRAY[$3::uuid],cursor=0,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2 AND array_length(operation_ids,1)>1',[userId,scope.sessionId,scope.anchorId]);
  }
  return {table:'batch',id:intent.id,before:null,details:{kind:intent.kind,operationIds:intent.operationIds,selectedCount:intent.operationIds.length,atomic:true,verify:intent.verify,patch:intent.patch,warnings,...(ruleName?{ruleName}:{}),remainingReviewIds:after.operations.filter(o=>intent.operationIds.includes(o.id)&&o.reviewReasons.length).map(o=>o.id)}};
 }
 if(intent.kind==='merge_duplicate')return mergeDuplicate(db,userId,intent);
 if(intent.kind==='cancel_import')return cancelImport(db,userId,intent,actionId);
 if(intent.kind==='duplicate_different'){
  const pair=(await db.query('SELECT * FROM finance.duplicate_candidate WHERE user_id=$1 AND id=$2',[userId,intent.id])).rows[0];if(!pair)throw new HttpError(404,'NOT_FOUND');
  await db.query("UPDATE finance.duplicate_candidate SET status='different',revision=revision+1 WHERE user_id=$1 AND id=$2",[userId,intent.id]);
  await db.query(`UPDATE finance.transaction t SET review_reasons=review_reasons-'possible_duplicate',revision=revision+1 WHERE t.user_id=$1 AND t.id=ANY($2::uuid[]) AND NOT EXISTS(SELECT 1 FROM finance.duplicate_candidate d WHERE d.user_id=t.user_id AND d.status='candidate' AND (d.left_id=t.id OR d.right_id=t.id))`,[userId,[pair.left_id,pair.right_id]]);
  return {table:'batch',id:intent.id,before:null,details:{kind:intent.kind,operationIds:[pair.left_id,pair.right_id].sort(),remembered:true}};
 }
 if(intent.kind==='set_exclusion')return applyExclusion(db,userId,intent,(await loadFinance(db,userId)).graph);
 if(intent.kind==='restore_history')return replayHistory(db,userId,intent);
 if(isStructural(intent.kind))return applyStructural(db,userId,intent as StructuralIntent,(await loadFinance(db,userId)).graph,actionId);
 if(isEntityKind(intent.kind))return applyEntity(db,userId,intent as EntityIntent,(await loadFinance(db,userId)).graph);
 return applyBase(db,userId,intent as BaseIntent,currentRevision);
}
async function replayHistory(db:PoolClient,userId:string,intent:RestoreIntent){
 const before=await loadFinance(db,userId),links=new Map(reconcile(before.graph).links.map(l=>[l.id,l]));
 return restoreHistory(db,userId,intent,before.state.generation,async()=>reconcile((await loadFinance(db,userId)).graph).links.filter(l=>l.reason!==null&&(links.get(l.id)?.reason!==l.reason||links.get(l.id)?.active)).map(l=>({kind:'link' as const,id:l.id,reason:'DEPENDENCY_CONFLICT'})));
}
async function applyBase(db:PoolClient,userId:string,intent:BaseIntent,currentRevision:string,loaded?:Awaited<ReturnType<typeof loadFinance>>):Promise<Undo> {
 const {graph,parties}=loaded??await loadFinance(db,userId),p=intent.patch??{},id=intent.id;
 if(intent.kind==='operation'){
  const before=await row(db,userId,'transaction',id),semantics:Semantics=structuredClone(before.semantics),values:Record<string,unknown>={};ownRefs(graph,parties,p);
  if(p.corrections!==undefined){ownRefs(graph,parties,p.corrections as Record<string,unknown>);values.corrections=p.corrections;}
  const map={kind:'kind',role:'role',categoryId:'category',subcategoryId:'subcategory',merchant:'merchant',counterpartyId:'counterparty'}as const;
  for(const [input,key]of Object.entries(map))if(input in p)(semantics as unknown as Record<string,unknown>)[key]=facet(p[input],'user',true);
  if('kind' in p||'role' in p){const effectiveAmount=(p.corrections as {amountMinor?:string}|undefined)?.amountMinor??effective(graph.operations.find(o=>o.id===id)!).amountMinor;if(!allowedOperationRoles(semantics.kind.value,effectiveAmount).includes(semantics.role.value))throw new HttpError(409,'OPERATION_KIND_ROLE_CONFLICT');}
  categoryCompatible(graph,semantics.role.value,semantics.category.value,semantics.subcategory.value);
  values.semantics=semantics;if('comment'in p)values.comment=p.comment;if('analyticsOverride'in p)values.analytics_override=p.analyticsOverride;
  const cleared=new Set<string>();if('kind'in p)cleared.add('low_kind_confidence');if('role'in p)for(const r of ['low_role_confidence','unresolved_role','unresolved_transfer'])cleared.add(r);if('categoryId'in p||'subcategoryId'in p)cleared.add('low_category_confidence');
  if('reviewRequested'in p)cleared.add('user_requested_review');values.review_reasons=[...before.review_reasons.filter((r:string)=>!cleared.has(r)),...(p.reviewRequested===true?['user_requested_review']:[])];await update(db,userId,'transaction',id,values);return {table:'transaction',id,before:Object.fromEntries(columns.transaction.map(k=>[k,before[k]]))};
 }
 if(intent.kind==='components'){
  await row(db,userId,'transaction',id);const before=(await db.query('SELECT * FROM finance.component WHERE user_id=$1 AND transaction_id=$2 ORDER BY id',[userId,id])).rows;
  for(const part of intent.parts!){
   const previous=graph.components.find(c=>c.id===part.id&&c.transactionId===id);
   if(previous){for(const key of ['role','category','subcategory']as const)if(part[key].source!=='user')(part as unknown as Record<string,unknown>)[key]=previous[key];}
   ownRefs(graph,parties,{categoryId:part.category.value,subcategoryId:part.subcategory.value});
   categoryCompatible(graph,part.role.value,part.category.value,part.subcategory.value);
   const existing=(await db.query('SELECT transaction_id FROM finance.component WHERE user_id=$1 AND id=$2',[userId,part.id])).rows[0];if(existing&&existing.transaction_id!==id)throw new HttpError(404,'NOT_FOUND');
  }
  const sum=intent.parts!.reduce((s,p)=>s+BigInt(p.amountMinor),0n),op=graph.operations.find(o=>o.id===id)!;
  if(intent.parts!.length&&sum!==BigInt(op.corrections.amountMinor??op.source.amountMinor))throw new HttpError(409,'COMPONENT_SUM_CONFLICT');
  await db.query('UPDATE finance.component SET active=false WHERE user_id=$1 AND transaction_id=$2',[userId,id]);
  for(const part of intent.parts!)await db.query(`INSERT INTO finance.component(user_id,id,transaction_id,type,amount_minor,role,category,subcategory) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
   ON CONFLICT(user_id,id) DO UPDATE SET type=EXCLUDED.type,amount_minor=EXCLUDED.amount_minor,role=EXCLUDED.role,category=EXCLUDED.category,subcategory=EXCLUDED.subcategory,active=true`,[userId,part.id,id,part.type,part.amountMinor,JSON.stringify(part.role),JSON.stringify(part.category),JSON.stringify(part.subcategory)]);
  await update(db,userId,'transaction',id,{decomposition:intent.parts!.length>0});return {table:'components',id,before:[...before,{decomposition:op.decomposition}]};
 }
 if(intent.kind==='link'){
  const l=intent.link!;if(!graph.operations.some(o=>o.id===l.sourceId)||!graph.operations.some(o=>o.id===l.targetId))throw new HttpError(404,'NOT_FOUND');
  const links=[...graph.links.filter(x=>x.id!==id),l],byId=new Map(links.map(x=>[x.id,x]));
  const correct=(opId:string,parentId:string)=>{const parent=byId.get(parentId);return !!parent&&(parent.sourceId===opId||parent.targetId===opId&&['own_transfer','debt_repayment'].includes(parent.kind));};
  for(const [opId,parent]of [[l.sourceId,l.sourceAllocationId],[l.targetId,l.targetAllocationId]])if(parent&&!correct(opId!,parent))throw new HttpError(404,'NOT_FOUND');
  if(allocationOrder(links).cyclic.includes(id))throw new HttpError(409,'CYCLIC_DEPENDENCY');
  for(const child of links)if(child.id!==id&&(child.sourceAllocationId===id&&!correct(child.sourceId,id)||child.targetAllocationId===id&&!correct(child.targetId,id)))throw new HttpError(409,'ALLOCATION_REFERENCE_CONFLICT');
  const before=(await db.query('SELECT * FROM finance.link WHERE user_id=$1 AND id=$2',[userId,id])).rows[0]??null;
  const values={source_id:l.sourceId,target_id:l.targetId,source_component_id:l.sourceComponentId,target_component_id:l.targetComponentId,source_allocation_id:l.sourceAllocationId??null,target_allocation_id:l.targetAllocationId??null,kind:l.kind,amount_minor:l.amountMinor,status:l.status,confidence:l.confidence,created_by:l.createdBy};
  if(before)await update(db,userId,'link',id,values);else await db.query(`INSERT INTO finance.link(user_id,id,source_id,target_id,source_component_id,target_component_id,source_allocation_id,target_allocation_id,kind,amount_minor,status,confidence,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[userId,id,...Object.values(values)]);
  const outcome=reconcile((await loadFinance(db,userId)).graph).links.find(x=>x.id===id);if(l.status==='confirmed'&&!outcome?.active)throw new HttpError(409,outcome?.reason??'LINK_CONFLICT');
  return {table:'link',id,before};
 }
 if(intent.kind==='analytics'){const before={loan_mode:graph.loanMode};await db.query('UPDATE finance.workspace SET loan_mode=$2 WHERE user_id=$1',[userId,intent.value]);return {table:'workspace',id:userId,before};}
 if(intent.kind==='undo'){
  const original=(await db.query("SELECT *,committed_at>clock_timestamp()-interval '30 days' AS recent FROM finance.action WHERE user_id=$1 AND id=$2",[userId,intent.value])).rows[0];
  if(original?.change_set){const result=await replayHistory(db,userId,{kind:'restore_history',id:intent.id,actionIds:[intent.value as string]});if((result.details.conflicts as unknown[]).length)throw new HttpError(409,'UNDO_CONFLICT');return result;}
  if(!original||original.status!=='committed'||original.undone||!original.recent||!original.undo_patch||original.intent.canonical.kind==='undo'||original.intent.canonical.kind==='delete_financial'||original.committed_revision!==currentRevision)throw new HttpError(409,'UNDO_CONFLICT');
  await restore(db,userId,original.undo_patch);await db.query('UPDATE finance.action SET undone=true WHERE user_id=$1 AND id=$2',[userId,intent.value]);return {table:'workspace',id:userId,before:null};
 }
 const table=intent.kind,before=intent.create?null:await row(db,userId,table,id),values:Record<string,unknown>={};
 if(table==='account'){activeAccount(graph,id);for(const [input,key]of Object.entries({name:'display_name',type:'account_type',analyticsEnabled:'analytics_enabled',defaultVisible:'default_visible',loanMode:'loan_mode'}))if(input in p)values[key]=p[input];}
 if(table==='category'){
  if(p.parentId&&graph.categories.some(c=>c.parentId===id))throw new HttpError(409,'CATEGORY_PARENT_CONFLICT');
  if(!intent.create&&(('role'in p&&p.role!==before.role)||('parentId'in p&&p.parentId!==before.parent_id))){
   const occupied=(await db.query("SELECT 1 FROM finance.transaction WHERE user_id=$1 AND (category_id=$2 OR subcategory_id=$2) UNION ALL SELECT 1 FROM finance.component WHERE user_id=$1 AND (category_id=$2 OR subcategory_id=$2) UNION ALL SELECT 1 FROM finance.rule WHERE user_id=$1 AND (assignments->>'categoryId'=$2::text OR assignments->>'subcategoryId'=$2::text) LIMIT 1",[userId,id])).rowCount;
   if(occupied)throw new HttpError(409,'DEPENDENCY_MIGRATION_REQUIRED');
  }
  const parentId=p.parentId===undefined?before?.parent_id:p.parentId,role=p.role??before?.role;
  if(parentId){const parent=graph.categories.find(c=>c.id===parentId);if(!parent||parent.parentId!==null||parent.id===id)throw new HttpError(409,'CATEGORY_PARENT_CONFLICT');if(parent.role!=='both'&&role!==parent.role)throw new HttpError(409,'CATEGORY_ROLE_CONFLICT');}
  if('role'in p&&p.role!=='both'&&graph.categories.some(c=>c.parentId===id&&c.role!==p.role))throw new HttpError(409,'DEPENDENCY_MIGRATION_REQUIRED');
  for(const [input,key]of Object.entries({name:'name',role:'role',parentId:'parent_id',hidden:'hidden'}))if(input in p)values[key]=p[input];
  if(intent.create){if(!p.name||!p.role)throw new TypeError('MISSING_CATEGORY');await db.query('INSERT INTO finance.category(user_id,id,name,role,parent_id,hidden) VALUES($1,$2,$3,$4,$5,$6)',[userId,id,p.name,p.role,p.parentId??null,p.hidden??false]);}
 }
 if(table==='counterparty'){const existing=await partyRows(db,userId);if(!intent.create)activeParty(existing,id);if((intent.create||p.state==='registered'||before?.state==='registered'&&typeof p.name==='string')&&existing.some(other=>other.id!==id&&other.state==='registered'&&!other.merged_into_id&&counterpartyNameKey(other.name)===counterpartyNameKey(String(p.name??before?.name))))throw new HttpError(409,'COUNTERPARTY_NAME_EXISTS');for(const [input,key]of Object.entries({name:'name',state:'state',isSelf:'is_self'}))if(input in p)values[key]=p[input];if(intent.create){if(!p.name)throw new TypeError('MISSING_NAME');await db.query('INSERT INTO finance.counterparty(user_id,id,name,state,is_self) VALUES($1,$2,$3,$4,$5)',[userId,id,p.name,p.state??'registered',p.isSelf??false]);}Object.assign(values,await saveCounterpartyOptions(db,userId,id,p,before,graph));}
 if(table==='rule'){
  const rule=p as unknown as Omit<Rule,'id'>,linked=parties.find(party=>party.autoRuleId===id&&!party.mergedIntoId);
  if(linked&&rule.assignments.counterpartyId!==linked.id)throw new HttpError(409,'COUNTERPARTY_RULE_TARGET');
  if(rule.conditions.counterpartyBankIdentity&&(!rule.assignments.counterpartyId||!parties.some(party=>party.id===rule.assignments.counterpartyId&&party.state==='registered'&&!party.mergedIntoId)))throw new HttpError(409,'RULE_NEEDS_SETUP');
  ownRefs(graph,parties,rule.conditions as Record<string,unknown>);ownRefs(graph,parties,rule.assignments as Record<string,unknown>);
  categoryCompatible(graph,rule.assignments.role??'unresolved',rule.assignments.categoryId??null,rule.assignments.subcategoryId??null);Object.assign(values,p,{dependency_status:'ready'});
  if(intent.create)await db.query('INSERT INTO finance.rule(user_id,id,name,enabled,priority,conditions,assignments) VALUES($1,$2,$3,$4,$5,$6,$7)',[userId,id,p.name,p.enabled,p.priority,JSON.stringify(p.conditions),JSON.stringify(p.assignments)]);
 }
 if(Object.keys(values).length&&(!intent.create||table==='counterparty'&&values.auto_rule_id))await update(db,userId,table,id,values);
 return {table,id,before:before?Object.fromEntries(columns[table].map(k=>[k,before[k]])):null};
}
async function restore(db:PoolClient,userId:string,undo:Undo){
 if(undo.table==='batch'||undo.table==='history')throw new HttpError(409,'UNDO_CONFLICT');
 if(undo.table==='entities'){await restoreEntities(db,userId,undo.before);return;}
 if(undo.table==='structure'){await restoreStructure(db,userId,undo.before!);return;}
 if(undo.table==='delete')throw new HttpError(409,'UNDO_CONFLICT');
 if(undo.table==='workspace'){if(undo.before)await db.query('UPDATE finance.workspace SET loan_mode=$2 WHERE user_id=$1',[userId,(undo.before as Record<string,unknown>).loan_mode]);return;}
 if(undo.table==='components'){
  const parts=undo.before as Record<string,unknown>[],settings=parts.at(-1)!;
  await db.query('UPDATE finance.component SET active=false WHERE user_id=$1 AND transaction_id=$2',[userId,undo.id]);
  for(const part of parts.slice(0,-1))await db.query('UPDATE finance.component SET type=$3,amount_minor=$4,role=$5,category=$6,subcategory=$7,active=$8 WHERE user_id=$1 AND id=$2',[userId,part.id,part.type,part.amount_minor,JSON.stringify(part.role),JSON.stringify(part.category),JSON.stringify(part.subcategory),part.active]);
  await update(db,userId,'transaction',undo.id,{decomposition:settings.decomposition});return;
 }
 if(!(undo.table in columns))throw new TypeError('INVALID_UNDO');
 if(undo.before)await update(db,userId,undo.table,undo.id,undo.before as Record<string,unknown>);else await db.query(`DELETE FROM finance.${undo.table} WHERE user_id=$1 AND id=$2`,[userId,undo.id]);
}
function impact(before:Awaited<ReturnType<typeof financeView>>,after:Awaited<ReturnType<typeof financeView>>,undo?:Undo,journal:Change[]=[]){
 const cardEdit=undo&&'details'in undo&&['operation_card','bulk_operations','create_rule_with_history'].includes(String(undo.details.kind));
 const beforeLinkReasons=cardEdit?new Map(before.links.map(l=>[l.id,l.reason])):undefined;
 const beforeOperations=new Map(before.operations.map(o=>[o.id,o])),afterIds=new Set(after.operations.map(o=>o.id));
 const removedOperationIds=before.operations.filter(o=>!afterIds.has(o.id)).map(o=>o.id);
 return {before:before.summary,after:after.summary,affectedOperationIds:[...removedOperationIds,...after.operations.filter(p=>JSON.stringify(p)!==JSON.stringify(beforeOperations.get(p.id))).map(p=>p.id)].sort(),removedOperationIds:removedOperationIds.sort(),dependencyConflicts:after.links.filter(l=>l.reason!==null&&(!beforeLinkReasons||beforeLinkReasons.get(l.id)!==l.reason)),reviewOperationIds:after.operations.filter(o=>o.reviewReasons.length).map(o=>o.id),changes:publicChanges(journal),...((undo&&'details'in undo)?{details:undo.details}:{})};
}
export async function previewFinance(db:PoolClient,userId:string,input:unknown){
 const r=object(input,['actionId','generation','revision','intent']),id=uuid(r.actionId),generation=uuid(r.generation),expected=revision(r.revision),state=await prepareFinance(db,userId);
 if(generation!==state.generation)throw new HttpError(409,'GENERATION_CHANGED');
 const existing=(await db.query('SELECT * FROM finance.action WHERE user_id=$1 AND id=$2',[userId,id])).rows[0];
 if(existing){if(existing.intent.canonical.receipt)return existing.result;if(stable(existing.intent.request)!==stable(r.intent))throw new HttpError(409,'ACTION_REUSED');if(existing.status==='committed')return existing.result;}
 if(expected!==state.revision)throw new HttpError(409,'FINANCE_CHANGED');
 if(r.intent&&typeof r.intent==='object'&&(r.intent as {kind?:unknown}).kind==='reset_financial')return previewReset(db,userId,id,r.intent,state,existing);
 if(existing)return {status:'previewed',actionId:id,intent:existing.intent.canonical,impact:existing.preview};
 const intent=parseIntent(r.intent),before=await financeView(db,userId),historyBefore=await captureHistory(db,userId);let changes:ReturnType<typeof impact>,journal:Change[];
 await db.query('SAVEPOINT finance_preview');try{const undo=await apply(db,userId,intent,state.revision,id);await repairOperationsViews(db,userId,intent);journal=historyDelta(historyBefore,await captureHistory(db,userId));changes=impact(before,await financeView(db,userId),undo,journal);}finally{await db.query('ROLLBACK TO SAVEPOINT finance_preview');await db.query('RELEASE SAVEPOINT finance_preview');}
 await db.query('INSERT INTO finance.action(user_id,id,generation,expected_revision,intent,preview,change_set) VALUES($1,$2,$3,$4,$5,$6,$7)',[userId,id,generation,expected,JSON.stringify({request:r.intent,canonical:intent}),JSON.stringify(changes),JSON.stringify(journal)]);
 return {status:'previewed',actionId:id,intent,impact:changes};
}
export async function commitFinance(db:PoolClient,userId:string,input:unknown,seal?:Sealer,sessionId?:string){
 const r=object(input,['actionId','confirmReset','password']),id=uuid(r.actionId),state=await prepareFinance(db,userId),action=(await db.query('SELECT *,expires_at>clock_timestamp() AS fresh FROM finance.action WHERE user_id=$1 AND id=$2',[userId,id])).rows[0];
 if(!action)throw new HttpError(404,'NOT_FOUND');if(action.intent.canonical.kind!=='reset_financial'&&('confirmReset'in r||'password'in r))throw new TypeError('INVALID_INPUT');if(action.status==='committed'&&action.intent.canonical.receipt)return action.result;if(action.generation!==state.generation)throw new HttpError(409,'GENERATION_CHANGED');if(action.status==='committed')return action.result;
 if(action.expected_revision!==state.revision||!action.fresh)throw new HttpError(409,'FINANCE_CHANGED');
 if(action.intent.canonical.kind==='reset_financial')return commitReset(db,userId,id,action,state,seal,r.confirmReset,sessionId,r.password);
 const before=await financeView(db,userId),historyBefore=await captureHistory(db,userId),undo=await apply(db,userId,action.intent.canonical,state.revision,id);
 if(undo.table==='history'&&(undo.details.conflicts as unknown[]).length)throw new HttpError(409,'ROLLBACK_CONFLICT');
 if(undo.table==='batch'&&undo.details.kind==='merge_duplicate'&&(undo.details.conflicts as unknown[]).length)throw new HttpError(409,'MERGE_CONFLICT');
 await repairOperationsViews(db,userId,action.intent.canonical);
 const journal=historyDelta(historyBefore,await captureHistory(db,userId)),actual=impact(before,await financeView(db,userId),undo,journal);
 if(stable(actual)!==stable(action.preview)||stable(journal)!==stable(action.change_set))throw new HttpError(409,'DEPENDENCIES_CHANGED');
 const next=(await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1 RETURNING generation,revision',[userId])).rows[0];
 const cleanup=undo.table==='delete'?{destructive:true,undoable:false,counts:undo.details.counts,accounts:((undo.details.accountsDeleted as string[])??[]).length,aliases:undo.details.aliasesDeleted,counterparties:((undo.details.counterpartiesDeleted as string[])??[]).length,counterpartyAliases:undo.details.counterpartyAliasesDeleted}:null;
 const result={status:'committed',actionId:id,generation:next.generation,revision:next.revision,...(cleanup?{cleanup}:{impact:action.preview})};
 if(cleanup)await db.query("UPDATE finance.action SET status='committed',generation=$3,intent=$4,preview=$5,result=$6,undo_patch=NULL,change_set=NULL,affected_operation_ids='{}',committed_at=clock_timestamp(),committed_revision=$7 WHERE user_id=$1 AND id=$2",[userId,id,next.generation,JSON.stringify({canonical:{kind:action.intent.canonical.kind,receipt:true}}),JSON.stringify(cleanup),JSON.stringify(result),next.revision]);
 else await db.query("UPDATE finance.action SET status='committed',result=$3,undo_patch=$4,committed_at=clock_timestamp(),committed_revision=$5,change_set=$6,affected_operation_ids=$7 WHERE user_id=$1 AND id=$2",[userId,id,JSON.stringify(result),['undo','restore_history'].includes(action.intent.canonical.kind)?null:JSON.stringify(undo),next.revision,JSON.stringify(journal),associatedOperations(journal,actual.affectedOperationIds)]);
 // Retire old history during writes. Scheduled cleanup/deletion cascade is a later block.
 await db.query("DELETE FROM finance.action WHERE user_id=$1 AND COALESCE(committed_at,created_at)<clock_timestamp()-interval '30 days'",[userId]);return result;
}
export async function editFinance(db:PoolClient,userId:string,input:unknown){
 const r=object(input,['actionId','generation','revision','intent']),raw=object(r.intent,['kind','id','patch']);
 if(raw.kind!=='operation'||object(raw.patch,['kind','role','categoryId','subcategoryId','merchant','counterpartyId','comment','analyticsOverride','reviewRequested']).corrections!==undefined)throw new HttpError(400,'PREVIEW_REQUIRED');
 await previewFinance(db,userId,r);return commitFinance(db,userId,{actionId:r.actionId});
}
/** Internal account matching hook; source aliases and local HMAC matching arrive with Import. */
export async function acceptAccount(db:PoolClient,userId:string,epoch:ImportEpoch,input:unknown){
 const state=await prepareFinance(db,userId);assertImportEpoch(epoch,state);
 const r=object(input,['id','bankId','systemName','type']),id=uuid(r.id),bank=safeText(r.bankId,80),name=safeText(r.systemName,160),type=choice(r.type,['debit_card','credit_card','bank_account','loan','savings','deposit','other']);
 if(!bank||!name)throw new TypeError('INVALID_ACCOUNT');const existing=(await db.query('SELECT bank_id FROM finance.account WHERE user_id=$1 AND id=$2',[userId,id])).rows[0];
 if(existing){if(existing.bank_id!==bank)throw new HttpError(409,'ACCOUNT_CONFLICT');return {id};}
 await db.query('INSERT INTO finance.account(user_id,id,bank_id,system_name,display_name,account_type) VALUES($1,$2,$3,$4,$4,$5)',[userId,id,bank,name,type]);
 await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1',[userId]);return {id};
}
/** Internal import acceptance primitive. There is deliberately no public bank-fact upload route.
 * Parser/HMAC/dedupe/cancellation orchestration is a later block. Caller owns the transaction. */
export async function acceptObservation(db:PoolClient,userId:string,epoch:ImportEpoch,observationId:string,transactionId:string|null,input:unknown,kind:Kind){
 const state=await prepareFinance(db,userId);assertImportEpoch(epoch,state);uuid(observationId);choice(kind,kinds);
 const r=object(input,['accountId','operationDate','postedDate','amountMinor','currency','operationAmountMinor','operationCurrency','merchantText','description','bankCategory','bankRefHmac','versions']);parsePersistedMinor(r.amountMinor);
 if((r.operationAmountMinor==null)!==(r.operationCurrency==null))throw new TypeError('INVALID_ORIGINAL_CURRENCY');
 if(r.operationAmountMinor!=null){parsePersistedMinor(r.operationAmountMinor);if(typeof r.operationCurrency!=='string'||!/^[A-Z]{3}$/.test(r.operationCurrency))throw new TypeError('INVALID_ORIGINAL_CURRENCY');}
 const versions=object(r.versions,['parser','normalizer','sanitizer','classification']);if(!versions.parser||!versions.normalizer||!versions.sanitizer||Object.values(versions).some(v=>!safeText(v,80)))throw new TypeError('INVALID_VERSIONS');
 const fact:BankFact={accountId:uuid(r.accountId),operationDate:dateFact(r.operationDate),postedDate:r.postedDate===null?null:dateFact(r.postedDate),amountMinor:r.amountMinor as string,currency:choice(r.currency,['RUB']),sourceKind:kind,operationAmountMinor:r.operationAmountMinor as string??null,operationCurrency:r.operationCurrency as string??null,merchantText:safeText(r.merchantText,160),description:safeText(r.description,1000),bankCategory:safeText(r.bankCategory,160),bankRefHmac:r.bankRefHmac===null?null:typeof r.bankRefHmac==='string'&&/^[0-9a-f]{64}$/.test(r.bankRefHmac)?r.bankRefHmac:(()=>{throw new TypeError('INVALID_PSEUDONYM');})(),versions:versions as Record<string,string>};
 const existing=(await db.query('SELECT * FROM finance.source_observation WHERE user_id=$1 AND id=$2',[userId,observationId])).rows[0];
 if(existing){
  const prior={accountId:existing.account_id,operationDate:existing.operation_date,postedDate:existing.posted_date,amountMinor:existing.amount_minor,currency:existing.currency,sourceKind:existing.source_kind,operationAmountMinor:existing.operation_amount_minor,operationCurrency:existing.operation_currency,merchantText:existing.merchant_text,description:existing.description,bankCategory:existing.bank_category,bankRefHmac:existing.bank_ref_hmac,versions:existing.versions};
  if(stable(prior)!==stable(fact)||transactionId!==null&&transactionId!==existing.transaction_id)throw new HttpError(409,'OBSERVATION_REUSED');
  return {transactionId:existing.transaction_id as string,observationId,projection:reconcile((await loadFinance(db,userId)).graph).operations.find(o=>o.id===existing.transaction_id)};
 }
 const {graph,rules}=await loadFinance(db,userId),account=canonicalAccount(graph,fact.accountId);
 const id=transactionId===null?randomUUID():uuid(transactionId);let semantics=initialBankSemantics(fact);
 if(transactionId!==null){
  const previous=await row(db,userId,'transaction',id);semantics=refreshBankSemantics(previous.semantics,fact);
 }else{
  const op:Operation={id,source:fact,accountAssignmentId:account.id,corrections:{},semantics,comment:'',analyticsOverride:'default',decomposition:false,reviewReasons:[]},classified=applyFinancialRecognition(applyRules(op,account,rules,undefined,graph.categories),graph.categories);
  semantics=classified.semantics;await db.query('INSERT INTO finance.transaction(user_id,id,source_observation_id,semantics,analytics_override,review_reasons) VALUES($1,$2,$3,$4,$5,$6)',[userId,id,observationId,JSON.stringify(semantics),classified.analyticsOverride,JSON.stringify(classified.reviewReasons)]);
 }
 await db.query('INSERT INTO finance.source_observation(user_id,id,transaction_id,account_id,operation_date,posted_date,amount_minor,currency,merchant_text,description,bank_category,bank_ref_hmac,versions,source_kind,operation_amount_minor,operation_currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[userId,observationId,id,fact.accountId,JSON.stringify(fact.operationDate),fact.postedDate===null?null:JSON.stringify(fact.postedDate),fact.amountMinor,fact.currency,fact.merchantText,fact.description,fact.bankCategory,fact.bankRefHmac,JSON.stringify(fact.versions),kind,fact.operationAmountMinor,fact.operationCurrency]);
 await db.query('INSERT INTO finance.observation_account(user_id,observation_id,account_id) VALUES($1,$2,$3)',[userId,observationId,account.id]);
 if(transactionId!==null)await db.query('UPDATE finance.transaction SET source_observation_id=$3,semantics=$4,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2',[userId,id,observationId,JSON.stringify(semantics)]);
 await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1',[userId]);return {transactionId:id,observationId,projection:reconcile((await loadFinance(db,userId)).graph).operations.find(o=>o.id===id)};
}
/** Internal sanitized alias hook. HMAC generation/key custody and full Import matching remain separate. */
export async function acceptAccountAlias(db:PoolClient,userId:string,epoch:ImportEpoch,input:unknown){
 const state=await prepareFinance(db,userId);assertImportEpoch(epoch,state);
 const r=object(input,['id','accountId','type','hmac']),id=uuid(r.id),type=choice(r.type,['bank_account','card','loan_contract','bank_contract','bank_label']);if(typeof r.hmac!=='string'||!/^([0-9a-f]{64})$/.test(r.hmac))throw new TypeError('INVALID_PSEUDONYM');
 const account=canonicalAccount((await loadFinance(db,userId)).graph,uuid(r.accountId)),old=(await db.query('SELECT id,account_id,alias_type,alias_hmac FROM finance.account_alias WHERE user_id=$1 AND (id=$2 OR (alias_type=$3 AND alias_hmac=$4))',[userId,id,type,r.hmac])).rows;
 if(old.length){if(old.length!==1||old[0].account_id!==account.id||old[0].alias_type!==type||old[0].alias_hmac!==r.hmac)throw new HttpError(409,'ALIAS_CONFLICT');return {id:old[0].id as string,accountId:account.id};}
 await db.query('INSERT INTO finance.account_alias(user_id,id,account_id,alias_type,alias_hmac) VALUES($1,$2,$3,$4,$5)',[userId,id,account.id,type,r.hmac]);await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1',[userId]);return {id,accountId:account.id};
}
/** Internal matching primitive; only a sanitized HMAC enters the financial store. */
export async function acceptCounterpartyAlias(db:PoolClient,userId:string,epoch:ImportEpoch,input:unknown){
 const state=await prepareFinance(db,userId);assertImportEpoch(epoch,state);
 const r=object(input,['id','counterpartyId','type','hmac']),id=uuid(r.id),type=choice(r.type,['card','bank_account','phone','recipient']);if(typeof r.hmac!=='string'||!/^[0-9a-f]{64}$/.test(r.hmac))throw new TypeError('INVALID_PSEUDONYM');
 const party=canonicalParty(await partyRows(db,userId),uuid(r.counterpartyId)),old=(await db.query('SELECT id,counterparty_id,alias_type,alias_hmac FROM finance.counterparty_alias WHERE user_id=$1 AND (id=$2 OR (alias_type=$3 AND alias_hmac=$4))',[userId,id,type,r.hmac])).rows;
 if(old.length){if(old.length!==1||old[0].counterparty_id!==party.id||old[0].alias_type!==type||old[0].alias_hmac!==r.hmac)throw new HttpError(409,'ALIAS_CONFLICT');return {id:old[0].id as string,counterpartyId:party.id};}
 await db.query('INSERT INTO finance.counterparty_alias(user_id,id,counterparty_id,alias_type,alias_hmac) VALUES($1,$2,$3,$4,$5)',[userId,id,party.id,type,r.hmac]);await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1',[userId]);return {id,counterpartyId:party.id};
}
/** Source-instance ownership is distinct from a user-verified operation label.
 * Import orchestration supplies the sanitized party/alias and owns this transaction. */
export async function acceptCounterpartyObservation(db:PoolClient,userId:string,epoch:ImportEpoch,input:unknown){
 const state=await prepareFinance(db,userId);assertImportEpoch(epoch,state);
 const r=object(input,['observationId','counterpartyId','aliasId']),observationId=uuid(r.observationId),aliasId=ref(r.aliasId),party=canonicalParty(await partyRows(db,userId),uuid(r.counterpartyId));
 const observation=(await db.query('SELECT finance.canonical_operation(user_id,transaction_id) AS transaction_id FROM finance.source_observation WHERE user_id=$1 AND id=$2',[userId,observationId])).rows[0];if(!observation)throw new HttpError(404,'NOT_FOUND');
 if(aliasId!==null&&!(await db.query('SELECT 1 FROM finance.counterparty_alias WHERE user_id=$1 AND id=$2 AND counterparty_id=$3',[userId,aliasId,party.id])).rowCount)throw new HttpError(404,'NOT_FOUND');
 const old=(await db.query('SELECT counterparty_id,alias_id FROM finance.observation_counterparty WHERE user_id=$1 AND observation_id=$2',[userId,observationId])).rows[0];
 if(old){if(old.counterparty_id!==party.id||old.alias_id!==aliasId)throw new HttpError(409,'COUNTERPARTY_BINDING_REUSED');return {observationId,counterpartyId:party.id,aliasId};}
 await db.query('INSERT INTO finance.observation_counterparty(user_id,observation_id,counterparty_id,alias_id) VALUES($1,$2,$3,$4)',[userId,observationId,party.id,aliasId]);
 const operation=await row(db,userId,'transaction',observation.transaction_id),semantics:Semantics=structuredClone(operation.semantics),cp=semantics.counterparty;
 if(operation.source_observation_id===observationId&&!cp.userVerified&&(cp.source==='bank'||cp.value===null&&cp.source==='deterministic_system_rule')){semantics.counterparty=facet(party.id,'bank');await update(db,userId,'transaction',operation.id,{semantics});}
 // A new source assignment after merge is a dependency even when it is not
 // the currently selected observation; Undo must not redistribute it silently.
 await db.query('UPDATE finance.transaction t SET revision=revision+1 WHERE t.user_id=$1 AND t.id=$2 AND EXISTS(SELECT 1 FROM finance.transaction a WHERE a.user_id=t.user_id AND a.merged_into_id=t.id)',[userId,operation.id]);
 await db.query('UPDATE finance.workspace SET revision=revision+1 WHERE user_id=$1',[userId]);return {observationId,counterpartyId:party.id,aliasId};
}
/** Future sanitized Import/worker entry point. Caller owns one DB transaction; no raw upload route. */
export async function withPreparedImport<T>(db:PoolClient,userId:string,input:PreparedImportContext,write:(epoch:ImportEpoch)=>Promise<T>):Promise<T>{
 const state=await prepareFinance(db,userId),context=await assertPreparedContext(db,userId,input,state);
 const result=await write({generation:context.generation,keyVersion:context.keyVersion});
 await assertPreparedContext(db,userId,input,await prepareFinance(db,userId));
 return result;
}
