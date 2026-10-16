import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { factorPromptSchema, expandPromptSchema, preparedTaskRequestBody, preparedTaskExamples, preparedTaskProfile } from '../src/task-prepared-contract.ts';
import { taskJsonRequestBody } from '../src/task-json-transport.ts';
import { schemaProbeRequest } from '../src/task-schema-probe.ts';
import { taskProposalPrompt, taskRelevancePrompt, taskProposalSchema, taskRelevanceSchema, parseTaskProposalWire, taskCapabilities } from '../../../packages/analyzer/src/task-protocol.ts';
import { assertClosedSchema } from '../../../packages/analyzer/src/closed-schema.ts';

const bound = { inputTokens: 131072, outputTokens: 1200, modelVersion: 'openai/gpt-oss-120b' };

test('factoring both prompt schemas restores every original constraint and keeps properties maps out of reference positions', async () => {
  for (const original of [taskRelevanceSchema, taskProposalSchema]) {
    const compact = factorPromptSchema(original), expanded = expandPromptSchema(compact);
    assert.deepEqual(expanded, original);
    const walk = (v: any) => { if (!v || typeof v !== 'object') return; if (v.properties) { assert.equal('$ref' in v.properties, false); Object.values(v.properties).forEach(walk); }
      if (v.items) walk(v.items); if (v.anyOf) v.anyOf.forEach(walk); };
    walk(compact); Object.values(compact.$defs as object).forEach(walk);
  }
  const raw = JSON.parse(await readFile(new URL('./fixtures/task-json-observed-20261015.json', import.meta.url), 'utf8'));
  for (const row of raw.records.filter((r: any) => r.value?.status)) assert.doesNotThrow(() => assertClosedSchema(row.value, expandPromptSchema(factorPromptSchema(taskProposalSchema))));
});

test('the prepared request removes duplicated capabilities but preserves model, output bound, JSON mode and authoritative schema', async () => {
  const request = await schemaProbeRequest(), wire = preparedTaskRequestBody('cloud-oss', bound, taskProposalPrompt, request.input, taskProposalSchema), parsed = JSON.parse(wire);
  assert.deepEqual(parsed.response_format, { type: 'json_object' }); assert.equal(parsed.max_completion_tokens, 1200); assert.equal(parsed.model, bound.modelVersion);
  const input = JSON.parse(parsed.messages[1].content); assert.equal('capabilities' in input, false); assert.equal('global' in input, false); assert.equal('expected' in input, false);
  assert.deepEqual(input.tasks, []); assert.equal(input.question, request.turn.question);
  assert.ok(Buffer.byteLength(wire) < Buffer.byteLength(taskJsonRequestBody('cloud-oss', bound, taskProposalPrompt, request.input, taskProposalSchema)));
  const gate = JSON.parse(preparedTaskRequestBody('cloud-oss', bound, taskRelevancePrompt, { question: 'Сколько стоят услуги?', hasFinancialTasks: false, capabilities: taskCapabilities }, taskRelevanceSchema));
  assert.deepEqual(JSON.parse(gate.messages[1].content), { question: 'Сколько стоят услуги?', hasFinancialTasks: false });
});

test('generic shape examples pass the original closed parser while duplicate names, extra keys and fabricated quotes still fail', () => {
  for (const sample of preparedTaskExamples) assert.doesNotThrow(() => parseTaskProposalWire(sample.answer, sample.question));
  const first = preparedTaskExamples[0]!;
  for (const bad of [{ ...first.answer, foreign: true }, { ...first.answer, metric: { op: 'set', value: 'income', quote: 'not in question' } },
    { ...first.answer, edits: [{ field: 'categories', op: 'set', value: { names: ['траты', 'траты'] }, quote: 'траты' }] }]) assert.throws(() => parseTaskProposalWire(bad, first.question));
});

test('the prepared contract has no paid admission and rejects wrong phase/schema/model and injected input fields', async () => {
  assert.equal(preparedTaskProfile.paidDispatchEnabled, false); assert.equal(preparedTaskProfile.modelAccepted, false); assert.equal(preparedTaskProfile.runtimeAiEnabled, false);
  const r = await schemaProbeRequest();
  assert.throws(() => preparedTaskRequestBody('cloud-oss', bound, taskProposalPrompt, { ...r.input as object, expected: {} }, taskProposalSchema));
  assert.throws(() => preparedTaskRequestBody('cloud-oss', bound, taskProposalPrompt, { ...r.input as object, tasks: [{ handle: 't1', taskHandle: 't1', parentHandle: null, metric: 'expenses', grouping: 'none', comparison: 'none', totalMinor: 'private' }] }, taskProposalSchema));
  assert.throws(() => preparedTaskRequestBody('cloud-oss', bound, taskProposalPrompt, r.input, {}), /CONTRACT_INVALID/);
  assert.throws(() => preparedTaskRequestBody('cloud-oss', { ...bound, modelVersion: 'other' }, taskProposalPrompt, r.input, taskProposalSchema), /CONTRACT_INVALID/);
  assert.throws(() => expandPromptSchema({ $ref: 'https://example.invalid/schema', $defs: {} }), /SCHEMA_INVALID/);
});
