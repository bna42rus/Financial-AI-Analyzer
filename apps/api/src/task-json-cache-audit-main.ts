import { readFile } from 'node:fs/promises';
import { auditObservedJsonCache } from './task-json-cache-audit.ts';
import { BenchmarkFailure } from './benchmark-transport.ts';

async function main() {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new BenchmarkFailure('TASK_JSON_AUDIT_ARGUMENTS_INVALID');
  const bytes = await readFile(path); if (bytes.length > 131072) throw new BenchmarkFailure('TASK_JSON_AUDIT_EXPORT_INVALID');
  console.log(JSON.stringify(await auditObservedJsonCache(JSON.parse(bytes.toString('utf8')))));
}
main().catch(error => { console.error(error instanceof BenchmarkFailure ? error.code : 'TASK_JSON_AUDIT_FAILED'); process.exitCode = 1; });
