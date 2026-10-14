import { mkdir, open, unlink, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { privateJson } from './kms.ts';
import { object } from '../../../packages/finance-core/src/model.ts';
import { tokenCost } from '../../../packages/analyzer/src/cost.ts';
import { candidates, createBenchmarkTransport, BenchmarkFailure } from './benchmark-transport.ts';
import type { Candidate } from './benchmark-transport.ts';
import { BenchmarkLedger } from './benchmark-ledger.ts';
import { runSmoke, smokeCostReport } from './benchmark-engine.ts';
import type { ContextMode } from './benchmark-engine.ts';
import { fixtureVersion, smokeScenarios } from './benchmark-fixtures.ts';
import { assertInactiveOperator, probeRequestId, runProbe } from './benchmark-probe.ts';

const stateDirectory = '/var/lib/cashneuro/analyzer-benchmark';
async function main() {
  const [action, candidate, mode = 'task', ...extra] = process.argv.slice(2);
  const diagnostic = action === '--probe' || action === '--probe-after-funding';
  const fundedSmoke = action === '--live-after-funding', recovery = diagnostic || fundedSmoke;
  if (extra.length || !['--dry-run', '--live', '--probe', '--probe-after-funding', '--live-after-funding'].includes(action ?? '') || !Object.hasOwn(candidates, candidate ?? '') || !['task', 'window', 'transcript'].includes(mode) || diagnostic && mode !== 'task') throw new BenchmarkFailure('BENCH_ARGUMENTS_INVALID');
  const probePhase = action === '--probe-after-funding' ? 'after-funding' : 'initial';
  const selected = candidates[candidate as Candidate];
  if (action === '--dry-run') {
    console.log(JSON.stringify({ candidate, mode, fixtureVersion, scenarios: smokeScenarios.length,
      turns: smokeScenarios.reduce((sum, s) => sum + s.turns.length, 0), price: selected.price,
      maximumReservationRub: (Number(tokenCost(selected.price, selected.contextTokens, 1200)) / 1e9).toFixed(9),
      smokeBudgetRub: '45', overallApprovedBudgetRub: '1000', paidCalls: 0 })); return;
  }
  if (process.getuid?.() !== 0) throw new BenchmarkFailure('BENCH_OPERATOR_REQUIRED');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const stat = await lstat(stateDirectory);
  if (await realpath(stateDirectory) !== stateDirectory || !stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o700) throw new BenchmarkFailure('BENCH_STATE_DIRECTORY_INVALID');
  for (const path of ['/var/lib', '/var/lib/cashneuro', stateDirectory]) {
    const meta = await lstat(path);
    if (!meta.isDirectory() || meta.uid !== 0 || (meta.mode & 0o022)) throw new BenchmarkFailure('BENCH_STATE_DIRECTORY_INVALID');
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  // Exclusive process lock. If the process dies, keep the lock: reconcile the
  // last reservation/provider billing before an operator removes it.
  if (recovery) await assertInactiveOperator(join(stateDirectory, 'operator.lock'));
  const lockPath = join(stateDirectory, recovery ? 'diagnostic.lock' : 'operator.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch { throw new BenchmarkFailure('BENCH_LOCKED'); }
  let ledger: BenchmarkLedger | undefined; let clean = false; let probeId: string | undefined;
  try {
    await lock.writeFile(String(process.pid)); await lock.sync();
    if (recovery) await assertInactiveOperator(join(stateDirectory, 'operator.lock'));
    ledger = await BenchmarkLedger.load(join(stateDirectory, 'smoke-ledger.jsonl'));
    const raw = await privateJson('/etc/cashneuro/ai/benchmark/provider-keys.json');
    const keys = object(raw, ['cloud', 'yandex']);
    const transport = createBenchmarkTransport(candidate as Candidate, keys[selected.provider]);
    if (diagnostic) probeId = probeRequestId(transport, probePhase);
    if (fundedSmoke) await ledger.allowFundedSmoke();
    const result = diagnostic ? await runProbe(transport, ledger, probePhase) : await runSmoke(transport, ledger, mode as ContextMode, fundedSmoke ? 'after-funding' : 'initial');
    console.log(JSON.stringify({ ...result, cost: smokeCostReport(ledger) }));
    clean = !ledger.totals().blocked;
  } catch (error) {
    if (ledger) console.log(JSON.stringify({ candidate, mode, error: error instanceof BenchmarkFailure ? error.code : 'BENCH_FAILED', cost: smokeCostReport(ledger) }));
    throw error;
  } finally {
    if (ledger) {
      clean = diagnostic ? Boolean(probeId) && (!ledger.records.has(probeId!) || Boolean(ledger.records.get(probeId!)?.receipt)) : !ledger.totals().blocked;
      await ledger.close();
    }
    await lock.close();
    if (clean) await unlink(lockPath);
  }
}
main().catch(error => { console.error(error instanceof BenchmarkFailure ? error.code : 'BENCH_FAILED'); process.exitCode = 1; });
