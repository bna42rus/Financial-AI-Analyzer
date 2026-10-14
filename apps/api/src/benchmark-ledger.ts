import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { rubAtoms, tokenCost } from '../../../packages/analyzer/src/cost.ts';
import type { Usage, TokenPrice, DispatchBound } from '../../../packages/analyzer/src/cost.ts';
import { BenchmarkFailure } from './benchmark-transport.ts';

type Reservation = { type: 'reserve'; id: string; atoms: string; price: TokenPrice; bound: DispatchBound; purpose?: 'operator_probe' };
type Receipt = { type: 'receipt'; id: string; usage: Usage | null; atoms: string | null; value: unknown; code: string | null; fingerprint: string | null; latencyMs: number; cachedTokens: number | null; reasoningTokens: number | null };
type Event = Reservation | Receipt;
export const benchmarkBudget = { project: 1000n * rubAtoms, smoke: 45n * rubAtoms };
export const benchmarkDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Caller holds the one process lock for the entire live run. All reservations
 * and receipts are fsynced; restart never releases an ambiguous dispatch. */
export class BenchmarkLedger {
  file: FileHandle; records = new Map<string, { reserve: Reservation; receipt?: Receipt }>(); previous = '0'.repeat(64);
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private constructor(file: FileHandle) { this.file = file; }
  static async load(path: string): Promise<BenchmarkLedger> {
    const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size > 4_194_304) throw new Error();
      // Persist the initial directory entry too, before a paid dispatch can
      // happen. File fsync alone does not guarantee survival of its creation.
      const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
      const ledger = new BenchmarkLedger(file), source = await file.readFile('utf8');
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
    const old = this.records.get(event.id);
    if (event.type === 'reserve') {
      if (event.purpose !== undefined) {
        if (event.purpose !== 'operator_probe') throw new Error();
        this.assertProbeAllowed(event.price, event.bound);
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
    for (const { reserve, receipt } of this.records.values()) {
      if (!receipt?.usage) { held += BigInt(reserve.atoms); blocked = true; }
      else { spent += BigInt(receipt.atoms!);
        if (receipt.usage.inputTokens > reserve.bound.inputTokens || receipt.usage.outputTokens > reserve.bound.outputTokens || receipt.usage.modelVersion !== reserve.bound.modelVersion) blocked = true;
        if (fingerprints.has(reserve.bound.modelVersion) && fingerprints.get(reserve.bound.modelVersion) !== receipt.fingerprint) blocked = true;
        fingerprints.set(reserve.bound.modelVersion, receipt.fingerprint); }
    }
    return { spent, held, blocked };
  }
  private async append(event: Event) {
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
  private assertProbeAllowed(price: TokenPrice, bound: DispatchBound) {
    // An explicit operator probe is allowed only after one known HTTP rejection.
    // Its full old reservation remains held; delivery loss/crash/drift do not qualify.
    if (this.poisoned || this.records.size !== 1) throw new BenchmarkFailure('BENCH_PROBE_NOT_ALLOWED');
    const old = [...this.records.values()][0]!;
    if (!old.receipt || old.receipt.usage !== null || !/^BENCH_(PROVIDER_FAILURE|IDENTITY_DENIED)(?:_HTTP_[3-5]\d{2})?$/.test(old.receipt.code ?? '') ||
        benchmarkDigest(old.reserve.price) !== benchmarkDigest(price) || benchmarkDigest(old.reserve.bound) !== benchmarkDigest(bound)) throw new BenchmarkFailure('BENCH_PROBE_NOT_ALLOWED');
    const total = this.totals(), amount = tokenCost(price, bound.inputTokens, bound.outputTokens);
    if (total.spent + total.held + amount > benchmarkBudget.smoke || total.spent + total.held + amount > benchmarkBudget.project) throw new BenchmarkFailure('BENCH_BUDGET_EXHAUSTED');
  }
  async reserveProbe(id: string, price: TokenPrice, bound: DispatchBound) {
    return this.exclusive(async () => {
      if (!/^[a-f0-9]{64}$/.test(id) || this.records.has(id)) throw new BenchmarkFailure('BENCH_RESERVATION_INVALID');
      this.assertProbeAllowed(price, bound);
      const atoms = tokenCost(price, bound.inputTokens, bound.outputTokens).toString();
      await this.append({ type: 'reserve', id, atoms, price, bound, purpose: 'operator_probe' });
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
