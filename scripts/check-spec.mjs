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
