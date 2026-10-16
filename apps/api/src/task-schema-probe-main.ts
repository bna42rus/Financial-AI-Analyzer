import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { join } from 'node:path';
import { object } from '../../../packages/finance-core/src/model.ts';
import { privateJson } from './kms.ts';
import { BenchmarkLedger, benchmarkDigest } from './benchmark-ledger.ts';
import { BenchmarkFailure } from './benchmark-transport.ts';
import { readPilotJson, writePilotJson } from './task-pilot-journal.ts';
import { inspectCloudTaskModel } from './task-trial.ts';
import { assertPilotFreshness, pilotProviderSnapshot } from './task-pilot-runner.ts';
import { assertInactiveOperator } from './benchmark-probe.ts';
import { schemaProbeArtifact, verifySchemaProbeCheckpoint, runSingleSchemaProbe, schemaProbeCheckpoint } from './task-schema-probe.ts';
import { createSchemaProbeTransport } from './task-schema-probe-transport.ts';
import { smokeCostReport } from './benchmark-engine.ts';

async function main() {
  const [action, ...extra] = process.argv.slice(2), report = action === '--report';
  if (extra.length || !['--live', '--report'].includes(action ?? '') || process.getuid?.() !== 0) throw new BenchmarkFailure('TASK_SCHEMA_PROBE_ARGUMENTS_INVALID');
  const directory = '/var/lib/cashneuro/analyzer-benchmark';
  for (const path of ['/var/lib', '/var/lib/cashneuro', directory, join(directory, 'task-pilot-v1-cache')]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022 || await realpath(path) !== path || path.startsWith(directory) && (stat.mode & 0o777) !== 0o700) throw new BenchmarkFailure('BENCH_STATE_DIRECTORY_INVALID');
  }
  const artifact = await schemaProbeArtifact(), frozenPath = join(directory, 'task-schema-probe-v1.json'), resultPath = join(directory, 'task-schema-probe-v1-result.json');
  const frozen = { binding: artifact.binding, bindingSha256: artifact.bindingSha256, id: artifact.id }, frozenHash = benchmarkDigest(frozen);
  let ledger = await BenchmarkLedger.load(join(directory, 'smoke-ledger.jsonl'), { readOnly: true }), lock;
  const print = (result: unknown) => {
    const cost = ledger.totals(), incremental = cost.spent + cost.held - BigInt(schemaProbeCheckpoint.incrementalBaselineUpperAtoms);
    console.log(JSON.stringify({ ...result as object, incrementalUpperAtoms: incremental.toString(), remainingOriginal20RubHeadroomAtoms: (20_000_000_000n - incremental).toString(), cost: smokeCostReport(ledger) }));
  };
  try {
    await verifySchemaProbeCheckpoint(ledger, directory, artifact);
    let saved: Record<string, unknown> | undefined;
    try { saved = object(await readPilotJson(frozenPath), ['hash', 'payload']); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (saved && (saved.hash !== frozenHash || benchmarkDigest(saved.payload) !== frozenHash)) throw new BenchmarkFailure('TASK_SCHEMA_PROBE_ARTIFACT_CHANGED');
    const replay = ledger.records.has(artifact.id);
    if (!saved) {
      if (report || replay) throw new BenchmarkFailure('TASK_SCHEMA_PROBE_ARTIFACT_UNAVAILABLE');
      assertPilotFreshness(); await writePilotJson(frozenPath, { hash: frozenHash, payload: frozen });
    }
    if (replay || report) {
      if (!replay) { print({ probe: 'cashneuro-task-schema-probe/1', status: 'not_started', paidCalls: 0 }); return; }
      print(await runSingleSchemaProbe({ ledger, permit: artifact.permit, request: artifact.request, resultPath })); return;
    }
    assertPilotFreshness();
    // The old failed-run locks are evidence. Check their PIDs but never remove
    // or rename them. A separate one-shot lock serializes this explicit probe.
    await assertInactiveOperator(join(directory, 'operator.lock'));
    await assertInactiveOperator(join(directory, 'diagnostic.lock'));
    try { lock = await open(join(directory, 'task-schema-probe-v1.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw new BenchmarkFailure('BENCH_LOCKED'); }
    await lock.writeFile(String(process.pid)); await lock.sync();
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
    await ledger.close(); ledger = await BenchmarkLedger.load(join(directory, 'smoke-ledger.jsonl'));
    await verifySchemaProbeCheckpoint(ledger, directory, artifact);
    const keys = object(await privateJson('/etc/cashneuro/ai/benchmark/provider-keys.json'), ['cloud', 'yandex']);
    const provider = await inspectCloudTaskModel(keys.cloud, fetch);
    if (provider.modelMetadataSha256 !== pilotProviderSnapshot || provider.numericMetadata.context_length !== 131072 || provider.numericMetadata.max_model_len !== 131072) throw new BenchmarkFailure('TASK_PILOT_PROVIDER_SNAPSHOT_CHANGED');
    const { transport, diagnostics } = createSchemaProbeTransport(keys.cloud);
    print(await runSingleSchemaProbe({ ledger, permit: artifact.permit, request: artifact.request, resultPath, transport, diagnostics,
      secrets: [String(object(keys.cloud, ['apiKey']).apiKey)], beforeDispatch: () => assertPilotFreshness() }));
  } catch (error) {
    print({ probe: 'cashneuro-task-schema-probe/1', error: error instanceof BenchmarkFailure ? error.code : 'TASK_SCHEMA_PROBE_FAILED', modelAccepted: false, runtimeAiEnabled: false });
    throw error;
  } finally { await ledger.close(); await lock?.close(); }
}
main().catch(error => { console.error(error instanceof BenchmarkFailure ? error.code : 'TASK_SCHEMA_PROBE_FAILED'); process.exitCode = 1; });
