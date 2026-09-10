import { beforeEach, describe, expect, it } from 'vitest';
import { state } from '../state.js';
import { SESSION_RECIPES, threshold } from './plan.js';

beforeEach(() => {
  state.Z = {
    S1:{hr:'113-139', pace:379}, S2:{hr:'139-155', pace:334}, S3:{hr:'155-165', pace:303},
    S4:{hr:'165-174', pace:278}, S5:{hr:'174+', pace:260}
  };
});

describe('threshold reps are prescribed at measured LT pace exactly', () => {
  // The point of the whole "threshold vs sub-threshold" distinction: the PACE is pinned to
  // S4 with no multiplier, and the sub-threshold part comes from targeting mid-zone HR. A
  // multiplier creeping in here would silently make every threshold session in the block
  // supra-threshold, which is the one deviation the method's own reference text names as
  // breaking it.
  it('prescribes exactly S4, never a fraction of it', () => {
    const s = threshold(4, 1000, 90, 'jog', 2, 1.5);
    expect(s.main.paceSpk).toBe(278);
    expect(s.main.pace).toBe('4:40/km');
  });

  it('moves with S4 and nothing else', () => {
    state.Z.S4.pace = 265;
    expect(threshold(4, 1000, 90, 'jog', 2, 1.5).main.paceSpk).toBe(265);
  });

  // Guards the argument ORDER, which is what actually broke when the dead paceRatio
  // parameter was removed from the signature but the callers had already been updated:
  // every value after it shifted one place, so recoverySec became the pace multiplier and
  // recoveryLabel became a number. Nothing in the suite noticed.
  it('reads every argument in the position its callers pass it', () => {
    const s = threshold(5, 1200, 120, 'walk', 2.5, 1);
    expect(s.main.reps).toBe(5);
    expect(s.main.label).toBe('5 x 1200m');
    expect(s.main.recoverySec).toBe(120);
    expect(s.main.recoveryLabel).toBe('walk');
    expect(s.wu.km).toBe(2.5);
    expect(s.cd.km).toBe(1);
    // 2.5 + 5x1.2 + 1 = 9.5km - a wrong argument order puts this wildly out, or NaN.
    expect(s.totalKm).toBe('9.5');
    expect(Number.isFinite(s.totalSec)).toBe(true);
  });

  it('builds the same session through the recipe as through a direct call', () => {
    const direct = threshold(4, 1000, 90, 'jog', 2, 1.5);
    const viaRecipe = SESSION_RECIPES.threshold({reps:4, repM:1000, recoverySec:90, recoveryLabel:'jog', wuKm:2, cdKm:1.5});
    expect(viaRecipe).toEqual(direct);
  });

  // A stored day from before the parameter was removed may still carry paceRatio in its
  // recipe args. It must be ignored, not applied as a multiplier and not thrown on.
  it('ignores a leftover paceRatio in stored recipe args', () => {
    const withRatio = SESSION_RECIPES.threshold({reps:4, repM:1000, paceRatio:0.989, recoverySec:90, recoveryLabel:'jog', wuKm:2, cdKm:1.5});
    expect(withRatio.main.paceSpk).toBe(278);
    expect(withRatio.totalKm).toBe('7.5');
  });
});
