import type {PoolClient} from 'pg';
import type {FastifyRequest} from 'fastify';
import {fields,string,HttpError,outbox} from './types.ts';
import type {Sealer} from './types.ts';
import {actionId,remember} from './commerce.ts';
const retryKinds=['invitation','payment_claim','renewal_claim','payment_decision','renewal_decision','manual_access_changed'];
export async function mailQueue(db:PoolClient){
 const deliveries=(await db.query(`SELECT id,kind,state,attempts,created_at AS "createdAt",sent_at AS "sentAt",next_attempt_at AS "nextAttemptAt",last_error AS "lastError",acceptance,subject_id AS "subjectId",source_schema AS "sourceSchema" FROM mail.delivery ORDER BY created_at DESC,id LIMIT 100`)).rows;
 return {deliveries:deliveries.map(r=>({...r,canRetry:r.sourceSchema==='access'&&r.state==='failed'&&retryKinds.includes(r.kind)&&!['STALE','DELIVERY_UNKNOWN','INVALID_PAYLOAD'].includes(r.lastError)})),
  audit:(await db.query('SELECT action_id AS "actionId",delivery_id AS "deliveryId",reason,created_at AS "createdAt" FROM mail.resend_audit ORDER BY created_at DESC LIMIT 100')).rows};
}
export async function retryMail(db:PoolClient,request:FastifyRequest,actorId:string){
 const b=fields(request,['actionId','deliveryId','reason']),id=actionId(b.actionId),delivery=actionId(b.deliveryId),reason=string(b.reason,1000).trim();
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['mail-retry:'+delivery]);
 if(await remember(db,id,actorId,{kind:'mail_retry',delivery,reason}))return {status:'already_committed',...await mailQueue(db)};
 if(!(await db.query('SELECT mail.retry_delivery($1::uuid) AS changed',[delivery])).rows[0].changed)throw new HttpError(409,'DELIVERY_UNAVAILABLE');
 await db.query('INSERT INTO mail.resend_audit(action_id,actor_id,delivery_id,reason) VALUES($1,$2,$3,$4)',[id,actorId,delivery,reason]);
 return {status:'queued',...await mailQueue(db)};
}
/** An intentional resend keeps the current invite/token/lifetime and creates a new delivery. */
export async function resendInvitation(db:PoolClient,request:FastifyRequest,actorId:string,seal:Sealer){
 const b=fields(request,['actionId','invitationId','reason']),id=actionId(b.actionId),invitationId=string(b.invitationId,100),reason=string(b.reason,1000).trim();
 const ref=(await db.query('SELECT purchase_id,manual_grant_id,email FROM commerce.invitation WHERE id=$1',[invitationId])).rows[0];
 if(!ref)throw new HttpError(404,'NOT_FOUND');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['access-email:'+ref.email]);
 if(await remember(db,id,actorId,{kind:'invitation_resend',invitationId,reason}))return {status:'already_committed'};
 if(ref.purchase_id)await db.query('SELECT id FROM commerce.purchase WHERE id=$1 FOR UPDATE',[ref.purchase_id]);
 else await db.query('SELECT id FROM commerce.manual_grant WHERE id=$1 FOR UPDATE',[ref.manual_grant_id]);
 const invite=(await db.query(`SELECT i.email,i.sealed_token,i.expires_at FROM commerce.invitation i LEFT JOIN commerce.purchase p ON p.id=i.purchase_id LEFT JOIN commerce.manual_grant g ON g.id=i.manual_grant_id WHERE i.id=$1 AND i.state='active' AND i.expires_at>clock_timestamp() AND (p.state='paid_not_activated' OR g.state='pending' AND (g.term->>'kind'!='fixed' OR (g.term->>'end')::timestamptz>clock_timestamp())) FOR UPDATE OF i`,[invitationId])).rows[0];
 if(!invite)throw new HttpError(409,'INVITATION_UNAVAILABLE');
 if((await db.query("SELECT 1 FROM mail.delivery WHERE kind='invitation' AND subject_id=$1 AND state='queued'",[invitationId])).rowCount)throw new HttpError(409,'DELIVERY_UNAVAILABLE');
 const delivery=await outbox(db,'access',seal,'invitation',{email:invite.email,token:seal.open(invite.sealed_token),expiresAt:invite.expires_at.toISOString()},{subjectId:invitationId,expiresAt:invite.expires_at.toISOString()});
 await db.query('INSERT INTO mail.resend_audit(action_id,actor_id,delivery_id,reason) VALUES($1,$2,$3,$4)',[id,actorId,delivery,reason]);
 return {status:'queued'};
}
