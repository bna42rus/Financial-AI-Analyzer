import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGate,signSession,validSession,safeNext,gatePage} from './staging-gate.mjs';
const key=Buffer.alloc(32,7);
test('outer session survives restart, expires and rejects tampering or another secret',()=>{
 const now=1700000000000,token=signSession(key,now);assert.equal(validSession(token,key,now+86400000),true);assert.equal(validSession(token,key,now+366*86400000),false);assert.equal(validSession(token+'x',key,now),false);assert.equal(validSession(token,Buffer.alloc(32,8),now),false);
 for(const value of ['https://example.test','//example.test','/\\example.test','/__staging/login','/\r\nLocation:x'])assert.equal(safeNext(value),'/');assert.equal(safeNext('/?x=1#account'),'/?x=1#account');assert.ok(!gatePage().includes('value="password"'));
});
test('outer login sets only a secure long-lived session and does not accept cross-origin credentials',async()=>{
 let calls=0;const server=createGate(key,async(login,password)=>{calls++;return login==='owner'&&password==='synthetic';});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;const call=(url,init={})=>fetch(url,{...init,headers:{'X-Forwarded-Host':'test.cashneuro.ru',...init.headers}});
 try{
  let r=await call(origin+'/__staging/verify',{redirect:'manual',headers:{'X-Forwarded-Uri':'/#account'}});assert.equal(r.status,302);assert.match(r.headers.get('Location'),/login/);
  r=await call(origin+'/__staging/login',{method:'POST',body:'login=owner&password=synthetic',headers:{Origin:'https://evil.example'},redirect:'manual'});assert.equal(r.status,403);assert.equal(calls,0);
  r=await call(origin+'/__staging/login?next=%2F',{method:'POST',body:'login=owner&password=synthetic',headers:{Origin:'https://test.cashneuro.ru'},redirect:'manual'});assert.equal(r.status,303);const cookie=r.headers.get('Set-Cookie');assert.match(cookie,/Secure; HttpOnly; SameSite=Lax/);assert.match(cookie,/Max-Age=31536000/);assert.ok(!cookie.includes('synthetic'));
  r=await call(origin+'/__staging/verify',{headers:{Cookie:cookie.split(';')[0]}});assert.equal(r.status,204);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('admin gate remembers login but never accepts a web session or a web Origin',async()=>{
 const admin='admin.test.cashneuro.ru';let seen;
 const server=createGate(key,async(_login,_password,host)=>{seen=host;return true;});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{
  let r=await fetch(origin+'/__staging/login',{headers:{'X-Forwarded-Host':admin}});assert.match(await r.text(),/Вход в тестовую админку/);
  r=await fetch(origin+'/__staging/login',{method:'POST',body:'login=owner&password=synthetic',headers:{'X-Forwarded-Host':admin,Origin:'https://test.cashneuro.ru'},redirect:'manual'});assert.equal(r.status,403);
  r=await fetch(origin+'/__staging/login',{method:'POST',body:'login=owner&password=synthetic',headers:{'X-Forwarded-Host':admin,Origin:'https://'+admin},redirect:'manual'});assert.equal(r.status,303);assert.equal(seen,admin);const cookie=r.headers.get('Set-Cookie').split(';')[0];assert.ok(!cookie.includes('synthetic'));
  r=await fetch(origin+'/__staging/verify',{headers:{'X-Forwarded-Host':admin,Cookie:cookie},redirect:'manual'});assert.equal(r.status,204);
  r=await fetch(origin+'/__staging/verify',{headers:{'X-Forwarded-Host':'test.cashneuro.ru',Cookie:cookie},redirect:'manual'});assert.equal(r.status,302);
  r=await fetch(origin+'/__staging/verify',{headers:{'X-Forwarded-Host':admin,Cookie:'cashneuro_staging='+signSession(key)},redirect:'manual'});assert.equal(r.status,302);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
