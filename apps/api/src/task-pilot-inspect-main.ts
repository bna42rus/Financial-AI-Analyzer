import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { BenchmarkLedger } from './benchmark-ledger.ts';
import { BenchmarkFailure } from './benchmark-transport.ts';
import { PilotJournal } from './task-pilot-journal.ts';
import { pilotBinding, pilotRequestIds } from './task-pilot-runner.ts';
import { loadTrialCorpus } from './task-trial.ts';
import { inspectTaskPilot } from './task-pilot-inspection.ts';
import { smokeCostReport } from './benchmark-engine.ts';

async function main() {
  if (process.argv.length !== 2 || process.getuid?.() !== 0) throw new BenchmarkFailure('TASK_PILOT_INSPECTION_ARGUMENTS_INVALID');
  const directory = '/var/lib/cashneuro/analyzer-benchmark';
  for (const path of ['/var/lib', '/var/lib/cashneuro', directory, join(directory, 'task-pilot-v1-cache')]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022 || await realpath(path) !== path || path.startsWith(directory) && (stat.mode & 0o777) !== 0o700) throw new BenchmarkFailure('BENCH_STATE_DIRECTORY_INVALID');
  }
  const artifact = await pilotBinding(), { corpus } = await loadTrialCorpus();
  const ledger = await BenchmarkLedger.load(join(directory, 'smoke-ledger.jsonl'), { readOnly: true });
  try {
    const before = await ledger.file.stat();
    const journal = await PilotJournal.load({ path: join(directory, 'task-pilot-v1.json'), cacheDirectory: join(directory, 'task-pilot-v1-cache'), ledger, bindingSha256: artifact.sha256,
      requestIds: pilotRequestIds(corpus, artifact.sha256), incrementalCapAtoms: '20000000000', maximumCalls: 240, readOnly: true, assertInitial() { throw new BenchmarkFailure('TASK_PILOT_NOT_STARTED'); } });
    const report = await inspectTaskPilot(journal, corpus, artifact.sha256), after = await ledger.file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new BenchmarkFailure('TASK_PILOT_INSPECTION_CONCURRENT_WRITE');
    console.log(JSON.stringify({ ...report, cost: smokeCostReport(ledger) }));
  } finally { await ledger.close(); }
}
main().catch(error => { console.error(error instanceof BenchmarkFailure ? error.code : 'TASK_PILOT_INSPECTION_FAILED'); process.exitCode = 1; });
