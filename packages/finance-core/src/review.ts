import type {Semantics} from './model.ts';
export type ReviewStatus='none'|'recommended'|'required'|'verified';
/** Process labels never erase reasons or grant verification to unrelated facets. */
export function reviewStatus(reasons:string[],semantics:Semantics):ReviewStatus {
 if(reasons.some(r=>!['low_kind_confidence','low_role_confidence','low_category_confidence'].includes(r)))return 'required';
 if(reasons.length)return 'recommended';
 return [semantics.kind,semantics.role,semantics.category,semantics.subcategory].some(f=>f.userVerified)?'verified':'none';
}

export function reviewReasonsAfterEdit(reasons:string[],patch:object&{reviewRequested?:boolean;corrections?:object}):string[]{
 const cleared=new Set<string>();
 if('corrections'in patch&&patch.corrections&&typeof patch.corrections==='object'&&['amountMinor','operationDate','accountId'].every(k=>Object.hasOwn(patch.corrections!,k)))for(const reason of ['parser_uncertainty','import_issue'])cleared.add(reason);
 if('kind'in patch)cleared.add('low_kind_confidence');
 if('role'in patch)for(const reason of ['low_role_confidence','unresolved_role','unresolved_transfer'])cleared.add(reason);
 if('categoryId'in patch||'subcategoryId'in patch)cleared.add('low_category_confidence');
 if('reviewRequested'in patch)cleared.add('user_requested_review');
 return [...reasons.filter(reason=>!cleared.has(reason)),...(patch.reviewRequested===true?['user_requested_review']:[])];
}

export function missingCategoryLabel(parts:readonly {role:string;categoryId:string|null}[]=[]):string{
 if(parts.length<2)return 'Не указана категория';
 const missing=parts.flatMap((p,i)=>['expense','income'].includes(p.role)&&p.categoryId===null?[i+1]:[]);
 return missing.length===1?'У части '+missing[0]+' не задана категория':missing.length?'У частей '+missing.join(', ')+' не задана категория':'Не указана категория';
}
export function needsPartsCategoryReview(op:{decompositionActive:boolean;parts?:readonly unknown[]}):boolean{return op.decompositionActive||(op.parts?.length??0)>1;}
