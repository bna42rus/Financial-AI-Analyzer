import {HttpError} from './types.ts';
import {uuid} from '../../../packages/finance-core/src/model.ts';
export type AccessPayment = {id:string;test:boolean;paid:boolean;status:string;amount:{currency:string;value:string};metadata?:{orderId?:string};captured_at?:string;cancellation_details?:{reason?:string};confirmation?:{confirmation_url?:string;expires_at?:string};payment_method?:{id?:string;saved?:boolean;card?:{first6?:string;last4?:string;expiry_month?:string;expiry_year?:string}}};
export type ProviderRefund={id:string;payment_id:string;created_at:string;status:string;amount:{value:string;currency:string}};
export type AccessPaymentProvider={test:boolean;createRefund?:(input:{id:string;paymentId:string;value:string})=>Promise<ProviderRefund>;readRefund?:(id:string)=>Promise<ProviderRefund>;refunds?:(since:string,cursor?:string)=>Promise<{items:ProviderRefund[];next_cursor?:string}>;read(id:string):Promise<AccessPayment>;create(input:{id:string;value:string;title:string;save?:boolean;method?:string;first?:boolean}):Promise<AccessPayment>};
export function createAccessPaymentProvider(input:{shopId:string;secret:string;origin:string;test:boolean},fetcher=fetch):AccessPaymentProvider{
 const {shopId,secret,origin,test}=input,url=new URL(origin);
 if(!/^\d{3,16}$/.test(shopId)||!(test?/^test_[A-Za-z0-9_-]{12,200}$/:/^live_[A-Za-z0-9_-]{12,200}$/).test(secret)||url.protocol!=='https:'||url.origin!==origin)throw Error('PAYMENT_CONFIGURATION_DENIED');
 const authorization='Basic '+Buffer.from(shopId+':'+secret).toString('base64');
 async function send(id:string,body?:Record<string,unknown>){
  let response:Response;
  try{response=await fetcher('https://api.yookassa.ru/v3/payments'+(body?'':'/'+uuid(id)),{method:body?'POST':'GET',headers:{Authorization:authorization,...(body?{'Content-Type':'application/json','Idempotence-Key':id}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(7000),redirect:'error'});}catch{throw new HttpError(503,'PAYMENT_UNAVAILABLE');}
  if(!response.ok)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
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
 return {test,createRefund,refunds,readRefund,read:id=>send(id),create:({id,value,title,save,method,first})=>send(id,{amount:{value,currency:'RUB'},capture:true,description:'CashNeuro: '+title,metadata:{orderId:id},...(method?{payment_method_id:method}:{confirmation:{type:'redirect',return_url:origin+(first?'/#checkout?payment='+id:'/#account?payment=return')},...(save?{save_payment_method:true}:{})})})};
}
export function verifiedPayment(payment:AccessPayment,expected:{id:string;providerId:string|null;value:string;test:boolean}){
 if(payment.test!==expected.test||uuid(payment.id)!==payment.id||expected.providerId&&payment.id!==expected.providerId||payment.metadata?.orderId!==expected.id||payment.amount?.currency!=='RUB'||payment.amount.value!==expected.value||!['pending','succeeded','canceled','waiting_for_capture'].includes(payment.status)||payment.status==='succeeded'&&payment.paid!==true)throw new HttpError(502,'PAYMENT_UNVERIFIED');
 if(payment.confirmation?.confirmation_url){const url=new URL(payment.confirmation.confirmation_url);if(url.protocol!=='https:'||!['yookassa.ru','yoomoney.ru'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host))||url.username||url.password)throw new HttpError(502,'PAYMENT_UNVERIFIED');return url.href;}
 return null;
}
