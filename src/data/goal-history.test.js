// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveGoal, goalChangedMaterially, loadGoalHistory, planGoalArchival, truncateGoalHistory } from './goal-history.js';

function goal(overrides){
  return Object.assign({
    goalId:'hm-sub135', type:'HM', zoneKey:'GOAL', label:'Half Marathon',
    raceName:'Lierlopet Halvmaraton', distanceKm:21.0975, raceDate:'2026-09-27',
    goalTimeSec:5700, goalTimeLabel:'Sub-1:35:00', goalPaceSec:269, goalPaceLabel:'4:29/km',
  }, overrides);
}

describe('goalChangedMaterially', () => {
  it('is false when nothing that actually matters differs', () => {
    expect(goalChangedMaterially(goal(), goal({label:'HM (relabeled)'}))).toBe(false);
  });
  it('is true when goalTimeSec differs', () => {
    expect(goalChangedMaterially(goal(), goal({goalTimeSec:5400}))).toBe(true);
  });
  it('is true when raceDate differs', () => {
    expect(goalChangedMaterially(goal(), goal({raceDate:'2026-09-05'}))).toBe(true);
  });
  it('is true when distanceKm differs (a different race entirely)', () => {
    expect(goalChangedMaterially(goal(), goal({distanceKm:10}))).toBe(true);
  });
  it('is false when either side is missing', () => {
    expect(goalChangedMaterially(null, goal())).toBe(false);
    expect(goalChangedMaterially(goal(), null)).toBe(false);
  });
});

describe('planGoalArchival', () => {
  const tenK = goal({goalId:'10k-lierlopet', type:'10K', zoneKey:'RACE10K', label:'10K', distanceKm:10, raceDate:'2026-08-30'});

  it('flags a goal missing from the new array as removed', () => {
    const result = planGoalArchival([goal(), tenK], [tenK]);
    expect(result).toEqual([{goal: goal(), reason:'removed'}]);
  });

  it('flags a goal present but materially changed as superseded', () => {
    const changed = goal({goalTimeSec:5400, goalTimeLabel:'Sub-1:30:00'});
    const result = planGoalArchival([goal(), tenK], [changed, tenK]);
    expect(result).toEqual([{goal: goal(), reason:'superseded', supersededBy: changed}]);
  });

  it('flags nothing when the same goals are resupplied unchanged', () => {
    const result = planGoalArchival([goal(), tenK], [goal(), tenK]);
    expect(result).toEqual([]);
  });

  it('handles an empty old/new list without throwing', () => {
    expect(planGoalArchival([], [])).toEqual([]);
    expect(planGoalArchival(null, null)).toEqual([]);
  });
});

describe('archiveGoal / loadGoalHistory / truncateGoalHistory', () => {
  beforeEach(() => {
    window.storage = {get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined)};
  });

  it('loadGoalHistory returns an empty array when nothing has been archived yet', async () => {
    expect(await loadGoalHistory()).toEqual([]);
  });

  it('archiveGoal appends a new entry with archivedAt/reason/result set', async () => {
    const ok = await archiveGoal(goal(), 'superseded', null);
    expect(ok).toBe(true);
    expect(window.storage.set).toHaveBeenCalledTimes(1);
    const [key, payload] = window.storage.set.mock.calls[0];
    expect(key).toBe('goal-history');
    const saved = JSON.parse(payload);
    expect(saved).toHaveLength(1);
    expect(saved[0].goalId).toBe('hm-sub135');
    expect(saved[0].reason).toBe('superseded');
    expect(saved[0].archivedAt).toBeTruthy();
    expect(saved[0].result).toBeNull();
  });

  it('archiveGoal appends onto existing history rather than overwriting it', async () => {
    window.storage.get = vi.fn().mockResolvedValue({value: JSON.stringify([{goalId:'old-one', reason:'removed', archivedAt:'2026-01-01T00:00:00.000Z'}])});
    await archiveGoal(goal(), 'completed', {actualDist:21.1, actualDurSec:5650, actualTimeLabel:'1:34:10'});
    const saved = JSON.parse(window.storage.set.mock.calls[0][1]);
    expect(saved).toHaveLength(2);
    expect(saved[0].goalId).toBe('old-one');
    expect(saved[1].goalId).toBe('hm-sub135');
    expect(saved[1].result.actualTimeLabel).toBe('1:34:10');
  });

  it('archiveGoal returns false and does not write when existing history is unreadable', async () => {
    window.storage.get = vi.fn().mockResolvedValue({value: 'not json'});
    const ok = await archiveGoal(goal(), 'removed', null);
    expect(ok).toBe(false);
    expect(window.storage.set).not.toHaveBeenCalled();
  });

  it('truncateGoalHistory trims back to the given length', async () => {
    window.storage.get = vi.fn().mockResolvedValue({value: JSON.stringify([{goalId:'a'}, {goalId:'b'}, {goalId:'c'}])});
    await truncateGoalHistory(1);
    const saved = JSON.parse(window.storage.set.mock.calls[0][1]);
    expect(saved).toEqual([{goalId:'a'}]);
  });

  it('truncateGoalHistory is a no-op when history is already within the target length', async () => {
    window.storage.get = vi.fn().mockResolvedValue({value: JSON.stringify([{goalId:'a'}])});
    await truncateGoalHistory(5);
    expect(window.storage.set).not.toHaveBeenCalled();
  });

  it('truncateGoalHistory is a no-op when len is null (defensive fallback for pre-existing history entries)', async () => {
    await truncateGoalHistory(null);
    expect(window.storage.get).not.toHaveBeenCalled();
  });
});
