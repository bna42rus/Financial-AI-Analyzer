import {saveCard,savedCard} from './payment-cards.ts';
export {saveCard} from './payment-cards.ts';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {AccessPayment,AccessPaymentProvider,ProviderRefund} from './access-payment-provider.ts';
import type {Sealer} from './types.ts';
import {HttpError} from './types.ts';
import {uuid,object} from '../../../packages/finance-core/src/model.ts';
import {billingPlan,sameBillingPlan,noticeLeadMs,rubleValue} from '../../../packages/access/src/billing.ts';
import {legalDocuments} from '../../../packages/access/src/legal.ts';
import {checkLegalVersion} from './launch-legal.ts';
import {lockedCycle} from './entitlement.ts';
import type {Tariff} from '@finance/access';
export async function trialInfo(db:PoolClient,userId:string){
 const row=(await db.query('SELECT trial_state FROM commerce.onboarding_account WHERE user_id=$1',[userId])).rows[0];
 const paid=(await db.query("SELECT 1 FROM commerce.access_checkout o WHERE o.user_id=$1 AND o.purpose='access' AND o.state='paid' AND NOT EXISTS(SELECT 1 FROM commerce.trial_checkout t WHERE t.checkout_id=o.id) LIMIT 1",[userId])).rowCount;
 const trial=(await db.query("SELECT t.result,t.refund_state,o.access_end>clock_timestamp() AS active FROM commerce.trial_checkout t JOIN commerce.access_checkout o ON o.id=t.checkout_id WHERE t.user_id=$1 AND t.kind='trial' AND o.state='paid' ORDER BY t.created_at DESC LIMIT 1",[userId])).rows[0];
 return {isNew:!!row&&!paid&&['new','pending','denied'].includes(row.trial_state),trialAvailable:!!row&&!paid&&['new','pending','denied'].includes(row.trial_state),trialState:trial?.active&&trial.result==='granted'?'active':row?.trial_state==='active'?'used':row?.trial_state??null,trialResult:trial?.result??null,refundState:trial?.refund_state??null};
}
export async function startTrial(db:PoolClient,user:{id:string;email:string},input:unknown,provider:AccessPaymentProvider|undefined,seal:Sealer,bindingOnly=false){
 if(!provider?.createRefund)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
 const b=object(input,['id','device','offerVersion','renewalVersion','cardConsent','tariffId','catalogVersion','priceMinor','cardId']);
 checkLegalVersion(b.offerVersion,legalDocuments.offer.version,true);
 if(b.renewalVersion!==undefined)checkLegalVersion(b.renewalVersion,legalDocuments.renewal.version,true);
 if(b.cardConsent!==true)throw new HttpError(400,'CARD_CONSENT_REQUIRED');
 const id=uuid(b.id),device=uuid(b.device),cycle=await lockedCycle(db,user.id);
 if((await db.query('SELECT o.id FROM commerce.access_checkout o JOIN commerce.trial_checkout t ON t.checkout_id=o.id WHERE o.id=$1 AND o.user_id=$2',[id,user.id])).rowCount)return {id};
 const info=await trialInfo(db,user.id);

 if((!bindingOnly&&(!info.trialAvailable||cycle.indefinite||cycle.accessEnd&&Date.parse(cycle.accessEnd)>Date.now()))||(await db.query("SELECT 1 FROM identity.security_state WHERE user_id=$1 AND status='suspended'",[user.id])).rowCount)throw new HttpError(409,'TRIAL_UNAVAILABLE');
 if((await db.query("SELECT 1 FROM commerce.access_checkout WHERE user_id=$1 AND purpose=$2 AND state IN ('created','pending','reconcile')",[user.id,bindingOnly?'card':'trial'])).rowCount)throw new HttpError(409,'PAYMENT_PENDING');
 await db.query('SELECT pg_advisory_xact_lock_shared(92044)');
 const tariffs=(await db.query<{snapshot:Tariff}>("SELECT snapshot FROM access.tariff WHERE snapshot->>'active'='true' AND snapshot->>'availableForRenewal'='true'")).rows.map(r=>r.snapshot);
 const weekly=tariffs.find(t=>t.id===b.tariffId&&(bindingOnly||t.duration.kind==='days'&&t.duration.count===7));
 if(!weekly||weekly.priceMinor!==b.priceMinor||(weekly.catalogVersion??0)!==b.catalogVersion)throw new HttpError(409,'TARIFF_CHANGED');
 const t=billingPlan(weekly),verification={...t,name:bindingOnly?'Привязка карты':'Проверка карты для пробной недели',priceMinor:'1000',aiQuota:2500};
 await db.query('INSERT INTO commerce.access_checkout(id,user_id,tariff,offer_version,renewal_version,mode,cycle_revision,purpose) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,user.id,verification,b.offerVersion,b.renewalVersion??null,b.renewalVersion?'enroll':'once',cycle.revision,bindingOnly?'card':'trial']);
 await db.query('INSERT INTO commerce.trial_checkout(checkout_id,user_id,renewal_tariff,device_key,email_key,refund_key,kind) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,user.id,t,seal.rateKey('trial-device:'+device),seal.rateKey('trial-email:'+user.email.trim().toLowerCase()),randomUUID(),bindingOnly?'card':'trial']);
 if(b.cardId!==undefined){const card=await savedCard(db,user.id,b.cardId);await db.query('UPDATE commerce.access_checkout SET card_id=$2,payment_method_id=$3 WHERE id=$1',[id,card.id,card.method_id]);}
 if(!bindingOnly)await db.query("UPDATE commerce.onboarding_account SET trial_state='pending' WHERE user_id=$1",[user.id]);return {id};
}
export async function isTrial(db:PoolClient,id:string){return !!(await db.query('SELECT 1 FROM commerce.trial_checkout WHERE checkout_id=$1',[id])).rowCount;}
export async function finishTrial(db:PoolClient,id:string,user:{id:string;email:string},payment:AccessPayment,seal:Sealer){
 const t=(await db.query('SELECT * FROM commerce.trial_checkout WHERE checkout_id=$1 FOR UPDATE',[id])).rows[0];if(!t||t.result)return;
 await db.query('INSERT INTO commerce.card_refund_job(checkout_id,user_id,provider_id,refund_key) VALUES($1,$2,$3,$4) ON CONFLICT(checkout_id) DO NOTHING',[id,user.id,payment.id,t.refund_key]);
 const c=payment.payment_method?.card,method=await saveCard(db,user.id,payment,seal);
 if(t.kind==='card'){await db.query("UPDATE commerce.trial_checkout SET result=$2,result_reason=$3 WHERE checkout_id=$1",[id,method?'granted':'denied',method?null:'card_not_saved']);return;}
 const alreadyPaid=(await db.query("SELECT 1 FROM commerce.access_checkout WHERE user_id=$1 AND purpose='access' AND state='paid'",[user.id])).rowCount;
 const mask=c&&/^\d{6}$/.test(c.first6??'')&&/^\d{4}$/.test(c.last4??'')&&/^\d{2}$/.test(c.expiry_month??'')&&/^\d{4}$/.test(c.expiry_year??'')?[c.first6,c.last4,c.expiry_month,c.expiry_year].join(':'):null;
 const claimed=!alreadyPaid&&method&&mask&&(await db.query('SELECT commerce.claim_trial($1,$2,$3,$4) AS ok',[id,t.email_key,t.device_key,seal.rateKey('trial-card:'+mask)])).rows[0]?.ok;
 await db.query('UPDATE commerce.trial_checkout SET result=$2,result_reason=$3 WHERE checkout_id=$1',[id,claimed?'granted':'denied',claimed?null:alreadyPaid?'paid_access':!method?'card_not_saved':!mask?'card_details_missing':'repeat_trial']);
 await db.query('UPDATE commerce.onboarding_account SET trial_state=$2 WHERE user_id=$1',[user.id,claimed?'active':alreadyPaid?'used':'denied']);
 if(!claimed)return; // Refund the verification payment even if repeat-use protection denies access.
 await db.query('SELECT commerce.activate_checkout_counter($1)',[id]);
 const cycle=await lockedCycle(db,user.id),times=(await db.query("SELECT clock_timestamp() AS start,clock_timestamp()+interval '7 days' AS finish")).rows[0];
 await db.query('UPDATE commerce.access_cycle SET anchor_at=$2,access_end=$3,calendar_months=0,extra_days=7,end_offset_ms=0,revision=revision+1 WHERE user_id=$1',[user.id,times.start,times.finish]);
 await db.query("INSERT INTO commerce.access_paid_window(user_id,starts_at,ends_at,kind,quota) VALUES($1,$2,$3,'days',2500)",[user.id,times.start,times.finish]);
 await db.query('UPDATE commerce.access_checkout SET previous_end=$2,access_end=$3 WHERE id=$1',[id,cycle.accessEnd,times.finish]);
 const order=(await db.query('SELECT * FROM commerce.access_checkout WHERE id=$1',[id])).rows[0];
 const disabled=(await db.query("SELECT 1 FROM commerce.autorenewal_event WHERE user_id=$1 AND action='disable' AND recorded_at>=$2",[user.id,order.created_at])).rowCount;
 const active=order.mode==='enroll'&&order.renewal_version&&!disabled;
 await db.query(`INSERT INTO commerce.autorenewal(user_id,checkout_id,tariff,offer_version,renewal_version,method_id,state,next_at,accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id) DO UPDATE SET checkout_id=EXCLUDED.checkout_id,tariff=EXCLUDED.tariff,offer_version=EXCLUDED.offer_version,renewal_version=EXCLUDED.renewal_version,method_id=EXCLUDED.method_id,state=EXCLUDED.state,next_at=EXCLUDED.next_at,notice_id=NULL,accepted_at=EXCLUDED.accepted_at`,[user.id,id,t.renewal_tariff,order.offer_version,legalDocuments.renewal.version,active?method:null,active?'active':'off',times.finish,order.created_at]);
 await db.query('UPDATE commerce.autorenewal SET card_id=(SELECT id FROM commerce.payment_card WHERE user_id=$1 AND method_id=$2 AND active LIMIT 1) WHERE user_id=$1',[user.id,method]);
 if(active)await db.query("INSERT INTO commerce.autorenewal_event(user_id,action,checkout_id,tariff,offer_version,renewal_version) VALUES($1,'enable',$2,$3,$4,$5)",[user.id,id,t.renewal_tariff,order.offer_version,order.renewal_version]);
}
export async function recordTrialRefund(db:PoolClient,refund:ProviderRefund){
 const t=(await db.query('SELECT * FROM commerce.card_refund_job WHERE provider_id=$1 FOR UPDATE',[refund.payment_id])).rows[0];if(!t)return false;
 if(refund.amount?.currency!=='RUB'||refund.amount.value!==rubleValue(String(t.amount_minor))||t.refund_id&&t.refund_id!==refund.id||!['pending','succeeded','canceled'].includes(refund.status))throw new HttpError(502,'PAYMENT_UNVERIFIED');
 await db.query('UPDATE commerce.card_refund_job SET refund_id=$2,refund_state=$3 WHERE checkout_id=$1',[t.checkout_id,refund.id,refund.status]);
 await db.query('UPDATE commerce.trial_checkout SET refund_id=$2,refund_state=$3 WHERE checkout_id=$1',[t.checkout_id,refund.id,refund.status]);return true;
}
export async function refundTrial(db:PoolClient,id:string,provider:AccessPaymentProvider){
 const t=(await db.query("SELECT * FROM commerce.card_refund_job WHERE checkout_id=$1 FOR UPDATE",[id])).rows[0];
 if(!t||t.refund_state==='succeeded'||t.refund_state==='canceled')return;
 await db.query('UPDATE commerce.card_refund_job SET refund_attempt_at=clock_timestamp() WHERE checkout_id=$1',[id]);
 try{const refund=t.refund_id?await provider.readRefund!(t.refund_id):await provider.createRefund!({id:t.refund_key,paymentId:t.provider_id,value:rubleValue(String(t.amount_minor))});
  if(refund.payment_id!==t.provider_id)throw new HttpError(502,'PAYMENT_UNVERIFIED');await recordTrialRefund(db,refund);
 }catch(e){if(e instanceof HttpError&&e.code==='PAYMENT_UNVERIFIED')throw e;/* Required/pending is durable and retried by the billing worker. */}
}
export async function runTrialRefunds(pool:Pool,provider:AccessPaymentProvider){
 for(const t of (await pool.query('SELECT * FROM commerce.trial_refunds_due()')).rows){const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT set_config('app.user_id',$1,true)",[t.user_id]);await refundTrial(db,t.checkout_id,provider);await db.query('COMMIT');}catch{await db.query('ROLLBACK');}finally{db.release();}}
}
export async function enableRenewal(db:PoolClient,userId:string,input:unknown){
 const b=object(input,['renewalVersion','offerVersion','cardId']);checkLegalVersion(b.renewalVersion,legalDocuments.renewal.version,true);checkLegalVersion(b.offerVersion,legalDocuments.offer.version,true);
 const cycle=await lockedCycle(db,userId),now=Date.now();
 if((await db.query("SELECT 1 FROM identity.security_state WHERE user_id=$1 AND status='suspended'",[userId])).rowCount)throw new HttpError(403,'SUSPENDED');
 if(cycle.indefinite||!cycle.accessEnd||Date.parse(cycle.accessEnd)<=now)throw new HttpError(409,'ACCESS_EXPIRED');
 const r=(await db.query('SELECT * FROM commerce.autorenewal WHERE user_id=$1 FOR UPDATE',[userId])).rows[0],card=b.cardId!==undefined?await savedCard(db,userId,b.cardId):(await db.query('SELECT * FROM commerce.payment_card WHERE user_id=$1 AND active ORDER BY (id=$2) DESC NULLS LAST,created_at LIMIT 1',[userId,r?.card_id??null])).rows[0];
 if(!r||!card)throw new HttpError(409,'CARD_REQUIRED');
 if(r.state!=='active'&&Date.parse(cycle.accessEnd)-now<=noticeLeadMs)throw new HttpError(409,'AUTORENEWAL_TOO_LATE');
 const current=(await db.query<{snapshot:Tariff}>("SELECT snapshot FROM access.tariff WHERE id=$1 AND snapshot->>'active'='true' AND snapshot->>'availableForRenewal'='true'",[r.tariff.id])).rows[0]?.snapshot;
 if(!current||!sameBillingPlan(billingPlan(current),r.tariff))throw new HttpError(409,'AUTORENEWAL_TERMS_CHANGED');
 await db.query("UPDATE commerce.autorenewal SET state='active',method_id=$2,card_id=$6,next_at=$3,accepted_at=CASE WHEN state='active' THEN accepted_at ELSE clock_timestamp() END,notice_id=CASE WHEN state='active' THEN notice_id ELSE NULL END,offer_version=$4,renewal_version=$5 WHERE user_id=$1",[userId,card.method_id,cycle.accessEnd,b.offerVersion,b.renewalVersion,card.id]);
 await db.query("INSERT INTO commerce.autorenewal_event(user_id,action,checkout_id,tariff,offer_version,renewal_version) VALUES($1,'enable',$2,$3,$4,$5)",[userId,r.checkout_id,r.tariff,b.offerVersion,b.renewalVersion]);return {status:'enabled'};
}
