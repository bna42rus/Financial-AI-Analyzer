import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

// Test the installed dependency used by both Vite applications, not a copy.
for (const app of ['web', 'admin']) {
  const appRequire = createRequire(new URL(`../apps/${app}/package.json`, import.meta.url));
  const picomatch = createRequire(appRequire.resolve('vite'))('picomatch');
  for (const pattern of ['+(*)', '+(*a)', '*(*)', '*(a*)']) {
    for (const options of [{}, {fastpaths: false}, {maxExtglobRecursion: false}, {capture: true}]) {
      const regex = picomatch.makeRe(pattern, options);
      // Check literalization before exercising the pathological input. This
      // assertion fails immediately if the patch is missing, without hanging CI.
      assert.ok(regex.source.includes(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${app}: unguarded ${pattern}`);
      assert.ok(regex.test(pattern));
      assert.equal(regex.test('a'.repeat(100_000) + '!'), false);
    }
  }
  for (const [pattern, input, expected] of [
    ['**/*.ts', 'src/main.ts', true], ['**/*.ts', 'src/main.js', false],
    ['**/*.@(spec|test).?(c|m)[jt]s?(x)', 'e2e/check.spec.ts', true],
    ['+(ab)', 'abab', true], ['+(ab)', 'aba', false], ['*(a)', 'aaa', true],
    ['!(foo)', 'bar', true], ['!(foo)', 'foo', false],
  ]) assert.equal(picomatch(pattern)(input), expected, `${app}: ${pattern} / ${input}`);
}
console.log('Installed picomatch security guard and supported glob semantics passed.');
