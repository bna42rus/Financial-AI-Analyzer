import {createHash} from 'node:crypto';
import {HttpError} from './types.ts';
import {uuid} from '../../../packages/finance-core/src/model.ts';
export type PaymentMethod = NonNullable<AccessPayment['payment_method']>;
export type AccessPayment = {id:string;test:boolean;paid:boolean;status:string;amount:{currency:string;value:string};metadata?:{orderId?:string};captured_at?:string;created_at?:string;cancellation_details?:{reason?:string};confirmation?:{confirmation_url?:string;expires_at?:string};payment_method?:{id?:string;saved?:boolean;card?:{card_type?:string;first6?:string;last4?:string;expiry_month?:string;expiry_year?:string}}};
export type ProviderRefund={id:string;payment_id:string;created_at:string;status:string;amount:{value:string;currency:string}};
export type AccessPaymentProvider={test:boolean;readMethod?:(id:string)=>Promise<PaymentMethod>;capture?:(id:string,key:string,value:string)=>Promise<AccessPayment>;cancel?:(id:string,key:string)=>Promise<AccessPayment>;createRefund?:(input:{id:string;paymentId:string;value:string})=>Promise<ProviderRefund>;readRefund?:(id:string)=>Promise<ProviderRefund>;refunds?:(since:string,cursor?:string)=>Promise<{items:ProviderRefund[];next_cursor?:string}>;read(id:string):Promise<AccessPayment>;create(input:{id:string;value:string;title:string;save?:boolean;method?:string;first?:boolean;authorize?:boolean;cardOnly?:boolean}):Promise<AccessPayment>};
export function createAccessPaymentProvider(input:{shopId:string;secret:string;origin:string;test:boolean},fetcher=fetch):AccessPaymentProvider{
 const {shopId,secret,origin,test}=input,url=new URL(origin);
 if(!/^\d{3,16}$/.test(shopId)||!(test?/^test_[A-Za-z0-9_-]{12,200}$/:/^live_[A-Za-z0-9_-]{12,200}$/).test(secret)||url.protocol!=='https:'||url.origin!==origin)throw Error('PAYMENT_CONFIGURATION_DENIED');
 const authorization='Basic '+Buffer.from(shopId+':'+secret).toString('base64');
 async function send(id:string,body?:Record<string,unknown>){
  let response:Response;
  try{response=await fetcher('https://api.yookassa.ru/v3/payments'+(body?'':'/'+uuid(id)),{method:body?'POST':'GET',headers:{Authorization:authorization,...(body?{'Content-Type':'application/json','Idempotence-Key':id}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(7000),redirect:'error'});}catch{throw new HttpError(503,'PAYMENT_UNAVAILABLE');}
  if(!response.ok){let failure:{parameter?:string}={};try{failure=await response.json() as typeof failure;}catch{}if(body&&response.status===400&&failure.parameter==='payment_method_id')throw new HttpError(409,'CARD_UNAVAILABLE');throw new HttpError(503,'PAYMENT_UNAVAILABLE');}
  try{const value=await response.json() as AccessPayment;if(value.test!==test||uuid(value.id)!==value.id)throw Error();return value;}catch{throw new HttpError(502,'PAYMENT_UNVERIFIED');}
 }
 async function readRefund(id:string){
  let response:Response;
  try{response=await fetcher('https://api.yookassa.ru/v3/refunds/'+uuid(id),{headers:{Authorization:authorization},signal:AbortSignal.timeout(7000),redirect:'error'});}catch{throw new HttpError(503,'PAYMENT_UNAVAILABLE');}
  if(!response.ok)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
  try{return await response.json() as ProviderRefund;}catch{throw new HttpError(502,'PAYMENT_UNVERIFIED');}
 }
 async function refunds(since:string,cursor?:string){
  const query=new URLSearchParams({'created_at.gte':since,limit:'50'});
  if(cursor)query.set('cursor',cursor);
  const response=await fetcher('https://api.yookassa.ru/v3/refunds?'+query,{headers:{Authorization:authorization},signal:AbortSignal.timeout(7000),redirect:'error'});
  if(!response.ok)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
  const data=await response.json();
  if(!data||!Array.isArray(data.items)||data.items.length>50||data.next_cursor!==undefined&&(typeof data.next_cursor!=='string'||data.next_cursor.length>500))throw new HttpError(502,'PAYMENT_UNVERIFIED');
  return data as {items:ProviderRefund[];next_cursor?:string};
 }
 async function createRefund({id,paymentId,value}:{id:string;paymentId:string;value:string}){
  let response:Response;
  try{response=await fetcher('https://api.yookassa.ru/v3/refunds',{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json','Idempotence-Key':uuid(id)},body:JSON.stringify({payment_id:uuid(paymentId),amount:{value,currency:'RUB'}}),signal:AbortSignal.timeout(7000),redirect:'error'});}catch{throw new HttpError(503,'PAYMENT_UNAVAILABLE');}
  if(!response.ok)throw new HttpError(503,'PAYMENT_UNAVAILABLE');return await response.json() as ProviderRefund;
 }
 async function operation(id:string,key:string,action:string,body:Record<string,unknown>){
  const h=createHash('sha256').update('cashneuro-payment-operation:'+uuid(key)+':'+action).digest('hex');
  const operationKey=[h.slice(0,8),h.slice(8,12),'5'+h.slice(13,16),'a'+h.slice(17,20),h.slice(20,32)].join('-');
  let response:Response;try{response=await fetcher('https://api.yookassa.ru/v3/payments/'+uuid(id)+'/'+action,{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json','Idempotence-Key':operationKey},body:JSON.stringify(body),signal:AbortSignal.timeout(7000),redirect:'error'});}catch{throw new HttpError(503,'PAYMENT_UNAVAILABLE');}
  if(!response.ok)throw new HttpError(503,'PAYMENT_UNAVAILABLE');return await response.json() as AccessPayment;
 }
 return {test,readMethod:async(id)=>{const response=await fetcher('https://api.yookassa.ru/v3/payment_methods/'+uuid(id),{headers:{Authorization:authorization},signal:AbortSignal.timeout(2500),redirect:'error'});if(!response.ok)throw new HttpError(503,'PAYMENT_UNAVAILABLE');const method=await response.json() as PaymentMethod;if(method.id!==id)throw new HttpError(502,'PAYMENT_UNVERIFIED');return method;},capture:(id,key,value)=>operation(id,key,'capture',{amount:{value,currency:'RUB'}}),cancel:(id,key)=>operation(id,key,'cancel',{}),createRefund,refunds,readRefund,read:id=>send(id),create:({id,value,title,save,method,first,authorize,cardOnly})=>send(id,{amount:{value,currency:'RUB'},capture:!authorize,description:'CashNeuro: '+title,metadata:{orderId:id},...(cardOnly&&!method?{payment_method_data:{type:'bank_card'}}:{}),...(method?{payment_method_id:method}:save?{save_payment_method:true}:{}),...(!method?{confirmation:{type:'redirect',return_url:origin+(first?'/#checkout?payment='+id:'/#payment-return')}}:{})})};
}
export function verifiedPayment(payment:AccessPayment,expected:{id:string;providerId:string|null;value:string;test:boolean}){
 if(payment.test!==expected.test||uuid(payment.id)!==payment.id||expected.providerId&&payment.id!==expected.providerId||payment.metadata?.orderId!==expected.id||payment.amount?.currency!=='RUB'||payment.amount.value!==expected.value||!['pending','succeeded','canceled','waiting_for_capture'].includes(payment.status)||payment.status==='succeeded'&&payment.paid!==true)throw new HttpError(502,'PAYMENT_UNVERIFIED');
 if(payment.confirmation?.confirmation_url){const url=new URL(payment.confirmation.confirmation_url);if(url.protocol!=='https:'||!['yookassa.ru','yoomoney.ru'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host))||url.username||url.password)throw new HttpError(502,'PAYMENT_UNVERIFIED');return url.href;}
 return null;
}
