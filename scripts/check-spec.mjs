import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const manifest = JSON.parse(await readFile(new URL("../docs/product/source-manifest.json", import.meta.url), "utf8"));
for (const source of manifest.sources) {
  const bytes = await readFile(new URL(`../${source.path}`, import.meta.url));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== source.sha256) throw new Error(`Product source hash mismatch: ${source.path}`);
}
const baseline = await readFile(new URL("../docs/product/baseline.md", import.meta.url), "utf8");
if ((baseline.match(/^### A-\d+/gm) || []).length !== 11 || (baseline.match(/^### B-\d+/gm) || []).length !== 10) {
  throw new Error("Approved amendment register is incomplete");
}
console.log("Original PDF/Word hashes and approved A/B amendment register verified");

// Integrity of coverage evidence: a green build must not silently omit clauses
// or claim full acceptance merely because a referenced file exists.
const registry = JSON.parse(await readFile(new URL('../docs/product/implementation-registry.json', import.meta.url),'utf8'));
const audit = JSON.parse(await readFile(new URL('../docs/audit/comprehensive-spec-matrix.json', import.meta.url),'utf8'));
const prior = JSON.parse(await readFile(new URL('../docs/audit/spec-screen-matrix.json', import.meta.url),'utf8'));
const original = new Map([...registry.requirements,...registry.approved_baseline_items].map(item=>[item.id,item]));
const priorById = new Map(prior.requirements.map(item=>[item.id,item]));
if (registry.requirements.length!==455 || registry.approved_baseline_items.length!==39 || audit.requirements.length!==494 || new Set(audit.requirements.map(item=>item.id)).size!==494) throw new Error('Audit coverage register is incomplete or duplicated');
for (const item of audit.requirements) {
  const source=original.get(item.id);
  if (!source || source.status!==item.registry_status_preserved || item.full_clause_verified!==false) throw new Error(`Unsupported audit acceptance: ${item.id}`);
  const sourceText=item.id.startsWith('PDF-') ? source.source_text??'' : priorById.get(item.id)?.requirement_text??'';
  if (createHash('sha256').update(sourceText).digest('hex')!==item.source_text_sha256) throw new Error(`Audit source text mismatch: ${item.id}`);
  if (!item.open_gap_ids.length || item.open_gap_ids.some(id=>!audit.open_gaps.some(gap=>gap.id===id))) throw new Error(`Missing audit limitations: ${item.id}`);
  for (const ref of [...item.implementation_refs,...item.verification_refs]) await readFile(new URL('../'+ref.split('#')[0],import.meta.url));
}
if (audit.pdf_appendix.length!==9 || new Set(audit.pdf_appendix.map(item=>item.id)).size!==9 || audit.word_context.length!==30) throw new Error('Audit appendix/context coverage is incomplete');
for (const item of audit.pdf_appendix) if (!item.reviewed || item.mapped_pdf_sections.some(n=>!registry.sections.some(section=>section.number===n))) throw new Error(`Invalid appendix map: ${item.id}`);
for (const finding of audit.findings) for (const id of finding.requirements) if (!original.has(id)) throw new Error(`Unknown finding requirement: ${id}`);
console.log('494 requirement entries, 9 appendix maps, 30 context sections and evidence references verified');
