import type {Duration} from './model.ts';
import type {Cycle} from './renewal.ts';
export type ManualTerm=Duration|{kind:'fixed';end:string}|{kind:'indefinite'};
export type QuotaPolicy={source:'override';limit:number}|{source:'tariff';tariffId:string;limit:number};
export type AccessType='Paid'|'Test'|'Free'|'Other';
export type ManualCommand={actionId:string;mode:'invite'|'extend'|'set_end'|'indefinite'|'end_now';reason:string;email?:string;userId?:string;term?:ManualTerm;accessType?:AccessType;quota?:{source:'override';limit:number}|{source:'tariff';tariffId:string};inviteHours?:number;expectedRevision?:number;expectedMode?:string;expectedQuota?:QuotaPolicy};
export type ManualPreview={mode:string;previousMode:string;previous:Cycle|null;next:Cycle|null;quota:QuotaPolicy;email:string;blocked:boolean;expectedRevision:number;term?:ManualTerm;inviteHours?:number};
export type ManualUser={userId:string;name:string;email:string;status:string;registeredAt:string;cycle:Cycle|null};
export type ManualInvite={id:string;grantId:string;email:string;createdAt:string;expiresAt:string;state:string;term:ManualTerm;accessType:AccessType;quota:QuotaPolicy;reason:string};
export type ManualAudit={actionId:string;actorId:string;at:string;email:string;userId:string|null;mode:string;reason:string;before:Cycle|null;after:Cycle|null;quota:QuotaPolicy};
export type ManualQueue={users:ManualUser[];invitations:ManualInvite[];audit:ManualAudit[];tariffs:{id:string;name:string;aiQuota:number}[]};
export function termLabel(term:ManualTerm){return term.kind==='indefinite'?'Бессрочно':term.kind==='fixed'?'До выбранной даты':term.kind==='days'?`${term.count} дней`:`${term.count} календарных месяцев`;}
