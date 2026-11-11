import {randomInt,randomUUID,timingSafeEqual} from 'node:crypto';
import type {PoolClient} from 'pg';
import {email,password,string,HttpError,outbox} from './types.ts';
import type {Sealer} from './types.ts';
import {hashPassword,digest} from './crypto.ts';
import {reserveMailRequest} from './mail-cooldown.ts';
import {checkLegalVersion,recordLegal} from './launch-legal.ts';
import {legalDocuments} from '../../../packages/access/src/legal.ts';
export async function signupStart(db:PoolClient,b:Record<string,unknown>,seal:Sealer){
 const address=email(b.email),chosen=password(b.password),name=string(b.name,100).trim();
 if(chosen!==b.confirmPassword)throw new HttpError(400,'PASSWORD_MISMATCH');
 checkLegalVersion(b.termsVersion,legalDocuments.terms.version,true);
 checkLegalVersion(b.consentVersion,legalDocuments.consent.version,true);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['access-email:'+address]);
 if((await db.query('SELECT 1 FROM identity.auth_user WHERE email=$1',[address])).rowCount)throw new HttpError(409,'EXISTING_ACCOUNT');
 if((await db.query("SELECT 1 FROM commerce.invitation WHERE email=$1 AND state='active' AND expires_at>clock_timestamp()",[address])).rowCount)throw new HttpError(409,'USE_EXISTING_INVITATION');
 const retryAfterSeconds=await reserveMailRequest(db,seal,'finance','registration',address);
 const id=randomUUID(),code=String(randomInt(0,1000000)).padStart(6,'0');
 await db.query('DELETE FROM identity.signup_pending WHERE expires_at<clock_timestamp()');
 await db.query("INSERT INTO identity.signup_pending(id,email,name,password_hash,code_hash,terms_version,consent_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '15 minutes')",[id,address,name,await hashPassword(chosen),digest(id+':'+code),b.termsVersion,b.consentVersion]);
 await outbox(db,'identity',seal,'signup_code',{email:address,code},{subjectId:id,expiresAt:new Date(Date.now()+900000).toISOString()});
 return {id,retryAfterSeconds};
}
export async function signupComplete(db:PoolClient,b:Record<string,unknown>){
 const id=string(b.id,36),code=string(b.code,6);
 const p=(await db.query('SELECT * FROM identity.signup_pending WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE',[id])).rows[0];
 // Return errors so the route commits failed-attempt counters instead of rolling them back.
 if(!p||p.attempts>=5||!/^\d{6}$/.test(code))return {code:'INVALID_SIGNUP_CODE'};
 if(!timingSafeEqual(Buffer.from(p.code_hash),Buffer.from(digest(id+':'+code)))){
  await db.query('UPDATE identity.signup_pending SET attempts=attempts+1 WHERE id=$1',[id]);return {code:'INVALID_SIGNUP_CODE'};
 }
 if(p.registered_user_id)return {status:'registered'};
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['access-email:'+p.email]);
 if((await db.query('SELECT 1 FROM identity.auth_user WHERE email=$1',[p.email])).rowCount)throw new HttpError(409,'EXISTING_ACCOUNT');
 const user=randomUUID();
 await db.query('INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,$2,$3,true,clock_timestamp(),clock_timestamp())',[user,p.name,p.email]);
 await db.query("INSERT INTO identity.auth_account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES($1,$2,'credential',$2,$3,clock_timestamp(),clock_timestamp())",[randomUUID(),user,p.password_hash]);
 await db.query("INSERT INTO identity.security_state(user_id,status,access_end,indefinite) VALUES($1,'active',clock_timestamp(),false)",[user]);
 await db.query("SELECT set_config('app.user_id',$1,true)",[user]);
 await db.query("INSERT INTO commerce.access_cycle(user_id,anchor_at,access_end,timezone,calendar_months,extra_days,indefinite,end_offset_ms,quota_policy) VALUES($1,clock_timestamp()-interval '1 second',clock_timestamp(),'Europe/Moscow',0,0,false,0,'{\"source\":\"override\",\"limit\":0}')",[user]);
 await db.query('INSERT INTO commerce.onboarding_account(user_id) VALUES($1)',[user]);
 await recordLegal(db,user,'terms',p.terms_version);await recordLegal(db,user,'privacy_notice',legalDocuments.privacy.version);
 await db.query("UPDATE identity.signup_pending SET registered_user_id=$2,password_hash='' WHERE id=$1",[id,user]);
 return {status:'registered'};
}
