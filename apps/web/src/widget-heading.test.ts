import {test,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {WidgetHeading} from './WidgetHeading';
import {defaultOverview} from '../../../packages/finance-core/src/overview';
import type {WidgetResult} from '../../../packages/finance-core/src/overview';
test('period and comparison headings name each interval only once and identify the previous totals',()=>{const widget={...defaultOverview().widgets[0]!,headings:['total','period','comparison'] as ('total'|'period'|'comparison')[]},result={filter:{from:'2026-09-01',through:'2026-09-30'},comparisonFilter:{from:'2026-08-01',through:'2026-08-31'},totals:{expenses:'10000'},previousTotals:{expenses:'20000'}} as WidgetResult;const html=renderToStaticMarkup(createElement(WidgetHeading,{widget,result}));expect(html.match(/01.09.2026/g)).toHaveLength(1);expect(html.match(/01.08.2026/g)).toHaveLength(1);expect(html).toContain('Расходы за период сравнения');});

test('operation-count totals appear once, with the same label and number style as other headings',()=>{const widget={...defaultOverview().widgets[0]!,metrics:['operation_count'] as const,headings:['total','count'] as const},result={filter:{},comparisonFilter:null,totals:{operation_count:'20'},previousTotals:{},operationCount:20} as WidgetResult;const html=renderToStaticMarkup(createElement(WidgetHeading,{widget:{...widget,metrics:[...widget.metrics],headings:[...widget.headings]},result}));expect(html.match(/Количество операций/g)).toHaveLength(1);expect(html.match(/>20</g)).toHaveLength(1);});
