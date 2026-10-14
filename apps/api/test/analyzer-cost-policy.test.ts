import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costPolicy } from '../src/analyzer-cost.ts';
const policy={projectId:'staging/finance/trial-20261014',projectPeriodStart:'2026-10-14T00:00:00Z',projectPeriodEnd:'2026-11-14T00:00:00Z',projectLimitRub:'1000',price:{version:'yandex-20261014',currency:'RUB',inputRubPerMillion:'800',outputRubPerMillion:'800'}};
test('cost configuration pins a versioned RUB tariff and explicit bounded project window',()=>{
  assert.deepEqual(costPolicy(policy),policy);
  for(const change of [{projectLimitRub:'1001'},{projectLimitRub:1000},{projectLimitRub:'0'},{projectPeriodEnd:policy.projectPeriodStart},{projectPeriodStart:'not-a-date'},{projectId:'secret\ntext'},{price:{...policy.price,currency:'USD'}},{arbitrary:'field'}])assert.throws(()=>costPolicy({...policy,...change}));
});
