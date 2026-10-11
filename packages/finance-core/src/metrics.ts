import type {Part} from './graph.ts';
import type {Semantics} from './model.ts';

export const metrics=['expenses','gross_expenses','income','difference','refunds','reimbursements','expense_reductions','own_transfers','transfers','loan_payments','loan_costs','fees','cash','operation_count','attention','budget'] as const;
export type Metric=typeof metrics[number];
export type MetricRow={classification:Semantics;reviewReasons:string[];componentTypes?:Record<string,string>;allocationKinds?:Record<string,string>};
const abs=(n:bigint)=>n<0n?-n:n;
export function metricMatches(metric:Metric,p:Part,o:MetricRow):boolean{
 const kind=o.classification.kind.value,amount=BigInt(p.amountMinor),links=p.basis.map(id=>o.allocationKinds?.[id]);
 switch(metric){
  case 'expenses':case 'gross_expenses':case 'expense_reductions':return p.role==='expense'&&(metric==='expenses'||(metric==='gross_expenses'?amount<0n:amount>0n));
  case 'income':return p.role==='income';
  case 'difference':return p.role==='income'||p.role==='expense';
  case 'refunds':return p.role==='expense'&&amount>0n&&!links.includes('expense_reimbursement');
  case 'reimbursements':return p.role==='expense'&&amount>0n&&links.includes('expense_reimbursement');
  // Count debit portions once, including partial own-transfer allocations.
  case 'own_transfers':return amount<0n&&p.role==='neutral'&&(kind==='own_transfer'||links.includes('own_transfer'));
  case 'transfers':return ['transfer_in','transfer_out','own_transfer'].includes(kind);
  case 'loan_payments':return kind==='loan_payment'&&amount<0n;
  case 'loan_costs':return amount<0n&&p.role==='expense'&&(['interest','fee','insurance'].includes(kind)||kind==='loan_payment'&&['interest','fee','insurance'].includes(o.componentTypes?.[p.componentId??'']??''));
  case 'fees':return amount<0n&&p.role==='expense'&&(kind==='fee'||o.componentTypes?.[p.componentId??'']==='fee');
  case 'cash':return ['cash_withdrawal','cash_deposit'].includes(kind);
  case 'attention':return o.reviewReasons.length>0;
  case 'operation_count':return true;
  case 'budget':return false;
 }
}
export function metricAmount(metric:Metric,p:Part,o:MetricRow):bigint{
 if(!metricMatches(metric,p,o))return 0n;
 const n=BigInt(p.amountMinor);
 if(['own_transfers','loan_payments','loan_costs','fees'].includes(metric))return abs(n);
 if(metric==='expenses'||metric==='gross_expenses')return -n;
 return n;
}
