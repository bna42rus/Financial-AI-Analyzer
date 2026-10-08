import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {postgresFixture} from './postgres.ts';
import {envelope,token,digest} from '../src/crypto.ts';
import {outbox} from '../src/types.ts';
import {deliverBatch,enqueueReminders,sandboxTransport,assertMailRole,startMailWorker,DeliveryFailure} from '../src/mail-worker.ts';
import type {WorkerConfig,Transport} from '../src/mail-worker.ts';
let pg:Awaited<ReturnType<typeof postgresFixture>>,fc:WorkerConfig,cc:WorkerConfig;
const origins={financeOrigin:'https://app.example.test',controlOrigin:'https://admin.example.test',adminRecipient:'owner@example.test'};
before(async()=>{pg=await postgresFixture();fc={...origins,profile:'finance',pool:pg.mailFinance,wrappingKey:randomBytes(32),environment:'test'};cc={...origins,profile:'control',pool:pg.mailControl,wrappingKey:randomBytes(32),environment:'test'};});
after(async()=>{await pg?.close();});
beforeEach(async()=>{await pg.owner.query('TRUNCATE identity.outbox,control.outbox,access.outbox,mail.delivery,mail.resend_audit,mail.sandbox_inbox,identity.auth_user,control.auth_user,access.request,commerce.manual_grant,commerce.action CASCADE');});
async function queue(kind='security_password_changed',payload:Record<string,unknown>={email:'user@example.test'},schema:'identity'|'control'|'access'='identity',config=fc,subjectId?:string){
 await outbox(pg.owner,schema,envelope(config.wrappingKey),kind,payload,{subjectId});return (await pg.owner.query('SELECT id FROM '+schema+'.outbox ORDER BY created_at DESC LIMIT 1')).rows[0].id as string;
}
async function state(id:string){return (await pg.owner.query('SELECT * FROM mail.delivery WHERE id=$1',[id])).rows[0];}
async function invite(){
 const id=crypto.randomUUID(),grant=crypto.randomUUID(),secret=token();
 await pg.owner.query(`INSERT INTO commerce.manual_grant(id,email,term,access_type,quota_policy,reason,creator,created_at,state) VALUES($1,'user@example.test','{"kind":"days","count":30}','Test','{"source":"override","limit":10}','Synthetic','owner',clock_timestamp(),'pending')`,[grant]);
 await pg.owner.query(`INSERT INTO commerce.invitation(id,manual_grant_id,email,verifier,sealed_token,expires_at,state,created_at) VALUES($1,$2,'user@example.test',$3,$4,clock_timestamp()+interval '72 hours','active',clock_timestamp())`,[id,grant,digest(secret),envelope(cc.wrappingKey).seal(secret)]);
 const expiry=(await pg.owner.query('SELECT expires_at FROM commerce.invitation WHERE id=$1',[id])).rows[0].expires_at.toISOString();
 return {id,secret,delivery:await queue('invitation',{email:'user@example.test',token:secret,expiresAt:expiry},'access',cc,id)};
}
test('mail roles have no passwords/sessions/financial/keys, API cannot read encrypted mail or inbox',async()=>{
 for(const pool of [pg.mailFinance,pg.mailControl])for(const sql of ['SELECT * FROM identity.auth_account','SELECT * FROM control.auth_account','SELECT * FROM identity.auth_session','SELECT * FROM finance.isolation_canary','SELECT * FROM protected_keys.isolation_canary'])await assert.rejects(pool.query(sql),{code:'42501'});
 for(const pool of [pg.finance,pg.control])for(const sql of ['SELECT * FROM mail.sandbox_inbox','SELECT mail.project_delivery()'])await assert.rejects(pool.query(sql),{code:'42501'});
 await assert.rejects(assertMailRole({...fc,pool:pg.owner}),/MAIL_ROLE_DENIED/);
 await assert.rejects(assertMailRole({...fc,pool:pg.finance}),/MAIL_ROLE_DENIED/);
 await assert.rejects(assertMailRole({...fc,financeOrigin:''}),/MAIL_CONFIGURATION_DENIED/);
 await assert.rejects(assertMailRole({...fc,adminRecipient:'real@real.example'}),/MAIL_CONFIGURATION_DENIED/);
});
test('delivery reaches encrypted durable sandbox; sent is acceptance and metadata has no secrets',async()=>{
 const id=await queue();assert.equal((await state(id)).state,'queued');await deliverBatch(fc,sandboxTransport(fc));
 const row=await state(id);assert.equal(row.state,'sent');assert.equal(row.acceptance,'sandbox');assert.equal(row.attempts,1);assert.ok(row.sent_at);
 const stored=(await pg.owner.query('SELECT sealed_message FROM mail.sandbox_inbox WHERE id=$1',[id])).rows[0].sealed_message;assert.ok(!stored.includes('user@example.test'));
 assert.match(JSON.parse(envelope(fc.wrappingKey).open(stored)).text,/Старые сессии/);assert.ok(!JSON.stringify(row).includes('user@example.test'));await deliverBatch(fc,sandboxTransport(fc));assert.equal((await state(id)).attempts,1);
});
test('finance/control queues and wrapping keys stay independent',async()=>{
 const f=await queue(),c=await queue('security_admin_recovery',{email:'owner@example.test'},'control',cc),i=await invite();
 await deliverBatch(fc,sandboxTransport(fc));assert.equal((await state(f)).state,'sent');assert.equal((await state(c)).state,'queued');assert.equal((await state(i.delivery)).state,'queued');
 assert.equal((await pg.mailFinance.query('SELECT 1 FROM access.outbox')).rowCount,0);
 await deliverBatch(cc,sandboxTransport(cc));assert.equal((await state(c)).state,'sent');assert.equal((await state(i.delivery)).state,'sent');
 await assert.rejects(pg.mailControl.query('SELECT * FROM identity.outbox'),{code:'42501'});
});
test('temporary failures back off and recover without duplicate acceptance',async()=>{
 const id=await queue(),base=sandboxTransport(fc);let calls=0;
 const transport:Transport={idempotent:true,deliver:async(i,m)=>{if(++calls===1)throw new DeliveryFailure('TEMPORARY',true);return base.deliver(i,m);}};
 await deliverBatch(fc,transport);const first=await state(id);assert.equal(first.state,'queued');assert.equal(first.last_error,'TEMPORARY');assert.equal(first.attempts,1);
 await deliverBatch(fc,transport);assert.equal(calls,1);
 await pg.owner.query("UPDATE identity.outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);await deliverBatch(fc,transport);assert.equal((await state(id)).state,'sent');assert.equal(calls,2);assert.equal((await pg.owner.query('SELECT 1 FROM mail.sandbox_inbox')).rowCount,1);
});
test('five failures stop; safe audited retry keeps cumulative attempts and hides invite token',async()=>{
 const i=await invite(),failure:Transport={idempotent:true,deliver:async()=>{throw new DeliveryFailure('TEMPORARY',true);}};
 for(let n=0;n<5;n++){await pg.owner.query('UPDATE access.outbox SET next_attempt_at=clock_timestamp() WHERE id=$1',[i.delivery]);await deliverBatch(cc,failure);}
 assert.equal((await state(i.delivery)).state,'failed');assert.equal((await state(i.delivery)).attempts,5);
 assert.equal((await pg.control.query('SELECT mail.retry_delivery($1) AS ok',[i.delivery])).rows[0].ok,true);
 await deliverBatch(cc,sandboxTransport(cc));assert.equal((await state(i.delivery)).state,'sent');assert.equal((await state(i.delivery)).attempts,6);
 assert.equal((await pg.owner.query('SELECT state FROM commerce.invitation WHERE id=$1',[i.id])).rows[0].state,'active');assert.ok(!JSON.stringify((await pg.control.query('SELECT * FROM mail.delivery')).rows).includes(i.secret));
});
test('cancelled/used/expired invitations are suppressed before send and cannot be manually retried',async()=>{
 for(const target of ['cancelled','used','expired']){
  const i=await invite();await pg.owner.query(target==='expired'?"UPDATE commerce.invitation SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1":'UPDATE commerce.invitation SET state=$2 WHERE id=$1',target==='expired'?[i.id]:[i.id,target]);
  await deliverBatch(cc,sandboxTransport(cc));assert.equal((await state(i.delivery)).last_error,'STALE');assert.equal((await pg.control.query('SELECT mail.retry_delivery($1) AS ok',[i.delivery])).rows[0].ok,false);
  await pg.owner.query('DELETE FROM commerce.invitation');await pg.owner.query('DELETE FROM commerce.manual_grant');
 }
 assert.equal((await pg.owner.query('SELECT 1 FROM mail.sandbox_inbox')).rowCount,0);
});
test('password reset is single-purpose, expires/epoch invalidation suppresses mail, admin cannot resend',async()=>{
 await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES('u','User','user@example.test',true,now(),now()); INSERT INTO identity.security_state(user_id) VALUES('u')");
 const secret=token();await pg.owner.query("INSERT INTO identity.reset_token(verifier,user_id,epoch,expires_at) VALUES($1,'u',0,clock_timestamp()+interval '15 minutes')",[digest(secret)]);
 const id=await queue('password_reset',{email:'user@example.test',token:secret,profile:'finance'},'identity',fc,'u');await pg.owner.query("UPDATE identity.security_state SET epoch=1 WHERE user_id='u'");
 await deliverBatch(fc,sandboxTransport(fc));assert.equal((await state(id)).last_error,'STALE');assert.equal((await pg.control.query('SELECT mail.retry_delivery($1) AS ok',[id])).rows[0].ok,false);
});
test('concurrent workers lease one message and accept it once',async()=>{
 const id=await queue(),base=sandboxTransport(fc);let calls=0;
 const transport:Transport={idempotent:true,deliver:async(i,m)=>{calls++;await new Promise(r=>setTimeout(r,30));return base.deliver(i,m);}};
 await Promise.all([deliverBatch(fc,transport),deliverBatch(fc,transport)]);assert.equal(calls,1);assert.equal((await state(id)).state,'sent');
});
test('crashed non-idempotent dispatch becomes unknown rather than silently sending twice',async()=>{
 const id=await queue();await pg.owner.query("UPDATE identity.outbox SET lease_id=gen_random_uuid(),lease_until=clock_timestamp()-interval '1 second',attempts=1,retry_count=1 WHERE id=$1",[id]);let calls=0;
 await deliverBatch(fc,{idempotent:false,deliver:async()=>{calls++;return {acceptance:'sandbox'};}});assert.equal(calls,0);assert.equal((await state(id)).last_error,'DELIVERY_UNKNOWN');
});
test('durable idempotent sandbox recovers an acceptance-before-status crash',async()=>{
 const id=await queue(),transport=sandboxTransport(fc);await transport.deliver(id,{to:'user@example.test',subject:'Synthetic',text:'Synthetic'});
 await pg.owner.query("UPDATE identity.outbox SET lease_id=gen_random_uuid(),lease_until=clock_timestamp()-interval '1 second',attempts=1,retry_count=1 WHERE id=$1",[id]);await deliverBatch(fc,transport);
 assert.equal((await state(id)).state,'sent');assert.equal((await pg.owner.query('SELECT 1 FROM mail.sandbox_inbox')).rowCount,1);
});
test('unknown provider outcome is terminal, malformed payload and real recipients are never sent',async()=>{
 const unknown=await queue();await deliverBatch(fc,{idempotent:false,deliver:async()=>{throw new Error('sensitive provider error');}});assert.equal((await state(unknown)).last_error,'DELIVERY_UNKNOWN');
 const invalid=await queue('unsupported');await deliverBatch(fc,sandboxTransport(fc));assert.equal((await state(invalid)).last_error,'INVALID_PAYLOAD');
 const real=await queue('security_password_changed',{email:'real@real.example'});await deliverBatch(fc,sandboxTransport(fc));assert.equal((await state(real)).last_error,'REJECTED');assert.equal((await pg.owner.query('SELECT 1 FROM mail.sandbox_inbox')).rowCount,0);
});
test('reminders are deduplicated by current end and suppressed after extension/indefinite; expiry is notified',async()=>{
 await pg.owner.query("INSERT INTO identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES('u','User','user@example.test',true,now(),now()); INSERT INTO identity.security_state(user_id) VALUES('u'); INSERT INTO commerce.access_cycle(user_id,anchor_at,access_end,timezone,calendar_months,extra_days,quota_policy) VALUES('u',now()-interval '30 days',now()+interval '7 days','Europe/Moscow',0,37,'{\"source\":\"override\",\"limit\":10}')");
 await enqueueReminders(fc);await enqueueReminders(fc);assert.equal((await pg.owner.query('SELECT 1 FROM identity.outbox')).rowCount,1);
 await pg.owner.query("UPDATE commerce.access_cycle SET access_end=now()+interval '20 days' WHERE user_id='u'");await deliverBatch(fc,sandboxTransport(fc));assert.equal((await pg.owner.query('SELECT last_error FROM identity.outbox')).rows[0].last_error,'STALE');
 await pg.owner.query("UPDATE commerce.access_cycle SET access_end=now()+interval '1 day' WHERE user_id='u'");await enqueueReminders(fc);await deliverBatch(fc,sandboxTransport(fc));assert.equal((await pg.owner.query("SELECT 1 FROM identity.outbox WHERE state='sent'")).rowCount,1);
 await pg.owner.query("UPDATE commerce.access_cycle SET access_end=now()-interval '1 second' WHERE user_id='u'");await enqueueReminders(fc);await enqueueReminders(fc);await deliverBatch(fc,sandboxTransport(fc));assert.equal((await pg.owner.query("SELECT 1 FROM identity.outbox WHERE kind='access_expired' AND state='sent'")).rowCount,1);
 await pg.owner.query("UPDATE commerce.access_cycle SET access_end=NULL,indefinite=true WHERE user_id='u'");await enqueueReminders(fc);assert.equal((await pg.owner.query('SELECT 1 FROM identity.outbox')).rowCount,3);
});
test('pg-boss runtime processes a real durable queue without owner or API credentials',async()=>{
 const id=await queue(),worker=await startMailWorker(fc);
 try{
  const until=Date.now()+10000;while(Date.now()<until&&(await state(id)).state==='queued')await new Promise(r=>setTimeout(r,100));
  assert.equal((await state(id)).state,'sent');assert.ok((await pg.owner.query('SELECT 1 FROM jobs_mail_finance.job')).rowCount);
 }finally{await worker.stop();}
});
