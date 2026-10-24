/** Root-only release preparation: public GETs and saved receipts, no model POST. */
import {constants} from 'node:fs';
import {readFile,lstat,realpath,open} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Pool} from 'pg';
import {privateJson} from './kms.ts';
import {stagingDatabase} from './runtime-key.ts';
import {assistantRuntimeManifest} from './analyzer-assistant-manifest.ts';
import {classificationRuntimeAdmission,validateClassificationEvidence,confirmClassificationPaidReceipt} from './classification-admission.ts';
import {classificationPilotTotals,classificationFailure} from './classification-smoke-support.ts';
import {verifyClassificationTariff} from './classification-tariff.ts';
import {digest} from './classification-plan.ts';
import {createStagingAssistantProvider} from './analyzer-assistant-provider.ts';
import {rubAmount} from '../../../packages/analyzer/src/cost.ts';
import {checkAssistantStagingSettings} from './analyzer-assistant-settings.ts';
import type {AssistantStagingSettings} from './analyzer-assistant-settings.ts';

async function writePrivate(path:string,value:unknown){
 const parent=dirname(path),info=await lstat(parent);
 if(!info.isDirectory()||info.uid!==0||(info.mode&0o777)!==0o700||await realpath(parent)!==parent)throw Error('CLASSIFICATION_ADMISSION_DIRECTORY_INVALID');
 const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}
 const directory=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
}
async function main(){
 const [action,evidence,output,fallbackOutput,tested,installed,...extra]=process.argv.slice(2);
 if(process.getuid?.()!==0||action!=='--prepare'||extra.length||!evidence||!/^\/var\/lib\/cashneuro\/classification-check-[A-Za-z0-9]+$/.test(evidence)||!output||!fallbackOutput||output===fallbackOutput||![tested,installed].every(s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s)))throw Error('CLASSIFICATION_ADMISSION_ARGUMENTS_INVALID');
 const manifest=await assistantRuntimeManifest();if(manifest.sourceSha256!==tested)throw Error('CLASSIFICATION_TESTED_RELEASE_CHANGED');
 const original=await privateJson('/etc/cashneuro/ai/assistant-staging.json') as AssistantStagingSettings;
 if(original.sourceSha256!==installed)throw Error('ASSISTANT_RELEASE_CHANGED');const originalHash=digest(original);
 const environment=await readFile('/etc/cashneuro/staging/finance-api.env','utf8');
 const database=environment.split('\n').map(line=>/^\s*DATABASE_URL\s*=\s*(.*?)\s*$/.exec(line)?.[1]).find(v=>v!==undefined)?.replace(/^["']|["']$/g,'');
 stagingDatabase('staging',database);const pool=new Pool({connectionString:database,max:2,connectionTimeoutMillis:5000,query_timeout:10000}),db=await pool.connect();
 const lockName='classification-continuation:'+original.cost.projectId;
 try{
  const identity=(await db.query('SELECT current_user AS role,current_database() AS name')).rows[0];if(identity?.role!=='finance_api'||identity.name!=='finance_staging')throw Error('ASSISTANT_DATABASE_DENIED');
  if(!(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[lockName])).rows[0].locked)throw Error('CLASSIFICATION_CHECK_IN_PROGRESS');
  const user=(await db.query(`SELECT u.id FROM identity.auth_user u JOIN identity.security_state s ON s.user_id=u.id LEFT JOIN commerce.access_cycle c ON c.user_id=u.id
   WHERE u.email=ANY($1::text[]) AND u.email_verified AND s.status='active' AND (CASE WHEN c.user_id IS NOT NULL THEN c.indefinite ELSE s.indefinite END OR CASE WHEN c.user_id IS NOT NULL THEN c.access_end ELSE s.access_end END>clock_timestamp()) ORDER BY u.id LIMIT 1`,[original.allowedEmails])).rows[0];
  if(!user)throw Error('FINANCE_ACCESS_REQUIRED');
  await db.query('BEGIN READ ONLY');await db.query("SELECT set_config('app.user_id',$1,true)",[user.id]);
  let evidenceResult;
  try{
   evidenceResult=await validateClassificationEvidence(evidence,(fingerprint,usage,from,through)=>confirmClassificationPaidReceipt(db,user.id,original.cost.projectId,fingerprint,usage,from,through));
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}
  const totals=await classificationPilotTotals(db,original.cost.projectId,original.cost.projectPeriodStart);
  const getOnly:typeof fetch=async(url,options)=>{if(options?.method!=='GET')throw Error('CLASSIFICATION_ADMISSION_HTTP_DENIED');return fetch(url,options);};
  const tariff=await verifyClassificationTariff(getOnly),settings=classificationRuntimeAdmission(original,totals,manifest.sourceSha256,tariff);
  await createStagingAssistantProvider(pool,settings,getOnly,manifest.sourceSha256);
  const fallback=checkAssistantStagingSettings({...settings,sourceSha256:installed!});
  if(digest(await privateJson('/etc/cashneuro/ai/assistant-staging.json'))!==originalHash)throw Error('CLASSIFICATION_ACTIVE_CONFIGURATION_CHANGED');
  await db.query('BEGIN');
  try{
   await db.query(`INSERT INTO commerce.ai_project_budget(project_id,period_start,period_end,limit_atoms) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[settings.cost.projectId,settings.cost.projectPeriodStart,settings.cost.projectPeriodEnd,rubAmount(settings.cost.projectLimitRub).toString()]);
   const budget=(await db.query('SELECT limit_atoms,period_end=$3::timestamptz AS matches_end,blocked FROM commerce.ai_project_budget WHERE project_id=$1 AND period_start=$2 FOR UPDATE',[settings.cost.projectId,settings.cost.projectPeriodStart,settings.cost.projectPeriodEnd])).rows[0];
   if(!budget?.matches_end||budget.blocked||BigInt(budget.limit_atoms)!==rubAmount(settings.cost.projectLimitRub))throw Error('CLASSIFICATION_RECONCILIATION_REQUIRED');
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}
  await writePrivate(output,settings);await writePrivate(fallbackOutput,fallback);
  console.log(JSON.stringify({...evidenceResult,sourceSha256:manifest.sourceSha256,expiresAt:settings.expiresAt,maximumCallsRemaining:original.admission.stageMaximumCalls-original.admission.calls-totals.calls}));
 }finally{try{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockName]);}finally{db.release();await pool.end();}}
}
main().catch(error=>{console.log(JSON.stringify({status:'STOP',...classificationFailure(error)}));process.exitCode=1;});
