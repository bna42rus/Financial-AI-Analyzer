import {useState} from 'react';
import type {Rule} from '../../../packages/finance-core/src/rules';
import type {OperationRow} from './operations-client';
import type {FinanceState} from './finance-client';
import type {WorkspaceCommand} from './workspace-command';
import {RuleEditor} from './SettingsRules';
export function OperationRule({state,operations,command,disabled,onClose}:{state:FinanceState;operations:OperationRow[];command:WorkspaceCommand|null;disabled:boolean;onClose:()=>void}){
 const [snapshot]=useState(()=>[...operations]),[seed]=useState<Rule>(()=>{const first=snapshot[0]!,conditions:Rule['conditions']={},assignments:Rule['assignments']={},same=(value:(o:OperationRow)=>unknown)=>snapshot.every(o=>value(o)===value(first));
 if(first.classification.merchant.value&&same(o=>o.classification.merchant.value))conditions.merchantEquals=first.classification.merchant.value;
 if(same(o=>o.accountId))conditions.accountId=first.accountId;if(same(o=>o.classification.kind.value))conditions.kind=first.classification.kind.value;
 if(same(o=>BigInt(o.amountMinor)>0n)&&snapshot.every(o=>BigInt(o.amountMinor)!==0n))conditions.direction=BigInt(first.amountMinor)>0n?'in':'out';
 if(snapshot.every(o=>!o.decompositionActive)&&same(o=>o.analyticsRole)&&first.analyticsRole!=='mixed')assignments.role=first.analyticsRole;
 if(assignments.role&&same(o=>o.classification.category.value)&&first.classification.category.value){assignments.categoryId=first.classification.category.value;if(same(o=>o.classification.subcategory.value))assignments.subcategoryId=first.classification.subcategory.value;}
 return {id:crypto.randomUUID(),name:(first.classification.merchant.value?'Правило: '+first.classification.merchant.value:'Правило для выбранных').slice(0,160),enabled:true,priority:100,conditions,assignments};});
 return <section aria-label="Правило по выбранным операциям"><p>Выбрано конкретных операций: {snapshot.length}. Общие признаки предложены как условия будущего правила. Проверьте условия и действия: правило не исправляет эти записи и не применяется к прошлым автоматически.</p><RuleEditor state={state} command={command} disabled={disabled} close={onClose} id={null} seed={seed}/></section>;
}
