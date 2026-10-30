import {test,expect} from 'vitest';
import {parseNavigationPreferences,initialFinanceHash,initialPeriod} from './navigation-preferences';
test('explicit links and logo win over start screen; last-used accepts only finite main routes',()=>{
 const p={startScreen:'last' as const,defaultPeriod:'all' as const};
 expect(initialFinanceHash('#overview',p,'analyzer')).toBe('#overview');expect(initialFinanceHash('#settings/interface',p,'analyzer')).toBe('#settings/interface');
 expect(initialFinanceHash('',p,'operations')).toBe('#operations');expect(initialFinanceHash('',p,'settings')).toBe('#overview');expect(initialFinanceHash('',{...p,startScreen:'analyzer'})).toBe('#analyzer');
});
test('initial period uses the user date and is inclusive across month/year boundaries',()=>{
 const now=new Date('2026-01-01T01:00:00Z');
 expect(initialPeriod('current_month',now,'Pacific/Honolulu')).toEqual({from:'2025-12-01',through:'2025-12-31'});
 expect(initialPeriod('current_year',now,'Asia/Vladivostok')).toEqual({from:'2026-01-01',through:'2026-01-01'});
 expect(initialPeriod('last_30_days',now,'Asia/Vladivostok')).toEqual({from:'2025-12-03',through:'2026-01-01'});expect(initialPeriod('all',now,'Etc/UTC')).toEqual({from:'',through:''});
});
test('a corrupt or widened preference cannot become a route, filter or record store',()=>{
 for(const v of [null,[],{startScreen:'https://example.test',defaultPeriod:'all'},{startScreen:'overview',defaultPeriod:'fixed',from:'2026-01-01'},{startScreen:'overview',defaultPeriod:'all',operationIds:['x']}])expect(parseNavigationPreferences(v)).toEqual({startScreen:'overview',defaultPeriod:'all'});
});
