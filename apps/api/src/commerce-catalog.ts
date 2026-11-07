import type {PoolClient} from 'pg';
import {object} from '../../../packages/finance-core/src/model.ts';
import {HttpError} from './types.ts';

const planIds=['cashneuro-1w','cashneuro-2w','cashneuro-1m','cashneuro-3m','cashneuro-6m'];
export const catalogOrder="CASE WHEN snapshot->'duration'->>'kind'='days' THEN (snapshot->'duration'->>'count')::int ELSE (snapshot->'duration'->>'count')::int*31 END,id";
export async function commerceCatalog(db:PoolClient){return {
 plans:(await db.query(`SELECT snapshot FROM access.tariff WHERE id=ANY($1::text[]) ORDER BY ${catalogOrder}`,[planIds])).rows.map(r=>r.snapshot),
 packs:(await db.query('SELECT units,price_minor AS "priceMinor",enabled FROM commerce.ai_pack ORDER BY units')).rows,
};}
export async function updateCommerceCatalog(db:PoolClient,input:unknown){
 const r=object(input,['id','units','priceMinor','months','durationKind','count','aiQuota','enabled','expectedVersion']),price=Number(r.priceMinor);
 if(typeof r.priceMinor!=='string'||!/^[1-9]\d{2,6}$/.test(r.priceMinor)||price<100||price>1000000||typeof r.enabled!=='boolean')throw new HttpError(400,'INVALID_INPUT');
 if(r.id!==undefined){
  await db.query('SELECT pg_advisory_xact_lock(92044)');
  const kind=r.durationKind??'calendar_months',count=Number(r.count??r.months),quota=r.aiQuota;
  if(!planIds.includes(String(r.id))||r.units!==undefined||!['days','calendar_months'].includes(String(kind))||typeof (r.count??r.months)!=='number'||!Number.isSafeInteger(count)||count<1||count>(kind==='days'?31:24)||quota!==undefined&&(!Number.isSafeInteger(quota)||Number(quota)<0||Number(quota)>1000000)||r.expectedVersion!==undefined&&(!Number.isSafeInteger(r.expectedVersion)||Number(r.expectedVersion)<0))throw new HttpError(400,'INVALID_INPUT');
  const name=kind==='days'?(count===7?'1 неделя':count===14?'2 недели':count+' дн.'):(count===1?'1 месяц':count===3?'3 месяца':count===6?'6 месяцев':count+' мес.');
  const update=await db.query(`UPDATE access.tariff SET snapshot=snapshot||jsonb_build_object(
   'priceMinor',$2::text,'duration',jsonb_build_object('kind',$3::text,'count',$4::integer),
   'active',$5::boolean,'publicVisible',$5::boolean,'name',$6::text,'aiQuota',COALESCE($7::integer,(snapshot->>'aiQuota')::int),
   'catalogVersion',COALESCE((snapshot->>'catalogVersion')::int,0)+1)
   WHERE id=$1 AND ($8::int IS NULL OR COALESCE((snapshot->>'catalogVersion')::int,0)=$8)`,[r.id,r.priceMinor,kind,count,r.enabled,name,quota??null,r.expectedVersion??null]);
  if(!update.rowCount)throw new HttpError(409,'TARIFF_CHANGED');
 }else{
  if(![1000,2000,5000,10000].includes(Number(r.units))||typeof r.units!=='number'||r.months!==undefined||r.count!==undefined||r.durationKind!==undefined||r.aiQuota!==undefined||r.expectedVersion!==undefined)throw new HttpError(400,'INVALID_INPUT');
  await db.query('UPDATE commerce.ai_pack SET price_minor=$2,enabled=$3 WHERE units=$1',[r.units,price,r.enabled]);
 }
 return commerceCatalog(db);
}
