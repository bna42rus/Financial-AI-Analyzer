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
