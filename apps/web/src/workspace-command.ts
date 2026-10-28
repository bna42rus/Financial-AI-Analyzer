import type {OverviewView} from '../../../packages/finance-core/src/overview';
import type {BudgetDefinition} from '../../../packages/finance-core/src/budgets';
import type {OperationsView} from '../../../packages/finance-core/src/operations';
import type {MergeChoices,MergeSide} from '../../../packages/finance-core/src/duplicate-merge';
import {ApiError} from './server-client';
import type {FinancePreview,FinanceReceipt,FinanceState,OperationPatch,BulkIntent,BulkDetails} from './finance-client';
import type {SettingsIntent} from './settings-intents';
import type {SelectedCategoryKey} from '../../../packages/finance-core/src/selected-categories';
export type WorkspaceIntent={kind:'set_category_binding';targetKey:string;categoryId:string|null;subcategoryId:string|null}|{kind:'add_catalog_categories';keys:SelectedCategoryKey[]}|{kind:'save_overview_view';id?:string;name:string;definition:OverviewView;isDefault:boolean;create:boolean}|{kind:'delete_overview_view';id:string}|{kind:'reorder_overview_views';viewIds:string[]}|{kind:'save_budget';id?:string;name:string;definition:BudgetDefinition;enabled:boolean;create:boolean;limitMinor?:string}|{kind:'set_budget_limit';id:string;limitMinor:string;applyFrom:'current'|'next'}|{kind:'delete_budget';id:string}|{kind:'reorder_operations_views';viewIds:string[]}|{kind:'save_operations_view';id?:string;name:string;definition:OperationsView;isDefault:boolean;create:boolean}|{kind:'delete_operations_view';id:string}|SettingsIntent|BulkIntent|{kind:'operation';id:string;patch:OperationPatch}|{kind:'account'|'category'|'counterparty';id:string;patch:Record<string,unknown>;create?:boolean}|{kind:'analytics';value:'cashflow'|'economic'}|{kind:'undo';id:string;value:string}|{kind:'restore_history';actionIds:string[]}|{kind:'cancel_import';batchId:string;fileId?:string}|{kind:'duplicate_different';id:string}|{kind:'merge_duplicate';id:string;canonicalId:string;sourceSide:MergeSide;choices:MergeChoices;components?:MergeSide|'none';dropLinkIds:string[]};
export type CommandState={phase:'idle'|'sending'|'preview'|'retry'|'stale'|'unavailable';title:string;error:string;message:string;preview:FinancePreview|null;undoActionId:string|null;bulkResult?:BulkDetails|null};
export const emptyCommand:CommandState={phase:'idle',title:'',error:'',message:'',preview:null,undoActionId:null,bulkResult:null};
type Pending={path:string;body:Record<string,unknown>;confirmation:boolean;generation:string;undo:boolean};
export class WorkspaceCommand{
 private state={...emptyCommand};private pending:Pending|null=null;private disposed=false;
 constructor(private deps:{view:()=>FinanceState|null;request:(path:string,body:Record<string,unknown>)=>Promise<FinancePreview|FinanceReceipt>;load:()=>Promise<FinanceState>},private changed:(state:CommandState)=>void,private saved:(state:FinanceState)=>void,private unavailable:()=>void){}
 private publish(patch:Partial<CommandState>){if(this.disposed)return;this.state={...this.state,...patch};this.changed({...this.state});}
 begin(intent:WorkspaceIntent,title:string,confirmation:boolean,epoch?:{generation:string;revision:string}){const view=this.deps.view();if(!view||this.disposed||this.state.phase!=='idle')return;const snapshot=epoch??view;this.publish({title,error:'',message:'',bulkResult:null});return this.send({path:'/finance/preview',body:{actionId:crypto.randomUUID(),generation:snapshot.generation,revision:snapshot.revision,intent:structuredClone(intent)},confirmation,generation:snapshot.generation,undo:['undo','restore_history'].includes(intent.kind)});}
 adoptPreview(preview:FinancePreview|FinanceReceipt,generation:string,title:string,confirmation=true,undo=false){const view=this.deps.view();if(!view||this.disposed||this.state.phase!=='idle'||view.generation!==generation)return;this.pending={path:'/finance/commit',body:{actionId:preview.actionId},confirmation,generation,undo};if(preview.status==='committed'){this.publish({title,error:'',message:'',bulkResult:null});return this.send(this.pending);}this.publish({phase:'preview',preview,title,error:'',message:'',bulkResult:null});if(!confirmation)return this.send(this.pending);}
 confirm(){if(this.state.phase==='preview'&&this.pending)return this.send(this.pending);}
 retry(){if(this.state.phase==='retry'&&this.pending)return this.send(this.pending);}
 cancel(){if(this.state.phase==='preview'){this.pending=null;this.publish({phase:'idle',preview:null,title:''});}}
 undo(){if(this.state.undoActionId)return this.begin({kind:'undo',id:crypto.randomUUID(),value:this.state.undoActionId},'Отмена последнего изменения',false);}
 private async send(pending:Pending):Promise<void>{
  if(this.disposed)return;this.pending=pending;this.publish({phase:'sending',error:''});
  try{const result=await this.deps.request(pending.path,pending.body);if(this.disposed)return;
   if(result.status==='previewed'){const commit={...pending,path:'/finance/commit',body:{actionId:result.actionId}};this.pending=commit;if(!pending.confirmation){await this.send(commit);return;}this.publish({phase:'preview',preview:result});return;}
   this.pending=null;this.publish({preview:null,bulkResult:result.impact?.details?.kind==='bulk_operations'?result.impact.details as BulkDetails:null,undoActionId:pending.undo||result.cleanup?null:result.actionId,message:result.cleanup?'Загрузка отменена. Для восстановления выберите исходные файлы заново.':pending.undo?'Изменение отменено.':'Изменение сохранено.'});
   try{const view=await this.deps.load();if(this.disposed)return;if(view.generation!==result.generation){this.publish({phase:'unavailable',error:'Финансовые данные сброшены. Откройте приложение заново.'});this.unavailable();return;}this.saved(view);this.publish({phase:'idle'});}
   catch(error){if(this.disposed)return;if(this.accessError(error))return;this.publish({phase:'stale',error:'Изменение сохранено, но данные не удалось обновить. Обновите их перед следующей правкой.'});}
  }catch(error){if(this.disposed)return;if(this.accessError(error))return;
   if(error instanceof ApiError&&error.code==='NETWORK_ERROR'){this.publish({phase:'retry',error:'Сервер не подтвердил результат. Повторите то же действие; второй записи не будет.'});return;}
   this.pending=null;const conflict=error instanceof ApiError&&['FINANCE_CHANGED','DEPENDENCIES_CHANGED','GENERATION_CHANGED','REVIEW_CHANGED','REVIEW_GROUP_CHANGED'].includes(error.code);this.publish({phase:conflict?'stale':'idle',preview:null,error:error instanceof Error?error.message:'Изменение не применено. Обновите данные и повторите.'});
  }
 }
 private accessError(error:unknown){if(error instanceof ApiError&&['AUTH_REQUIRED','FINANCE_ACCESS_REQUIRED','ACCESS_EXPIRED','SUSPENDED','GENERATION_CHANGED'].includes(error.code)){this.pending=null;this.publish({phase:'unavailable',preview:null,error:'Доступ к финансовым данным ограничен.'});this.unavailable();return true;}return false;}
 async reload(){if(this.disposed||!['idle','stale'].includes(this.state.phase))return;this.publish({phase:'sending',error:''});try{const view=await this.deps.load();if(this.disposed)return;this.saved(view);this.publish({phase:'idle',preview:null});}catch(e){if(this.disposed||this.accessError(e))return;this.publish({phase:'stale',error:'Данные не удалось обновить. Повторите позже.'});}}
 dispose(){this.disposed=true;this.pending=null;}
}

