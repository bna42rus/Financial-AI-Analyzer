import {useState} from 'react';
import type {Rule} from '../../../packages/finance-core/src/rules';
import type {OperationRow} from './operations-client';
import type {FinanceState} from './finance-client';
import type {CommandState,WorkspaceCommand} from './workspace-command';
import {RuleEditor} from './SettingsRules';
export function OperationRule({state,operation,command,commandState,disabled,onClose}:{state:FinanceState;operation:OperationRow;command:WorkspaceCommand|null;commandState:CommandState;disabled:boolean;onClose:()=>void}){
 const [seed]=useState<Rule>(()=>{
  const {classification,accountId,amountMinor,analyticsRole,decompositionActive}=operation,merchant=classification.merchant.value,amount=BigInt(amountMinor);
  const conditions:Rule['conditions']={accountId,kind:classification.kind.value},assignments:Rule['assignments']={};
  if(merchant)conditions.merchantEquals=merchant;
  if(amount!==0n)conditions.direction=amount>0n?'in':'out';
  if(!decompositionActive&&analyticsRole!=='mixed')assignments.role=analyticsRole;
  if(assignments.role&&classification.category.value){assignments.categoryId=classification.category.value;assignments.subcategoryId=classification.subcategory.value;}
  return {id:crypto.randomUUID(),name:(merchant?'Правило: '+merchant:'Правило для операции').slice(0,160),enabled:true,priority:100,conditions,assignments};
 });
 return <RuleEditor state={state} command={command} commandState={commandState} disabled={disabled} close={onClose} id={null} seed={seed}/>;
}
