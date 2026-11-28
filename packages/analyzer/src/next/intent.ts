/** Inactive contract prototype. Not imported by the current workflow or provider.
 * Parsing proves structure only. Preparation, semantic review and authorization
 * remain separate gates; never execute this value as a Registry command.
 */
import {assertClosedSchema} from '../closed-schema.ts';
import {calculatorSchema} from '../calculators.ts';
import type {CalculatorInput} from '../calculators.ts';
import {assistantChangeSchema} from '../assistant-changes.ts';
import type {AssistantChange} from '../assistant-changes.ts';
import {financialSourceSchema} from '../financial-sources.ts';
import type {FinancialSourceRequest} from '../financial-sources.ts';
import {queryMetrics, queryGroupings, queryComparisons} from '../registry.ts';
import type {Query} from '../registry.ts';
import {conditionFields} from '../task-context.ts';
import type {Condition} from '../task-context.ts';
import {analysisOptionsSchema} from '../analysis.ts';
import type {AnalysisOptions} from '../analysis.ts';

export const intentVersion = 'cashneuro-intent-prototype/1';
const en = (values: readonly string[]) => ({type:'string', enum:values});
const text = {type:'string', minLength:1, maxLength:1000};
const alias = {type:'string', pattern:'^[a-z][a-z0-9_]{0,31}$'};
const fieldName = {type:'string', pattern:'^[a-z][a-zA-Z0-9_]{0,63}$'};
const closed = (properties:Record<string, unknown>) => ({type:'object', additionalProperties:false, properties, required:Object.keys(properties)});
const list = (items:unknown, maxItems:number, minItems=0) => ({type:'array', items, minItems, maxItems});
const nullable = (schema:unknown) => ({anyOf:[schema,{type:'null'}]});
const bindingSchema = {anyOf:[
  closed({mode:en(['new'])}),
  closed({mode:en(['continue']), conditions:en(['merge_ui','pin'])}),
  closed({mode:en(['reference']), handle:alias, conditions:en(['pin'])}),
  closed({mode:en(['answer']), clarification:alias, option:nullable(alias)}),
]};
export type Binding = {mode:'new'} | {mode:'continue'; conditions:'merge_ui'|'pin'} |
  {mode:'reference'; handle:string; conditions:'pin'} | {mode:'answer'; clarification:string; option:string|null};
export type Presentation = {format:'auto'|'number'|'table'|'chart'|'operations'; detail:'short'|'normal'|'detailed'};
const presentationSchema = closed({format:en(['auto','number','table','chart','operations']), detail:en(['short','normal','detailed'])});
export type ConditionEdit = {field:Condition; op:'set'; expression:string} | {field:Condition; op:'clear'|'use_current'};
const conditionEditSchema = {anyOf:[
  closed({field:en(Object.keys(conditionFields)), op:en(['set']), expression:text}),
  closed({field:en(Object.keys(conditionFields)), op:en(['clear','use_current'])}),
]};
type Edits<T> = {[K in keyof Omit<T,'kind'>]-?:
  {field:K; op:'set'; value:NonNullable<T[K]>; quote:string} | {field:K; op:'clear'}
}[keyof Omit<T,'kind'>];
export type CalculationParameters = {[K in CalculatorInput['kind']]:
  {calculator:K; edits:Edits<Extract<CalculatorInput,{kind:K}>>[]}
}[CalculatorInput['kind']];
// Reuse existing per-calculator field schemas; do not duplicate monetary models.
const calculationSchema = {anyOf:calculatorSchema.anyOf.map(schema => {
  const props = schema.properties as Record<string,unknown>;
  const kind = (props.kind as {enum:string[]}).enum;
  return closed({calculator:en(kind), edits:list({anyOf:Object.entries(props).filter(([field])=>field!=='kind').flatMap(([field,value])=>[
    closed({field:en([field]), op:en(['set']), value, quote:text}),
    closed({field:en([field]), op:en(['clear'])}),
  ])},32)});
})};
type Envelope<A extends string,P> = {version:typeof intentVersion; action:A; binding:Binding; parameters:P; presentation:Presentation};
export type SimpleIntent =
  | Envelope<'read',{metric:Query['metric']|null; grouping:Query['grouping']|null; comparison:Query['comparison']|null; conditions:ConditionEdit[]; options:AnalysisOptions}>
  | Envelope<'calculate',CalculationParameters>
  | Envelope<'compare',{scenarios:string[]; criterion:'interest'|'total_paid'|'payment'|'net_return'|'value'; objective:'min'|'max'}>
  | Envelope<'explain',{subject:{kind:'concept'; question:string}|{kind:'result'; handle:string}}>
  | Envelope<'advise',{goal:string; constraints:string[]; evidence:string[]}>
  | Envelope<'propose',AssistantChange>
  | Envelope<'source',FinancialSourceRequest>
  | Envelope<'interface',{command:string}>
  | Envelope<'clarify',{question:string; missing:string[]}>
  | Envelope<'unrelated',{message:string}>;
export type ReportStep = {key:string; after:string[]; intent:SimpleIntent; bindings:{field:string; step:string; fact:string}[]};
export type Intent = SimpleIntent | Envelope<'report',{steps:ReportStep[]}>;
const envelope = (action:string, parameters:unknown) => closed({version:en([intentVersion]), action:en([action]), binding:bindingSchema, parameters, presentation:presentationSchema});
const simpleSchemas = [
  envelope('read',closed({metric:nullable(en(queryMetrics)), grouping:nullable(en(queryGroupings)), comparison:nullable(en(queryComparisons)), conditions:list(conditionEditSchema,32), options:analysisOptionsSchema})),
  envelope('calculate',calculationSchema),
  envelope('compare',closed({scenarios:list(alias,6,2), criterion:en(['interest','total_paid','payment','net_return','value']), objective:en(['min','max'])})),
  envelope('explain',closed({subject:{anyOf:[closed({kind:en(['concept']),question:text}),closed({kind:en(['result']),handle:alias})]}})),
  envelope('advise',closed({goal:text, constraints:list(text,20), evidence:list(alias,20)})),
  envelope('propose',assistantChangeSchema),
  envelope('source',financialSourceSchema),
  // command is parsed only by the existing finite interfaceAction registry.
  envelope('interface',closed({command:text})),
  envelope('clarify',closed({question:text, missing:list(text,20,1)})),
  envelope('unrelated',closed({message:text})),
];
const reportSchema = (stepIntent:unknown) => envelope('report',closed({steps:list(closed({
  key:alias, after:list(alias,12), intent:stepIntent, bindings:list(closed({field:fieldName,step:alias,fact:fieldName}),20),
}),12,1)}));
export const intentSchema = {anyOf:[...simpleSchemas,reportSchema({anyOf:simpleSchemas})]};
function invalid():never {throw new TypeError('INTENT_PROTOTYPE_INVALID');}
function unique(values:string[]) {if(new Set(values).size!==values.length) invalid();}
function checkSimple(intent:SimpleIntent) {
  if(intent.action==='calculate') unique(intent.parameters.edits.map(e=>e.field));
  if(intent.action==='read') unique(intent.parameters.conditions.map(e=>e.field));
  if(intent.action==='compare') unique(intent.parameters.scenarios);
}
export function parseIntent(raw:unknown):Intent {
  try {
    // Validate the bounded report frame and each bounded simple intent separately.
    // A nested schedule must not consume the legacy validator's depth budget
    // merely because it belongs to a report. Never relax that shared boundary.
    if(raw && typeof raw==='object' && 'action' in raw && raw.action==='report') {
      const frame = structuredClone(raw) as Record<string,unknown>;
      const params = frame.parameters as {steps?:unknown[]} | null;
      if(params && Array.isArray(params.steps)) for(const step of params.steps)
        if(step && typeof step==='object') (step as Record<string,unknown>).intent=null;
      assertClosedSchema(frame,reportSchema({type:'null'}));
      for(const step of (raw as Extract<Intent,{action:'report'}>).parameters.steps)
        assertClosedSchema(step.intent,{anyOf:simpleSchemas});
    } else assertClosedSchema(raw,{anyOf:simpleSchemas});
  } catch {invalid();}
  const intent = structuredClone(raw) as Intent;
  if(intent.action!=='report') {checkSimple(intent); return intent;}
  const steps = intent.parameters.steps, byKey = new Map(steps.map(s=>[s.key,s]));
  unique(steps.map(s=>s.key));
  for(const step of steps) {
    checkSimple(step.intent); unique(step.after); unique(step.bindings.map(b=>b.field));
    if(step.after.some(key=>key===step.key||!byKey.has(key))) invalid();
    // Facts can only originate in an explicitly declared prerequisite.
    if(step.bindings.some(b=>!step.after.includes(b.step))) invalid();
  }
  const visiting = new Set<string>(), complete = new Set<string>();
  const visit = (key:string) => {
    if(visiting.has(key)) invalid(); if(complete.has(key)) return;
    visiting.add(key); for(const dep of byKey.get(key)!.after) visit(dep);
    visiting.delete(key); complete.add(key);
  };
  for(const step of steps) visit(step.key);
  return intent;
}
