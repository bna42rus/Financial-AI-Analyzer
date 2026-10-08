import type {PoolClient} from 'pg';
import {ImportContractError,parseContext,validatePreparedBatch} from '../../../packages/imports/src/contract.ts';
import {withPreparedImport} from './finance.ts';
import {HttpError} from './types.ts';

/** Development validation stage only: no financial write, queue, stored payload or AI call. */
export async function validateImport(db:PoolClient,userId:string,input:unknown){
 try{
  // Authority/epoch is checked before inspecting financial rows, and again before returning.
  const context=parseContext(input&&typeof input==='object'&&!Array.isArray(input)?(input as Record<string,unknown>).context:undefined);
  return await withPreparedImport(db,userId,context,async()=>validatePreparedBatch(input).report);
 }catch(error){if(error instanceof ImportContractError)throw new HttpError(400,'INVALID_IMPORT_PAYLOAD');throw error;}
}
