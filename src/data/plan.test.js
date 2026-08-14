// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { computeWeekPlannedKm } from './plan.js';

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
