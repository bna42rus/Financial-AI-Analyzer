import type {PoolClient} from 'pg';
import {object} from '../../../packages/finance-core/src/model.ts';
import {catalogDurationLabel} from '../../../packages/access/src/model.ts';
import type {Tariff} from '../../../packages/access/src/model.ts';
import {HttpError} from './types.ts';

type Pack={id:string;units:number;priceMinor:number;enabled:boolean};
export type CatalogChange={label:string;before:unknown;after:unknown};
export const catalogOrder="CASE WHEN snapshot->'duration'->>'kind'='days' THEN (snapshot->'duration'->>'count')::int ELSE (snapshot->'duration'->>'count')::int*31 END,id";
export async function commerceCatalog(db:PoolClient){return {
 plans:(await db.query<{snapshot:Tariff}>(`SELECT snapshot FROM access.tariff WHERE id LIKE 'cashneuro-%' ORDER BY ${catalogOrder}`)).rows.map(r=>r.snapshot),
 packs:(await db.query<Pack>('SELECT catalog_id AS id,units,price_minor AS "priceMinor",enabled FROM commerce.ai_pack ORDER BY units')).rows,
};}
const validInt=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
const differences=(fields:CatalogChange[])=>fields.filter(field=>field.before!==field.after);

export async function updateCommerceCatalog(db:PoolClient,input:unknown){
 const r=object(input,['kind','id','packId','units','priceMinor','months','durationKind','count','aiQuota','enabled','expectedVersion','expectedUnits','expectedPriceMinor','expectedEnabled']);
 if(typeof r.priceMinor!=='string'||!/^[1-9]\d{2,6}$/.test(r.priceMinor)||!validInt(Number(r.priceMinor),100,1000000)||Number(r.priceMinor)%100!==0||typeof r.enabled!=='boolean')throw new HttpError(400,'INVALID_TARIFF_PRICE');
 await db.query('SELECT pg_advisory_xact_lock(92044)');
 if(r.kind==='plan'||r.id!==undefined){
  if(r.id!==undefined&&(typeof r.id!=='string'||!/^cashneuro-[a-z0-9-]{1,85}$/.test(r.id)))throw new HttpError(400,'INVALID_INPUT');
  const id=r.id??'cashneuro-'+crypto.randomUUID();
  const previous=(await db.query<{snapshot:Tariff}>('SELECT snapshot FROM access.tariff WHERE id=$1 FOR UPDATE',[id])).rows[0]?.snapshot;
  if(r.id&&!previous||previous&&r.expectedVersion!==undefined&&r.expectedVersion!==(previous.catalogVersion??0))throw new HttpError(409,'TARIFF_CHANGED');
  const kind=r.durationKind??'calendar_months',count=r.count??r.months,aiQuota=r.aiQuota??previous?.aiQuota;
  if(kind!=='days'&&kind!=='calendar_months'||!validInt(count,1,kind==='days'?36500:120))throw new HttpError(400,'INVALID_TARIFF_DURATION');
  if(!validInt(aiQuota,0,1000000))throw new HttpError(400,'INVALID_TARIFF_LIMIT');
  const duration={kind,count} as Tariff['duration'];
  const next:Tariff={id,name:catalogDurationLabel(duration),duration,priceMinor:r.priceMinor,aiQuota,active:r.enabled,publicVisible:r.enabled,
   availableForNew:previous?.availableForNew??true,availableForRenewal:previous?.availableForRenewal??true,catalogVersion:(previous?.catalogVersion??0)+1};
  const changes=differences([
   {label:'Срок',before:previous?catalogDurationLabel(previous.duration):null,after:next.name},
   {label:'Цена, ₽',before:previous?Number(previous.priceMinor)/100:null,after:Number(next.priceMinor)/100},
   {label:'Лимит Анализатора',before:previous?.aiQuota??null,after:next.aiQuota},
   {label:'Показывать пользователям',before:previous?.active??null,after:next.active}
  ]);
  if(changes.length)await db.query('INSERT INTO access.tariff(id,snapshot) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET snapshot=EXCLUDED.snapshot',[id,next]);
  return {catalog:await commerceCatalog(db),audit:changes.length?{kind:previous?'tariff':'tariff_created',target:next.name,changes}:null};
 }
 if(r.kind!==undefined&&r.kind!=='pack'||!validInt(r.units,1,1000000)||r.packId!==undefined&&typeof r.packId!=='string')throw new HttpError(400,'INVALID_PACK_UNITS');
 const previous=(await db.query<Pack>(`SELECT catalog_id AS id,units,price_minor AS "priceMinor",enabled FROM commerce.ai_pack
  WHERE ($1::text IS NOT NULL AND catalog_id=$1) OR ($2::boolean AND units=$3) FOR UPDATE`,[r.packId??null,r.kind===undefined&&r.packId===undefined,r.units])).rows[0];
 if(r.packId&&!previous||previous&&((r.expectedUnits!==undefined&&previous.units!==r.expectedUnits)||(r.expectedPriceMinor!==undefined&&previous.priceMinor!==r.expectedPriceMinor)||(r.expectedEnabled!==undefined&&previous.enabled!==r.expectedEnabled)))throw new HttpError(409,'TARIFF_CHANGED');
 const other=(await db.query('SELECT 1 FROM commerce.ai_pack WHERE units=$1 AND catalog_id IS DISTINCT FROM $2',[r.units,previous?.id??null])).rowCount;
 if(other)throw new HttpError(409,'PACK_UNITS_EXIST');
 const changes=differences([
  {label:'Количество единиц',before:previous?.units??null,after:r.units},
  {label:'Цена, ₽',before:previous?previous.priceMinor/100:null,after:Number(r.priceMinor)/100},
  {label:'Показывать пользователям',before:previous?.enabled??null,after:r.enabled}
 ]);
 if(changes.length){
  if(previous)await db.query('UPDATE commerce.ai_pack SET units=$2,price_minor=$3,enabled=$4 WHERE catalog_id=$1',[previous.id,r.units,Number(r.priceMinor),r.enabled]);
  else await db.query('INSERT INTO commerce.ai_pack(units,price_minor,enabled) VALUES($1,$2,$3)',[r.units,Number(r.priceMinor),r.enabled]);
 }
 return {catalog:await commerceCatalog(db),audit:changes.length?{kind:previous?'pack':'pack_created',target:r.units+' единиц',changes}:null};
}
