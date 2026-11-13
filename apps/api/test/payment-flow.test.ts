import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAccessPaymentProvider} from '../src/access-payment-provider.ts';
import {testYooKassa} from '../src/yookassa-topups.ts';
const id='12345678-1234-4234-a234-123456789abc',method='22345678-1234-4234-a234-123456789abc';
test('saved-card interactive checkout offers confirmation; automatic debit does not redirect',async()=>{
 const bodies:any[]=[];
 const provider=createAccessPaymentProvider({shopId:'123456',secret:'test_synthetic_key_123456',origin:'https://example.test',test:true},async(_url,init)=>{bodies.push(JSON.parse(init!.body as string));return new Response(JSON.stringify({id,test:true}));});
 await provider.create({id,value:'1.00',title:'Synthetic verification',method,authorize:true});
 assert.equal(bodies[0].payment_method_id,method);assert.equal(bodies[0].confirmation.type,'redirect');assert.equal(bodies[0].confirmation.return_url,'https://example.test/#payment-return');assert.equal(bodies[0].capture,false);assert.deepEqual(bodies[0].amount,{value:'1.00',currency:'RUB'});
 await provider.create({id,value:'119.00',title:'Synthetic renewal',method});assert.equal(bodies[1].confirmation,undefined);assert.equal(bodies[1].capture,true);
});
test('saved-card Analyzer package uses redirect confirmation, exact amount and one idempotency key',async()=>{
 const provider=testYooKassa('123456','test_synthetic_key_123456','https://example.test',async(_url,init)=>{const b=JSON.parse(init!.body as string);assert.equal(b.payment_method_id,method);assert.equal(b.confirmation.type,'redirect');assert.deepEqual(b.amount,{value:'69.00',currency:'RUB'});assert.equal(b.metadata.orderId,id);assert.equal((init!.headers as Record<string,string>)['Idempotence-Key'],id);assert.match(b.description,/2000/);return new Response(JSON.stringify({id,test:true}));});
 await provider.create({id,value:'69.00',units:2000,method});
});
test('an unusable saved token produces a safe actionable card error',async()=>{
 const p=createAccessPaymentProvider({shopId:'123456',secret:'test_synthetic_key_123456',origin:'https://example.test',test:true},async()=>new Response(JSON.stringify({parameter:'payment_method_id'}),{status:400}));
 await assert.rejects(p.create({id,value:'1.00',title:'Synthetic',method,authorize:true}),{code:'CARD_UNAVAILABLE'});
});
