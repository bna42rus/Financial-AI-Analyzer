import type {Bank} from './contract.ts';
export type ImportStatus='accepted'|'processing'|'completed'|'partial'|'invalidated'|'cancelled';
export type RowCounts={rowsFound:number;pending:number;created:number;existing:number;updated:number;notImported:number;removed:number;review:number};
export type TransactionCounts={total:number;created:number;existing:number;updated:number;review:number};
export type ImportReport={schemaVersion:1;batchId:string;generation?:string;revision?:string;operationIds?:string[];stage:'server_accepted';status:ImportStatus;createdAt:string;finishedAt:string|null;counts:RowCounts&{files:number;blockedFiles:number};transactionCounts:TransactionCounts;newAccountIds:string[];files:{fileId:string;operationIds?:string[];bank:Bank;cancelledAt?:string|null;blocked:boolean;error:string|null;counts:RowCounts;transactionCounts:TransactionCounts;issues:{ordinal:number;code:string;nextStep:string}[]}[]};
export type ImportHistory={batches:{batchId:string;status:ImportStatus;createdAt:string;finishedAt:string|null;files:number;rowsFound:number}[];nextCursor:string|null};
export const importActive=(status:ImportStatus)=>status==='accepted'||status==='processing';
