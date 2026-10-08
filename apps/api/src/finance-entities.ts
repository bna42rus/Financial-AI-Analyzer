import {dependentLinks} from '../../../packages/finance-core/src/allocation-graph.ts';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {object,choice,uuid,facet} from '../../../packages/finance-core/src/model.ts';
import type {Graph,Category,Semantics,Role,Facet} from '../../../packages/finance-core/src/model.ts';
import {safeText} from '../../../packages/privacy/src/text.ts';
import {HttpError} from './types.ts';

type RoleDecision={kind:'operation'|'component';id:string;role:Role};
type CategoryOptions={roleDecisions:RoleDecision[];childRoles:{id:string;role:Category['role']}[];targetRole?:Category['role']};
type PartyAssignment={id:string;counterpartyId:string|null};
type NewParty={id:string;name:string;state:'registered'|'ignored';isSelf:boolean};
export type EntityIntent=({kind:'merge_categories';id:string;sourceIds:string[]}|{kind:'delete_category';id:string;replacementId:string|null}|{kind:'migrate_category';id:string;parentId:string|null;role:Category['role']})&CategoryOptions|{kind:'merge_counterparties';id:string;sourceIds:string[]}|{kind:'split_counterparty';id:string;newParties:NewParty[];observations:PartyAssignment[];operations:PartyAssignment[];aliases:PartyAssignment[]}|{kind:'delete_counterparty';id:string};
export type EntityUndo={table:'entities';id:string;before:Record<string,unknown>;details:Record<string,unknown>};
const kinds=['merge_categories','delete_category','migrate_category','merge_counterparties','split_counterparty','delete_counterparty'] as const;
export function isEntityKind(kind:string):kind is EntityIntent['kind'] {return (kinds as readonly string[]).includes(kind);}
function list(v:unknown,min=0,max=10000):unknown[]{if(!Array.isArray(v)||v.length<min||v.length>max)throw new TypeError('INVALID_SELECTION');return v;}
function unique(ids:string[]){if(new Set(ids).size!==ids.length)throw new TypeError('DUPLICATE_SELECTION');return ids;}
function bool(v:unknown){if(typeof v!=='boolean')throw new TypeError('INVALID_BOOLEAN');return v;}
const nullableId=(v:unknown)=>v===null?null:uuid(v);
function partyAssignments(v:unknown,nullable=false){const r=list(v).map(v=>{const a=object(v,['id','counterpartyId']);return {id:uuid(a.id),counterpartyId:nullable?nullableId(a.counterpartyId):uuid(a.counterpartyId)};});unique(r.map(a=>a.id));return r;}
export function parseEntityIntent(value:unknown):EntityIntent {
 const r=object(value,['kind','id','sourceIds','replacementId','parentId','role','targetRole','childRoles','roleDecisions','newParties','observations','operations','aliases']),kind=choice(r.kind,kinds),id=uuid(r.id);
 if(['merge_categories','delete_category','migrate_category'].includes(kind)){
  const roleDecisions=list(r.roleDecisions??[]).map(v=>{const a=object(v,['kind','id','role']);return {kind:choice(a.kind,['operation','component']),id:uuid(a.id),role:choice(a.role,['expense','income','neutral','unresolved'])};});unique(roleDecisions.map(r=>r.kind+':'+r.id));
  const childRoles=list(r.childRoles??[]).map(v=>{const a=object(v,['id','role']);return {id:uuid(a.id),role:choice(a.role,['expense','income','both'])};});unique(childRoles.map(r=>r.id));
  const options:CategoryOptions={roleDecisions,childRoles,...(r.targetRole===undefined?{}:{targetRole:choice(r.targetRole,['expense','income','both'])})};
  if(kind==='merge_categories'){object(value,['kind','id','sourceIds','targetRole','childRoles','roleDecisions']);const sourceIds=unique(list(r.sourceIds,1,30).map(uuid));if(sourceIds.includes(id))throw new TypeError('SELF_MERGE');return {kind,id,sourceIds,...options};}
  if(kind==='delete_category'){object(value,['kind','id','replacementId','targetRole','childRoles','roleDecisions']);const replacementId=nullableId(r.replacementId);if(replacementId===id||replacementId===null&&r.targetRole!==undefined)throw new TypeError('INVALID_REPLACEMENT');return {kind,id,replacementId,...options};}
  object(value,['kind','id','parentId','role','childRoles','roleDecisions']);return {kind:'migrate_category',id,parentId:nullableId(r.parentId),role:choice(r.role,['expense','income','both']),...options};
 }
 if(kind==='merge_counterparties'){object(value,['kind','id','sourceIds']);const sourceIds=unique(list(r.sourceIds,1,30).map(uuid));if(sourceIds.includes(id))throw new TypeError('SELF_MERGE');return {kind,id,sourceIds};}
 if(kind==='delete_counterparty'){object(value,['kind','id']);return {kind,id};}
 object(value,['kind','id','newParties','observations','operations','aliases']);const newParties=list(r.newParties,1,9).map(v=>{const a=object(v,['id','name','state','isSelf']),name=safeText(a.name,160);if(!name)throw new TypeError('EMPTY_NAME');return {id:a.id===undefined?randomUUID():uuid(a.id),name,state:choice(a.state,['registered','ignored']),isSelf:bool(a.isSelf)};});unique([id,...newParties.map(p=>p.id)]);
 return {kind:'split_counterparty',id,newParties,observations:partyAssignments(r.observations),operations:partyAssignments(r.operations,true),aliases:partyAssignments(r.aliases)};
}
type PartyRow={id:string;name:string;state:'discovered'|'registered'|'ignored';is_self:boolean;merged_into_id:string|null};
type SourceRow={observation_id:string;counterparty_id:string;alias_id:string|null;transaction_id:string};
type AliasRow={id:string;counterparty_id:string;alias_type:string;alias_hmac:string};
type OperationRow={id:string;semantics:Semantics;review_reasons:string[]};
type ComponentRow={id:string;role:Facet<Role>;category:Facet<string|null>;subcategory:Facet<string|null>};
type RuleRow={id:string;conditions:Record<string,unknown>;assignments:Record<string,unknown>;enabled:boolean;dependency_status:string};
type Snapshot={categories:Category[];parties:PartyRow[];sources:SourceRow[];aliases:AliasRow[];operations:OperationRow[];components:ComponentRow[];rules:RuleRow[];createdPartyIds:string[]};
function blank():Snapshot {return {categories:[],parties:[],sources:[],aliases:[],operations:[],components:[],rules:[],createdPartyIds:[]};}
export async function partyRows(db:PoolClient,userId:string){return (await db.query<PartyRow>('SELECT id,name,state,is_self,merged_into_id FROM finance.counterparty WHERE user_id=$1 ORDER BY id',[userId])).rows;}
export function activeParty(parties:PartyRow[],id:string){const p=parties.find(p=>p.id===id);if(!p)throw new HttpError(404,'NOT_FOUND');if(p.merged_into_id)throw new HttpError(409,'COUNTERPARTY_MERGED');return p;}
export function canonicalParty(parties:PartyRow[],id:string){const seen=new Set<string>();let p=parties.find(p=>p.id===id);while(p?.merged_into_id){if(seen.has(p.id))throw new HttpError(409,'COUNTERPARTY_CYCLE');seen.add(p.id);p=parties.find(a=>a.id===p!.merged_into_id);}if(!p)throw new HttpError(404,'NOT_FOUND');return p;}
async function entityRows(db:PoolClient,userId:string){return {
 operations:(await db.query<OperationRow>('SELECT id,semantics,review_reasons FROM finance.transaction WHERE user_id=$1 ORDER BY id',[userId])).rows,
 components:(await db.query<ComponentRow>('SELECT id,role,category,subcategory FROM finance.component WHERE user_id=$1 ORDER BY id',[userId])).rows,
 rules:(await db.query<RuleRow>('SELECT id,conditions,assignments,enabled,dependency_status FROM finance.rule WHERE user_id=$1 ORDER BY id',[userId])).rows,
 };}
export async function partySources(db:PoolClient,userId:string){return (await db.query<SourceRow>('SELECT b.observation_id,b.counterparty_id,b.alias_id,o.transaction_id FROM finance.observation_counterparty b JOIN finance.source_observation o ON (o.user_id,o.id)=(b.user_id,b.observation_id) WHERE b.user_id=$1 ORDER BY b.observation_id',[userId])).rows;}
async function partyAliases(db:PoolClient,userId:string){return (await db.query<AliasRow>('SELECT id,counterparty_id,alias_type,alias_hmac FROM finance.counterparty_alias WHERE user_id=$1 ORDER BY id',[userId])).rows;}
async function writeOperation(db:PoolClient,userId:string,row:OperationRow){await db.query('UPDATE finance.transaction SET semantics=$3,review_reasons=$4,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,row.id,JSON.stringify(row.semantics),JSON.stringify(row.review_reasons)]);}
async function writeRule(db:PoolClient,userId:string,r:RuleRow){await db.query('UPDATE finance.rule SET conditions=$3,assignments=$4,enabled=$5,dependency_status=$6,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,r.id,JSON.stringify(r.conditions),JSON.stringify(r.assignments),r.enabled,r.dependency_status]);}
function allows(role:string,c:Category){return !['expense','income'].includes(role)||c.role==='both'||c.role===role;}
function compatible(categories:Category[],role:string,categoryId:string|null,subcategoryId:string|null){const c=categories.find(c=>c.id===categoryId),s=categories.find(c=>c.id===subcategoryId);return (categoryId===null||!!c&&c.parentId===null&&allows(role,c))&&(subcategoryId===null||!!s&&s.parentId===c?.id&&allows(role,s));}
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
export async function applyEntity(db:PoolClient,userId:string,intent:EntityIntent,graph:Graph):Promise<EntityUndo>{
 if(intent.kind==='merge_categories'||intent.kind==='delete_category'||intent.kind==='migrate_category')return applyCategory(db,userId,intent,graph);
 return applyParty(db,userId,intent,graph);
}
async function applyCategory(db:PoolClient,userId:string,intent:Extract<EntityIntent,{kind:'merge_categories'|'delete_category'|'migrate_category'}>,graph:Graph):Promise<EntityUndo>{
 const old=graph.categories,category=(id:string)=>{const c=old.find(c=>c.id===id);if(!c)throw new HttpError(404,'NOT_FOUND');return c;},original=category(intent.id),next=structuredClone(old),removed=new Set<string>(),touched=new Set<string>([intent.id]),rootMap=new Map<string,string|null>(),leafMap=new Map<string,string|null>();
 let target:Category|null=null;
 if(intent.kind==='migrate_category'){
  if(intent.parentId!==null){const parent=category(intent.parentId);if(parent.parentId!==null||parent.id===intent.id||old.some(c=>c.parentId===intent.id))throw new HttpError(409,'CATEGORY_PARENT_CONFLICT');}
  target=next.find(c=>c.id===intent.id)!;target.parentId=intent.parentId;target.role=intent.role;
 }else{
  const targetId=intent.kind==='merge_categories'?intent.id:intent.replacementId;target=targetId===null?null:next.find(c=>c.id===category(targetId).id)!;
  const donors=intent.kind==='merge_categories'?intent.sourceIds:[intent.id];
  if(target&&((target.parentId===null)!==(original.parentId===null)))throw new HttpError(409,'CATEGORY_LEVEL_CONFLICT');
  for(const id of donors){const donor=category(id);if((donor.parentId===null)!==(original.parentId===null))throw new HttpError(409,'CATEGORY_LEVEL_CONFLICT');removed.add(id);touched.add(id);
   if(donor.parentId===null){rootMap.set(id,target?.id??null);for(const child of next.filter(c=>c.parentId===id)){touched.add(child.id);if(target)child.parentId=target.id;else removed.add(child.id);}}
   else leafMap.set(id,target?.id??null);
  }
  if(target){touched.add(target.id);if(intent.targetRole)target.role=intent.targetRole;}
 }
 const retained=next.filter(c=>!removed.has(c.id));
 for(const decision of intent.childRoles){const child=retained.find(c=>c.id===decision.id);if(!child||child.parentId!==target?.id)throw new HttpError(409,'INVALID_CHILD_ROLE_SCOPE');child.role=decision.role;touched.add(child.id);}
 for(const c of retained)if(c.parentId!==null){const p=retained.find(p=>p.id===c.parentId);if(!p||p.parentId!==null||p.id===c.id)throw new HttpError(409,'CATEGORY_PARENT_CONFLICT');if(p.role!=='both'&&p.role!==c.role)throw new HttpError(409,'CATEGORY_ROLE_CONFLICT');}
 for(const c of retained)if(!same(c,old.find(o=>o.id===c.id)))touched.add(c.id);
 function remap(c:string|null,s:string|null):[string|null,string|null]{
  if(rootMap.has(c??'')){c=rootMap.get(c!)!;if(c===null)s=null;}
  if(s!==null&&leafMap.has(s)){s=leafMap.get(s)!;if(s!==null)c=retained.find(x=>x.id===s)!.parentId;}
  if(s!==null&&removed.has(s))s=null;
  if(intent.kind==='migrate_category'){
   if(original.parentId===null&&target!.parentId!==null&&c===intent.id){c=target!.parentId;s=intent.id;}
   else if(original.parentId!==null&&s===intent.id){if(target!.parentId===null){c=intent.id;s=null;}else c=target!.parentId;}
  }
  if(s!==null&&touched.has(s))c=retained.find(x=>x.id===s)!.parentId;
  return [c,s];
 }
 const rows=await entityRows(db,userId),before=blank(),changedOperations:string[]=[],changedComponents:string[]=[],rulesMoved:string[]=[],rulesNeedSetup:string[]=[],roleMap=new Map(intent.roleDecisions.map(r=>[r.kind+':'+r.id,r.role])),usedRoles=new Set<string>();
 for(const row of rows.operations){const originalSemantics=row.semantics,affected=touched.has(originalSemantics.category.value??'')||touched.has(originalSemantics.subcategory.value??'');if(!affected)continue;
  const updated=structuredClone(row),sem=updated.semantics,[c,s]=remap(sem.category.value,sem.subcategory.value),decision=roleMap.get('operation:'+row.id);
  if(decision!==undefined){sem.role=facet(decision,'user',true);usedRoles.add('operation:'+row.id);updated.review_reasons=updated.review_reasons.filter(r=>!['low_role_confidence','unresolved_role','unresolved_transfer'].includes(r));}
  sem.category=c===null&&c!==sem.category.value?facet(null,'user',true):{...sem.category,value:c};sem.subcategory=s===null&&s!==sem.subcategory.value?facet(null,'user',true):{...sem.subcategory,value:s};
  if(!compatible(retained,sem.role.value,c,s))throw new HttpError(409,'CATEGORY_ROLE_DECISION_REQUIRED');
  if(!same(row,updated)){before.operations.push(row);await writeOperation(db,userId,updated);changedOperations.push(row.id);}
 }
 for(const row of rows.components){if(!touched.has(row.category.value??'')&&!touched.has(row.subcategory.value??''))continue;const updated=structuredClone(row),[c,s]=remap(row.category.value,row.subcategory.value),decision=roleMap.get('component:'+row.id);
  if(decision!==undefined){updated.role=facet(decision,'user',true);usedRoles.add('component:'+row.id);}updated.category=c===null&&c!==row.category.value?facet(null,'user',true):{...row.category,value:c};updated.subcategory=s===null&&s!==row.subcategory.value?facet(null,'user',true):{...row.subcategory,value:s};
  if(!compatible(retained,updated.role.value,c,s))throw new HttpError(409,'CATEGORY_ROLE_DECISION_REQUIRED');
  if(!same(row,updated)){before.components.push(row);await db.query('UPDATE finance.component SET role=$3,category=$4,subcategory=$5 WHERE user_id=$1 AND id=$2',[userId,row.id,JSON.stringify(updated.role),JSON.stringify(updated.category),JSON.stringify(updated.subcategory)]);changedComponents.push(row.id);}
 }
 if(usedRoles.size!==roleMap.size)throw new HttpError(409,'INVALID_ROLE_DECISION_SCOPE');
 for(const r of rows.rules){const a=r.assignments,oldCategory=typeof a.categoryId==='string'?a.categoryId:null,oldSub=typeof a.subcategoryId==='string'?a.subcategoryId:null;if(!touched.has(oldCategory??'')&&!touched.has(oldSub??''))continue;
  const updated=structuredClone(r),[c,s]=remap(oldCategory,oldSub);if('categoryId'in a||c!==oldCategory)updated.assignments.categoryId=c;if('subcategoryId'in a||s!==oldSub)updated.assignments.subcategoryId=s;
  const previous=old.find(x=>x.id===(oldSub??oldCategory)),current=retained.find(x=>x.id===(s??c));
  const uncertainRole=a.role===undefined&&previous&&current&&current.role!=='both'&&previous.role!==current.role;
  if((oldCategory!==null&&c===null)||(oldSub!==null&&s===null)||uncertainRole||a.role!==undefined&&!compatible(retained,a.role as string,c,s)){updated.enabled=false;updated.dependency_status='needs_setup';rulesNeedSetup.push(r.id);}
  if(!same(r,updated)){before.rules.push(r);await writeRule(db,userId,updated);rulesMoved.push(r.id);}
 }
 before.categories=old.filter(c=>removed.has(c.id)||!same(c,retained.find(n=>n.id===c.id)));
 // Move children before dropping their old parent; all transaction/component references already moved.
 for(const c of retained)if(!same(c,old.find(o=>o.id===c.id)))await db.query('UPDATE finance.category SET parent_id=$3,role=$4,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,c.id,c.parentId,c.role]);
 for(const id of [...removed].sort((a,b)=>Number(category(b).parentId!==null)-Number(category(a).parentId!==null)))await db.query('DELETE FROM finance.category WHERE user_id=$1 AND id=$2',[userId,id]);
 const affected=[...new Set([...changedOperations,...graph.components.filter(c=>changedComponents.includes(c.id)).map(c=>c.transactionId)])].sort(),linkDependencies=dependentLinks(graph.links,graph.links.filter(l=>affected.includes(l.sourceId)||affected.includes(l.targetId)).map(l=>l.id));
 return {table:'entities',id:intent.id,before:before as unknown as Record<string,unknown>,details:{kind:intent.kind,categoriesRemoved:[...removed].sort(),categoriesChanged:retained.filter(c=>touched.has(c.id)),operationDependencies:affected,componentDependencies:changedComponents,linkDependencies,rulesMoved,rulesNeedSetup,roleDecisions:intent.roleDecisions,financialOperationsDeleted:0}};
}
function coverage(actual:string[],assigned:PartyAssignment[]){if(actual.length!==assigned.length||assigned.some(a=>!actual.includes(a.id)))throw new HttpError(409,'EXPLICIT_DISTRIBUTION_REQUIRED');}
export async function removePartyCard(db:PoolClient,userId:string,ids:string[]){
 const rows=await entityRows(db,userId),before=blank();before.parties=(await partyRows(db,userId)).filter(p=>ids.includes(p.id));before.sources=(await partySources(db,userId)).filter(s=>ids.includes(s.counterparty_id));before.aliases=(await partyAliases(db,userId)).filter(a=>ids.includes(a.counterparty_id));
 for(const r of rows.operations)if(ids.includes(r.semantics.counterparty.value??'')){before.operations.push(r);const updated=structuredClone(r);updated.semantics.counterparty=facet(null,'user',true);await writeOperation(db,userId,updated);}
 for(const r of rows.rules)if(ids.includes(r.conditions.counterpartyId as string)||ids.includes(r.assignments.counterpartyId as string)){before.rules.push(r);const updated=structuredClone(r);if(ids.includes(updated.conditions.counterpartyId as string))delete updated.conditions.counterpartyId;if(ids.includes(updated.assignments.counterpartyId as string))updated.assignments.counterpartyId=null;updated.enabled=false;updated.dependency_status='needs_setup';await writeRule(db,userId,updated);}
 await db.query('DELETE FROM finance.observation_counterparty WHERE user_id=$1 AND counterparty_id=ANY($2::uuid[])',[userId,ids]);await db.query('DELETE FROM finance.counterparty_alias WHERE user_id=$1 AND counterparty_id=ANY($2::uuid[])',[userId,ids]);
 await db.query('UPDATE finance.counterparty SET merged_into_id=NULL WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,ids]);await db.query('DELETE FROM finance.counterparty WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,ids]);return before;
}
async function applyParty(db:PoolClient,userId:string,intent:Extract<EntityIntent,{kind:'merge_counterparties'|'split_counterparty'|'delete_counterparty'}>,graph:Graph):Promise<EntityUndo>{
 const parties=await partyRows(db,userId),target=activeParty(parties,intent.id),sources=await partySources(db,userId),aliases=await partyAliases(db,userId),rows=await entityRows(db,userId);let before=blank();
 if(intent.kind==='delete_counterparty'){
  const ids=parties.filter(p=>p.id===intent.id||p.merged_into_id===intent.id).map(p=>p.id);before=await removePartyCard(db,userId,ids);
  return {table:'entities',id:intent.id,before:before as unknown as Record<string,unknown>,details:{kind:intent.kind,counterpartiesRemoved:ids,operationDependencies:before.operations.map(r=>r.id),sourcesRemoved:before.sources.length,aliasesRemoved:before.aliases.length,rulesNeedSetup:before.rules.map(r=>r.id),financialOperationsDeleted:0}};
 }
 if(intent.kind==='merge_counterparties'){
  for(const id of intent.sourceIds)activeParty(parties,id);const donors=new Set(intent.sourceIds);before.parties=parties.filter(p=>donors.has(p.id)||!!p.merged_into_id&&donors.has(p.merged_into_id));before.sources=sources.filter(s=>donors.has(s.counterparty_id));before.aliases=aliases.filter(a=>donors.has(a.counterparty_id));
  for(const r of rows.operations)if(donors.has(r.semantics.counterparty.value??'')){before.operations.push(r);const updated=structuredClone(r);updated.semantics.counterparty={...updated.semantics.counterparty,value:intent.id};await writeOperation(db,userId,updated);}
  for(const r of rows.rules)if(donors.has(r.conditions.counterpartyId as string)||donors.has(r.assignments.counterpartyId as string)){before.rules.push(r);const updated=structuredClone(r);if(donors.has(r.conditions.counterpartyId as string))updated.conditions.counterpartyId=intent.id;if(donors.has(r.assignments.counterpartyId as string))updated.assignments.counterpartyId=intent.id;await writeRule(db,userId,updated);}
  await db.query('UPDATE finance.observation_counterparty SET counterparty_id=$3 WHERE user_id=$1 AND counterparty_id=ANY($2::uuid[])',[userId,intent.sourceIds,intent.id]);await db.query('UPDATE finance.counterparty_alias SET counterparty_id=$3 WHERE user_id=$1 AND counterparty_id=ANY($2::uuid[])',[userId,intent.sourceIds,intent.id]);await db.query('UPDATE finance.counterparty SET merged_into_id=$3,revision=revision+1 WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,before.parties.map(p=>p.id),intent.id]);
  return {table:'entities',id:intent.id,before:before as unknown as Record<string,unknown>,details:{kind:intent.kind,canonicalSettings:target,counterpartiesRedirected:before.parties.map(p=>p.id),operationDependencies:before.operations.map(r=>r.id),observationsMoved:before.sources.length,aliasesMoved:before.aliases.length,rulesMoved:before.rules.map(r=>r.id),sourceFactsPreserved:true,financialRolesUnchanged:true}};
 }
 const destinations=new Set([intent.id,...intent.newParties.map(p=>p.id)]);for(const p of intent.newParties)if(parties.some(a=>a.id===p.id))throw new HttpError(409,'COUNTERPARTY_EXISTS');
 before.sources=sources.filter(s=>s.counterparty_id===intent.id);before.aliases=aliases.filter(a=>a.counterparty_id===intent.id);const bound=new Set(before.sources.map(s=>s.transaction_id)),affected=rows.operations.filter(o=>o.semantics.counterparty.value===intent.id||bound.has(o.id));
 coverage(before.sources.map(s=>s.observation_id),intent.observations);coverage(before.aliases.map(a=>a.id),intent.aliases);coverage(affected.map(o=>o.id),intent.operations);
 for(const a of [...intent.observations,...intent.aliases])if(!a.counterpartyId||!destinations.has(a.counterpartyId))throw new HttpError(409,'INVALID_DESTINATION');for(const a of intent.operations)if(a.counterpartyId!==null&&!destinations.has(a.counterpartyId))activeParty(parties,a.counterpartyId);
 const aliasAssignments=new Map(intent.aliases.map(a=>[a.id,a.counterpartyId]));for(const s of before.sources)if(s.alias_id&&aliasAssignments.get(s.alias_id)!==intent.observations.find(a=>a.id===s.observation_id)!.counterpartyId)throw new HttpError(409,'ALIAS_DISTRIBUTION_CONFLICT');
 before.createdPartyIds=intent.newParties.map(p=>p.id);for(const p of intent.newParties)await db.query('INSERT INTO finance.counterparty(user_id,id,name,state,is_self) VALUES($1,$2,$3,$4,$5)',[userId,p.id,p.name,p.state,p.isSelf]);
 for(const r of affected){before.operations.push(r);const updated=structuredClone(r),assignment=intent.operations.find(a=>a.id===r.id)!;if(assignment.counterpartyId!==updated.semantics.counterparty.value)updated.semantics.counterparty=facet(assignment.counterpartyId,'user',true);await writeOperation(db,userId,updated);}
 for(const a of intent.observations)await db.query('UPDATE finance.observation_counterparty SET counterparty_id=$3 WHERE user_id=$1 AND observation_id=$2',[userId,a.id,a.counterpartyId]);for(const a of intent.aliases)await db.query('UPDATE finance.counterparty_alias SET counterparty_id=$3 WHERE user_id=$1 AND id=$2',[userId,a.id,a.counterpartyId]);
 for(const r of rows.rules)if(r.conditions.counterpartyId===intent.id||r.assignments.counterpartyId===intent.id){before.rules.push(r);await writeRule(db,userId,{...r,enabled:false,dependency_status:'needs_setup'});}
 return {table:'entities',id:intent.id,before:before as unknown as Record<string,unknown>,details:{kind:intent.kind,newParties:intent.newParties,observations:intent.observations,operations:intent.operations,aliases:intent.aliases,rulesNeedSetup:before.rules.map(r=>r.id),sourceFactsPreserved:true,financialRolesUnchanged:true}};
}
export async function restoreEntities(db:PoolClient,userId:string,value:Record<string,unknown>){
 const b=value as unknown as Snapshot;
 for(const c of [...b.categories].sort((a,z)=>Number(a.parentId!==null)-Number(z.parentId!==null)))await db.query('INSERT INTO finance.category(user_id,id,name,parent_id,role,hidden) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,id) DO UPDATE SET name=EXCLUDED.name,parent_id=EXCLUDED.parent_id,role=EXCLUDED.role,hidden=EXCLUDED.hidden,revision=finance.category.revision+1',[userId,c.id,c.name,c.parentId,c.role,c.hidden]);
 for(const p of [...b.parties].sort((a,z)=>Number(a.merged_into_id!==null)-Number(z.merged_into_id!==null)))await db.query('INSERT INTO finance.counterparty(user_id,id,name,state,is_self,merged_into_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,id) DO UPDATE SET name=EXCLUDED.name,state=EXCLUDED.state,is_self=EXCLUDED.is_self,merged_into_id=EXCLUDED.merged_into_id,revision=finance.counterparty.revision+1',[userId,p.id,p.name,p.state,p.is_self,p.merged_into_id]);
 for(const a of b.aliases)await db.query('INSERT INTO finance.counterparty_alias(user_id,id,counterparty_id,alias_type,alias_hmac) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,id) DO UPDATE SET counterparty_id=EXCLUDED.counterparty_id',[userId,a.id,a.counterparty_id,a.alias_type,a.alias_hmac]);
 for(const s of b.sources)await db.query('INSERT INTO finance.observation_counterparty(user_id,observation_id,counterparty_id,alias_id) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,observation_id) DO UPDATE SET counterparty_id=EXCLUDED.counterparty_id',[userId,s.observation_id,s.counterparty_id,s.alias_id]);
 for(const r of b.operations)await writeOperation(db,userId,r);for(const c of b.components)await db.query('UPDATE finance.component SET role=$3,category=$4,subcategory=$5 WHERE user_id=$1 AND id=$2',[userId,c.id,JSON.stringify(c.role),JSON.stringify(c.category),JSON.stringify(c.subcategory)]);for(const r of b.rules)await writeRule(db,userId,r);
 if(b.createdPartyIds.length)await db.query('DELETE FROM finance.counterparty WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,b.createdPartyIds]);
}
