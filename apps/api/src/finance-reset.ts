import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {object} from '../../../packages/finance-core/src/model.ts';
import {HttpError,string} from './types.ts';
import type {Sealer} from './types.ts';
import {verifyPassword} from './crypto.ts';
import {sealPseudonymKey} from './pseudonym-context.ts';
import {stableJSON} from './finance-history.ts';

type ResetIntent={kind:'reset_financial';keepCategories:boolean;keepRules:boolean;keepInterface:boolean};
type State={generation:string;revision:string;key_version:string;interface_epoch:string;loan_mode:string;config_revision:string};
const tables=['transaction','source_observation','component','link','account','observation_account','account_alias','counterparty','observation_counterparty','counterparty_alias','category','rule','action','ingestion_context','ingestion_batch','ingestion_file','ingestion_row','ingestion_account','duplicate_candidate'] as const;
type Snapshot={counts:Record<string,number>;fingerprints:Record<string,string>;state:State;rulesNeedSetup:number};
function parse(input:unknown):ResetIntent {
 const r=object(input,['kind','keepCategories','keepRules','keepInterface']);
 if(r.kind!=='reset_financial'||['keepCategories','keepRules','keepInterface'].some(k=>typeof r[k]!=='boolean'))throw new TypeError('EXPLICIT_RESET_CHOICES_REQUIRED');
 return r as ResetIntent;
}
function dependencies(r:{conditions:Record<string,unknown>;assignments:Record<string,unknown>},keepCategories:boolean){
 const conditions={...r.conditions},assignments={...r.assignments};let changed=false;
 for(const k of ['accountId','counterpartyId'])if(k in conditions){delete conditions[k];changed=true;}
 for(const k of ['counterpartyId',...(!keepCategories?['categoryId','subcategoryId']:[])])if(assignments[k]!==undefined&&assignments[k]!==null){delete assignments[k];changed=true;}
 return {conditions,assignments,changed};
}
async function snapshot(db:PoolClient,userId:string,id:string,intent:ResetIntent,state:State):Promise<Snapshot>{
 const counts:Record<string,number>={},fingerprints:Record<string,string>={};
 for(const table of tables){
  // Bounded per-row hashes avoid materializing the whole financial graph or storing facts in a preview.
  const row=(await db.query(`SELECT count(*)::int AS n,encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY ${table.startsWith('observation_')?'observation_id':'id'}),''),'UTF8')),'hex') AS fingerprint FROM finance.${table} t WHERE user_id=$1${table==='action'?' AND id<>$2':''}`,[userId,...(table==='action'?[id]:[])])).rows[0];
  counts[table]=row.n;fingerprints[table]=row.fingerprint;
 }
 const rules=(await db.query('SELECT conditions,assignments FROM finance.rule WHERE user_id=$1',[userId])).rows;
 return {counts,fingerprints,state:{generation:state.generation,revision:state.revision,key_version:state.key_version,interface_epoch:state.interface_epoch,loan_mode:state.loan_mode,config_revision:state.config_revision},rulesNeedSetup:intent.keepRules?rules.filter(r=>dependencies(r,intent.keepCategories).changed).length:0};
}
function impact(s:Snapshot,intent:ResetIntent){
 const c=s.counts;
 return {details:{kind:intent.kind,scope:'all_financial_data',destructive:true,undoable:false,requiresConfirmation:true,reimportWarning:true,counts:{operations:c.transaction,observations:c.source_observation,components:c.component,links:c.link,accounts:c.account,accountAliases:c.account_alias,counterparties:c.counterparty,counterpartyAliases:c.counterparty_alias,sourceBindings:c.observation_account!+c.observation_counterparty!,history:c.action,preparedContexts:c.ingestion_context,imports:c.ingestion_batch,importFiles:c.ingestion_file,importRows:c.ingestion_row,importAccounts:c.ingestion_account,duplicateCandidates:c.duplicate_candidate,categories:intent.keepCategories?0:c.category,rules:intent.keepRules?0:c.rule},preserved:{categories:intent.keepCategories?c.category:0,rules:intent.keepRules?c.rule:0,interface:intent.keepInterface},rulesNeedSetup:s.rulesNeedSetup,keyPolicy:'rotate',pendingPayloadPolicy:'invalidate_generation_and_key_version'}};
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
 // Remove all supported copies, including inactive components and prior deletion receipts.
 await db.query('DELETE FROM finance.ingestion_batch WHERE user_id=$1',[userId]);
 await db.query('DELETE FROM finance.link WHERE user_id=$1',[userId]);
 await db.query('DELETE FROM finance.transaction WHERE user_id=$1',[userId]);
 for(const table of ['account_alias','counterparty_alias','account','counterparty'])await db.query(`DELETE FROM finance.${table} WHERE user_id=$1`,[userId]);
 if(intent.keepRules){
  const rules=(await db.query('SELECT id,conditions,assignments FROM finance.rule WHERE user_id=$1',[userId])).rows;
  for(const r of rules){const d=dependencies(r,intent.keepCategories);if(d.changed)await db.query("UPDATE finance.rule SET conditions=$3,assignments=$4,enabled=false,dependency_status='needs_setup' WHERE user_id=$1 AND id=$2",[userId,r.id,JSON.stringify(d.conditions),JSON.stringify(d.assignments)]);}
 }else await db.query('DELETE FROM finance.rule WHERE user_id=$1',[userId]);
 if(!intent.keepCategories)await db.query('DELETE FROM finance.category WHERE user_id=$1',[userId]);
 await db.query('DELETE FROM finance.ingestion_context WHERE user_id=$1',[userId]);
 await db.query('DELETE FROM finance.action WHERE user_id=$1 AND id<>$2',[userId,id]);
 const generation=randomUUID(),version=randomUUID();
 await db.query('SELECT finance.rotate_pseudonym_key($1,$2,$3,$4,$5)',[state.generation,state.key_version,generation,version,sealPseudonymKey(seal,userId,version)]);
 const next=(await db.query("UPDATE finance.workspace SET revision=revision+1,loan_mode='cashflow',interface_epoch=CASE WHEN $2 THEN interface_epoch ELSE gen_random_uuid() END WHERE user_id=$1 RETURNING generation,revision,key_version,interface_epoch",[userId,intent.keepInterface])).rows[0];
 const cleanup={...impact(current,intent).details,interfaceReset:!intent.keepInterface};
 const result={status:'committed',actionId:id,generation:next.generation,revision:next.revision,keyVersion:next.key_version,interfaceEpoch:next.interface_epoch,cleanup};
 await db.query("UPDATE finance.action SET status='committed',generation=$3,intent=$4,preview=$5,result=$6,undo_patch=NULL,change_set=NULL,affected_operation_ids='{}',committed_at=clock_timestamp(),committed_revision=$7 WHERE user_id=$1 AND id=$2",[userId,id,next.generation,JSON.stringify({canonical:{kind:'reset_financial',receipt:true}}),JSON.stringify(cleanup),JSON.stringify(result),next.revision]);
 return result;
}
