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

/** Merchant service forms keep their original spans and guards. For Yandex,
 * bank separators, terminal numbers and wrapper tokens may separate the words. */
export function merchantLiteralIndex<T>(rows:readonly {value:T;forms:readonly string[]}[]){
 const direct=literalIndex(rows),brand=/^(?:yandex|yandeks|jandeks|iandeks|яндекс)$/u;
 const separated=rows.flatMap(row=>row.forms.flatMap(form=>{const words=catalogFold(form).match(/[\p{L}\p{N}]+/gu)??[];return words.length>1&&words.some(w=>brand.test(w))?[{value:row.value,form:catalogFold(form),words}]:[];}));
 return (text:string):LiteralHit<T>[]=>{const hits=direct(text),folded=catalogFold(text),tokens=[...folded.matchAll(/[\p{L}]+|[\p{N}]+/gu)].map(m=>({word:m[0],from:[...folded.slice(0,m.index)].length,through:[...folded.slice(0,m.index!+m[0].length)].length}));
  for(const item of separated){const selected=item.words.map(w=>tokens.find(t=>t.word===w&&!literalNegated(text,{value:true,form:w,from:t.from,through:t.through})));if(selected.some(t=>!t))continue;const from=Math.min(...selected.map(t=>t!.from)),through=Math.max(...selected.map(t=>t!.through));if(!hits.some(h=>h.value===item.value&&h.form===item.form&&h.from===from&&h.through===through))hits.push({value:item.value,form:item.form,from,through});}
  return hits;
 };
}
