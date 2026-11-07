import type {PoolClient} from 'pg';
import {legalDocuments} from '../../../packages/access/src/legal.ts';
import {sameBillingPlan} from '../../../packages/access/src/billing.ts';
import {HttpError} from './types.ts';

export function checkLegalVersion(value:unknown, expected:string, required:boolean){
 if (value!==undefined ? value!==expected : required) throw new HttpError(409,'LEGAL_VERSION_REQUIRED');
}
export async function accountLegal(db:PoolClient,userId:string){
 const rows=(await db.query('SELECT document,version FROM identity.legal_event WHERE user_id=$1 AND (document,version) IN ((\'terms\',$2),(\'privacy_notice\',$3))',[userId,legalDocuments.terms.version,legalDocuments.privacy.version])).rows;
 const recurring=(await db.query(`SELECT a.tariff AS before,a.offer_version,a.renewal_version,t.snapshot AS current
  FROM commerce.autorenewal a LEFT JOIN access.tariff t ON t.id=a.tariff->>'id' AND t.snapshot->>'active'='true'
   AND t.snapshot->>'availableForRenewal'='true' WHERE a.user_id=$1 AND a.state IN ('active','changed')`,[userId])).rows[0];
 const billingChanged=!!recurring&&(!recurring.current||recurring.offer_version!==legalDocuments.offer.version||recurring.renewal_version!==legalDocuments.renewal.version||!sameBillingPlan(recurring.before,recurring.current));
 return {billingChanged,termsAccepted:rows.some(r=>r.document==='terms'),privacySeen:rows.some(r=>r.document==='privacy_notice')};
}
export async function recordLegal(db:PoolClient,userId:string,document:unknown,version:unknown){
 if(document!=='terms'&&document!=='privacy_notice')throw new HttpError(400,'INVALID_INPUT');
 checkLegalVersion(version,legalDocuments[document==='terms'?'terms':'privacy'].version,true);
 await db.query('INSERT INTO identity.legal_event(user_id,document,version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[userId,document,version]);
}
