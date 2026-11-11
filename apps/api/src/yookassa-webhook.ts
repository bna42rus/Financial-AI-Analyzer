import {recordTrialRefund} from './trial.ts';
import type {PoolClient} from 'pg';
import type {AccessRequest} from '../../../packages/access/src/model.ts';
import type {AccessPaymentProvider} from './access-payment-provider.ts';
import {syncAccessCheckout} from './access-checkout.ts';
import {recordAccessRefund,refundValue} from './checkout-operations.ts';
import {HttpError} from './types.ts';
import type {Sealer} from './types.ts';
import {aiTopup} from './yookassa-topups.ts';
import type {TestPayments} from './yookassa-topups.ts';

type Target={id:string;user_id:string|null;application_id:string|null;kind:'access'|'topup';state:string};
const reference=(value:unknown):value is string=>typeof value==='string'&&/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(value);

export async function handleYooKassaNotification(db:PoolClient,body:unknown,access:AccessPaymentProvider|undefined,topups:TestPayments|undefined,seal:Sealer){
 const notification=body as {type?:unknown;event?:unknown;object?:{id?:unknown;payment_id?:unknown}}|null;
 if(notification?.type!=='notification')throw new HttpError(400,'INVALID_NOTIFICATION');
 const event=notification.event;
 if(event!=='payment.succeeded'&&event!=='payment.canceled'&&event!=='payment.waiting_for_capture'&&event!=='refund.succeeded')return;
 const id=notification.object?.id;
 const paymentId=event==='refund.succeeded'?notification.object?.payment_id:id;
 if(!reference(id)||!reference(paymentId))throw new HttpError(400,'INVALID_NOTIFICATION');

 const targets=(await db.query<Target>('SELECT * FROM commerce.yookassa_payment_target($1)',[paymentId])).rows;
 if(targets.length!==1)return;
 const target=targets[0]!;
 if(event==='refund.succeeded'){
  const readRefund=target.kind==='access'?access?.readRefund:topups?.readRefund;
  if(!readRefund)return;
  if(target.state!=='paid'){
   if(target.state==='pending')throw new HttpError(503,'PAYMENT_UNAVAILABLE');
   return;
  }
  const refund=await readRefund(id);
  if(refund?.id!==id||refund.payment_id!==paymentId||refund.status!=='succeeded')throw new HttpError(502,'PAYMENT_UNVERIFIED');
  if(target.kind==='access'){if(target.user_id)await db.query("SELECT set_config('app.user_id',$1,true)",[target.user_id]);if(!await recordTrialRefund(db,refund))await recordAccessRefund(db,refund,seal);}
  else{
   const amount=refundValue(refund);
   if(amount===null)throw new HttpError(502,'PAYMENT_UNVERIFIED');
   await db.query('SELECT commerce.record_topup_refund($1,$2,$3,$4)',[id,paymentId,amount,refund.created_at]);
  }
  return;
 }
 // The notification only identifies a known payment. The provider API supplies its result.
 if(target.state!=='pending')return;
 const provider=target.kind==='access'?access:topups;
 if(!provider)return;
 const payment=await provider.read(paymentId);
 const expected=event==='payment.succeeded'?'succeeded':event==='payment.waiting_for_capture'?'waiting_for_capture':'canceled';
 if(payment.status!==expected){
  if(payment.status!=='succeeded'&&payment.status!=='canceled')throw new HttpError(503,'PAYMENT_UNAVAILABLE');
  return;
 }
 if(target.application_id&&access){
  const row=(await db.query<{data:AccessRequest}>('SELECT data FROM access.request WHERE id=$1 FOR UPDATE',[target.application_id])).rows[0]?.data;
  if(row)await syncAccessCheckout(db,target.id,row,{...access,read:async()=>payment},seal);
 }else if(target.user_id){
  await db.query("SELECT set_config('app.user_id',$1,true)",[target.user_id]);
  const owner=(await db.query<{id:string;email:string}>('SELECT id,email FROM identity.auth_user WHERE id=$1',[target.user_id])).rows[0];
  if(!owner)return;
  if(target.kind==='access'&&access)await syncAccessCheckout(db,target.id,owner,{...access,read:async()=>payment},seal);
  if(target.kind==='topup'&&topups)await aiTopup(db,owner,{id:target.id},{...topups,read:async()=>payment},seal);
 }
}
