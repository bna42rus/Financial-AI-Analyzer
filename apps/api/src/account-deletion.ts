import {randomInt,timingSafeEqual} from 'node:crypto';
import type {PoolClient} from 'pg';
import {verifyPassword} from './crypto.ts';
import {email,HttpError,outbox,string} from './types.ts';
import type {Sealer} from './types.ts';
import {reserveMailRequest} from './mail-cooldown.ts';
import {actionId} from './commerce.ts';

type Owner={id:string;email:string};
type RequestRow={id:string;status:'awaiting_code'|'pending';epoch:number;verifier:string|null;expires_at:Date|null;requested_at:Date|null};
const fingerprint=(seal:Sealer,owner:Owner,id:string,code:string)=>seal.rateKey('account-erasure/v1/'+owner.id+'/'+id+'/'+code);

export async function accountDeletion(db:PoolClient,owner:Owner,step:'status'|'start'|'confirm'|'cancel',input:Record<string,unknown>,seal:Sealer){
 const state=(await db.query('SELECT epoch FROM identity.security_state WHERE user_id=$1 FOR UPDATE',[owner.id])).rows[0];
 if(!state)throw new HttpError(401,'AUTH_REQUIRED');
 const row=(await db.query<RequestRow>('SELECT * FROM identity.account_deletion WHERE user_id=$1 FOR UPDATE',[owner.id])).rows[0];
 const current=row?.epoch===state.epoch?row:undefined;
 const publicStatus=()=>{
  if(!current)return {status:'none'};
  if(current.status==='pending')return {status:'pending',requestedAt:current.requested_at};
  if(current.expires_at&&current.expires_at.getTime()>Date.now())return {status:'awaiting_code',expiresAt:current.expires_at};
  return {status:'none'};
 };
 if(step==='status')return publicStatus();
 if(step==='cancel'){
  if(current?.status==='pending')await db.query('SELECT commerce.record_deletion_withdrawal($1)',[current.id]);
  await db.query('DELETE FROM identity.account_deletion WHERE user_id=$1',[owner.id]);
  return {status:'none'};
 }
 if(step==='start'){
  if(current?.status==='pending')return publicStatus();
  if(input.confirm!==true)throw new HttpError(400,'INVALID_INPUT');
  const password=string(input.password,128);
  const credential=(await db.query("SELECT password FROM identity.auth_account WHERE user_id=$1 AND provider_id='credential'",[owner.id])).rows[0]?.password;
  if(!credential||!await verifyPassword(password,credential))throw new HttpError(401,'INVALID_CREDENTIALS');
  const retryAfterSeconds=await reserveMailRequest(db,seal,'finance','account-deletion',owner.email,owner.id);
  const id=crypto.randomUUID(),code=String(randomInt(1000000)).padStart(6,'0');
  const {expires_at}= (await db.query<{expires_at:Date}>(`INSERT INTO identity.account_deletion(id,user_id,status,epoch,verifier,expires_at)
   VALUES($1,$2,'awaiting_code',$3,$4,clock_timestamp()+interval '15 minutes')
   ON CONFLICT(user_id) DO UPDATE SET id=EXCLUDED.id,status=EXCLUDED.status,epoch=EXCLUDED.epoch,verifier=EXCLUDED.verifier,
    expires_at=EXCLUDED.expires_at,requested_at=NULL RETURNING expires_at`,[id,owner.id,state.epoch,fingerprint(seal,owner,id,code)])).rows[0]!;
  await outbox(db,'identity',seal,'account_deletion_code',{email:owner.email,code,requestId:id},{subjectId:owner.id,expiresAt:expires_at.toISOString()});
  return {status:'awaiting_code',expiresAt:expires_at,retryAfterSeconds};
 }
 if(current?.status==='pending')return publicStatus();
 const code=string(input.code,6);
 if(!current?.verifier||!current.expires_at||current.expires_at.getTime()<=Date.now()||!/^\d{6}$/.test(code)
  ||!timingSafeEqual(Buffer.from(current.verifier),Buffer.from(fingerprint(seal,owner,current.id,code))))throw new HttpError(400,'DELETION_CODE_INVALID');
 const {requested_at}=(await db.query<{requested_at:Date}>(`UPDATE identity.account_deletion SET status='pending',requested_at=clock_timestamp(),expires_at=NULL,verifier=NULL
  WHERE id=$1 RETURNING requested_at`,[current.id])).rows[0]!;
 await outbox(db,'identity',seal,'account_deletion_received',{email:owner.email,requestId:current.id},{subjectId:owner.id,dedupeKey:'deletion-received:'+current.id});
 return {status:'pending',requestedAt:requested_at};
}

export async function deletionQueue(db:PoolClient){
 return {requests:(await db.query('SELECT id,email,requested_at AS "requestedAt" FROM commerce.control_deletion_queue()')).rows};
}

export async function deletionPreview(db:PoolClient,body:Record<string,unknown>){
 const row=(await db.query('SELECT * FROM commerce.control_deletion_preview($1)',[actionId(body.id)])).rows[0];
 if(!row)throw new HttpError(409,'DELETION_NOT_PENDING');
 return {operations:Number(row.operations),imports:Number(row.imports),dialogs:Number(row.dialogs)};
}

export async function finishAccountDeletion(db:PoolClient,actor:string,body:Record<string,unknown>,seal:Sealer){
 const id=actionId(body.id),row=(await db.query('SELECT email FROM commerce.control_deletion_queue() WHERE id=$1',[id])).rows[0];
 const address=body.email===undefined?row?.email:email(body.email);if(!address)throw new HttpError(409,'DELETION_NOT_PENDING');
 const {status}=(await db.query<{status:string}>('SELECT commerce.finish_account_deletion($1,$2,$3) AS status',[id,actor,address])).rows[0]!;
 if(status==='already_completed')return {status:'completed'};
 if(status!=='completed')throw new HttpError(409,status);
 await outbox(db,'access',seal,'account_deletion_completed',{email:address,requestId:id},{expiresAt:new Date(Date.now()+86400000).toISOString(),dedupeKey:'deletion-completed:'+id});
 return {status};
}
