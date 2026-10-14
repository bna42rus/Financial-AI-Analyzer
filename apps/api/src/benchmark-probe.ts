import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { gatePrompt, gateSchema, parseGate } from '../../../packages/analyzer/src/yandex-contract.ts';
import { benchmarkDigest, BenchmarkLedger } from './benchmark-ledger.ts';
import { BenchmarkFailure, replayOnlyBenchmarkTransport } from './benchmark-transport.ts';
import type { BenchmarkResult, BenchmarkTransport } from './benchmark-transport.ts';
import { runSmoke } from './benchmark-engine.ts';
import { revisedGatePrompt, resolvedBenchmarkPromptVersion } from './benchmark-prompts.ts';

const input = { question: 'Сколько потрачено за выбранный период?', hasFinancialContext: false };
export type ProbePhase = 'initial' | 'after-funding';
const probeVersion = (phase: ProbePhase) => phase === 'initial' ? 'operator-probe/1' : 'operator-probe-after-funding/1';
export function probeRequestId(transport: BenchmarkTransport, phase: ProbePhase = 'initial') {
  if (!['initial', 'after-funding'].includes(phase)) throw new BenchmarkFailure('BENCH_PROBE_NOT_ALLOWED');
  return benchmarkDigest({ purpose: probeVersion(phase), candidate: transport.candidate, price: transport.price, prompt: gatePrompt, input, schema: gateSchema });
}
export async function assertInactiveOperator(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 16) throw new BenchmarkFailure('BENCH_OPERATOR_LOCK_INVALID');
    const source = await file.readFile('utf8');
    if (!/^[1-9]\d{0,9}$/.test(source) || Number(source) > 2147483647) throw new BenchmarkFailure('BENCH_OPERATOR_LOCK_INVALID');
    let running = true;
    try { process.kill(Number(source), 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new BenchmarkFailure('BENCH_OPERATOR_LOCK_UNVERIFIED');
      running = false;
    }
    if (running) throw new BenchmarkFailure('BENCH_OPERATOR_ACTIVE');
  } finally { await file.close(); }
}
/** Exactly one explicit diagnostic dispatch. Never releases the old reservation
 * or lock, and never retries a cached, failed, or ambiguous diagnostic attempt. */
export async function runProbe(transport: BenchmarkTransport, ledger: BenchmarkLedger, phase: ProbePhase = 'initial') {
  const id = probeRequestId(transport, phase);
  const purpose = phase === 'initial' ? 'operator_probe' : 'operator_probe_after_funding';
  const replay = Boolean(ledger.records.has(id));
  if (replay && ledger.records.get(id)?.reserve.purpose !== purpose) throw new BenchmarkFailure('BENCH_PROBE_NOT_ALLOWED');
  if (!replay) {
    const started = performance.now(); let completed: BenchmarkResult | undefined;
    try {
      completed = await transport.complete(gatePrompt, input, gateSchema, () => ledger.reserveProbe(id, transport.price, transport.bound, purpose));
      const value = parseGate(completed.value);
      await ledger.receipt({ id, usage: completed.usage, value, code: null, fingerprint: completed.fingerprint,
        latencyMs: Math.ceil(performance.now() - started), cachedTokens: completed.cachedTokens, reasoningTokens: completed.reasoningTokens });
    } catch (error) {
      const old = ledger.records.get(id);
      if (!old || old.receipt) throw error;
      const failure = error instanceof BenchmarkFailure ? error : new BenchmarkFailure('BENCH_PLAN_INVALID', completed?.usage, completed?.fingerprint ?? undefined);
      await ledger.receipt({ id, usage: failure.usage ?? null, value: { referencedParameters: failure.referencedParameters ?? [] }, code: failure.code, fingerprint: failure.fingerprint ?? null,
        latencyMs: Math.ceil(performance.now() - started), cachedTokens: completed?.cachedTokens ?? null, reasoningTokens: completed?.reasoningTokens ?? null });
    }
  }
  const receipt = ledger.records.get(id)?.receipt;
  return { probe: probeVersion(phase), candidate: transport.candidate, callsThisRun: replay ? 0 : 1, replay,
    error: receipt?.code ?? (receipt ? null : 'BENCH_RECONCILIATION_REQUIRED'), result: receipt?.code ? null : receipt?.value ?? null,
    referencedParameters: receipt?.code ? (receipt.value as { referencedParameters?: string[] } | null)?.referencedParameters ?? [] : [],
    usage: receipt?.usage ?? null, originalReservationPreserved: true };
}

const formatInput = { ...input, previousTask: null };
export function formatProbeRequestId(transport: BenchmarkTransport) {
  if (transport.candidate !== 'cloud-giga') throw new BenchmarkFailure('BENCH_PROBE_NOT_ALLOWED');
  return benchmarkDigest({ purpose: 'operator-format-probe/1', candidate: transport.candidate, price: transport.price,
    bound: transport.bound, benchmarkPromptVersion: resolvedBenchmarkPromptVersion, prompt: revisedGatePrompt, input: formatInput, schema: gateSchema });
}
/** One diagnostic after the known Giga format failure. No schema repair/retry,
 * raw content, credentials or arbitrary response strings enter its receipt. */
export async function runFormatProbe(transport: BenchmarkTransport, ledger: BenchmarkLedger) {
  const id = formatProbeRequestId(transport), replay = ledger.records.has(id);
  if (!replay) {
    const failed = await runSmoke(replayOnlyBenchmarkTransport('cloud-giga'), ledger, 'task', 'after-funding', true, 'resolved');
    if (failed.turns !== 24 || failed.checks.some(c => c.calls !== 1 || c.diagnostics?.errors.length !== 1 || c.diagnostics.errors[0]?.code !== 'BENCH_RESPONSE_INVALID')) throw new BenchmarkFailure('BENCH_PROBE_NOT_ALLOWED');
    const started = performance.now(); let completed: BenchmarkResult | undefined;
    try {
      completed = await transport.complete(revisedGatePrompt, formatInput, gateSchema, () => ledger.reserve(id, transport.price, transport.bound));
      const gate = parseGate(completed.value);
      await ledger.receipt({ id, usage: completed.usage, value: { gate, responsePhase: null, responseShape: completed.responseShape ?? null }, code: null,
        fingerprint: completed.fingerprint, latencyMs: Math.ceil(performance.now() - started), cachedTokens: completed.cachedTokens, reasoningTokens: completed.reasoningTokens });
    } catch (error) {
      const old = ledger.records.get(id); if (!old || old.receipt) throw error;
      const failure = error instanceof BenchmarkFailure ? error : new BenchmarkFailure('BENCH_PLAN_INVALID', completed?.usage, completed?.fingerprint ?? undefined);
      await ledger.receipt({ id, usage: failure.usage ?? null, value: { gate: null, responsePhase: failure.responsePhase ?? (completed ? 'GATE' : null),
        responseShape: failure.responseShape ?? completed?.responseShape ?? null }, code: failure.code, fingerprint: failure.fingerprint ?? null,
        latencyMs: Math.ceil(performance.now() - started), cachedTokens: completed?.cachedTokens ?? null, reasoningTokens: completed?.reasoningTokens ?? null });
    }
  }
  const receipt = ledger.records.get(id)?.receipt;
  return { probe: 'operator-format-probe/1', candidate: transport.candidate, callsThisRun: replay ? 0 : 1, replay,
    error: receipt?.code ?? (receipt ? null : 'BENCH_RECONCILIATION_REQUIRED'), diagnostics: receipt?.value ?? null, usage: receipt?.usage ?? null,
    originalReservationPreserved: true };
}
