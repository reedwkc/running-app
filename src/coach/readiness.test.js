// @ts-nocheck - window.storage test mocks intentionally implement only what's used
import { describe, expect, it, vi } from 'vitest';
import { computeReadinessSignal } from './readiness.js';

function mockStorage(map){
  window.storage = {get: vi.fn(async (key)=> map[key]!==undefined ? {value: JSON.stringify(map[key])} : null)};
}

// Mirrors training-load.test.js's flatHistory helper - builds N days of daily TRIMP points
// ending at (and including) real "today", since computeReadinessSignal calls computeACWR
// with no explicit asOfDateStr (defaults to the real current date).
function flatTrimpHistory(days, value, spikeLastDays, spikeValue){
  const today = new Date(); today.setHours(0,0,0,0);
  const points = [];
  for(let i=0;i<days;i++){
    const d = new Date(today); d.setDate(d.getDate()-i);
    const dateStr = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    points.push({date:dateStr, value: i<spikeLastDays ? spikeValue : value});
  }
  return points;
}

// 8-point trend history: first 3 = "older" comparison window, last 5 = "recent" - matches
// getTrendSummary's slice(-5)/slice(-10,-5) windows exactly (see tier-estimates.js).
function trendHistory(olderValue, recentValue, field){
  field = field || 'value';
  const points = [];
  for(let i=0;i<3;i++) points.push({date:'2026-0'+(i+1)+'-01', [field]: olderValue});
  for(let i=0;i<5;i++) points.push({date:'2026-0'+(i+4)+'-01', [field]: recentValue});
  return points;
}

describe('computeReadinessSignal', () => {
  it('returns insufficient-data when no trend/load history exists at all', async () => {
    mockStorage({});
    const r = await computeReadinessSignal();
    expect(r.status).toBe('insufficient-data');
    expect(r.evidence).toEqual([]);
  });

  it('flags overreaching from ACWR alone (High) even with no trend data', async () => {
    mockStorage({'trimp-history': flatTrimpHistory(28, 30, 7, 100)}); // steady base, sharp recent spike
    const r = await computeReadinessSignal();
    expect(r.acwr.status).toBe('High');
    expect(r.status).toBe('overreaching');
    expect(r.evidence.some(e=>e.includes('High'))).toBe(true);
  });

  it('reports detraining from ACWR alone (Low) with nothing else corroborating', async () => {
    mockStorage({'trimp-history': flatTrimpHistory(28, 40, 7, 5)}); // normal base, barely training this week
    const r = await computeReadinessSignal();
    expect(r.acwr.status).toBe('Low');
    expect(r.status).toBe('detraining');
  });

  it('does NOT flag overreaching from a single declining trend alone - needs corroboration', async () => {
    mockStorage({'hrrecovery-history': trendHistory(20, 15)}); // -25% - a real decline on its own
    const r = await computeReadinessSignal();
    expect(r.status).toBe('normal');
  });

  it('flags overreaching when 2 of 3 trend signals decline meaningfully, even with no ACWR data', async () => {
    mockStorage({
      'hrrecovery-history': trendHistory(20, 15), // -25%, declining
      'decoupling-history': trendHistory(4, 6),   // +50%, worsening
    });
    const r = await computeReadinessSignal();
    expect(r.status).toBe('overreaching');
    expect(r.evidence.length).toBe(2);
  });

  it('does not count a trend move smaller than the meaningful-change bar as declining', async () => {
    mockStorage({
      'hrrecovery-history': trendHistory(20, 19),  // -5%, below the bar
      'decoupling-history': trendHistory(4, 4.15), // ~+3.75%, below the bar
    });
    const r = await computeReadinessSignal();
    expect(r.status).toBe('normal');
  });

  it('efficiency trend uses its own polarity (declining = falling behind, not rising)', async () => {
    mockStorage({
      'efficiency-history': trendHistory(30, 25, 'ef'), // -16.7%, declining
      'hrrecovery-history': trendHistory(20, 15),        // -25%, declining
    });
    const r = await computeReadinessSignal();
    expect(r.status).toBe('overreaching');
  });

  it('an IMPROVING trend never counts toward overreaching', async () => {
    mockStorage({
      'hrrecovery-history': trendHistory(15, 20), // +33%, improving
      'decoupling-history': trendHistory(6, 4),   // -33%, improving (less fade)
    });
    const r = await computeReadinessSignal();
    expect(r.status).toBe('normal');
  });
});
