import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { join } from 'node:path';
import { object } from '../../../packages/finance-core/src/model.ts';
import { privateJson } from './kms.ts';
import { BenchmarkLedger, benchmarkDigest } from './benchmark-ledger.ts';
import { BenchmarkFailure } from './benchmark-transport.ts';
import { PilotJournal, readPilotJson, ensurePilotCache } from './task-pilot-journal.ts';
import { loadTrialCorpus, inspectCloudTaskModel } from './task-trial.ts';
import { assertInactiveOperator } from './benchmark-probe.ts';
import { assertPilotFreshness, pilotProviderSnapshot, pilotRequestIds, runPilot } from './task-pilot-runner.ts';
import { createTaskJsonTransport, replayOnlyTaskJsonTransport, persistProviderError, readSafeProviderError } from './task-json-transport.ts';
import type { ProviderErrorCapture } from './task-json-transport.ts';
import { jsonTrialBinding, assertJsonTrialStart, jsonTrialAdmission, reusedFinancialGate } from './task-json-trial.ts';
import { smokeCostReport } from './benchmark-engine.ts';

async function main() {
  const [action, ...extra] = process.argv.slice(2);
  if (extra.length || !['--live', '--report'].includes(action ?? '') || process.getuid?.() !== 0) throw new BenchmarkFailure('TASK_JSON_ARGUMENTS_INVALID');
  const directory = '/var/lib/cashneuro/analyzer-benchmark', path = join(directory, 'task-json-trial-v1.json'), cache = join(directory, 'task-json-trial-v1-cache');
  for (const p of ['/var/lib', '/var/lib/cashneuro', directory]) {
    const stat = await lstat(p); if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022 || await realpath(p) !== p || p === directory && (stat.mode & 0o777) !== 0o700) throw new BenchmarkFailure('BENCH_STATE_DIRECTORY_INVALID');
  }
  const artifact = await jsonTrialBinding(), { corpus } = await loadTrialCorpus();
  let exists = false;
  try { await readPilotJson(path); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Repeating the console block is free, including an interrupted saved prefix.
  const report = action === '--report' || exists;
  let ledger = await BenchmarkLedger.load(join(directory, 'smoke-ledger.jsonl'), { readOnly: true }), lock;
  let captures: ProviderErrorCapture[] = [], capturesFlushed = false;
  const flush = async () => {
    if (report || capturesFlushed) return [];
    capturesFlushed = true;
    const saved = [];
    for (const capture of captures) {
      const record = [...ledger.records.entries()].find(([, r]) => (r.receipt?.value as { wireSha256?: unknown } | null)?.wireSha256 === capture.wireSha256);
      if (!record?.[1].receipt) continue; // Receipt fsync must precede evidence.
      saved.push(await persistProviderError(directory, record[0], capture));
    }
    return saved;
  };
  try {
    if (!report) {
      assertPilotFreshness(); await assertJsonTrialStart(ledger, directory);
      for (const name of ['operator.lock', 'diagnostic.lock', 'task-schema-probe-v1.lock']) await assertInactiveOperator(join(directory, name));
      try { lock = await open(join(directory, 'task-json-trial-v1.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch { throw new BenchmarkFailure('BENCH_LOCKED'); }
      await lock.writeFile(String(process.pid)); await lock.sync();
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
      await ledger.close(); ledger = await BenchmarkLedger.load(join(directory, 'smoke-ledger.jsonl'));
      await assertJsonTrialStart(ledger, directory);
    }
    const journal = await PilotJournal.load({ path, cacheDirectory: cache, ledger, bindingSha256: artifact.sha256, requestIds: pilotRequestIds(corpus, artifact.sha256),
      maximumCalls: 240, readOnly: report, ...jsonTrialAdmission,
      assertInitial(l) { if (l.records.size !== 495 || l.totals().spent !== 13389232820n || l.totals().held !== 11820804480n) throw new BenchmarkFailure('TASK_JSON_BASELINE_CHANGED'); } });
    let transport = replayOnlyTaskJsonTransport(), secrets: string[] = [];
    if (!report) {
      try { await ensurePilotCache(cache); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const keys = object(await privateJson('/etc/cashneuro/ai/benchmark/provider-keys.json'), ['cloud', 'yandex']);
      const provider = await inspectCloudTaskModel(keys.cloud, fetch);
      if (provider.modelMetadataSha256 !== pilotProviderSnapshot || provider.numericMetadata.context_length !== 131072 || provider.numericMetadata.max_model_len !== 131072) throw new BenchmarkFailure('TASK_PILOT_PROVIDER_SNAPSHOT_CHANGED');
      const live = createTaskJsonTransport(keys.cloud); transport = live.transport; captures = live.captures; secrets = [String(object(keys.cloud, ['apiKey']).apiKey)];
    }
    const cacheStat = await lstat(cache); if (!cacheStat.isDirectory() || cacheStat.uid !== 0 || (cacheStat.mode & 0o777) !== 0o700 || await realpath(cache) !== cache) throw new BenchmarkFailure('BENCH_STATE_DIRECTORY_INVALID');
    const result = await runPilot(corpus, transport, journal, artifact.sha256, { secrets, reusedInitialGate: reusedFinancialGate,
      beforeDispatch: report ? undefined : () => assertPilotFreshness(), progress: report ? undefined : row => console.log(JSON.stringify({ progress: 'cashneuro-json-trial/1', ...row })) });
    const errors: unknown[] = await flush();
    if (report) for (const id of journal.frozen.requestIds) if (ledger.records.get(id)?.receipt?.code) {
      try { errors.push(await readSafeProviderError(directory, id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    console.log(JSON.stringify({ ...result, experiment: 'cashneuro-task-json-trial/1', wireMode: 'json_object', reusedGateReceiptId: artifact.binding.reusedGate.sourceReceiptId,
      providerErrors: errors, report, ledgerHeadSha256: ledger.previous, frozenSha256: benchmarkDigest(journal.frozen), cost: smokeCostReport(ledger) }));
  } catch (error) {
    let providerErrors: unknown[] = [];
    try { providerErrors = await flush(); } catch { /* Accounting remains durable even if diagnostic persistence fails. */ }
    console.log(JSON.stringify({ experiment: 'cashneuro-task-json-trial/1', error: error instanceof BenchmarkFailure ? error.code : 'TASK_JSON_TRIAL_FAILED', providerErrors,
      ledgerHeadSha256: ledger.previous, cost: smokeCostReport(ledger), modelAccepted: false, runtimeAiEnabled: false }));
    throw error;
  } finally { await ledger.close(); await lock?.close(); }
}
main().catch(error => { console.error(error instanceof BenchmarkFailure ? error.code : 'TASK_JSON_TRIAL_FAILED'); process.exitCode = 1; });
