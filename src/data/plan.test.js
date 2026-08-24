// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyReducedWeek, computeWeekPlannedKm, computeZones, applyPlanOverrides } from './plan.js';
import { defaultGoalConfig } from './goal-config.js';

describe('computeWeekPlannedKm', () => {
  it('sums km across easy/threshold/vo2max/long/race day types, ignoring open days', () => {
    const week = {
      days: [
        {type:'easy', data:{km:8}},
        {type:'threshold', data:{totalKm:'10.5'}},
        {type:'vo2max', data:{totalKm:'9.0'}},
        {type:'long', data:{totalKm:'19.0'}},
        {type:'open', data:{}},
      ],
    };
    expect(computeWeekPlannedKm(week)).toBe(46.5);
  });

  it('uses race day km directly', () => {
    const week = {days:[{type:'race', data:{km:21.1}}]};
    expect(computeWeekPlannedKm(week)).toBe(21.1);
  });

  it('returns 0 for a week with no days or only open days', () => {
    expect(computeWeekPlannedKm({days:[]})).toBe(0);
    expect(computeWeekPlannedKm({days:[{type:'open', data:{}}]})).toBe(0);
  });

  it('does not throw on a missing days array', () => {
    expect(computeWeekPlannedKm({})).toBe(0);
  });
});

describe('classifyReducedWeek (taper vs. recovery)', () => {
  const raceWeek = {n:8, days:[{type:'race', tag:'Sun - Sep 27', name:'RACE - Half Marathon', data:{km:21.1}}]};

  it('classifies a cutback week BEFORE an upcoming race as taper', () => {
    const weeks = [{n:7, cutback:true, days:[{type:'threshold'}]}, raceWeek];
    expect(classifyReducedWeek(weeks, 7)).toMatchObject({kind:'taper', raceWeekN:8});
  });

  it('classifies a cutback week AFTER a just-run race as recovery', () => {
    const weeks = [raceWeek, {n:9, cutback:true, days:[{type:'easy'}]}];
    expect(classifyReducedWeek(weeks, 9)).toMatchObject({kind:'recovery', raceWeekN:8});
  });

  it('classifies the week containing the race itself as race, not taper/recovery', () => {
    const weeks = [raceWeek];
    expect(classifyReducedWeek(weeks, 8)).toMatchObject({kind:'race'});
  });

  it('treats a contiguous run of cutback weeks between this one and the race as still belonging to it', () => {
    const weeks = [{n:6, cutback:true, days:[{type:'threshold'}]}, {n:7, cutback:true, days:[{type:'easy'}]}, raceWeek];
    expect(classifyReducedWeek(weeks, 6)).toMatchObject({kind:'taper', raceWeekN:8});
  });

  it('falls back to generic "cutback" when a normal (non-cutback) week separates this one from the nearest race in either direction', () => {
    const weeks = [raceWeek, {n:9, cutback:false, days:[{type:'threshold'}]}, {n:10, cutback:true, days:[{type:'easy'}]}];
    expect(classifyReducedWeek(weeks, 10)).toMatchObject({kind:'cutback'});
  });

  it('returns null for a week number not present in the list', () => {
    expect(classifyReducedWeek([raceWeek], 99)).toBeNull();
  });
});

describe('computeZones (goalConfig-driven GOAL/RACE10K)', () => {
  const profile = {lthr:171, ltPaceSec:275, maxHR:191, vo2max:53, restHR:40};

  it('reproduces the exact hardcoded GOAL/RACE10K values via the default goal config', () => {
    const z = computeZones(profile, defaultGoalConfig());
    expect(z.GOAL).toEqual({hr:'168-172', pace:269});
    expect(z.RACE10K).toEqual({hr:'175-185', pace:258});
  });

  it('falls back to the default goal config when none is passed (undefined)', () => {
    const z = computeZones(profile, undefined);
    expect(z.GOAL.pace).toBe(269);
    expect(z.RACE10K.pace).toBe(258);
  });

  it('leaves S1-S5 unaffected by goalConfig - purely profile-derived', () => {
    const withGoals = computeZones(profile, defaultGoalConfig());
    const noGoals = computeZones(profile, {version:1, phase:'maintenance', activeGoals:[]});
    expect(withGoals.S4).toEqual(noGoals.S4);
    expect(withGoals.S1).toEqual(noGoals.S1);
  });

  it('produces a synthetic, non-crashing fallback pace for an empty goal slot (maintenance phase)', () => {
    const z = computeZones(profile, {version:1, phase:'maintenance', activeGoals:[]});
    expect(z.GOAL.synthetic).toBe(true);
    expect(z.RACE10K.synthetic).toBe(true);
    expect(typeof z.GOAL.pace).toBe('number');
    expect(typeof z.RACE10K.pace).toBe('number');
  });
});

describe('applyPlanOverrides (whole-week upsert)', () => {
  const baseWeeks = () => [
    {n:1, dates:'Aug 3-9', days:[{tag:'Wed - Aug 5', type:'threshold'}]},
    {n:2, dates:'Aug 10-16', days:[{tag:'Mon - Aug 10', type:'threshold'}]},
  ];

  beforeEach(() => {
    window.storage = {get: vi.fn().mockResolvedValue(null)};
  });

  it('returns weeks unchanged (no-op) when no plan-override key exists', async () => {
    const weeks = baseWeeks();
    const result = await applyPlanOverrides(weeks);
    expect(result).toBe(weeks);
  });

  it('replaces an existing week by n, leaving other weeks byte-identical', async () => {
    const weeks = baseWeeks();
    const newWeek2 = {n:2, dates:'Aug 10-16', days:[{tag:'Mon - Aug 10', type:'threshold'}, {tag:'Wed - Aug 12', type:'vo2max'}]};
    window.storage = {get: vi.fn().mockResolvedValue({value: JSON.stringify({weeksByN:{'2':newWeek2}})})};
    const result = await applyPlanOverrides(weeks);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(weeks[0]);
    expect(result[1]).toEqual(newWeek2);
  });

  it('appends a new week beyond the current max n', async () => {
    const weeks = baseWeeks();
    const week9 = {n:9, dates:'Oct 1-7', days:[{tag:'Mon - Oct 1', type:'easy'}]};
    window.storage = {get: vi.fn().mockResolvedValue({value: JSON.stringify({weeksByN:{'9':week9}})})};
    const result = await applyPlanOverrides(weeks);
    expect(result.map(w=>w.n)).toEqual([1,2,9]);
  });

  it('truncateAfter drops stale weeks beyond the cutoff not present in the override', async () => {
    const weeks = [...baseWeeks(), {n:3, dates:'Aug 17-23', days:[]}, {n:4, dates:'Aug 24-30', days:[]}];
    const week9 = {n:9, dates:'Oct 1-7', days:[]};
    window.storage = {get: vi.fn().mockResolvedValue({value: JSON.stringify({weeksByN:{'9':week9}, truncateAfter:2})})};
    const result = await applyPlanOverrides(weeks);
    expect(result.map(w=>w.n)).toEqual([1,2,9]);
  });

  it('falls back to the unmodified weeks if the stored override JSON is corrupted', async () => {
    const weeks = baseWeeks();
    window.storage = {get: vi.fn().mockResolvedValue({value: 'not json'})};
    const result = await applyPlanOverrides(weeks);
    expect(result).toBe(weeks);
  });
});
