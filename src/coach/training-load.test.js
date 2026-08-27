// @ts-nocheck - window.storage test mocks intentionally implement only what's used
import { describe, expect, it, vi } from 'vitest';
import { computeACWR, loadTrimpHistory } from './training-load.js';

// Builds N days of flat daily TRIMP points ending at (and including) asOf. Formats each
// date from local Y/M/D components, not toISOString() (which converts to UTC) - computeACWR
// itself parses date strings as local midnight (see daysBetween), so building test dates
// via UTC would silently drift by a day in any timezone not already at UTC+0.
function flatHistory(days, value, asOf){
  const end = new Date(asOf+'T00:00:00');
  const points = [];
  for(let i=0;i<days;i++){
    const d = new Date(end); d.setDate(d.getDate()-i);
    const dateStr = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    points.push({date: dateStr, value});
  }
  return points;
}

describe('computeACWR', () => {
  const asOf = '2026-08-27';

  it('returns null with less than the minimum history window (too early for a meaningful ratio)', () => {
    const points = flatHistory(10, 50, asOf); // only 10 days of history
    expect(computeACWR(points, asOf)).toBeNull();
  });

  it('returns null for empty/missing history', () => {
    expect(computeACWR([], asOf)).toBeNull();
    expect(computeACWR(null, asOf)).toBeNull();
  });

  it('reports ratio ~1.0 ("Optimal") when load has been flat for weeks', () => {
    const points = flatHistory(28, 50, asOf);
    const result = computeACWR(points, asOf);
    expect(result).not.toBeNull();
    expect(result.ratio).toBeCloseTo(1.0, 1);
    expect(result.status).toBe('Optimal');
  });

  it('flags a sharp recent spike as "High" even with a long steady base', () => {
    // Steady 30/day base for 28 days, then the last 7 days ramped way up.
    const points = flatHistory(28, 30, asOf).map(p=>{
      const age = Math.round((new Date(asOf+'T00:00:00') - new Date(p.date+'T00:00:00'))/86400000);
      return age < 7 ? {date:p.date, value:100} : p;
    });
    const result = computeACWR(points, asOf);
    expect(result.ratio).toBeGreaterThan(1.3);
    expect(result.status).toBe('High');
  });

  it('flags a long layoff followed by only a couple of easy days as "Low"', () => {
    const points = flatHistory(28, 40, asOf).map(p=>{
      const age = Math.round((new Date(asOf+'T00:00:00') - new Date(p.date+'T00:00:00'))/86400000);
      return age < 7 ? {date:p.date, value:5} : p; // barely training this week after a normal base
    });
    const result = computeACWR(points, asOf);
    expect(result.ratio).toBeLessThan(0.8);
    expect(result.status).toBe('Low');
  });

  it('ignores points dated after asOf (no peeking at the future)', () => {
    const points = flatHistory(28, 50, asOf);
    points.push({date:'2026-09-15', value:9999});
    const result = computeACWR(points, asOf);
    expect(result.ratio).toBeCloseTo(1.0, 1);
  });

  it('defaults asOf to today when not given', () => {
    const today = new Date().toISOString().slice(0,10);
    const points = flatHistory(28, 50, today);
    const result = computeACWR(points);
    expect(result).not.toBeNull();
  });
});

describe('loadTrimpHistory', () => {
  it('returns the parsed history array', async () => {
    window.storage = {get: vi.fn(async ()=>({value: JSON.stringify([{date:'2026-08-01', value:42}])}))};
    const hist = await loadTrimpHistory();
    expect(hist).toEqual([{date:'2026-08-01', value:42}]);
  });

  it('returns an empty array when nothing is stored yet', async () => {
    window.storage = {get: vi.fn(async ()=>null)};
    expect(await loadTrimpHistory()).toEqual([]);
  });
});
