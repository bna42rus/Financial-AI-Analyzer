/** Synthetic suite selection and oracle, separate from the model's input. */
import {createHash} from 'node:crypto';
import {additionalCases,additionalFilter,additionalPreparationMatches,additionalOutcomeMatches} from '../../../packages/analyzer/src/next/additional-pilot.ts';
import type {AdditionalCase} from '../../../packages/analyzer/src/next/additional-pilot.ts';
import {pilotCases,pilotPreparationMatches,pilotOutcomeMatches} from '../../../packages/analyzer/src/next/pilot.ts';
import type {PilotId} from '../../../packages/analyzer/src/next/pilot.ts';
import type {Preparation} from '../../../packages/analyzer/src/next/tasks.ts';
import type {Understanding,TurnResult} from '../../../packages/analyzer/src/next/workflow.ts';
import type {Catalog} from '../../../packages/analyzer/src/yandex-contract.ts';
import type {GlobalSnapshot} from '../../../packages/analyzer/src/task-context.ts';
import {parseIntent} from '../../../packages/analyzer/src/next/intent.ts';
import {queryMetrics,queryGroupings} from '../../../packages/analyzer/src/registry.ts';
import {analysisOptionsSchema} from '../../../packages/analyzer/src/analysis.ts';
import {calculatorSchema} from '../../../packages/analyzer/src/calculators.ts';
export type SuiteCase={id:string;chain:string;question:string;ui?:AdditionalCase['ui']};
export function createPilotSuite(name:unknown,catalog:Catalog){
 if(name!==undefined&&name!=='basic'&&name!=='additional')throw Error('PILOT_SUITE_INVALID');
 const additional=name==='additional',cases:readonly SuiteCase[]=additional?additionalCases:pilotCases;
 const version=additional?'analyzer-next-additional/1':'analyzer-next-pilot/1',limitRub=additional?'5':'10';
 const caseSignature=additional?createHash('sha256').update(JSON.stringify(cases.map(c=>({id:c.id,chain:c.chain,question:c.question,ui:c.ui??null})))).digest('hex'):undefined;
 return {name:additional?'additional':'basic',version,cases,limitRub,caseSignature,
  global(c:SuiteCase):GlobalSnapshot{return {revision:c.ui?.revision??0,filter:additionalFilter(c.ui?.filter??{},catalog),touched:c.ui?.revision?{period:c.ui.revision,categories:c.ui.revision}:{}};},
  preparationMatches(c:SuiteCase,p:Preparation|null,reply:Understanding){return additional?additionalPreparationMatches(c as AdditionalCase,p,reply,catalog):!!p&&reply.intent!==null&&(c.id!=='read-compare'||reply.intent.action==='compare'&&reply.intent.parameters.objective==='max')&&pilotPreparationMatches(c.id as PilotId,p);},
  outcomeMatches(c:SuiteCase,r:TurnResult){return additional?additionalOutcomeMatches(c as AdditionalCase,r):c.id==='loan-concept'?r.status==='explanation':r.status==='completed'&&pilotOutcomeMatches(c.id as PilotId,r.outcome);},
 };
}
/** Invalid replies expose finite shape facts, never arbitrary values/key names. */
export function pilotIntentDiagnostic(raw:unknown):unknown{
 try{const p=parseIntent(raw);return {action:p.action,binding:p.binding,parameters:p.parameters};}catch{}
 const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
 const r=record(raw),p=record(r.parameters),options=record(p.options),b=record(r.binding),presentation=record(r.presentation);
 const finite=(value:unknown,allowed:readonly string[])=>typeof value==='string'&&allowed.includes(value)?value:'unsupported';
 const common=['version','action','binding','parameters','presentation'];
 const optionNames=Object.keys(analysisOptionsSchema.properties);
 const calculatorKinds=calculatorSchema.anyOf.map(s=>(s.properties.kind as {enum:string[]}).enum[0]!),calculatorFields=[...new Set(calculatorSchema.anyOf.flatMap(s=>Object.keys(s.properties)))];
 const edits=Array.isArray(p.edits)?p.edits.slice(0,32).map(value=>{const e=record(value);return {field:finite(e.field,calculatorFields),op:finite(e.op,['set','clear']),valueKind:e.value===null?'null':Array.isArray(e.value)?'array':typeof e.value,valueChoice:finite(e.value,['annuity','differentiated','both','reduce_term','reduce_payment']),hasQuote:Object.hasOwn(e,'quote'),extraFieldCount:Object.keys(e).filter(k=>!['field','op','value','quote'].includes(k)).length};}):null;
 return {invalid:true,action:finite(r.action,['read','calculate','compare','explain']),bindingMode:finite(b.mode,['new','continue','reference','answer']),
  missing:common.filter(k=>!Object.hasOwn(r,k)),unknownCommonCount:Object.keys(r).filter(k=>!common.includes(k)).length,
  metric:finite(p.metric,[...queryMetrics,'loan_payments']),grouping:finite(p.grouping,[...queryGroupings,'time']),calculator:finite(p.calculator,calculatorKinds),edits,
  ...(r.action==='compare'?{scenarioCount:Array.isArray(p.scenarios)?p.scenarios.length:null,scenarioAliases:Array.isArray(p.scenarios)?p.scenarios.slice(0,100).map(v=>typeof v==='string'&&/^t[1-9][0-9]*(?:_v[1-9][0-9]*)?$/.test(v)&&v.length<=32?v:'unsupported'):null,criterion:finite(p.criterion,['interest','total_paid','payment','net_return','value']),objective:finite(p.objective,['min','max']),unknownParameterCount:Object.keys(p).filter(k=>!['scenarios','criterion','objective'].includes(k)).length}:{}),
  presentationFormat:finite(presentation.format,['auto','number','table','chart','operations']),
  invalidPresentationOptionNames:['format','detail'].filter(k=>Object.hasOwn(options,k)),unknownOptionCount:Object.keys(options).filter(k=>!optionNames.includes(k)).length};
}
