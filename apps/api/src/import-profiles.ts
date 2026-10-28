import type {PoolClient} from 'pg';
import {merchantSourceSanitizer,sourceProfiles} from '../../../packages/imports/src/safe-source.ts';

/** Code support alone is insufficient: a partially updated database must not
 * advertise a profile whose closed evidence constraint cannot persist it. */
export async function merchantSourceStorageAvailable(db:PoolClient):Promise<boolean>{
 const r=await db.query<{supported:boolean}>("SELECT position('textEvidence' IN pg_get_constraintdef(oid))>0 AS supported FROM pg_constraint WHERE conrelid=to_regclass('finance.ingestion_row') AND conname='finite_source_evidence'");
 return r.rows[0]?.supported===true;
}
export async function availableSourceProfiles(db:PoolClient){
 return await merchantSourceStorageAvailable(db)?[...sourceProfiles]:sourceProfiles.filter(p=>p!==merchantSourceSanitizer);
}
