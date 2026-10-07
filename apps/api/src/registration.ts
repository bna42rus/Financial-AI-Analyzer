import type { PoolClient } from 'pg';
import type { FastifyRequest } from 'fastify';
import { fields,string,password,HttpError,outbox,event } from './types.ts';
import type { Sealer } from './types.ts';
import { token,digest,hashPassword } from './crypto.ts';

async function invitation(db:PoolClient,secret:string) {
  // Lock purchase before invitation consistently with control reissue/cancel.
  const ref=(await db.query('SELECT purchase_id,manual_grant_id,email FROM commerce.invitation WHERE verifier=$1',[digest(secret)])).rows[0];
  if(!ref)throw new HttpError(400,'INVALID_INVITATION');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['access-email:'+ref.email]);
  const purchase=ref.purchase_id?(await db.query('SELECT * FROM commerce.purchase WHERE id=$1 FOR UPDATE',[ref.purchase_id])).rows[0]:null;
  const grant=ref.manual_grant_id?(await db.query('SELECT id,email,term,quota_policy,state FROM commerce.manual_grant WHERE id=$1 FOR UPDATE',[ref.manual_grant_id])).rows[0]:null;
  const invite=(await db.query(`SELECT id,purchase_id,manual_grant_id,email,state,expires_at FROM commerce.invitation WHERE verifier=$1 AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`,[digest(secret)])).rows[0];
  if(!invite||!((purchase?.state==='paid_not_activated')||(grant?.state==='pending')))throw new HttpError(400,'INVALID_INVITATION');
  return {invite,purchase,grant};
}
export async function requestRegistrationProof(db:PoolClient,request:FastifyRequest,seal:Sealer) {
  const b=fields(request,['invitationToken']);const {invite}=await invitation(db,string(b.invitationToken,100));
  // A new independently random proof goes only to the expected address; never return it via this API.
  // Do not revoke earlier proofs on request: someone with a copied invite must not block its owner.
  const secret=token();
  await db.query(`INSERT INTO access.registration_proof(verifier,invitation_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '15 minutes')`,[digest(secret),invite.id]);
  await outbox(db,'access',seal,'registration_verification',{email:invite.email,proofToken:secret});
  return {status:'accepted'};
}
export async function register(db:PoolClient,request:FastifyRequest,seal:Sealer) {
  const b=fields(request,['invitationToken','proofToken','name','password']);
  const chosen=password(b.password), name=string(b.name,100).trim();
  const {invite,purchase,grant}=await invitation(db,string(b.invitationToken,100));
  const proof=(await db.query(`SELECT verifier,expires_at FROM access.registration_proof WHERE verifier=$1 AND invitation_id=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,[digest(string(b.proofToken,100)),invite.id])).rows[0];
  if(!proof)throw new HttpError(400,'INVALID_REGISTRATION_PROOF');
  if((await db.query('SELECT 1 FROM identity.auth_user WHERE email=$1',[invite.email])).rowCount)throw new HttpError(409,'EXISTING_ACCOUNT');
  const duration=grant?.term??purchase.data.duration,indefinite=duration.kind==='indefinite',fixed=duration.kind==='fixed';
  if(!indefinite&&!fixed&&(!['days','calendar_months'].includes(duration.kind)||!Number.isInteger(duration.count)||duration.count<1||duration.count>36500))throw new HttpError(409,'INVALID_DURATION');
  const quotaPolicy=grant?.quota_policy??{source:'tariff',tariffId:purchase.data.tariff.id,limit:purchase.data.tariff.aiQuota};
  if(!Number.isSafeInteger(quotaPolicy.limit)||quotaPolicy.limit<0)throw new HttpError(409,'QUOTA_REQUIRED');
  const id=crypto.randomUUID(), hash=await hashPassword(chosen);
  // First Development cycle fixes Moscow timezone. The anchor is retained for future renewal/quota boundaries.
  // Month addition happens in local calendar time; PostgreSQL clamps unavailable days to month end.
  const times=(await db.query(`WITH anchor AS (SELECT clock_timestamp() AS start)
    SELECT start,CASE WHEN $1='indefinite' THEN NULL WHEN $1='fixed' THEN $3::timestamptz
      WHEN $1='calendar_months' THEN ((start AT TIME ZONE 'Europe/Moscow')+make_interval(months=>$2)) AT TIME ZONE 'Europe/Moscow'
      ELSE start+($2*interval '24 hours') END AS finish FROM anchor`,[duration.kind,duration.count??0,duration.end??null])).rows[0];
  if(proof.expires_at<=times.start)throw new HttpError(400,'INVALID_REGISTRATION_PROOF');
  if(invite.expires_at<=times.start||fixed&&(!times.finish||times.finish<=times.start))throw new HttpError(400,'INVALID_INVITATION');
  await db.query(`INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,$2,$3,true,$4,$4)`,[id,name,invite.email,times.start]);
  await db.query(`INSERT INTO identity.auth_account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES($1,$2,'credential',$2,$3,$4,$4)`,[crypto.randomUUID(),id,hash,times.start]);
  await db.query(`INSERT INTO identity.security_state(user_id,status,access_end,indefinite) VALUES($1,'active',$2,$3)`,[id,times.finish,indefinite]);
  if(purchase)await db.query(`UPDATE commerce.purchase SET state='active',user_id=$1,activated_at=$2,access_end=$3,timezone='Europe/Moscow' WHERE id=$4`,[id,times.start,times.finish,purchase.id]);
  else await db.query(`UPDATE commerce.manual_grant SET state='active',user_id=$1,activated_at=$2,access_end=$3 WHERE id=$4`,[id,times.start,times.finish,grant.id]);
  await db.query("SELECT set_config('app.user_id',$1,true)",[id]);
  await db.query(`INSERT INTO commerce.access_cycle(user_id,anchor_at,access_end,timezone,calendar_months,extra_days,indefinite,end_offset_ms,quota_policy) VALUES($1,$2,$3,'Europe/Moscow',$4,$5,$6,$7,$8)`,[id,times.start,times.finish,duration.kind==='calendar_months'?duration.count:0,duration.kind==='days'?duration.count:0,indefinite,fixed?times.finish.getTime()-times.start.getTime():0,quotaPolicy]);
  await db.query(`UPDATE commerce.invitation SET state='used',used_at=$1 WHERE id=$2`,[times.start,invite.id]);
  await db.query('UPDATE access.registration_proof SET consumed_at=$1 WHERE invitation_id=$2',[times.start,invite.id]);
  if(purchase){await db.query('DELETE FROM access.application_session WHERE request_id=$1',[purchase.request_id]);
  await db.query('UPDATE access.email_token SET consumed_at=$1 WHERE request_id=$2',[times.start,purchase.request_id]);}
  await event(db,'identity',id,'invitation_registration');
  await outbox(db,'identity',seal,'access_activated',{email:invite.email,activatedAt:times.start,accessEnd:times.finish,indefinite});
  // No implicit login/session. The chosen password must be used for a fresh normal sign-in.
  return {status:'registered',activatedAt:times.start,accessEnd:times.finish};
}
