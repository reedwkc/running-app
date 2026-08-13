// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { computeDecoupling } from './trimp.js';

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
