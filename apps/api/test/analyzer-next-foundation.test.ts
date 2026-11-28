import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {PrototypeSession} from '../../../packages/analyzer/src/next/workflow.ts';
import {intentVersion} from '../../../packages/analyzer/src/next/intent.ts';
import {scope,catalog,id} from '../../../packages/analyzer/test/fixtures/next-finances.ts';
import {emptyConversation} from '../../../packages/analyzer/src/assistant-conversation.ts';
import {sealNextSession,restoreNextSession,nextCheckpointVersion} from '../src/analyzer-next-checkpoint.ts';
import {nextModelCall,nextCallFingerprint} from '../src/analyzer-next-model-call.ts';
import {withAssistantJournal} from '../src/assistant-journal.ts';
import type {AssistantRequest,AssistantModel,CompletionInput} from '../src/assistant-workflow.ts';

const env=(n:number,question:string)=>({scope,requestId:id(n),question,date:'2026-11-28',global:{revision:0,filter:{},touched:{}},dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog});
const intent=(action:string,parameters:unknown,binding:unknown={mode:'new'})=>({version:intentVersion,action,binding,parameters,presentation:{format:'auto',detail:'normal'}});
async function turn(session:PrototypeSession,n:number,question:string,value:unknown){
 const environment=env(n,question);
 return session.run(environment,{async understand(){return {relevance:'financial',intent:value};}},{current:()=>environment,async authorize(){},async review(){return true;},tools:{async guard(){},async read(){throw Error('No financial read for a hypothetical loan');}}});
}
test('a private checkpoint preserves pending clarification, explanation, and the resumed loan across fresh sessions',async()=>{
 const key=randomBytes(32),beforeKey=Buffer.from(key);let session=new PrototypeSession(scope);
 const waiting=await turn(session,1300,'Кредит 100000 на 12 месяцев',intent('calculate',{calculator:'loan',edits:[{field:'principalRubles',op:'set',value:'100000',quote:'100000'},{field:'months',op:'set',value:12,quote:'12 месяцев'}]}));assert.equal(waiting.status,'waiting');
 const saved=sealNextSession(session,key),pending=session.snapshot().pending!.handle;
 session=restoreNextSession(scope,JSON.parse(JSON.stringify(saved)),key);assert.equal(session.snapshot().pending!.handle,pending);
 const explanation=await turn(session,1301,'Что такое аннуитет?',intent('explain',{subject:{kind:'concept',question:'Что такое аннуитет?'}}));assert.equal(explanation.status,'explanation');assert.deepEqual(sealNextSession(session,key),saved);
 session=restoreNextSession(scope,saved,key);
 const completed=await turn(session,1302,'Ставка 10%',intent('calculate',{calculator:'loan',edits:[{field:'annualRatePercent',op:'set',value:'10',quote:'10%'}]},{mode:'answer',clarification:pending,option:null}));assert.equal(completed.status,'completed');
 const restored=restoreNextSession(scope,sealNextSession(session,key),key);assert.deepEqual(restored.snapshot(),session.snapshot());assert.equal(restored.snapshot().history.length,1);assert.equal(restored.snapshot().pending,null);assert.deepEqual(key,beforeKey);
});
test('a checkpoint refuses a foreign owner, chat, epoch, generation, key, version or altered payload',()=>{
 const key=randomBytes(32),checkpoint=sealNextSession(new PrototypeSession(scope),key);
 for(const changed of [{...scope,ownerId:'another-owner'},{...scope,chatId:id(99)},{...scope,chatEpoch:id(99)},{...scope,generation:id(99)}])assert.throws(()=>restoreNextSession(changed,checkpoint,key),/^TypeError: NEXT_CHECKPOINT_INVALID$/);
 for(const raw of [{...checkpoint,version:'cashneuro-assistant-workflow/7'},{...checkpoint,payload:checkpoint.payload+' '},{...checkpoint,mac:'f'.repeat(64)},{...checkpoint,sql:'private-value'},JSON.parse(checkpoint.payload)])assert.throws(()=>restoreNextSession(scope,raw,key),/^TypeError: NEXT_CHECKPOINT_INVALID$/);
 assert.throws(()=>restoreNextSession(scope,checkpoint,randomBytes(32)),/NEXT_CHECKPOINT_INVALID/);assert.throws(()=>sealNextSession(new PrototypeSession(scope),new Uint8Array(1)),/NEXT_CHECKPOINT_INVALID/);
 assert.equal(checkpoint.version,nextCheckpointVersion);assert.equal(JSON.stringify(checkpoint).includes(key.toString('hex')),false);
});
test('running work cannot be sealed or restored as a successful durable context',async()=>{
 const key=randomBytes(32),session=new PrototypeSession(scope),environment=env(1303,'Кредит 100000 под 10% на 12 месяцев');
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),inside=new Promise<void>(r=>entered=r);
 const work=session.run(environment,{async understand(){return {relevance:'financial',intent:intent('calculate',{calculator:'loan',edits:[{field:'principalRubles',op:'set',value:'100000',quote:'100000'},{field:'annualRatePercent',op:'set',value:'10',quote:'10%'},{field:'months',op:'set',value:12,quote:'12 месяцев'}]})};}},{current:()=>environment,async authorize(){},async review(){return true;},tools:{async guard(){entered();await waiting;},async read(){throw Error('no read');}}});
 await inside;
 try{assert.throws(()=>sealNextSession(session,key),/NEXT_CHECKPOINT_BUSY/);assert.throws(()=>PrototypeSession.fromTrustedCheckpoint(scope,session.snapshot()),/TASK_CHECKPOINT_BUSY/);}
 finally{release();}
 assert.equal((await work).status,'completed');assert.deepEqual(restoreNextSession(scope,sealNextSession(session,key),key).snapshot(),session.snapshot());
});

const first:CompletionInput={phase:'understand',prompt:'Synthetic understanding',input:{question:'synthetic'},schema:{type:'object'}};
const review:CompletionInput={phase:'check_changes',prompt:'Synthetic semantic review',input:{question:'synthetic',intent:{synthetic:true}},schema:{type:'object'}};
const bound={modelVersion:'synthetic-next-model',inputTokens:1000,outputTokens:500},usage={modelVersion:bound.modelVersion,inputTokens:100,outputTokens:50};
const request:AssistantRequest={requestId:id(1400),scope,conversation:emptyConversation(scope),global:{revision:0,filter:{},touched:{}},dataRevision:'synthetic/1',question:'Учебный вопрос',now:new Date('2026-11-28T09:00:00Z'),timezone:'Europe/Moscow'};
async function directory(action:(path:string)=>Promise<void>){const path=await mkdtemp(join(tmpdir(),'cashneuro-next-'));try{await chmod(path,0o700);await action(path);}finally{await rm(path,{recursive:true,force:true});}}
test('fresh journal instances replay both durable call slots without a new reservation or transport',async()=>{
 await directory(async path=>{
  const events:string[]=[],accounting={async reserve(_id:string,index:number){events.push('reserve:'+index);},async settle(_id:string,index:number,value:unknown){events.push((value?'settle:':'hold:')+index);}};
  const model:AssistantModel={bound,async complete(input,before){await before();events.push('http:'+input.phase);return {value:{accepted:true},usage};}};
  await withAssistantJournal(path,request,accounting,async journal=>{await nextModelCall(model,journal,first);await nextModelCall(model,journal,review,1);});
  assert.deepEqual(events,['reserve:0','http:understand','settle:0','reserve:1','http:check_changes','settle:1']);events.length=0;
  model.complete=async()=>{throw Error('No transport is permitted during replay');};
  await withAssistantJournal(path,request,accounting,async journal=>{
   const a=await nextModelCall(model,journal,first,0,'replay_only'),b=await nextModelCall(model,journal,review,1,'replay_only');assert.ok(a.replayed&&b.replayed);
   (a.value as any).accepted=false;assert.equal((journal.receipt.calls[0]!.value as any).accepted,true);assert.equal(journal.receipt.calls[0]!.phase,'understand');assert.equal(journal.receipt.calls[1]!.phase,'check_changes');
   const reordered:CompletionInput={schema:{type:'object'},input:{intent:{synthetic:true},question:'synthetic'},prompt:review.prompt,phase:'check_changes'};
   assert.equal((await nextModelCall(model,journal,reordered,1,'replay_only')).replayed,true);
   assert.notEqual(nextCallFingerprint({...review,input:{scenarios:['t1','t2']}}),nextCallFingerprint({...review,input:{scenarios:['t2','t1']}}));
   assert.notEqual(nextCallFingerprint({...review,input:{comparison:null}}),nextCallFingerprint({...review,input:{}}));
   await assert.rejects(nextModelCall(model,journal,{...review,prompt:'changed'},1),/ASSISTANT_REQUEST_CHANGED/);
  });assert.deepEqual(events,[]);
 });
});
test('a saved sent review keeps its hold and never dispatches again after restart',async()=>{
 await directory(async path=>{
  let reserves=0,transports=0;const accounting={async reserve(){reserves++;},async settle(){}};
  const model:AssistantModel={bound,async complete(_input,before){await before();transports++;return {value:{accepted:true},usage};}};
  await withAssistantJournal(path,request,accounting,async journal=>{
   await nextModelCall(model,journal,first);await journal.reserve(1,bound);
   journal.receipt.calls.push({fingerprint:nextCallFingerprint(review),phase:'check_changes',state:'sent'});await journal.persist();
  });
  await withAssistantJournal(path,request,accounting,async journal=>{await assert.rejects(nextModelCall(model,journal,review,1),/ASSISTANT_DELIVERY_UNKNOWN/);assert.equal(journal.receipt.calls[1]!.state,'sent');});
  assert.equal(reserves,2);assert.equal(transports,1);
 });
});
test('review cannot dispatch without received understanding, exceed two calls, or fill a replay-only missing slot',async()=>{
 await directory(async path=>{
  let reserves=0,transports=0;const accounting={async reserve(){reserves++;},async settle(){}};
  const model:AssistantModel={bound,async complete(_input,before){await before();transports++;return {value:{accepted:true},usage};}};
  await withAssistantJournal(path,request,accounting,async journal=>{
   await assert.rejects(nextModelCall(model,journal,review,1),/ASSISTANT_CALL_LIMIT/);
   await nextModelCall(model,journal,first);
   await assert.rejects(nextModelCall(model,journal,review,1,'replay_only'),/PILOT_REPLAY_MISSING/);
   await assert.rejects(nextModelCall(model,journal,first,1),/ASSISTANT_CALL_LIMIT/);
   await assert.rejects(nextModelCall(model,journal,review,2 as never),/ASSISTANT_CALL_LIMIT/);
  });assert.equal(reserves,1);assert.equal(transports,1);
 });
});
test('review usage is settled in its own slot and provider drift cannot corrupt or repay understanding',async()=>{
 await directory(async path=>{
  const settled:number[]=[];let transports=0,reserves=0;
  const accounting={async reserve(){reserves++;},async settle(_id:string,index:number){settled.push(index);}};
  const model:AssistantModel={bound,async complete(input,before){await before();transports++;return {value:{accepted:true},usage:input.phase==='understand'?usage:{...usage,modelVersion:'unexpected-model'}};}};
  let firstReceipt:unknown;
  await withAssistantJournal(path,request,accounting,async journal=>{
   await nextModelCall(model,journal,first);firstReceipt=structuredClone(journal.receipt.calls[0]);
   await assert.rejects(nextModelCall(model,journal,review,1),/ASSISTANT_PROVIDER_CHANGED/);
   assert.deepEqual(journal.receipt.calls[0],firstReceipt);assert.equal(journal.receipt.calls[1]!.state,'failed');
  });
  await withAssistantJournal(path,request,accounting,async journal=>{
   await assert.rejects(nextModelCall(model,journal,review,1),/ASSISTANT_PROVIDER_CHANGED/);assert.deepEqual(journal.receipt.calls[0],firstReceipt);
  });assert.deepEqual(settled,[0,1]);assert.equal(transports,2);assert.equal(reserves,2);
 });
});
