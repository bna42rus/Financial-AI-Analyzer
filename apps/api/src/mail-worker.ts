import {PgBoss} from 'pg-boss';
import type {Pool,PoolClient} from 'pg';
import {digest,envelope} from './crypto.ts';
import {isKmsKey} from './kms.ts';
import type {UnlockedKmsKey} from './kms.ts';
import {outbox} from './types.ts';
import {renderMail} from './mail-templates.ts';
import type {Message,MailOrigins} from './mail-templates.ts';
export type MailProfile='finance'|'control';
export type Transport={idempotent:boolean;deliver:(id:string,message:Message)=>Promise<{acceptance:'sandbox'|'postbox'}>};
export class DeliveryFailure extends Error{constructor(public code:'TEMPORARY'|'REJECTED'|'DELIVERY_UNKNOWN',public retryable=false){super(code);}}
export type WorkerConfig=MailOrigins&{profile:MailProfile;pool:Pool;wrappingKey:Buffer;environment:'development'|'test'|'staging';kmsKey?:UnlockedKmsKey;postbox?:import('./postbox.ts').PostboxConfig};
type Row={id:string;kind:string;sealed_payload:string;subject_id:string|null;expires_at:Date|null;lease_id:string|null;lease_until:Date|null;attempts:number;retry_count:number;source_scope:MailProfile};
type Schema='identity'|'control'|'access';
export async function assertMailRole(config:WorkerConfig){
 if(!['development','test','staging'].includes(config.environment)||config.wrappingKey.length!==32)throw new Error('MAIL_CONFIGURATION_DENIED');
 if(config.environment==='staging'&&!isKmsKey(config.kmsKey,'staging/'+config.profile,config.wrappingKey))throw new Error('MAIL_CONFIGURATION_DENIED');
 if(config.postbox&&config.environment!=='staging')throw new Error('MAIL_CONFIGURATION_DENIED');
 try{
  for(const origin of [config.financeOrigin,config.controlOrigin]){const u=new URL(origin);if(u.origin!==origin||!['http:','https:'].includes(u.protocol))throw new Error();if(config.environment==='staging'&&(u.protocol!=='https:'||!(u.hostname==='test.cashneuro.ru'||u.hostname.endsWith('.test.cashneuro.ru'))))throw new Error();}
  if(config.postbox){if(!config.postbox.recipients.some(r=>r.toLowerCase()===config.adminRecipient.toLowerCase()))throw new Error();}
  else if(!/^[^\s@]+@example\.test$/.test(config.adminRecipient))throw new Error();
 }catch{throw new Error('MAIL_CONFIGURATION_DENIED');}
 const role=(await config.pool.query('SELECT oid,current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
 if(role.name!=='mail_'+config.profile||role.rolsuper||role.rolbypassrls)throw new Error('MAIL_ROLE_DENIED');
 const owned=await config.pool.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (c.relowner=$1 OR n.nspowner=$1) AND n.nspname IN ('identity','control','access','commerce','finance','protected_keys','mail','jobs_mail_finance','jobs_mail_control') LIMIT 1`,[role.oid]);
 if(owned.rowCount)throw new Error('MAIL_ROLE_DENIED');
}
/** Durable synthetic inbox only. It never resolves an address or contacts an external service. */
export function sandboxTransport(config:WorkerConfig):Transport{
 const seal=envelope(config.wrappingKey);
 return {idempotent:true,async deliver(id,message){
  if(!/^[^\s@]+@example\.test$/.test(message.to))throw new DeliveryFailure('REJECTED');
  await config.pool.query(`INSERT INTO mail.sandbox_inbox(id,source_scope,sealed_message) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`,[id,config.profile,seal.seal(JSON.stringify(message))]);
  return {acceptance:'sandbox'};
 }};
}
async function currentMessage(db:PoolClient,schema:Schema,row:Row,p:Record<string,unknown>):Promise<boolean>{
 if(row.expires_at&&row.expires_at<=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now)return false;
 const verifier=(key:string)=>typeof p[key]==='string'?digest(p[key]):'';
 if(row.kind==='application_verification')return Boolean((await db.query(`SELECT 1 FROM access.email_token t JOIN access.request r ON r.id=t.request_id WHERE verifier=$1 AND consumed_at IS NULL AND t.expires_at>clock_timestamp() AND r.data->>'status' NOT IN ('rejected','paid_not_activated') AND ((r.data->>'expiresAt')::timestamptz>clock_timestamp() OR r.data->>'status' IN ('under_review','needs_topup'))`,[verifier('token')])).rowCount);
 if(row.kind==='invitation'||row.kind==='registration_verification'){
  const where=row.kind==='invitation'?'i.verifier=$1':`EXISTS(SELECT 1 FROM access.registration_proof proof WHERE proof.invitation_id=i.id AND proof.verifier=$1 AND proof.consumed_at IS NULL AND proof.expires_at>clock_timestamp())`;
  return Boolean((await db.query(`SELECT 1 FROM commerce.invitation i LEFT JOIN commerce.purchase p ON p.id=i.purchase_id LEFT JOIN commerce.manual_grant g ON g.id=i.manual_grant_id WHERE ${where} AND i.state='active' AND i.expires_at>clock_timestamp() AND (p.state='paid_not_activated' OR g.state='pending' AND (g.term->>'kind'!='fixed' OR (g.term->>'end')::timestamptz>clock_timestamp()))`,[verifier(row.kind==='invitation'?'token':'proofToken')])).rowCount);
 }
 if(row.kind==='password_reset')return Boolean((await db.query(`SELECT 1 FROM ${schema}.reset_token t JOIN ${schema}.security_state s ON s.user_id=t.user_id JOIN ${schema}.auth_user u ON u.id=t.user_id WHERE verifier=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() AND t.epoch=s.epoch AND u.email_verified=true AND u.email=$2`,[verifier('token'),p.email])).rowCount);
 if(['access_reminder','access_expired'].includes(row.kind)){
  const r=(await db.query(`SELECT c.access_end,c.indefinite,u.email,u.email_verified,clock_timestamp() AS now FROM commerce.access_cycle c JOIN identity.auth_user u ON u.id=c.user_id WHERE c.user_id=$1`,[row.subject_id])).rows[0];
  if(!r||r.indefinite||!r.email_verified||r.email!==p.email||r.access_end?.toISOString()!==p.accessEnd)return false;
  const day=(d:Date)=>Date.parse(new Date(d.getTime()+10800000).toISOString().slice(0,10));
  return row.kind==='access_expired'?r.access_end<=r.now:r.access_end>r.now&&String((day(r.access_end)-day(r.now))/86400000)===p.stage;
 }
 return true;
}
/** Claims commit before dispatch; crashes are never silently labelled sent. */
async function claim(config:WorkerConfig,schema:Schema,transport:Transport){
 const db=await config.pool.connect(),seal=envelope(config.wrappingKey);
 try{
  await db.query('BEGIN');
  const row=(await db.query(`SELECT * FROM ${schema}.outbox WHERE state='queued' AND source_scope=$1 AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[config.profile])).rows[0] as Row|undefined;
  if(!row){await db.query('COMMIT');return null;}
  let error:string|null=null,p:Record<string,unknown>={},message:Message|undefined;
  if(row.lease_id&&!transport.idempotent)error='DELIVERY_UNKNOWN';
  else try{
   p=JSON.parse(seal.open(row.sealed_payload));
   if(!p||typeof p!=='object'||Array.isArray(p))throw new Error();
   if(!await currentMessage(db,schema,row,p))error='STALE';
   else message=renderMail(row.kind,p,config,(await db.query('SELECT created_at FROM '+schema+'.outbox WHERE id=$1',[row.id])).rows[0].created_at.toISOString());
  }catch{error='INVALID_PAYLOAD';}
  if(row.retry_count>=5)error??='ATTEMPTS_EXHAUSTED';
  if(error){await db.query(`UPDATE ${schema}.outbox SET state='failed',last_error=$2,lease_id=NULL,lease_until=NULL WHERE id=$1`,[row.id,error]);await db.query('COMMIT');return {suppressed:true} as const;}
  const lease=crypto.randomUUID();
  await db.query(`UPDATE ${schema}.outbox SET attempts=attempts+1,retry_count=retry_count+1,lease_id=$2,lease_until=clock_timestamp()+interval '30 seconds',last_error=NULL WHERE id=$1`,[row.id,lease]);
  await db.query('COMMIT');return {id:row.id,lease,message:message!,retryCount:row.retry_count+1} as const;
 }catch{await db.query('ROLLBACK');throw new Error('MAIL_CLAIM_FAILED');}finally{db.release();}
}
export async function deliverBatch(config:WorkerConfig,transport:Transport,limit=20){
 await assertMailRole(config);
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('INVALID_BATCH');
 let processed=0;
 for(const schema of [config.profile==='finance'?'identity':'control','access'] as Schema[]){
  while(processed<limit){
   const row=await claim(config,schema,transport);if(!row)break;processed++;
   if('suppressed' in row)continue;
   try{
    const result=await transport.deliver(row.id,row.message);
    if(result.acceptance!==(config.postbox?'postbox':'sandbox'))throw new DeliveryFailure('DELIVERY_UNKNOWN');
    await config.pool.query(`UPDATE ${schema}.outbox SET state='sent',sent_at=clock_timestamp(),acceptance=$3,last_error=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND state='queued'`,[row.id,row.lease,result.acceptance]);
   }catch(error){
    const known=error instanceof DeliveryFailure,code=known?error.code:'DELIVERY_UNKNOWN',retry=known&&error.retryable&&code==='TEMPORARY'&&row.retryCount<5;
    await config.pool.query(`UPDATE ${schema}.outbox SET state=$3,last_error=$4,lease_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+($5*interval '1 second') WHERE id=$1 AND lease_id=$2 AND state='queued'`,[row.id,row.lease,retry?'queued':'failed',code,Math.min(240,15*2**(row.retryCount-1))]);
   }
  }
 }
 return {processed};
}
export async function enqueueReminders(config:WorkerConfig){
 await assertMailRole(config);if(config.profile!=='finance')return {queued:0};
 const db=await config.pool.connect(),seal=envelope(config.wrappingKey);let queued=0;
 try{
  await db.query('BEGIN');
  const rows=(await db.query(`SELECT c.user_id,c.access_end,u.email,clock_timestamp() AS now FROM commerce.access_cycle c JOIN identity.auth_user u ON u.id=c.user_id WHERE c.indefinite=false AND c.access_end IS NOT NULL AND u.email_verified=true ORDER BY c.user_id`)).rows;
  for(const r of rows){
   const end=r.access_end.toISOString(),days=(Date.parse(new Date(r.access_end.getTime()+10800000).toISOString().slice(0,10))-Date.parse(new Date(r.now.getTime()+10800000).toISOString().slice(0,10)))/86400000;
   const stage=r.access_end<=r.now?'expired':[7,1].includes(days)?String(days):null;if(!stage)continue;
   await outbox(db,'identity',seal,stage==='expired'?'access_expired':'access_reminder',{email:r.email,accessEnd:end,stage},{subjectId:r.user_id,dedupeKey:'reminder:'+r.user_id+':'+end+':'+stage});queued++;
  }
  await db.query('COMMIT');return {queued};
 }catch{await db.query('ROLLBACK');throw new Error('REMINDER_QUEUE_FAILED');}finally{db.release();}
}
export async function startMailWorker(config:WorkerConfig){
 await assertMailRole(config);
 const boss=new PgBoss({schema:'jobs_mail_'+config.profile,db:{executeSql:(sql,values)=>config.pool.query(sql,values)},migrate:false,schedule:false,registerInstance:false,reindex:false});
 boss.on('error',()=>{process.stderr.write('Mail job failed.\n');});
 await boss.start();
 const transport=config.postbox?(await import('./postbox.ts')).postboxTransport(config.postbox):sandboxTransport(config);
 await boss.work('mail-tick',{batchSize:1,pollingIntervalSeconds:1},async()=>{await enqueueReminders(config);await deliverBatch(config,transport);});
 let pending=false;
 const dispatch=async()=>{if(pending)return;pending=true;try{await boss.send('mail-tick',{}, {singletonKey:'tick'});}finally{pending=false;}};
 await dispatch();
 const timer=setInterval(()=>{void dispatch().catch(()=>process.stderr.write('Mail dispatch failed.\n'));},15000);
 return {boss,async stop(){clearInterval(timer);await boss.stop({graceful:true,timeout:10000});}};
}
