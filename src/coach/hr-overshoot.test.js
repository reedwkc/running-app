import { describe, expect, it } from 'vitest';
import { computeHROvershoot, parseHRBand } from './strava-import.js';

const lap = (role, avgHR) => ({role, avgHR});

describe('parseHRBand', () => {
  it('reads a closed band', () => {
    expect(parseHRBand('165-174')).toEqual({lo:165, hi:174});
  });

  // The VO2max zone is stored open-ended precisely because HR is SUPPOSED to keep climbing
  // across the set - a zone with no ceiling cannot be overshot, and every overshoot check
  // routes through here so that stays true without each caller re-deciding it.
  it('refuses an open-ended band, so VO2max reps can never be flagged as overshooting', () => {
    expect(parseHRBand('174+')).toBeNull();
    expect(computeHROvershoot({laps:[lap('work',188), lap('work',192)]}, {hr:'174+'})).toBeNull();
  });

  it('refuses junk and missing values rather than guessing', () => {
    expect(parseHRBand('n/a')).toBeNull();
    expect(parseHRBand('')).toBeNull();
    expect(parseHRBand(undefined)).toBeNull();
    expect(parseHRBand('174-165')).toBeNull();
  });
});

describe('computeHROvershoot', () => {
  const band = {hr:'165-174'};

  it('reports zero overshoot when every rep stayed in zone', () => {
    const r = computeHROvershoot({laps:[lap('work',168), lap('work',170), lap('work',172)]}, band);
    expect(r).toEqual({repCount:3, overshootCount:0, firstOvershootRep:null, maxOvershootBpm:0, ceilingBpm:174});
  });

  // The case this whole feature exists for: pace was held, so the pace comparison says
  // nothing, and only HR reveals where the effort actually landed.
  it('records which rep it started on, not just how many', () => {
    const r = computeHROvershoot({laps:[lap('work',168), lap('work',171), lap('work',173), lap('work',178)]}, band);
    expect(r.overshootCount).toBe(1);
    expect(r.firstOvershootRep).toBe(4);
    expect(r.maxOvershootBpm).toBe(4);
  });

  // Same rep count, same ceiling, very different meaning - a last-rep tip over the ceiling is
  // ordinary cardiovascular drift, an overshoot from rep 2 is a real finding. The metric has
  // to separate them or a detector built on it will cry wolf on well-executed sessions.
  it('distinguishes an early overshoot from a late one', () => {
    const late = computeHROvershoot({laps:[lap('work',166), lap('work',169), lap('work',172), lap('work',176)]}, band);
    const early = computeHROvershoot({laps:[lap('work',170), lap('work',177), lap('work',179), lap('work',181)]}, band);
    expect(late.firstOvershootRep).toBe(4);
    expect(late.overshootCount).toBe(1);
    expect(early.firstOvershootRep).toBe(2);
    expect(early.overshootCount).toBe(3);
    expect(early.maxOvershootBpm).toBe(7);
  });

  it('ignores warmup, recovery and cooldown laps', () => {
    const r = computeHROvershoot({laps:[
      lap('warmup',176), lap('work',168), lap('recovery',175), lap('work',170), lap('cooldown',180)
    ]}, band);
    expect(r.repCount).toBe(2);
    expect(r.overshootCount).toBe(0);
  });

  // Returning null rather than a zeroed object matters: callers must not be able to present
  // "no overshoot detected" as a measurement that was actually made.
  it('returns null when there is nothing meaningful to measure', () => {
    expect(computeHROvershoot({laps:[lap('work',180)]}, band)).toBeNull();
    expect(computeHROvershoot({laps:[]}, band)).toBeNull();
    expect(computeHROvershoot(null, band)).toBeNull();
    expect(computeHROvershoot({laps:[lap('work',180), lap('work',181)]}, {})).toBeNull();
    expect(computeHROvershoot({laps:[lap('work',null), lap('work',null)]}, band)).toBeNull();
  });

  it('treats HR exactly at the ceiling as in zone, not over it', () => {
    const r = computeHROvershoot({laps:[lap('work',174), lap('work',174)]}, band);
    expect(r.overshootCount).toBe(0);
  });
});
