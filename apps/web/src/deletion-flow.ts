import {ApiError} from './server-client';
import type {FinanceImpact,FinanceReceipt} from './finance-client';
export type DeleteScope={kind:'operations';operationIds:string[]}|{kind:'period';from:string;through:string;accountIds?:string[]}|{kind:'account';accountId:string;deleteAccount:boolean}|{kind:'counterparty';counterpartyId:string;deleteCard:boolean};
export type DeletionIntent={kind:'delete_financial';scope:DeleteScope}|{kind:'reset_financial';keepCategories:boolean;keepRules:boolean;keepInterface:boolean};
export type DeletionEpoch={generation:string;revision:string;recentAuthenticationRequired?:boolean};
export type DeletionDetails={kind:'delete_financial'|'reset_financial';counts:Record<string,number>;operationIds?:string[];retainedOperationIds?:string[];survivingRelatedOperationIds?:string[];accountsDeleted?:string[];aliasesDeleted?:number;counterpartiesDeleted?:string[];counterpartyAliasesDeleted?:number;rulesNeedSetup:string[]|number;preserved?:{categories:number;rules:number;interface:boolean}};
export type DeletionPreview={status:'previewed';actionId:string;impact:Partial<Omit<FinanceImpact,'details'>>&{details:DeletionDetails}};
export type DeletionReceipt=FinanceReceipt&{interfaceEpoch?:string;cleanup:{destructive:true;undoable:false;interfaceReset?:boolean;counts?:Record<string,number>}};
export type DeletionState={phase:'draft'|'sending'|'preview'|'retry'|'stale'|'done'|'unavailable';preview:DeletionPreview|null;receipt:DeletionReceipt|null;error:string;requiresPassword:boolean};
export const emptyDeletion:DeletionState={phase:'draft',preview:null,receipt:null,error:'',requiresPassword:false};
type Pending={path:'/finance/preview'|'/finance/commit';body:Record<string,unknown>;reset:boolean};
/** Keeps one action identity across uncertain responses. Password proof is never retained in pending state. */
export class DeletionFlow{
 private state:DeletionState={...emptyDeletion};private pending:Pending|null=null;private disposed=false;
 constructor(private deps:{epoch:()=>Promise<DeletionEpoch>;request:(path:string,body:Record<string,unknown>)=>Promise<DeletionPreview|DeletionReceipt>;committed:(receipt:DeletionReceipt)=>Promise<void>;unavailable:()=>void},private changed:(state:DeletionState)=>void){}
 private publish(patch:Partial<DeletionState>){if(this.disposed)return;this.state={...this.state,...patch};this.changed({...this.state});}
 async begin(intent:DeletionIntent,epoch?:DeletionEpoch){if(this.disposed||this.state.phase!=='draft')return;const copy=structuredClone(intent);this.publish({phase:'sending',error:''});try{const context=copy.kind==='reset_financial'?await this.deps.epoch():epoch;if(this.disposed)return;if(!context)throw new Error('Обновите данные перед удалением.');this.publish({requiresPassword:copy.kind==='reset_financial'&&!!context.recentAuthenticationRequired});await this.send({path:'/finance/preview',body:{actionId:crypto.randomUUID(),generation:context.generation,revision:context.revision,intent:copy},reset:copy.kind==='reset_financial'});}catch(e){this.failed(e);}}
 confirm(password?:string){if(this.state.phase==='preview'&&this.pending)return this.send(this.pending,password);}
 retry(password?:string){if(this.state.phase==='retry'&&this.pending)return this.send(this.pending,password);}
 private async send(pending:Pending,password?:string){if(this.disposed)return;this.pending=pending;this.publish({phase:'sending',error:''});try{const body=password&&pending.reset&&pending.path==='/finance/commit'?{...pending.body,password}:pending.body;const result=await this.deps.request(pending.path,body);if(this.disposed)return;
  if(result.status==='previewed'){this.pending={path:'/finance/commit',body:{actionId:result.actionId,...(pending.reset?{confirmReset:true}:{})},reset:pending.reset};this.publish({phase:'preview',preview:result});return;}
  this.pending=null;this.publish({phase:'done',preview:null,receipt:result,error:''});try{await this.deps.committed(result);}catch(e){if(this.disposed)return;if(this.access(e))return;this.publish({error:'Удаление завершено, но свежие данные не загрузились. Закройте окно и обновите данные.'});}
 }catch(e){this.failed(e);}}
 private access(e:unknown){if(e instanceof ApiError&&['AUTH_REQUIRED','FINANCE_ACCESS_REQUIRED','ACCESS_EXPIRED','SUSPENDED'].includes(e.code)){this.pending=null;this.publish({phase:'unavailable',preview:null,error:'Доступ к финансовым данным ограничен.'});this.deps.unavailable();return true;}return false;}
 private failed(e:unknown){if(this.disposed||this.access(e))return;const code=e instanceof ApiError?e.code:'';if(code==='NETWORK_ERROR'&&this.pending){this.publish({phase:'retry',error:'Сервер не подтвердил результат. Повторите то же действие; повторного удаления не будет.'});return;}
  if(this.pending?.reset&&this.pending.path==='/finance/commit'&&['RECENT_AUTHENTICATION_REQUIRED','INVALID_CREDENTIALS','RATE_LIMITED'].includes(code)){this.publish({phase:'preview',requiresPassword:true,error:e instanceof Error?e.message:'Подтвердите паролем.'});return;}
  this.pending=null;const stale=['FINANCE_CHANGED','DEPENDENCIES_CHANGED','GENERATION_CHANGED'].includes(code);this.publish({phase:stale?'stale':'draft',preview:null,error:stale?'Данные или зависимости изменились. Ничего не удалено. Закройте окно, обновите данные и проверьте последствия заново.':e instanceof Error?e.message:'Удаление не выполнено.'});
 }
 dispose(){this.disposed=true;this.pending=null;this.state={...emptyDeletion};}
}
