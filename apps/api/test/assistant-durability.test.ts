import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withAssistantJournal } from '../src/assistant-journal.ts';
import { withAssistantBudget, assistantBudgetVersion, remainingAssistantTrialBudget, checkAssistantPermit } from '../src/assistant-budget.ts';
import type { AssistantPermit } from '../src/assistant-budget.ts';
import { createCloudAssistantModel } from '../src/assistant-transport.ts';
import { runAssistant } from '../src/assistant-workflow.ts';
import type { AssistantRequest, AssistantServices } from '../src/assistant-workflow.ts';
import { emptyConversation } from '../../../packages/analyzer/src/assistant-conversation.ts';
import { assistantVersion } from '../../../packages/analyzer/src/assistant-plan.ts';
const id = (n: number) => '60000000-0000-4000-8000-' + String(n).padStart(12, '0');
const scope = { ownerId: 'independent-synthetic-owner', chatId: id(1), generation: id(2), chatEpoch: id(3) };
const request = (): AssistantRequest => ({ requestId: id(4), scope, conversation: emptyConversation(scope), global: { revision: 0, filter: {}, touched: {} },
  dataRevision: '1', question: 'Объясни смысл инфляции', now: new Date('2026-10-16T10:00:00Z'), timezone: 'Asia/Tokyo' });
const bound = { inputTokens: 131072, outputTokens: 1200, modelVersion: 'openai/gpt-oss-120b' };
const usage = { inputTokens: 100, outputTokens: 50, modelVersion: bound.modelVersion };
const plan = { version: assistantVersion, topic: 'general_finance', action: 'explain' };
const price = { version: 'synthetic-test', currency: 'RUB' as const, inputRubPerMillion: '15.86', outputRubPerMillion: '61' };
const permit = (): AssistantPermit => ({ version: assistantBudgetVersion, sourceSha256: 'a'.repeat(64), metadataSha256: 'b'.repeat(64),
  tariffCheckedAt: '2026-10-16T00:00:00Z', tariffSource: 'https://cloud.ru/products/evolution-ai-factory/catalog-foundation-models', price, bound, capAtoms: '10000000000', maximumCalls: 60 });
const now = () => new Date('2026-10-16T12:00:00Z');
const accounting = { async reserve() {}, async settle() {} };

test('a continuation deducts prior settled cost and call count and never clears an unknown hold', () => {
  const entries = [{ requestId: id(4), index: 0, bound, usage }], p = permit();
  const snapshot = (rows: unknown[]) => ({ permit: p, entries: rows, sha256: createHash('sha256').update(JSON.stringify({ permit: p, entries: rows })).digest('hex') });
  const result = remainingAssistantTrialBudget(snapshot(entries));
  assert.equal(result.spentAtoms, '4636000'); assert.equal(result.capAtoms, '9995364000'); assert.equal(result.maximumCalls, 59);
  assert.throws(() => remainingAssistantTrialBudget(snapshot([{ requestId: id(4), index: 0, bound, unknown: true }])), /RECONCILIATION_REQUIRED/);
  assert.throws(() => remainingAssistantTrialBudget({ ...snapshot(entries), sha256: 'f'.repeat(64) }), /PREVIOUS_BUDGET_INVALID/);
  const nextPermit = { ...p, capAtoms: result.capAtoms, maximumCalls: result.maximumCalls, previousBudgetSha256: result.previousBudgetSha256 };
  const next = { permit: nextPermit, entries, sha256: createHash('sha256').update(JSON.stringify({ permit: nextPermit, entries })).digest('hex') };
  const continuation = remainingAssistantTrialBudget(next, result);
  assert.equal(continuation.spentAtoms, '9272000'); assert.equal(continuation.capAtoms, '9990728000'); assert.equal(continuation.maximumCalls, 58);
});
function services() {
  let committed: Parameters<AssistantServices['commit']>[0] | undefined, fail = false;
  const s: AssistantServices = { async guard() { if (committed) throw Error('STATE_CHANGED'); }, async catalog() { throw Error('NO_CATALOG_ALLOWED'); },
    async authorizeQuery() { throw Error('NO_QUERY_ALLOWED'); }, async calculate() { throw Error('NO_CALCULATION_ALLOWED'); }, render() { throw Error(); },
    async commit(input) { if (committed) { assert.deepEqual(input, committed); return; } if (fail) { fail = false; throw Error('SYNTHETIC_COMMIT_CRASH'); } committed = structuredClone(input); } };
  return { s, failNextCommit() { fail = true; }, get committed() { return committed; } };
}
function wire(content: unknown, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ model: bound.modelVersion, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content), tool_calls: [] } }], ...extra }));
}
async function temporary(action: (root: string, requests: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-independent-test-')); await chmod(root, 0o700);
  const requests = join(root, 'requests'); await mkdir(requests, { mode: 0o700 });
  try { await action(root, requests); } finally { await rm(root, { recursive: true, force: true }); }
}

test('HTTP adapter writes sent receipt and reserve BEFORE POST; known usage precedes schema parsing and survives a fresh journal instance', async () => temporary(async (root, directory) => {
  const r = request(), s = services(); let calls = 0;
  const model = createCloudAssistantModel({ apiKey: 'synthetic-key-1234567890123' }, async (url, init) => {
    assert.equal(url, 'https://foundation-models.api.cloud.ru/v1/chat/completions');
    const saved = JSON.parse(await readFile(join(directory, r.requestId + '.json'), 'utf8'));
    assert.equal(saved.receipt.calls.at(-1).state, 'sent');
    const b = JSON.parse(await readFile(join(root, 'budget.json'), 'utf8')); assert.equal(b.entries.length, calls + 1);
    const body = JSON.parse(String(init?.body)); assert.equal(body.response_format.type, 'json_object'); assert.equal(body.max_completion_tokens, 1200);
    assert.equal(JSON.stringify(body).includes('synthetic-key'), false); assert.equal(JSON.stringify(body).includes(scope.chatId), false);
    return wire(calls++ === 0 ? plan : { text: 'Инфляция означает общий рост цен.' });
  });
  let first: unknown;
  await withAssistantBudget(root, permit(), async a => { first = await withAssistantJournal(directory, r, a, j => runAssistant(r, model, j, s.s)); }, now);
  assert.equal(calls, 2); assert.ok(s.committed);
  await withAssistantBudget(root, permit(), async a => { const again = await withAssistantJournal(directory, r, a, j => runAssistant(r, model, j, s.s)); assert.deepEqual(again, first); }, now);
  assert.equal(calls, 2); assert.equal((await stat(join(root, 'budget.json'))).mode & 0o777, 0o600);
}));

test('a crash at commit recovers the exact prepared result and never calls the provider again', async () => temporary(async (_root, directory) => {
  const r = request(), s = services(); s.failNextCommit(); let calls = 0;
  const model = createCloudAssistantModel({ apiKey: 'synthetic-key-1234567890123' }, async () => wire(calls++ === 0 ? plan : { text: 'Синтетическое объяснение.' }));
  await assert.rejects(withAssistantJournal(directory, r, accounting, j => runAssistant(r, model, j, s.s)), /SYNTHETIC_COMMIT_CRASH/);
  const saved = JSON.parse(await readFile(join(directory, r.requestId + '.json'), 'utf8')); assert.equal(saved.receipt.result.status, 'answer'); assert.ok(saved.receipt.conversation);
  const recovered = await withAssistantJournal(directory, r, accounting, j => runAssistant(r, model, j, s.s));
  assert.equal(recovered.status, 'answer'); assert.equal(calls, 2); assert.ok(s.committed);
}));

test('malformed model JSON with valid usage gets one accounted repair; model identity drift gets none', async () => temporary(async (_root, directory) => {
  const r = request(), s = services(); let calls = 0, settlements = 0;
  const a = { ...accounting, async settle(_requestId: string, _index: number, u: unknown) { assert.ok(u); settlements++; } };
  const model = createCloudAssistantModel({ apiKey: 'synthetic-key-1234567890123' }, async () => wire([ '{broken', plan, { text: 'Исправленный ответ.' } ][calls++]));
  const reply = await withAssistantJournal(directory, r, a, j => runAssistant(r, model, j, s.s));
  assert.equal(reply.status, 'answer'); assert.equal(calls, 3); assert.equal(settlements, 3);
  const driftRequest = { ...request(), requestId: id(5) }; calls = 0;
  const drift = createCloudAssistantModel({ apiKey: 'synthetic-key-1234567890123' }, async () => { calls++; return wire(plan, { model: 'another-model' }); });
  const failed = await withAssistantJournal(directory, driftRequest, accounting, j => runAssistant(driftRequest, drift, j, services().s));
  assert.equal(failed.code, 'ASSISTANT_PROVIDER_CHANGED'); assert.equal(calls, 1);
}));

test('unknown HTTP delivery retains its full durable hold, blocks new requests after restart, and does not retry', async () => temporary(async (root, directory) => {
  const r = request(); let calls = 0;
  const model = createCloudAssistantModel({ apiKey: 'synthetic-key-1234567890123' }, async () => { calls++; throw Error('synthetic timeout'); });
  await withAssistantBudget(root, permit(), async (a, totals) => {
    const failed = await withAssistantJournal(directory, r, a, j => runAssistant(r, model, j, services().s));
    assert.equal(failed.code, 'ASSISTANT_DELIVERY_UNKNOWN'); assert.equal(totals().heldAtoms, '2152001920'); assert.equal(totals().blocked, true);
  }, now);
  await withAssistantBudget(root, permit(), async a => {
    await assert.rejects(a.reserve(id(6), 0, bound), /ASSISTANT_RECONCILIATION_REQUIRED/);
    const replay = await withAssistantJournal(directory, r, a, j => runAssistant(r, model, j, services().s)); assert.equal(replay.code, 'ASSISTANT_DELIVERY_UNKNOWN');
  }, now);
  assert.equal(calls, 1);
}));

test('budget cap, total call limit, changed binding and stale tariff block before dispatch; settlement is idempotent', async () => temporary(async (root) => {
  const p = { ...permit(), maximumCalls: 1 };
  await withAssistantBudget(root, p, async a => { await a.reserve(id(4), 0, bound); await a.settle(id(4), 0, usage); await a.settle(id(4), 0, usage); await assert.rejects(a.reserve(id(4), 1, bound), /BUDGET_EXHAUSTED/); }, now);
  await assert.rejects(withAssistantBudget(root, { ...p, sourceSha256: 'c'.repeat(64) }, async () => {}, now), /PERMIT_CHANGED/);
}));

test('cap lower than conservative reservation and expired tariff cannot send any request', async () => temporary(async (root) => {
  await withAssistantBudget(root, { ...permit(), capAtoms: '1000000000' }, async a => { await assert.rejects(a.reserve(id(4), 0, bound), /BUDGET_EXHAUSTED/); }, now);
  const second = join(root, 'second'); await mkdir(second, { mode: 0o700 });
  await withAssistantBudget(second, permit(), async a => { await assert.rejects(a.reserve(id(4), 0, bound), /TARIFF_STALE/); }, () => new Date('2026-10-18T00:00:00Z'));
}));

test('journal refuses legacy directories, permissive files, symlinks, changed requests and concurrent request locks', async () => temporary(async (root, directory) => {
  const r = request(); await writeFile(join(directory, 'old-ledger.jsonl'), 'legacy', { mode: 0o600 });
  await assert.rejects(withAssistantJournal(directory, r, accounting, async () => {}), /NOT_EMPTY/); await rm(join(directory, 'old-ledger.jsonl'));
  await withAssistantJournal(directory, r, accounting, async () => {
    await assert.rejects(withAssistantJournal(directory, r, accounting, async () => {}), /REQUEST_IN_PROGRESS/);
  });
  await assert.rejects(withAssistantJournal(directory, { ...r, question: 'Изменённый запрос' }, accounting, async () => {}), /REQUEST_CHANGED/);
  const path = join(directory, r.requestId + '.json'); await chmod(path, 0o644);
  await assert.rejects(withAssistantJournal(directory, r, accounting, async () => {}), /JOURNAL_INVALID/);
  await rm(path); await writeFile(join(root, 'outside.json'), '{}', { mode: 0o600 }); await symlink(join(root, 'outside.json'), path);
  await assert.rejects(withAssistantJournal(directory, r, accounting, async () => {}));
}));


test('explicit authorization extends cumulative ceilings without resetting old spend, calls, identities or unknown holds', () => {
  const legacy = { ...permit(), version: 'cashneuro-assistant-budget/1' as const };
  const entries = [{ requestId: id(4), index: 0, bound, usage }];
  const snapshot = (p: unknown, rows = entries) => ({ permit: p, entries: rows, sha256: createHash('sha256').update(JSON.stringify({ permit: p, entries: rows })).digest('hex') });
  const old = remainingAssistantTrialBudget(snapshot(legacy));
  const authorization = { capAtoms: '10000000000', maximumCalls: 70 };
  const expanded = { ...permit(), authorization, capAtoms: (BigInt(authorization.capAtoms) - BigInt(old.spentAtoms)).toString(), maximumCalls: 69, previousBudgetSha256: old.previousBudgetSha256 };
  const next = remainingAssistantTrialBudget(snapshot(expanded), old);
  assert.equal(next.calls, 2); assert.equal(next.maximumCalls, 68); assert.equal(next.spentAtoms, '9272000'); assert.equal(next.capAtoms, '9990728000');
  assert.throws(() => remainingAssistantTrialBudget(snapshot({ ...expanded, capAtoms: authorization.capAtoms }), old), /PREVIOUS_BUDGET_INVALID/);
  assert.throws(() => remainingAssistantTrialBudget(snapshot({ ...expanded, maximumCalls: 70 }), old), /PREVIOUS_BUDGET_INVALID/);
  assert.throws(() => checkAssistantPermit({ ...expanded, authorization: undefined }), /PERMIT_INVALID/);
  assert.throws(() => checkAssistantPermit({ ...expanded, version: legacy.version }), /PERMIT_INVALID/);
  assert.throws(() => checkAssistantPermit({ ...expanded, authorization: { ...authorization, capAtoms: '11000000000' } }), /PERMIT_INVALID/);
  assert.throws(() => remainingAssistantTrialBudget(snapshot(legacy, [{ requestId: id(4), index: 0, bound, unknown: true } as any])), /RECONCILIATION_REQUIRED/);
});
