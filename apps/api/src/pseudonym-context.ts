import {randomBytes} from 'node:crypto';
import type {PoolClient} from 'pg';
import {object,uuid} from '../../../packages/finance-core/src/model.ts';
import {HttpError} from './types.ts';
import type {Sealer} from './types.ts';
import {sourceProfiles} from '../../../packages/imports/src/safe-source.ts';

export type ImportEpoch={generation:string;keyVersion:string};
export type PreparedImportContext=ImportEpoch&{contextId:string};
export type EpochState={generation:string;key_version:string};
export function importEpoch(state:ImportEpoch):ImportEpoch{return {generation:state.generation,keyVersion:state.keyVersion};}
export function assertImportEpoch(input:ImportEpoch,state:EpochState){
 const r=object(input,['generation','keyVersion']);
 if(uuid(r.generation)!==state.generation)throw new HttpError(409,'GENERATION_CHANGED');
 if(uuid(r.keyVersion)!==state.key_version)throw new HttpError(409,'KEY_VERSION_CHANGED');
}
export function sealPseudonymKey(seal:Sealer,userId:string,version:string){
 const key=randomBytes(32);
 try{return seal.seal(JSON.stringify({purpose:'pseudonymization/v1',userId,version,key:key.toString('base64url')}));}finally{key.fill(0);}
}
function openKey(seal:Sealer,encoded:string,userId:string,version:string){
 try{
  const p=object(JSON.parse(seal.open(encoded)),['purpose','userId','version','key']);
  if(p.purpose!=='pseudonymization/v1'||p.userId!==userId||p.version!==version||typeof p.key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(p.key))throw new Error();
  const bytes=Buffer.from(p.key,'base64url');try{if(bytes.length!==32||bytes.toString('base64url')!==p.key)throw new Error();return p.key;}finally{bytes.fill(0);}
 }catch{throw new HttpError(503,'PSEUDONYM_KEY_UNAVAILABLE');}
}
/** Only the authenticated local import preparation endpoint returns the key. Never an AI tool. */
export async function prepareImportContext(db:PoolClient,userId:string,state:EpochState,input:unknown,seal:Sealer){
 // Caller holds the per-user workspace lock; no extra UPDATE grant is needed for context reads.
 const r=object(input,['contextId']),id=uuid(r.contextId),existing=(await db.query('SELECT generation,key_version,expires_at>clock_timestamp() AS fresh FROM finance.ingestion_context WHERE user_id=$1 AND id=$2',[userId,id])).rows[0];
 if(existing&&(existing.generation!==state.generation||existing.key_version!==state.key_version))throw new HttpError(409,'IMPORT_CONTEXT_CHANGED');
 if(existing&&!existing.fresh)throw new HttpError(409,'IMPORT_CONTEXT_EXPIRED');
 await db.query('DELETE FROM finance.ingestion_context WHERE user_id=$1 AND (expires_at<=clock_timestamp() OR generation<>$2 OR key_version<>$3)',[userId,state.generation,state.key_version]);
 if(!existing&&Number((await db.query('SELECT count(*) AS n FROM finance.ingestion_context WHERE user_id=$1',[userId])).rows[0].n)>=100)throw new HttpError(409,'IMPORT_CONTEXT_LIMIT');
 const record=(await db.query('SELECT * FROM finance.ensure_pseudonym_key($1,$2,$3)',[state.generation,state.key_version,sealPseudonymKey(seal,userId,state.key_version)])).rows[0];
 if(!existing)await db.query('INSERT INTO finance.ingestion_context(user_id,id,generation,key_version) VALUES($1,$2,$3,$4)',[userId,id,state.generation,state.key_version]);
 const key=openKey(seal,record.sealed_key,userId,state.key_version);
 return {contextId:id,generation:state.generation,keyVersion:state.key_version,key,algorithm:'HMAC-SHA-256',keyBytes:32,storage:'memory_only',sourceProfiles:[...sourceProfiles],expiresAt:(await db.query('SELECT expires_at FROM finance.ingestion_context WHERE user_id=$1 AND id=$2',[userId,id])).rows[0].expires_at};
}
export async function assertPreparedContext(db:PoolClient,userId:string,input:PreparedImportContext,state:EpochState){
 const r=object(input,['contextId','generation','keyVersion']),id=uuid(r.contextId);
 if(uuid(r.generation)!==state.generation||uuid(r.keyVersion)!==state.key_version)throw new HttpError(409,'IMPORT_CONTEXT_CHANGED');
 const context=(await db.query('SELECT generation,key_version,expires_at>clock_timestamp() AS fresh FROM finance.ingestion_context WHERE user_id=$1 AND id=$2',[userId,id])).rows[0];
 if(!context||context.generation!==state.generation||context.key_version!==state.key_version)throw new HttpError(409,'IMPORT_CONTEXT_CHANGED');
 if(!context.fresh)throw new HttpError(409,'IMPORT_CONTEXT_EXPIRED');
 return {contextId:id,generation:state.generation,keyVersion:state.key_version};
}
