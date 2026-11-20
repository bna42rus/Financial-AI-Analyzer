import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAccessPaymentProvider} from '../src/access-payment-provider.ts';
import {aiTopup,testYooKassa} from '../src/yookassa-topups.ts';
const id='12345678-1234-4234-a234-123456789abc',method='22345678-1234-4234-a234-123456789abc';
test('saved-card checkout omits confirmation for both authorization and automatic debit',async()=>{
 const bodies:any[]=[];
 const provider=createAccessPaymentProvider({shopId:'123456',secret:'test_synthetic_key_123456',origin:'https://example.test',test:true},async(_url,init)=>{bodies.push(JSON.parse(init!.body as string));return new Response(JSON.stringify({id,test:true}));});
 await provider.create({id,value:'1.00',title:'Synthetic verification',method,authorize:true});
 assert.equal(bodies[0].payment_method_id,method);assert.equal(bodies[0].confirmation,undefined);assert.equal(bodies[0].capture,false);assert.deepEqual(bodies[0].amount,{value:'1.00',currency:'RUB'});
 await provider.create({id,value:'119.00',title:'Synthetic renewal',method});assert.equal(bodies[1].confirmation,undefined);assert.equal(bodies[1].capture,true);
});
test('saved-card Analyzer package authorizes without redirect, with exact amount and one idempotency key',async()=>{
 const provider=testYooKassa('123456','test_synthetic_key_123456','https://example.test',async(_url,init)=>{const b=JSON.parse(init!.body as string);assert.equal(b.payment_method_id,method);assert.equal(b.confirmation,undefined);assert.equal(b.capture,false);assert.deepEqual(b.amount,{value:'69.00',currency:'RUB'});assert.equal(b.metadata.orderId,id);assert.equal((init!.headers as Record<string,string>)['Idempotence-Key'],id);assert.match(b.description,/2000/);return new Response(JSON.stringify({id,test:true}));});
 await provider.create({id,value:'69.00',units:2000,method});
});
test('an unusable saved token produces a safe actionable card error',async()=>{
 const p=createAccessPaymentProvider({shopId:'123456',secret:'test_synthetic_key_123456',origin:'https://example.test',test:true},async()=>new Response(JSON.stringify({parameter:'payment_method_id'}),{status:400}));
 await assert.rejects(p.create({id,value:'1.00',title:'Synthetic',method,authorize:true}),{code:'CARD_UNAVAILABLE'});
});

test('new-card checkout keeps its hosted confirmation page',async()=>{
 const p=createAccessPaymentProvider({shopId:'123456',secret:'test_synthetic_key_123456',origin:'https://example.test',test:true},async(_url,init)=>{
  const body=JSON.parse(init!.body as string);assert.equal(body.confirmation.type,'redirect');assert.equal(body.confirmation.return_url,'https://example.test/#payment-return');assert.equal(body.save_payment_method,true);assert.equal(body.payment_method_id,undefined);return new Response(JSON.stringify({id,test:true}));
 });await p.create({id,value:'119.00',title:'Synthetic',save:true,authorize:true});
});
function topupFixture(status='pending',providerId:string|null=method){
 const row={id,user_id:'owner',status,provider_id:providerId,units:2000,price_minor:6900,created_at:new Date(),paid_at:null,redirect_url:'https://yookassa.ru/test',cancellation_reason:null as string|null};
 const queries:string[]=[];
 const db={query:async(sql:string)=>{queries.push(sql);if(sql.startsWith('SELECT * FROM commerce.ai_topup_order'))return {rows:[{...row}]};if(sql.includes("SET status='cancelled'")){row.status='cancelled';row.cancellation_reason='user_canceled';row.redirect_url=null as any;return {rows:[{...row}]};}return {rows:[]};}} as any;
 const payment={id:method,test:true,paid:false,status:'pending',metadata:{orderId:id},amount:{currency:'RUB',value:'69.00'}};
 return {row,db,payment,queries};
}
const owner={id:'owner',email:'synthetic@example.test'},seal={} as any;
test('cancel an unopened package locally without creating a provider payment',async()=>{
 const f=topupFixture('created',null);const provider={create:async()=>{throw Error('must not create');},read:async()=>{throw Error('must not read');}};
 const result=await aiTopup(f.db,owner,{id,cancel:true},provider,seal);assert.equal(result.status,'cancelled');assert.equal(result.redirect,null);
});
test('cancel pending package, allow a replacement and never capture its late authorization',async()=>{
 const f=topupFixture();let voids=0;const provider={create:async()=>{throw Error('must not create');},read:async()=>f.payment,cancel:async()=>{voids++;return {...f.payment,status:'canceled'};},capture:async()=>{throw Error('must not capture');}};
 assert.equal((await aiTopup(f.db,owner,{id,cancel:true},provider,seal)).status,'cancelled');
 f.payment.status='waiting_for_capture';assert.equal((await aiTopup(f.db,owner,{id},provider,seal)).status,'cancelled');assert.equal(voids,1);
 assert.ok(!f.queries.some(sql=>sql.includes("status=$5")||sql.includes('outbox')));
});
test('a late successful legacy payment after cancellation is refunded with a stable key',async()=>{
 const f=topupFixture('cancelled');f.row.cancellation_reason='user_canceled';f.payment.status='succeeded';f.payment.paid=true;const keys:string[]=[];
 const provider={create:async()=>{throw Error('must not create');},read:async()=>f.payment,createRefund:async(x:any)=>{keys.push(x.id);assert.equal(x.paymentId,method);assert.equal(x.value,'69.00');return {id:x.id,payment_id:method,amount:f.payment.amount,status:'pending',created_at:new Date().toISOString()};}};
 assert.equal((await aiTopup(f.db,owner,{id},provider,seal)).status,'cancelled');assert.equal((await aiTopup(f.db,owner,{id},provider,seal)).status,'cancelled');assert.equal(keys[0],keys[1]);assert.ok(!f.queries.some(sql=>sql.includes('outbox')));
});
