import { constants } from 'node:fs';
import { open, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { object, uuid } from '../../../packages/finance-core/src/model.ts';
import { tokenPrice, tokenCost, usageTokens } from '../../../packages/analyzer/src/cost.ts';
import type { TokenPrice, DispatchBound, Usage } from '../../../packages/analyzer/src/cost.ts';
import { AssistantError } from '../../../packages/analyzer/src/assistant-plan.ts';
import type { AssistantAccounting } from './assistant-journal.ts';

export const assistantBudgetVersion = 'cashneuro-assistant-budget/1';
export type AssistantPermit = { version: typeof assistantBudgetVersion; sourceSha256: string; metadataSha256: string;
  tariffCheckedAt: string; tariffSource: string; price: TokenPrice; bound: DispatchBound; capAtoms: string; maximumCalls: number; previousBudgetSha256?: string };
type Entry = { requestId: string; index: number; bound: DispatchBound; usage?: Usage; unknown?: boolean };
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function checkAssistantPermit(value: unknown): AssistantPermit {
  const p = object(value, ['version', 'sourceSha256', 'metadataSha256', 'tariffCheckedAt', 'tariffSource', 'price', 'bound', 'capAtoms', 'maximumCalls', 'previousBudgetSha256']);
  if (p.version !== assistantBudgetVersion || ![p.sourceSha256, p.metadataSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) ||
      typeof p.tariffCheckedAt !== 'string' || !Number.isFinite(Date.parse(p.tariffCheckedAt)) || p.tariffSource !== 'https://cloud.ru/products/evolution-ai-factory/catalog-foundation-models' ||
      typeof p.capAtoms !== 'string' || !/^[1-9][0-9]{0,10}$/.test(p.capAtoms) || BigInt(p.capAtoms) > 10_000_000_000n ||
      !Number.isInteger(p.maximumCalls) || Number(p.maximumCalls) < 1 || Number(p.maximumCalls) > 60) throw new AssistantError('ASSISTANT_PERMIT_INVALID');
  tokenPrice(p.price); const b = object(p.bound, ['inputTokens', 'outputTokens', 'modelVersion']);
  if (p.previousBudgetSha256 !== undefined && (typeof p.previousBudgetSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.previousBudgetSha256))) throw new AssistantError('ASSISTANT_PERMIT_INVALID');
  if (b.inputTokens !== 131072 || b.outputTokens !== 1200 || b.modelVersion !== 'openai/gpt-oss-120b') throw new AssistantError('ASSISTANT_PERMIT_INVALID');
  return p as AssistantPermit;
}
/** Read-only admission from the previous attempt. Never frees a hold or
 * raises the owner's cumulative 10 RUB / 60 completion authorization. */
export function remainingAssistantTrialBudget(value: unknown) {
  const state = object(value, ['permit', 'entries', 'sha256']), permit = checkAssistantPermit(state.permit);
  if (permit.capAtoms !== '10000000000' || permit.maximumCalls !== 60 || permit.previousBudgetSha256 !== undefined ||
      !Array.isArray(state.entries) || state.entries.length > 60 || state.sha256 !== hash({ permit: state.permit, entries: state.entries })) throw new AssistantError('ASSISTANT_PREVIOUS_BUDGET_INVALID');
  let spent = 0n; const seen = new Set<string>();
  for (const raw of state.entries) {
    const e = object(raw, ['requestId', 'index', 'bound', 'usage', 'unknown']); uuid(e.requestId);
    const key = e.requestId + ':' + e.index;
    if (!Number.isInteger(e.index) || Number(e.index) < 0 || Number(e.index) > 2 || seen.has(key) || !isDeepStrictEqual(e.bound, permit.bound)) throw new AssistantError('ASSISTANT_PREVIOUS_BUDGET_INVALID');
    if (!e.usage || e.unknown) throw new AssistantError('ASSISTANT_RECONCILIATION_REQUIRED');
    const u = object(e.usage, ['inputTokens', 'outputTokens', 'modelVersion']);
    if (u.modelVersion !== permit.bound.modelVersion || usageTokens(u.inputTokens) > permit.bound.inputTokens || usageTokens(u.outputTokens) > permit.bound.outputTokens) throw new AssistantError('ASSISTANT_RECONCILIATION_REQUIRED');
    spent += tokenCost(permit.price, Number(u.inputTokens), Number(u.outputTokens)); seen.add(key);
  }
  if (spent >= BigInt(permit.capAtoms) || state.entries.length >= 60) throw new AssistantError('ASSISTANT_BUDGET_EXHAUSTED');
  return { previousBudgetSha256: hash(state), spentAtoms: spent.toString(), capAtoms: (BigInt(permit.capAtoms) - spent).toString(), maximumCalls: 60 - state.entries.length };
}
async function syncDir(directory: string) { const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); } }
async function readPrivate(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = await fd.stat(); if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.size > 262144) throw new AssistantError('ASSISTANT_BUDGET_INVALID'); return JSON.parse(await fd.readFile('utf8')); } finally { await fd.close(); }
}

/** A separately authorized operator experiment, with one lock across all
 * requests. An unknown dispatch keeps its full hold and blocks NEW calls.
 * This never opens the historical benchmark ledger. */
export async function withAssistantBudget<T>(directory: string, raw: AssistantPermit, action: (accounting: AssistantAccounting, totals: () => { calls: number; spentAtoms: string; heldAtoms: string; blocked: boolean }) => Promise<T>, now = () => new Date()): Promise<T> {
  const permit = checkAssistantPermit(raw); directory = resolve(directory);
  const s = await lstat(directory);
  if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) throw new AssistantError('ASSISTANT_BUDGET_DIRECTORY_INVALID');
  const lockPath = join(directory, 'experiment.lock'), path = join(directory, 'budget.json');
  let lock;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch { throw new AssistantError('ASSISTANT_EXPERIMENT_IN_PROGRESS'); }
  try {
    await lock.writeFile(String(process.pid)); await lock.sync(); await syncDir(directory);
    let entries: Entry[] = [];
    try {
      const state = object(await readPrivate(path), ['permit', 'entries', 'sha256']);
      if (!isDeepStrictEqual(checkAssistantPermit(state.permit), permit)) throw new AssistantError('ASSISTANT_PERMIT_CHANGED');
      if (state.sha256 !== hash({ permit: state.permit, entries: state.entries }) || !Array.isArray(state.entries) || state.entries.length > permit.maximumCalls) throw new AssistantError('ASSISTANT_BUDGET_INVALID');
      const seen = new Set<string>();
      for (const rawEntry of state.entries) {
        const e = object(rawEntry, ['requestId', 'index', 'bound', 'usage', 'unknown']);
        uuid(e.requestId); const key = e.requestId + ':' + e.index;
        if (!Number.isInteger(e.index) || Number(e.index) < 0 || Number(e.index) > 2 || seen.has(key) || !isDeepStrictEqual(e.bound, permit.bound) || e.unknown !== undefined && e.unknown !== true || e.usage && e.unknown) throw new AssistantError('ASSISTANT_BUDGET_INVALID');
        if (e.usage) { const u = object(e.usage, ['inputTokens', 'outputTokens', 'modelVersion']); usageTokens(u.inputTokens); usageTokens(u.outputTokens); if (u.modelVersion !== null && u.modelVersion !== permit.bound.modelVersion) throw new AssistantError('ASSISTANT_BUDGET_INVALID'); }
        seen.add(key);
      }
      entries = state.entries as Entry[];
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const persist = async () => {
      const temporary = join(directory, randomUUID() + '.tmp'), fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await fd.writeFile(JSON.stringify({ permit, entries, sha256: hash({ permit, entries }) }) + '\n'); await fd.sync(); } finally { await fd.close(); }
      await rename(temporary, path); await syncDir(directory);
    };
    const totals = () => {
      let spent = 0n, held = 0n, blocked = false;
      for (const e of entries) {
        if (!e.usage) { held += tokenCost(permit.price, e.bound.inputTokens, e.bound.outputTokens); blocked = true; }
        else { spent += tokenCost(permit.price, e.usage.inputTokens, e.usage.outputTokens); if (e.usage.modelVersion !== e.bound.modelVersion || e.usage.inputTokens > e.bound.inputTokens || e.usage.outputTokens > e.bound.outputTokens) blocked = true; }
      }
      return { calls: entries.length, spentAtoms: spent.toString(), heldAtoms: held.toString(), blocked };
    };
    let poisoned = false;
    const save = async () => { try { await persist(); } catch { poisoned = true; throw new AssistantError('ASSISTANT_BUDGET_WRITE_FAILED'); } };
    await save();
    const accounting: AssistantAccounting = {
      async reserve(requestId, index, bound) {
        uuid(requestId);
        const age = now().getTime() - Date.parse(permit.tariffCheckedAt);
        if (!Number.isFinite(age) || age < 0 || age > 86400000) throw new AssistantError('ASSISTANT_TARIFF_STALE');
        if (poisoned || !Number.isInteger(index) || index < 0 || index > 2 || !isDeepStrictEqual(bound, permit.bound) || entries.some(e => e.requestId === requestId && e.index === index)) throw new AssistantError('ASSISTANT_RESERVATION_INVALID');
        const t = totals();
        if (t.blocked) throw new AssistantError('ASSISTANT_RECONCILIATION_REQUIRED');
        if (t.calls >= permit.maximumCalls || BigInt(t.spentAtoms) + BigInt(t.heldAtoms) + tokenCost(permit.price, bound.inputTokens, bound.outputTokens) > BigInt(permit.capAtoms)) throw new AssistantError('ASSISTANT_BUDGET_EXHAUSTED');
        entries.push({ requestId, index, bound: structuredClone(bound) }); await save();
      },
      async settle(requestId, index, usage) {
        const e = entries.find(e => e.requestId === requestId && e.index === index);
        if (poisoned || !e) throw new AssistantError('ASSISTANT_RESERVATION_REQUIRED');
        if (usage) { usageTokens(usage.inputTokens); usageTokens(usage.outputTokens); }
        if (e.usage || e.unknown) { if (!isDeepStrictEqual(e.usage, usage)) throw new AssistantError('ASSISTANT_SETTLEMENT_CHANGED'); return; }
        if (usage) e.usage = structuredClone(usage); else e.unknown = true;
        await save();
      },
    };
    return await action(accounting, totals);
  } finally { await lock.close(); await unlink(lockPath); await syncDir(directory); }
}
