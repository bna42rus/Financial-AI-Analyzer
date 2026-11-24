/** Offline replay of archived synthetic smoke plans. No provider, DB connection,
 * financial writes or budget settlement. Never print archived model values. */
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {extendedCases} from './analyzer-live-cases.ts';
import {parseAssistantPlan,compileAssistantPlan} from '../packages/analyzer/src/assistant-plan.ts';
import {emptyConversation} from '../packages/analyzer/src/assistant-conversation.ts';
import {calculateFinancial} from '../packages/analyzer/src/calculators.ts';
import {bindReportValues,deriveReportFact,sectionFacts} from '../packages/analyzer/src/report.ts';
import type {ReportResult,ReportSection} from '../packages/analyzer/src/report.ts';

export const archiveCaseNames=['loan-free-wording','loan-prepayment','multiple-read-conditions','deposit-compound-additions','percentage-decimal'];
const fold=(s:string)=>s.normalize('NFKC').replace(/\s+/gu,' ').trim();
export async function checkArchivedPlans(rows:unknown):Promise<{name:string;passed:boolean;code:string}[]>{
 if(!Array.isArray(rows)||!rows.length||rows.length>5)throw Error('ARCHIVE_INPUT_INVALID');
 const known=await extendedCases(async()=>({chatId:randomUUID(),chatEpoch:randomUUID()}));const seen=new Set<string>();
 return rows.map(row=>{
  const name=typeof row?.name==='string'&&archiveCaseNames.includes(row.name)?row.name:'unknown';
  try{
   const example=known.find(c=>c.name===name);
   if(!example||seen.has(name)||typeof row.question!=='string'||fold(row.question)!==fold(example.text))throw Error('ARCHIVE_CASE_MISMATCH');seen.add(name);
   if(!Array.isArray(row.calls)||row.calls.length>3)throw Error('ARCHIVE_CALLS_INVALID');
   const first=row.calls.find((c:any)=>c.phase==='understand'),review=row.calls.findLast((c:any)=>c.phase==='check_changes');
   if(first?.state!=='received')throw Error('ARCHIVE_UNDERSTAND_MISSING');
   // The original candidate must now parse without its former repair call.
   const initial=parseAssistantPlan(first.value),plan=review?parseAssistantPlan(review.value?.plan):initial;
   if(review&&(review.state!=='received'||!Array.isArray(review.value?.conditions)||review.value.conditions.some((c:any)=>c.scope==='financial'&&c.covered!==true)))throw Error('ARCHIVE_CONDITIONS_INVALID');
   let answer:any;
   if(plan.action==='calculate')answer={calculation:calculateFinancial(plan.calculation)};
   else if(plan.action==='read'){
    const scope={ownerId:'archive-synthetic-owner',chatId:randomUUID(),chatEpoch:randomUUID(),generation:randomUUID()};
    const compiled=compileAssistantPlan({plan,scope,book:emptyConversation(scope).book,global:{revision:0,filter:{},touched:{}},messageId:randomUUID(),calendar:{currentDate:'2026-11-24',timezone:'Europe/Moscow'}},{accounts:[],categories:[],counterparties:[]});
    if(compiled.status!=='resolved')throw Error(compiled.reason);answer={query:compiled.query};
   }else if(plan.action==='report'){
    const report:ReportResult={version:'cashneuro-report/1',sections:[],facts:[],narrative:[]};
    for(const [i,step]of plan.report!.steps.entries()){
     const section:ReportSection={index:i+1,label:step.label};
     if(step.kind==='calculate')section.calculation=calculateFinancial(bindReportValues(step.calculation,step.bindings,report.facts));
     else if(step.kind==='derive')section.derived=deriveReportFact(step,i+1,report.facts);
     else throw Error('ARCHIVE_TOOL_NOT_ALLOWED');
     report.sections.push(section);report.facts.push(...sectionFacts(section));
    }answer={report};
   }else throw Error('ARCHIVE_ACTION_INVALID');
   if(!example.check(answer))throw Error('ARCHIVE_RESULT_MISMATCH');
   return {name,passed:true,code:'CHECKED'};
  }catch(error){const code=error instanceof Error&&/^[A-Za-z][A-Za-z0-9_]{1,80}$/u.test(error.message)?error.message:'ARCHIVE_VALIDATION_FAILED';return {name,passed:false,code};}
 });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>1048576)throw Error('ARCHIVE_INPUT_TOO_LARGE');}
  const checked=await checkArchivedPlans(JSON.parse(input));
  for(const r of checked)console.log(`${r.passed?'PASS':'FAIL'} archived-${r.name}: ${r.code}`);
  console.log(`ARCHIVE_RESULT: ${checked.filter(r=>r.passed).length}/${checked.length}; 0 model calls, 0 RUB; stored-plan checks only, no financial data changed.`);
  process.exitCode=checked.some(r=>!r.passed)?1:0;
 }catch{console.error('ARCHIVE_CHECK_FAILED');process.exitCode=1;}
}
