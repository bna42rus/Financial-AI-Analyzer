/** Scripted synthetic replies for offline acceptance only. Never a live provider. */
import {intentVersion} from '../../src/next/intent.ts';
const keep={mode:'continue',conditions:'merge_ui'},fresh={mode:'new'},ref=(handle:string)=>({mode:'reference',handle,conditions:'pin'});
const envelope=(action:string,parameters:unknown,binding:unknown=fresh,format='auto')=>({version:intentVersion,action,parameters,binding,presentation:{format,detail:'normal'}});
const set=(field:string,value:unknown,quote:string)=>({field,op:'set',value,quote});
const condition=(field:string,expression:string)=>({field,op:'set',expression});
const read=(conditions:unknown[],binding:unknown=fresh,grouping:string|null=null,metric:string|null='expenses')=>envelope('read',{metric,grouping,comparison:null,conditions,options:{}},binding);
const month=(expression:string,binding:unknown=fresh,grouping:string|null=null)=>read([condition('period',expression)],binding,grouping);
const loan=(edits:unknown[],binding:unknown=fresh,format='auto')=>envelope('calculate',{calculator:'loan',edits},binding,format);
const compare=(scenarios:string[],criterion='value')=>envelope('compare',{scenarios,criterion,objective:criterion==='value'?'max':'min'},keep);
// Scripted replies test the harness and tool path. No provider is called here;
// real understanding quality is measured separately by --suite additional.
export const scriptedAdditionalReplies:Record<string,unknown>={
 'months-start':month('2025-10',fresh,'category'),
 'months-short':month('2025-09',fresh,'category'),
 'months-growth':compare(['t1','t2']),
 'months-explicit-base':compare(['t2','t1']),
 'months-current-ui':read([],fresh,'category'),
 'filters-start':read([condition('period','октябрь 2025'),condition('categories','Продукты')]),
 'filters-month':month('сентябрь',keep),
 'filters-strict-money':read([condition('amount','больше 120 рублей')],keep),
 'filters-clear-money':read([{field:'amount',op:'clear'}],keep),
 'filters-new-scope':month('2025-10',fresh,'category'),
 'loan-two-variants':loan([set('principalRubles','240000','240 тысяч'),set('annualRatePercent','12','12%'),set('months',24,'24 месяца')]),
 'loan-change-term':loan([set('months',12,'12 месяцев')],keep),
 'loan-zero-rate':loan([set('annualRatePercent','0','0%')],keep),
 'loan-choice-short':loan([set('payment','annuity','аннуитетный')],keep),
 'loan-switch-typo':loan([set('payment','differentiated','дифиренцированный')],keep),
 'loan-both-charts':loan([{field:'payment',op:'clear'}],keep,'chart'),
 'loan-tied-comparison':compare(['t6_v2','t6_v1'],'interest'),
 'mixed-read':month('2025-10',fresh,'category'),
 'mixed-new-loan':loan([set('principalRubles','100000','100000 рублей'),set('annualRatePercent','10','10%'),set('months',10,'10 месяцев'),set('payment','annuity','аннуитетный')]),
 'mixed-back-to-read':month('сентябрь',ref('t1')),
 'mixed-back-to-loan':loan([],ref('t2'),'chart'),
 'mixed-concept':envelope('explain',{subject:{kind:'concept',question:'Что означает аннуитетный?'}}),
 'mixed-rate-after-concept':loan([set('annualRatePercent','0','0%')],keep),
};
