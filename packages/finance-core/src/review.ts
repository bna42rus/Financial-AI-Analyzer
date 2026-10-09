import type {Semantics} from './model.ts';
export type ReviewStatus='none'|'recommended'|'required'|'verified';
/** Process labels never erase reasons or grant verification to unrelated facets. */
export function reviewStatus(reasons:string[],semantics:Semantics):ReviewStatus {
 if(reasons.some(r=>!['low_kind_confidence','low_role_confidence','low_category_confidence'].includes(r)))return 'required';
 if(reasons.length)return 'recommended';
 return [semantics.kind,semantics.role,semantics.category,semantics.subcategory].some(f=>f.userVerified)?'verified':'none';
}
