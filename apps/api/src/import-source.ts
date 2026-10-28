import type {PoolClient} from 'pg';
import type {BankFact} from '../../../packages/finance-core/src/model.ts';
import {bankDescription,merchantBankDescription,cleanBankText} from '../../../packages/imports/src/bank-description.ts';
import {sourceFields,hasBankDescription,merchantSourceSanitizer,descriptionSourceSanitizer} from '../../../packages/imports/src/safe-source.ts';
import type {SafeSource} from '../../../packages/imports/src/safe-source.ts';

/** Rebuild inherited text only from observations that still exist. A materialized
 * snapshot must never preserve merchant evidence from a cancelled source. */
export async function sourceEvidence(db:PoolClient,userId:string){
 return (await db.query<{id:string;transaction_id:string;evidence_recorded:boolean;source_evidence:SafeSource|null;source_kind:NonNullable<BankFact['sourceKind']>;merchant_text:string;description:string;source_profile?:string}>(`SELECT o.id,finance.canonical_operation(o.user_id,o.transaction_id) AS transaction_id,r.evidence_recorded,r.source_evidence,o.source_kind,o.merchant_text,o.description,o.versions->>'sanitizer' AS source_profile
 FROM finance.source_observation o LEFT JOIN finance.ingestion_row r ON (r.user_id,r.id)=(o.user_id,o.import_row_id)
 WHERE o.user_id=$1 ORDER BY o.observed_at,o.id`,[userId])).rows;
}
export function resolveSourceText(fact:BankFact,transactionId:string,selectedId:string,rows:Awaited<ReturnType<typeof sourceEvidence>>):BankFact{
 const own=rows.filter(r=>r.transaction_id===transactionId),selected=own.find(r=>r.id===selectedId);
 const clean=(source:BankFact):BankFact=>hasBankDescription(source.versions.sourceSanitizer)?{...source,description:cleanBankText(source.description),merchantText:cleanBankText(source.merchantText,160),bankCategory:cleanBankText(source.bankCategory,160)}:source;
 if(!selected?.evidence_recorded)return clean(fact);
 let text=sourceFields(null),detailed:string|null=null,textEvidence:string|undefined;
 for(const row of own){
  if(!row.evidence_recorded){detailed=null;textEvidence=undefined;text={sourceKind:row.source_kind,merchantText:row.merchant_text,description:row.description};}
  else if(row.source_evidence){
   const profile=row.source_profile??descriptionSourceSanitizer,details=row.source_evidence.details;
   const safe=details?{...row.source_evidence,details:profile===merchantSourceSanitizer?{...merchantBankDescription(details.description,details.merchantText,details.bankCategory,details.mcc),textEvidence:'textEvidence' in details?details.textEvidence:'unknown'}:bankDescription(details.description,details.merchantText,details.bankCategory,details.mcc)}:row.source_evidence;
   const next=sourceFields(safe,profile);
   if(detailed&&!details&&text.sourceKind===next.sourceKind){
    if(detailed===merchantSourceSanitizer)next.merchantText=text.merchantText;
    next.description=text.description;next.bankCategory=text.bankCategory;next.sourceMcc=text.sourceMcc;
   }else{detailed=details?(profile===merchantSourceSanitizer?merchantSourceSanitizer:descriptionSourceSanitizer):null;textEvidence=details&&'textEvidence' in details?details.textEvidence:undefined;}
   if(text.sourceKind===next.sourceKind){if(!next.merchantText)next.merchantText=text.merchantText;if(!next.bankCategory)next.bankCategory=text.bankCategory;if(!next.sourceMcc)next.sourceMcc=text.sourceMcc;}
   text=next;
  }
  if(row.id===selectedId)break;
 }
 const versions={...fact.versions};delete versions.sourceTextEvidence;
 if(detailed)versions.sourceSanitizer=detailed;
 else if(selected.source_profile)versions.sourceSanitizer=selected.source_profile;
 if(detailed===merchantSourceSanitizer)versions.sourceTextEvidence=textEvidence??'unknown';
 return clean({...fact,...text,versions});
}
