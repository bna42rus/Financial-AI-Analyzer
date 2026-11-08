import type {PoolClient} from 'pg';
import {object,uuid} from '../../../packages/finance-core/src/model.ts';
import {HttpError,outbox} from './types.ts';
import type {Sealer} from './types.ts';

type Payment={id:string;test:boolean;paid:boolean;status:string;amount:{currency:string;value:string};metadata:{orderId:string};confirmation?:{confirmation_url:string}};
export type TestPayments={read(id:string):Promise<Payment>;create(input:{id:string;value:string;units:number}):Promise<Payment>};
export function testYooKassa(shopId:string,key:string,origin:string,call=fetch):TestPayments{
 if(!/^\d{3,16}$/.test(shopId)||!/^test_[A-Za-z0-9_-]{12,200}$/.test(key)||new URL(origin).origin!==origin||!origin.startsWith('https://'))throw new Error('YOOKASSA_TEST_CONFIGURATION_REQUIRED');
 const auth='Basic '+Buffer.from(shopId+':'+key).toString('base64');
 async function send(path:string,body?:object,id?:string){
  let response:Response;try{response=await call('https://api.yookassa.ru/v3/payments'+path,{method:body?'POST':'GET',headers:{Authorization:auth,...(body?{'Content-Type':'application/json','Idempotence-Key':id!}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(7000)});}catch{throw new HttpError(503,'PAYMENT_UNAVAILABLE');}
  if(!response.ok)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
  try{const payment=await response.json() as Payment;if(payment.test!==true||uuid(payment.id)!==payment.id)throw Error();return payment;}catch{throw new HttpError(502,'PAYMENT_UNVERIFIED');}
 }
 return {read:id=>send('/'+uuid(id)),create:({id,value,units})=>send('',{amount:{value,currency:'RUB'},capture:true,confirmation:{type:'redirect',return_url:origin+'/#analyzer/payment'},description:'CashNeuro: '+units+' единиц Анализатора',metadata:{orderId:id}},id)};
}
type Order={id:string;units:number;price_minor:number;status:string;provider_id:string|null;redirect_url:string|null;paid_at:Date|null;created_at:Date};
const value=(minor:number)=>Math.floor(minor/100)+'.'+String(minor%100).padStart(2,'0');
const projection=(order:Order)=>({id:order.id,units:order.units,status:order.status,redirect:order.redirect_url});
export async function aiPackCatalog(db:PoolClient,userId:string,provider?:TestPayments){return {
 enabled:!!provider,packages:(await db.query('SELECT units,price_minor AS "priceMinor" FROM commerce.ai_pack WHERE enabled ORDER BY units')).rows,
 pending:(await db.query<Order>("SELECT * FROM commerce.ai_topup_order WHERE user_id=$1 AND status IN ('created','pending') ORDER BY created_at DESC LIMIT 10",[userId])).rows.map(projection),
};}
export async function aiTopup(db:PoolClient,owner:{id:string;email:string},input:unknown,provider:TestPayments|undefined,seal:Sealer){
 if(!provider)throw new HttpError(503,'PAYMENT_UNAVAILABLE');
 const r=object(input,['id','units']),id=uuid(r.id),read=async()=>(await db.query<Order>('SELECT * FROM commerce.ai_topup_order WHERE user_id=$1 AND id=$2 FOR UPDATE',[owner.id,id])).rows[0];
 let order=await read();
 if(r.units!==undefined){
  if(typeof r.units!=='number'||![1000,2000,5000,10000].includes(r.units))throw new HttpError(400,'INVALID_INPUT');
  if(order&&order.units!==r.units)throw new HttpError(409,'ACTION_REUSED');
  if(!order){
   const inserted=await db.query<Order>("INSERT INTO commerce.ai_topup_order(user_id,id,units,price_minor) SELECT $1,$2,units,price_minor FROM commerce.ai_pack WHERE units=$3 AND enabled RETURNING *",[owner.id,id,r.units]);order=inserted.rows[0];
   if(!order)throw new HttpError(404,'NOT_FOUND');
  }
 }
 if(!order)throw new HttpError(404,'NOT_FOUND');
 if(r.units!==undefined||['paid','cancelled'].includes(order.status))return projection(order);
 if(!order.provider_id&&Date.now()-order.created_at.getTime()>23*3600_000)throw new HttpError(409,'PAYMENT_RETRY_REQUIRED');
 const payment=order.provider_id?await provider.read(order.provider_id):await provider.create({id,value:value(order.price_minor),units:order.units});
 if(payment.test!==true||payment.amount?.value!==value(order.price_minor)||payment.amount?.currency!=='RUB'||payment.metadata?.orderId!==id||order.provider_id&&payment.id!==order.provider_id)throw new HttpError(502,'PAYMENT_UNVERIFIED');
 let redirect:string|null=order.redirect_url;
 if(payment.confirmation?.confirmation_url){const url=new URL(payment.confirmation.confirmation_url);if(url.protocol!=='https:'||!['yookassa.ru','yoomoney.ru'].some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain))||url.username||url.password)throw new HttpError(502,'PAYMENT_UNVERIFIED');redirect=url.href;}
 const status=payment.status==='succeeded'&&payment.paid===true?'paid':payment.status==='canceled'?'cancelled':'pending';
 if(status==='paid')await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['customer-ai-budget:'+owner.id]);
 const saved=(await db.query<Order>("UPDATE commerce.ai_topup_order SET provider_id=$3,redirect_url=$4,status=$5,paid_at=CASE WHEN $5='paid' THEN clock_timestamp() ELSE NULL END WHERE user_id=$1 AND id=$2 RETURNING *",[owner.id,id,uuid(payment.id),status==='pending'?redirect:null,status])).rows[0]!;
 if(status==='paid')await outbox(db,'identity',seal,'analyzer_topup',{email:owner.email,units:order.units},{subjectId:owner.id,dedupeKey:'ai-topup:'+id});
 return projection(saved);
}
