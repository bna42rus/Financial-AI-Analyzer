import type {PoolClient} from 'pg';
import {reviewGroupIds} from '../../../packages/finance-core/src/review-group.ts';
import type {ReviewGroupOperation} from '../../../packages/finance-core/src/review-group.ts';
import {HttpError} from './types.ts';
export type ReviewScope={sessionId:string;revision:string;anchorId:string};
export async function assertReviewGroup(db:PoolClient,userId:string,scope:ReviewScope,ids:string[],operations:ReviewGroupOperation[]){
 const s=(await db.query('SELECT operation_ids,cursor,status,revision FROM finance.review_session WHERE user_id=$1 AND id=$2 FOR UPDATE',[userId,scope.sessionId])).rows[0];
 if(!s)throw new HttpError(404,'NOT_FOUND');
 if(String(s.revision)!==scope.revision||s.status!=='in_progress'||s.operation_ids[s.cursor]!==scope.anchorId)throw new HttpError(409,'REVIEW_CHANGED');
 const expected=reviewGroupIds(operations,s.operation_ids,scope.anchorId);
 if(expected.length!==ids.length||expected.some((id,i)=>id!==ids[i]))throw new HttpError(409,'REVIEW_GROUP_CHANGED');
}
