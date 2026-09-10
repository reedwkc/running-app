import { beforeEach, describe, expect, it } from 'vitest';
import { state } from '../state.js';
import { describeWeekProjection, projectedLTPaceFor, projectedPaceForZone, projectedZones, PROJECTION_MEANINGFUL_SEC, weekDates } from './pace-projection.js';

const d = s => new Date(s + 'T00:00:00');

beforeEach(() => {
  state.profile = {lthr: 171, ltPaceSec: 278, maxHR: 191, vo2max: 53, restHR: 40};
  state.goalConfig = undefined;
});

describe('projectedZones', () => {
  // The projected paces must come from the same zone maths as the live ones, or the two
  // numbers shown side by side would be computed on different rules and could not be
  // meaningfully compared - which is the entire point of showing them together.
  it('derives every zone from the projected threshold pace using the live zone ratios', () => {
    const z = projectedZones(265);
    expect(z.S4.pace).toBe(265);
    expect(z.S2.pace).toBe(Math.round(265*1.2));
    expect(z.S3.pace).toBe(Math.round(265*1.091));
    expect(z.S1.pace).toBe(Math.round(265*1.364));
  });

  // A threshold pace improving means running faster at the SAME heart rate, so the bands
  // must not move with it - a projected zone whose HR band had shifted would be describing
  // a different runner, not a fitter one.
  it('leaves the HR bands untouched', () => {
    expect(projectedZones(265).S4.hr).toBe(projectedZones(278).S4.hr);
  });

  it('refuses rather than guessing without a projected pace', () => {
    expect(projectedZones(null)).toBeNull();
  });
});

describe('projectedPaceForZone', () => {
  beforeEach(() => {
    // S5's live pace comes from a separately measured VO2max pace, NOT from the LT ratio -
    // note it is deliberately not 278*0.927 here, which is the whole point of the test.
    state.Z = {S1:{pace:379}, S2:{pace:334}, S3:{pace:303}, S4:{pace:278}, S5:{pace:260}, GOAL:{pace:256}, RACE10K:{pace:284}};
  });

  it('rebuilds S1-S4 from the projected threshold pace, exactly', () => {
    expect(projectedPaceForZone('S4', 265, 278)).toBe(265);
    expect(projectedPaceForZone('S2', 265, 278)).toBe(Math.round(265*1.2));
  });

  // Rebuilding S5 from the LT ratio would put a projected number derived one way beside a
  // live number derived another, and present them as comparable. Scaling states the
  // assumption instead: VO2max pace improves roughly in step with threshold pace.
  it('scales S5 in proportion rather than rebuilding it from the LT ratio', () => {
    expect(projectedPaceForZone('S5', 265, 278)).toBe(Math.round(260*(265/278)));
    expect(projectedPaceForZone('S5', 265, 278)).not.toBe(Math.round(265*0.927));
  });

  // Goal pace is the destination, identical in every week of the block - projecting it would
  // imply a target that moves, which is exactly what it does not do.
  it('never projects a fixed target zone', () => {
    expect(projectedPaceForZone('GOAL', 265, 278)).toBeNull();
    expect(projectedPaceForZone('RACE10K', 265, 278)).toBeNull();
  });

  it('refuses rather than guessing on missing inputs', () => {
    expect(projectedPaceForZone('S4', null, 278)).toBeNull();
    expect(projectedPaceForZone('S4', 265, null)).toBeNull();
    expect(projectedPaceForZone('S9', 265, 278)).toBeNull();
    expect(projectedPaceForZone(null, 265, 278)).toBeNull();
  });
});

describe('describeWeekProjection', () => {
  const projection = {currentLtPaceSec: 278, at: {[d('2027-01-25').getTime()]: 265, [d('2026-09-14').getTime()]: 277}};

  it('reads a target the curve has moved past as behind', () => {
    const cmp = describeWeekProjection(projection, d('2027-01-25'));
    expect(cmp.status).toBe('behind');
    expect(cmp.deltaSec).toBe(13);
    expect(cmp.meaningful).toBe(true);
  });

  // Early in a block the curve has barely moved, and a 1s/km difference is inside the noise
  // of any threshold estimate - showing it would invite chasing a number that hasn't moved.
  it('stays quiet when the difference is inside estimation noise', () => {
    const cmp = describeWeekProjection(projection, d('2026-09-14'));
    expect(cmp.meaningful).toBe(false);
    expect(cmp.status).toBe('on-curve');
    expect(Math.abs(cmp.deltaSec)).toBeLessThan(PROJECTION_MEANINGFUL_SEC);
  });

  it('reads running ahead of the curve as ahead', () => {
    const cmp = describeWeekProjection({currentLtPaceSec: 258, at: {[d('2027-01-25').getTime()]: 265}}, d('2027-01-25'));
    expect(cmp.status).toBe('ahead');
    expect(cmp.deltaSec).toBe(-7);
  });

  it('says nothing at all for a date the curve was never asked about', () => {
    expect(describeWeekProjection(projection, d('2030-01-01'))).toBeNull();
    expect(describeWeekProjection(null, d('2027-01-25'))).toBeNull();
  });
});

describe('projectedLTPaceFor and weekDates', () => {
  it('returns null rather than a fabricated value for an unknown date', () => {
    expect(projectedLTPaceFor({at: {}}, d('2027-01-01'))).toBeNull();
    expect(projectedLTPaceFor(null, d('2027-01-01'))).toBeNull();
  });

  it('collects the real dates of a week, skipping anything undateable', () => {
    const dates = weekDates({days: [{tag: 'Mon - Sep 14'}, {tag: 'not a date'}, {tag: 'Sat - Sep 19'}]});
    expect(dates).toHaveLength(2);
    expect(dates[0].getMonth()).toBe(8);
  });

  it('handles an empty or missing week without throwing', () => {
    expect(weekDates(null)).toEqual([]);
    expect(weekDates({})).toEqual([]);
  });
});
