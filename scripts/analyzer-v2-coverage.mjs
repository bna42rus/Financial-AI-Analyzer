import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root = new URL('../',import.meta.url);
export const coverageUrl = new URL('docs/architecture/analyzer-v2/coverage.json',root);
export const sourceUrl = new URL('docs/product/analyzer-capabilities-20261117.md',root);
const fail = message => {throw new Error('ANALYZER_COVERAGE_INVALID: '+message);};
export async function validateCoverage(matrix,source) {
  if(matrix.version!=='cashneuro-analyzer-coverage/1'||matrix.runtimeIntegrated!==false||matrix.paidCalls!==0||matrix.measurement!=='not_executed') fail('unsupported acceptance/measurement');
  const questions = new Map([...source.matchAll(/^- \*\*(A\d\d-\d\d)\*\* — (.+)$/gm)].map(m=>[m[1],m[2]]));
  const groups = [...source.matchAll(/^### (A\d\d)\. (.+) — (P\d)$/gm)];
  if(questions.size!==240||matrix.tasks?.length!==240||matrix.groups?.length!==24) fail('240 tasks / 24 groups required');
  const unique = (items,label) => {if(new Set(items).size!==items.length) fail('duplicate '+label);};
  unique(matrix.tasks.map(t=>t.id),'task'); unique(matrix.groups.map(g=>g.id),'group');
  for(const m of groups) {
    const g=matrix.groups.find(g=>g.id===m[1]);
    if(!g||g.title!==m[2]||g.priority!==m[3]||!g.inputs||!g.outcome||matrix.tasks.filter(t=>t.group===g.id).length!==10) fail('group '+m[1]);
  }
  for(const [key,t] of Object.entries(matrix.tools)) {
    if(t.inspection==='missing') {if(t.path!==null||t.symbol!==null) fail('unfounded missing evidence '+key);continue;}
    if(t.inspection!=='candidate'||typeof t.path!=='string'||!t.path.match(/^(packages|apps)\/[a-z0-9_./-]+$/i)||t.path.includes('..')) fail('tool reference '+key);
    const bytes=await readFile(new URL(t.path,root),'utf8');
    if(t.symbol&&!new RegExp('export\\s+(?:async\\s+)?(?:function|const|type|class|interface)\\s+'+t.symbol+'\\b').test(bytes)) fail('missing export '+key+': '+t.symbol);
  }
  for(const t of matrix.tasks) {
    if(questions.get(t.id)!==t.question||t.group!==t.id.slice(0,3)||t.status!=='mapped_not_accepted'||!t.criterion||t.criterion.length<20) fail('task '+t.id);
    if(!t.tools?.length||t.tools.some(k=>!matrix.tools[k])||!t.gaps?.length||t.gaps.some(k=>!matrix.gaps[k])) fail('unmapped tool/gap '+t.id);
    if(!t.requiredChecks?.length||t.requiredChecks.some(k=>!matrix.checks[k])) fail('checks '+t.id);
    if(t.tools.some(k=>matrix.tools[k].inspection==='missing')&&!t.gaps.includes('missing_tool_or_contract')) fail('hidden gap '+t.id);
  }
  // Parse blocks by offsets rather than relying on a multiline end-of-file anchor.
  const headings=[...source.matchAll(/^### (D\d\d)\. (.+)$/gm)];
  if(headings.length!==12||matrix.dialogs?.length!==12) fail('12 dialogs required');
  unique(matrix.dialogs.map(d=>d.id),'dialog');
  for(let i=0;i<headings.length;i++) {
    const h=headings[i],d=matrix.dialogs.find(d=>d.id===h[1]);
    const block=source.slice(h.index,headings[i+1]?.index??source.indexOf('\n## ',h.index+1));
    const steps=[...block.matchAll(/^\d+\. (.+)$/gm)].map(m=>m[1]);
    if(!d||d.title!==h[2]||JSON.stringify(d.steps)!==JSON.stringify(steps)||steps.length!==4||d.status!=='mapped_not_accepted'||d.criteria.length<3||d.requiredChecks.some(k=>!matrix.checks[k])) fail('dialog '+h[1]);
  }
  const prior=JSON.parse(await readFile(new URL(matrix.relatedCatalog,root),'utf8'));
  if(prior.cases.length!==337) fail('existing 337-question catalog lost');
  return {tasks:matrix.tasks.length,dialogs:matrix.dialogs.length,candidates:Object.values(matrix.tools).filter(t=>t.inspection==='candidate').length,missing:Object.values(matrix.tools).filter(t=>t.inspection==='missing').length};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==2) throw new Error('ANALYZER_COVERAGE_OFFLINE_ONLY');
  const result=await validateCoverage(JSON.parse(await readFile(coverageUrl,'utf8')),await readFile(sourceUrl,'utf8'));
  console.log(`Analyzer V2 inventory: ${result.tasks} tasks, ${result.dialogs} dialogs; ${result.candidates} source candidates, ${result.missing} explicit gaps; no model calls, no acceptance claim`);
}
