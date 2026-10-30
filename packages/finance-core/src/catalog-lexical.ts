import {caseFoldExtras} from './catalog/generated/activity-v1.ts';
/** Search projection only. Never persist this over a bank/user display value. */
export function catalogFold(value:string):string{
 return [...value.normalize('NFKC').toLowerCase()].map(c=>caseFoldExtras[c]??c).join('').replace(/ё/g,'е').replace(/(?<=\p{L})[\u2010\u2011](?=\p{L})/gu,'-').replace(/\s+/gu,' ').trim();
}
const attached=/[\p{L}\p{N}\p{M}\p{Cf}_]/u;
export type LiteralHit<T>={value:T;form:string;from:number;through:number};
type Trie<T>={next:Map<string,Trie<T>>;ends:{value:T;form:string}[]};
/** Collect overlaps; neither longest spelling nor array order resolves meaning. */
export function literalIndex<T>(rows:readonly {value:T;forms:readonly string[]}[]){
 const root:Trie<T>={next:new Map(),ends:[]};
 for(const row of rows)for(const form of row.forms){let node=root;const folded=catalogFold(form);if(!folded)throw Error('EMPTY_CATALOG_LITERAL');for(const c of folded){let next=node.next.get(c);if(!next){next={next:new Map(),ends:[]};node.next.set(c,next);}node=next;}node.ends.push({value:row.value,form:folded});}
 return (text:string):LiteralHit<T>[]=>{const chars=[...catalogFold(text)],hits:LiteralHit<T>[]=[];
  for(let i=0;i<chars.length;i++){if(i&&attached.test(chars[i-1]!))continue;let node:Trie<T>|undefined=root;
   for(let j=i;j<chars.length;j++){node=node.next.get(chars[j]!);if(!node)break;if(node.ends.length&&(j+1===chars.length||!attached.test(chars[j+1]!)))for(const end of node.ends)hits.push({...end,from:i,through:j+1});}
  }return hits;
 };
}
export const hasLiteral=(text:string,forms:readonly string[])=>literalIndex([{value:true,forms}])(text).length>0;

export const literalNegated=(text:string,hit:LiteralHit<unknown>)=>/(?:^|[\s,;])(?:не|not)\s+$/u.test([...catalogFold(text)].slice(0,hit.from).join(''));
