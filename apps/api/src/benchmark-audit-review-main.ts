import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { reviewSavedAudit } from './benchmark-audit-review.ts';

// Local file analysis only. It neither opens the protected ledger nor reads
// provider credentials. The source is never rewritten; JSON goes to stdout.
try {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error('BENCH_AUDIT_REVIEW_FILE_REQUIRED');
  const bytes = await readFile(path);
  if (bytes.length > 16 * 1024 * 1024) throw new Error('BENCH_AUDIT_EXPORT_TOO_LARGE');
  const result = await reviewSavedAudit(JSON.parse(bytes.toString('utf8')));
  process.stdout.write(JSON.stringify({ ...result, sourceSha256: createHash('sha256').update(bytes).digest('hex') }, null, 2) + '\n');
} catch {
  // File paths, reflected input and parser snippets do not belong in logs.
  process.stderr.write('BENCH_AUDIT_REVIEW_FAILED\n'); process.exitCode = 1;
}
