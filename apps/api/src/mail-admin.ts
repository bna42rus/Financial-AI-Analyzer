import type {PoolClient} from 'pg';
import type {FastifyRequest} from 'fastify';
import {fields,string,HttpError} from './types.ts';
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
