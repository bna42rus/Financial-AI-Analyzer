import type {PoolClient} from 'pg';
import {object,choice,uuid} from '../../../packages/finance-core/src/model.ts';
import {prepareFinance,financeView} from './finance.ts';
import {selectionIds} from './finance-bulk.ts';
import {HttpError} from './types.ts';
type SessionRow={id:string;generation:string;operation_ids:string[];cursor:number;decisions:Record<string,string>;status:'created'|'in_progress'|'paused'|'completed'|'abandoned';revision:string};
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const publicSession=(s:SessionRow)=>({id:s.id,generation:s.generation,operationIds:s.operation_ids,cursor:s.cursor,decisions:s.decisions,status:s.status,revision:String(s.revision)});
async function session(db:PoolClient,userId:string,id:string){const s=(await db.query<SessionRow>('SELECT * FROM finance.review_session WHERE user_id=$1 AND id=$2 FOR UPDATE',[userId,id])).rows[0];if(!s)throw new HttpError(404,'NOT_FOUND');return s;}
async function save(db:PoolClient,userId:string,s:SessionRow){const r=await db.query<SessionRow>('UPDATE finance.review_session SET cursor=$3,decisions=$4,status=$5,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2 RETURNING *',[userId,s.id,s.cursor,JSON.stringify(s.decisions),s.status]);return r.rows[0]!;}
function advance(s:SessionRow,operations:Awaited<ReturnType<typeof financeView>>['operations']){
 const byId=new Map(operations.map(o=>[o.id,o]));let changed=false;
 while(s.cursor<s.operation_ids.length){const id=s.operation_ids[s.cursor]!,op=byId.get(id);if(op?.reviewReasons.length)break;s.decisions[id]=op?'resolved_elsewhere':'unavailable';s.cursor++;changed=true;}
 if(s.cursor===s.operation_ids.length&&s.status!=='abandoned'&&s.status!=='completed'){s.status='completed';changed=true;}
 return changed;
}
export async function reviewSessions(db:PoolClient,userId:string,input:unknown){
 object(input,[]);const state=await prepareFinance(db,userId),view=await financeView(db,userId),rows=(await db.query<SessionRow>('SELECT * FROM finance.review_session WHERE user_id=$1 AND generation=$2 ORDER BY updated_at DESC LIMIT 20 FOR UPDATE',[userId,state.generation])).rows;
 const sessions=[];for(let s of rows){if(['created','in_progress','paused'].includes(s.status)&&advance(s,view.operations))s=await save(db,userId,s);sessions.push(publicSession(s));}return {generation:state.generation,sessions};
}
export async function reviewCommand(db:PoolClient,userId:string,input:unknown){
 const r=object(input,['commandId','sessionId','generation','revision','kind','operationIds','financeRevision']),commandId=uuid(r.commandId),id=uuid(r.sessionId),generation=uuid(r.generation),kind=choice(r.kind,['create','resume','pause','skip','unknown','back','abandon']),state=await prepareFinance(db,userId);
 if(state.generation!==generation)throw new HttpError(409,'GENERATION_CHANGED');
 const previous=(await db.query('SELECT request,result FROM finance.review_command WHERE user_id=$1 AND id=$2',[userId,commandId])).rows[0];
 if(previous){if(stable(previous.request)!==stable(r))throw new HttpError(409,'ACTION_REUSED');return previous.result;}
 const view=await financeView(db,userId);let s:SessionRow;
 if(kind==='create'){
  object(input,['commandId','sessionId','generation','kind','operationIds','financeRevision']);if(r.financeRevision!==state.revision)throw new HttpError(409,'FINANCE_CHANGED');const ids=selectionIds(r.operationIds),byId=new Map(view.operations.map(o=>[o.id,o]));
  for(const opId of ids){if(!byId.has(opId))throw new HttpError(404,'NOT_FOUND');if(!byId.get(opId)!.reviewReasons.length)throw new HttpError(409,'REVIEW_SCOPE_CHANGED');}
  if((await db.query("SELECT count(*)::int AS n FROM finance.review_session WHERE user_id=$1 AND status IN ('created','in_progress','paused')",[userId])).rows[0].n>=20)throw new HttpError(409,'REVIEW_SESSION_LIMIT');
  if((await db.query('SELECT 1 FROM finance.review_session WHERE user_id=$1 AND id=$2',[userId,id])).rowCount)throw new HttpError(409,'ACTION_REUSED');s=(await db.query<SessionRow>('INSERT INTO finance.review_session(user_id,id,generation,operation_ids) VALUES($1,$2,$3,$4) RETURNING *',[userId,id,generation,ids ])).rows[0]!;s.status='in_progress';
 }else{
  object(input,['commandId','sessionId','generation','revision','kind']);s=await session(db,userId,id);if(s.generation!==generation)throw new HttpError(409,'GENERATION_CHANGED');if(String(s.revision)!==r.revision)throw new HttpError(409,'REVIEW_CHANGED');
  if(s.status==='abandoned'||s.status==='completed'&&kind!=='back')throw new HttpError(409,'REVIEW_COMPLETED');
  if(kind==='resume')s.status='in_progress';else if(kind==='pause')s.status='paused';else if(kind==='abandon')s.status='abandoned';
  else if(kind==='back'){s.cursor=Math.max(0,s.cursor-1);s.status='in_progress';}
  else {if(s.cursor>=s.operation_ids.length)throw new HttpError(409,'REVIEW_COMPLETED');s.decisions[s.operation_ids[s.cursor]!]=kind==='unknown'?'unknown':'skipped';s.cursor++;s.status='in_progress';}
 }
 if(s.status!=='abandoned')advance(s,view.operations);s=await save(db,userId,s);const result=publicSession(s);
 await db.query('INSERT INTO finance.review_command(user_id,id,session_id,request,result) VALUES($1,$2,$3,$4,$5)',[userId,commandId,id,JSON.stringify(r),JSON.stringify(result)]);return result;
}
