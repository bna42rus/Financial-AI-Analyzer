import type {PoolClient} from 'pg';
import type {BankFact} from '../../../packages/finance-core/src/model.ts';
import {sourceFields} from '../../../packages/imports/src/safe-source.ts';
import type {SafeSource} from '../../../packages/imports/src/safe-source.ts';

/** Rebuild inherited text only from observations that still exist. A materialized
 * snapshot must never preserve merchant evidence from a cancelled source. */
export async function sourceEvidence(db:PoolClient,userId:string){
 return (await db.query<{id:string;transaction_id:string;evidence_recorded:boolean;source_evidence:SafeSource|null;source_kind:NonNullable<BankFact['sourceKind']>;merchant_text:string;description:string}>(`SELECT o.id,finance.canonical_operation(o.user_id,o.transaction_id) AS transaction_id,r.evidence_recorded,r.source_evidence,o.source_kind,o.merchant_text,o.description
 FROM finance.source_observation o LEFT JOIN finance.ingestion_row r ON (r.user_id,r.id)=(o.user_id,o.import_row_id)
 WHERE o.user_id=$1 ORDER BY o.observed_at,o.id`,[userId])).rows;
}
export function resolveSourceText(fact:BankFact,transactionId:string,selectedId:string,rows:Awaited<ReturnType<typeof sourceEvidence>>):BankFact{
 const own=rows.filter(r=>r.transaction_id===transactionId),selected=own.find(r=>r.id===selectedId);
 if(!selected?.evidence_recorded)return fact;
 let text=sourceFields(null),detailed=false;
 for(const row of own){
  if(!row.evidence_recorded){detailed=false;text={sourceKind:row.source_kind,merchantText:row.merchant_text,description:row.description};}
  else if(row.source_evidence){const next=sourceFields(row.source_evidence);if(detailed&&!row.source_evidence.details&&text.sourceKind===next.sourceKind){next.description=text.description;next.bankCategory=text.bankCategory;next.sourceMcc=text.sourceMcc;}else detailed=!!row.source_evidence.details;if(text.sourceKind===next.sourceKind){if(!next.merchantText)next.merchantText=text.merchantText;if(!next.bankCategory)next.bankCategory=text.bankCategory;if(!next.sourceMcc)next.sourceMcc=text.sourceMcc;}text=next;}
  if(row.id===selectedId)break;
 }
 return {...fact,...text,versions:{...fact.versions,...(detailed?{sourceSanitizer:'bank-source/4'}:{})}};
}
