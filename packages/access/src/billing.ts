import type {Tariff} from './model.ts';
export type BillingPlan=Pick<Tariff,'id'|'name'|'duration'|'priceMinor'|'aiQuota'|'catalogVersion'>;
export const billingPlan=(t:Tariff):BillingPlan=>({id:t.id,name:t.name,duration:t.duration,priceMinor:t.priceMinor,aiQuota:t.aiQuota,catalogVersion:t.catalogVersion??0});
export function sameBillingPlan(a:BillingPlan,b:BillingPlan){
 return a.id===b.id&&a.priceMinor===b.priceMinor&&a.duration.kind===b.duration.kind&&a.duration.count===b.duration.count&&a.aiQuota===b.aiQuota;
}
export const noticeLeadMs=72*3600000;
export function mayAutoCharge(input:{now:number;due:number;noticeAcceptedAt:number|null;hasCurrentPermission:boolean;matchesOffer:boolean}){
 return input.hasCurrentPermission&&input.matchesOffer&&input.now>=input.due&&input.now-input.due<23*3600000&&input.noticeAcceptedAt!==null&&input.noticeAcceptedAt<=input.due-noticeLeadMs;
}
export const rubleValue=(minor:string)=>{
 const n=BigInt(minor);return String(n/100n)+'.'+String(n%100n).padStart(2,'0');
};
