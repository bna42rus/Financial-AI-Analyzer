import type {AccessRequest,Payment,AuditEntry,Duration,Tariff} from './model.ts';
export type RenewalState='open'|'completed'|'cancelled'|'rejected';
export type RenewalRow=AccessRequest&{renewalState:RenewalState;accessEnd?:string};
export type Cycle={anchorAt:string;accessEnd:string;timezone:string;revision:number;calendarMonths:number;extraDays:number};
export type RenewalQueue={requests:RenewalRow[];payments:Payment[];audit:AuditEntry[];extensions:Extension[]};
export type Extension={requestId:string;actionId:string;at:string;mode:'continuous'|'restored';previousEnd:string;accessEnd:string;anchorAt:string;timezone:string;duration:Duration};
export type RenewalPreview={request:RenewalRow;payment?:Payment;duration?:Duration;extension?:Extension;cycleRevision:number;mode:'continuous'|'restored'};
export type OwnRenewal={cycle:Cycle;request:RenewalRow|null;tariffs:Tariff[]};
export function renewalLabel(row:RenewalRow){return row.renewalState==='completed'?'Продление подтверждено':row.renewalState==='cancelled'?'Заявка отменена':row.renewalState==='rejected'?'Заявка отклонена':row.status==='under_review'?'На проверке':row.status==='needs_topup'?'Ожидает доплаты':'Ожидает оплаты';}
