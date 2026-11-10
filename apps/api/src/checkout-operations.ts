import type {Pool,PoolClient} from 'pg';
import type {AccessRequest} from '../../../packages/access/src/model.ts';
import type {AccessPaymentProvider,ProviderRefund} from './access-payment-provider.ts';
import {verifiedPayment} from './access-payment-provider.ts';
import {syncAccessCheckout} from './access-checkout.ts';
import {actionId,remember} from './commerce.ts';
import {HttpError,outbox} from './types.ts';
import type {Sealer} from './types.ts';

type Job={checkout_id:string;provider_id:string|null;state:string;provider_state:string|null;action_id:string};
const finalState=(state:string|null)=>state==='succeeded'||state==='canceled';
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requestReconciliation(db:PoolClient,actor:string,input:Record<string,unknown>){
 const id=actionId(input.actionId),checkoutId=actionId(input.checkoutId),step=input.step;
 const providerId=input.providerId;
 if(step!=='check'&&step!=='apply'||providerId!==undefined&&(typeof providerId!=='string'||!uuidPattern.test(providerId)))throw new HttpError(400,'INVALID_PAYMENT_REFERENCE');
 const order=(await db.query("SELECT * FROM commerce.control_checkout_queue($1) WHERE id=$1 AND status='reconcile'",[checkoutId])).rows[0];
 if(!order)throw new HttpError(409,'PAYMENT_RECONCILIATION_UNAVAILABLE');
 const previous=(await db.query<Job>('SELECT * FROM commerce.checkout_reconciliation WHERE checkout_id=$1 FOR UPDATE',[checkoutId])).rows[0];
 if(previous&&['checking','applying'].includes(previous.state))throw new HttpError(409,'PAYMENT_RECONCILIATION_BUSY');
 const ref=order.provider_id??providerId??previous?.provider_id??null;
 if(!ref)throw new HttpError(400,'INVALID_PAYMENT_REFERENCE');
 if(step==='apply'&&(previous?.state!=='verified'||!finalState(previous.provider_state)))throw new HttpError(409,'PAYMENT_RECONCILIATION_UNVERIFIED');
 const payload={kind:'checkout_reconciliation',decision:step,checkoutId,email:order.email,providerStatus:previous?.provider_state??null};
 if(await remember(db,id,actor,payload))return {status:'queued'};
 await db.query(`INSERT INTO commerce.checkout_reconciliation(checkout_id,provider_id,state,actor_id,action_id)
  VALUES($1,$2,$3,$4,$5) ON CONFLICT(checkout_id) DO UPDATE SET provider_id=EXCLUDED.provider_id,
  state=EXCLUDED.state,actor_id=EXCLUDED.actor_id,action_id=EXCLUDED.action_id,message=NULL,updated_at=clock_timestamp()`,[checkoutId,ref,step==='check'?'checking':'applying',actor,id]);
 return {status:'queued'};
}

export async function runReconciliations(pool:Pool,provider:AccessPaymentProvider,seal:Sealer){
 const ids=(await pool.query<{checkout_id:string}>("SELECT checkout_id FROM commerce.checkout_reconciliation WHERE state IN ('checking','applying') ORDER BY updated_at LIMIT 8")).rows;
 for(const {checkout_id:id} of ids){
  const db=await pool.connect();
  let actionId:string|undefined;
  try{
   await db.query('BEGIN');
   await db.query('SELECT pg_advisory_xact_lock(92042)');
   const job=(await db.query<Job>("SELECT * FROM commerce.checkout_reconciliation WHERE checkout_id=$1 AND state IN ('checking','applying') FOR UPDATE",[id])).rows[0];
   if(!job){await db.query('COMMIT');continue;}
   actionId=job.action_id;
   const owner=(await db.query<{application_id:string|null;user_id:string|null;email:string}>('SELECT * FROM commerce.reconciliation_target($1)',[id])).rows[0];
   if(!owner||!job.provider_id)throw new HttpError(409,'PAYMENT_RECONCILIATION_UNAVAILABLE');
   const key=owner.application_id?'app.checkout_application':'app.user_id';
   await db.query('SELECT set_config($1,$2,true)',[key,owner.application_id??owner.user_id]);
   const order=(await db.query<{provider_id:string|null;tariff:{priceMinor:string}}>('SELECT provider_id,tariff FROM commerce.access_checkout WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!order)throw new HttpError(409,'PAYMENT_RECONCILIATION_UNAVAILABLE');
   const payment=await provider.read(job.provider_id),minor=BigInt(order.tariff.priceMinor);
   const value=(minor/100n)+'.'+String(minor%100n).padStart(2,'0');
   verifiedPayment(payment,{id,providerId:order.provider_id??job.provider_id,value,test:provider.test});
   let status='verified',message:string|null=null;
   if(job.state==='applying'){
    if(finalState(payment.status)){
     if(!order.provider_id)await db.query('UPDATE commerce.access_checkout SET provider_id=$2 WHERE id=$1',[id,payment.id]);
     const account=owner.application_id?(await db.query<{data:AccessRequest}>('SELECT data FROM access.request WHERE id=$1',[owner.application_id])).rows[0]?.data:
      {id:owner.user_id!,email:owner.email};
     if(!account)throw new HttpError(409,'PAYMENT_RECONCILIATION_UNAVAILABLE');
     const resolved=await syncAccessCheckout(db,id,account,{...provider,read:async()=>payment},seal,true);
     status=resolved.state==='paid'||resolved.state==='cancelled'?'resolved':'unknown';
     if(status==='unknown')message='Не удалось завершить обработку оплаты. Проверьте условия заявки.';
    }else message='Окончательный результат оплаты ещё неизвестен.';
   }
   await db.query('UPDATE commerce.checkout_reconciliation SET state=$2,provider_state=$3,message=$4,updated_at=clock_timestamp() WHERE checkout_id=$1',[id,status,payment.status,message]);
   await db.query('SELECT commerce.record_checkout_reconciliation_result($1,$2)',[id,actionId]);
   await db.query('COMMIT');
  }catch(error){
   await db.query('ROLLBACK');
   if(actionId){await db.query("UPDATE commerce.checkout_reconciliation SET state='unknown',message=$3,updated_at=clock_timestamp() WHERE checkout_id=$1 AND action_id=$2",[id,actionId,
    error instanceof HttpError&&error.code==='PAYMENT_UNVERIFIED'?'Платёж ЮKassa не совпадает с заказом CashNeuro.':'Не удалось сверить платёж. Проверьте номер в ЮKassa и повторите.']);
    await db.query('SELECT commerce.record_checkout_reconciliation_result($1,$2)',[id,actionId]);
   }
  }finally{db.release();}
 }
}

function refundValue(refund:ProviderRefund){
 if(!refund||typeof refund.id!=='string'||!uuidPattern.test(refund.id)||typeof refund.payment_id!=='string'||!uuidPattern.test(refund.payment_id)||
  !['pending','succeeded','canceled'].includes(refund.status)||refund.amount?.currency!=='RUB'||typeof refund.amount.value!=='string'||
  !/^\d{1,8}\.\d{2}$/.test(refund.amount.value)||typeof refund.created_at!=='string'||!Number.isFinite(Date.parse(refund.created_at)))return null;
 const minor=Number(refund.amount.value.replace('.',''));
 return minor>0&&minor<=1000000?minor:null;
}
export async function importRefunds(pool:Pool,provider:AccessPaymentProvider,seal:Sealer,since:string,cursor?:string){
 if(!provider.refunds)return undefined;
 const page=await provider.refunds(since,cursor);
 for(const refund of page.items){
  const amount=refundValue(refund);if(amount===null)continue;
  const db=await pool.connect();
  try{
   await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(92042)');
   const row=(await db.query('SELECT * FROM commerce.record_checkout_refund($1,$2,$3,$4,$5)',[refund.id,refund.payment_id,amount,refund.status,refund.created_at])).rows[0];
   if(row?.notify_email)await outbox(db,'access',seal,'billing_refund',{email:row.notify_email,amountMinor:String(amount),full:row.fully_refunded},{subjectId:row.checkout_id,dedupeKey:'billing-refund:'+refund.id});
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 return page.next_cursor;
}
