/** Closed brand forms, not stemming, edit-distance matching or general language inference. */
const cyrillic:Record<string,string>={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
const styles=[cyrillic,{...cyrillic,ё:'yo',х:'kh',щ:'shch'},{...cyrillic,й:'j',х:'kh',щ:'shh',ю:'ju',я:'ja'}];
export function brandForms(forms:readonly string[]):string[]{
 const expanded=forms.flatMap(form=>[form,...styles.map(style=>form.toLowerCase().replace(/[а-яё]/gu,c=>style[c]!))]);
 return [...new Set(expanded.flatMap(form=>[form,form.replace(/[\s-]+/gu,'')]))];
}
/** Unlike a search key, foreign letters must remain word boundaries, not disappear. */
export const brandKey=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[а-яё]/gu,c=>cyrillic[c]!).replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/gu,' ');
const lookalikes:Record<string,string>={a:'а',b:'в',c:'с',e:'е',h:'н',k:'к',m:'м',o:'о',p:'р',t:'т',x:'х',y:'у'};
export function brandKeys(text:string):string[]{
 const normalized=text.normalize('NFKC').toLowerCase();
 // Only mixed Cyrillic/Latin tokens get a second view. Pure Latin is never reinterpreted.
 const mixed=normalized.replace(/[\p{L}\p{N}]+/gu,token=>/[а-яё]/u.test(token)&&/[a-z]/u.test(token)?token.replace(/[abcehkmoptxy]/gu,c=>lookalikes[c]!):token);
 return [...new Set([brandKey(normalized),brandKey(mixed)])];
}
export function brandPattern(aliases:readonly string[]):RegExp{
 const keys=[...new Set(aliases.map(brandKey))].filter(Boolean).sort((a,b)=>b.length-a.length).map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 // A complete numeric branch suffix is allowed; SPAR349X, SPARK and XXLENTA are not.
 return new RegExp('(?:^| )(?:'+keys.join('|')+')(?=$| |[0-9]+(?=$| ))','u');
}
