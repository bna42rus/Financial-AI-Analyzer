import type { OperationsFilter } from '../../../packages/finance-core/src/operations';
import type { Condition, GlobalSnapshot } from '../../../packages/analyzer/src/task-context';
import { conditionFields, globalSnapshot } from '../../../packages/analyzer/src/task-context';

/** Lives in ServerFinance, not the Analyzer tab. A -> B -> A while the tab is
 * unmounted still carries a manual-touch event. ACK removes only its prefix. */
export class AnalyzerFilterQueue {
  private seq = 0;
  private events: { seq: number; fields: Condition[] }[] = [];
  private revision: number | null = null;
  private change: { id: string; revision: number; filter: OperationsFilter; touched: Condition[]; seq: number } | null = null;
  touch(before: OperationsFilter, after: OperationsFilter, explicit: Condition[] = []) {
    const normalize = (v: unknown) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v ?? null);
    const fields = (Object.keys(conditionFields) as Condition[]).filter(f => explicit.includes(f) || conditionFields[f].some(k => normalize(before[k]) !== normalize(after[k])));
    if (fields.length || normalize(before.operationIds) !== normalize(after.operationIds)) this.events.push({ seq: ++this.seq, fields });
  }
  async synchronize(generation: string, filter: OperationsFilter, send: (body: Record<string, unknown>) => Promise<GlobalSnapshot>): Promise<number> {
    if (this.revision === null) this.revision = globalSnapshot(await send({ generation })).revision;
    // Keep the exact write ID/body after a network error; no second stamp/cost.
    this.change ??= { id: crypto.randomUUID(), revision: this.revision, filter: structuredClone(filter), touched: [...new Set(this.events.flatMap(e => e.fields))], seq: this.seq };
    const change = this.change, { seq, ...body } = change;
    let response: GlobalSnapshot;
    try { response = await send({ generation, change: body }); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (code !== 'NETWORK_ERROR') this.change = null;
      if (code === 'AI_CONTEXT_CHANGED') this.revision = null;
      throw error; // No automatic overwrite after a cross-tab CAS conflict.
    }
    // An unverified ACK is like a lost network reply: retain the exact write.
    response = globalSnapshot(response);
    this.revision = response.revision; this.events = this.events.filter(e => e.seq > seq); this.change = null;
    if (this.seq !== seq || JSON.stringify(change.filter) !== JSON.stringify(filter)) throw new Error('Фильтры изменились во время подготовки. Отправьте вопрос ещё раз.');
    return response.revision;
  }
  reset() { this.seq = 0; this.events = []; this.revision = null; this.change = null; }
}
