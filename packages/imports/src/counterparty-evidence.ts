/** A bank-supplied identifier of the other side of a transfer. It stays local until pseudonymized. */
export const counterpartyEvidenceKinds=['bank_account','bank_contract','card','phone'] as const;
export type CounterpartyEvidenceKind=typeof counterpartyEvidenceKinds[number];
export type CounterpartyEvidence={kind:CounterpartyEvidenceKind;hmac:string;name?:string};

export function counterpartyNameHint(value:unknown):string|undefined{
 if(typeof value!=='string')return;
 const name=value.normalize('NFKC').trim().replace(/ +/g,' ');
 return /^[А-ЯЁ][а-яё-]{1,28} [А-ЯЁ]\.$/u.test(name)?name:undefined;
}

export function fullCounterpartyIdentifier(kind:CounterpartyEvidenceKind,input:unknown):string|undefined{
 if(kind==='bank_contract')return typeof input==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(input)?input:undefined;
 if(typeof input!=='string'||input.length>48||!/^[0-9+() -]+$/.test(input))return;
 if(kind!=='phone'&&/[^0-9 -]/.test(input))return;
 const digits=input.replace(/\D/g,'');
 if(kind==='bank_account')return /^\d{20}$/.test(digits)?digits:undefined;
 if(kind==='card')return /^\d{16,19}$/.test(digits)?digits:undefined;
 return /^[78]9\d{9}$/.test(digits)?'7'+digits.slice(1):undefined;
}

export const ownTransferEvidence=(description:string)=>/^(?:(?:внутренний|входящий|исходящий)\s+)?перевод(?:\s+денежных средств|\s+средств)?\s+себе(?=$|[^\p{L}\p{N}])|между (?:своими|собственными) счетами|на (?:свой|собственный) сч[её]т|own transfer|between (?:my|own) accounts/iu.test(description);

/** Local-only evidence. A masked card suffix, ordinary amount or person name
 * never establishes an identity. No returned raw value is sent to the server. */
export function transferIdentifiers(description:string):{kind:CounterpartyEvidenceKind;value:string}[]{
 const out:{kind:CounterpartyEvidenceKind;value:string}[]=[];
 if(!/^(?:(?:внутренний|внешний|входящий|исходящий|денежный|банковский)\s+)?перевод(?=$|[^\p{L}\p{N}])/iu.test(description)||/\p{Cf}/u.test(description))return out;
 const patterns:[CounterpartyEvidenceKind,RegExp][]=[['bank_account',/(?:на|со?|от)\s+(?:сч[её]т[а]?|account)\s*(?:№\s*)?(\d{20})(?!\d)/giu],['bank_contract',/(?:на|с|со)\s+(?:договор|контракт)\s*(?:№\s*)?([A-Za-z0-9][A-Za-z0-9._:/-]{2,127})/giu],['card',/(?:на|с|со)\s+карт[уы]\s*(?:№\s*)?(\d{16,19})(?!\d)/giu],['phone',/(?:по (?:номеру )?телефона|телефон)\s*[:+]?\s*([78]9\d{9})(?!\d)/giu]];
 for(const [kind,re] of patterns)for(const m of description.matchAll(re)){const value=fullCounterpartyIdentifier(kind,m[1]);if(value)out.push({kind,value});}
 return out.slice(0,3);
}
