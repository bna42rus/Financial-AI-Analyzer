import { lstat, realpath } from 'node:fs/promises';
import { object } from '../../../packages/finance-core/src/model.ts';
import { privateJson } from './kms.ts';
import { BenchmarkLedger } from './benchmark-ledger.ts';
import { BenchmarkFailure } from './benchmark-transport.ts';
import { taskTrialManifest, assertTrialBaseline, inspectCloudTaskModel } from './task-trial.ts';

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  // No live action/flag/env fallback exists. Old paid CLI actions remain paused.
  if (rest.length || !['--dry-run', '--preflight'].includes(action ?? '')) throw new BenchmarkFailure('TASK_TRIAL_PAID_DISPATCH_DISABLED');
  const manifest = await taskTrialManifest();
  if (action === '--dry-run') { console.log(JSON.stringify({ ...manifest, paidCalls: 0, catalogHttpCalls: 0 })); return; }
  if (process.getuid?.() !== 0) throw new BenchmarkFailure('BENCH_OPERATOR_REQUIRED');
  const directory = '/var/lib/cashneuro/analyzer-benchmark';
  for (const path of ['/var/lib', '/var/lib/cashneuro', directory]) {
    const meta = await lstat(path);
    if (!meta.isDirectory() || meta.uid !== 0 || meta.mode & 0o022 || await realpath(path) !== path || path === directory && (meta.mode & 0o777) !== 0o700) throw new BenchmarkFailure('BENCH_STATE_DIRECTORY_INVALID');
  }
  // Read-only file handle and exact baseline check precede credential access.
  const ledger = await BenchmarkLedger.load(directory + '/smoke-ledger.jsonl', { readOnly: true });
  try {
    const before = await ledger.file.stat(), cost = assertTrialBaseline(ledger);
    const keys = object(await privateJson('/etc/cashneuro/ai/benchmark/provider-keys.json'), ['cloud', 'yandex']);
    const provider = await inspectCloudTaskModel(keys.cloud, fetch);
    const after = await ledger.file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new BenchmarkFailure('TASK_TRIAL_BASELINE_CHANGED');
    console.log(JSON.stringify({ preflight: 'cashneuro-task-preflight/1', manifest, provider, cost, ledgerModified: false, paidCalls: 0,
      remaining: ['Controlled paid runner and complete frozen acceptance evaluation', 'Provider model revision verification', 'Current applicable tariff confirmation'] }));
  } finally { await ledger.close(); }
}
main().catch(error => { console.error(error instanceof BenchmarkFailure ? error.code : 'TASK_TRIAL_PREFLIGHT_FAILED'); process.exitCode = 1; });
