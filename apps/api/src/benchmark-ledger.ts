import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { rubAtoms, tokenCost } from '../../../packages/analyzer/src/cost.ts';
import type { Usage, TokenPrice, DispatchBound } from '../../../packages/analyzer/src/cost.ts';
import { BenchmarkFailure } from './benchmark-transport.ts';

export type ProbePurpose = 'operator_probe' | 'operator_probe_after_funding';
type Reservation = { type: 'reserve'; id: string; atoms: string; price: TokenPrice; bound: DispatchBound; purpose?: ProbePurpose };
type Receipt = { type: 'receipt'; id: string; usage: Usage | null; atoms: string | null; value: unknown; code: string | null; fingerprint: string | null; latencyMs: number; cachedTokens: number | null; reasoningTokens: number | null };
type FundedContinuation = { type: 'continue_with_held_rejections'; id: string; rejectionIds: string[]; proofId: string };
type Event = Reservation | Receipt | FundedContinuation;
export const benchmarkBudget = { project: 1000n * rubAtoms, smoke: 45n * rubAtoms };
export const benchmarkDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Caller holds the one process lock for the entire live run. All reservations
 * and receipts are fsynced; restart never releases an ambiguous dispatch. */
export class BenchmarkLedger {
  file: FileHandle; records = new Map<string, { reserve: Reservation; receipt?: Receipt }>(); previous = '0'.repeat(64);
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private heldRejections = new Set<string>();
  private constructor(file: FileHandle, private readonly readOnly = false) { this.file = file; }
  static async load(path: string, options: { readOnly?: boolean } = {}): Promise<BenchmarkLedger> {
    const file = await open(path, (options.readOnly ? constants.O_RDONLY : constants.O_RDWR | constants.O_CREAT | constants.O_APPEND) | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size > 4_194_304) throw new Error();
      // Persist the initial directory entry too, before a paid dispatch can
      // happen. File fsync alone does not guarantee survival of its creation.
      if (!options.readOnly) {
        const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
      }
      const ledger = new BenchmarkLedger(file, options.readOnly), source = await file.readFile('utf8');
      if (source && !source.endsWith('\n')) throw new Error();
      for (const line of source.split('\n').filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.previous !== ledger.previous || record.hash !== benchmarkDigest({ previous: record.previous, event: record.event })) throw new Error();
        ledger.apply(record.event); ledger.previous = record.hash;
      }
      return ledger;
    } catch { await file.close(); throw new BenchmarkFailure('BENCH_LEDGER_INVALID'); }
  }
  private apply(event: Event) {
    if (!event || !/^[a-f0-9]{64}$/.test(event.id)) throw new Error();
    if (event.type === 'continue_with_held_rejections') {
      const expected = this.fundedContinuation();
      if (benchmarkDigest(event) !== benchmarkDigest(expected)) throw new Error();
      this.heldRejections = new Set(event.rejectionIds);
      return;
    }
    const old = this.records.get(event.id);
    if (event.type === 'reserve') {
      if (event.purpose !== undefined) {
        if (!['operator_probe', 'operator_probe_after_funding'].includes(event.purpose)) throw new Error();
        this.assertProbeAllowed(event.price, event.bound, event.purpose);
      }
      if (old || !/^\d{1,16}$/.test(event.atoms) || BigInt(event.atoms) !== tokenCost(event.price, event.bound.inputTokens, event.bound.outputTokens) || BigInt(event.atoms) <= 0n || typeof event.bound.modelVersion !== 'string') throw new Error();
      this.records.set(event.id, { reserve: event });
    } else if (event.type === 'receipt') {
      if (!old || old.receipt || (event.usage ? event.atoms !== tokenCost(old.reserve.price, event.usage.inputTokens, event.usage.outputTokens).toString() : event.atoms !== null) || !Number.isSafeInteger(event.latencyMs) || event.latencyMs < 0) throw new Error();
      old.receipt = event;
    } else throw new Error();
  }
  totals() {
    let spent = 0n, held = 0n; let blocked = this.poisoned;
    const fingerprints = new Map<string, string | null>();
    for (const [id, { reserve, receipt }] of this.records) {
      if (!receipt?.usage) { held += BigInt(reserve.atoms); if (!this.heldRejections.has(id)) blocked = true; }
      else { spent += BigInt(receipt.atoms!);
        if (receipt.usage.inputTokens > reserve.bound.inputTokens || receipt.usage.outputTokens > reserve.bound.outputTokens || receipt.usage.modelVersion !== reserve.bound.modelVersion) blocked = true;
        if (fingerprints.has(reserve.bound.modelVersion) && fingerprints.get(reserve.bound.modelVersion) !== receipt.fingerprint) blocked = true;
        fingerprints.set(reserve.bound.modelVersion, receipt.fingerprint); }
    }
    return { spent, held, blocked };
  }
  private fundedContinuation(): FundedContinuation {
    if (this.poisoned || this.heldRejections.size || this.records.size !== 3) throw new BenchmarkFailure('BENCH_FUNDED_CONTINUATION_NOT_ALLOWED');
    const entries = [...this.records.entries()], [firstId, first] = entries[0]!, [probeId, probe] = entries[1]!, [proofId, proof] = entries[2]!;
    const usage = proof.receipt?.usage;
    const gate = proof.receipt?.value as { relevance?: unknown; followUp?: unknown } | null;
    if (first.reserve.purpose !== undefined || !first.receipt || first.receipt.usage !== null || !/^BENCH_(PROVIDER_FAILURE|IDENTITY_DENIED)(?:_HTTP_[3-5]\d{2})?$/.test(first.receipt.code ?? '') ||
        probe.reserve.purpose !== 'operator_probe' || !probe.receipt || probe.receipt.usage !== null || probe.receipt.code !== 'BENCH_PROVIDER_FAILURE_HTTP_402' ||
        proof.reserve.purpose !== 'operator_probe_after_funding' || !proof.receipt || proof.receipt.code !== null || !usage || usage.modelVersion !== proof.reserve.bound.modelVersion ||
        usage.inputTokens > proof.reserve.bound.inputTokens || usage.outputTokens > proof.reserve.bound.outputTokens || gate?.relevance !== 'financial' || gate.followUp !== false ||
        [probe, proof].some(record => benchmarkDigest(record.reserve.price) !== benchmarkDigest(first.reserve.price) || benchmarkDigest(record.reserve.bound) !== benchmarkDigest(first.reserve.bound))) throw new BenchmarkFailure('BENCH_FUNDED_CONTINUATION_NOT_ALLOWED');
    const data = { rejectionIds: [firstId, probeId], proofId };
    return { type: 'continue_with_held_rejections', id: benchmarkDigest({ action: 'funded-smoke/1', ...data }), ...data };
  }
  async allowFundedSmoke() {
    return this.exclusive(async () => {
      if (this.heldRejections.size) return;
      await this.append(this.fundedContinuation());
    });
  }
  private async append(event: Event) {
    if (this.readOnly) throw new BenchmarkFailure('BENCH_REPLAY_ONLY');
    try {
    const hash = benchmarkDigest({ previous: this.previous, event });
    const bytes = Buffer.from(JSON.stringify({ previous: this.previous, event, hash }) + '\n');
    let offset = 0;
    while (offset < bytes.length) { const written = await this.file.write(bytes, offset, bytes.length - offset); if (!written.bytesWritten) throw new Error(); offset += written.bytesWritten; }
    await this.file.sync(); this.apply(event); this.previous = hash;
    } catch { this.poisoned = true; throw new BenchmarkFailure('BENCH_LEDGER_WRITE_FAILED'); }
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action); this.queue = result.catch(() => undefined); return result;
  }
  async reserve(id: string, price: TokenPrice, bound: DispatchBound) {
    return this.exclusive(async () => {
    if (!/^[a-f0-9]{64}$/.test(id) || this.records.has(id)) throw new BenchmarkFailure('BENCH_RESERVATION_INVALID');
    const total = this.totals(), amount = tokenCost(price, bound.inputTokens, bound.outputTokens);
    if (total.blocked) throw new BenchmarkFailure('BENCH_RECONCILIATION_REQUIRED');
    for (const old of this.records.values()) if (old.reserve.bound.modelVersion === bound.modelVersion && benchmarkDigest(old.reserve.price) !== benchmarkDigest(price)) throw new BenchmarkFailure('BENCH_PRICE_CHANGED');
    if (total.spent + total.held + amount > benchmarkBudget.smoke || total.spent + total.held + amount > benchmarkBudget.project) throw new BenchmarkFailure('BENCH_BUDGET_EXHAUSTED');
    await this.append({ type: 'reserve', id, atoms: amount.toString(), price, bound });
    });
  }
  private assertProbeAllowed(price: TokenPrice, bound: DispatchBound, purpose: ProbePurpose = 'operator_probe') {
    // An explicit operator probe is allowed only after one known HTTP rejection.
    // Its full old reservation remains held; delivery loss/crash/drift do not qualify.
    const afterFunding = purpose === 'operator_probe_after_funding';
    if (!['operator_probe', 'operator_probe_after_funding'].includes(purpose) || this.poisoned || this.records.size !== (afterFunding ? 2 : 1)) throw new BenchmarkFailure('BENCH_PROBE_NOT_ALLOWED');
    const records = [...this.records.values()], old = records[0]!;
    if (old.reserve.purpose !== undefined || !old.receipt || old.receipt.usage !== null || !/^BENCH_(PROVIDER_FAILURE|IDENTITY_DENIED)(?:_HTTP_[3-5]\d{2})?$/.test(old.receipt.code ?? '') ||
        benchmarkDigest(old.reserve.price) !== benchmarkDigest(price) || benchmarkDigest(old.reserve.bound) !== benchmarkDigest(bound)) throw new BenchmarkFailure('BENCH_PROBE_NOT_ALLOWED');
    if (afterFunding) {
      const probe = records[1]!;
      if (probe.reserve.purpose !== 'operator_probe' || !probe.receipt || probe.receipt.usage !== null || probe.receipt.code !== 'BENCH_PROVIDER_FAILURE_HTTP_402' ||
          benchmarkDigest(probe.reserve.price) !== benchmarkDigest(price) || benchmarkDigest(probe.reserve.bound) !== benchmarkDigest(bound)) throw new BenchmarkFailure('BENCH_PROBE_NOT_ALLOWED');
    }
    const total = this.totals(), amount = tokenCost(price, bound.inputTokens, bound.outputTokens);
    if (total.spent + total.held + amount > benchmarkBudget.smoke || total.spent + total.held + amount > benchmarkBudget.project) throw new BenchmarkFailure('BENCH_BUDGET_EXHAUSTED');
  }
  async reserveProbe(id: string, price: TokenPrice, bound: DispatchBound, purpose: ProbePurpose = 'operator_probe') {
    return this.exclusive(async () => {
      if (!/^[a-f0-9]{64}$/.test(id) || this.records.has(id)) throw new BenchmarkFailure('BENCH_RESERVATION_INVALID');
      this.assertProbeAllowed(price, bound, purpose);
      const atoms = tokenCost(price, bound.inputTokens, bound.outputTokens).toString();
      await this.append({ type: 'reserve', id, atoms, price, bound, purpose });
    });
  }
  async receipt(receipt: Omit<Receipt, 'type' | 'atoms'>) {
    return this.exclusive(async () => {
    const old = this.records.get(receipt.id); if (!old || old.receipt) throw new BenchmarkFailure('BENCH_RESERVATION_REQUIRED');
    if (!Number.isSafeInteger(receipt.latencyMs) || receipt.latencyMs < 0) throw new BenchmarkFailure('BENCH_RECEIPT_INVALID');
    await this.append({ ...receipt, type: 'receipt', atoms: receipt.usage ? tokenCost(old.reserve.price, receipt.usage.inputTokens, receipt.usage.outputTokens).toString() : null });
    });
  }
  async close() { await this.file.close(); }
}
