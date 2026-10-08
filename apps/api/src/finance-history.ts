import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {object,uuid,dateFact} from '../../../packages/finance-core/src/model.ts';
import {HttpError} from './types.ts';

const definitions={
 operation:{table:'transaction',id:'id',keys:['corrections','semantics','comment','analytics_override','decomposition','review_reasons','source_observation_id'],readonly:['source_observation_id']},
 account:{table:'account',id:'id',keys:['bank_id','system_name','display_name','account_type','currency','analytics_enabled','default_visible','loan_mode','merged_into_id'],readonly:['bank_id','system_name','currency']},
 category:{table:'category',id:'id',keys:['name','parent_id','role','hidden'],readonly:[]},
 counterparty:{table:'counterparty',id:'id',keys:['name','state','is_self','merged_into_id'],readonly:[]},
 rule:{table:'rule',id:'id',keys:['name','enabled','priority','conditions','assignments','dependency_status'],readonly:[]},
 link:{table:'link',id:'id',keys:['source_id','target_id','source_component_id','target_component_id','kind','amount_minor','status','confidence','created_by'],readonly:[]},
 component:{table:'component',id:'id',keys:['transaction_id','type','amount_minor','role','category','subcategory','active'],readonly:['transaction_id']},
 account_source:{table:'observation_account',id:'observation_id',keys:['account_id','transaction_id'],readonly:['transaction_id']},
 account_alias:{table:'account_alias',id:'id',keys:['account_id','alias_type','alias_hmac'],readonly:['alias_type','alias_hmac']},
 counterparty_source:{table:'observation_counterparty',id:'observation_id',keys:['counterparty_id','alias_id','transaction_id'],readonly:['alias_id','transaction_id']},
 counterparty_alias:{table:'counterparty_alias',id:'id',keys:['counterparty_id','alias_type','alias_hmac'],readonly:['alias_type','alias_hmac']},
 analytics:{table:'workspace',id:'user_id',keys:['loan_mode'],readonly:[]},
} as const;
export type ObjectKind=keyof typeof definitions;
type Snapshot={revision:string;values:Record<string,unknown>};
export type Change={kind:ObjectKind;id:string;before:Snapshot|null;after:Snapshot|null};
export type SnapshotMap=Map<string,{kind:ObjectKind;id:string;snapshot:Snapshot}>;
export type RestoreIntent={kind:'restore_history';id:string;actionIds:string[]};
export type HistoryUndo={table:'history';id:string;before:null;details:Record<string,unknown>};
type Conflict={actionId?:string;kind?:ObjectKind;id?:string;reason:string};
type HistoryRow={id:string;generation:string;intent:{canonical:{kind:string}};change_set:Change[]|null;affected_operation_ids:string[];committed_revision:string;committed_at:Date;undone:boolean;recent:boolean;undo_patch:unknown};
const key=(kind:ObjectKind,id:string)=>kind+':'+id;
export function stableJSON(v:unknown):string{return JSON.stringify(v,(_k,r)=>r&&typeof r==='object'&&!Array.isArray(r)?Object.fromEntries(Object.keys(r).sort().map(k=>[k,r[k]])):r);}
function ids(value:unknown,max=100){if(!Array.isArray(value)||value.length<1||value.length>max)throw new TypeError('INVALID_SELECTION');const result=value.map(uuid);if(new Set(result).size!==result.length)throw new TypeError('DUPLICATE_SELECTION');return result;}
export function parseRestoreIntent(value:unknown):RestoreIntent {const r=object(value,['kind','actionIds']);return {kind:'restore_history',id:randomUUID(),actionIds:ids(r.actionIds)};}
export async function captureHistory(db:PoolClient,userId:string):Promise<SnapshotMap>{
 const result:SnapshotMap=new Map();
 for(const kind of Object.keys(definitions)as ObjectKind[]){const d=definitions[kind];let rows:Record<string,unknown>[];
  if(kind==='account_source'||kind==='counterparty_source')rows=(await db.query(`SELECT b.*,o.transaction_id FROM finance.${d.table} b JOIN finance.source_observation o ON (o.user_id,o.id)=(b.user_id,b.observation_id) WHERE b.user_id=$1 ORDER BY b.observation_id`,[userId])).rows;
  else rows=(await db.query(`SELECT ${d.id},${kind==='analytics'?'config_revision AS revision':'revision'},${d.keys.join(',')} FROM finance.${d.table} WHERE user_id=$1 ORDER BY ${d.id}`,[userId])).rows;
  for(const row of rows){const id=row[d.id]as string;result.set(key(kind,id),{kind,id,snapshot:{revision:String(row.revision),values:Object.fromEntries(d.keys.map(k=>[k,row[k]]))}});}
 }
 return result;
}
export function historyDelta(before:SnapshotMap,after:SnapshotMap):Change[]{
 return [...new Set([...before.keys(),...after.keys()])].sort().flatMap(k=>{const b=before.get(k),a=after.get(k);return stableJSON(b?.snapshot??null)===stableJSON(a?.snapshot??null)?[]:[{kind:(a??b)!.kind,id:(a??b)!.id,before:b?.snapshot??null,after:a?.snapshot??null}];});
}
export function publicChanges(changes:Change[]){const safe=(s:Snapshot|null)=>s===null?null:{revision:s.revision,values:Object.fromEntries(Object.entries(s.values).filter(([k])=>k!=='alias_hmac'))};return changes.map(c=>({...c,before:safe(c.before),after:safe(c.after)}));}
export function associatedOperations(changes:Change[],projected:string[]){const ids=new Set(projected);for(const c of changes){if(c.kind==='operation')ids.add(c.id);for(const s of [c.before,c.after])if(s){if(c.kind==='link'){ids.add(s.values.source_id as string);ids.add(s.values.target_id as string);}if(['component','account_source','counterparty_source'].includes(c.kind))ids.add(s.values.transaction_id as string);}}return [...ids].sort();}
async function historyRows(db:PoolClient,userId:string){const rows=(await db.query<HistoryRow>("SELECT *,committed_at>clock_timestamp()-interval '30 days' AS recent FROM finance.action WHERE user_id=$1 AND status='committed' AND (committed_at>clock_timestamp()-interval '30 days' OR undone=false) ORDER BY committed_revision DESC LIMIT 10001",[userId])).rows;if(rows.length>10000)throw new HttpError(409,'HISTORY_SIZE_LIMIT');return rows;}
function plan(rows:HistoryRow[],actionIds:string[],current:SnapshotMap,generation:string){
 const selected=new Set(actionIds),actions=actionIds.map(id=>{const row=rows.find(r=>r.id===id);if(!row)throw new HttpError(404,'NOT_FOUND');return row;}).sort((a,b)=>BigInt(a.committed_revision)>BigInt(b.committed_revision)?-1:1),virtual=new Map(current),targets=new Map<string,Change>(),conflicts:Conflict[]=[],objects=new Map<string,{kind:ObjectKind;id:string}>();
 for(const row of actions){let reason:string|undefined;
  if(!row.recent)reason='HISTORY_EXPIRED';else if(row.generation!==generation)reason='GENERATION_CHANGED';else if(row.undone)reason='ALREADY_ROLLED_BACK';else if(['delete_financial','undo','restore_history'].includes(row.intent.canonical.kind)||!row.undo_patch)reason='ACTION_NOT_REVERSIBLE';else if(!row.change_set)reason='LEGACY_HISTORY';
  if(reason){conflicts.push({actionId:row.id,reason});continue;}
  for(const c of row.change_set!){const k=key(c.kind,c.id);objects.set(k,{kind:c.kind,id:c.id});
   const later=rows.some(r=>!selected.has(r.id)&&BigInt(r.committed_revision)>BigInt(row.committed_revision)&&r.change_set?.some(l=>key(l.kind,l.id)===k));
   if(later||stableJSON(virtual.get(k)?.snapshot??null)!==stableJSON(c.after)){conflicts.push({actionId:row.id,kind:c.kind,id:c.id,reason:!virtual.has(k)&&c.after?'OBJECT_MISSING':'OBJECT_CHANGED'});continue;}
   targets.set(k,{...c,after:current.get(k)?.snapshot??null});if(c.before)virtual.set(k,{kind:c.kind,id:c.id,snapshot:c.before});else virtual.delete(k);
  }
 }
 if(objects.size>5000)throw new HttpError(409,'ROLLBACK_SCOPE_LIMIT');
 return {actions,targets:[...targets.values()],objects:[...objects.values()],conflicts};
}
const jsonKeys=new Set(['corrections','semantics','review_reasons','conditions','assignments','role','category','subcategory']);
async function put(db:PoolClient,userId:string,c:Change){
 const d=definitions[c.kind],values=c.before!.values,exists=c.after!==null,keys=d.keys.filter(k=>!exists||!(d.readonly as readonly string[]).includes(k)).filter(k=>k!=='transaction_id'||c.kind==='component'),params=keys.map(k=>jsonKeys.has(k)&&(k!=='role'||c.kind==='component')?JSON.stringify(values[k]):values[k]);
 if(c.kind==='operation'&&!exists)throw new HttpError(409,'OBJECT_MISSING');
 if(exists)await db.query(`UPDATE finance.${d.table} SET ${keys.map((k,i)=>k+'=$'+(i+3)).join(',')} WHERE user_id=$1 AND ${d.id}=$2`,[userId,c.id,...params]);
 else await db.query(`INSERT INTO finance.${d.table}(user_id,${d.id},${keys.join(',')}) VALUES($1,$2,${keys.map((_k,i)=>'$'+(i+3)).join(',')})`,[userId,c.id,...params]);
}
function order(c:Change){if(c.kind==='account')return 0;if(c.kind==='category')return c.before?.values.parent_id?2:1;if(c.kind==='counterparty')return c.before?.values.merged_into_id?4:3;if(c.kind.endsWith('_alias'))return 5;if(c.kind==='operation')return 6;if(c.kind==='component')return 7;if(c.kind==='link')return 9;return 8;}
function referenceConflicts(map:SnapshotMap):Conflict[]{
 const out:Conflict[]=[],get=(k:ObjectKind,id:unknown)=>typeof id==='string'?map.get(key(k,id))?.snapshot.values:undefined;
 const compatible=(role:unknown,c:unknown,s:unknown)=>{const root=get('category',c),sub=get('category',s),allows=(v:Record<string,unknown>)=>!['expense','income'].includes(role as string)||v.role==='both'||v.role===role;return (c===null||!!root&&root.parent_id===null&&allows(root))&&(s===null||!!sub&&sub.parent_id===c&&allows(sub));};
 for(const row of map.values()){const v=row.snapshot.values;let invalid=false;
  if(row.kind==='category'&&v.parent_id!==null){const parent=get('category',v.parent_id);invalid=!parent||parent.parent_id!==null||parent.role!=='both'&&parent.role!==v.role;}
  if(row.kind==='operation'){const sem=v.semantics as {role:{value:string};category:{value:string|null};subcategory:{value:string|null};counterparty:{value:string|null}};invalid=!compatible(sem.role.value,sem.category.value,sem.subcategory.value)||sem.counterparty.value!==null&&!get('counterparty',sem.counterparty.value)||!!get('counterparty',sem.counterparty.value)?.merged_into_id||!!v.corrections&&typeof v.corrections==='object'&&'accountId'in v.corrections&&!get('account',(v.corrections as Record<string,unknown>).accountId);}
  if(row.kind==='component')invalid=!compatible((v.role as {value:string}).value,(v.category as {value:string|null}).value,(v.subcategory as {value:string|null}).value);
  if(row.kind==='rule'){const a=v.assignments as Record<string,unknown>,f=v.conditions as Record<string,unknown>;invalid=!compatible(a.role,a.categoryId??null,a.subcategoryId??null)||[f.counterpartyId,a.counterpartyId].some(id=>id!==undefined&&id!==null&&(!get('counterparty',id)||get('counterparty',id)?.merged_into_id))||f.accountId!==undefined&&(!get('account',f.accountId)||!!get('account',f.accountId)?.merged_into_id);}
  if(invalid)out.push({kind:row.kind,id:row.id,reason:'DEPENDENCY_CONFLICT'});
 }
 return out;
}
export async function restoreHistory(db:PoolClient,userId:string,intent:RestoreIntent,generation:string,validate:()=>Promise<Conflict[]>):Promise<HistoryUndo>{
 const current=await captureHistory(db,userId),p=plan(await historyRows(db,userId),intent.actionIds,current,generation),details:Record<string,unknown>={kind:intent.kind,actionIds:p.actions.map(r=>r.id),objects:p.objects,conflicts:p.conflicts,atomic:true};
 if(p.conflicts.length)return {table:'history',id:intent.id,before:null,details};
 await db.query('SAVEPOINT history_replay');
 try{
  // Remove new links first, then recreate/update referenced objects, then remove newly created cards/components.
  for(const c of p.targets.filter(c=>!c.before&&c.kind==='link'))await db.query('DELETE FROM finance.link WHERE user_id=$1 AND id=$2',[userId,c.id]);
  for(const c of p.targets.filter(c=>c.before).sort((a,b)=>order(a)-order(b)))await put(db,userId,c);
  for(const c of p.targets.filter(c=>!c.before&&c.kind!=='link').sort((a,b)=>order(b)-order(a))){const d=definitions[c.kind];if(c.kind==='operation'||c.kind==='analytics')throw new HttpError(409,'OBJECT_MISSING');await db.query(`DELETE FROM finance.${d.table} WHERE user_id=$1 AND ${d.id}=$2`,[userId,c.id]);}
  await db.query('SET CONSTRAINTS ALL IMMEDIATE');await db.query('SET CONSTRAINTS ALL DEFERRED');
  const restored=await captureHistory(db,userId),existingConflicts=new Set(referenceConflicts(current).map(c=>key(c.kind!,c.id!)));
  const conflicts=[...referenceConflicts(restored).filter(c=>!existingConflicts.has(key(c.kind!,c.id!))||stableJSON(current.get(key(c.kind!,c.id!))?.snapshot.values)!==stableJSON(restored.get(key(c.kind!,c.id!))?.snapshot.values)),...await validate()];if(conflicts.length){await db.query('ROLLBACK TO SAVEPOINT history_replay');details.conflicts=conflicts;}
  else await db.query('UPDATE finance.action SET undone=true WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,intent.actionIds]);
 }catch(e){await db.query('ROLLBACK TO SAVEPOINT history_replay');if(e instanceof HttpError||['23503','23505','23514'].includes((e as {code:string}).code))details.conflicts=[{reason:'DEPENDENCY_CONFLICT'}];else throw e;}
 finally{await db.query('RELEASE SAVEPOINT history_replay');}
 return {table:'history',id:intent.id,before:null,details};
}
type HistoryFilter={from?:string;through?:string;operationIds?:string[];kinds?:string[];beforeRevision?:string;limit:number};
const actionKinds=['operation','components','link','account','category','counterparty','rule','analytics','undo','merge_accounts','split_account','delete_financial','merge_categories','delete_category','migrate_category','merge_counterparties','split_counterparty','delete_counterparty','set_exclusion','restore_history'];
function parseHistoryFilter(value:unknown):HistoryFilter {const r=object(value,['from','through','operationIds','kinds','beforeRevision','limit']),f:HistoryFilter={limit:100};
 for(const k of ['from','through']as const)if(k in r){const d=dateFact({precision:'instant',instant:r[k]});f[k]=(d as {instant:string}).instant;}if(f.from&&f.through&&f.from>f.through)throw new TypeError('INVALID_RANGE');
 if('operationIds'in r)f.operationIds=ids(r.operationIds);if('kinds'in r){if(!Array.isArray(r.kinds)||!r.kinds.length||r.kinds.length>actionKinds.length||r.kinds.some(k=>typeof k!=='string'||!actionKinds.includes(k)))throw new TypeError('INVALID_HISTORY_KINDS');f.kinds=[...new Set(r.kinds as string[])];}
 if('beforeRevision'in r){if(typeof r.beforeRevision!=='string'||!/^(0|[1-9]\d*)$/.test(r.beforeRevision))throw new TypeError('INVALID_REVISION');f.beforeRevision=r.beforeRevision;}
 if('limit'in r){if(typeof r.limit!=='number'||!Number.isInteger(r.limit)||r.limit<1||r.limit>100)throw new TypeError('INVALID_LIMIT');f.limit=r.limit;}return f;
}
export async function queryHistory(db:PoolClient,userId:string,generation:string,input:unknown={}){
 const f=parseHistoryFilter(input),current=await captureHistory(db,userId),all=await historyRows(db,userId);
 if(f.operationIds)for(const id of f.operationIds)if(!current.has(key('operation',id)))throw new HttpError(404,'NOT_FOUND');
 const filtered=all.filter(r=>r.recent&&(!f.from||r.committed_at>=new Date(f.from))&&(!f.through||r.committed_at<=new Date(f.through))&&(!f.operationIds||r.affected_operation_ids.some(id=>f.operationIds!.includes(id)))&&(!f.kinds||f.kinds.includes(r.intent.canonical.kind))&&(!f.beforeRevision||BigInt(r.committed_revision)<BigInt(f.beforeRevision))),page=filtered.slice(0,f.limit),actions=page.map(r=>{
  const p=plan(all,[r.id],current,generation),available=!p.conflicts.length,structural=!r.change_set&&!['delete_financial','undo','restore_history'].includes(r.intent.canonical.kind)&&r.undo_patch&&!r.undone;
  return {id:r.id,committed_at:r.committed_at,revision:r.committed_revision,intent:r.intent.canonical,undone:r.undone,undoable:available,requiresPreview:true,dependenciesChecked:false,rollbackStatus:available?'available':structural?'legacy':p.conflicts.some(c=>['OBJECT_CHANGED','OBJECT_MISSING','DEPENDENCY_CONFLICT'].includes(c.reason))?'conflict':'not_available',conflicts:p.conflicts,operationIds:r.affected_operation_ids,changes:publicChanges(r.change_set??[])};
 });
 return {actions,nextBeforeRevision:filtered.length>f.limit?page.at(-1)?.committed_revision??null:null};
}
