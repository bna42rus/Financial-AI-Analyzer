"""Inspect the completion endpoint using an invalid, non-inference payload.

No prompts, model calls, secret values or raw provider error bodies are emitted.
Unlike GET /models this checks the endpoint actually used by the assistant.
"""
import json
import os
import subprocess

PROBE = r"""
import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
const path='/etc/cashneuro/ai/assistant-staging.json';
try {
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 let key;
 try {
  const s=await fd.stat();
  if(!s.isFile()||s.uid!==0||(s.mode&0o077)||s.nlink!==1||s.size>65536||await realpath(path)!==path)throw Error();
  const c=JSON.parse(await fd.readFile('utf8'));
  if(c.realm!=='staging/finance'||typeof c.apiKey!=='string'||!/^[\x21-\x7e]{20,512}$/.test(c.apiKey))throw Error();
  key=c.apiKey;
 }finally{await fd.close();}
 // model and messages are required. Their absence prevents inference.
 const r=await fetch('https://foundation-models.api.cloud.ru/v1/chat/completions',{
  method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},
  body:'{}',redirect:'error',signal:AbortSignal.timeout(12000)
 });
 const reader=r.body?.getReader();let value='',bytes=0;
 if(reader)try{while(bytes<16384){const p=await reader.read();if(p.done)break;bytes+=p.value.length;value+=new TextDecoder().decode(p.value.slice(0,16384-value.length));}}finally{await reader.cancel();}
 // Never reflect the body or credential, only an allowlisted diagnosis.
 const text=value.replaceAll(key,'').toLocaleLowerCase('ru');
 let reason='UNCLASSIFIED_PROVIDER_REJECTION';
 if([400,422].includes(r.status)&&/required|missing|validation|field|обязател|не указан/u.test(text))reason='INVALID_PAYLOAD_EXPECTED';
 else if(/expired|token_expired|key_expired|ист[её]к/u.test(text))reason='KEY_EXPIRED';
 else if(/not yet valid|not active|inactive key|неактив.*ключ/u.test(text))reason='KEY_INACTIVE';
 else if(/insufficient.*(?:fund|balance|credit|quota)|payment.required|недостаточно.*средств|баланс/u.test(text))reason='PROVIDER_BALANCE';
 else if(/guardrail|content.policy|moderation|content.filter/u.test(text))reason='PROVIDER_CONTENT_POLICY';
 else if(/account.*(?:block|suspend)|blocked.account|аккаунт.*заблок/u.test(text))reason='PROVIDER_ACCOUNT_BLOCKED';
 else if(/project.*(?:block|disable|not.found)|service.*not.enabled/u.test(text))reason='PROJECT_OR_SERVICE_UNAVAILABLE';
 else if(/invalid.*(?:api.key|token|credential)|(?:api.key|token).*invalid|key.*not.found|unauthoriz|unauthentic/u.test(text))reason='CREDENTIAL_REJECTED';
 else if(/permission|forbidden|access.denied|not.allowed|недостаточно.*прав/u.test(text))reason='ACCESS_DENIED';
 // A catalog lookup is useful connectivity/model evidence, not a paid inference
 // and not proof that a valid completion request will be accepted.
 const catalog={catalogHttpStatus:null,catalogRequestSucceeded:false,gptOss120bAvailable:null};
 try{
  const response=await fetch('https://foundation-models.api.cloud.ru/v1/models',{
   headers:{authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(12000)
  });
  catalog.catalogHttpStatus=response.status;
  if(response.ok){
   const cr=response.body?.getReader();let size=0,parts=[];
   if(!cr)throw Error();
   try{while(true){const part=await cr.read();if(part.done)break;size+=part.value.length;if(size>524288)throw Error();parts.push(part.value);}}finally{await cr.cancel();}
   const data=JSON.parse(Buffer.concat(parts).toString('utf8'));
   catalog.catalogRequestSucceeded=Array.isArray(data.data);
   catalog.gptOss120bAvailable=Array.isArray(data.data)&&data.data.some(x=>x.id==='openai/gpt-oss-120b');
  }else{await response.body?.cancel();}
 }catch(error){catalog.catalogCheckError=error?.name==='TimeoutError'?'TIMEOUT':'CONNECTION_OR_RESPONSE_FAILED';}
 let providerErrorEnvelope=[];
 try{const body=JSON.parse(value);if(body&&typeof body==='object')providerErrorEnvelope=['error','errors','detail','message','code','type','status'].filter(k=>Object.hasOwn(body,k));}catch{}
 console.log(JSON.stringify({probe:'completion-endpoint-invalid-payload/1',httpStatus:r.status,reason,providerErrorEnvelope,...catalog,modelCalls:0}));
}catch(e){
 console.log(JSON.stringify({probe:'completion-endpoint-invalid-payload/1',reason:e?.name==='TimeoutError'?'TIMEOUT':'CONNECTION_OR_CONFIG_FAILED',modelCalls:0}));
 process.exitCode=1;
}
"""


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('Run this inspection with sudo')
    result = subprocess.run(['/usr/bin/node', '--input-type=module', '-'], input=PROBE,
                            text=True, capture_output=True, timeout=35, check=False)
    try:
        report = json.loads(result.stdout)
    except ValueError:
        report = {'reason': 'PROBE_FAILED', 'modelCalls': 0}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(result.returncode)
