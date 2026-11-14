import {createAccessPaymentProvider,verifiedPayment} from './access-payment-provider.ts';
import {createHash} from 'node:crypto';
import {saveCard,savedCard,paymentCards,cardLock} from './payment-cards.ts';
import type {PoolClient} from 'pg';
import {object,uuid} from '../../../packages/finance-core/src/model.ts';
import {HttpError,outbox} from './types.ts';
import type {Sealer} from './types.ts';

import type {AccessPayment as Payment,AccessPaymentProvider} from './access-payment-provider.ts';
export type TestPayments={readRefund?:AccessPaymentProvider['readRefund'];cancel?:AccessPaymentProvider['cancel'];capture?:AccessPaymentProvider['capture'];createRefund?:AccessPaymentProvider['createRefund'];read(id:string):Promise<Payment>;create(input:{id:string;value:string;units:number;method?:string;save?:boolean}):Promise<Payment>};
export function testYooKassa(shopId:string,key:string,origin:string,call=fetch):TestPayments{
 const provider=createAccessPaymentProvider({shopId,secret:key,origin,test:true},call);
 return {read:provider.read,cancel:provider.cancel,capture:provider.capture,createRefund:provider.createRefund,readRefund:provider.readRefund,create:({id,value,units,method,save})=>provider.create({id,value,title:units+' единиц Анализатора',authorize:true,cardOnly:!method,...(method?{method}:{save:save!==false})})};
}
type Order={cancellation_reason?:string|null;card_id?:string|null;id:string;units:number;price_minor:number;status:string;provider_id:string|null;redirect_url:string|null;paid_at:Date|null;created_at:Date};
const value=(minor:number)=>Math.floor(minor/100)+'.'+String(minor%100).padStart(2,'0');
const projection=(order:Order)=>({reason:(order as Order&{cancellation_reason?:string}).cancellation_reason??null,id:order.id,units:order.units,status:order.status,redirect:order.redirect_url});
export async function aiPackCatalog(db:PoolClient,userId:string,provider?:TestPayments,seal?:Sealer){return {
 cards:await paymentCards(db,userId,seal),enabled:!!provider,packages:(await db.query('SELECT catalog_id AS id,units,price_minor AS "priceMinor" FROM commerce.ai_pack WHERE enabled ORDER BY units')).rows,
 pending:(await db.query<Order>("SELECT * FROM commerce.ai_topup_order WHERE user_id=$1 AND status IN ('created','pending') ORDER BY created_at DESC LIMIT 10",[userId])).rows.map(projection),
};}
export async function aiTopup(db:PoolClient,owner:{id:string;email:string},input:unknown,provider:TestPayments|undefined,seal:Sealer){
 if(!provider)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
 await cardLock(db,owner.id);
 const r=object(input,['id','units','packId','priceMinor','cardId','cancel']),id=uuid(r.id),read=async()=>(await db.query<Order>('SELECT * FROM commerce.ai_topup_order WHERE user_id=$1 AND id=$2 FOR UPDATE',[owner.id,id])).rows[0];
 let order=await read();
 if(r.cancel!==undefined&&(r.cancel!==true||r.units!==undefined||r.cardId!==undefined||r.packId!==undefined||r.priceMinor!==undefined))throw new HttpError(400,'INVALID_INPUT');
 if(r.units!==undefined){
  if(typeof r.units!=='number'||!Number.isSafeInteger(r.units)||r.units<1||r.units>1000000||r.packId!==undefined&&typeof r.packId!=='string'||r.priceMinor!==undefined&&(!Number.isSafeInteger(r.priceMinor)||Number(r.priceMinor)<100))throw new HttpError(400,'INVALID_INPUT');
  if(order&&(order.units!==r.units||r.priceMinor!==undefined&&order.price_minor!==r.priceMinor||(order.card_id??null)!==(r.cardId??null)))throw new HttpError(409,'ACTION_REUSED');
  if(!order){
   const pending=(await db.query<Order>("SELECT * FROM commerce.ai_topup_order WHERE user_id=$1 AND status IN ('created','pending') ORDER BY created_at DESC LIMIT 1",[owner.id])).rows[0];if(pending){if(pending.units!==r.units||pending.price_minor!==r.priceMinor||(pending.card_id??null)!==(r.cardId??null))throw new HttpError(409,'PAYMENT_PENDING');return projection(pending);}
   const inserted=await db.query<Order>("INSERT INTO commerce.ai_topup_order(user_id,id,units,price_minor) SELECT $1,$2,units,price_minor FROM commerce.ai_pack WHERE units=$3 AND enabled AND ($4::text IS NULL OR catalog_id=$4) AND ($5::int IS NULL OR price_minor=$5) RETURNING *",[owner.id,id,r.units,r.packId??null,r.priceMinor??null]);order=inserted.rows[0];
   if(!order)throw new HttpError(409,'TARIFF_CHANGED');
   if(r.cardId!==undefined){const card=await savedCard(db,owner.id,r.cardId);await db.query('UPDATE commerce.ai_topup_order SET card_id=$3 WHERE user_id=$1 AND id=$2',[owner.id,id,card.id]);order.card_id=card.id;}
  }
 }
 if(!order)throw new HttpError(404,'NOT_FOUND');
 if(r.units!==undefined||order.status==='paid'||order.status==='cancelled'&&order.cancellation_reason!=='user_canceled')return projection(order);
 const cancelling=r.cancel===true||order.cancellation_reason==='user_canceled';
 async function cancelled(){const row=(await db.query<Order>("UPDATE commerce.ai_topup_order SET status='cancelled',cancellation_reason='user_canceled',redirect_url=NULL WHERE user_id=$1 AND id=$2 RETURNING *",[owner.id,id])).rows[0]!;return projection(row);}
 if(!order.provider_id&&(cancelling||Date.now()-order.created_at.getTime()>23*3600_000))return cancelled();
 const card=order.card_id&&!order.provider_id?await savedCard(db,owner.id,order.card_id):null;
 let payment=order.provider_id?await provider.read(order.provider_id):await provider.create({id,value:value(order.price_minor),units:order.units,...(card?{method:seal.open(card.method_id)}:{save:true})});
 const verify=(p:Payment)=>verifiedPayment(p,{id,providerId:order!.provider_id,value:value(order!.price_minor),test:true});
 let redirect=verify(payment);order.provider_id=payment.id;
 // A completed payment wins a simultaneous user cancellation. Later results of
 // an already cancelled link are voided/refunded and never grant units.
 if(cancelling&&!(r.cancel===true&&order.status!=='cancelled'&&payment.status==='succeeded')){
  if(payment.status==='waiting_for_capture'){
   if(!provider.cancel)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
   payment=await provider.cancel(payment.id,id);verify(payment);
   if(payment.status!=='canceled')throw new HttpError(503,'PAYMENT_UNAVAILABLE');
  }
  if(payment.status==='succeeded'){
   if(!provider.createRefund)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
   const hash=createHash('sha256').update('ai-topup-cancel:'+id).digest('hex'),refundId=[hash.slice(0,8),hash.slice(8,12),'5'+hash.slice(13,16),'a'+hash.slice(17,20),hash.slice(20,32)].join('-');
   const refund=await provider.createRefund({id:refundId,paymentId:payment.id,value:value(order.price_minor)});
   if(refund.payment_id!==payment.id||refund.amount?.currency!=='RUB'||refund.amount.value!==value(order.price_minor)||!['pending','succeeded'].includes(refund.status))throw new HttpError(502,'PAYMENT_UNVERIFIED');
  }
  return cancelled();
 }
 if(payment.status==='waiting_for_capture'){
  if(!provider.capture)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
  payment=await provider.capture(payment.id,id,value(order.price_minor));redirect=verify(payment);
  if(payment.status==='waiting_for_capture')throw new HttpError(503,'PAYMENT_UNAVAILABLE');
 }
 const status=payment.status==='succeeded'&&payment.paid===true?'paid':payment.status==='canceled'?'cancelled':'pending';
 if(status==='paid')await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['customer-ai-budget:'+owner.id]);
 await db.query('UPDATE commerce.ai_topup_order SET cancellation_reason=$3 WHERE user_id=$1 AND id=$2',[owner.id,id,status==='cancelled'?payment.cancellation_details?.reason??'canceled':null]);
 const saved=(await db.query<Order>("UPDATE commerce.ai_topup_order SET provider_id=$3,redirect_url=$4,status=$5,paid_at=CASE WHEN $5='paid' THEN clock_timestamp() ELSE NULL END WHERE user_id=$1 AND id=$2 RETURNING *",[owner.id,id,uuid(payment.id),status==='pending'?redirect:null,status])).rows[0]!;
 if(status==='paid')await saveCard(db,owner.id,payment,seal);
 if(status==='paid')await outbox(db,'identity',seal,'analyzer_topup',{email:owner.email,units:order.units},{subjectId:owner.id,dedupeKey:'ai-topup:'+id});
 return projection(saved);
}
