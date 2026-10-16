import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { join } from 'node:path';
import { object } from '../../../packages/finance-core/src/model.ts';
import { privateJson } from './kms.ts';
import { BenchmarkLedger, benchmarkDigest } from './benchmark-ledger.ts';
import { BenchmarkFailure } from './benchmark-transport.ts';
import { PilotJournal, readPilotJson, ensurePilotCache } from './task-pilot-journal.ts';
import { loadTrialCorpus, inspectCloudTaskModel, trialRequestId } from './task-trial.ts';
import { assertInactiveOperator } from './benchmark-probe.ts';
import { assertPilotFreshness, pilotProviderSnapshot, pilotRequestIds, runPilot } from './task-pilot-runner.ts';
import { persistProviderError, readSafeProviderError, rejectedTaskPayloadCapture } from './task-json-transport.ts';
import type { ProviderErrorCapture } from './task-json-transport.ts';
import { intentTrialBinding, assertIntentTrialStart, intentAdmission } from './task-intent-trial.ts';
import { createCapturedIntentTransport, replayIntentTransport } from './task-intent-transport.ts';
import { smokeCostReport } from './benchmark-engine.ts';

async function main() {
  const [action, ...extra] = process.argv.slice(2);
  if (extra.length || !['--live', '--report'].includes(action ?? '') || process.getuid?.() !== 0) throw new BenchmarkFailure('TASK_INTENT_ARGUMENTS_INVALID');
  const directory = '/var/lib/cashneuro/analyzer-benchmark', path = join(directory, 'task-intent-trial-v1.json'), cache = join(directory, 'task-intent-trial-v1-cache');
  for (const p of ['/var/lib', '/var/lib/cashneuro', directory]) {
    const stat = await lstat(p); if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022 || await realpath(p) !== p || p === directory && (stat.mode & 0o777) !== 0o700) throw new BenchmarkFailure('BENCH_STATE_DIRECTORY_INVALID');
  }
  const artifact = await intentTrialBinding(), { corpus } = await loadTrialCorpus();
  let exists = false;
  try { await readPilotJson(path); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Repeating the console block is free, including an interrupted saved prefix.
  const report = action === '--report' || exists;
  let ledger = await BenchmarkLedger.load(join(directory, 'smoke-ledger.jsonl'), { readOnly: true }), lock;
  let captures: ProviderErrorCapture[] = [], capturesFlushed = false;
  const payloadEvidence: unknown[] = [];
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
      assertPilotFreshness(); await assertIntentTrialStart(ledger, directory);
      for (const name of ['operator.lock', 'diagnostic.lock', 'task-schema-probe-v1.lock', 'task-json-trial-v1.lock']) await assertInactiveOperator(join(directory, name));
      try { lock = await open(join(directory, 'task-intent-trial-v1.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch { throw new BenchmarkFailure('BENCH_LOCKED'); }
      await lock.writeFile(String(process.pid)); await lock.sync();
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
      await ledger.close(); ledger = await BenchmarkLedger.load(join(directory, 'smoke-ledger.jsonl'));
      await assertIntentTrialStart(ledger, directory);
    }
    const intentGateIds = new Set([...corpus.singles, ...corpus.dialogs.flatMap(d => d.turns)].map(t => trialRequestId(artifact.sha256, t.id, 'gate', 0)));
    for (const repeat of corpus.repetitions) for (let occurrence = 1; occurrence <= repeat.additionalIndependentCopies; occurrence++) intentGateIds.add(trialRequestId(artifact.sha256, repeat.caseId, 'gate', occurrence));
    const journal = await PilotJournal.load({ path, cacheDirectory: cache, ledger, bindingSha256: artifact.sha256, requestIds: pilotRequestIds(corpus, artifact.sha256).filter(id => intentGateIds.has(id)),
      maximumCalls: 120, readOnly: report, ...intentAdmission,
      assertInitial(l) { if (l.records.size !== 665 || l.previous !== artifact.binding.baseline.ledgerHead || l.totals().spent !== 22627111860n || l.totals().held !== 11820804480n) throw new BenchmarkFailure('TASK_INTENT_BASELINE_CHANGED'); } });
    let transport = replayIntentTransport(), secrets: string[] = [];
    if (!report) {
      try { await ensurePilotCache(cache); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const keys = object(await privateJson('/etc/cashneuro/ai/benchmark/provider-keys.json'), ['cloud', 'yandex']);
      const provider = await inspectCloudTaskModel(keys.cloud, fetch);
      if (provider.modelMetadataSha256 !== pilotProviderSnapshot || provider.numericMetadata.context_length !== 131072 || provider.numericMetadata.max_model_len !== 131072) throw new BenchmarkFailure('TASK_PILOT_PROVIDER_SNAPSHOT_CHANGED');
      const live = createCapturedIntentTransport(keys.cloud); transport = live.transport; captures = live.captures; secrets = [String(object(keys.cloud, ['apiKey']).apiKey)];
    }
    const cacheStat = await lstat(cache); if (!cacheStat.isDirectory() || cacheStat.uid !== 0 || (cacheStat.mode & 0o777) !== 0o700 || await realpath(cache) !== cache) throw new BenchmarkFailure('BENCH_STATE_DIRECTORY_INVALID');
    const result = await runPilot(corpus, transport, journal, artifact.sha256, { secrets, intent: true,
      onRejectedPayload: report ? undefined : async payload => { payloadEvidence.push(await persistProviderError(directory, payload.id, rejectedTaskPayloadCapture(payload))); },
      beforeDispatch: report ? undefined : () => assertPilotFreshness(), progress: report ? undefined : row => console.log(JSON.stringify({ progress: 'cashneuro-intent-trial/1', ...row })) });
    const errors: unknown[] = [...payloadEvidence, ...await flush()];
    if (report) for (const id of journal.frozen.requestIds) if (ledger.records.get(id)?.receipt) {
      try { errors.push(await readSafeProviderError(directory, id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    console.log(JSON.stringify({ ...result, experiment: 'cashneuro-task-intent-trial/1', wireMode: 'json_object', singleModelCallPerTurn: true,
      providerErrors: errors, report, ledgerHeadSha256: ledger.previous, frozenSha256: benchmarkDigest(journal.frozen), cost: smokeCostReport(ledger) }));
  } catch (error) {
    let providerErrors: unknown[] = [...payloadEvidence];
    try { providerErrors.push(...await flush()); } catch { /* Accounting remains durable even if diagnostic persistence fails. */ }
    console.log(JSON.stringify({ experiment: 'cashneuro-task-intent-trial/1', error: error instanceof BenchmarkFailure ? error.code : 'TASK_INTENT_TRIAL_FAILED', providerErrors,
      ledgerHeadSha256: ledger.previous, cost: smokeCostReport(ledger), modelAccepted: false, runtimeAiEnabled: false }));
    throw error;
  } finally { await ledger.close(); await lock?.close(); }
}
main().catch(error => { console.error(error instanceof BenchmarkFailure ? error.code : 'TASK_INTENT_TRIAL_FAILED'); process.exitCode = 1; });
