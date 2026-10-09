import {dependentLinks} from '../../../packages/finance-core/src/allocation-graph.ts';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {invalidatePendingImports} from './import-ingestion.ts';
import {object,choice,uuid,dateFact,effective,operationDay} from '../../../packages/finance-core/src/model.ts';
import type {Graph,Account} from '../../../packages/finance-core/src/model.ts';
import {safeText} from '../../../packages/privacy/src/text.ts';
import {HttpError} from './types.ts';
import {partyRows,activeParty,partySources,removePartyCard} from './finance-entities.ts';

type Assignment={id:string;accountId:string};
type NewAccount={id:string;name:string;type:Account['type'];analyticsEnabled:boolean;defaultVisible:boolean;loanMode:Account['loanMode']};
export type DeleteScope={kind:'operations';operationIds:string[]}|{kind:'period';from:string;through:string;accountIds?:string[]}|{kind:'account';accountId:string;deleteAccount:boolean}|{kind:'counterparty';counterpartyId:string;deleteCard:boolean};
export type StructuralIntent={kind:'merge_accounts';id:string;sourceIds:string[]}|{kind:'split_account';id:string;newAccounts:NewAccount[];observations:Assignment[];operations:Assignment[];aliases:Assignment[]}|{kind:'delete_financial';id:string;scope:DeleteScope};
export type StructuralUndo={table:'structure'|'delete';id:string;before:Record<string,unknown>|null;details:Record<string,unknown>};
const structuralKinds=['merge_accounts','split_account','delete_financial'] as const;
export function isStructural(kind:string):kind is StructuralIntent['kind'] {return (structuralKinds as readonly string[]).includes(kind);}
function boolean(v:unknown){if(typeof v!=='boolean')throw new TypeError('INVALID_BOOLEAN');return v;}
function list(v:unknown,min=0,max=10000):unknown[]{if(!Array.isArray(v)||v.length<min||v.length>max)throw new TypeError('INVALID_SELECTION');return v;}
function unique(ids:string[]){if(new Set(ids).size!==ids.length)throw new TypeError('DUPLICATE_SELECTION');return ids;}
function assignments(v:unknown):Assignment[]{const rows=list(v).map(v=>{const r=object(v,['id','accountId']);return {id:uuid(r.id),accountId:uuid(r.accountId)};});unique(rows.map(r=>r.id));return rows;}
export function parseStructuralIntent(value:unknown):StructuralIntent {
 const r=object(value,['kind','id','sourceIds','newAccounts','observations','operations','aliases','scope']),kind=choice(r.kind,structuralKinds);
 if(kind==='merge_accounts'){
  object(value,['kind','id','sourceIds']);const id=uuid(r.id),sourceIds=unique(list(r.sourceIds,1,30).map(uuid));if(sourceIds.includes(id))throw new TypeError('SELF_MERGE');return {kind,id,sourceIds};
 }
 if(kind==='split_account'){
  object(value,['kind','id','newAccounts','observations','operations','aliases']);
  const id=uuid(r.id),newAccounts=list(r.newAccounts,1,9).map(v=>{const a=object(v,['id','name','type','analyticsEnabled','defaultVisible','loanMode']),name=safeText(a.name,160);if(!name)throw new TypeError('EMPTY_NAME');return {id:a.id===undefined?randomUUID():uuid(a.id),name,type:choice(a.type,['debit_card','credit_card','bank_account','loan','savings','deposit','other']),analyticsEnabled:boolean(a.analyticsEnabled),defaultVisible:boolean(a.defaultVisible),loanMode:a.loanMode===null?null:choice(a.loanMode,['cashflow','economic'])};});
  unique([id,...newAccounts.map(a=>a.id)]);return {kind,id,newAccounts,observations:assignments(r.observations),operations:assignments(r.operations),aliases:assignments(r.aliases)};
 }
 object(value,['kind','scope']);const s=object(r.scope,['kind','operationIds','from','through','accountIds','accountId','deleteAccount','counterpartyId','deleteCard']);let scope:DeleteScope;
 if(s.kind==='operations'){object(r.scope,['kind','operationIds']);scope={kind:'operations',operationIds:unique(list(s.operationIds,1,1000).map(uuid))};}
 else if(s.kind==='period'){
  object(r.scope,['kind','from','through','accountIds']);const from=dateFact({precision:'day',date:s.from}),through=dateFact({precision:'day',date:s.through});if(from.precision!=='day'||through.precision!=='day'||from.date>through.date)throw new TypeError('INVALID_RANGE');
  scope={kind:'period',from:from.date,through:through.date,...(s.accountIds===undefined?{}:{accountIds:unique(list(s.accountIds,1,100).map(uuid))})};
 }else if(s.kind==='account'){object(r.scope,['kind','accountId','deleteAccount']);scope={kind:'account',accountId:uuid(s.accountId),deleteAccount:boolean(s.deleteAccount)};}
 else if(s.kind==='counterparty'){object(r.scope,['kind','counterpartyId','deleteCard']);scope={kind:'counterparty',counterpartyId:uuid(s.counterpartyId),deleteCard:boolean(s.deleteCard)};}
 else throw new TypeError('INVALID_SCOPE');return {kind,id:randomUUID(),scope};
}
export function activeAccount(graph:Graph,id:string){const a=graph.accounts.find(a=>a.id===id);if(!a)throw new HttpError(404,'NOT_FOUND');if(a.mergedIntoId)throw new HttpError(409,'ACCOUNT_MERGED');return a;}
export function canonicalAccount(graph:Graph,id:string){const seen=new Set<string>();let a=graph.accounts.find(a=>a.id===id);while(a?.mergedIntoId){if(seen.has(a.id))throw new HttpError(409,'ACCOUNT_CYCLE');seen.add(a.id);a=graph.accounts.find(x=>x.id===a!.mergedIntoId);}if(!a)throw new HttpError(404,'NOT_FOUND');return a;}
type Binding={observation_id:string;account_id:string;transaction_id:string};
type Alias={id:string;account_id:string;alias_type:string};
type AccountRow={id:string;display_name:string;account_type:string;analytics_enabled:boolean;default_visible:boolean;loan_mode:string|null;merged_into_id:string|null};
type TransactionRow={id:string;corrections:Record<string,unknown>};
type RuleRow={id:string;conditions:Record<string,unknown>;assignments:Record<string,unknown>;enabled:boolean;dependency_status:string};
const accountColumns=['display_name','account_type','analytics_enabled','default_visible','loan_mode','merged_into_id'] as const;
async function sourceMap(db:PoolClient,userId:string){return (await db.query<Binding>('SELECT b.observation_id,b.account_id,o.transaction_id FROM finance.observation_account b JOIN finance.source_observation o ON (o.user_id,o.id)=(b.user_id,b.observation_id) WHERE b.user_id=$1 ORDER BY b.observation_id',[userId])).rows;}
async function aliases(db:PoolClient,userId:string){return (await db.query<Alias>('SELECT id,account_id,alias_type FROM finance.account_alias WHERE user_id=$1 ORDER BY id',[userId])).rows;}
function coverage(actual:string[],supplied:Assignment[]){if(actual.length!==supplied.length||supplied.some(r=>!actual.includes(r.id)))throw new HttpError(409,'EXPLICIT_DISTRIBUTION_REQUIRED');}
async function capture(db:PoolClient,userId:string,accountIds:string[],bindingRows:Binding[],aliasRows:Alias[],operationIds:string[],ruleIds:string[]){
 const accounts=(await db.query<AccountRow>('SELECT id,display_name,account_type,analytics_enabled,default_visible,loan_mode,merged_into_id FROM finance.account WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[userId,accountIds])).rows;
 const transactions=(await db.query<TransactionRow>('SELECT id,corrections FROM finance.transaction WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[userId,operationIds])).rows;
 const rules=(await db.query<RuleRow>('SELECT id,conditions,assignments,enabled,dependency_status FROM finance.rule WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[userId,ruleIds])).rows;
 return {accounts,bindings:bindingRows,aliases:aliasRows,transactions,rules,createdAccountIds:[] as string[]};
}
export async function applyStructural(db:PoolClient,userId:string,intent:StructuralIntent,graph:Graph,actionId:string):Promise<StructuralUndo>{
 const bindings=await sourceMap(db,userId),aliasRows=await aliases(db,userId),rules=(await db.query<RuleRow>('SELECT id,conditions,assignments,enabled,dependency_status FROM finance.rule WHERE user_id=$1 ORDER BY id',[userId])).rows;
 if(intent.kind==='delete_financial')return deleteFinancial(db,userId,intent,graph,bindings,aliasRows,rules,actionId);
 const original=activeAccount(graph,intent.id);
 if(intent.kind==='merge_accounts'){
  for(const id of intent.sourceIds)activeAccount(graph,id);
  const sources=new Set(intent.sourceIds),sourceAccounts=graph.accounts.filter(a=>sources.has(a.id)||!!a.mergedIntoId&&sources.has(a.mergedIntoId)).map(a=>a.id),bound=bindings.filter(b=>sources.has(b.account_id)),aliased=aliasRows.filter(a=>sources.has(a.account_id)),changedOperations=graph.operations.filter(o=>!!o.corrections.accountId&&sources.has(o.corrections.accountId)).map(o=>o.id),changedRules=rules.filter(r=>sources.has(r.conditions.accountId as string)).map(r=>r.id);
  const before=await capture(db,userId,sourceAccounts,bound,aliased,changedOperations,changedRules);
  await db.query('UPDATE finance.observation_account SET account_id=$3 WHERE user_id=$1 AND account_id=ANY($2::uuid[])',[userId,intent.sourceIds,intent.id]);
  await db.query('UPDATE finance.account_alias SET account_id=$3 WHERE user_id=$1 AND account_id=ANY($2::uuid[])',[userId,intent.sourceIds,intent.id]);
  await db.query("UPDATE finance.transaction SET corrections=jsonb_set(corrections,'{accountId}',to_jsonb($3::text)),revision=revision+1 WHERE user_id=$1 AND corrected_account_id=ANY($2::uuid[])",[userId,intent.sourceIds,intent.id]);
  for(const r of before.rules)await db.query('UPDATE finance.rule SET conditions=$3,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,r.id,JSON.stringify({...r.conditions,accountId:intent.id})]);
  await db.query('UPDATE finance.account SET merged_into_id=$3,revision=revision+1 WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,sourceAccounts,intent.id]);
  const operationDependencies=[...new Set([...bound.map(b=>b.transaction_id),...changedOperations])].sort(),linkDependencies=dependentLinks(graph.links,graph.links.filter(l=>operationDependencies.includes(l.sourceId)||operationDependencies.includes(l.targetId)).map(l=>l.id));
  return {table:'structure',id:intent.id,before,details:{kind:intent.kind,targetAccountId:intent.id,sourceAccountIds:sourceAccounts,canonicalSettings:original,operationDependencies,linkDependencies,observationsMoved:bound.length,aliasesMoved:aliased.length,rulesMoved:changedRules,correctionsMoved:changedOperations,sourceFactsPreserved:true}};
 }
 const destinations=new Set([intent.id,...intent.newAccounts.map(a=>a.id)]);
 for(const a of intent.newAccounts)if(graph.accounts.some(x=>x.id===a.id))throw new HttpError(409,'ACCOUNT_EXISTS');
 const bound=bindings.filter(b=>b.account_id===intent.id),aliased=aliasRows.filter(a=>a.account_id===intent.id),boundOperations=new Set(bound.map(b=>b.transaction_id)),affected=graph.operations.filter(o=>effective(o).accountId===intent.id||boundOperations.has(o.id)).map(o=>o.id);
 coverage(bound.map(b=>b.observation_id),intent.observations);coverage(aliased.map(a=>a.id),intent.aliases);coverage(affected,intent.operations);
 for(const a of [...intent.observations,...intent.aliases])if(!destinations.has(a.accountId))throw new HttpError(409,'INVALID_DESTINATION');
 for(const a of intent.operations)if(!destinations.has(a.accountId))activeAccount(graph,a.accountId);
 const changedRules=rules.filter(r=>r.conditions.accountId===intent.id).map(r=>r.id),before=await capture(db,userId,[],bound,aliased,affected,changedRules);before.createdAccountIds=intent.newAccounts.map(a=>a.id);
 for(const a of intent.newAccounts)await db.query('INSERT INTO finance.account(user_id,id,bank_id,system_name,display_name,account_type,analytics_enabled,default_visible,loan_mode) SELECT user_id,$3,bank_id,system_name,$4,$5,$6,$7,$8 FROM finance.account WHERE user_id=$1 AND id=$2',[userId,intent.id,a.id,a.name,a.type,a.analyticsEnabled,a.defaultVisible,a.loanMode]);
 for(const b of intent.observations)await db.query('UPDATE finance.observation_account SET account_id=$3 WHERE user_id=$1 AND observation_id=$2',[userId,b.id,b.accountId]);
 for(const a of intent.aliases)await db.query('UPDATE finance.account_alias SET account_id=$3 WHERE user_id=$1 AND id=$2',[userId,a.id,a.accountId]);
 const assignmentsByObservation=new Map(intent.observations.map(b=>[b.id,b.accountId]));
 for(const assignment of intent.operations){
  const r=before.transactions.find(t=>t.id===assignment.id)!,currentSource=(await db.query('SELECT source_observation_id FROM finance.transaction WHERE user_id=$1 AND id=$2',[userId,r.id])).rows[0].source_observation_id;
  const boundAccount=assignmentsByObservation.get(currentSource)??bindings.find(b=>b.observation_id===currentSource)!.account_id,corrections={...r.corrections};
  if(assignment.accountId===boundAccount)delete corrections.accountId;else corrections.accountId=assignment.accountId;
  await db.query('UPDATE finance.transaction SET corrections=$3,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,r.id,JSON.stringify(corrections)]);
 }
 for(const id of changedRules)await db.query("UPDATE finance.rule SET enabled=false,dependency_status='needs_setup',revision=revision+1 WHERE user_id=$1 AND id=$2",[userId,id]);
 const linkDependencies=dependentLinks(graph.links,graph.links.filter(l=>affected.includes(l.sourceId)||affected.includes(l.targetId)).map(l=>l.id));
 return {table:'structure',id:intent.id,before,details:{kind:intent.kind,newAccounts:intent.newAccounts,observations:intent.observations,operations:intent.operations,aliases:intent.aliases,linkDependencies,rulesNeedSetup:changedRules,sourceFactsPreserved:true}};
}
async function deleteFinancial(db:PoolClient,userId:string,intent:Extract<StructuralIntent,{kind:'delete_financial'}>,graph:Graph,bindings:Binding[],aliasRows:Alias[],rules:RuleRow[],actionId:string):Promise<StructuralUndo>{
 const scope=intent.scope;let selected:string[],accountIds:string[]=[],counterpartyIds:string[]=[];
 if(scope.kind==='operations'){for(const id of scope.operationIds)if(!graph.operations.some(o=>o.id===id))throw new HttpError(404,'NOT_FOUND');selected=scope.operationIds;}
 else if(scope.kind==='period'){
  for(const id of scope.accountIds??[])activeAccount(graph,id);
  selected=graph.operations.filter(o=>{const f=effective(o),day=operationDay(f.operationDate);return day>=scope.from&&day<=scope.through&&(!scope.accountIds||scope.accountIds.includes(f.accountId));}).map(o=>o.id);
 }else if(scope.kind==='counterparty'){
  const parties=await partyRows(db,userId);activeParty(parties,scope.counterpartyId);const bound=new Set((await partySources(db,userId)).filter(b=>b.counterparty_id===scope.counterpartyId).map(b=>b.transaction_id));
  selected=graph.operations.filter(o=>o.semantics.counterparty.value===scope.counterpartyId||bound.has(o.id)).map(o=>o.id);
  if(scope.deleteCard)counterpartyIds=parties.filter(p=>p.id===scope.counterpartyId||p.merged_into_id===scope.counterpartyId).map(p=>p.id);
 }else{
  activeAccount(graph,scope.accountId);const ids=new Set(bindings.filter(b=>b.account_id===scope.accountId).map(b=>b.transaction_id));selected=graph.operations.filter(o=>effective(o).accountId===scope.accountId||ids.has(o.id)).map(o=>o.id);
  if(scope.deleteAccount){accountIds=graph.accounts.filter(a=>a.id===scope.accountId||a.mergedIntoId===scope.accountId).map(a=>a.id);
   // Split destinations retain their own source provenance; never delete them to remove an old card.
   const used=(await db.query('SELECT 1 FROM finance.source_observation WHERE user_id=$1 AND account_id=ANY($2::uuid[]) AND NOT(transaction_id=ANY($3::uuid[])) LIMIT 1',[userId,accountIds,selected])).rowCount;if(used)throw new HttpError(409,'SOURCE_ACCOUNT_STILL_REFERENCED');
  }
 }
 if(!selected.length&&!accountIds.length&&!counterpartyIds.length)throw new HttpError(409,'EMPTY_SCOPE');if(selected.length>1000)throw new HttpError(409,'DELETE_SCOPE_LIMIT');
 const chosen=new Set(selected),removedLinkIds=dependentLinks(graph.links,graph.links.filter(l=>chosen.has(l.sourceId)||chosen.has(l.targetId)).map(l=>l.id)),removedLinks=new Set(removedLinkIds),survivingRelated=[...new Set(graph.links.filter(l=>removedLinks.has(l.id)).flatMap(l=>[l.sourceId,l.targetId]).filter(id=>!chosen.has(id)))].sort();
 const counts=(await db.query(`SELECT
 (SELECT count(*)::int FROM finance.source_observation WHERE user_id=$1 AND transaction_id=ANY($2::uuid[])) AS observations,
 (SELECT count(*)::int FROM finance.component WHERE user_id=$1 AND transaction_id=ANY($2::uuid[])) AS components,
 (SELECT count(*)::int FROM finance.link WHERE user_id=$1 AND (source_id=ANY($2::uuid[]) OR target_id=ANY($2::uuid[]))) AS links,
 (SELECT count(*)::int FROM finance.action WHERE user_id=$1 AND id<>$3 AND NOT(status='committed' AND COALESCE(intent->'canonical'->>'receipt','false')='true')) AS history`,[userId,selected,actionId])).rows[0];
 const removedAliases=aliasRows.filter(a=>accountIds.includes(a.account_id)),changedRules=rules.filter(r=>accountIds.includes(r.conditions.accountId as string));
 const cpAliases=counterpartyIds.length?(await db.query('SELECT count(*)::int AS n FROM finance.counterparty_alias WHERE user_id=$1 AND counterparty_id=ANY($2::uuid[])',[userId,counterpartyIds])).rows[0].n:0;
 const cpRules=rules.filter(r=>counterpartyIds.includes(r.conditions.counterpartyId as string)||counterpartyIds.includes(r.assignments.counterpartyId as string));
 const duplicateSurvivors=[...new Set((await db.query('SELECT left_id,right_id FROM finance.duplicate_candidate WHERE user_id=$1 AND (left_id=ANY($2::uuid[]) OR right_id=ANY($2::uuid[]))',[userId,selected])).rows.flatMap(r=>[r.left_id,r.right_id]).filter(id=>!chosen.has(id)))];
 const ingestion=(await db.query(`SELECT
 (SELECT count(*)::int FROM finance.ingestion_row r JOIN finance.source_observation o ON (o.user_id,o.id)=(r.user_id,r.observation_id) WHERE o.user_id=$1 AND o.transaction_id=ANY($2::uuid[])) AS sources,
 (SELECT count(*)::int FROM finance.ingestion_row WHERE user_id=$1 AND status='pending') AS pending,
 (SELECT count(*)::int FROM finance.duplicate_candidate WHERE user_id=$1 AND (left_id=ANY($2::uuid[]) OR right_id=ANY($2::uuid[]))) AS candidates`,[userId,selected])).rows[0];
 const details={kind:intent.kind,scope,destructive:true,undoable:false,reimportWarning:true,operationIds:[...selected].sort(),survivingRelatedOperationIds:survivingRelated,accountsDeleted:accountIds,aliasesDeleted:removedAliases.length,counterpartiesDeleted:counterpartyIds,counterpartyAliasesDeleted:cpAliases,rulesNeedSetup:[...changedRules,...cpRules].map(r=>r.id),counts:{operations:selected.length,observations:counts.observations,components:counts.components,links:removedLinkIds.length,history:counts.history,importSources:ingestion.sources,pendingImportRowsInvalidated:ingestion.pending,duplicateCandidates:ingestion.candidates},historyPolicy:'clear_financial_history_and_previews',pendingPayloadPolicy:'invalidate_previous_generation'};
 // Delete the closed link set in one statement before transaction FK cascades, including deep descendants.
 await db.query('DELETE FROM finance.link WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,removedLinkIds]);
 await db.query('DELETE FROM finance.transaction WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,selected]);
 await invalidatePendingImports(db,userId);
 await db.query(`UPDATE finance.transaction t SET review_reasons=review_reasons-'possible_duplicate',revision=revision+1 WHERE t.user_id=$1 AND t.id=ANY($2::uuid[]) AND review_reasons @> '["possible_duplicate"]'::jsonb AND NOT EXISTS(SELECT 1 FROM finance.duplicate_candidate d WHERE d.user_id=t.user_id AND d.status='candidate' AND (d.left_id=t.id OR d.right_id=t.id))`,[userId,duplicateSurvivors]);
 if(accountIds.length){
  await db.query('DELETE FROM finance.account_alias WHERE user_id=$1 AND account_id=ANY($2::uuid[])',[userId,accountIds]);
  for(const r of changedRules){const conditions={...r.conditions};delete conditions.accountId;await db.query("UPDATE finance.rule SET conditions=$3,enabled=false,dependency_status='needs_setup',revision=revision+1 WHERE user_id=$1 AND id=$2",[userId,r.id,JSON.stringify(conditions)]);}
  await db.query('UPDATE finance.account SET merged_into_id=NULL WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,accountIds]);
  await db.query('DELETE FROM finance.account WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,accountIds]);
 }
 if(counterpartyIds.length)await removePartyCard(db,userId,counterpartyIds);
 // Old previews/results contain entire-workspace totals. Retain only metadata-only deletion receipts.
 await db.query("DELETE FROM finance.action WHERE user_id=$1 AND id<>$2 AND NOT(status='committed' AND COALESCE(intent->'canonical'->>'receipt','false')='true')",[userId,actionId]);
 await db.query('UPDATE finance.workspace SET generation=gen_random_uuid() WHERE user_id=$1',[userId]);
 return {table:'delete',id:intent.id,before:null,details};
}
export async function restoreStructure(db:PoolClient,userId:string,value:Record<string,unknown>){
 const before=value as unknown as {accounts:AccountRow[];bindings:Binding[];aliases:Alias[];transactions:TransactionRow[];rules:RuleRow[];createdAccountIds:string[]};
 for(const a of before.accounts)await db.query(`UPDATE finance.account SET ${accountColumns.map((k,i)=>k+'=$'+(i+3)).join(',')},revision=revision+1 WHERE user_id=$1 AND id=$2`,[userId,a.id,...accountColumns.map(k=>a[k])]);
 for(const b of before.bindings)await db.query('UPDATE finance.observation_account SET account_id=$3 WHERE user_id=$1 AND observation_id=$2',[userId,b.observation_id,b.account_id]);
 for(const a of before.aliases)await db.query('UPDATE finance.account_alias SET account_id=$3 WHERE user_id=$1 AND id=$2',[userId,a.id,a.account_id]);
 for(const t of before.transactions)await db.query('UPDATE finance.transaction SET corrections=$3,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,t.id,JSON.stringify(t.corrections)]);
 for(const r of before.rules)await db.query('UPDATE finance.rule SET conditions=$3,assignments=$4,enabled=$5,dependency_status=$6,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,r.id,JSON.stringify(r.conditions),JSON.stringify(r.assignments),r.enabled,r.dependency_status]);
 if(before.createdAccountIds.length)await db.query('DELETE FROM finance.account WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,before.createdAccountIds]);
}
