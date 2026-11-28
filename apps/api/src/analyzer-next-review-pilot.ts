/** Operator-only synthetic acceptance. Neither questions nor expected results
 * are imported by the HTTP engine or included in model input. */
import {createHash} from 'node:crypto';
import type {AdditionalCase} from '../../../packages/analyzer/src/next/additional-pilot.ts';
import {additionalPreparationMatches,additionalOutcomeMatches} from '../../../packages/analyzer/src/next/additional-pilot.ts';
import type {Understanding,TurnResult} from '../../../packages/analyzer/src/next/workflow.ts';
import type {Preparation} from '../../../packages/analyzer/src/next/tasks.ts';
import type {Catalog} from '../../../packages/analyzer/src/yandex-contract.ts';
import {intentVersion} from '../../../packages/analyzer/src/next/intent.ts';
import {PrototypeSession} from '../../../packages/analyzer/src/next/workflow.ts';
import {prepareTask} from '../../../packages/analyzer/src/next/tasks.ts';
import type {State,Environment} from '../../../packages/analyzer/src/next/tasks.ts';
import type {AssistantModel,AssistantJournal} from './assistant-workflow.ts';
import {nextModelCall} from './analyzer-next-model-call.ts';
import {reviewNextUnderstanding,nextReviewVersion,nextReviewSchema} from './analyzer-next-review.ts';
import {assertClosedSchema} from '../../../packages/analyzer/src/closed-schema.ts';
import {understandingPrompt,understandingSchema} from '../../../packages/analyzer/src/next/understanding.ts';
import {calculateWidget,parseWidget} from '../../../packages/finance-core/src/overview.ts';
import {rows,catalog as fixtureCatalog} from '../../../packages/analyzer/test/fixtures/next-finances.ts';

const strict={amountBasis:'absolute_operation' as const,amountFrom:'10001'};
export const reviewPilotCases:readonly AdditionalCase[]=[
 {id:'review-read-start',chain:'review-read',question:'За октябрь 2025 выведи траты по категориям со счёта «Учебный счёт». Сумма каждой операции строго больше 100 рублей.',expected:{kind:'read',grouping:'category',filter:{from:'2025-10-01',through:'2025-10-31',...strict},total:'15000'}},
 {id:'review-read-month',chain:'review-read',question:'Теперь сентябрь того же года. Прочие условия оставь прежними.',expected:{kind:'read',grouping:'category',filter:{from:'2025-09-01',through:'2025-09-30',...strict},total:'0'}},
 {id:'review-loan-start',chain:'review-loan',question:'Рассчитай оба способа погашения: кредит 120 тысяч рублей, 12% годовых, на два года.',expected:{kind:'loan',principal:'120000',rate:'12',months:24,payments:['annuity','differentiated']}},
 {id:'review-loan-chart',chain:'review-loan',question:'Выведи графики помесячных платежей для обоих способов. Сумму, ставку и срок не меняй.',expected:{kind:'loan',principal:'120000',rate:'12',months:24,payments:['annuity','differentiated'],chart:true}},
 // The first call is still recorded/billed honestly. Only this controlled
 // candidate is substituted before review; the runtime never repairs this way.
 {id:'review-rejects-lost-filter',chain:'review-negative',question:'За октябрь 2025 выведи траты по категориям со счёта «Учебный счёт». Сумма каждой операции строго больше 100 рублей.',expected:{kind:'read',grouping:'category',filter:{from:'2025-10-01',through:'2025-10-31'},total:'16800'}},
];
export const reviewPilotVersion='analyzer-next-review-pilot/1';
export const reviewPilotSignature=createHash('sha256').update(JSON.stringify({version:reviewPilotVersion,cases:reviewPilotCases,negativeControl:'omit_amount/1'})).digest('hex');
export function reviewPilotCandidate(id:string,raw:unknown):unknown{
 if(id!=='review-rejects-lost-filter')return raw;
 return {relevance:'financial',intent:{version:intentVersion,action:'read',binding:{mode:'new'},parameters:{metric:'expenses',grouping:'category',comparison:null,conditions:[{field:'period',op:'set',expression:'октябрь 2025'}],options:{}},presentation:{format:'auto',detail:'normal'}}};
}
export function reviewPilotPreparationMatches(c:AdditionalCase,p:Preparation|null,reply:Understanding,catalog:Catalog){return additionalPreparationMatches(c,p,reply,catalog);}
export function reviewPilotOutcomeMatches(c:AdditionalCase,r:TurnResult){
 return c.id==='review-rejects-lost-filter'?r.status==='failed'&&r.code==='SEMANTIC_REVIEW_REJECTED':additionalOutcomeMatches(c,r);
}

/** The ordinary reviewer alone gates execution. The numerical test oracle runs
 * afterwards and can report a failure, never authorize or repair the candidate. */
export async function runReviewPilotTurn(c:AdditionalCase,session:PrototypeSession,env:Environment,model:AssistantModel,journal:AssistantJournal,authorize:()=>Promise<void>,dispatch:'allow'|'replay_only'='allow'){
 let reviewed:{state:State;reply:Understanding}|undefined,accepted:boolean|undefined,replayed=false,reads=0,diagnostic='';
 const remember=(e:unknown)=>{const code=(e as {code?:unknown})?.code??(e instanceof Error&&/^(?:TASK|NEXT_REVIEW)_[A-Z_]{1,70}$/.test(e.message)?e.message:undefined);diagnostic=typeof code==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(code)?code:'PILOT_REVIEW_FAILED';};
 const result=await session.run(env,{async understand(input){try{const r=await nextModelCall(model,journal,{phase:'understand',prompt:understandingPrompt,input,schema:understandingSchema},0,dispatch);replayed=r.replayed;return reviewPilotCandidate(c.id,r.value);}catch(e){remember(e);throw e;}}},{
  current:()=>env,authorize,
  async review(input,reply){reviewed={state:session.snapshot(),reply:structuredClone(reply)};try{accepted=await reviewNextUnderstanding(input,reply,reviewed.state,env,model,journal,dispatch);return accepted;}catch(e){remember(e);throw e;}},
  tools:{guard:authorize,async read(query){reads++;return calculateWidget(parseWidget({id:env.scope.chatId,name:'Синтетическая выборка',metrics:[query.metric],grouping:query.grouping,filter:query.filter,comparison:query.comparison==='custom'?{kind:'custom',...query.options?.comparisonPeriod}:{kind:query.comparison},chart:'table',topN:50}),rows,fixtureCatalog,{},new Date(env.date+'T12:00:00Z'),'Europe/Moscow',true);}},
 });
 let expected=false,resolved='';
 if(reviewed)try{const p=reviewed.reply.intent?prepareTask(reviewed.state,env,reviewed.reply.intent):null;expected=reviewPilotPreparationMatches(c,p,reviewed.reply,env.catalog);resolved=p?(p.status==='ready'?p.task.kind:p.status):reviewed.reply.relevance;}catch{/* Report a mismatch; never repair or retry. */}
 const negative=c.id==='review-rejects-lost-filter';
 const matches=expected&&reviewPilotOutcomeMatches(c,result)&&accepted===!negative&&(!negative||reads===0&&session.snapshot().history.length===0);
 return {result,matches,accepted,replayed,reads,resolved,diagnostic};
}
/** Enough to diagnose a review failure in the same terminal output. Arbitrary
 * response strings/keys are not echoed; quotes must come from the fixed case. */
export function reviewPilotDiagnostic(raw:unknown,question:string){
 const r=raw&&typeof raw==='object'?raw as Record<string,unknown>:{},conditions=Array.isArray(r.conditions)?r.conditions:[];
 let schemaValid=true;try{assertClosedSchema(raw,nextReviewSchema);}catch{schemaValid=false;}
 const source=(c:any)=>typeof c?.quote==='string'&&!!c.quote.trim()&&question.includes(c.quote);
 return {received:raw!==undefined,schemaValid,versionMatches:r.version===nextReviewVersion,decision:r.decision==='accept'||r.decision==='reject'?r.decision:'unsupported',conditionCount:conditions.length,
  invalidEvidenceCount:conditions.filter(c=>!source(c)).length,duplicateQuoteCount:conditions.length-new Set(conditions.map(c=>c?.quote)).size,
  uncoveredSourceConditions:conditions.filter(c=>source(c)&&c.covered===false).slice(0,8).map(c=>c.quote),unknownFieldCount:Object.keys(r).filter(k=>!['version','decision','conditions'].includes(k)).length};
}
