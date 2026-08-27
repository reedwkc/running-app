// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { computeCadenceFade, computeDecoupling, computeSessionTRIMP, computeTRIMP } from './trimp.js';

// Builds a synthetic 40-minute stream (medium resolution, ~1 point every 6s) with a
// steady heart rate and a controllable speed drop partway through, to check decoupling
// picks up a real efficiency fade without needing a real Strava activity.
function buildStream(minutes, hr, firstHalfSpeed, secondHalfSpeed){
  const n = Math.round(minutes*60/6);
  const time = [], heartrate = [], velocity_smooth = [];
  for(let i=0;i<n;i++){
    time.push(i*6);
    heartrate.push(hr);
    velocity_smooth.push(i < n/2 ? firstHalfSpeed : secondHalfSpeed);
  }
  return { time:{data:time}, heartrate:{data:heartrate}, velocity_smooth:{data:velocity_smooth} };
}

describe('computeDecoupling', () => {
  it('reports ~0% decoupling when pace and HR hold flat for the whole run', () => {
    const streams = buildStream(40, 150, 3.5, 3.5);
    const result = computeDecoupling(streams);
    expect(result).not.toBeNull();
    expect(Math.abs(result.decouplingPct)).toBeLessThan(0.5);
  });

  it('reports positive decoupling when speed drops in the second half at the same HR', () => {
    const streams = buildStream(40, 150, 3.5, 3.15); // ~10% slower late at the same effort
    const result = computeDecoupling(streams);
    expect(result.decouplingPct).toBeGreaterThan(5);
  });

  it('returns null for a run shorter than the 25-minute minimum', () => {
    const streams = buildStream(15, 150, 3.5, 3.5);
    expect(computeDecoupling(streams)).toBeNull();
  });

  it('returns null when streams are missing or mismatched', () => {
    expect(computeDecoupling(null)).toBeNull();
    expect(computeDecoupling({heartrate:{data:[1,2,3]}})).toBeNull();
  });
});

// Builds a synthetic stream with a controllable cadence drop partway through, for
// computeCadenceFade - same shape as buildStream above, plus a cadence array.
function buildCadenceStream(minutes, hr, firstHalfCadence, secondHalfCadence){
  const n = Math.round(minutes*60/6);
  const time = [], heartrate = [], cadence = [];
  for(let i=0;i<n;i++){
    time.push(i*6);
    heartrate.push(hr);
    cadence.push(i < n/2 ? firstHalfCadence : secondHalfCadence);
  }
  return { time:{data:time}, heartrate:{data:heartrate}, cadence:{data:cadence} };
}

describe('computeCadenceFade', () => {
  it('reports ~0% fade when cadence holds flat for the whole run', () => {
    const streams = buildCadenceStream(40, 150, 85, 85);
    const result = computeCadenceFade(streams);
    expect(result).not.toBeNull();
    expect(Math.abs(result.fadePct)).toBeLessThan(0.5);
    expect(result.cadenceFirst).toBe(170); // doubled from one-leg 85 to a real steps/min number
  });

  it('reports positive fade when cadence drops in the second half', () => {
    const streams = buildCadenceStream(40, 150, 85, 78); // stride rate fading late
    const result = computeCadenceFade(streams);
    expect(result.fadePct).toBeGreaterThan(5);
  });

  it('returns null for a run shorter than the 25-minute minimum', () => {
    expect(computeCadenceFade(buildCadenceStream(15, 150, 85, 85))).toBeNull();
  });

  it('returns null when there is no cadence stream (not every activity has one)', () => {
    expect(computeCadenceFade({time:{data:[0,6,12]}, heartrate:{data:[150,150,150]}})).toBeNull();
    expect(computeCadenceFade(null)).toBeNull();
  });
});

describe('computeSessionTRIMP', () => {
  const profile = {restHR: 50, maxHR: 190};

  it('matches the full-stream computeTRIMP for a constant-HR session (same underlying formula)', () => {
    const minutes = 40, hr = 150;
    const streams = buildStream(minutes, hr, 3.5, 3.5);
    const fullStream = computeTRIMP(streams, profile);
    const sessionLevel = computeSessionTRIMP(hr, minutes, profile);
    expect(sessionLevel).toBeCloseTo(fullStream, 0);
  });

  it('increases with higher average HR at the same duration (exponential weighting, not linear)', () => {
    const low = computeSessionTRIMP(130, 60, profile);
    const high = computeSessionTRIMP(170, 60, profile);
    expect(high).toBeGreaterThan(low*1.5); // exponential curve, not proportional to HR
  });

  it('returns null for missing inputs rather than a fabricated number', () => {
    expect(computeSessionTRIMP(null, 60, profile)).toBeNull();
    expect(computeSessionTRIMP(150, 0, profile)).toBeNull();
    expect(computeSessionTRIMP(150, 60, null)).toBeNull();
    expect(computeSessionTRIMP(150, 60, {restHR:60, maxHR:60})).toBeNull(); // zero HR range
  });
});
