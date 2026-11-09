import type {PoolClient} from 'pg';
import type {FastifyRequest} from 'fastify';
import {fields,string,HttpError} from './types.ts';

export async function adminHistory(db:PoolClient,request:FastifyRequest){
 const body=fields(request,['search','before']);
 const search=typeof body.search==='string'&&body.search.length<=254?body.search.trim():'';
 const cursor=body.before as {at?:unknown;id?:unknown}|undefined;
 const at=cursor?string(cursor.at,64):null,id=cursor?string(cursor.id,128):null;
 if(at&&!Number.isFinite(Date.parse(at)))throw new HttpError(400,'INVALID_INPUT');
 const entries=(await db.query(`WITH history AS (
 SELECT a.id,a.created_at AS stamp,coalesce(a.payload->>'kind','action') AS kind,
  coalesce(m.data->>'mode',a.payload->>'decision') AS decision,
  coalesce(m.data->>'email',d.email,i.email,r.email,n.data->>'email',a.payload->>'email',a.payload->>'target',mails.recipient) AS target,
  u.email AS actor,coalesce(m.data->>'reason',a.payload->>'reason') AS note,
  coalesce(m.data->'before'->>'accessEnd',e.data->>'previousEnd') AS before,coalesce(m.data->'after'->>'accessEnd',e.data->>'accessEnd') AS after,
  coalesce(m.data->'before'->>'indefinite','false')='true' AS "beforeIndefinite",
  coalesce(m.data->'after'->>'indefinite','false')='true' AS "afterIndefinite"
 FROM commerce.action a
 LEFT JOIN commerce.manual_access_audit m ON m.action_id=a.id
 LEFT JOIN commerce.account_directory d ON d.user_id=a.payload->>'userId'
 LEFT JOIN commerce.invitation i ON i.id=a.payload->>'invitationId'
 LEFT JOIN access.request r ON r.id=a.payload->>'requestId'
 LEFT JOIN commerce.renewal_request n ON n.id=a.payload->>'requestId'
 LEFT JOIN commerce.access_extension e ON e.action_id=a.id
 LEFT JOIN mail.delivery mails ON mails.id::text=a.payload->>'delivery'
 LEFT JOIN control.auth_user u ON u.id=a.actor_id
 )
 SELECT *,stamp::text AS at FROM history WHERE ($1='' OR strpos(lower(concat_ws(' ',target,actor,note,kind,decision,
 CASE decision WHEN 'extend' THEN 'доступ продлён продление' WHEN 'end_now' THEN 'доступ завершён' WHEN 'indefinite' THEN 'бессрочный доступ' WHEN 'set_end' THEN 'изменена дата окончания' END)),lower($1))>0)
 AND ($2::timestamptz IS NULL OR (stamp,id)<($2::timestamptz,$3))
 ORDER BY stamp DESC,id DESC LIMIT 50`,[search,at,id])).rows;
 return {entries};
}
