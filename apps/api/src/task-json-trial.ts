import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { benchmarkDigest, BenchmarkLedger } from './benchmark-ledger.ts';
import { BenchmarkFailure } from './benchmark-transport.ts';
import { object } from '../../../packages/finance-core/src/model.ts';
import { taskTrialManifest } from './task-trial.ts';
import { readPilotJson } from './task-pilot-journal.ts';
import { schemaProbeCheckpoint, verifySchemaProbeCheckpoint } from './task-schema-probe.ts';
import { taskRelevancePrompt, taskProposalPrompt, taskRelevanceSchema, taskProposalSchema } from '../../../packages/analyzer/src/task-protocol.ts';
import { jsonWireVersion, cloudApiSpecification, jsonSystemPrompt } from './task-json-transport.ts';
import { pilotTariff } from './task-pilot-runner.ts';

export const priorSchemaProbe = { id: '35a00c586c7cf8b13b5c8aaf198fde7abad80d605886ee7e39ff7995da71bba4',
  bindingSha256: 'b1068b151b89dc861b630430500cb162ec0259addc6e0ca03f94a333922a53ef',
  wireSha256: '5978cbddbbe4207dfa89adce37ce73b2e98be5364a6cc04dfefbba0b7ead3016' };
export const jsonTrialAdmission = { retainedHttp400s: [schemaProbeCheckpoint.rejectionId, priorSchemaProbe.id], budgetBaselineUpperAtoms: '20888941260', incrementalCapAtoms: '20000000000' };
export const reusedFinancialGate = { turnId: 'single-01', value: { relevance: 'financial' } };
export async function assertJsonTrialStart(ledger: BenchmarkLedger, directory: string) {
  await verifySchemaProbeCheckpoint(ledger, directory, { id: priorSchemaProbe.id });
  const wrapper = object(await readPilotJson(join(directory, 'task-schema-probe-v1.json')), ['hash', 'payload']);
  if (wrapper.hash !== benchmarkDigest(wrapper.payload)) throw new BenchmarkFailure('TASK_JSON_BASELINE_CHANGED');
  const frozen = object(wrapper.payload, ['binding', 'bindingSha256', 'id']), receipt = ledger.records.get(priorSchemaProbe.id)?.receipt;
  const value = receipt?.value as { bindingSha256?: unknown; wireSha256?: unknown } | null;
  const cost = ledger.totals();
  if (frozen.bindingSha256 !== priorSchemaProbe.bindingSha256 || benchmarkDigest(frozen.binding) !== priorSchemaProbe.bindingSha256 || frozen.id !== priorSchemaProbe.id ||
      receipt?.code !== 'BENCH_PROVIDER_FAILURE_HTTP_400' || receipt.usage !== null || value?.bindingSha256 !== priorSchemaProbe.bindingSha256 || value.wireSha256 !== priorSchemaProbe.wireSha256 ||
      ledger.records.size !== 495 || cost.spent !== 13389232820n || cost.held !== 11820804480n || ledger.totalsWithHeldHttp400s(jsonTrialAdmission.retainedHttp400s).blocked) throw new BenchmarkFailure('TASK_JSON_BASELINE_CHANGED');
}
export async function jsonTrialBinding() {
  const manifest = await taskTrialManifest(), source: Record<string, string> = {};
  if (manifest.corpusSha256 !== '8b7f4890d9cc172c37856be9e0bea53a455a07dcc33a76829bb2a834e19e213f' || manifest.promptsSha256 !== 'e2465ece6e41faf4cb7277c4b667ef6b1ce544e705412a23dabc1c11f3c347e8') throw new BenchmarkFailure('TASK_JSON_CONTRACT_CHANGED');
  for (const path of ['task-json-trial.ts', 'task-json-trial-main.ts', 'task-json-transport.ts', 'task-schema-probe.ts', 'task-schema-probe-transport.ts', 'task-provider-schema.ts']) source[path] = benchmarkDigest(await readFile(new URL('./' + path, import.meta.url), 'utf8'));
  const binding = { version: 'cashneuro-task-json-trial/1', wireVersion: jsonWireVersion, cloudApiSpecification, checkedOn: '2026-10-15', manifest, extraSource: source,
    wirePromptsSha256: benchmarkDigest({ gate: jsonSystemPrompt(taskRelevancePrompt, taskRelevanceSchema), plan: jsonSystemPrompt(taskProposalPrompt, taskProposalSchema) }),
    originalCheckpoint: schemaProbeCheckpoint, priorSchemaProbe, admission: jsonTrialAdmission, tariff: pilotTariff,
    reusedGate: { ...reusedFinancialGate, sourceReceiptId: schemaProbeCheckpoint.gateId, sourceWireSha256: schemaProbeCheckpoint.gateWireSha256, previousWireMode: 'json_schema', independentRepeat: false },
    maximumTurns: 120, maximumNewModelCalls: 239, modelAccepted: false, immutableModelVersionVerified: false, runtimeAiEnabled: false };
  return { binding, sha256: benchmarkDigest(binding) };
}
