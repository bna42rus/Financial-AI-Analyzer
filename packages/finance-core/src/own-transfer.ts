import {ownTransferEvidence} from '../../imports/src/counterparty-evidence.ts';
import {facet} from './model.ts';
import type {Operation} from './model.ts';
export const ownTransferRule='cashneuro-own-account/1';
const protectedFacet=(v:{source:string;userVerified:boolean})=>v.userVerified||['user','personal_rule','global_rule','ai'].includes(v.source);
export function applyOwnTransfer(operation:Operation):Operation{
 if(operation.decomposition||protectedFacet(operation.semantics.kind)||protectedFacet(operation.semantics.role)||!['other','transfer_in','transfer_out','own_transfer'].includes(operation.semantics.kind.value))return operation;
 if(operation.source.versions.sourceSanitizer!=='bank-source/5'||operation.source.versions.sourceTextEvidence!=='intact')return operation;
 if(!operation.bankOwnAccountId&&!ownTransferEvidence(operation.source.description))return operation;
 const next=structuredClone(operation);
 next.semantics.kind={...facet('own_transfer' as const),ruleId:ownTransferRule};next.semantics.role={...facet('neutral' as const),ruleId:ownTransferRule};
 for(const key of ['category','subcategory'] as const)if(!protectedFacet(next.semantics[key]))next.semantics[key]=facet(null);
 return next;
}
