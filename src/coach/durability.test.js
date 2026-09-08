// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDurabilityAdjustedProjectionSec, DURABILITY_CADENCE_FADE_HEALTHY_PCT, DURABILITY_CADENCE_FADE_MODERATE_PCT, DURABILITY_DECOUPLING_HEALTHY_PCT, DURABILITY_DECOUPLING_MODERATE_PCT, formatDurabilityNote, getDurabilitySignal } from './durability.js';

function mockHistory({decoupling, cadenceFade}){
  window.storage = {
    get: vi.fn(async (key) => {
      if(key==='decoupling-history') return decoupling ? {value: JSON.stringify(decoupling)} : null;
      if(key==='cadence-fade-history') return cadenceFade ? {value: JSON.stringify(cadenceFade)} : null;
      return null;
    }),
  };
}

// getTrendSummary needs >=5 "recent" + >=3 "older" points to return a real read - build a
// history whose most recent 5 points all equal recentVal and whose next 5 back equal
// olderVal, so avgRecent/avgOlder land exactly on the values a test wants to assert against.
function buildHistory(recentVal, olderVal){
  const older = Array.from({length:5}, (_,i)=>({date:'2026-08-'+(10+i), value: olderVal}));
  const recent = Array.from({length:5}, (_,i)=>({date:'2026-08-'+(20+i), value: recentVal}));
  return older.concat(recent);
}

describe('getDurabilitySignal', () => {
  beforeEach(() => { window.storage = {get: vi.fn(async ()=>null)}; });

  it('returns insufficient-data when neither history has enough points', async () => {
    mockHistory({});
    const sig = await getDurabilitySignal();
    expect(sig.classification).toBe('insufficient-data');
    expect(sig.concerning).toBe(false);
  });

  it('classifies "good" when decoupling is at or below the healthy threshold', async () => {
    mockHistory({decoupling: buildHistory(DURABILITY_DECOUPLING_HEALTHY_PCT, DURABILITY_DECOUPLING_HEALTHY_PCT)});
    const sig = await getDurabilitySignal();
    expect(sig.classification).toBe('good');
    expect(sig.concerning).toBe(false);
    expect(sig.decoupling.avgRecent).toBe(DURABILITY_DECOUPLING_HEALTHY_PCT);
  });

  it('classifies "moderate" when decoupling sits between the healthy and moderate thresholds', async () => {
    mockHistory({decoupling: buildHistory(7, 7)});
    const sig = await getDurabilitySignal();
    expect(sig.classification).toBe('moderate');
    expect(sig.concerning).toBe(false);
  });

  it('classifies "poor" (concerning) when decoupling exceeds the moderate threshold', async () => {
    mockHistory({decoupling: buildHistory(DURABILITY_DECOUPLING_MODERATE_PCT+1, DURABILITY_DECOUPLING_MODERATE_PCT+1)});
    const sig = await getDurabilitySignal();
    expect(sig.classification).toBe('poor');
    expect(sig.concerning).toBe(true);
  });

  it('a poor cadence-fade reading escalates an otherwise-good decoupling read to poor - mechanical fatigue is not overridden by an OK HR:pace ratio', async () => {
    mockHistory({
      decoupling: buildHistory(3, 3), // well within healthy
      cadenceFade: buildHistory(DURABILITY_CADENCE_FADE_MODERATE_PCT+1, DURABILITY_CADENCE_FADE_MODERATE_PCT+1),
    });
    const sig = await getDurabilitySignal();
    expect(sig.classification).toBe('poor');
    expect(sig.concerning).toBe(true);
  });

  it('a moderate cadence-fade reading nudges a good decoupling read to moderate, but never downgrades a poor decoupling read', async () => {
    mockHistory({
      decoupling: buildHistory(3, 3),
      cadenceFade: buildHistory(DURABILITY_CADENCE_FADE_HEALTHY_PCT+0.5, DURABILITY_CADENCE_FADE_HEALTHY_PCT+0.5),
    });
    const sig = await getDurabilitySignal();
    expect(sig.classification).toBe('moderate');
  });

  it('cadence fade never makes a poor decoupling read look better', async () => {
    mockHistory({
      decoupling: buildHistory(DURABILITY_DECOUPLING_MODERATE_PCT+1, DURABILITY_DECOUPLING_MODERATE_PCT+1),
      cadenceFade: buildHistory(0.5, 0.5), // excellent cadence fade
    });
    const sig = await getDurabilitySignal();
    expect(sig.classification).toBe('poor');
  });
});

describe('computeDurabilityAdjustedProjectionSec', () => {
  it('returns null with no decoupling data', () => {
    expect(computeDurabilityAdjustedProjectionSec(6000, {decoupling:null}, 21.0975)).toBeNull();
  });

  it('returns null (no adjustment) when decoupling is at or below the healthy threshold', () => {
    const sig = {decoupling:{avgRecent: DURABILITY_DECOUPLING_HEALTHY_PCT}};
    expect(computeDurabilityAdjustedProjectionSec(6000, sig, 21.0975)).toBeNull();
  });

  it('slows the projection when decoupling exceeds the healthy threshold, proportional to the excess', () => {
    const distanceKm = 20;
    const pureProjectedSec = 6000; // even pace = 300s/km
    const sig = {decoupling:{avgRecent: 15}}; // 10 points of excess over the 5% healthy bar
    const adjusted = computeDurabilityAdjustedProjectionSec(pureProjectedSec, sig, distanceKm);
    // excessFraction = 0.10 -> second-half pace = 300*1.10 = 330s/km
    // adjusted = 10km*300 + 10km*330 = 3000+3300 = 6300
    expect(adjusted).toBe(6300);
    expect(adjusted).toBeGreaterThan(pureProjectedSec);
  });

  it('a larger decoupling excess produces a larger slowdown (monotonic)', () => {
    const mild = computeDurabilityAdjustedProjectionSec(6000, {decoupling:{avgRecent:8}}, 20);
    const severe = computeDurabilityAdjustedProjectionSec(6000, {decoupling:{avgRecent:20}}, 20);
    expect(severe).toBeGreaterThan(mild);
  });
});

describe('formatDurabilityNote', () => {
  it('reports insufficient data plainly when there is no signal yet', () => {
    expect(formatDurabilityNote(null)).toMatch(/not enough/i);
    expect(formatDurabilityNote({classification:'insufficient-data'})).toMatch(/not enough/i);
  });

  it('includes both decoupling and cadence-fade numbers when both are available', () => {
    const note = formatDurabilityNote({classification:'moderate', decoupling:{avgRecent:6.2}, cadenceFade:{avgRecent:3.1}});
    expect(note).toContain('6.2%');
    expect(note).toContain('3.1%');
    expect(note).toMatch(/moderate fade/i);
  });

  it('describes a poor classification as a genuine durability limiter', () => {
    const note = formatDurabilityNote({classification:'poor', decoupling:{avgRecent:14}, cadenceFade:null});
    expect(note).toMatch(/durability limiter/i);
  });
});
