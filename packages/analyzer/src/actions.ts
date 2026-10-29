import {object,choice,uuid} from '../../finance-core/src/model.ts';
/** Each entry delegates to an existing backend parser; unknown kinds never reach it. */
export const financeActionKinds=['add_catalog_categories','set_category_binding','operation','components','link','account','category','counterparty','rule','analytics','undo','bulk_operations','merge_accounts','split_account','delete_financial','merge_categories','delete_category','migrate_category','merge_counterparties','split_counterparty','delete_counterparty','set_exclusion','restore_history','cancel_import','duplicate_different','merge_duplicate','delete_rule','apply_rules','save_budget','set_budget_limit','delete_budget','save_overview_view','delete_overview_view','reorder_overview_views','save_operations_view','delete_operations_view','reorder_operations_views'] as const;
export type FinanceActionKind=typeof financeActionKinds[number];
export type ActionTool={name:'set_inclusion';answerId:string;value:'include'|'exclude'}|{name:'edit_operations';answerId:string;patch:Record<string,unknown>;operationIds?:string[]}|{name:'finance_action';answerId:string;intent:Record<string,unknown>&{kind:FinanceActionKind}};
export function parseActionTool(value:unknown):ActionTool {
 const r=object(value,['name','answerId','value','patch','operationIds','intent']),answerId=uuid(r.answerId);
 if(r.name==='set_inclusion'){object(value,['name','answerId','value']);return {name:r.name,answerId,value:choice(r.value,['include','exclude'])};}
 if(r.name==='edit_operations'){
  object(value,['name','answerId','patch','operationIds']);const patch=object(r.patch,['kind','role','categoryId','subcategoryId','merchant','counterpartyId','comment','analyticsOverride','corrections','reviewRequested']);if(!Object.keys(patch).length)throw new TypeError('EMPTY_PATCH');
  let operationIds:string[]|undefined;if(r.operationIds!==undefined){if(!Array.isArray(r.operationIds)||!r.operationIds.length||r.operationIds.length>1000)throw new TypeError('INVALID_SCOPE');operationIds=r.operationIds.map(uuid);if(new Set(operationIds).size!==operationIds.length)throw new TypeError('DUPLICATE_SCOPE');}
  return {name:r.name,answerId,patch,...(operationIds?{operationIds}:{})};
 }
 if(r.name==='finance_action'){object(value,['name','answerId','intent']);if(!r.intent||typeof r.intent!=='object'||Array.isArray(r.intent))throw new TypeError('INVALID_INTENT');const intent=r.intent as Record<string,unknown>;choice(intent.kind,financeActionKinds);return {name:r.name,answerId,intent:structuredClone(intent) as Record<string,unknown>&{kind:FinanceActionKind}};}
 throw new TypeError('UNKNOWN_ANALYZER_TOOL');
}
/** PDF 51: one reversible edit and explicit future rules need no extra confirmation. */
export function actionConfirmation(intent:{kind:string;patch?:Record<string,unknown>;operationIds?:string[];create?:boolean}):boolean {
 if(intent.kind==='operation')return !!intent.patch?.corrections;
 if(intent.kind==='category'&&intent.create)return false;
 if(intent.kind==='category')return !!intent.patch&&('role'in intent.patch||'parentId'in intent.patch);
 if(intent.kind==='counterparty')return !!intent.patch&&('isSelf'in intent.patch||'state'in intent.patch);
 if(intent.kind==='account')return !!intent.patch&&['type','loanMode','analyticsEnabled'].some(k=>k in intent.patch!);
 if(intent.kind==='rule'||intent.kind==='undo')return false;
 return true;
}
