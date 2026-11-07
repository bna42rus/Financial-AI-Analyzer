import {HttpError} from './types.ts';
import {uuid} from '../../../packages/finance-core/src/model.ts';
export type AccessPayment = {id:string;test:boolean;paid:boolean;status:string;amount:{currency:string;value:string};metadata?:{orderId?:string};confirmation?:{confirmation_url?:string};payment_method?:{id?:string;saved?:boolean}};
export type AccessPaymentProvider={test:boolean;read(id:string):Promise<AccessPayment>;create(input:{id:string;value:string;title:string;save?:boolean;method?:string;first?:boolean}):Promise<AccessPayment>};
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
 return {test,read:id=>send(id),create:({id,value,title,save,method,first})=>send(id,{amount:{value,currency:'RUB'},capture:true,description:'CashNeuro: '+title,metadata:{orderId:id},...(method?{payment_method_id:method}:{confirmation:{type:'redirect',return_url:origin+(first?'/#access?payment=return':'/#account?payment=return')},...(save?{save_payment_method:true}:{})})})};
}
export function verifiedPayment(payment:AccessPayment,expected:{id:string;providerId:string|null;value:string;test:boolean}){
 if(payment.test!==expected.test||uuid(payment.id)!==payment.id||expected.providerId&&payment.id!==expected.providerId||payment.metadata?.orderId!==expected.id||payment.amount?.currency!=='RUB'||payment.amount.value!==expected.value||!['pending','succeeded','canceled','waiting_for_capture'].includes(payment.status)||payment.status==='succeeded'&&payment.paid!==true)throw new HttpError(502,'PAYMENT_UNVERIFIED');
 if(payment.confirmation?.confirmation_url){const url=new URL(payment.confirmation.confirmation_url);if(url.protocol!=='https:'||!['yookassa.ru','yoomoney.ru'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host))||url.username||url.password)throw new HttpError(502,'PAYMENT_UNVERIFIED');return url.href;}
 return null;
}
