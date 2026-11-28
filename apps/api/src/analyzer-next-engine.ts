import type {Pool,PoolClient} from 'pg';
import type {AssistantProvider} from './analyzer-assistant-provider.ts';
import {runNextRequest} from './analyzer-next-store.ts';
import {nextModelCall} from './analyzer-next-model-call.ts';
import {reviewNextUnderstanding} from './analyzer-next-review.ts';
import {presentNextResult} from './analyzer-next-presenter.ts';
import {understandingSchema,understandingPrompt} from '../../../packages/analyzer/src/next/understanding.ts';
import type {Prepared} from '../../../packages/analyzer/src/next/tasks.ts';
import {calculateAnalyzerQuery} from './analyzer.ts';

/** The only HTTP engine assembly: mandatory semantic review before private read,
 * existing deterministic tools, no pilot oracle or permissive test callbacks. */
export function executeNextRequest(pool:Pool,userId:string,value:unknown,provider:AssistantProvider,key:Uint8Array,authorize:(db:PoolClient)=>Promise<void>){
 return runNextRequest(pool,userId,value,provider,key,authorize,async({session,environment:env,calendar,journal,within})=>{
  const model=provider.forNextRequest();let prepared:Prepared|undefined,read:Awaited<ReturnType<typeof calculateAnalyzerQuery>>|undefined;
  const result=await session.run(env,{async understand(input){return (await nextModelCall(model,journal,{phase:'understand',prompt:understandingPrompt,input,schema:understandingSchema})).value;}},{
   current:()=>env,authorize:()=>within(async()=>{}),
   review:(input,reply)=>reviewNextUnderstanding(input,reply,session.snapshot(),env,model,journal),
   tools:{guard:task=>within(async()=>{prepared=task;}),read:(query,task)=>within(async db=>{
    read=await calculateAnalyzerQuery(db,userId,query,calendar.now,{mode:'ai',timezone:calendar.timezone,periodFromQuestion:query.filter.from!==env.global.filter.from||query.filter.through!==env.global.filter.through,followUp:task.parent!==null,provider:{id:'cashneuro-analyzer-next/1',model:model.bound.modelVersion,version:'cashneuro-next-store/1'}});
    return read.answer.result!;
   })},
  });
  const answer=presentNextResult(result,prepared,read?.answer);if(prepared)answer.presentation=prepared.presentation;
  return {result,answer,dependencyIds:read?.dependencyIds};
 });
}
