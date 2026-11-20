import {appendFileSync,mkdirSync} from 'node:fs';
import type {Reporter,TestCase,TestResult} from '@playwright/test/reporter';

/** Emit synthetic test failures immediately, even if a later test times out. */
export default class ImmediateFailures implements Reporter {
 onTestEnd(test:TestCase,result:TestResult){
  if(result.status===test.expectedStatus||result.status==='skipped')return;
  const entry={test:test.titlePath(),file:test.location.file.split('/').slice(-3).join('/'),line:test.location.line,status:result.status,message:result.errors.map(e=>e.message??e.value??'').join('\n').slice(0,16000)};
  const line=JSON.stringify(entry);console.error('CI_CASE_FAILURE '+line);
  mkdirSync('test-results',{recursive:true});appendFileSync('test-results/ci-failures.ndjson',line+'\n');
 }
}
