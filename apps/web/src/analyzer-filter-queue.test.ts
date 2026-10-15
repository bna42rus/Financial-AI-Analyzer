import { test, expect } from 'vitest';
import { AnalyzerFilterQueue } from './analyzer-filter-queue';
import type { GlobalSnapshot } from '../../../packages/analyzer/src/task-context';

test('manual A -> B -> A and same-value reset survive navigation and one ACK', async () => {
  const queue = new AnalyzerFilterQueue(), sent: Record<string, unknown>[] = [];
  queue.touch({}, { from: '2026-09-01' }); queue.touch({ from: '2026-09-01' }, {});
  queue.touch({}, {}, ['categories']);
  const send = async (body: Record<string, unknown>) => { sent.push(body); return { revision: body.change ? 8 : 7, filter: {}, touched: {} } as GlobalSnapshot; };
  expect(await queue.synchronize('generation', {}, send)).toBe(8);
  expect(sent[1]!.change).toMatchObject({ revision: 7, filter: {}, touched: ['period', 'categories'] });
  sent.length = 0; await queue.synchronize('generation', {}, send);
  expect(sent[0]!.change).toMatchObject({ revision: 8, touched: [] });
});
test('lost ACK retries the exact write ID and payload; concurrent edits stay pending', async () => {
  const queue = new AnalyzerFilterQueue(), sent: Record<string, unknown>[] = [];
  let fail = true;
  const send = async (body: Record<string, unknown>) => {
    sent.push(structuredClone(body));
    if (!body.change) return { revision: 0, filter: {}, touched: {} } as GlobalSnapshot;
    if (fail) { fail = false; throw Object.assign(new Error('network'), { code: 'NETWORK_ERROR' }); }
    return { revision: sent.length, filter: {}, touched: {} } as GlobalSnapshot;
  };
  await expect(queue.synchronize('g', {}, send)).rejects.toThrow('network');
  queue.touch({}, {}, ['accounts']);
  await expect(queue.synchronize('g', {}, send)).rejects.toThrow('Фильтры изменились');
  expect(sent[2]).toEqual(sent[1]);
  await queue.synchronize('g', {}, send);
  expect(sent[3]!.change).toMatchObject({ touched: ['accounts'] });
});
test('cross-tab CAS conflict is surfaced; a new explicit send rereads the server revision', async () => {
  const queue = new AnalyzerFilterQueue(), sent: Record<string, unknown>[] = [];
  let conflict = true;
  const send = async (body: Record<string, unknown>) => {
    sent.push(body);
    if (!body.change) return { revision: conflict ? 4 : 5, filter: {}, touched: {} } as GlobalSnapshot;
    if (conflict) { conflict = false; throw Object.assign(new Error('changed'), { code: 'AI_CONTEXT_CHANGED' }); }
    return { revision: 6, filter: {}, touched: {} } as GlobalSnapshot;
  };
  await expect(queue.synchronize('g', {}, send)).rejects.toThrow('changed');
  expect(sent).toHaveLength(2);
  await queue.synchronize('g', {}, send);
  expect(sent[3]!.change).toMatchObject({ revision: 5 });
});
