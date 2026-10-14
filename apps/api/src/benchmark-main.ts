import { mkdir, open, unlink, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { privateJson } from './kms.ts';
import { object } from '../../../packages/finance-core/src/model.ts';
import { tokenCost } from '../../../packages/analyzer/src/cost.ts';
import { candidates, createBenchmarkTransport, replayOnlyBenchmarkTransport, BenchmarkFailure } from './benchmark-transport.ts';
import type { Candidate } from './benchmark-transport.ts';
import { BenchmarkLedger } from './benchmark-ledger.ts';
import { runSmoke, runComparison, smokeCostReport } from './benchmark-engine.ts';
import type { ContextMode } from './benchmark-engine.ts';
import { fixtureVersion, smokeScenarios } from './benchmark-fixtures.ts';
import { assertInactiveOperator, probeRequestId, runProbe, formatProbeRequestId, runFormatProbe } from './benchmark-probe.ts';

const stateDirectory = '/var/lib/cashneuro/analyzer-benchmark';
async function main() {
  const [action, candidate, mode = 'task', ...extra] = process.argv.slice(2);
  const formatProbe = action === '--probe-format';
  const diagnostic = action === '--probe' || action === '--probe-after-funding' || formatProbe;
  const comparison = action === '--compare';
  const resolved = action === '--live-resolved' || action === '--report-resolved' || comparison;
  const report = action === '--report' || action === '--report-revised' || action === '--report-resolved';
  const revised = action === '--live-revised' || action === '--report-revised';
  const fundedSmoke = action === '--live-after-funding', recovery = diagnostic || fundedSmoke || report || revised || resolved;
  if (extra.length || !['--dry-run', '--live', '--probe', '--probe-after-funding', '--live-after-funding', '--report', '--live-revised', '--report-revised', '--live-resolved', '--report-resolved', '--compare', '--probe-format'].includes(action ?? '') || !Object.hasOwn(candidates, candidate ?? '') || !['task', 'window', 'transcript'].includes(mode) || diagnostic && mode !== 'task' || (comparison || formatProbe) && candidate !== 'cloud-giga') throw new BenchmarkFailure('BENCH_ARGUMENTS_INVALID');
  const probePhase = action === '--probe-after-funding' ? 'after-funding' : 'initial';
  const selected = candidates[candidate as Candidate];
  if (action === '--dry-run') {
    console.log(JSON.stringify({ candidate, mode, fixtureVersion, scenarios: smokeScenarios.length,
      turns: smokeScenarios.reduce((sum, s) => sum + s.turns.length, 0), price: selected.price,
      maximumReservationRub: (Number(tokenCost(selected.price, selected.contextTokens, 1200)) / 1e9).toFixed(9),
      smokeBudgetRub: '45', overallApprovedBudgetRub: '1000', paidCalls: 0 })); return;
  }
  if (process.getuid?.() !== 0) throw new BenchmarkFailure('BENCH_OPERATOR_REQUIRED');
  if (!report) await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
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
  let ledger: BenchmarkLedger | undefined; let clean = report; let probeId: string | undefined;
  try {
    await lock.writeFile(String(process.pid)); await lock.sync();
    if (recovery) await assertInactiveOperator(join(stateDirectory, 'operator.lock'));
    ledger = await BenchmarkLedger.load(join(stateDirectory, 'smoke-ledger.jsonl'), { readOnly: report });
    const transport = report ? replayOnlyBenchmarkTransport(candidate as Candidate) :
      createBenchmarkTransport(candidate as Candidate, object(await privateJson('/etc/cashneuro/ai/benchmark/provider-keys.json'), ['cloud', 'yandex'])[selected.provider]);
    if (diagnostic) probeId = formatProbe ? formatProbeRequestId(transport) : probeRequestId(transport, probePhase);
    if (fundedSmoke) await ledger.allowFundedSmoke();
    // A revised paid trial requires a completed baseline for the same model/mode.
    if (revised && !report) await runSmoke(replayOnlyBenchmarkTransport(candidate as Candidate), ledger, mode as ContextMode, 'after-funding');
    if (resolved && !report && !comparison) await runSmoke(replayOnlyBenchmarkTransport(candidate as Candidate), ledger, mode as ContextMode, 'after-funding', false, 'revised');
    const result = formatProbe ? await runFormatProbe(transport, ledger) : diagnostic ? await runProbe(transport, ledger, probePhase) : comparison ? await runComparison(transport, ledger, mode as ContextMode) :
      await runSmoke(transport, ledger, mode as ContextMode, fundedSmoke || report || revised || resolved ? 'after-funding' : 'initial', report || revised || resolved, resolved ? 'resolved' : revised ? 'revised' : 'original');
    console.log(JSON.stringify({ ...result, ...((report || revised || resolved) && 'checks' in result ? { checks: result.checks.filter(c => !c.gate || c.plan === false) } : {}),
      ...(report ? { report: 'saved-smoke/1', paidCalls: 0 } : {}), cost: smokeCostReport(ledger) }));
    clean = !ledger.totals().blocked;
  } catch (error) {
    if (ledger) console.log(JSON.stringify({ candidate, mode, error: error instanceof BenchmarkFailure ? error.code : 'BENCH_FAILED', cost: smokeCostReport(ledger) }));
    throw error;
  } finally {
    if (ledger) {
      clean = report || (diagnostic ? Boolean(probeId) && (!ledger.records.has(probeId!) || Boolean(ledger.records.get(probeId!)?.receipt)) : !ledger.totals().blocked);
      await ledger.close();
    }
    await lock.close();
    if (clean) await unlink(lockPath);
  }
}
main().catch(error => { console.error(error instanceof BenchmarkFailure ? error.code : 'BENCH_FAILED'); process.exitCode = 1; });
