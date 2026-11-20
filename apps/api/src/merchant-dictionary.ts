import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setMerchantDictionary,validateMerchantDictionary} from '../../../packages/finance-core/src/merchant-dictionary.ts';
let checkedAt=0,stamp='',pending:Promise<void>|undefined;
/** One public dictionary for both realms/environments. Atomic validated swaps;
 * a malformed/unavailable update never discards the last working snapshot. */
export async function refreshMerchantDictionary(force=false){
 if(pending)return pending;if(!force&&Date.now()-checkedAt<5000)return;checkedAt=Date.now();
 pending=(async()=>{try{
  const path=process.env.CASHNEURO_MERCHANT_DICTIONARY_FILE??'/var/lib/cashneuro/merchant-dictionary/active.json',info=await stat(path);
  if(!info.isFile()||info.size>1024*1024||(info.mode&0o022)!==0)return;
  const nextStamp=info.ino+':'+info.mtimeMs+':'+info.size;if(nextStamp===stamp)return;
  const raw=await readFile(path,'utf8'),data=validateMerchantDictionary(JSON.parse(raw));
  data.revision=data.revision.slice(0,63)+'.'+createHash('sha256').update(raw).digest('hex').slice(0,16);setMerchantDictionary(data);stamp=nextStamp;
 }catch{/* Preserve the bundled/last validated dictionary; never log source content. */}})();
 try{await pending;}finally{pending=undefined;}
}
