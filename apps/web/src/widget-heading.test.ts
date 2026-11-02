import {test,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {WidgetHeading} from './WidgetHeading';
import {defaultOverview} from '../../../packages/finance-core/src/overview';
import type {WidgetResult} from '../../../packages/finance-core/src/overview';
test('period and comparison headings name each interval only once and identify the previous totals',()=>{const widget={...defaultOverview().widgets[0]!,headings:['total','period','comparison'] as ('total'|'period'|'comparison')[]},result={filter:{from:'2026-09-01',through:'2026-09-30'},comparisonFilter:{from:'2026-08-01',through:'2026-08-31'},totals:{expenses:'10000'},previousTotals:{expenses:'20000'}} as WidgetResult;const html=renderToStaticMarkup(createElement(WidgetHeading,{widget,result}));expect(html.match(/2026-09-01/g)).toHaveLength(1);expect(html.match(/2026-08-01/g)).toHaveLength(1);expect(html).toContain('Расходы за период сравнения');});
