import { benchmarkDigest } from './benchmark-ledger.ts';
import { BenchmarkFailure, candidates } from './benchmark-transport.ts';
import { trialRequestId } from './task-trial.ts';
import type { TrialCorpus } from './task-trial.ts';
import type { PilotJournal } from './task-pilot-journal.ts';
import { parseTaskRelevance, taskRelevanceSchema, taskProposalSchema } from '../../../packages/analyzer/src/task-protocol.ts';
import { auditTaskWireSchema, projectTaskWireSchema, taskWireProfile } from './task-provider-schema.ts';

/** Read-only checkpoint of a stopped, frozen run. No transport or credential
 * argument exists. Existing unknown receipts remain unknown, fully held. */
export async function inspectTaskPilot(journal: PilotJournal, corpus: TrialCorpus, bindingSha256: string) {
  if (!journal.readOnly || journal.frozen.bindingSha256 !== bindingSha256) throw new BenchmarkFailure('TASK_PILOT_INSPECTION_READ_ONLY_REQUIRED');
  const state = journal.verify(), slots = [...corpus.singles, ...corpus.dialogs.flatMap(d => d.turns)].map(turn => ({ turn, occurrence: 0 }));
  for (const repeat of corpus.repetitions) for (let occurrence = 1; occurrence <= repeat.additionalIndependentCopies; occurrence++) slots.push({ turn: corpus.singles.find(t => t.id === repeat.caseId)!, occurrence });
  const records = [];
  for (const { turn, occurrence } of slots) for (const phase of ['gate', 'plan'] as const) {
    const id = trialRequestId(bindingSha256, turn.id, phase, occurrence), record = journal.ledger.records.get(id);
    if (!record) continue;
    const receipt = record.receipt, value = receipt?.value as { wireSha256?: unknown } | null;
    const wireSha256 = typeof value?.wireSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.wireSha256) ? value.wireSha256 : null;
    let cacheStatus = 'not_available', relevance: string | null = null;
    if (receipt?.usage && receipt.code === null && wireSha256) {
      try { const cached = await journal.cached(id, wireSha256); cacheStatus = cached.code ?? 'verified'; if (phase === 'gate' && !cached.code) relevance = parseTaskRelevance(cached.payload).relevance; }
      catch { cacheStatus = 'invalid_or_missing'; }
    }
    records.push({ id, caseId: turn.id, occurrence, phase, wireSha256, error: typeof receipt?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(receipt.code) ? receipt.code : receipt?.code === null ? null : 'RECEIPT_UNAVAILABLE',
      usage: receipt?.usage ? { inputTokens: receipt.usage.inputTokens, outputTokens: receipt.usage.outputTokens, modelVersion: receipt.usage.modelVersion === candidates['cloud-oss'].model ? candidates['cloud-oss'].model : 'MODEL_DRIFT' } : null,
      heldAtoms: receipt?.usage ? '0' : record.reserve.atoms, cacheStatus, relevance });
  }
  if (records.length !== state.calls) throw new BenchmarkFailure('TASK_PILOT_INSPECTION_INCOMPLETE');
  const checkpoint = { bindingSha256, ledgerHeadSha256: journal.ledger.previous, frozenSha256: benchmarkDigest(journal.frozen), baselineRecordsSha256: journal.frozen.baselineRecordsSha256, records };
  return { inspection: 'cashneuro-pilot-format-checkpoint/1', ...checkpoint, checkpointSha256: benchmarkDigest(checkpoint),
    paidCalls: 0, httpCalls: 0, ledgerModified: false, recordsModified: false, holdsReleased: false, blocked: state.cost.blocked,
    incrementalUpperAtoms: state.incrementalUpperAtoms, originalIncrementalCapAtoms: journal.frozen.incrementalCapAtoms,
    remainingIncrementalHeadroomAtoms: (BigInt(journal.frozen.incrementalCapAtoms) - BigInt(state.incrementalUpperAtoms)).toString(),
    schemaAudit: { gate: auditTaskWireSchema(taskRelevanceSchema), plan: auditTaskWireSchema(taskProposalSchema),
      preparedProfile: taskWireProfile, preparedPlanIssues: auditTaskWireSchema(projectTaskWireSchema(taskProposalSchema)),
      localAuthoritativeSchemaUnchanged: true, appliedToFrozenPilot: false, providerDecoderVersionVerified: false, provider400CauseConfirmed: false, originalProviderErrorRecoverable: false },
    modelAccepted: false, runtimeAiEnabled: false };
}
