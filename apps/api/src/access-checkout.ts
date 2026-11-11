import {isTrial,finishTrial,refundTrial,runTrialRefunds,saveCard,trialInfo} from './trial.ts';
import {paidAnalyzerUnits} from './customer-ai-budget.ts';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {legalDocuments} from '../../../packages/access/src/legal.ts';
import {billingPlan,mayAutoCharge,noticeLeadMs,rubleValue,sameBillingPlan} from '../../../packages/access/src/billing.ts';
import type {BillingPlan} from '../../../packages/access/src/billing.ts';
import type {AccessRequest,Tariff} from '@finance/access';
import {object,uuid} from '../../../packages/finance-core/src/model.ts';
import {lockedCycle,extensionAt} from './entitlement.ts';
import {digest,token} from './crypto.ts';
import {HttpError,outbox,clock} from './types.ts';
import type {Sealer} from './types.ts';
import {accountLegal,checkLegalVersion} from './launch-legal.ts';
import {catalogOrder} from './commerce-catalog.ts';
import {verifiedPayment} from './access-payment-provider.ts';
import type {AccessPaymentProvider} from './access-payment-provider.ts';

type Mode='once'|'enroll'|'automatic';
type Order={purpose?:string;cancel_requested?:boolean;provider_status?:string;capture_required?:boolean;desired_auto?:boolean|null;save_card?:boolean;id:string;user_id:string|null;application_id:string|null;tariff:BillingPlan;offer_version:string;renewal_version:string|null;mode:Mode;cycle_revision:number|null;planned_end:Date|null;provider_id:string|null;redirect_url:string|null;payment_method_id:string|null;state:'created'|'pending'|'paid'|'cancelled'|'reconcile';created_at:Date;paid_at:Date|null};
type Renewal={user_id:string;checkout_id:string;tariff:BillingPlan;offer_version:string;renewal_version:string;method_id:string|null;state:'active'|'off'|'changed'|'failed';next_at:Date;notice_id:string|null};
type Account={id:string;email:string};
const projection=(o:Order)=>({purpose:o.purpose??'access',cancelRequested:o.cancel_requested??false,id:o.id,state:o.state,mode:o.mode,autoRequested:o.mode==='enroll'&&!!o.renewal_version&&(o.state!=='paid'||o.application_id===null||!!o.payment_method_id),tariff:o.tariff,plannedEnd:o.planned_end,redirect:o.state==='pending'?o.redirect_url:null});
const terminal=(o:Order)=>['paid','cancelled','reconcile'].includes(o.state);
const catalog=async(db:PoolClient)=>(await db.query<{snapshot:Tariff}>(`SELECT snapshot FROM access.tariff WHERE snapshot->>'active'='true' AND snapshot->>'availableForRenewal'='true' ORDER BY ${catalogOrder}`)).rows.map(r=>r.snapshot);
async function savedRenewal(db:PoolClient,userId:string){return (await db.query<Renewal>('SELECT * FROM commerce.autorenewal WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];}
async function paymentOrder(db:PoolClient,id:string){return (await db.query<Order>('SELECT * FROM commerce.access_checkout WHERE id=$1 FOR UPDATE',[id])).rows[0];}
async function currentOrder(db:PoolClient,userId:string,purpose='access'){return (await db.query<Order>("SELECT * FROM commerce.access_checkout WHERE user_id=$1 AND purpose=$2 ORDER BY (state IN ('created','pending','reconcile')) DESC,created_at DESC LIMIT 1",[userId,purpose])).rows[0];}
async function automaticEvent(db:PoolClient,r:Renewal,action:'enable'|'disable'|'changed'|'failed'){
 await db.query('INSERT INTO commerce.autorenewal_event(user_id,action,checkout_id,tariff,offer_version,renewal_version) VALUES($1,$2,$3,$4,$5,$6)',[r.user_id,action,r.checkout_id,r.tariff,r.offer_version,r.renewal_version]);
}
function exactConsent(r:Renewal,current:Tariff|undefined){return !!current&&sameBillingPlan(r.tariff,billingPlan(current))&&r.offer_version===legalDocuments.offer.version&&r.renewal_version===legalDocuments.renewal.version;}
async function stopRenewal(db:PoolClient,r:Renewal,state:'off'|'changed'|'failed'){
 await db.query('UPDATE commerce.autorenewal SET state=$2,method_id=NULL,notice_id=NULL WHERE user_id=$1',[r.user_id,state]);
 await automaticEvent(db,r,state==='off'?'disable':state);
}
export async function checkoutAccountState(db:PoolClient,userId:string,provider:AccessPaymentProvider|undefined,seal?:Sealer){
 if(provider&&seal){for(const purpose of ['access','trial','card']){const o=await currentOrder(db,userId,purpose);if(o&&o.provider_id&&['created','pending'].includes(o.state)){const u=(await db.query('SELECT id,email FROM identity.auth_user WHERE id=$1',[userId])).rows[0];await syncAccessCheckout(db,o.id,u,provider,seal);}}}
 const cycle=await lockedCycle(db,userId),r=await savedRenewal(db,userId),latest=await currentOrder(db,userId);
 const tariffs=cycle.indefinite?[]:await catalog(db);
 const info=await trialInfo(db,userId),card=(await db.query('SELECT last4 FROM commerce.saved_card WHERE user_id=$1',[userId])).rows[0]??null;
 const active=!!cycle.accessEnd&&Date.parse(cycle.accessEnd)>Date.now();
 const termsValid=!!r&&!!tariffs.find(t=>t.id===r.tariff.id&&sameBillingPlan(r.tariff,billingPlan(t)));
 const canEnable=!!provider&&!!r&&!!card&&termsValid&&active&&Date.parse(cycle.accessEnd!)-Date.now()>noticeLeadMs&&!cycle.indefinite;
 return {canEnable,canBind:!!r&&active&&!card,enableReason:!provider?'Оплата временно недоступна.':!r?'Сначала выберите и оплатите тариф.':!card?'Для включения автопродления привяжите карту.':!active?'Сначала продлите доступ.':!termsValid?'Условия тарифа изменились. Выберите тариф заново.':!canEnable?'До окончания доступа осталось меньше трёх дней. Продлите доступ вручную.':null,enabled:!!provider&&!cycle.indefinite,test:provider?.test??false,accessEnd:info.isNew?null:cycle.accessEnd,tariffs,
  renewal:r?{state:r.state==='active'&&!exactConsent(r,tariffs.find(t=>t.id===r.tariff.id))?'changed':r.state,tariff:r.tariff,nextAt:r.next_at}:null,
  card,...info,trialOrder:(await currentOrder(db,userId,'trial'))?projection((await currentOrder(db,userId,'trial'))!):null,cardOrder:(await currentOrder(db,userId,'card'))?projection((await currentOrder(db,userId,'card'))!):null,order:latest?projection(latest):null};
}
export async function quoteAccess(db:PoolClient,userId:string,input:unknown,provider:AccessPaymentProvider|undefined){
 if(!provider)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
 const r=object(input,['tariffId']),cycle=await lockedCycle(db,userId),t=(await catalog(db)).find(t=>t.id===r.tariffId);
 if(!t)throw new HttpError(409,'TARIFF_CHANGED');
 const now=await clock(db),start=cycle.accessEnd&&cycle.accessEnd>now?cycle.accessEnd:now,result=await extensionAt(db,cycle,t.duration,now,'quote','quote');
 return {tariff:billingPlan(t),startsAt:start,endsAt:result.extension.accessEnd,cycleRevision:cycle.revision,offerVersion:legalDocuments.offer.version,renewalVersion:legalDocuments.renewal.version};
}
async function orderInsert(db:PoolClient,id:string,owner:{id?:string;requestId?:string},t:BillingPlan,mode:Mode,cycleRevision?:number,plannedEnd?:string|null,method?:string){
 await db.query('INSERT INTO commerce.access_checkout(id,user_id,application_id,tariff,offer_version,renewal_version,mode,cycle_revision,planned_end,payment_method_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,owner.id??null,owner.requestId??null,t,legalDocuments.offer.version,mode==='once'?null:legalDocuments.renewal.version,mode,cycleRevision??null,plannedEnd??null,method??null]);
 return (await paymentOrder(db,id))!;
}
export async function startAccessCheckout(db:PoolClient,user:Account,input:unknown,provider:AccessPaymentProvider|undefined,legalRequired=false){
 if(!provider)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
 if(legalRequired&&!(await accountLegal(db,user.id)).termsAccepted)throw new HttpError(409,'TERMS_ACCEPTANCE_REQUIRED');
 const r=object(input,['id','tariffId','priceMinor','catalogVersion','offerVersion','renewalVersion','cycleRevision','saveCardConsent','autoRenewal']);
 checkLegalVersion(r.offerVersion,legalDocuments.offer.version,true);
 if(r.renewalVersion!==undefined)checkLegalVersion(r.renewalVersion,legalDocuments.renewal.version,true);
 const mode=r.renewalVersion===undefined?'once':'enroll',id=uuid(r.id);
 const cycle=await lockedCycle(db,user.id);
 if((await db.query("SELECT status FROM identity.security_state WHERE user_id=$1",[user.id])).rows[0]?.status!=='active')throw new HttpError(403,'SUSPENDED');
 const old=await paymentOrder(db,id);
 if(old){
  if(old.user_id!==user.id||old.tariff.id!==r.tariffId||old.tariff.priceMinor!==r.priceMinor||old.mode!==mode)throw new HttpError(409,'ACTION_REUSED');
  return projection(old);
 }
 const pending=await currentOrder(db,user.id);if(pending&&!['paid','cancelled'].includes(pending.state))throw new HttpError(409,'PAYMENT_PENDING');
 await db.query('SELECT pg_advisory_xact_lock_shared(92044)');
 const q=await quoteAccess(db,user.id,{tariffId:r.tariffId},provider);
 if(q.tariff.catalogVersion!==r.catalogVersion||q.tariff.priceMinor!==r.priceMinor||q.cycleRevision!==r.cycleRevision)throw new HttpError(409,'TARIFF_CHANGED');
 const created=await orderInsert(db,id,user,q.tariff,mode,q.cycleRevision,q.endsAt);
 if(r.saveCardConsent===true)await db.query('UPDATE commerce.access_checkout SET save_card=true WHERE id=$1',[id]);
 if(typeof r.autoRenewal==='boolean')await db.query('UPDATE commerce.access_checkout SET desired_auto=$2 WHERE id=$1',[id,r.autoRenewal]);
 return projection(created);
}
export async function startFirstCheckout(db:PoolClient,row:AccessRequest,input:unknown,provider:AccessPaymentProvider|undefined){
 if(!provider)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
 const r=object(input,['id','priceMinor','offerVersion','renewalVersion']);checkLegalVersion(r.offerVersion,legalDocuments.offer.version,true);
 if(r.renewalVersion!==undefined)checkLegalVersion(r.renewalVersion,legalDocuments.renewal.version,true);
 const mode=r.renewalVersion===undefined?'once':'enroll',id=uuid(r.id);await db.query("SELECT set_config('app.checkout_application',$1,true)",[row.id]);
 const existing=await paymentOrder(db,id);
 if(existing){
  if(existing.application_id!==row.id||existing.tariff.priceMinor!==r.priceMinor||existing.mode!==mode)throw new HttpError(409,'ACTION_REUSED');
  return projection(existing);
 }
 if(!row.verifiedAt||row.status!=='awaiting_payment'||Date.parse(row.expiresAt)<=Date.parse(await clock(db))||row.tariff.priceMinor!==r.priceMinor)throw new HttpError(409,'PAYMENT_RETRY_REQUIRED');
 const pending=(await db.query("SELECT 1 FROM commerce.access_checkout WHERE application_id=$1 AND state IN ('created','pending','reconcile')",[row.id])).rowCount;
 if(pending)throw new HttpError(409,'PAYMENT_PENDING');
 if(mode==='enroll'){
  await db.query('SELECT pg_advisory_xact_lock_shared(92044)');
  const plan=(await catalog(db)).find(t=>t.id===row.tariff.id);
  if(!plan||!sameBillingPlan(billingPlan(row.tariff),billingPlan(plan)))throw new HttpError(409,'AUTORENEWAL_TERMS_CHANGED');
 }
 return projection(await orderInsert(db,id,{requestId:row.id},billingPlan(row.tariff),mode));
}
export async function firstCheckoutState(db:PoolClient,row:AccessRequest,provider:AccessPaymentProvider|undefined){
 await db.query("SELECT set_config('app.checkout_application',$1,true)",[row.id]);
 const o=(await db.query<Order>('SELECT * FROM commerce.access_checkout WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1',[row.id])).rows[0];
 const renewal=(await catalog(db)).find(t=>t.id===row.tariff.id);
 return {enabled:!!provider,test:provider?.test??false,autoAvailable:!!provider&&!!renewal&&sameBillingPlan(billingPlan(row.tariff),billingPlan(renewal)),order:o?projection(o):null};
}
export async function disableFirstAutoRenewal(db:PoolClient,row:AccessRequest){
 await db.query("SELECT set_config('app.checkout_application',$1,true)",[row.id]);
 await db.query("UPDATE commerce.access_checkout SET renewal_version=NULL,payment_method_id=NULL WHERE application_id=$1 AND mode='enroll' AND state IN ('created','pending','paid')",[row.id]);
 return {status:'disabled'};
}
export async function activateFirstAutoRenewal(db:PoolClient,purchase:{id:string;request_id:string},userId:string,finish:Date){
 if(!/^purchase:[0-9a-f-]{36}$/u.test(purchase.id))return;
 await db.query("SELECT set_config('app.checkout_application',$1,true)",[purchase.request_id]);
 const order=await paymentOrder(db,purchase.id.slice(9));
 if(!order||order.application_id!==purchase.request_id||order.state!=='paid'||order.mode!=='enroll'||!order.renewal_version||!order.payment_method_id)return;
 const r=(await db.query<Renewal>(`INSERT INTO commerce.autorenewal(user_id,checkout_id,tariff,offer_version,renewal_version,method_id,state,next_at,accepted_at)
  VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8) RETURNING *`,[userId,order.id,order.tariff,order.offer_version,order.renewal_version,order.payment_method_id,finish,order.created_at])).rows[0]!;
 await automaticEvent(db,r,'enable');
 await db.query('INSERT INTO commerce.saved_card(user_id,method_id) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET method_id=EXCLUDED.method_id',[userId,order.payment_method_id]);
 await db.query('UPDATE commerce.access_checkout SET payment_method_id=NULL WHERE id=$1',[order.id]);
}
async function finalizeAccount(db:PoolClient,o:Order,user:Account,savedMethod:string|null,seal:Sealer){
 const cycle=await lockedCycle(db,user.id),settled=await clock(db);
 // If payment started before expiry, processing delay should not shift the original tariff calendar.
 const continuity=cycle.accessEnd&&cycle.accessEnd<=settled&&o.created_at.toISOString()<cycle.accessEnd;
 const start=continuity?cycle.accessEnd!:(cycle.accessEnd&&cycle.accessEnd>settled?cycle.accessEnd:settled);
 const base=continuity?new Date(Date.parse(cycle.accessEnd!)-1).toISOString():settled;
 const result=await extensionAt(db,cycle,o.tariff.duration,base,o.id,o.id),e=result.extension;
 await db.query('UPDATE commerce.access_cycle SET anchor_at=$1,access_end=$2,calendar_months=$3,extra_days=$4,revision=revision+1,end_offset_ms=CASE WHEN $6 THEN end_offset_ms ELSE 0 END WHERE user_id=$5',[e.anchorAt,e.accessEnd,result.calendarMonths,result.extraDays,user.id,e.mode==='continuous']);
 await db.query('UPDATE commerce.access_checkout SET previous_end=$2,access_end=$3 WHERE id=$1',[o.id,cycle.accessEnd,e.accessEnd]);
 await db.query('INSERT INTO commerce.access_paid_window(user_id,starts_at,ends_at,kind,quota) VALUES($1,$2,$3,$4,$5)',[user.id,start,e.accessEnd,o.tariff.duration.kind,paidAnalyzerUnits(o.tariff.id,o.tariff.duration.kind,o.tariff.aiQuota)]);
 await db.query("UPDATE commerce.access_cycle SET quota_policy=jsonb_build_object('source','tariff','tariffId',$2::text,'limit',$3::int) WHERE user_id=$1 AND quota_policy->>'source'='override' AND quota_policy->>'limit'='0' AND EXISTS(SELECT 1 FROM commerce.onboarding_account WHERE user_id=$1)",[user.id,o.tariff.id,o.tariff.aiQuota]);
 const old=await savedRenewal(db,user.id);
 if(o.mode==='enroll'&&savedMethod){
  // Enablement is tied to the original, explicitly accepted checkout. A disable while it is pending wins.
  const disabled=(await db.query("SELECT 1 FROM commerce.autorenewal_event WHERE user_id=$1 AND action='disable' AND recorded_at>=$2 LIMIT 1",[user.id,o.created_at])).rowCount;
  if(!disabled){
   const r=(await db.query<Renewal>(`INSERT INTO commerce.autorenewal(user_id,checkout_id,tariff,offer_version,renewal_version,method_id,state,next_at,accepted_at)
    VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8) ON CONFLICT(user_id) DO UPDATE SET checkout_id=EXCLUDED.checkout_id,tariff=EXCLUDED.tariff,offer_version=EXCLUDED.offer_version,renewal_version=EXCLUDED.renewal_version,method_id=EXCLUDED.method_id,state='active',next_at=EXCLUDED.next_at,notice_id=NULL,accepted_at=EXCLUDED.accepted_at RETURNING *`,
    [user.id,o.id,o.tariff,o.offer_version,o.renewal_version,savedMethod,e.accessEnd,o.created_at])).rows[0]!;
   await automaticEvent(db,r,'enable');
  }
 }else if(o.mode==='automatic'&&old?.state==='active'){
  await db.query('UPDATE commerce.autorenewal SET next_at=$2,notice_id=NULL WHERE user_id=$1',[user.id,e.accessEnd]);
 }else if(o.mode!=='automatic'&&old?.state==='active'){
  await db.query('UPDATE commerce.autorenewal SET next_at=$2,notice_id=NULL WHERE user_id=$1',[user.id,e.accessEnd]);
 }
 if(!old&&o.mode==='once')await db.query(`INSERT INTO commerce.autorenewal(user_id,checkout_id,tariff,offer_version,renewal_version,method_id,state,next_at) VALUES($1,$2,$3,$4,$5,NULL,'off',$6)`,[user.id,o.id,o.tariff,o.offer_version,legalDocuments.renewal.version,e.accessEnd]);
 if(o.desired_auto===false){const current=await savedRenewal(db,user.id);const changed=(await db.query("SELECT 1 FROM commerce.autorenewal_event WHERE user_id=$1 AND recorded_at>$2",[user.id,o.created_at])).rowCount;if(current?.state==='active'&&!changed)await stopRenewal(db,current,'off');}
 await outbox(db,'identity',seal,'billing_paid',{email:user.email,accessEnd:e.accessEnd,priceMinor:o.tariff.priceMinor},{subjectId:user.id,dedupeKey:'billing-paid:'+o.id});
}
async function finishFirst(db:PoolClient,o:Order,row:AccessRequest,seal:Sealer){
 const code=token(),invitationId='invitation:'+o.id;
 const r=(await db.query('SELECT commerce.finish_first_checkout($1,$2,$3,$4) AS done',[o.id,invitationId,digest(code),seal.seal(code)])).rows[0];
 if(!r?.done){await db.query("UPDATE commerce.access_checkout SET state='reconcile',reconcile_reason='first_access_not_issued',payment_method_id=NULL WHERE id=$1",[o.id]);return;}
 const expiresAt=new Date(Date.parse(await clock(db))+72*3600000).toISOString();
 await outbox(db,'access',seal,'billing_invitation',{email:row.email,token:code,expiresAt},{subjectId:invitationId,expiresAt,dedupeKey:'billing-invite:'+o.id});
}
export async function syncAccessCheckout(db:PoolClient,id:string,owner:Account|AccessRequest,provider:AccessPaymentProvider|undefined,seal:Sealer,resolveReconciliation=false){
 if(!provider)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
 const first='tariff' in owner;
 if(first)await db.query("SELECT set_config('app.checkout_application',$1,true)",[owner.id]);else await lockedCycle(db,owner.id);
 const o=await paymentOrder(db,uuid(id));
 if(!o||(first?o.application_id!==owner.id:o.user_id!==owner.id))throw new HttpError(404,'NOT_FOUND');
 if(o.cancel_requested&&!o.provider_id)return projection(o);
 if(terminal(o)&&!o.cancel_requested&&!(resolveReconciliation&&o.state==='reconcile'&&o.provider_id))return projection(o);
 const now=Date.parse(await clock(db));
 if(!o.provider_id){
  if(!first&&(await db.query('SELECT status FROM identity.security_state WHERE user_id=$1',[owner.id])).rows[0]?.status!=='active')throw new HttpError(403,'SUSPENDED');
  if(now-o.created_at.getTime()>23*3600000){await db.query("UPDATE commerce.access_checkout SET state='reconcile',reconcile_reason='provider_reference_missing' WHERE id=$1",[o.id]);return projection({...o,state:'reconcile'});}
  if(first&&(!owner.verifiedAt||owner.status!=='awaiting_payment'||o.created_at.getTime()>=Date.parse(owner.expiresAt)))throw new HttpError(409,'PAYMENT_RETRY_REQUIRED');
  if(o.mode==='automatic'){
   const cycle=await lockedCycle(db,owner.id);
   await db.query('SELECT pg_advisory_xact_lock_shared(92044)');
   const r=await savedRenewal(db,owner.id);
   const current=(await catalog(db)).find(t=>t.id===o.tariff.id);
   const consent=!!r&&r.state==='active'&&r.method_id===o.payment_method_id&&cycle.revision===o.cycle_revision&&cycle.accessEnd===r.next_at.toISOString()&&exactConsent(r,current)&&sameBillingPlan(r.tariff,o.tariff);
   if(!consent){await db.query("UPDATE commerce.access_checkout SET state='reconcile',reconcile_reason='autorenewal_consent_changed' WHERE id=$1",[o.id]);return projection({...o,state:'reconcile'});}
  }
 }
 const trial=!first&&await isTrial(db,o.id);
 let payment=o.provider_id?await provider.read(o.provider_id):await provider.create({id:o.id,value:rubleValue(o.tariff.priceMinor),title:o.tariff.name,first,authorize:!first&&o.mode!=='automatic',cardOnly:trial,...(trial||o.save_card||o.mode==='enroll'&&o.renewal_version?{save:true}:o.mode==='automatic'?{method:o.payment_method_id?seal.open(o.payment_method_id):undefined}:{})});
 const redirect=verifiedPayment(payment,{id:o.id,providerId:o.provider_id,value:rubleValue(o.tariff.priceMinor),test:provider.test});
 const providerExpiry=payment.confirmation?.expires_at?Date.parse(payment.confirmation.expires_at):o.created_at.getTime()+3600000;
 if(!first&&o.mode!=='automatic'&&['pending','waiting_for_capture'].includes(payment.status)&&now>=providerExpiry){o.cancel_requested=true;await db.query("UPDATE commerce.access_checkout SET cancel_requested=true WHERE id=$1",[o.id]);}
 if(o.cancel_requested){
  if(payment.status==='waiting_for_capture'){if(!provider.cancel)throw new HttpError(503,'PAYMENT_UNAVAILABLE');payment=await provider.cancel(payment.id,o.id);verifiedPayment(payment,{id:o.id,providerId:payment.id,value:rubleValue(o.tariff.priceMinor),test:provider.test});}
  await db.query("UPDATE commerce.access_checkout SET provider_id=$2,provider_status=$3,state='cancelled',redirect_url=NULL WHERE id=$1",[o.id,payment.id,payment.status]);
  if(payment.status==='succeeded'){await db.query('INSERT INTO commerce.card_refund_job(checkout_id,user_id,provider_id,refund_key,amount_minor) VALUES($1,$2,$3,$4,$5) ON CONFLICT(checkout_id) DO NOTHING',[o.id,owner.id,payment.id,randomUUID(),Number(o.tariff.priceMinor)]);await refundTrial(db,o.id,provider);}
  return projection({...o,state:'cancelled',redirect_url:null});
 }
 if(payment.status==='waiting_for_capture'&&o.mode!=='automatic'&&!first){
  if(!provider.capture)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
  payment=await provider.capture(payment.id,o.id,rubleValue(o.tariff.priceMinor));verifiedPayment(payment,{id:o.id,providerId:payment.id,value:rubleValue(o.tariff.priceMinor),test:provider.test});
 }
 await db.query('UPDATE commerce.access_checkout SET capture_required=$2,provider_status=$3 WHERE id=$1',[o.id,!first&&o.mode!=='automatic',payment.status]);
 const savedMethod=payment.payment_method?.saved&&typeof payment.payment_method.id==='string'&&payment.payment_method.id.length<=160?seal.seal(payment.payment_method.id):null;
 if(payment.status==='pending'&&now-o.created_at.getTime()>=3600000){await db.query("UPDATE commerce.access_checkout SET cancel_requested=true,state='cancelled',provider_id=$2,provider_status='pending',redirect_url=NULL WHERE id=$1",[o.id,payment.id]);return projection({...o,state:'cancelled',redirect_url:null});}
 const state=payment.status==='succeeded'?'paid':payment.status==='canceled'?'cancelled':'pending';
 if(resolveReconciliation&&state==='pending')return projection(o);
 const timestamp=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
 const reason=payment.cancellation_details?.reason;
 await db.query(`UPDATE commerce.access_checkout SET provider_id=$2,redirect_url=$3,state=$4,paid_at=CASE WHEN $4='paid' THEN clock_timestamp() ELSE NULL END,
  payment_method_id=$5,provider_paid_at=$6,provider_expires_at=$7,cancellation_reason=$8,reconcile_reason=NULL WHERE id=$1`,
 [o.id,payment.id,state==='pending'?redirect:null,state,first&&state==='paid'&&o.mode==='enroll'&&o.renewal_version?savedMethod:null,
  timestamp(payment.captured_at),state==='pending'?timestamp(payment.confirmation?.expires_at):null,
  state==='cancelled'&&typeof reason==='string'&&/^[a-z_]{1,60}$/.test(reason)?reason:null]);
 if(state==='paid'){
  if(first)await finishFirst(db,o,owner,seal);
  else if(trial){await finishTrial(db,o.id,owner,payment,seal);await refundTrial(db,o.id,provider);}
  else{await saveCard(db,owner.id,payment,seal);await finalizeAccount(db,o,owner,savedMethod,seal);await db.query("UPDATE commerce.onboarding_account SET trial_state='used' WHERE user_id=$1",[owner.id]);}
  await db.query('SELECT commerce.record_checkout_completion($1)',[o.id]);
 }else if(state==='cancelled'&&o.mode==='automatic'){
  const r=await savedRenewal(db,owner.id);if(r?.state==='active')await stopRenewal(db,r,'failed');
 }
 return projection((await paymentOrder(db,o.id))!);
}
export async function disableAutoRenewal(db:PoolClient,userId:string){
 await lockedCycle(db,userId);
 const r=await savedRenewal(db,userId);
 if(r?.state!=='off'&&r)await stopRenewal(db,r,'off');
 else if(!r)await db.query("INSERT INTO commerce.autorenewal_event(user_id,action) VALUES($1,'disable')",[userId]);
 return {status:'disabled'};
}
export async function runAutoRenewals(pool:Pool,provider:AccessPaymentProvider,seal:Sealer){
 const interactive=(await pool.query('SELECT * FROM commerce.interactive_checkouts_due()')).rows;
 for(const item of interactive){const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT set_config('app.user_id',$1,true)",[item.user_id]);const u=(await db.query('SELECT id,email FROM identity.auth_user WHERE id=$1',[item.user_id])).rows[0];if(u)await syncAccessCheckout(db,item.id,u,provider,seal);await db.query('COMMIT');}catch{await db.query('ROLLBACK');}finally{db.release();}}
 await runTrialRefunds(pool,provider);
 await pool.query('SELECT commerce.flag_stale_checkouts()');
 const first=(await pool.query<{id:string;application_id:string}>('SELECT * FROM commerce.billing_first_due()')).rows;
 for(const item of first){
  const db=await pool.connect();try{
   await db.query('BEGIN');
   const row=(await db.query<{data:AccessRequest}>('SELECT data FROM access.request WHERE id=$1 FOR UPDATE',[item.application_id])).rows[0]?.data;
   if(row)await syncAccessCheckout(db,item.id,row,provider,seal);
   await db.query('COMMIT');
  }catch{await db.query('ROLLBACK');}finally{db.release();}
 }
 const users=(await pool.query<{id:string}>('SELECT commerce.billing_due() AS id')).rows;
 for(const {id} of users){
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   await db.query("SELECT set_config('app.user_id',$1,true)",[id]);
   const cycle=await lockedCycle(db,id);
   const user=(await db.query('SELECT u.id,u.email,s.status FROM identity.auth_user u JOIN identity.security_state s ON s.user_id=u.id WHERE u.id=$1 AND u.email_verified',[id])).rows[0] as (Account&{status:string})|undefined;
   if(user){
    const o=await currentOrder(db,id),r=await savedRenewal(db,id);
    if(o&&(o.state==='pending'||o.state==='created'&&o.mode==='automatic')){
     if(o.state!=='created'||user.status==='active')await syncAccessCheckout(db,o.id,user,provider,seal);
    }else if(r?.state==='active'){
     await db.query('SELECT pg_advisory_xact_lock_shared(92044)');
     const t=(await catalog(db)).find(t=>t.id===r.tariff.id),now=Date.parse(await clock(db)),due=r.next_at.getTime();
     if(user.status!=='active'||!exactConsent(r,t)){
      await stopRenewal(db,r,'changed');
      await outbox(db,'identity',seal,'billing_changed',{email:user.email},{subjectId:id,dedupeKey:'billing-changed:'+r.checkout_id});
     }else if(!cycle.accessEnd||Date.parse(cycle.accessEnd)!==due){
      await stopRenewal(db,r,'changed');
     }else if(!r.notice_id&&due-now>=noticeLeadMs&&due-now<=5*86400000){
      const notice=await outbox(db,'identity',seal,'billing_notice',{email:user.email,dueAt:r.next_at.toISOString(),priceMinor:r.tariff.priceMinor},{subjectId:id,expiresAt:new Date(due-noticeLeadMs).toISOString(),dedupeKey:'billing-notice:'+r.checkout_id+':'+due});
      await db.query('UPDATE commerce.autorenewal SET notice_id=$2 WHERE user_id=$1',[id,notice]);
     }else if(now>=due){
      const sent=r.notice_id?(await db.query<{sent:Date|null}>('SELECT commerce.billing_notice_sent($1) AS sent',[r.notice_id])).rows[0]?.sent:null;
      if(!r.method_id||o?.state==='reconcile'||!mayAutoCharge({now,due,noticeAcceptedAt:sent?.getTime()??null,hasCurrentPermission:r.state==='active',matchesOffer:exactConsent(r,t)}))await stopRenewal(db,r,'failed');
      else await orderInsert(db,randomUUID(),user,r.tariff,'automatic',cycle.revision,null,r.method_id);
     }
    }
   }
   await db.query('COMMIT');
  }catch{await db.query('ROLLBACK');}
  finally{db.release();}
 }
}

export async function cancelAccessCheckout(db:PoolClient,user:Account,input:unknown,provider:AccessPaymentProvider|undefined,seal:Sealer){
 if(!provider)throw new HttpError(503,'PAYMENT_UNAVAILABLE');const b=object(input,['id']);await lockedCycle(db,user.id);let o=await paymentOrder(db,uuid(b.id));
 if(!o||o.user_id!==user.id)throw new HttpError(404,'NOT_FOUND');if(o.state==='paid'||o.state==='cancelled')return projection(o);
 if(o.provider_id){const p=await provider.read(o.provider_id);verifiedPayment(p,{id:o.id,providerId:o.provider_id,value:rubleValue(o.tariff.priceMinor),test:provider.test});if(p.status==='succeeded')return syncAccessCheckout(db,o.id,user,{...provider,read:async()=>p},seal);}
 await db.query("UPDATE commerce.access_checkout SET cancel_requested=true,state='cancelled',redirect_url=NULL WHERE id=$1",[o.id]);
 if(o.provider_id){try{return await syncAccessCheckout(db,o.id,user,provider,seal);}catch(e){if(!(e instanceof HttpError)||e.code!=='PAYMENT_UNAVAILABLE')throw e;return projection({...o,state:'cancelled',redirect_url:null,cancel_requested:true});}}
 return projection({...o,state:'cancelled',cancel_requested:true});
}
