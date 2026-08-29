// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { classifyActualEffort } from './effort.js';

const profile = {lthr: 172};

function withWorkLap(avgHR, extra){
  return Object.assign({stravaImport: {lapsReliable: true, laps: [{role:'work', avgHR}]}}, extra);
}

describe('classifyActualEffort', () => {
  it('classifies a work lap well above LTHR as vo2max', () => {
    expect(classifyActualEffort(withWorkLap(180), profile)).toBe('vo2max');
  });

  it('classifies a work lap at LTHR-8 or above (but below the vo2max band) as threshold', () => {
    expect(classifyActualEffort(withWorkLap(165), profile)).toBe('threshold'); // 172-8=164, 165>=164
    expect(classifyActualEffort(withWorkLap(172), profile)).toBe('threshold');
  });

  it('classifies a moderate work lap below the threshold band as subthreshold', () => {
    expect(classifyActualEffort(withWorkLap(158), profile)).toBe('subthreshold'); // 172-18=154, 172-8=164 -> 158 is between
  });

  it('classifies a genuinely easy work lap as easy', () => {
    expect(classifyActualEffort(withWorkLap(140), profile)).toBe('easy');
  });

  it('prefers long over subthreshold when duration is long enough, even without hard effort', () => {
    expect(classifyActualEffort(withWorkLap(158, {actualDur: 90}), profile)).toBe('long');
    expect(classifyActualEffort(withWorkLap(158, {actualDist: '15'}), profile)).toBe('long');
  });

  it('does not let a long duration override a genuinely hard effort', () => {
    expect(classifyActualEffort(withWorkLap(180, {actualDur: 90}), profile)).toBe('vo2max');
    expect(classifyActualEffort(withWorkLap(165, {actualDur: 90}), profile)).toBe('threshold');
  });

  it('uses the hardest work lap, not an average, when multiple laps are present', () => {
    const obj = {stravaImport: {lapsReliable: true, laps: [{role:'work', avgHR:145}, {role:'work', avgHR:180}, {role:'recovery', avgHR:120}]}};
    expect(classifyActualEffort(obj, profile)).toBe('vo2max');
  });

  it('ignores laps when lapsReliable is false and falls back to overall avgHR', () => {
    const obj = {stravaImport: {lapsReliable: false, laps: [{role:'work', avgHR:180}]}, avgHR: '166'};
    expect(classifyActualEffort(obj, profile)).toBe('threshold');
  });

  it('falls back to overall avgHR when there is no stravaImport at all', () => {
    expect(classifyActualEffort({avgHR: '178'}, profile)).toBe('vo2max');
  });

  it('falls back to duration-only "long" when there is no HR evidence at all', () => {
    expect(classifyActualEffort({actualDur: '90'}, profile)).toBe('long');
    expect(classifyActualEffort({actualDist: '16'}, profile)).toBe('long');
  });

  it('returns null when there is neither HR evidence nor a long enough duration to classify', () => {
    expect(classifyActualEffort({actualDur: '30'}, profile)).toBeNull();
    expect(classifyActualEffort({}, profile)).toBeNull();
  });

  it('returns null when the profile or its lthr is missing', () => {
    expect(classifyActualEffort(withWorkLap(180), null)).toBeNull();
    expect(classifyActualEffort(withWorkLap(180), {})).toBeNull();
  });

  it('returns null for a null/undefined obj', () => {
    expect(classifyActualEffort(null, profile)).toBeNull();
    expect(classifyActualEffort(undefined, profile)).toBeNull();
  });
});
