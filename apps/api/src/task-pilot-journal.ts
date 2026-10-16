import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { benchmarkDigest, BenchmarkLedger } from './benchmark-ledger.ts';
import { BenchmarkFailure } from './benchmark-transport.ts';
import { tokenCost } from '../../../packages/analyzer/src/cost.ts';
import type { DispatchBound, TokenPrice } from '../../../packages/analyzer/src/cost.ts';
import { object } from '../../../packages/finance-core/src/model.ts';

type Frozen = { version: 'cashneuro-pilot-journal/1'; bindingSha256: string; baselineIds: string[]; baselineRecordsSha256: string; baselineUpperAtoms: string; requestIds: string[]; incrementalCapAtoms: string; maximumCalls: number; retainedHttp400s?: string[]; budgetBaselineUpperAtoms?: string };
const fail = (code = 'TASK_PILOT_JOURNAL_INVALID'): never => { throw new BenchmarkFailure(code); };
const baselineDigest = (ledger: BenchmarkLedger, ids: string[]) => benchmarkDigest(ids.map(id => [id, ledger.records.get(id)]));
async function syncParent(path: string) { const dir = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await dir.sync(); } finally { await dir.close(); } }
export async function readPilotJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 131072) return fail();
    const text = await file.readFile('utf8'); if (!text.endsWith('\n')) return fail();
    return JSON.parse(text);
  } catch { return fail(); } finally { await file.close(); }
}
/** Exclusive create only: an existing frozen artifact/cache is never replaced. */
export async function writePilotJson(path: string, payload: unknown) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify(payload) + '\n'); let offset = 0;
    if (bytes.length > 131072) return fail();
    while (offset < bytes.length) { const part = await file.write(bytes, offset, bytes.length - offset); if (!part.bytesWritten) return fail(); offset += part.bytesWritten; }
    await file.sync();
  } finally { await file.close(); }
  await syncParent(path);
}
export async function ensurePilotCache(path: string) {
  await mkdir(path, { mode: 0o700 }); await syncParent(path);
}

/** Generic private frozen journal. The operator CLI supplies the mandatory exact
 * historical-baseline validator; tests use their own isolated synthetic baseline.
 * Every paid reserve/receipt still belongs to the original BenchmarkLedger. */
export class PilotJournal {
  private reserveQueue: Promise<unknown> = Promise.resolve();
  private constructor(readonly ledger: BenchmarkLedger, readonly frozen: Frozen, readonly cacheDirectory: string, readonly readOnly: boolean) {}
  static async load(options: { path: string; cacheDirectory: string; ledger: BenchmarkLedger; bindingSha256: string; requestIds: string[]; incrementalCapAtoms: string; maximumCalls: number; readOnly: boolean; assertInitial: (ledger: BenchmarkLedger) => void; retainedHttp400s?: string[]; budgetBaselineUpperAtoms?: string }) {
    const { ledger } = options;
    if (!/^[a-f0-9]{64}$/.test(options.bindingSha256) || !/^\d{1,16}$/.test(options.incrementalCapAtoms) || BigInt(options.incrementalCapAtoms) <= 0n || BigInt(options.incrementalCapAtoms) > 20_000_000_000n ||
        options.maximumCalls !== options.requestIds.length || options.maximumCalls < 1 || options.maximumCalls > 240 || new Set(options.requestIds).size !== options.requestIds.length || options.requestIds.some(id => !/^[a-f0-9]{64}$/.test(id))) return fail();
    let frozen: Frozen;
    if ((options.retainedHttp400s === undefined) !== (options.budgetBaselineUpperAtoms === undefined) || options.budgetBaselineUpperAtoms !== undefined && !/^\d{1,16}$/.test(options.budgetBaselineUpperAtoms)) return fail();
    try {
      const raw = object(await readPilotJson(options.path), ['hash', 'payload']);
      if (raw.hash !== benchmarkDigest(raw.payload)) return fail();
      frozen = object(raw.payload, ['version', 'bindingSha256', 'baselineIds', 'baselineRecordsSha256', 'baselineUpperAtoms', 'requestIds', 'incrementalCapAtoms', 'maximumCalls', 'retainedHttp400s', 'budgetBaselineUpperAtoms']) as Frozen;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (options.readOnly) return fail('TASK_PILOT_NOT_STARTED');
      options.assertInitial(ledger);
      const baselineIds = [...ledger.records.keys()].sort();
      if (baselineIds.length > 1000 || options.requestIds.some(id => ledger.records.has(id))) return fail();
      const cost = options.retainedHttp400s ? ledger.totalsWithHeldHttp400s(options.retainedHttp400s) : ledger.totals(); if (cost.blocked) return fail('BENCH_RECONCILIATION_REQUIRED');
      frozen = { version: 'cashneuro-pilot-journal/1', bindingSha256: options.bindingSha256, baselineIds, baselineRecordsSha256: baselineDigest(ledger, baselineIds), baselineUpperAtoms: (cost.spent + cost.held).toString(),
        requestIds: options.requestIds, incrementalCapAtoms: options.incrementalCapAtoms, maximumCalls: options.maximumCalls,
        ...(options.retainedHttp400s ? { retainedHttp400s: options.retainedHttp400s, budgetBaselineUpperAtoms: options.budgetBaselineUpperAtoms } : {}) };
      await writePilotJson(options.path, { payload: frozen, hash: benchmarkDigest(frozen) });
    }
    if (benchmarkDigest(frozen.retainedHttp400s ?? null) !== benchmarkDigest(options.retainedHttp400s ?? null) || frozen.budgetBaselineUpperAtoms !== options.budgetBaselineUpperAtoms) return fail('TASK_PILOT_FROZEN_ARTIFACT_CHANGED');
    if (frozen.version !== 'cashneuro-pilot-journal/1' || frozen.bindingSha256 !== options.bindingSha256 || frozen.incrementalCapAtoms !== options.incrementalCapAtoms || frozen.maximumCalls !== options.maximumCalls ||
        benchmarkDigest(frozen.requestIds) !== benchmarkDigest(options.requestIds) || !Array.isArray(frozen.baselineIds) || frozen.baselineIds.length > 1000 || new Set(frozen.baselineIds).size !== frozen.baselineIds.length || frozen.baselineIds.some(id => !/^[a-f0-9]{64}$/.test(id)) ||
        !/^[a-f0-9]{64}$/.test(frozen.baselineRecordsSha256) || !/^\d{1,16}$/.test(frozen.baselineUpperAtoms)) return fail('TASK_PILOT_FROZEN_ARTIFACT_CHANGED');
    const service = new PilotJournal(ledger, frozen, options.cacheDirectory, options.readOnly);
    service.verify(); return service;
  }
  verify() {
    const f = this.frozen;
    if (f.baselineIds.some(id => !this.ledger.records.has(id)) || baselineDigest(this.ledger, f.baselineIds) !== f.baselineRecordsSha256) return fail('TASK_PILOT_BASELINE_CHANGED');
    const allowed = new Set([...f.baselineIds, ...f.requestIds]);
    if ([...this.ledger.records.keys()].some(id => !allowed.has(id))) return fail('TASK_PILOT_FOREIGN_REQUEST');
    const cost = f.retainedHttp400s ? this.ledger.totalsWithHeldHttp400s(f.retainedHttp400s) : this.ledger.totals(), delta = cost.spent + cost.held - BigInt(f.budgetBaselineUpperAtoms ?? f.baselineUpperAtoms);
    const baselineUpper = f.baselineIds.reduce((sum, id) => { const r = this.ledger.records.get(id)!; return sum + BigInt(r.receipt?.usage ? r.receipt.atoms! : r.reserve.atoms); }, 0n);
    if (baselineUpper !== BigInt(f.baselineUpperAtoms)) return fail('TASK_PILOT_BASELINE_CHANGED');
    if (f.budgetBaselineUpperAtoms !== undefined && BigInt(f.budgetBaselineUpperAtoms) > baselineUpper) return fail('TASK_PILOT_COST_CONTRACT_CHANGED');
    if (delta < 0n || delta > BigInt(f.incrementalCapAtoms)) return fail('TASK_PILOT_COST_CONTRACT_CHANGED');
    if (this.frozen.requestIds.filter(id => this.ledger.records.has(id)).length > f.maximumCalls) return fail('TASK_PILOT_CALL_LIMIT');
    return { cost, incrementalUpperAtoms: delta.toString(), calls: this.frozen.requestIds.filter(id => this.ledger.records.has(id)).length };
  }
  async reserve(id: string, price: TokenPrice, bound: DispatchBound) {
    const action = this.reserveQueue.then(async () => {
    if (this.readOnly) return fail('BENCH_REPLAY_ONLY');
    const current = this.verify();
    if (!this.frozen.requestIds.includes(id) || this.ledger.records.has(id)) return fail('TASK_PILOT_ID_INVALID');
    if (this.frozen.requestIds.some(key => this.ledger.records.get(key)?.receipt?.code === 'TASK_PILOT_PROVIDER_INVALID')) return fail('TASK_PILOT_PROVIDER_DRIFT');
    if (current.cost.blocked) return fail('BENCH_RECONCILIATION_REQUIRED');
    if (current.calls >= this.frozen.maximumCalls) return fail('TASK_PILOT_CALL_LIMIT');
    const reserve = tokenCost(price, bound.inputTokens, bound.outputTokens);
    if (BigInt(current.incrementalUpperAtoms) + reserve > BigInt(this.frozen.incrementalCapAtoms)) return fail('TASK_PILOT_INCREMENTAL_BUDGET_EXHAUSTED');
    // The original ledger enforces its original global/project caps as well.
    if (this.frozen.retainedHttp400s) await this.ledger.reserveHeldFormatTrial(id, price, bound, { ...this.frozen, retainedHttp400s: this.frozen.retainedHttp400s, budgetBaselineUpperAtoms: this.frozen.budgetBaselineUpperAtoms! });
    else await this.ledger.reserve(id, price, bound);
    });
    this.reserveQueue = action.catch(() => undefined); return action;
  }
  async cached(id: string, wireSha256: string): Promise<{ payload: unknown; code: string | null }> {
    const receipt = this.ledger.records.get(id)?.receipt;
    if (!receipt?.usage) return fail('BENCH_RECONCILIATION_REQUIRED');
    const value = object(receipt.value, ['wireSha256']);
    if (value.wireSha256 !== wireSha256) return fail('TASK_PILOT_REQUEST_CHANGED');
    if (receipt.code) return { payload: null, code: receipt.code };
    let raw: Record<string, unknown>;
    try { raw = object(await readPilotJson(join(this.cacheDirectory, id + '.json')), ['hash', 'payload']); }
    catch { return fail('TASK_PILOT_RESPONSE_UNAVAILABLE'); }
    if (raw.hash !== benchmarkDigest(raw.payload)) return fail();
    const cached = object(raw.payload, ['id', 'wireSha256', 'value', 'code']);
    if (cached.id !== id || cached.wireSha256 !== wireSha256 || cached.code !== null && cached.code !== 'TASK_PILOT_PAYLOAD_INVALID') return fail('TASK_PILOT_REQUEST_CHANGED');
    return { payload: cached.value, code: cached.code as string | null };
  }
  async cache(id: string, wireSha256: string, value: unknown, code: string | null) {
    if (this.readOnly || !this.frozen.requestIds.includes(id) || !this.ledger.records.get(id)?.receipt?.usage || !/^[a-f0-9]{64}$/.test(wireSha256) || code !== null && code !== 'TASK_PILOT_PAYLOAD_INVALID') return fail();
    const payload = { id, wireSha256, value, code };
    await writePilotJson(join(this.cacheDirectory, id + '.json'), { hash: benchmarkDigest(payload), payload });
  }
}
