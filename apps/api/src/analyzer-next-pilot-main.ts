/** Root-only synthetic pilot; spends only through the existing Staging ledger. */
import {Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createStagingAssistantProvider,AssistantModelAdmissionError} from './analyzer-assistant-provider.ts';
import {withAssistantJournal,readAssistantPrivateFile} from './assistant-journal.ts';
import type {AssistantAccounting} from './assistant-journal.ts';
import type {RunReceipt,AssistantRequest} from './assistant-workflow.ts';
import {createCloudAssistantModel} from './assistant-transport.ts';
import {pilotModelCall} from './analyzer-next-pilot-call.ts';
import {reserveCost,settleCost} from './analyzer-cost.ts';
import {emptyConversation} from '../../../packages/analyzer/src/assistant-conversation.ts';
import {rubAmount,tokenCost} from '../../../packages/analyzer/src/cost.ts';
import {PrototypeSession} from '../../../packages/analyzer/src/next/workflow.ts';
import {prepareTask} from '../../../packages/analyzer/src/next/tasks.ts';
import {parseIntent} from '../../../packages/analyzer/src/next/intent.ts';
import {pilotSchema,pilotPrompt} from '../../../packages/analyzer/src/next/pilot.ts';
import {createPilotSuite,pilotIntentDiagnostic} from './analyzer-next-pilot-suite.ts';
import {scope,catalog,rows} from '../../../packages/analyzer/test/fixtures/next-finances.ts';
import {calculateWidget,parseWidget} from '../../../packages/finance-core/src/overview.ts';
import {sanitizeText} from '../../../packages/privacy/src/text.ts';
import {stagingDatabase} from './runtime-key.ts';
const rub=(n:bigint|string)=>{const v=BigInt(n);return `${v/1000000000n}.${(v%1000000000n).toString().padStart(9,'0')}`;};
async function main(){
 const mode=process.argv.slice(2).join(' '),replayOnly=mode==='--replay-only';
 if(process.getuid?.()!==0||!['--live','--replay-only'].includes(mode))throw Error('PILOT_ROOT_LIVE_REQUIRED');
 let input='';for await(const chunk of process.stdin){input+=chunk.toString();if(input.length>262144)throw Error('PILOT_INPUT_TOO_LARGE');}
 const cfg=JSON.parse(input),suite=createPilotSuite(cfg.suite,catalog);
 if(!/^\/srv\/cashneuro\/staging\/backend-releases\/[a-f0-9]{40}\/apps\/api$/.test(cfg.activeApi)||!/^\/var\/lib\/cashneuro\/analyzer-next-pilot\/[a-f0-9]{40}$/.test(cfg.directory))throw Error('PILOT_PATH_INVALID');
 stagingDatabase('staging',cfg.databaseUrl);
 const dbUrl=new URL(cfg.databaseUrl);if(dbUrl.username!=='finance_api'||dbUrl.pathname!=='/finance_staging'||typeof cfg.userId!=='string'||!cfg.userId)throw Error('PILOT_DATABASE_DENIED');
 const active=await import(pathToFileURL(join(cfg.activeApi,'src/analyzer-assistant-manifest.ts')).href);const expected=await active.assistantRuntimeManifest();
 const pool=new Pool({connectionString:cfg.databaseUrl,max:2});
 try{
  const provider=await createStagingAssistantProvider(pool,cfg.settings,fetch,expected.sourceSha256);
  console.log('MODEL_ADMISSION '+JSON.stringify((provider.binding as {modelAdmission:unknown}).modelAdmission));
  if(!provider.costPeriod||!provider.allowed(cfg.email))throw Error('PILOT_MONTHLY_ACCOUNT_DENIED');
  const manifestPath=join(cfg.directory,'run.json'),accountBinding=createHash('sha256').update(cfg.userId+':'+provider.policy.projectId).digest('hex');let manifest:any;
  try{manifest=await readAssistantPrivateFile(manifestPath);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
   const {writeFile}=await import('node:fs/promises');manifest={version:suite.version,accountBinding,ids:suite.cases.map(()=>randomUUID()),...(suite.caseSignature?{caseSignature:suite.caseSignature}:{})};await writeFile(manifestPath,JSON.stringify(manifest)+'\n',{flag:'wx',mode:0o600});}
  if(manifest.version!==suite.version||manifest.accountBinding!==accountBinding||manifest.caseSignature!==suite.caseSignature||!Array.isArray(manifest.ids)||manifest.ids.length!==suite.cases.length||new Set(manifest.ids).size!==suite.cases.length||manifest.ids.some((v:unknown)=>typeof v!=='string'||!/^[-a-f0-9]{36}$/.test(v)))throw Error('PILOT_MANIFEST_INVALID');
  const journalDirectory=join(cfg.directory,'journal');await mkdir(journalDirectory,{recursive:true,mode:0o700});
  const transaction=async<T>(action:(db:import('pg').PoolClient)=>Promise<T>)=>{const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT set_config('app.user_id',$1,true)",[cfg.userId]);const result=await action(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}};
  const runCost=async(db:import('pg').PoolClient)=>BigInt((await db.query(`SELECT COALESCE(sum(CASE WHEN state IN ('settled','released') THEN settled_atoms ELSE reserved_atoms END),0)::text AS n FROM commerce.ai_cost_reservation WHERE user_id=$1 AND request_id=ANY($2::uuid[])`,[cfg.userId,manifest.ids])).rows[0].n);
  const budget=()=>transaction(async db=>({month:await provider.budgetState!(db),run:await runCost(db)}));
  const before=await budget();console.log(`PILOT ${suite.name}: ${suite.cases.length} synthetic turns; ${replayOnly?'replay only, dispatch disabled':'run ceiling '+suite.limitRub+' RUB'}; existing monthly cap preserved. MONTH_AVAILABLE ${rub(before.month!.remainingAtoms)} RUB`);
  const sessions=new Map(suite.cases.map(c=>[c.chain,new PrototypeSession(scope)])),failedChains=new Set<string>();let tested=0,passed=0,skipped=0,newReservations=0;
  for(const [index,c]of suite.cases.entries()){
   if(failedChains.has(c.chain)){skipped++;continue;}
   const session=sessions.get(c.chain)!,requestId=manifest.ids[index],environment={scope,requestId,question:c.question,date:'2026-11-25',global:suite.global(c),dataRevision:'synthetic/1',accessRevision:'synthetic/1',catalog};
   const request:AssistantRequest={requestId,scope,question:c.question,global:environment.global,conversation:emptyConversation(scope),dataRevision:environment.dataRevision,timezone:'Europe/Moscow',now:new Date('2026-11-25T12:00:00Z')};
   const accounting:AssistantAccounting={async reserve(id,call,bound){if(replayOnly)throw Error('PILOT_REPLAY_MISSING');if(call!==0)throw Error('PILOT_ONE_CALL_ONLY');await transaction(async db=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['cloud-task-dispatch:'+cfg.userId]);
    if((await db.query('SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2 AND step=$3',[cfg.userId,id,'assistant_0'])).rowCount)throw Error('ASSISTANT_DELIVERY_UNKNOWN');
    const policy=provider.policy;await provider.prepareDispatch!(db,policy);
    if(await runCost(db)+tokenCost(policy.price,bound.inputTokens,bound.outputTokens)>rubAmount(suite.limitRub))throw Error('PILOT_RUN_COST_LIMIT');
    const fingerprint=createHash('sha256').update('analyzer-next-pilot/1:'+id).digest('hex');
    await db.query(`INSERT INTO commerce.analyzer_request(user_id,request_id,step,fingerprint,state,provider,model,period_start,anchor_at,usage_state) VALUES($1,$2,'assistant_0',$3,'sent','cashneuro-next-pilot/1',$4,$5,$5,'not_sent')`,[cfg.userId,id,fingerprint,bound.modelVersion,policy.projectPeriodStart]);
    await reserveCost(db,{userId:cfg.userId,requestId:id,step:'assistant_0',anchorAt:policy.projectPeriodStart,periodStart:policy.projectPeriodStart},policy,bound);await provider.authorizeDispatch(db,policy);
   });newReservations++;},async settle(id,call,usage){if(call!==0)throw Error('PILOT_ONE_CALL_ONLY');const violation=await transaction(async db=>{
    const changed=await settleCost(db,cfg.userId,id,'assistant_0',usage);
    await db.query(`UPDATE commerce.analyzer_request SET state=$3,usage_state=$4,input_tokens=$5,output_tokens=$6,model_version=$7,updated_at=clock_timestamp() WHERE user_id=$1 AND request_id=$2 AND step='assistant_0'`,[cfg.userId,id,usage?'completed':'unknown',usage?'reported':'unknown',usage?.inputTokens??null,usage?.outputTokens??null,usage?.modelVersion??null]);return changed;
   });if(violation)throw Error('ASSISTANT_PROVIDER_CHANGED');}};
   let receipt:RunReceipt|undefined,replayed=false,semantic=false,reviewCode='',providerCode='',resolved='';const started=performance.now();
   const result=await withAssistantJournal(journalDirectory,request,accounting,async journal=>{
    receipt=journal.receipt;
    return session.run(environment,{async understand(modelInput){try{const r=await pilotModelCall(createCloudAssistantModel({apiKey:cfg.settings.apiKey},fetch,'assistant','cashneuro-intent-prototype/1'),journal,{phase:'understand',prompt:pilotPrompt,input:modelInput,schema:pilotSchema},replayOnly?'replay_only':'allow');replayed=r.replayed;return r.value;}catch(error){const code=(error as {code?:string})?.code;providerCode=typeof code==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(code)?code:'PILOT_PROVIDER_FAILED';throw error;}}},{
     current:()=>({scope,dataRevision:environment.dataRevision,accessRevision:environment.accessRevision}),
     async authorize(){if(!provider.allowed(cfg.email))throw Error('PILOT_ACCOUNT_DENIED');},
     async review(_input,reply){try{const prepared=reply.intent?prepareTask(session.snapshot(),environment,reply.intent):null;resolved=prepared?(prepared.status==='ready'?(prepared.task.kind==='read'?'read:'+(prepared.task.node.parent?'continue':'new'):prepared.task.kind):prepared.status):reply.relevance;semantic=suite.preparationMatches(c,prepared,reply);if(!semantic)reviewCode='PILOT_EXPECTATION_MISMATCH';return semantic;}catch(error){reviewCode=error instanceof Error&&/^(?:TASK|INVALID)_[A-Z_]{1,70}$/.test(error.message)?error.message:'PILOT_PREPARATION_FAILED';return false;}},
     tools:{async guard(){},async read(query){return calculateWidget(parseWidget({id:scope.chatId,name:'Синтетическая выборка',metrics:[query.metric],grouping:query.grouping,filter:query.filter,comparison:query.comparison==='custom'?{kind:'custom',...query.options?.comparisonPeriod}:{kind:query.comparison},chart:'table',topN:50}),rows,catalog,{},request.now,'Europe/Moscow',true);}},
    });
   });
   const ok=semantic&&suite.outcomeMatches(c,result);tested++;if(ok)passed++;else failedChains.add(c.chain);
   const call=receipt?.calls[0],usage=call?.usage;let shape='invalid';try{const p=parseIntent((call?.value as any)?.intent);shape=p.action+':'+p.binding.mode+(p.action==='calculate'?':'+p.parameters.edits.map(e=>e.field).join(','):'');}catch{if(ok&&(resolved==='loan'||resolved==='loan_comparison'))shape='raw:recovered';}
   console.log(`${ok?'PASS':'FAIL'} ${c.id}: ${result.status}${'code'in result?':'+result.code:''}; ${Math.round(performance.now()-started)} ms; ${replayed?'replayed':'new'}; ${usage?.inputTokens??0}/${usage?.outputTokens??0} tokens; ${shape}; resolved=${resolved}`);
   if(!ok){const details=pilotIntentDiagnostic((call?.value as any)?.intent);console.log('DIAGNOSTIC '+c.id+' '+(providerCode||reviewCode||('code'in result?result.code:'PILOT_OUTCOME_MISMATCH'))+' '+sanitizeText(JSON.stringify(details)));}
   if(/^(?:PILOT_RUN_COST_LIMIT|AI_.*EXHAUSTED|ASSISTANT_RECONCILIATION_REQUIRED|ASSISTANT_DELIVERY_UNKNOWN|ASSISTANT_.*CHANGED)$/.test(providerCode)||result.status==='failed'&&/^(?:PILOT_RUN_COST_LIMIT|AI_.*EXHAUSTED|ASSISTANT_RECONCILIATION_REQUIRED)$/.test(result.code))break;
   const current=await budget();if(BigInt(current.month!.heldAtoms)>0n){console.log('STOP: unresolved cost hold; no retry');break;}
  }
  const after=await budget();console.log(`RESULT ${passed}/${tested}; total ${suite.cases.length}; skipped ${skipped}; not run ${suite.cases.length-tested}; new reservations ${newReservations}; NEW_COST ${rub(after.run-before.run)} RUB; RUN_TOTAL ${rub(after.run)} RUB; MONTH_AVAILABLE ${rub(after.month!.remainingAtoms)} RUB; MONTH_HELD ${rub(after.month!.heldAtoms)} RUB; no financial data changed`);
  if(passed!==suite.cases.length)process.exitCode=1;
 }finally{await pool.end();}
}
main().catch(e=>{if(e instanceof AssistantModelAdmissionError)console.error('MODEL_DIAGNOSTIC '+JSON.stringify(e.diagnostic));console.error(e instanceof Error&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:'PILOT_STOPPED');process.exitCode=1;});
