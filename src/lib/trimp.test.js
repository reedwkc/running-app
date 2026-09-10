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

const profile = {maxHR: 191, restHR: 40};

// Banister's TRIMP, written out independently from the published definition rather than
// borrowed from the implementation: TRIMP = D * HRr * 0.64 * e^(1.92*HRr), male coefficients.
const banister = (hr, minutes) => {
  const hrr = (hr - profile.restHR) / (profile.maxHR - profile.restHR);
  return minutes * hrr * 0.64 * Math.exp(1.92 * hrr);
};

const streamAt = (hr, minutes) => {
  const time = [], heartrate = [];
  for(let s = 0; s <= minutes*60; s += 10){ time.push(s); heartrate.push(hr); }
  return {time: {data: time}, heartrate: {data: heartrate}};
};

describe('TRIMP matches Banister', () => {
  it('reproduces the published formula for a steady session', () => {
    [[140, 45], [158, 30], [172, 20]].forEach(([hr, min]) => {
      expect(computeSessionTRIMP(hr, min, profile)).toBeCloseTo(Math.round(banister(hr, min)*10)/10, 1);
    });
  });

  it('gives the same answer integrated over a stream as from the session average', () => {
    expect(computeTRIMP(streamAt(160, 40), profile)).toBeCloseTo(computeSessionTRIMP(160, 40, profile), 0);
  });

  // The linear HRr factor was missing until 2026-09-10. Its absence scored resting HR as
  // real training load, which is the plainest way to see the error.
  it('scores zero load at resting heart rate, not 0.64 per minute', () => {
    expect(computeSessionTRIMP(profile.restHR, 60, profile)).toBe(0);
  });

  // The consequential half. ACWR divides one TRIMP sum by another, so a flat scaling error
  // would cancel; a SHAPE error does not. Dropping the linear factor flattened the curve and
  // made hard sessions contribute too little relative to easy ones - understating acute
  // spikes, which is the unsafe direction for an injury-risk heuristic.
  it('weights quality work against easy work in the published proportion', () => {
    const easy = computeSessionTRIMP(145, 60, profile);
    const hard = computeSessionTRIMP(170, 60, profile);
    expect(hard/easy).toBeCloseTo(banister(170, 60)/banister(145, 60), 2);
    expect(hard/easy).toBeGreaterThan(1.6);   // the real ratio is ~1.70
    const flattened = Math.exp(1.92*((170-40)/151)) / Math.exp(1.92*((145-40)/151));
    expect(flattened).toBeLessThan(1.45);     // what the old formula produced, ~1.37
  });

  it('refuses rather than guesses on unusable input', () => {
    expect(computeSessionTRIMP(150, 0, profile)).toBeNull();
    expect(computeSessionTRIMP(null, 30, profile)).toBeNull();
    expect(computeSessionTRIMP(150, 30, {maxHR: 180, restHR: 180})).toBeNull();
    expect(computeTRIMP({time:{data:[0]}, heartrate:{data:[150]}}, profile)).toBeNull();
    expect(computeTRIMP({time:{data:[0,10]}, heartrate:{data:[150]}}, profile)).toBeNull();
  });
});

describe('aerobic decoupling', () => {
  // Friel's aerobic decoupling: efficiency (speed per heartbeat) in the first half against
  // the second, expressed as the percentage the second half fell short.
  function run({firstSpeed, firstHR, secondSpeed, secondHR, minutes}){
    const time = [], heartrate = [], velocity_smooth = [];
    const total = minutes*60;
    for(let s = 0; s <= total; s += 10){
      time.push(s);
      const second = s >= total/2;
      heartrate.push(second ? secondHR : firstHR);
      velocity_smooth.push(second ? secondSpeed : firstSpeed);
    }
    return {time:{data:time}, heartrate:{data:heartrate}, velocity_smooth:{data:velocity_smooth}};
  }

  it('reads zero decoupling when pace and HR both hold', () => {
    const d = computeDecoupling(run({firstSpeed:3.0, firstHR:150, secondSpeed:3.0, secondHR:150, minutes:90}));
    expect(d.decouplingPct).toBeCloseTo(0, 1);
  });

  it('reads real decoupling when HR drifts up at unchanged pace', () => {
    const d = computeDecoupling(run({firstSpeed:3.0, firstHR:150, secondSpeed:3.0, secondHR:159, minutes:90}));
    // efficiency falls from 3.0/150 to 3.0/159, i.e. by 1 - 150/159 = 5.66%
    expect(d.decouplingPct).toBeCloseTo(5.7, 1);
  });

  it('declines to judge a run too short to drift', () => {
    expect(computeDecoupling(run({firstSpeed:3.0, firstHR:150, secondSpeed:3.0, secondHR:160, minutes:20}))).toBeNull();
  });

  // Why a progressive long run must not feed the decoupling trend: running the second half
  // harder drives HR up more than proportionally, so efficiency falls by DESIGN and the
  // metric reports late-run fade that never happened.
  it('misreads a deliberately progressive run as fade, which is why those are now excluded', () => {
    const d = computeDecoupling(run({firstSpeed:2.9, firstHR:145, secondSpeed:3.3, secondHR:172, minutes:100}));
    expect(d.decouplingPct).toBeGreaterThan(3);
  });
});
