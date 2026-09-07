// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { blockRelativeWeekN, findGoalRaceDay, reassignGoalZoneKeys, stampNewBlock } from './goal-config.js';

function goal(goalId, raceDate, zoneKey){
  return {goalId, type:'Custom', zoneKey: zoneKey||null, label: goalId, raceName: goalId, distanceKm: 10, raceDate, goalTimeSec: 3000, goalTimeLabel:'Sub-50:00', goalPaceSec: 300, goalPaceLabel:'5:00/km', goalHR:'n/a'};
}

describe('reassignGoalZoneKeys', () => {
  it('assigns the nearest upcoming goal GOAL and the second-nearest RACE10K', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-01T12:00:00'));
    try{
      const goals = [goal('c', '2026-12-01'), goal('a', '2026-09-01'), goal('b', '2026-10-01')];
      const result = reassignGoalZoneKeys(goals);
      expect(result.find(g=>g.goalId==='a').zoneKey).toBe('GOAL');
      expect(result.find(g=>g.goalId==='b').zoneKey).toBe('RACE10K');
      expect(result.find(g=>g.goalId==='c').zoneKey).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('preserves the original array order rather than sorting by race date', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-01T12:00:00'));
    try{
      const goals = [goal('c', '2026-12-01'), goal('a', '2026-09-01'), goal('b', '2026-10-01')];
      const result = reassignGoalZoneKeys(goals);
      expect(result.map(g=>g.goalId)).toEqual(['c', 'a', 'b']);
    } finally { vi.useRealTimers(); }
  });

  it('excludes a past-race-date goal from ranking and gives it zoneKey:null even if it previously held a slot', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-01T12:00:00'));
    try{
      const goals = [goal('past', '2026-01-01', 'GOAL'), goal('future', '2026-09-01')];
      const result = reassignGoalZoneKeys(goals);
      expect(result.find(g=>g.goalId==='past').zoneKey).toBeNull();
      expect(result.find(g=>g.goalId==='future').zoneKey).toBe('GOAL');
    } finally { vi.useRealTimers(); }
  });

  it('treats a race today as still upcoming (not past)', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-01T12:00:00'));
    try{
      const result = reassignGoalZoneKeys([goal('today', '2026-08-01')]);
      expect(result.find(g=>g.goalId==='today').zoneKey).toBe('GOAL');
    } finally { vi.useRealTimers(); }
  });

  it('gives zoneKey:null to every goal when none have an upcoming race date', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-01T12:00:00'));
    try{
      const goals = [goal('a', '2026-01-01', 'GOAL'), goal('b', '2026-02-01', 'RACE10K')];
      const result = reassignGoalZoneKeys(goals);
      expect(result.every(g=>g.zoneKey===null)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('handles an empty or missing list without throwing', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-01T12:00:00'));
    try{
      expect(reassignGoalZoneKeys([])).toEqual([]);
      expect(reassignGoalZoneKeys(undefined)).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('returns the same object reference for a goal whose zoneKey does not change', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-01T12:00:00'));
    try{
      const g = goal('a', '2026-09-01', 'GOAL');
      const result = reassignGoalZoneKeys([g]);
      expect(result[0]).toBe(g);
    } finally { vi.useRealTimers(); }
  });

  it('promotes a third goal once an earlier one is removed', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-01T12:00:00'));
    try{
      const goals = [goal('b', '2026-10-01'), goal('c', '2026-12-01')];
      const result = reassignGoalZoneKeys(goals);
      expect(result.find(g=>g.goalId==='b').zoneKey).toBe('GOAL');
      expect(result.find(g=>g.goalId==='c').zoneKey).toBe('RACE10K');
    } finally { vi.useRealTimers(); }
  });
});

describe('stampNewBlock / blockRelativeWeekN', () => {
  it('stamps blockStartWeekN to one past the highest existing week number', () => {
    const cfg = {};
    stampNewBlock(cfg, [{n:1}, {n:5}, {n:3}]);
    expect(cfg.blockStartWeekN).toBe(6);
    expect(cfg.blockStartedAt).toBeTruthy();
  });

  it('stamps blockStartWeekN to 1 when there are no existing weeks at all', () => {
    const cfg = {};
    stampNewBlock(cfg, []);
    expect(cfg.blockStartWeekN).toBe(1);
  });

  it('handles a missing/undefined weeks array without throwing', () => {
    const cfg = {};
    stampNewBlock(cfg, undefined);
    expect(cfg.blockStartWeekN).toBe(1);
  });

  it('maps the first week of a new block to display "1", counting up from there', () => {
    const cfg = {blockStartWeekN: 7};
    expect(blockRelativeWeekN(7, cfg)).toBe(1);
    expect(blockRelativeWeekN(8, cfg)).toBe(2);
    expect(blockRelativeWeekN(12, cfg)).toBe(6);
  });

  it('leaves a week from BEFORE the current block showing its own real number, not a renumbered/negative one', () => {
    const cfg = {blockStartWeekN: 7};
    expect(blockRelativeWeekN(5, cfg)).toBe(5);
    expect(blockRelativeWeekN(1, cfg)).toBe(1);
  });

  it('falls back to the raw week number when no block has ever been stamped - unchanged single-block behavior', () => {
    expect(blockRelativeWeekN(9, {})).toBe(9);
    expect(blockRelativeWeekN(9, null)).toBe(9);
    expect(blockRelativeWeekN(9, undefined)).toBe(9);
  });
});

describe('findGoalRaceDay', () => {
  it('matches by goalId first, even when another race day at the same distance also exists', () => {
    const weeks = [
      {n:5, days:[{tag:'Sat - Sep 5', type:'race', goalId:'old-hm', data:{km:21.19}}]},
      {n:57, days:[{tag:'Sat - Sep 4', type:'race', goalId:'new-hm', data:{km:21.0975}}]},
    ];
    const found = findGoalRaceDay(weeks, {goalId:'new-hm', distanceKm:21.0975});
    expect(found.week.n).toBe(57);
  });

  it('does NOT fall back to a race day already tagged for a DIFFERENT goal, even at a matching distance - the exact regression this caught: a brand new goal immediately showed an old, unrelated goal\'s completed result', () => {
    const weeks = [
      {n:5, days:[{tag:'Sat - Sep 5', type:'race', goalId:'old-hm', data:{km:21.19}}]},
    ];
    const found = findGoalRaceDay(weeks, {goalId:'new-hm', distanceKm:21.0975});
    expect(found).toBeNull();
  });

  it('still falls back to distance-matching a genuinely UNTAGGED race day (a hand-edited plan that never got a goalId)', () => {
    const weeks = [
      {n:5, days:[{tag:'Sat - Sep 5', type:'race', data:{km:21.19}}]},
    ];
    const found = findGoalRaceDay(weeks, {goalId:'new-hm', distanceKm:21.0975});
    expect(found.week.n).toBe(5);
  });

  it('returns null for a goal with no matching race day at all', () => {
    expect(findGoalRaceDay([{n:1, days:[]}], {goalId:'x', distanceKm:10})).toBeNull();
  });

  it('returns null for a falsy goal', () => {
    expect(findGoalRaceDay([], null)).toBeNull();
  });
});
