import type {OperationsFilter} from '../../finance-core/src/operations.ts';
import type {calculateBudget} from '../../finance-core/src/budgets.ts';
export type BudgetReadRequest={names?:string[];overrunOnly?:boolean;date?:string};
export const budgetReadSchema={type:'object',additionalProperties:false,required:[],properties:{names:{type:'array',minItems:1,maxItems:30,uniqueItems:true,items:{type:'string',minLength:1,maxLength:160}},overrunOnly:{type:'boolean'},date:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'}}};
export type BudgetReadResult={version:'cashneuro-budget-read/1';generation:string;revision:string;items:({id:string;name:string;enabled:boolean;dependencyStatus:string;upcomingLimit?:{from:string;limitMinor:string}}&ReturnType<typeof calculateBudget>)[];notice:string};
export type BudgetReadExecution={value:BudgetReadResult;dependencyIds:string[]};
export type BudgetScope=OperationsFilter;
