import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {object} from '../../../packages/finance-core/src/model.ts';
import {HttpError,string} from './types.ts';
import type {Sealer} from './types.ts';
import {verifyPassword} from './crypto.ts';
import {sealPseudonymKey} from './pseudonym-context.ts';
import {stableJSON} from './finance-history.ts';

type ResetIntent={kind:'reset_financial';keepCategories:boolean;keepRules:boolean;keepInterface:boolean;keepCounterparties?:boolean;keepBudgets?:boolean;keepAccounts?:boolean;keepCredits?:boolean};
type State={generation:string;revision:string;key_version:string;interface_epoch:string;loan_mode:string;config_revision:string};
const tables=['category_binding','transaction','source_observation','component','link','account','observation_account','account_alias','counterparty','observation_counterparty','counterparty_alias','category','rule','action','ingestion_context','ingestion_batch','ingestion_file','ingestion_row','ingestion_account','duplicate_candidate','operations_view','overview_view','budget','analyzer_chat','analyzer_message'] as const;
type Snapshot={counts:Record<string,number>;fingerprints:Record<string,string>;state:State;rulesNeedSetup:number;removeAccounts?:string[]};
function parse(input:unknown):ResetIntent {
 const optional=['keepCounterparties','keepBudgets','keepAccounts','keepCredits'];
 const r=object(input,['kind','keepCategories','keepRules','keepInterface',...optional]);
 if(r.kind!=='reset_financial'||['keepCategories','keepRules','keepInterface'].some(k=>typeof r[k]!=='boolean')||optional.some(k=>k in r&&typeof r[k]!=='boolean'))throw new TypeError('EXPLICIT_RESET_CHOICES_REQUIRED');
 return r as ResetIntent;
}
function dependencies(r:{conditions:Record<string,unknown>;assignments:Record<string,unknown>},intent:ResetIntent,removeAccounts:readonly string[]){
 const conditions={...r.conditions},assignments={...r.assignments};let changed=false;
 if(typeof conditions.accountId==='string'&&removeAccounts.includes(conditions.accountId)){delete conditions.accountId;changed=true;}
 if(!intent.keepCounterparties&&'counterpartyId' in conditions){delete conditions.counterpartyId;changed=true;}
 for(const k of [...(!intent.keepCounterparties?['counterpartyId']:[]),...(!intent.keepCategories?['categoryId','subcategoryId']:[])])if(assignments[k]!==undefined&&assignments[k]!==null){delete assignments[k];changed=true;}
 return {conditions,assignments,changed};
}
async function snapshot(db:PoolClient,userId:string,id:string,intent:ResetIntent,state:State):Promise<Snapshot>{
 const counts:Record<string,number>={},fingerprints:Record<string,string>={};
 for(const table of tables){
  // Bounded per-row hashes avoid materializing the whole financial graph or storing facts in a preview.
  const row=(await db.query(`SELECT count(*)::int AS n,encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY ${table.startsWith('observation_')?'observation_id':'id'}),''),'UTF8')),'hex') AS fingerprint FROM finance.${table} t WHERE user_id=$1${table==='action'?' AND id<>$2':''}`,[userId,...(table==='action'?[id]:[])])).rows[0];
  counts[table]=row.n;fingerprints[table]=row.fingerprint;
 }
 const accounts=(await db.query<{id:string;credit:boolean}>("SELECT id,account_type IN ('loan','credit_card') AS credit FROM finance.account WHERE user_id=$1 ORDER BY id",[userId])).rows;
 const removeAccounts=accounts.filter(a=>a.credit?!intent.keepCredits:!intent.keepAccounts).map(a=>a.id);
 counts.credits=accounts.filter(a=>a.credit).length;
 counts.creditsDeleted=accounts.filter(a=>a.credit&&removeAccounts.includes(a.id)).length;
 counts.accountAliasesDeleted=(await db.query("SELECT count(*)::int AS n FROM finance.account_alias WHERE user_id=$1 AND account_id=ANY($2::uuid[])",[userId,removeAccounts])).rows[0].n;
 const rules=(await db.query('SELECT conditions,assignments FROM finance.rule WHERE user_id=$1',[userId])).rows;
 return {counts,fingerprints,state:{generation:state.generation,revision:state.revision,key_version:state.key_version,interface_epoch:state.interface_epoch,loan_mode:state.loan_mode,config_revision:state.config_revision},removeAccounts,rulesNeedSetup:intent.keepRules?rules.filter(r=>dependencies(r,intent,removeAccounts).changed).length:0};
}
function impact(s:Snapshot,intent:ResetIntent){
 const c=s.counts,accountsDeleted=s.removeAccounts?.length??c.account!,creditsDeleted=c.creditsDeleted??0,rotate=(c.account_alias??0)===(c.accountAliasesDeleted??0)&&(!intent.keepCounterparties||!c.counterparty_alias);
 return {details:{kind:intent.kind,scope:'all_financial_data',destructive:true,undoable:false,requiresConfirmation:true,reimportWarning:true,counts:{categoryBindings:intent.keepCategories?0:c.category_binding,analyzerChats:c.analyzer_chat,analyzerMessages:c.analyzer_message,overviewViews:intent.keepInterface?0:c.overview_view,budgets:intent.keepBudgets?0:c.budget,operations:c.transaction,observations:c.source_observation,components:c.component,links:c.link,accounts:accountsDeleted-creditsDeleted,credits:creditsDeleted,accountAliases:c.accountAliasesDeleted??c.account_alias,counterparties:intent.keepCounterparties?0:c.counterparty,counterpartyAliases:intent.keepCounterparties?0:c.counterparty_alias,sourceBindings:c.observation_account!+c.observation_counterparty!,history:c.action,preparedContexts:c.ingestion_context,imports:c.ingestion_batch,importFiles:c.ingestion_file,importRows:c.ingestion_row,importAccounts:c.ingestion_account,duplicateCandidates:c.duplicate_candidate,categories:intent.keepCategories?0:c.category,rules:intent.keepRules?0:c.rule,operationsViews:intent.keepInterface?0:c.operations_view},preserved:{categories:intent.keepCategories?c.category:0,rules:intent.keepRules?c.rule:0,interface:intent.keepInterface,accounts:c.account!-accountsDeleted-(c.credits!-creditsDeleted),credits:c.credits!-creditsDeleted,counterparties:intent.keepCounterparties?c.counterparty:0,budgets:intent.keepBudgets?c.budget:0},rulesNeedSetup:s.rulesNeedSetup,keyPolicy:rotate?'rotate':'retain_aliases',pendingPayloadPolicy:'invalidate_generation'}};
}
export async function previewReset(db:PoolClient,userId:string,id:string,input:unknown,state:State,existing:Record<string,any>|undefined){
 const intent=parse(input);
 if(existing){if(stableJSON(existing.intent.request)!==stableJSON(intent))throw new HttpError(409,'ACTION_REUSED');return {status:'previewed',actionId:id,intent:existing.intent.canonical,impact:existing.preview};}
 const s=await snapshot(db,userId,id,intent,state),preview=impact(s,intent);
 await db.query('INSERT INTO finance.action(user_id,id,generation,expected_revision,intent,preview) VALUES($1,$2,$3,$4,$5,$6)',[userId,id,state.generation,state.revision,JSON.stringify({request:intent,canonical:intent,snapshot:s}),JSON.stringify(preview)]);
 return {status:'previewed',actionId:id,intent,impact:preview};
}
async function recentAuthentication(db:PoolClient,userId:string,sessionId:string|undefined,password:unknown){
 if(!sessionId)throw new HttpError(401,'RECENT_AUTHENTICATION_REQUIRED');
 const session=(await db.query("SELECT created_at>clock_timestamp()-interval '5 minutes' AS fresh FROM identity.auth_session WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp()",[sessionId,userId])).rows[0];
 if(!session)throw new HttpError(401,'AUTH_REQUIRED');
 if(password===undefined){if(!session.fresh)throw new HttpError(401,'RECENT_AUTHENTICATION_REQUIRED');return;}
 const encoded=(await db.query("SELECT password FROM identity.auth_account WHERE user_id=$1 AND provider_id='credential'",[userId])).rows[0]?.password;
 if(!encoded||!await verifyPassword(string(password,128),encoded))throw new HttpError(401,'INVALID_CREDENTIALS');
}
export async function commitReset(db:PoolClient,userId:string,id:string,action:Record<string,any>,state:State,seal:Sealer|undefined,confirmation:unknown,sessionId:string|undefined,password:unknown){
 if(confirmation!==true)throw new HttpError(400,'RESET_CONFIRMATION_REQUIRED');
 if(!seal)throw new HttpError(503,'RESET_UNAVAILABLE');
 await recentAuthentication(db,userId,sessionId,password);
 const intent=parse(action.intent.canonical),current=await snapshot(db,userId,id,intent,state);
 if(stableJSON(current)!==stableJSON(action.intent.snapshot))throw new HttpError(409,'DEPENDENCIES_CHANGED');
 const removeAccounts=current.removeAccounts??[];
 if(!intent.keepBudgets)await db.query('DELETE FROM finance.budget WHERE user_id=$1',[userId]);
 else for(const budget of (await db.query('SELECT id,definition FROM finance.budget WHERE user_id=$1',[userId])).rows){
  const definition=budget.definition,filter={...definition.filter};let affected=false;
  for(const k of ['accountIds','counterpartyIds','categoryIds','subcategoryIds','operationIds','batchId','fileId','ruleId'] as const){
   if(k==='accountIds'&&Array.isArray(filter[k])){const ids=(filter[k] as string[]).filter(id=>!removeAccounts.includes(id));if(ids.length!==(filter[k] as string[]).length){affected=true;if(ids.length)filter[k]=ids;else delete filter[k];}}
   else if(k in filter&&(!intent.keepCounterparties&&k==='counterpartyIds'||!intent.keepCategories&&['categoryIds','subcategoryIds'].includes(k)||!intent.keepRules&&k==='ruleId'||['operationIds','batchId','fileId'].includes(k))){affected=true;delete filter[k];}
  }
  if(affected)await db.query("UPDATE finance.budget SET definition=$3,enabled=false,dependency_status='needs_setup' WHERE user_id=$1 AND id=$2",[userId,budget.id,JSON.stringify({...definition,filter})]);
 }
 // Remove all supported copies, including inactive components and prior deletion receipts.
 await db.query('DELETE FROM finance.ingestion_batch WHERE user_id=$1',[userId]);
 await db.query('DELETE FROM finance.link WHERE user_id=$1',[userId]);
 await db.query('DELETE FROM finance.transaction WHERE user_id=$1',[userId]);
 await db.query('DELETE FROM finance.analyzer_chat WHERE user_id=$1',[userId]);
 if(removeAccounts.length){
  await db.query('DELETE FROM finance.account_alias WHERE user_id=$1 AND account_id=ANY($2::uuid[])',[userId,removeAccounts]);
  await db.query('UPDATE finance.account SET merged_into_id=NULL WHERE user_id=$1 AND merged_into_id=ANY($2::uuid[]) AND NOT id=ANY($2::uuid[])',[userId,removeAccounts]);
  await db.query('DELETE FROM finance.account WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,removeAccounts]);
 }
 if(!intent.keepCounterparties){await db.query('DELETE FROM finance.counterparty_alias WHERE user_id=$1',[userId]);await db.query('DELETE FROM finance.counterparty WHERE user_id=$1',[userId]);}
 if(intent.keepRules){
  const rules=(await db.query('SELECT id,conditions,assignments FROM finance.rule WHERE user_id=$1',[userId])).rows;
  for(const r of rules){const d=dependencies(r,intent,removeAccounts);if(d.changed)await db.query("UPDATE finance.rule SET conditions=$3,assignments=$4,enabled=false,dependency_status='needs_setup' WHERE user_id=$1 AND id=$2",[userId,r.id,JSON.stringify(d.conditions),JSON.stringify(d.assignments)]);}
 }else await db.query('DELETE FROM finance.rule WHERE user_id=$1',[userId]);
 if(!intent.keepCategories)await db.query('DELETE FROM finance.category WHERE user_id=$1',[userId]);
 if(!intent.keepInterface)await db.query('DELETE FROM finance.overview_view WHERE user_id=$1',[userId]);else {const views=(await db.query('SELECT id,definition FROM finance.overview_view WHERE user_id=$1',[userId])).rows;for(const view of views){const clean=(f:Record<string,unknown>)=>Object.fromEntries(Object.entries(f).filter(([k])=>['from','through','timezone','kind','role','source','inclusion','includeExcluded','refund','transfer','linked','status','attention','uncategorized','noSubcategory','noCounterparty'].includes(k)));const definition={...view.definition,filter:clean(view.definition.filter),widgets:view.definition.widgets.map((w:Record<string,unknown>,i:number)=>({...w,name:'Виджет '+(i+1),filter:clean(w.filter as Record<string,unknown>),budgetIds:[],excludedCategoryIds:[]}))};await db.query("UPDATE finance.overview_view SET name='Сохранённое представление',definition=$3,dependency_status='needs_setup' WHERE user_id=$1 AND id=$2",[userId,view.id,JSON.stringify(definition)]);}}
 if(!intent.keepInterface)await db.query('DELETE FROM finance.operations_view WHERE user_id=$1',[userId]);else {const views=(await db.query('SELECT id,definition FROM finance.operations_view WHERE user_id=$1',[userId])).rows;for(const view of views){const filter={...view.definition.filter};for(const key of ['search','merchant','comment','accountIds','counterpartyIds','batchId','fileId','operationIds','ruleId',...(!intent.keepCategories?['categoryIds','subcategoryIds']:[])])delete filter[key];await db.query("UPDATE finance.operations_view SET definition=$3,dependency_status='needs_setup' WHERE user_id=$1 AND id=$2",[userId,view.id,JSON.stringify({...view.definition,filter})]);}}
 await db.query('DELETE FROM finance.ingestion_context WHERE user_id=$1',[userId]);
 await db.query('DELETE FROM finance.action WHERE user_id=$1 AND id<>$2',[userId,id]);
 const generation=randomUUID(),cleanup={...impact(current,intent).details,interfaceReset:!intent.keepInterface};
 // Kept bank aliases cannot be rehashed without the original statement identifiers.
 // Invalidate all outstanding uploads via generation even when their alias key is retained.
 if(cleanup.keyPolicy==='rotate'){const version=randomUUID();await db.query('SELECT finance.rotate_pseudonym_key($1,$2,$3,$4,$5)',[state.generation,state.key_version,generation,version,sealPseudonymKey(seal,userId,version)]);}
 else await db.query('UPDATE finance.workspace SET generation=$2 WHERE user_id=$1',[userId,generation]);
 const next=(await db.query("UPDATE finance.workspace SET revision=revision+1,loan_mode=CASE WHEN $3 THEN loan_mode ELSE 'cashflow' END,interface_epoch=CASE WHEN $2 THEN interface_epoch ELSE gen_random_uuid() END WHERE user_id=$1 RETURNING generation,revision,key_version,interface_epoch",[userId,intent.keepInterface,!!intent.keepCredits])).rows[0];
 const result={status:'committed',actionId:id,generation:next.generation,revision:next.revision,keyVersion:next.key_version,interfaceEpoch:next.interface_epoch,cleanup};
 await db.query("UPDATE finance.action SET status='committed',generation=$3,intent=$4,preview=$5,result=$6,undo_patch=NULL,change_set=NULL,affected_operation_ids='{}',committed_at=clock_timestamp(),committed_revision=$7 WHERE user_id=$1 AND id=$2",[userId,id,next.generation,JSON.stringify({canonical:{kind:'reset_financial',receipt:true}}),JSON.stringify(cleanup),JSON.stringify(result),next.revision]);
 return result;
}
