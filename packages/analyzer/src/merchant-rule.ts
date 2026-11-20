import {recognizeMerchant,merchantKey} from '../../finance-core/src/merchant-recognition.ts';
import type {Category} from '../../finance-core/src/model.ts';
import type {Rule} from '../../finance-core/src/rules.ts';
/** An explicit future-rule command opens the existing editable preview flow.
 * This helper confers no authority and never writes or applies historical edits. */
export function merchantRuleDraft(text:string,categories:Category[]):Omit<Rule,'id'>|null{
 const match=/^(?:запомни\s*[:,]?\s*)?(?:весь|все|всё|всю|всегда)\s+(.{2,160}?)\s+(?:относить|относи|записывать|записывай)\s+(?:к|в|на)\s+(.{2,160}?)\s*[.!]?$/iu.exec(text.trim());
 if(!match)return null;
 const scope=match[1]!.trim(),target=match[2]!.replace(/^(?:категорию|категории)\s+/iu,'').trim(),available=categories.filter(c=>!c.hidden&&(c.role==='expense'||c.role==='both'));
 const chain=target.split(/\s*(?:→|->|›|\/)\s*/),matches=available.filter(c=>{const key=merchantKey(chain.at(-1)!),canonical=merchantKey(c.name);return canonical===key||canonical==='produkty'&&['produktam','produktah'].includes(key);});
 const selected=matches.filter(c=>chain.length===1||c.parentId!==null&&available.some(p=>p.id===c.parentId&&merchantKey(p.name)===merchantKey(chain[0]!)));
 if(selected.length!==1)return null;const category=selected[0]!,parent=category.parentId===null?category:available.find(c=>c.id===category.parentId);
 if(!parent)return null;
 let conditions:Rule['conditions'];
 if(/^(?:вендинг|vending)$/iu.test(scope))conditions={descriptionContains:'вендинг',direction:'out'};
 else{const recognized=recognizeMerchant(scope);if(!recognized.matched||recognized.conflict||!recognized.name)return null;conditions={merchantEquals:recognized.name,direction:'out'};}
 return {name:('Правило: '+scope+' → '+target).slice(0,160),enabled:true,priority:100,conditions,assignments:{categoryId:parent.id,subcategoryId:category.parentId===null?null:category.id}};
}
