import type {PoolClient} from 'pg';
import {object} from '../../../packages/finance-core/src/model.ts';
import {HttpError} from './types.ts';

export async function commerceCatalog(db:PoolClient){return {
 plans:(await db.query("SELECT snapshot FROM access.tariff WHERE id IN ('cashneuro-1m','cashneuro-3m','cashneuro-6m') ORDER BY (snapshot->'duration'->>'count')::int")).rows.map(r=>r.snapshot),
 packs:(await db.query('SELECT units,price_minor AS "priceMinor",enabled FROM commerce.ai_pack ORDER BY units')).rows,
};}
export async function updateCommerceCatalog(db:PoolClient,input:unknown){
 const r=object(input,['id','units','priceMinor','months','enabled']),price=Number(r.priceMinor);
 if(typeof r.priceMinor!=='string'||!/^\d{3,7}$/.test(r.priceMinor)||price<100||price>1000000||typeof r.enabled!=='boolean')throw new HttpError(400,'INVALID_INPUT');
 if(r.id!==undefined){
  if(!['cashneuro-1m','cashneuro-3m','cashneuro-6m'].includes(String(r.id))||r.units!==undefined||!Number.isSafeInteger(r.months)||Number(r.months)<1||Number(r.months)>24)throw new HttpError(400,'INVALID_INPUT');
  await db.query("UPDATE access.tariff SET snapshot=snapshot||jsonb_build_object('priceMinor',$2::text,'duration',jsonb_build_object('kind','calendar_months','count',$3::integer),'active',$4::boolean,'publicVisible',$4::boolean,'name',CASE WHEN $3=1 THEN '1 месяц' ELSE $3::text||' мес.' END) WHERE id=$1",[r.id,r.priceMinor,r.months,r.enabled]);
 }else{
  if(![1000,2000,5000,10000].includes(Number(r.units))||typeof r.units!=='number'||r.months!==undefined)throw new HttpError(400,'INVALID_INPUT');
  await db.query('UPDATE commerce.ai_pack SET price_minor=$2,enabled=$3 WHERE units=$1',[r.units,price,r.enabled]);
 }
 return commerceCatalog(db);
}
