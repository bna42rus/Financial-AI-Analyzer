import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMail,accessWarning,describeDevice} from '../src/mail-templates.ts';
const origins={financeOrigin:'https://app.example.test',controlOrigin:'https://admin.example.test',adminRecipient:'owner@example.test'};
test('verification/invitation/reset links use fragments and distinct configured origins',()=>{
 for(const kind of ['application_verification','invitation','password_reset']){
  const mail=renderMail(kind,{email:'USER@example.test',token:'synthetic_token',expiresAt:'2030-01-01T00:00:00Z',profile:kind==='password_reset'?'control':'finance'},origins,'2026-10-01T00:00:00Z');
  assert.equal(mail.to,'user@example.test');assert.match(mail.text,kind==='password_reset'?/https:\/\/admin.example.test\/#reset\?token=/:/https:\/\/app.example.test\/#(?:verify|invite)\?token=/);
 }
});
test('independent registration proof is a code and never a password',()=>{
 const m=renderMail('registration_verification',{email:'u@example.test',proofToken:'independent_proof'},origins,'2026-10-01T00:00:00Z');assert.match(m.text,/independent_proof/);assert.ok(!m.text.includes('#invite'));
});
test('payment claims notify the operator with server facts, decisions hide internal notes',()=>{
 const m=renderMail('payment_claim',{email:'u@example.test',name:'User',senderName:'Sender',senderBank:'Bank',expectedMinor:'119000',tariff:{name:'Month',priceMinor:'119000',aiQuota:20,duration:{kind:'calendar_months',count:1}},createdAt:'2026-10-01T00:00:00Z',claimedAt:'2026-10-02T00:00:00Z'},origins,'2026-10-02T00:00:00Z');
 assert.equal(m.to,'owner@example.test');assert.match(m.text,/1190,00 ₽/);assert.match(m.text,/1 календарный месяц/);
 const d=renderMail('payment_decision',{email:'u@example.test',status:'rejected',reason:'PRIVATE NOTE'},origins,'2026-10-01T00:00:00Z');assert.ok(!d.text.includes('PRIVATE'));
});
test('closed template registry rejects unknown kinds, malformed tokens and money',()=>{
 assert.throws(()=>renderMail('unknown',{email:'u@example.test'},origins,''));assert.throws(()=>renderMail('password_reset',{email:'u@example.test'},origins,''));
 assert.throws(()=>renderMail('payment_decision',{email:'u@example.test',status:'needs_topup',remainingMinor:'0.1'},origins,''));
});
test('device notification uses coarse categories instead of full user-agent/fingerprint',()=>{
 const raw='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1';assert.equal(describeDevice(raw),'Safari · iPhone / iPad');assert.equal(describeDevice(undefined),'Неизвестный браузер · Неизвестное устройство');
});
test('Moscow reminders at seven, three and one days, today, and expiry; indefinite never warns',()=>{
 const now=new Date('2026-10-07T21:30:00Z');
 for(const days of [1,3,7])assert.match(accessWarning(new Date(now.getTime()+days*86400000).toISOString(),false,now)!,new RegExp(days+' дн'));
 assert.match(accessWarning('2026-10-08T18:00:00Z',false,now)!,/сегодня/);
 assert.match(accessWarning(now.toISOString(),false,now)!,/закончился/);assert.equal(accessWarning('2026-10-10T00:00:00Z',true,now),null);
 assert.equal(accessWarning('2026-11-08T00:00:00Z',false,now),null);
});

test('HTML contains a labelled action and escaped user text, with a plain-text URL fallback',()=>{
 const m=renderMail('security_login',{email:'u@example.test',device:'<img onerror="alert(1)">',at:'2026-10-01T00:00:00Z'},origins,'2026-10-01T00:00:00Z');
 assert.match(m.html!,/href="https:\/\/app.example.test\/#account"[^>]*>Открыть аккаунт/);
 assert.match(m.html!,/&lt;img onerror=&quot;alert\(1\)&quot;&gt;/);
 assert.match(m.html!,/src="cid:cashneuro-mark"/);assert.match(m.text,/Открыть аккаунт: https:/);
});

test('messages triggered by someone entering an address explain what to do before showing the action',()=>{
 const kinds=['existing_account','existing_invitation','application_verification','invitation','billing_invitation','registration_verification','profile_email_verification','password_reset','owner_email_verification'];
 for(const kind of kinds){
  const mail=renderMail(kind,{email:'u@example.test',token:'synthetic_token',proofToken:'synthetic_proof',code:'123456',expiresAt:'2030-01-01T00:00:00Z',profile:kind==='owner_email_verification'?'control':'finance'},origins,'2026-10-01T00:00:00Z');
  assert.match(mail.text,/Если вы не .+проигнорируйте письмо/,kind);
  assert.match(mail.html!,/background:#fff5df[^>]*>Если вы не .+проигнорируйте письмо/,kind);
 }
 const notice=renderMail('existing_account',{email:'u@example.test'},origins,'2026-10-01T00:00:00Z');
 assert.ok(notice.text.indexOf('проигнорируйте письмо')<notice.text.indexOf('Войти в CashNeuro'));
});
