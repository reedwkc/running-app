// @ts-nocheck - window.storage test mocks intentionally implement only what's used
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../state.js';
import {
  computeTrajectoryPosition, getBestAvailableLTPace, impliedLTPaceForGoal, projectedTimeFromLTPace,
} from './goal-trajectory.js';

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

  it('picks whichever candidate (tier1 history / tier2 / tier3) was updated most recently', async () => {
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

  it('prefers a more recent tier3 estimate over an older tier2 one', async () => {
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
});
