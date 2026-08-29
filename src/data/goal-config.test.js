// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { reassignGoalZoneKeys } from './goal-config.js';

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
