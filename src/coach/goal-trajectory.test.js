// @ts-nocheck - window.storage test mocks intentionally implement only what's used
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../state.js';
import { defaultGoalConfig } from '../data/goal-config.js';
import { buildWeeks } from '../data/plan.js';
import {
  buildMergedLTPaceSeries, clampAIPositionToBaseline, computeBuildDaysBreakdown, computeGoalAchievability, computeGoalPosition, computeGoalProgress, computeHMTrajectoryBaseline, compute10KTrajectoryBaseline, computeLTPaceTrendRate, computeMaintenanceBaseline, computeMaintenanceTrend, getBestAvailableLTPace, goalTrackerHTML, impliedLTPaceForGoal, projectedTimeFromLTPace, recomputeZones,
} from './goal-trajectory.js';

describe('computeMaintenanceTrend (raceless maintenance phase - takes a real per-week rate, not a fragile two-point comparison)', () => {
  it('reads as holding steady at rate 0', () => {
    const {position, status} = computeMaintenanceTrend(0);
    expect(status).toBe('holding steady');
    expect(position).toBe(50);
  });

  it('reads as improving for a meaningfully positive rate (pace getting faster)', () => {
    const {position, status} = computeMaintenanceTrend(1.5); // sec/km/week
    expect(status).toBe('improving');
    expect(position).toBeGreaterThan(67);
  });

  it('reads as declining for a meaningfully negative rate (pace getting slower)', () => {
    const {position, status} = computeMaintenanceTrend(-1.5);
    expect(status).toBe('declining');
    expect(position).toBeLessThan(33);
  });

  it('returns a neutral sentinel when the rate is null (not enough data)', () => {
    expect(computeMaintenanceTrend(null)).toEqual({position:50, status:'neutral'});
  });
});

describe('computeMaintenanceBaseline (merges Tier 1/2/3 history, real trend rate)', () => {
  it('returns a neutral sentinel when there is no LT pace at all', async () => {
    // state.profile is shared module state that other describe blocks' beforeEach hooks may
    // have already populated - clear it explicitly so getBestAvailableLTPace's Tier 1
    // fallback can't mask the "no pace anywhere" case this test means to exercise.
    state.profile = {lthr:null, ltPaceSec:null, maxHR:null, vo2max:null, restHR:null};
    window.storage = {get: vi.fn().mockResolvedValue(null)};
    const baseline = await computeMaintenanceBaseline();
    expect(baseline).toMatchObject({position:50, status:'neutral'});
    expect(baseline.label).toContain('Not enough threshold data');
  });

  it('computes a real trend from merged Tier 1/2/3 history, not Tier 1 alone - a maintenance phase relying on fresh Tier 3 (treadmill) data mid-winter would otherwise be judged off stale Tier 1 updates', async () => {
    const daysAgo = n => new Date(Date.now()-n*86400000).toISOString();
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([{ltPaceSec:280, date:daysAgo(45)}])};
        if(key==='tier2-history') return {value: JSON.stringify([{ltPaceSec:276, date:daysAgo(30)}])};
        if(key==='tier3-history') return {value: JSON.stringify([{ltPaceSec:272, date:daysAgo(15)}, {ltPaceSec:268, date:daysAgo(1)}])};
        return null;
      }),
    };
    const baseline = await computeMaintenanceBaseline();
    expect(baseline.trend).not.toBeNull();
    expect(baseline.trend.rateSecPerWeek).toBeGreaterThan(0); // pace decreasing over time = improving
    expect(baseline.status).toBe('improving');
    expect(baseline.label).toContain('trending up');
  });

  it('falls back to a neutral-leaning "not enough data" label when a real LT pace exists but recent history is too thin to trend', async () => {
    window.storage = {
      get: vi.fn(async (key) => key==='profile-history' ? {value: JSON.stringify([{ltPaceSec:275, date:new Date().toISOString()}])} : null),
    };
    const baseline = await computeMaintenanceBaseline();
    expect(baseline.trend).toBeNull();
    expect(baseline.status).toBe('neutral');
    expect(baseline.label).toContain('Not enough clean, recent pace history');
  });
});

describe('impliedLTPaceForGoal / projectedTimeFromLTPace (Riegel formula)', () => {
  it('round-trips: the LT pace implied by a goal time projects back to roughly that goal time', () => {
    const goalTotalSec = 95*60; // sub-1:35 half marathon
    const ltPace = impliedLTPaceForGoal(goalTotalSec, 21.0975);
    const projectedSec = projectedTimeFromLTPace(ltPace, 21.0975);
    expect(projectedSec).toBeCloseTo(goalTotalSec, 0);
  });

  it('a faster LT pace projects to a faster race time at the same distance', () => {
    const slower = projectedTimeFromLTPace(280, 21.0975);
    const faster = projectedTimeFromLTPace(270, 21.0975);
    expect(faster).toBeLessThan(slower);
  });

  it('projects a longer time for a longer distance at the same LT pace', () => {
    const tenK = projectedTimeFromLTPace(275, 10);
    const half = projectedTimeFromLTPace(275, 21.0975);
    expect(half).toBeGreaterThan(tenK);
  });
});

describe('computeGoalPosition (replaces computeTrajectoryPosition - takes elapsedFrac directly, taper-aware elsewhere via computeBuildDaysBreakdown)', () => {
  it('reads as exactly 50 (on track) when the current gap exactly matches the expected linear closure', () => {
    // 20s/km behind at the start, halfway through the schedule the expected gap has
    // halved to 10 - a current gap of exactly 10 means right on schedule.
    const {position, status} = computeGoalPosition(20, 0.5, 10, 21.0975);
    expect(position).toBe(50);
    expect(status).toBe('on track');
  });

  it('reads as ahead when the current gap has closed faster than the schedule requires', () => {
    const {position, status} = computeGoalPosition(20, 0.5, -5, 21.0975);
    expect(position).toBeGreaterThan(67);
    expect(status).toBe('ahead');
  });

  it('reads as behind when the current gap has not closed at all despite being halfway through', () => {
    const {position, status} = computeGoalPosition(20, 0.5, 20, 21.0975);
    expect(position).toBeLessThan(33);
    expect(status).toBe('behind');
  });

  it('clamps position to [0,100] for extreme gaps', () => {
    expect(computeGoalPosition(20, 0.5, 500, 21.0975).position).toBe(0);
    expect(computeGoalPosition(20, 0.5, -500, 21.0975).position).toBe(100);
  });

  it('does not throw for elapsedFrac outside [0,1] - clamps instead', () => {
    expect(Number.isFinite(computeGoalPosition(20, 5, 10, 21.0975).position)).toBe(true);
    expect(Number.isFinite(computeGoalPosition(20, -1, 10, 21.0975).position)).toBe(true);
  });

  it('reproduces the original live bug and confirms the fix: a big original gap that has closed a lot reads "ahead" under a RAW (taper-diluted) elapsedFrac, but "on track" (not ahead) once elapsedFrac correctly excludes an active taper - the exact "strong ahead, 13 days out, still slower than goal" scenario', () => {
    // 150s/km behind at block start, now only 5s/km behind (105s over the full HM distance -
    // a real, meaningful gap, not noise). A RAW calendar elapsedFrac (diluted by a taper week
    // that shouldn't count as "the gap should already be closed") of 0.768 reads ahead:
    const raw = computeGoalPosition(150, 0.768, 5, 21.0975);
    expect(raw.position).toBeGreaterThan(67);
    expect(raw.status).toBe('ahead');
    // The SAME inputs, but with elapsedFrac computed the taper-aware way (real build-days
    // elapsed / real build-days total, excluding the upcoming taper week - see
    // computeBuildDaysBreakdown) land meaningfully lower, at 0.878 here, and correctly do NOT
    // read ahead - this is the actual fix, not a hardcoded near-race ceiling.
    const fixed = computeGoalPosition(150, 0.878, 5, 21.0975);
    expect(fixed.position).toBeLessThan(67);
    expect(fixed.status).not.toBe('ahead');
  });

  it('normFactor floor scales with race distance via MEANINGFUL_FINISH_GAP_SEC, not a flat unrelated constant - a small original gap is more sensitive for a longer race', () => {
    // startGapSec small enough that normFactor's floor (not the *0.5 term) binds for both
    // distances (60/21.0975≈2.85, 60/10=6, both > abs(2)*0.5=1).
    // elapsedFrac=1 -> expectedGapNow=0 exactly, so aheadBehind is driven purely by currentGapSec.
    expect(computeGoalPosition(2, 1, 0, 21.0975).position).toBe(50); // aheadBehind=0 -> on track regardless of floor
    const hmAhead = computeGoalPosition(2, 1, -2, 21.0975).position; // aheadBehind=2
    const tenKAhead = computeGoalPosition(2, 1, -2, 10).position;    // same aheadBehind=2, bigger floor
    expect(hmAhead).toBeGreaterThan(tenKAhead); // smaller floor (HM) -> more sensitive -> swings further
  });
});

describe('computeBuildDaysBreakdown (taper-aware time, excludes cutback:true weeks)', () => {
  const startDate = new Date(2026, 7, 1);   // Aug 1
  const raceDate = new Date(2026, 7, 21);   // Aug 21 - a clean 20-day window
  const now = new Date(2026, 7, 15);        // Aug 15 - 14 days elapsed of 20

  it('counts every day as build time when no weeks are given (degrades to plain calendar counting)', () => {
    const r = computeBuildDaysBreakdown(null, startDate, raceDate, now);
    expect(r.buildDaysTotal).toBe(20);
    expect(r.buildDaysElapsed).toBe(14);
    expect(r.buildDaysRemaining).toBe(6);
    expect(r.elapsedFrac).toBeCloseTo(14/20, 5);
  });

  it('excludes a cutback:true week\'s days from both the total and elapsed build-day counts', () => {
    const weeks = [
      {n:1, dates:'Aug 1-14', cutback:false},
      {n:2, dates:'Aug 15-21', cutback:true}, // the final week is a taper - not build time
    ];
    const r = computeBuildDaysBreakdown(weeks, startDate, raceDate, now);
    // The window is [Aug 1, Aug 21) - raceDate itself is the exclusive end, so only Aug 1-20
    // (20 days) are ever counted; the cutback week only overlaps that window on Aug 15-20 (6
    // days), leaving 14 real build days (Aug 1-14).
    expect(r.buildDaysTotal).toBe(14);
    // "now" (Aug 15) sits right at the taper's start - all 14 build days (Aug 1-14) are
    // already in the past relative to Aug 15.
    expect(r.buildDaysElapsed).toBe(14);
    expect(r.buildDaysRemaining).toBe(0);
    expect(r.elapsedFrac).toBe(1);
  });

  it('a taper week freezes elapsedFrac higher than the raw calendar fraction would show', () => {
    const weeks = [
      {n:1, dates:'Aug 1-14', cutback:false},
      {n:2, dates:'Aug 15-21', cutback:true},
    ];
    const raw = computeBuildDaysBreakdown(null, startDate, raceDate, now).elapsedFrac; // 0.7
    const taperAware = computeBuildDaysBreakdown(weeks, startDate, raceDate, now).elapsedFrac; // 1.0
    expect(taperAware).toBeGreaterThan(raw);
  });

  it('does not throw and returns elapsedFrac 1 for a zero-length window (startDate===raceDate)', () => {
    const same = new Date(2026, 7, 1);
    const r = computeBuildDaysBreakdown(null, same, same, now);
    expect(Number.isFinite(r.elapsedFrac)).toBe(true);
    expect(r.buildDaysTotal).toBe(0);
  });
});

describe('buildMergedLTPaceSeries', () => {
  const weeks = [{n:1, dates:'Aug 1-7', cutback:false}, {n:2, dates:'Aug 8-14', cutback:true}];

  it('merges and date-sorts points across all three tiers', () => {
    const tier1 = [{date:'2026-08-03', ltPaceSec:280}];
    const tier2 = [{date:'2026-08-01', ltPaceSec:275}];
    const tier3 = [{date:'2026-08-05', ltPaceSec:270}];
    const series = buildMergedLTPaceSeries(tier1, tier2, tier3, weeks, null);
    expect(series.map(p=>p.ltPaceSec)).toEqual([275, 280, 270]); // sorted by date, not by tier
  });

  it('excludes a point whose date falls inside a cutback:true week', () => {
    const tier1 = [{date:'2026-08-03', ltPaceSec:280}, {date:'2026-08-10', ltPaceSec:270}]; // Aug 10 is in the cutback week
    const series = buildMergedLTPaceSeries(tier1, null, null, weeks, null);
    expect(series.length).toBe(1);
    expect(series[0].ltPaceSec).toBe(280);
  });

  it('includes a point outside any known week (unknown defaults to counted)', () => {
    const tier1 = [{date:'2026-09-01', ltPaceSec:265}]; // outside both weeks entirely
    const series = buildMergedLTPaceSeries(tier1, null, null, weeks, null);
    expect(series.length).toBe(1);
  });

  it('always includes extraPoints, even when their date falls inside a cutback week', () => {
    const extra = [{date: new Date(2026, 7, 10), ltPaceSec:260}]; // Aug 10, inside the cutback week
    const series = buildMergedLTPaceSeries(null, null, null, weeks, extra);
    expect(series.length).toBe(1);
    expect(series[0].ltPaceSec).toBe(260);
  });

  it('ignores malformed points (no ltPaceSec or no date) rather than throwing', () => {
    const tier1 = [{date:'2026-08-03'}, {ltPaceSec:280}, null];
    expect(() => buildMergedLTPaceSeries(tier1, null, null, weeks, null)).not.toThrow();
    expect(buildMergedLTPaceSeries(tier1, null, null, weeks, null)).toEqual([]);
  });
});

describe('computeLTPaceTrendRate (median-split, sec/km/week, positive = improving)', () => {
  const pointsOver = (days, paces) => paces.map((p,i)=>({date:new Date(2026,7,1+Math.round(i*days/(paces.length-1))), ltPaceSec:p}));

  it('returns null below the minimum point count', () => {
    expect(computeLTPaceTrendRate(pointsOver(20, [280,275,270]))).toBeNull();
  });

  it('returns null below the minimum date span even with enough points', () => {
    expect(computeLTPaceTrendRate(pointsOver(5, [280,278,276,274]))).toBeNull();
  });

  it('reads a positive rate (improving) for a genuinely improving series', () => {
    const trend = computeLTPaceTrendRate(pointsOver(28, [285,280,275,270]));
    expect(trend).not.toBeNull();
    expect(trend.rateSecPerWeek).toBeGreaterThan(0);
    expect(trend.pointCount).toBe(4);
    expect(trend.spanDays).toBe(28);
  });

  it('reads a negative rate (slowing) for a genuinely worsening series', () => {
    const trend = computeLTPaceTrendRate(pointsOver(28, [270,272,276,280]));
    expect(trend.rateSecPerWeek).toBeLessThan(0);
  });

  it('a single wild outlier session does not swing the median-split rate much (the concrete case for median over a least-squares regression)', () => {
    const clean = computeLTPaceTrendRate(pointsOver(28, [285,280,278,276,274,270]));
    const withOutlier = computeLTPaceTrendRate(pointsOver(28, [285,280,278,400,274,270])); // one wildly bad reading
    expect(Math.abs(withOutlier.rateSecPerWeek - clean.rateSecPerWeek)).toBeLessThan(Math.abs(clean.rateSecPerWeek)); // outlier shifts it, but not past its own clean magnitude
  });
});

describe('computeGoalAchievability', () => {
  const distanceKm = 21.0975; // meaningfulGapPerKm ≈ 2.846

  it('classifies a trivial/negative gap as already-there, regardless of time or trend', () => {
    expect(computeGoalAchievability(0, 20, 5, distanceKm).classification).toBe('already-there');
    expect(computeGoalAchievability(-5, 20, 5, distanceKm).classification).toBe('already-there');
    expect(computeGoalAchievability(1, 20, 5, distanceKm).classification).toBe('already-there'); // 1 < 2.846 floor
  });

  it('classifies no real build days left with a real gap open as not-enough-time', () => {
    const a = computeGoalAchievability(10, 0, 5, distanceKm);
    expect(a.classification).toBe('not-enough-time');
  });

  it('classifies a real gap with real time left but no trend data as insufficient-data', () => {
    const a = computeGoalAchievability(10, 21, null, distanceKm);
    expect(a.classification).toBe('insufficient-data');
  });

  it('classifies a flat or worsening trend despite real time left as not-closing', () => {
    expect(computeGoalAchievability(10, 21, 0, distanceKm).classification).toBe('not-closing');
    expect(computeGoalAchievability(10, 21, -1, distanceKm).classification).toBe('not-closing');
  });

  it('classifies a trend at or above the required rate as on-pace', () => {
    // gap 10s/km over 21 build days (=3 weeks) -> required ~3.33s/km/week
    const a = computeGoalAchievability(10, 21, 4, distanceKm);
    expect(a.classification).toBe('on-pace');
    expect(a.accelerationFactor).toBeGreaterThan(1);
  });

  it('classifies a trend below the required rate as needs-to-accelerate, with the right accelerationFactor', () => {
    // required ~3.33s/km/week, observed only 1 -> needs to run ~3.33x faster
    const a = computeGoalAchievability(10, 21, 1, distanceKm);
    expect(a.classification).toBe('needs-to-accelerate');
    expect(a.accelerationFactor).toBeCloseTo(10/(21/7)/1, 2);
  });
});

describe('getBestAvailableLTPace (tier-merge logic)', () => {
  beforeEach(() => {
    state.profile = {lthr:171, ltPaceSec:275, maxHR:191, vo2max:53, restHR:40};
  });

  it('falls back to the Tier 1 (Garmin) profile pace when no history or tier estimates exist', async () => {
    window.storage = {get: vi.fn().mockResolvedValue(null)};
    const best = await getBestAvailableLTPace();
    expect(best).toEqual({source:'tier1', ltPaceSec:275, updatedAt:null});
  });

  it('picks a fresh, non-stale tier2 over the tier1 profile when tier1 is not actually faster', async () => {
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([{ltPaceSec:275, date:'2026-07-01'}])};
        if(key==='tier2-estimate') return {value: JSON.stringify({ltPaceSec:270, updatedAt:'2026-08-10'})};
        if(key==='tier3-estimate') return {value: JSON.stringify({ltPaceSec:268, updatedAt:'2026-08-05'})};
        return null;
      }),
    };
    const best = await getBestAvailableLTPace();
    expect(best.source).toBe('tier2');
    expect(best.ltPaceSec).toBe(270);
  });

  it('picks the fresher of tier2/tier3 (tier3) when both are solid and neither is stale, still ruling over a non-faster tier1', async () => {
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='tier2-estimate') return {value: JSON.stringify({ltPaceSec:270, updatedAt:'2026-07-01'})};
        if(key==='tier3-estimate') return {value: JSON.stringify({ltPaceSec:268, updatedAt:'2026-08-10'})};
        return null;
      }),
    };
    const best = await getBestAvailableLTPace();
    expect(best.source).toBe('tier3');
    expect(best.ltPaceSec).toBe(268);
  });

  it('lets a Tier 1 (Garmin) update win only when it is genuinely FASTER than the solid Tier 2/3 read, not merely more recent - the direct fix for "a fresh Garmin update should not outrank a solid tier2 unless it reflects better fitness"', async () => {
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([
          {ltPaceSec:275, date:'2026-08-05T08:00:00.000Z'},
          {ltPaceSec:251, date:'2026-08-20T08:00:00.000Z'}, // genuinely faster than tier2 below
        ])};
        if(key==='tier2-estimate') return {value: JSON.stringify({ltPaceSec:262, updatedAt:'2026-08-17T10:00:00.000Z'})};
        return null;
      }),
    };
    const best = await getBestAvailableLTPace();
    expect(best.source).toBe('tier1');
    expect(best.ltPaceSec).toBe(251);
  });

  it('does NOT let a fresher-but-not-faster Tier 1 update outrank a solid, non-stale Tier 2 read, even though Tier 1 genuinely changed value and did so after Tier 2', async () => {
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([
          {ltPaceSec:275, date:'2026-08-05T08:00:00.000Z'},
          {ltPaceSec:265, date:'2026-08-20T08:00:00.000Z'}, // a real Garmin update, but still slower than tier2's 262
        ])};
        if(key==='tier2-estimate') return {value: JSON.stringify({ltPaceSec:262, updatedAt:'2026-08-17T10:00:00.000Z'})};
        return null;
      }),
    };
    const best = await getBestAvailableLTPace();
    expect(best.source).toBe('tier2');
    expect(best.ltPaceSec).toBe(262);
  });

  it('falls back to plain recency once the best Tier 2/3 read has gone stale, so an old tier2 estimate cannot rule forever over a much newer Tier 1 read', async () => {
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([{ltPaceSec:265, date:'2026-08-15T08:00:00.000Z'}])};
        if(key==='tier2-estimate') return {value: JSON.stringify({ltPaceSec:262, updatedAt:'2026-05-01T10:00:00.000Z'})}; // well over the staleness window
        return null;
      }),
    };
    const best = await getBestAvailableLTPace();
    expect(best.source).toBe('tier1');
    expect(best.ltPaceSec).toBe(265);
  });

  it('ignores a tier estimate with no ltPaceSec set', async () => {
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='tier2-estimate') return {value: JSON.stringify({updatedAt:'2026-08-10'})}; // no ltPaceSec
        return null;
      }),
    };
    const best = await getBestAvailableLTPace();
    expect(best.source).toBe('tier1');
  });

  it('does not let a same-value Tier 1 re-save (e.g. VO2max-only update) outrank a genuinely more recent Tier 2 read - the exact live bug: LT pace unchanged at 275 but re-saved after Tier 2 updated to 262 on the same day', async () => {
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([
          {ltPaceSec:275, date:'2026-08-05T08:00:00.000Z'},
          {ltPaceSec:275, date:'2026-08-17T20:02:44.181Z'}, // vo2max-only re-save, ltPaceSec unchanged
        ])};
        if(key==='tier2-estimate') return {value: JSON.stringify({ltPaceSec:262, updatedAt:'2026-08-17T10:00:00.000Z'})};
        return null;
      }),
    };
    const best = await getBestAvailableLTPace();
    expect(best.source).toBe('tier2');
    expect(best.ltPaceSec).toBe(262);
  });

});

describe('recomputeZones (prescribed session paces anchored to best-available LT pace, not raw Tier 1)', () => {
  beforeEach(() => {
    state.profile = {lthr:171, ltPaceSec:275, maxHR:191, vo2max:53, restHR:40};
  });

  it('anchors S1-S4 to a solid Tier 2 read instead of the raw Tier 1 profile pace - the direct fix for "Tier 2 must also overwrite the prescribed session paces"', async () => {
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='tier2-estimate') return {value: JSON.stringify({ltPaceSec:262, updatedAt:new Date().toISOString()})};
        return null;
      }),
    };
    const {Z: z, layoffAdjustment} = await recomputeZones(state.profile, defaultGoalConfig());
    expect(z.S4.pace).toBe(262); // not 275, the raw Tier 1 profile value
    expect(z.S1.pace).toBe(Math.round(262*1.364)); // every zone re-derived from the SAME anchor
    expect(layoffAdjustment).toBeNull(); // no gap logged in this scenario
  });

  it('falls back to the raw Tier 1 profile pace when no Tier 2/3 estimate exists at all', async () => {
    window.storage = {get: vi.fn().mockResolvedValue(null)};
    const {Z: z} = await recomputeZones(state.profile, defaultGoalConfig());
    expect(z.S4.pace).toBe(275);
  });

  it('does not let a fresher-but-not-faster Tier 1 update override a solid Tier 2 read for the prescribed threshold pace', async () => {
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([{ltPaceSec:265, date:new Date().toISOString()}])};
        if(key==='tier2-estimate') return {value: JSON.stringify({ltPaceSec:262, updatedAt:new Date().toISOString()})};
        return null;
      }),
    };
    const {Z: z} = await recomputeZones(state.profile, defaultGoalConfig());
    expect(z.S4.pace).toBe(262);
  });

  it('inflates S4/S5 pace (slower) when a layoff adjustment is active, on top of whichever Tier evidence is otherwise authoritative', async () => {
    const oldDate = new Date(Date.now() - 30*86400000).toISOString(); // 30 days -> 'moderate', 5%/9%
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='last-activity-date') return {value: JSON.stringify({date: oldDate.slice(0,10)})};
        return null;
      }),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const {Z: z, layoffAdjustment} = await recomputeZones(state.profile, defaultGoalConfig());
    expect(layoffAdjustment).toMatchObject({severity:'moderate', ltPacePenaltyPct:5, vo2maxPenaltyPct:9});
    expect(z.S4.pace).toBe(Math.round(275*1.05)); // slower than the raw 275 anchor
  });

  it('does not touch prescribed pace once real evidence has landed since the gap was first flagged', async () => {
    const gapFirstFlagged = new Date(Date.now() - 20*86400000).toISOString();
    const freshEvidence = new Date(Date.now() - 1*86400000).toISOString(); // newer than the flag
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='layoff-episode') return {value: JSON.stringify({firstDetectedAt:gapFirstFlagged, days:20, severity:'mild', ltPacePenaltyPct:2, vo2maxPenaltyPct:4, rampWeeksRecommended:1})};
        if(key==='last-activity-date') return {value: JSON.stringify({date: new Date().toISOString().slice(0,10)})}; // resumed today
        if(key==='profile-history') return {value: JSON.stringify([{ltPaceSec:270, date:freshEvidence}])};
        return null;
      }),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const {Z: z, layoffAdjustment} = await recomputeZones(state.profile, defaultGoalConfig());
    expect(layoffAdjustment).toBeNull();
    expect(z.S4.pace).toBe(270); // the fresh Tier 1 reading, unadjusted
  });
});

describe('computeHMTrajectoryBaseline / compute10KTrajectoryBaseline (goal-config-driven, graceful no-goal handling)', () => {
  beforeEach(() => {
    state.profile = {lthr:171, ltPaceSec:275, maxHR:191, vo2max:53, restHR:40};
  });

  it('returns a neutral sentinel immediately when no goal is active (maintenance phase), without touching storage', async () => {
    window.storage = {get: vi.fn()};
    const hm = await computeHMTrajectoryBaseline(null);
    const tenK = await compute10KTrajectoryBaseline(null);
    expect(hm).toEqual({position:50, status:'neutral', label:'No active goal to gauge trend against right now.', source:null});
    expect(tenK).toEqual({position:50, status:'neutral', label:'No active goal to gauge trend against right now.', source:null});
    expect(window.storage.get).not.toHaveBeenCalled();
  });

  it('computes against the default goal config exactly as the old hardcoded literals did', async () => {
    const hmGoal = defaultGoalConfig().activeGoals.find(g=>g.zoneKey==='GOAL');
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([{ltPaceSec:285, date:'2026-08-01'}])};
        return null;
      }),
    };
    const hm = await computeHMTrajectoryBaseline(hmGoal, null);
    expect(hm.source).toBe('tier1');
    expect(typeof hm.position).toBe('number');
    expect(hm.label.toLowerCase()).toContain('sub-1:35:00');
  });

  it('uses the Riegel-implied LT pace, not the goal\'s raw goalPaceSec, for the gap - the direct fix for the confirmed ~10s/km unit mismatch (impliedLTPaceForGoal(5700,21.0975)=259 vs the literal goalPaceSec=269)', async () => {
    // best.ltPaceSec set to EXACTLY the old (buggy) goalPaceSec value - under the old code
    // this would read as gap=0 ("already there"); under the fix it's still a real ~10s/km
    // gap. goalPaceSec is included on the goal object specifically to prove it's now ignored.
    const hmGoal = {
      goalId:'hm-test', zoneKey:'GOAL', type:'HM', raceName:'Test Race', distanceKm:21.0975,
      raceDate: new Date(Date.now()+30*86400000).toISOString().slice(0,10),
      goalTimeSec:5700, goalTimeLabel:'Sub-1:35:00', goalPaceSec:269, goalPaceLabel:'4:29/km',
    };
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([{ltPaceSec:269, date:new Date().toISOString()}])};
        return null;
      }),
    };
    const hm = await computeHMTrajectoryBaseline(hmGoal, null);
    expect(hm.achievability.gapSec).toBeCloseTo(10, 0); // 269-259, NOT 269-269=0
    expect(hm.achievability.classification).not.toBe('already-there');
  });

  it('attaches a real trend and achievability read once enough history exists', async () => {
    const hmGoal = {
      goalId:'hm-test', zoneKey:'GOAL', type:'HM', raceName:'Test Race', distanceKm:21.0975,
      raceDate: new Date(Date.now()+40*86400000).toISOString().slice(0,10),
      goalTimeSec:5700, goalTimeLabel:'Sub-1:35:00', goalPaceSec:269, goalPaceLabel:'4:29/km',
    };
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([
          {ltPaceSec:290, date:new Date(Date.now()-28*86400000).toISOString()},
          {ltPaceSec:285, date:new Date(Date.now()-20*86400000).toISOString()},
          {ltPaceSec:278, date:new Date(Date.now()-10*86400000).toISOString()},
          {ltPaceSec:272, date:new Date().toISOString()},
        ])};
        return null;
      }),
    };
    const hm = await computeHMTrajectoryBaseline(hmGoal, null);
    expect(hm.trend).not.toBeNull();
    expect(hm.trend.rateSecPerWeek).toBeGreaterThan(0); // genuinely improving series
    expect(hm.achievability).not.toBeNull();
    expect(['on-pace','needs-to-accelerate','not-closing','already-there']).toContain(hm.achievability.classification);
  });

  it('reads achievability as insufficient-data with a real gap but too little history to trend', async () => {
    const hmGoal = {
      goalId:'hm-test', zoneKey:'GOAL', type:'HM', raceName:'Test Race', distanceKm:21.0975,
      raceDate: new Date(Date.now()+30*86400000).toISOString().slice(0,10),
      goalTimeSec:5700, goalTimeLabel:'Sub-1:35:00', goalPaceSec:269, goalPaceLabel:'4:29/km',
    };
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([{ltPaceSec:280, date:new Date().toISOString()}])}; // single point, real gap
        return null;
      }),
    };
    const hm = await computeHMTrajectoryBaseline(hmGoal, null);
    expect(hm.trend).toBeNull();
    expect(hm.achievability.classification).toBe('insufficient-data');
  });
});


describe('clampAIPositionToBaseline ("bound, don\'t block" for the AI-synthesized reading)', () => {
  it('clamps an AI position that overshoots the baseline by more than the band', () => {
    expect(clampAIPositionToBaseline(90, {position:40, status:'on track'}, 20)).toBe(60);
  });

  it('clamps an AI position that undershoots the baseline by more than the band', () => {
    expect(clampAIPositionToBaseline(5, {position:40, status:'on track'}, 20)).toBe(20);
  });

  it('leaves an AI position unchanged when it is within the band', () => {
    expect(clampAIPositionToBaseline(50, {position:40, status:'on track'}, 20)).toBe(50);
  });

  it('uses a default band of 20 when none is given', () => {
    expect(clampAIPositionToBaseline(90, {position:40, status:'on track'})).toBe(60);
  });

  it('passes the AI position through unchanged when the baseline is the neutral sentinel', () => {
    expect(clampAIPositionToBaseline(90, {position:50, status:'neutral'})).toBe(90);
  });

  it('passes the AI position through unchanged when there is no baseline at all', () => {
    expect(clampAIPositionToBaseline(90, null)).toBe(90);
  });
});

describe('goalTrackerHTML - previous-projection arrow', () => {
  const base = {position:50, status:'on track', confidence:'medium', label:'On track.', actionFlag:false, projectedSec:5760, projectedPaceSec:273};

  it('shows a down-arrow (improved/faster) when the new projection is faster than the previous one', () => {
    const html = goalTrackerHTML(Object.assign({}, base, {prevProjectedSec:5820})); // was 60s slower
    expect(html).toContain('&#9660;'); // down arrow
    expect(html).toContain('#5FA8A0'); // improvement color
    expect(html).toContain('60s');
    expect(html).toContain('was');
  });

  it('shows an up-arrow (worse/slower) when the new projection is slower than the previous one', () => {
    const html = goalTrackerHTML(Object.assign({}, base, {prevProjectedSec:5700})); // was 60s faster
    expect(html).toContain('&#9650;'); // up arrow
    expect(html).toContain('#C1502E'); // regression color
  });

  it('omits the arrow when there is no previous projection to compare against', () => {
    const html = goalTrackerHTML(Object.assign({}, base, {prevProjectedSec:undefined}));
    expect(html).not.toContain('was');
  });

  it('omits the arrow when the projection is essentially unchanged (<1s)', () => {
    const html = goalTrackerHTML(Object.assign({}, base, {prevProjectedSec:5760.4}));
    expect(html).not.toContain('was');
  });
});

describe('computeGoalProgress (partial-goal-aware, nested tenK/hm shape)', () => {
  beforeEach(async () => {
    const { computeZones } = await import('../data/plan.js');
    state.profile = {lthr:171, ltPaceSec:275, maxHR:191, vo2max:53, restHR:40};
    state.goalConfig = defaultGoalConfig();
    state.Z = computeZones(state.profile, state.goalConfig);
    state.WEEKS = buildWeeks();
    state.recentSaveCache = {};
  });

  it('returns both tenK and hm populated for the default two-goal config, with no 10K result yet', async () => {
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([{ltPaceSec:280, date:'2026-08-01'}])};
        return null;
      }),
    };
    const progress = await computeGoalProgress();
    expect(progress).not.toBeNull();
    expect(progress.tenK).not.toBeNull();
    expect(progress.hm).not.toBeNull();
    expect(progress.tenK.has10KResult).toBe(false);
    expect(progress.tenK.race10KDate.slice(0,7)).toBe('2026-08'); // timezone-sensitive day, month/year is enough here
    expect(progress.hm.raceHMDate.slice(0,7)).toBe('2026-09');
  });

  it('returns only hm when the 10K goal is inactive (e.g. already completed and removed from the config)', async () => {
    state.goalConfig = {version:1, phase:'race-build', activeGoals: defaultGoalConfig().activeGoals.filter(g=>g.zoneKey==='GOAL')};
    window.storage = {get: vi.fn().mockResolvedValue(null)};
    const progress = await computeGoalProgress();
    expect(progress).not.toBeNull();
    expect(progress.tenK).toBeNull();
    expect(progress.hm).not.toBeNull();
  });

  it('returns null only when neither goal slot is active', async () => {
    state.goalConfig = {version:1, phase:'maintenance', activeGoals:[]};
    window.storage = {get: vi.fn().mockResolvedValue(null)};
    const progress = await computeGoalProgress();
    expect(progress).toBeNull();
  });
});
