/** Shared SQL accounting for both assistant workflows. Caller holds its short
 * authorized transaction. Settlement deliberately survives access revocation. */
import type {PoolClient} from 'pg';
import type {DispatchBound,Usage} from '../../../packages/analyzer/src/cost.ts';
import type {AssistantProvider} from './analyzer-assistant-provider.ts';
import {reserveCost,settleCost} from './analyzer-cost.ts';
import {HttpError} from './types.ts';
import {AssistantError} from '../../../packages/analyzer/src/assistant-plan.ts';

export function assistantCallStep(index:number):'assistant_0'|'assistant_1'|'assistant_2'{
 if(!Number.isInteger(index)||index<0||index>2)throw new AssistantError('ASSISTANT_CALL_LIMIT');
 return `assistant_${index}` as ReturnType<typeof assistantCallStep>;
}
export async function reserveAssistantCall(db:PoolClient,userId:string,id:string,index:number,fingerprint:string,bound:DispatchBound,cycle:{anchorExact:string;periodExact:string},provider:AssistantProvider,tag:'cashneuro-assistant/1'|'cashneuro-analyzer-next/1'='cashneuro-assistant/1'){
 const step=assistantCallStep(index);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['cloud-task-dispatch:'+userId]);
 if((await db.query('SELECT 1 FROM commerce.analyzer_request WHERE user_id=$1 AND request_id=$2 AND step=$3',[userId,id,step])).rowCount)throw new HttpError(409,'AI_DELIVERY_UNKNOWN');
 if((await db.query("SELECT 1 FROM commerce.analyzer_request r WHERE r.user_id=$1 AND (r.state='sent' OR r.usage_state='unknown') AND NOT (r.state='failed' AND EXISTS (SELECT 1 FROM commerce.ai_cost_reservation c WHERE c.user_id=r.user_id AND c.request_id=r.request_id AND c.step=r.step AND c.state='released' AND c.settled_atoms=0 AND c.reported_input_tokens IS NULL AND c.reported_output_tokens IS NULL)) LIMIT 1",[userId])).rowCount)throw new HttpError(409,'AI_COST_RECONCILIATION_REQUIRED');
 await db.query(`INSERT INTO commerce.analyzer_request(user_id,request_id,step,fingerprint,state,provider,model,period_start,anchor_at,usage_state)
  VALUES($1,$2,$3,$4,'sent',$5,$6,$7,$8,'not_sent')`,[userId,id,step,fingerprint,tag,bound.modelVersion,cycle.periodExact,cycle.anchorExact]);
 const policy=provider.policy;await provider.prepareDispatch?.(db,policy);
 const anchorAt=provider.costPeriod==='project'?policy.projectPeriodStart:cycle.anchorExact;
 const periodStart=provider.costPeriod==='project'?policy.projectPeriodStart:cycle.periodExact;
 await reserveCost(db,{userId,requestId:id,step,anchorAt,periodStart},policy,bound);
 await provider.authorizeDispatch(db,policy);
}
export async function settleAssistantCall(db:PoolClient,userId:string,id:string,index:number,usage?:Usage){
 const step=assistantCallStep(index),changed=await settleCost(db,userId,id,step,usage);
 await db.query(`UPDATE commerce.analyzer_request SET state=CASE WHEN $4='received' AND NOT EXISTS(SELECT 1 FROM finance.analyzer_task_request WHERE user_id=$1 AND id=$2 AND state='pending') THEN 'completed' ELSE $4 END,usage_state=$5,input_tokens=$6,output_tokens=$7,model_version=$8,updated_at=clock_timestamp()
  WHERE user_id=$1 AND request_id=$2 AND step=$3 AND state IN ('sent','received','unknown')`,[userId,id,step,usage?'received':'unknown',usage?'reported':'unknown',usage?.inputTokens??null,usage?.outputTokens??null,usage?.modelVersion??null]);
 return changed;
}
