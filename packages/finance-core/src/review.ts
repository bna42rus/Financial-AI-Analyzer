import type {Semantics} from './model.ts';
export type ReviewStatus='none'|'recommended'|'required'|'verified';
/** Process labels never erase reasons or grant verification to unrelated facets. */
export function reviewStatus(reasons:string[],semantics:Semantics):ReviewStatus {
 if(reasons.some(r=>!['low_kind_confidence','low_role_confidence','low_category_confidence'].includes(r)))return 'required';
 if(reasons.length)return 'recommended';
 return [semantics.kind,semantics.role,semantics.category,semantics.subcategory].some(f=>f.userVerified)?'verified':'none';
}

export function reviewReasonsAfterEdit(reasons:string[],patch:object&{reviewRequested?:boolean}):string[]{
 const cleared=new Set<string>();
 if('kind'in patch)cleared.add('low_kind_confidence');
 if('role'in patch)for(const reason of ['low_role_confidence','unresolved_role','unresolved_transfer'])cleared.add(reason);
 if('categoryId'in patch||'subcategoryId'in patch)cleared.add('low_category_confidence');
 if('reviewRequested'in patch)cleared.add('user_requested_review');
 return [...reasons.filter(reason=>!cleared.has(reason)),...(patch.reviewRequested===true?['user_requested_review']:[])];
}
