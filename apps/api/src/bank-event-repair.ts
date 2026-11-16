import type {Graph,Operation} from '../../../packages/finance-core/src/model.ts';
import type {Rule} from '../../../packages/finance-core/src/rules.ts';
import {applyRules} from '../../../packages/finance-core/src/rules.ts';
import {refreshBankSemantics,applyFinancialRecognition} from '../../../packages/finance-core/src/financial-evidence.ts';
import {applyMerchantRecognition} from '../../../packages/finance-core/src/merchant-recognition.ts';
import {isDeepStrictEqual} from 'node:util';

/** Once per workspace after deployment; corrections, source facts, links,
 * components and user/rule decisions are retained. No model or network calls. */
export function bankEventRepairs(graph:Graph,rules:Rule[]):Operation[]{
 return graph.operations.flatMap(op=>{
  if(op.source.versions.sourceSanitizer!=='bank-source/5'||op.source.versions.sourceTextEvidence!=='intact'||op.decomposition||graph.components.some(c=>c.transactionId===op.id))return [];
  const account=graph.accounts.find(a=>a.id===(op.corrections.accountId??op.accountAssignmentId??op.source.accountId));if(!account)return [];
  const initialized={...op,semantics:refreshBankSemantics(op.semantics,op.source)};
  const next=applyMerchantRecognition(applyFinancialRecognition(applyRules(initialized,account,rules,undefined,graph.categories),graph.categories),graph.categories,graph.categoryBindings);
  return isDeepStrictEqual(op.semantics,next.semantics)&&isDeepStrictEqual(op.reviewReasons,next.reviewReasons)?[]:[next];
 });
}
