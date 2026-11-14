/** A bank-supplied identifier of the other side of a transfer. It stays local until pseudonymized. */
export const counterpartyEvidenceKinds=['bank_account','card','phone'] as const;
export type CounterpartyEvidenceKind=typeof counterpartyEvidenceKinds[number];
export type CounterpartyEvidence={kind:CounterpartyEvidenceKind;hmac:string;name?:string};

export function counterpartyNameHint(value:unknown):string|undefined{
 if(typeof value!=='string')return;
 const name=value.normalize('NFKC').trim().replace(/ +/g,' ');
 return /^[А-ЯЁ][а-яё-]{1,28} [А-ЯЁ]\.$/u.test(name)?name:undefined;
}

export function fullCounterpartyIdentifier(kind:CounterpartyEvidenceKind,input:unknown):string|undefined{
 if(typeof input!=='string'||input.length>48||!/^[0-9+() -]+$/.test(input))return;
 if(kind!=='phone'&&/[^0-9 -]/.test(input))return;
 const digits=input.replace(/\D/g,'');
 if(kind==='bank_account')return /^\d{20}$/.test(digits)?digits:undefined;
 if(kind==='card')return /^\d{16,19}$/.test(digits)?digits:undefined;
 return /^[78]9\d{9}$/.test(digits)?'7'+digits.slice(1):undefined;
}

export const ownTransferEvidence=(description:string)=>/между (?:своими |собственными )?счетами|на (?:свой|собственный) сч[её]т|own transfer|between (?:my|own) accounts/iu.test(description);
