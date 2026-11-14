import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {facet,object,uuid} from '../../../packages/finance-core/src/model.ts';
import type {Graph} from '../../../packages/finance-core/src/model.ts';
import {validateRule} from '../../../packages/finance-core/src/rules.ts';
import type {Rule} from '../../../packages/finance-core/src/rules.ts';
import type {CounterpartyEvidence} from '../../../packages/imports/src/counterparty-evidence.ts';
import {HttpError} from './types.ts';

export async function recognizeImportedCounterparty(db:PoolClient,userId:string,evidence:CounterpartyEvidence){
 const found=(await db.query<{id:string;counterparty_id:string}>(
  'SELECT id,counterparty_id FROM finance.counterparty_alias WHERE user_id=$1 AND alias_type=$2 AND alias_hmac=$3',
  [userId,evidence.kind,evidence.hmac])).rows[0];
 if(found)return found;
 const partyId=randomUUID(),aliasId=randomUUID();
 await db.query("INSERT INTO finance.counterparty(user_id,id,name,state) VALUES($1,$2,$3,'discovered')",[userId,partyId,evidence.name??'Получатель без имени']);
 await db.query('INSERT INTO finance.counterparty_alias(user_id,id,counterparty_id,alias_type,alias_hmac) VALUES($1,$2,$3,$4,$5)',[userId,aliasId,partyId,evidence.kind,evidence.hmac]);
 return {id:aliasId,counterparty_id:partyId};
}

export function parseProposalOperations(value:unknown){
 if(!Array.isArray(value)||value.length>1000)throw new TypeError('INVALID_SELECTION');
 const ids=value.map(uuid);
 if(new Set(ids).size!==ids.length)throw new TypeError('DUPLICATE_SELECTION');
 return ids;
}

export function parseCounterpartyRuleConditions(value:unknown,id:string){
 const fields=object(value,['bankId','direction','descriptionContains']);
 if(typeof fields.descriptionContains!=='string'||!fields.direction)throw new TypeError('INVALID_COUNTERPARTY_CONDITION');
 return validateRule({name:'Контрагент',enabled:true,priority:100,conditions:fields,assignments:{counterpartyId:id}}).conditions;
}

export async function removeProposalOperationIds(db:PoolClient,userId:string,deleted:string[]){
 if(!deleted.length)return;
 await db.query(`UPDATE finance.counterparty SET proposal_operation_ids=ARRAY(
  SELECT operation_id FROM unnest(proposal_operation_ids) WITH ORDINALITY AS ops(operation_id,position)
  WHERE NOT operation_id=ANY($2::uuid[]) ORDER BY position
 ),revision=revision+1 WHERE user_id=$1 AND proposal_operation_ids && $2::uuid[]`,[userId,deleted]);
}

function proposalCandidates(graph:Graph,id:string){
 return graph.operations.filter(op=>op.bankCounterpartyId===id||op.semantics.counterparty.value===id);
}

type CounterpartyOptions={
 state?:'ignored'|'registered';name?:string;proposalOperationIds?:string[];
 rememberForFuture?:boolean;ruleConditions?:Rule['conditions'];autoRuleId?:string;
};
type PartyBefore={state:string;name:string;auto_rule_id:string|null;proposal_operation_ids:string[]|null};
export async function saveCounterpartyOptions(db:PoolClient,userId:string,id:string,patch:CounterpartyOptions,before:PartyBefore|null,graph:Graph){
 const proposal=!!before&&before.state!=='registered';
 const registering=proposal&&patch.state==='registered';
 const changes:{proposal_operation_ids?:string[]|null;auto_rule_id?:string}={};
 if(patch.proposalOperationIds!==undefined||registering){
  if(!proposal)throw new HttpError(409,'COUNTERPARTY_PROPOSAL_CHANGED');
  const candidates=new Map(proposalCandidates(graph,id).map(op=>[op.id,op]));
  const ids=patch.proposalOperationIds??(before.proposal_operation_ids??[...candidates.keys()].slice(0,1000)).filter(key=>candidates.has(key));
  if(ids.some(key=>!candidates.has(key)))throw new HttpError(409,'COUNTERPARTY_OPERATIONS_CHANGED');
  if(registering){
   for(const key of ids){
    const op=candidates.get(key)!;
    if(op.semantics.counterparty.value===id&&op.semantics.counterparty.userVerified)continue;
    const semantics={...op.semantics,counterparty:facet(id,'user',true)};
    await db.query('UPDATE finance.transaction SET semantics=$3,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,key,JSON.stringify(semantics)]);
   }
   changes.proposal_operation_ids=null;
  }else changes.proposal_operation_ids=ids;
 }
 if(patch.rememberForFuture===undefined)return changes;
 if(proposal&&!registering)throw new HttpError(409,'COUNTERPARTY_PROPOSAL_CHANGED');
 if(before?.auto_rule_id){
  const rule=(await db.query<{enabled:boolean;dependency_status:string}>('SELECT enabled,dependency_status FROM finance.rule WHERE user_id=$1 AND id=$2',[userId,before.auto_rule_id])).rows[0];
  if(!rule||patch.rememberForFuture&&rule.dependency_status!=='ready')throw new HttpError(409,'RULE_NEEDS_SETUP');
  if(rule.enabled!==patch.rememberForFuture)await db.query('UPDATE finance.rule SET enabled=$3,revision=revision+1 WHERE user_id=$1 AND id=$2',[userId,before.auto_rule_id,patch.rememberForFuture]);
 }else if(patch.rememberForFuture){
  const aliases=await db.query('SELECT 1 FROM finance.counterparty_alias WHERE user_id=$1 AND counterparty_id=$2 LIMIT 1',[userId,id]);
  if(!patch.autoRuleId)throw new TypeError('INVALID_COUNTERPARTY_CONDITION');
  const conditions=patch.ruleConditions??(aliases.rowCount?{counterpartyBankIdentity:true}:{});
  const ready=Object.keys(conditions).length>0;
  const name=('Контрагент · '+(patch.name??before?.name??'')).slice(0,160);
  await db.query('INSERT INTO finance.rule(user_id,id,name,enabled,priority,conditions,assignments,dependency_status) VALUES($1,$2,$3,$4,100,$5,$6,$7)',[userId,patch.autoRuleId,name,ready,JSON.stringify(conditions),JSON.stringify({counterpartyId:id}),ready?'ready':'needs_setup']);
  changes.auto_rule_id=patch.autoRuleId;
 }
 return changes;
}
