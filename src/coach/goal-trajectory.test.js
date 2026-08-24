// @ts-nocheck - window.storage test mocks intentionally implement only what's used
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../state.js';
import { defaultGoalConfig } from '../data/goal-config.js';
import { buildWeeks } from '../data/plan.js';
import {
  applyNearRaceGapCeiling, clampAIPositionToBaseline, computeTrajectoryPosition, computeGoalProgress, computeHMTrajectoryBaseline, compute10KTrajectoryBaseline, computeMaintenanceTrend, getBestAvailableLTPace, goalTrackerHTML, impliedLTPaceForGoal, projectedTimeFromLTPace, recomputeZones,
} from './goal-trajectory.js';

describe('computeMaintenanceTrend (raceless maintenance phase - no timeline to interpolate toward)', () => {
  it('reads as holding steady when pace is essentially unchanged', () => {
    const {position, status} = computeMaintenanceTrend(275, 275);
    expect(status).toBe('holding steady');
    expect(position).toBe(50);
  });

  it('reads as improving when current pace is meaningfully faster than the reference', () => {
    const {position, status} = computeMaintenanceTrend(275, 260); // ~5.5% faster
    expect(status).toBe('improving');
    expect(position).toBeGreaterThan(67);
  });

  it('reads as declining when current pace is meaningfully slower than the reference', () => {
    const {position, status} = computeMaintenanceTrend(275, 290); // slower
    expect(status).toBe('declining');
    expect(position).toBeLessThan(33);
  });

  it('returns a neutral sentinel when either pace is missing', () => {
    expect(computeMaintenanceTrend(null, 275)).toEqual({position:50, status:'neutral'});
    expect(computeMaintenanceTrend(275, null)).toEqual({position:50, status:'neutral'});
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

describe('computeTrajectoryPosition', () => {
  const startDate = new Date(2026, 7, 1);  // Aug 1
  const raceDate = new Date(2026, 7, 21);  // Aug 21 - a clean 20-day window
  const halfway = new Date(2026, 7, 11);   // Aug 11 - exactly 10/20 = 0.5 elapsed

  it('reads as exactly 50 (on track) when the current gap exactly matches the expected linear closure', () => {
    // 20s/km behind at the start, halfway through the block the expected gap has
    // halved to 10 - a current gap of exactly 10 means right on schedule.
    const {position, status} = computeTrajectoryPosition(20, startDate, raceDate, 10, halfway);
    expect(position).toBe(50);
    expect(status).toBe('on track');
  });

  it('reads as ahead when the current gap has closed faster than the timeline requires', () => {
    const {position, status} = computeTrajectoryPosition(20, startDate, raceDate, -5, halfway);
    expect(position).toBeGreaterThan(67);
    expect(status).toBe('ahead');
  });

  it('reads as behind when the current gap has not closed at all despite being halfway through', () => {
    const {position, status} = computeTrajectoryPosition(20, startDate, raceDate, 20, halfway);
    expect(position).toBeLessThan(33);
    expect(status).toBe('behind');
  });

  it('clamps position to [0,100] for extreme gaps', () => {
    expect(computeTrajectoryPosition(20, startDate, raceDate, 500, halfway).position).toBe(0);
    expect(computeTrajectoryPosition(20, startDate, raceDate, -500, halfway).position).toBe(100);
  });

  it('does not throw and clamps elapsedFrac when startDate===raceDate (zero-length window)', () => {
    const same = new Date(2026, 7, 1);
    const {position} = computeTrajectoryPosition(20, same, same, 10, halfway);
    expect(Number.isFinite(position)).toBe(true);
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

  it('caps a near-race "ahead" reading down when a meaningful pace gap still remains (reproduces the "strong ahead, 13 days out, still slower than goal" live complaint)', async () => {
    // A big gap at block start (90s/km, just 2 days ago) that's since narrowed to 20s/km
    // (still meaningfully slower - 20*21.0975km =~422s, well over the 60s finish-time bar)
    // makes the RAW schedule math read "ahead" (it closed fast relative to how little of
    // the (short, artificial) timeline has elapsed) - but with the race only 10 days out,
    // that's not enough runway left to call this comfortably ahead.
    state.profile = {lthr:171, ltPaceSec:289, maxHR:191, vo2max:53, restHR:40};
    const hmGoal = {
      goalId:'hm-test', zoneKey:'GOAL', type:'HM', raceName:'Test Race', distanceKm:21.0975,
      raceDate: new Date(Date.now()+10*86400000).toISOString().slice(0,10),
      goalTimeSec:5700, goalTimeLabel:'Sub-1:35:00', goalPaceSec:269, goalPaceLabel:'4:29/km',
    };
    window.storage = {
      // getBestAvailableLTPace's "tier1" reading is the LATEST profile-history entry, not
      // state.profile - two entries needed so "block start" (oldest, 90s/km gap) and
      // "current" (newest, 20s/km gap) are actually distinct.
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([
          {ltPaceSec:359, date:new Date(Date.now()-2*86400000).toISOString()},
          {ltPaceSec:289, date:new Date().toISOString()},
        ])};
        return null;
      }),
    };
    const hm = await computeHMTrajectoryBaseline(hmGoal, null);
    expect(hm.position).toBeLessThanOrEqual(40);
    expect(hm.status).not.toBe('ahead');
    expect(hm.label).toContain('not enough runway');
  });

  it('does NOT cap a genuinely on-track/ahead reading when the race is more than NEAR_RACE_DAYS away', async () => {
    state.profile = {lthr:171, ltPaceSec:289, maxHR:191, vo2max:53, restHR:40};
    const hmGoal = {
      goalId:'hm-test', zoneKey:'GOAL', type:'HM', raceName:'Test Race', distanceKm:21.0975,
      raceDate: new Date(Date.now()+30*86400000).toISOString().slice(0,10), // 30 days out
      goalTimeSec:5700, goalTimeLabel:'Sub-1:35:00', goalPaceSec:269, goalPaceLabel:'4:29/km',
    };
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='profile-history') return {value: JSON.stringify([
          {ltPaceSec:359, date:new Date(Date.now()-2*86400000).toISOString()},
          {ltPaceSec:289, date:new Date().toISOString()},
        ])};
        return null;
      }),
    };
    const hm = await computeHMTrajectoryBaseline(hmGoal, null);
    expect(hm.status).toBe('ahead'); // confirms this scenario really would read "ahead" if not for the distance gate
    expect(hm.label).not.toContain('not enough runway');
  });
});

describe('applyNearRaceGapCeiling (near-race, meaningful-gap position cap)', () => {
  const raceDate = new Date(Date.now()+10*86400000); // 10 days out

  it('caps position down when the race is near and the finish-time-equivalent gap exceeds the meaningful threshold', () => {
    // 5s/km * 21.0975km =~105s, over the 60s bar
    expect(applyNearRaceGapCeiling(95, 5, 21.0975, raceDate)).toBeLessThanOrEqual(40);
  });

  it('leaves position unchanged when the finish-time-equivalent gap is trivial', () => {
    // 1s/km * 21.0975km =~21s, under the 60s bar
    expect(applyNearRaceGapCeiling(95, 1, 21.0975, raceDate)).toBe(95);
  });

  it('leaves position unchanged when the race is more than NEAR_RACE_DAYS away', () => {
    const farRaceDate = new Date(Date.now()+30*86400000);
    expect(applyNearRaceGapCeiling(95, 5, 21.0975, farRaceDate)).toBe(95);
  });

  it('leaves position unchanged when currentGapSec is null (unknown fitness)', () => {
    expect(applyNearRaceGapCeiling(95, null, 21.0975, raceDate)).toBe(95);
  });

  it('never RAISES position - a genuinely low reading stays low even if the gap is meaningful', () => {
    expect(applyNearRaceGapCeiling(20, 5, 21.0975, raceDate)).toBe(20);
  });

  it('does not cap a negative (faster-than-goal) gap, since that is not a "gap" at all', () => {
    expect(applyNearRaceGapCeiling(95, -5, 21.0975, raceDate)).toBe(95);
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
