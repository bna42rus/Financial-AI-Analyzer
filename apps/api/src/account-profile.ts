import {reserveMailRequest} from './mail-cooldown.ts';
import type {PoolClient} from 'pg';
import {digest,token,verifyPassword} from './crypto.ts';
import {email,event,HttpError,outbox,string} from './types.ts';
import type {Sealer} from './types.ts';
import {safeText} from '../../../packages/privacy/src/text.ts';

type Owner={id:string;email:string;sessionId:string};
export async function saveAccountName(db:PoolClient,id:string,value:unknown){
 const name=safeText(string(value,100),100).trim();if(!name)throw new HttpError(400,'INVALID_INPUT');
 await db.query('UPDATE identity.auth_user SET name=$2,updated_at=clock_timestamp() WHERE id=$1',[id,name]);return {name};
}
export async function accountEmail(db:PoolClient,owner:Owner,input:Record<string,unknown>,seal:Sealer){
 const key='profile-email:'+owner.id,epoch=(await db.query('SELECT epoch FROM identity.security_state WHERE user_id=$1 FOR UPDATE',[owner.id])).rows[0]?.epoch;
 if(epoch===undefined)throw new HttpError(401,'AUTH_REQUIRED');
 if('code' in input){
  const code=string(input.code,100).trim();
  const record=(await db.query('SELECT value FROM identity.auth_verification WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE',[key])).rows[0];
  if(!record)throw new HttpError(400,'INVALID_TOKEN');
  const pending=JSON.parse(seal.open(record.value)) as {verifier:string;email:string;oldEmail:string;session:string;epoch:number};
  if(pending.oldEmail!==owner.email||pending.session!==owner.sessionId||pending.epoch!==epoch||pending.verifier!==digest(code))throw new HttpError(400,'INVALID_TOKEN');
  if((await db.query('SELECT id FROM identity.auth_user WHERE email=$1',[pending.email])).rowCount)throw new HttpError(409,'EMAIL_UNAVAILABLE');
  await db.query('UPDATE identity.auth_user SET email=$2,updated_at=clock_timestamp() WHERE id=$1',[owner.id,pending.email]);
  await db.query('UPDATE identity.security_state SET epoch=epoch+1 WHERE user_id=$1',[owner.id]);
  await db.query('DELETE FROM identity.auth_session WHERE user_id=$1 AND id<>$2',[owner.id,owner.sessionId]);
  await db.query('DELETE FROM identity.reset_token WHERE user_id=$1',[owner.id]);
  await db.query('DELETE FROM identity.auth_verification WHERE id=$1',[key]);
  await event(db,'identity',owner.id,'profile_email_changed');
  await outbox(db,'identity',seal,'profile_email_changed',{email:owner.email},{subjectId:owner.id});
  return {status:'confirmed'};
 }
 const address=email(input.email),secret=string(input.password,128);
 const credential=(await db.query("SELECT password FROM identity.auth_account WHERE user_id=$1 AND provider_id='credential'",[owner.id])).rows[0]?.password;
 if(!credential||!await verifyPassword(secret,credential))throw new HttpError(401,'INVALID_CREDENTIALS');
 if(address===owner.email||(await db.query('SELECT id FROM identity.auth_user WHERE email=$1',[address])).rowCount)throw new HttpError(409,'EMAIL_UNAVAILABLE');
 const retryAfterSeconds=await reserveMailRequest(db,seal,'finance','email-change',address,owner.id);
 const code=token();
 const {expires_at}= (await db.query(`INSERT INTO identity.auth_verification(id,identifier,value,expires_at,created_at,updated_at)
  VALUES($1,$1,$2,clock_timestamp()+interval '15 minutes',clock_timestamp(),clock_timestamp())
  ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at RETURNING expires_at`,[key,seal.seal(JSON.stringify({verifier:digest(code),email:address,oldEmail:owner.email,session:owner.sessionId,epoch}))])).rows[0];
 await outbox(db,'identity',seal,'profile_email_verification',{email:address,code},{subjectId:owner.id,expiresAt:expires_at.toISOString()});
 return {status:'sent',retryAfterSeconds};
}
