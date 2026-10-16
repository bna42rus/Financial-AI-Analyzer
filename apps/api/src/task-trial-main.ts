import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { object } from '../../../packages/finance-core/src/model.ts';
import { privateJson } from './kms.ts';
import { BenchmarkLedger } from './benchmark-ledger.ts';
import { BenchmarkFailure, createBenchmarkTransport, replayOnlyBenchmarkTransport } from './benchmark-transport.ts';
import { taskTrialManifest, assertTrialBaseline, inspectCloudTaskModel, loadTrialCorpus } from './task-trial.ts';
import { PilotJournal, ensurePilotCache } from './task-pilot-journal.ts';
import { pilotBinding, pilotProviderSnapshot, assertPilotFreshness, pilotRequestIds, runPilot } from './task-pilot-runner.ts';
import { assertInactiveOperator } from './benchmark-probe.ts';
import { smokeCostReport } from './benchmark-engine.ts';

async function directoryIsPrivate(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o700 || await realpath(path) !== path) throw new BenchmarkFailure('BENCH_STATE_DIRECTORY_INVALID');
}

async function pilotAction(directory: string, report: boolean) {
  const artifact = await pilotBinding(), { corpus } = await loadTrialCorpus();
  const path = join(directory, 'task-pilot-v1.json'), cacheDirectory = join(directory, 'task-pilot-v1-cache'), lockPath = join(directory, 'diagnostic.lock');
  if (!report) assertPilotFreshness();
  let lock;
  if (!report) {
    await assertInactiveOperator(join(directory, 'operator.lock'));
    try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw new BenchmarkFailure('BENCH_LOCKED'); }
    await lock.writeFile(String(process.pid)); await lock.sync();
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
  }
  let ledger: BenchmarkLedger | undefined, clean = report;
  try {
    ledger = await BenchmarkLedger.load(join(directory, 'smoke-ledger.jsonl'), { readOnly: report });
    const journal = await PilotJournal.load({ path, cacheDirectory, ledger, bindingSha256: artifact.sha256, requestIds: pilotRequestIds(corpus, artifact.sha256), incrementalCapAtoms: '20000000000', maximumCalls: 240,
      readOnly: report, assertInitial: assertTrialBaseline });
    let transport = replayOnlyBenchmarkTransport('cloud-oss', 'empty-tools'), secrets: string[] = [];
    if (!report) {
      // Verify state before credential access or even the unbilled catalog GET.
      journal.verify(); if (ledger.totals().blocked) throw new BenchmarkFailure('BENCH_RECONCILIATION_REQUIRED');
      const keys = object(await privateJson('/etc/cashneuro/ai/benchmark/provider-keys.json'), ['cloud', 'yandex']);
      const provider = await inspectCloudTaskModel(keys.cloud, fetch);
      if (provider.modelMetadataSha256 !== pilotProviderSnapshot || provider.numericMetadata.context_length !== 131072 || provider.numericMetadata.max_model_len !== 131072) throw new BenchmarkFailure('TASK_PILOT_PROVIDER_SNAPSHOT_CHANGED');
      try { await ensurePilotCache(cacheDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await directoryIsPrivate(cacheDirectory);
      transport = createBenchmarkTransport('cloud-oss', keys.cloud, fetch, 'empty-tools');
      secrets = [String(object(keys.cloud, ['apiKey']).apiKey)];
    } else await directoryIsPrivate(cacheDirectory);
    const result = await runPilot(corpus, transport, journal, artifact.sha256, { secrets, beforeDispatch: report ? undefined : () => assertPilotFreshness(), progress: report ? undefined : row => console.log(JSON.stringify({ progress: 'cashneuro-pilot/1', ...row })) });
    console.log(JSON.stringify({ ...result, ...(report ? { report: 'saved-pilot/1', paidCalls: 0 } : {}), cost: smokeCostReport(ledger) }));
    clean = !ledger.totals().blocked && ![...ledger.records.values()].some(record => !record.receipt && journal.frozen.requestIds.includes(record.reserve.id));
  } catch (error) {
    clean = Boolean(ledger) && !ledger!.totals().blocked && ![...ledger!.records.values()].some(record => !record.receipt);
    if (ledger) console.log(JSON.stringify({ pilot: 'cashneuro-cloud-service-pilot/1', error: error instanceof BenchmarkFailure ? error.code : 'TASK_PILOT_FAILED', cost: smokeCostReport(ledger) }));
    throw error;
  } finally {
    await ledger?.close();
    if (lock) { await lock.close(); if (clean) { await unlink(lockPath); const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); } } }
  }
}

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  // Only this explicit bounded service pilot is new. Old paid actions/env
  // fallbacks cannot enable it or change its budget, corpus or provider binding.
  if (rest.length || !['--dry-run', '--preflight', '--live-pilot', '--report-pilot'].includes(action ?? '')) throw new BenchmarkFailure('TASK_TRIAL_PAID_DISPATCH_DISABLED');
  const manifest = await taskTrialManifest();
  if (action === '--dry-run') { console.log(JSON.stringify({ ...manifest, paidCalls: 0, catalogHttpCalls: 0 })); return; }
  if (process.getuid?.() !== 0) throw new BenchmarkFailure('BENCH_OPERATOR_REQUIRED');
  const directory = '/var/lib/cashneuro/analyzer-benchmark';
  for (const path of ['/var/lib', '/var/lib/cashneuro', directory]) {
    const meta = await lstat(path);
    if (!meta.isDirectory() || meta.uid !== 0 || meta.mode & 0o022 || await realpath(path) !== path || path === directory && (meta.mode & 0o777) !== 0o700) throw new BenchmarkFailure('BENCH_STATE_DIRECTORY_INVALID');
  }
  if (action === '--live-pilot' || action === '--report-pilot') return pilotAction(directory, action === '--report-pilot');
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
main().catch(error => { console.error(error instanceof BenchmarkFailure ? error.code : 'TASK_TRIAL_COMMAND_FAILED'); process.exitCode = 1; });
