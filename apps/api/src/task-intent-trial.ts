import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { taskIntentVersion, taskIntentPrompt, taskIntentSchema } from '../../../packages/analyzer/src/task-intent.ts';
import { benchmarkDigest, BenchmarkLedger } from './benchmark-ledger.ts';
import { BenchmarkFailure } from './benchmark-transport.ts';
import { taskTrialManifest } from './task-trial.ts';
import { readPilotJson } from './task-pilot-journal.ts';
import { jsonTrialAdmission } from './task-json-trial.ts';
import { intentWireVersion } from './task-intent-transport.ts';
import { pilotTariff } from './task-pilot-runner.ts';

export const intentTrialBaseline = { records: 665, ledgerHead: '5d5271f31c34cf41ac47712fff2718f666c85744b9df11618010968c7d4d05fb',
  spentAtoms: '22627111860', heldAtoms: '11820804480', originalBaselineUpperAtoms: '20888941260', incrementalCapAtoms: '20000000000',
  remainingAtoms: '6441024920', oldFrozenSha256: 'e3a80d6cc2696b376e043fee6ccf318481796be0c2ee0246168453165e945379',
  oldBindingSha256: '852762c202aa874604736a9406ccf134e8de90fe7485aadc15972eb5e77a362b' };
export const intentAdmission = { ...jsonTrialAdmission };
export async function assertIntentTrialStart(ledger: BenchmarkLedger, directory: string) {
  const baseline = intentTrialBaseline;
  if (ledger.records.size !== baseline.records || ledger.previous !== baseline.ledgerHead) throw new BenchmarkFailure('TASK_INTENT_BASELINE_CHANGED');
  const totals = ledger.totalsWithHeldHttp400s(intentAdmission.retainedHttp400s);
  if (totals.spent !== BigInt(baseline.spentAtoms) || totals.held !== BigInt(baseline.heldAtoms) || totals.blocked)
    throw new BenchmarkFailure('TASK_INTENT_BASELINE_CHANGED');
  const old = await readPilotJson(join(directory, 'task-json-trial-v1.json')) as { hash: string; payload: { bindingSha256: string } };
  if (old.hash !== benchmarkDigest(old.payload) || old.hash !== baseline.oldFrozenSha256 || old.payload.bindingSha256 !== baseline.oldBindingSha256)
    throw new BenchmarkFailure('TASK_INTENT_PRIOR_ARTIFACT_CHANGED');
}
export async function intentTrialBinding() {
  const manifest = await taskTrialManifest(), source: Record<string, string> = {};
  if (manifest.corpusSha256 !== '8b7f4890d9cc172c37856be9e0bea53a455a07dcc33a76829bb2a834e19e213f') throw new BenchmarkFailure('TASK_INTENT_CORPUS_CHANGED');
  for (const path of ['task-intent-trial.ts', 'task-intent-trial-main.ts', 'task-intent-transport.ts', 'analyzer-intent-model.ts', 'task-pilot-runner.ts', 'task-prepared-contract.ts'])
    source[path] = benchmarkDigest(await readFile(new URL('./' + path, import.meta.url), 'utf8'));
  const binding = { version: 'cashneuro-task-intent-trial/1', protocol: taskIntentVersion, wireVersion: intentWireVersion,
    checkedOn: pilotTariff.checkedOn, manifest, source, baseline: intentTrialBaseline, admission: intentAdmission, tariff: pilotTariff,
    promptsSha256: benchmarkDigest({ prompt: taskIntentPrompt, schema: taskIntentSchema }),
    extraction: 'One paid extraction before finance access; local compiler owns task binding and omission=preserve. No model task book, catalog, filters, IDs or old totals.',
    requestIdentity: 'Original trial ID formula with a new frozen binding; gate is the single intent phase, plan is local only.',
    maximumTurns: 120, maximumNewModelCalls: 120, independentRepeatTurns: 24, holdoutTurns: 28,
    admissionScope: 'Operator --live only, original 20 RUB cumulative incremental and 45 RUB global caps; full-context reserve unchanged. Budget exhaustion may stop before 120 turns.',
    modelAccepted: false, immutableModelVersionVerified: false, runtimeAiEnabled: false };
  return { binding, sha256: benchmarkDigest(binding) };
}
