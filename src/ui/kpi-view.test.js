// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { singleSeriesTrendHTML, tierTrendChartHTML } from './kpi-view.js';

describe('singleSeriesTrendHTML', () => {
  it('renders a valid SVG chart for a multi-point single series, matching tierTrendChartHTML directly', () => {
    const points = [
      {date:'2026-08-01', v:10},
      {date:'2026-08-05', v:12},
      {date:'2026-08-09', v:11},
    ];
    const direct = tierTrendChartHTML('Test', [{label:'Test', color:'#5FA85F', points}], v=>v+'x');
    const wrapped = singleSeriesTrendHTML('Test', points, '#5FA85F', v=>v+'x');
    expect(wrapped).toBe(direct);
    expect(wrapped).toContain('<svg');
    expect(wrapped).toContain('polyline');
    expect(wrapped).toContain('11x'); // last point's legend value, formatted
  });

  it('falls back to the "not enough history" message with zero points', () => {
    const html = singleSeriesTrendHTML('Test', [], '#5FA85F', v=>v);
    expect(html).toContain('Not enough history yet.');
  });

  it('draws a single dot (no polyline) for exactly one point', () => {
    const html = singleSeriesTrendHTML('Test', [{date:'2026-08-01', v:5}], '#5FA85F', v=>v);
    expect(html).toContain('<circle');
    expect(html).not.toContain('polyline');
  });
});
