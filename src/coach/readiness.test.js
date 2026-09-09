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
// sessionType is carried on every real point these histories store, and HR-recovery/
// time-to-target are now read with a sessionTypes filter (they are only defined between hard
// reps - see getTrendSummary). Fixtures model that shape so the tests exercise the real
// contract rather than an untyped series that no longer occurs in practice.
function trendHistory(olderValue, recentValue, field, sessionType){
  field = field || 'value';
  sessionType = sessionType || 'threshold';
  const points = [];
  for(let i=0;i<3;i++) points.push({date:'2026-0'+(i+1)+'-01', sessionType, [field]: olderValue});
  for(let i=0;i<5;i++) points.push({date:'2026-0'+(i+4)+'-01', sessionType, [field]: recentValue});
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

describe('rep-only trends must not blend in sessions where they are undefined', () => {
  it('ignores easy-run HR-recovery points, which are not a recovery-between-reps measurement at all', async () => {
    // Exactly the shape found in real logged data: four interval sessions (~20bpm drop after
    // a rep) followed by easy runs whose single "recovery" lap read -4 to +5bpm - HR barely
    // falling, or rising. Blended, that reads as "HR recovery collapsing 80%"; filtered, the
    // easy points are correctly not evidence of anything.
    mockStorage({'hrrecovery-history': [
      {date:'2026-08-11', value:17.8, sessionType:'threshold', sampleSize:4},
      {date:'2026-08-13', value:28.2, sessionType:'vo2max', sampleSize:6},
      {date:'2026-08-17', value:24, sessionType:'threshold', sampleSize:5},
      {date:'2026-08-19', value:20, sessionType:'threshold', sampleSize:6},
      {date:'2026-08-26', value:-4, sessionType:'easy', sampleSize:1},
      {date:'2026-08-27', value:-4, sessionType:'easy', sampleSize:1},
      {date:'2026-09-01', value:4, sessionType:'easy', sampleSize:1},
      {date:'2026-09-02', value:28.2, sessionType:'vo2max', sampleSize:5},
      {date:'2026-09-04', value:5, sessionType:'easy', sampleSize:1},
    ]});
    const r = await computeReadinessSignal();
    // Only 5 interval points remain - below the 6-point minimum - so the honest answer is no
    // trend at all, rather than a confident collapse built out of incomparable measurements.
    expect(r.hrRecoveryTrend).toBeNull();
    expect(r.status).not.toBe('overreaching');
  });
});
