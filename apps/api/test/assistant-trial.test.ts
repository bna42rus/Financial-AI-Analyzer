import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantTrialCases, assistantTrialCalculate, assistantTrialManifest, assistantTrialRequest, assistantTrialServices, scoreAssistantTrial } from '../src/assistant-trial.ts';
import { assistantVersion } from '../../../packages/analyzer/src/assistant-plan.ts';
import { runAssistant, assistantRequestFingerprint } from '../src/assistant-workflow.ts';
import type { AssistantJournal, AssistantModel } from '../src/assistant-workflow.ts';
import type { Conversation } from '../../../packages/analyzer/src/assistant-conversation.ts';

test('all 20 new development smoke expectations have valid independent totals and immutable source coverage', async () => {
  assert.equal(assistantTrialCases.length, 20); assert.equal(new Set(assistantTrialCases.map(c => c.id)).size, 20);
  for (const c of assistantTrialCases) if (c.expected.query) assert.equal(assistantTrialCalculate(c.expected.query, c.noTaxi).totals[c.expected.query.metric], c.expected.totalMinor, c.id);
  const manifest = await assistantTrialManifest();
  for (const name of ['assistant-budget', 'assistant-workflow', 'assistant-journal', 'assistant-transport', 'assistant-trial', 'assistant-trial-main']) assert.ok(manifest.source['apps/api/src/' + name + '.ts']);
  assert.ok(manifest.source['packages/analyzer/src/assistant-plan.ts']); assert.ok(manifest.source['packages/analyzer/src/assistant-conversation.ts']);
  assert.equal(manifest.liveExecuted, false); assert.equal(manifest.runtimeAiEnabled, false);
});

test('the operator evaluator runs the actual workflow, retains parents, and detects wrong filter fields even when totals coincide', async () => {
  const states = new Map<string, Conversation>();
  const plans = [
    { context: { mode: 'new' }, changes: [{ field: 'metric', op: 'set', value: 'expenses' }, { field: 'period', op: 'set', value: 'сентябрь 2026' }, { field: 'categories', op: 'set', value: { names: ['Продукты'] } }] },
    { context: { mode: 'continue' }, changes: [{ field: 'grouping', op: 'set', value: 'category' }] },
  ];
  for (let i = 0; i < 2; i++) {
    const c = assistantTrialCases[i]!, r = assistantTrialRequest(c, i, states.get(c.scenario));
    const journal: AssistantJournal = { receipt: { fingerprint: assistantRequestFingerprint(r), calls: [] }, async persist() {}, async reserve() {}, async settle() {} };
    const model: AssistantModel = { bound: { modelVersion: 'synthetic', inputTokens: 131072, outputTokens: 1200 }, async complete(_input, before) { await before(); return { value: { version: assistantVersion, topic: 'personal_finance', action: 'read', ...plans[i] }, usage: { inputTokens: 100, outputTokens: 50, modelVersion: 'synthetic' } }; } };
    const result = await runAssistant(r, model, journal, assistantTrialServices(r, c, state => states.set(c.scenario, state)));
    assert.equal(scoreAssistantTrial(c, result, states.get(c.scenario)!).passed, true);
    const wrong = { ...result, query: { ...result.query!, filter: { ...result.query!.filter, through: '2026-09-29' } } };
    assert.ok(scoreAssistantTrial(c, wrong, states.get(c.scenario)!).failures.includes('query'));
  }
});
