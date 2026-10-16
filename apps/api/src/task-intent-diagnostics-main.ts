import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { auditObservedIntentCache, renderIntentAudit, observedIntentRun } from './task-intent-cache-audit.ts';
import { intentTrialBinding } from './task-intent-trial.ts';

// Reuse the already-reviewed, pinned exporter without showing its encoded output.
// It validates private permissions, the exact frozen artifact and ledger head,
// cache hashes, AES-GCM capsules and reflected credentials before returning bytes.
async function readPrivateExport() {
  if (process.getuid?.() !== 0) throw Error('ROOT_REQUIRED');
  const source = await readFile(new URL('../../../docs/architecture/export-intent-audit-20261015.js', import.meta.url), 'utf8');
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module'], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let bytes = 0;
    const stop = () => { child.kill(); reject(Error('PRIVATE_EXPORT_FAILED')); };
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1048576) return stop(); chunks.push(chunk); });
    child.stderr.resume(); // Never print a subprocess stack or private text.
    child.on('error', stop); child.stdin.on('error', stop);
    child.on('close', code => {
      try {
        if (code !== 0) throw Error();
        const text = Buffer.concat(chunks).toString('utf8'), match = /^CASHNEURO_INTENT_AUDIT_V1 ([A-Za-z0-9+/=]+)\n$/.exec(text);
        if (!match) throw Error();
        resolve(JSON.parse(gunzipSync(Buffer.from(match[1]!, 'base64'), { maxOutputLength: 2097152 }).toString('utf8')));
      } catch { reject(Error('PRIVATE_EXPORT_FAILED')); }
    });
    child.stdin.end(source);
  });
}

async function main() {
  const [flag, path, ...extra] = process.argv.slice(2);
  if (flag !== '--report' || !path?.startsWith('/') || extra.length) throw Error('ARGUMENTS_INVALID');
  if ((await intentTrialBinding()).sha256 !== observedIntentRun.bindingSha256) throw Error('SOURCE_BINDING_CHANGED');
  const report = await auditObservedIntentCache(await readPrivateExport());
  if (report.passed !== observedIntentRun.passed || report.rejected !== observedIntentRun.rejected || report.totalCostAtoms !== observedIntentRun.costAtoms) throw Error('HISTORICAL_RESULT_CHANGED');
  // Never overwrite an existing report, symlink, cache, receipt or ledger file.
  await writeFile(path, renderIntentAudit(report, true) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(renderIntentAudit(report));
  console.log('Полный отчёт по всем 88 ответам: ' + path);
}
main().catch(error => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'FAILED';
  console.error('CASHNEURO DIAGNOSTICS STOPPED: ' + code);
  console.error('Отчёт не подтверждён. Новых вызовов модели нет; исходные журналы не изменены.');
  process.exitCode = 1;
});
