import type {PoolClient} from 'pg';
import type {AssistantProvider} from './analyzer-assistant-provider.ts';
import {object,uuid} from '../../../packages/finance-core/src/model.ts';
import {nextCheckpointVersion} from './analyzer-next-checkpoint.ts';
import {nextStoreVersion} from './analyzer-next-store.ts';
import {HttpError} from './types.ts';

/** Server selection for Staging; normal access and per-user quota checks remain. */
export function nextTestEmails(raw:unknown):readonly string[]|undefined{
 if(raw===undefined)return undefined;
 if(!Array.isArray(raw)||raw.length!==1||typeof raw[0]!=='string'||raw[0]!==raw[0].toLowerCase()||!/^[^\s@]{1,100}@[^\s@]{1,150}\.[^\s@]{1,50}$/.test(raw[0]))throw Error('ANALYZER_NEXT_CONFIGURATION_DENIED');
 return Object.freeze([...raw]);
}
export function nextEmailSetting(raw:string|undefined){return raw===undefined?undefined:nextTestEmails(raw.split(','));}
export function nextAllSetting(raw:string|undefined){if(raw===undefined||raw==='0')return false;if(raw==='1')return true;throw Error('ANALYZER_NEXT_CONFIGURATION_DENIED');}
export function validateNextConfiguration(emails:unknown,profile:string,environment:string,provider:AssistantProvider|undefined,all:unknown=false){
 const allowed=nextTestEmails(emails);
 if(typeof all!=='boolean'||all&&(profile!=='finance'||!['test','staging'].includes(environment)||!provider))throw Error('ANALYZER_NEXT_CONFIGURATION_DENIED');
 if(allowed&&(profile!=='finance'||!['test','staging'].includes(environment)||!provider||allowed.some(email=>!provider.allowed(email))))throw Error('ANALYZER_NEXT_CONFIGURATION_DENIED');
 return allowed??(all?Object.freeze([]):undefined);
}
export function nextAccountEnabled(email:string,emails:readonly string[]|undefined,all:boolean){return all||!!emails?.includes(email.toLowerCase());}
/** Preserve the protocol of existing work/history even after enabling the new
 * slice. A disabled signed chat cannot be sent through the legacy parser. */
export async function nextRequestRoute(db:PoolClient,userId:string,value:unknown,enabled:boolean){
 const b=object(value,['id','chatId','chatEpoch','generation','globalRevision','text']);
 const id=uuid(b.id),chatId=uuid(b.chatId);
 const row=(await db.query('SELECT request FROM finance.analyzer_task_request WHERE user_id=$1 AND id=$2',[userId,id])).rows[0];
 const checkpoint=(await db.query('SELECT conversation FROM finance.assistant_conversation WHERE user_id=$1 AND chat_id=$2',[userId,chatId])).rows[0];
 const isNext=row?row.request?.version===nextStoreVersion:checkpoint?checkpoint.conversation?.version===nextCheckpointVersion:
  !(await db.query('SELECT 1 FROM finance.analyzer_message WHERE user_id=$1 AND chat_id=$2 LIMIT 1',[userId,chatId])).rowCount&&enabled;
 if(isNext&&!enabled)throw new HttpError(409,'AI_CHAT_PROTOCOL_CHANGED');
 return isNext;
}
