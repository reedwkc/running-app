// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { buildBoundariesFromStravaLaps, computeAnalysisMetrics, isPlausibleLapStructure } from './strava-import.js';
import { parsePaceLabelToSec } from '../lib/format.js';

// 1 sample/second synthetic stream: constant speed per segment, HR ramping linearly
// within each segment (to simulate real HR lag/decay rather than an instant jump).
function buildStream(segments){
  const time=[], heartrate=[], velocity_smooth=[], distance=[];
  let t=0, d=0;
  segments.forEach(seg=>{
    for(let i=0;i<seg.durationSec;i++){
      const frac = seg.durationSec>1 ? i/(seg.durationSec-1) : 0;
      heartrate.push(Math.round(seg.hrStart + (seg.hrEnd-seg.hrStart)*frac));
      velocity_smooth.push(seg.speedMps);
      time.push(t);
      distance.push(d);
      d += seg.speedMps;
      t += 1;
    }
  });
  return {time:{data:time}, heartrate:{data:heartrate}, velocity_smooth:{data:velocity_smooth}, distance:{data:distance}};
}

describe('computeAnalysisMetrics', () => {
  // warmup -> work (HR ramps 120->178, crossing the 170 floor near the end) -> recovery
  // (HR ramps back down, slow pace) -> cooldown
  const segments = [
    {durationSec:60, speedMps:2.5, hrStart:100, hrEnd:120},
    {durationSec:120, speedMps:4.5, hrStart:120, hrEnd:178},
    {durationSec:90, speedMps:1.3, hrStart:178, hrEnd:140},
    {durationSec:60, speedMps:2.0, hrStart:140, hrEnd:110},
  ];
  const streams = buildStream(segments);
  const laps = [
    {lapNum:1, role:'warmup', startSec:0, endSec:60},
    {lapNum:2, role:'work', startSec:60, endSec:180},
    {lapNum:3, role:'recovery', startSec:180, endSec:270},
    {lapNum:4, role:'cooldown', startSec:270, endSec:330},
  ];

  it('computes the work lap pace from the real constant speed, not an LLM guess', () => {
    const result = computeAnalysisMetrics(streams, laps, 170, false);
    const workLap = result.laps.find(l=>l.role==='work');
    expect(parsePaceLabelToSec(workLap.avgPaceLabel)).toBeCloseTo(1000/4.5, 0);
  });

  it('excludes the HR ramp-up from a work lap avgHR once target is reached and held', () => {
    const result = computeAnalysisMetrics(streams, laps, 170, false);
    const workLap = result.laps.find(l=>l.role==='work');
    // Full-segment mean would be ~149 (midpoint of 120->178); the held-from-target window
    // should read meaningfully higher, close to the segment's peak HR.
    expect(workLap.avgHR).toBeGreaterThan(165);
    expect(workLap.timeToTargetSec).toBeGreaterThan(0);
    expect(workLap.timeToTargetSec).toBeLessThan(120);
  });

  it('computes the recovery lap pace from its own real (slow) speed - this is the actual bug fix: no contamination from neighboring segments', () => {
    const result = computeAnalysisMetrics(streams, laps, 170, false);
    const recoveryLap = result.laps.find(l=>l.role==='recovery');
    const workLap = result.laps.find(l=>l.role==='work');
    const recoveryPaceSec = parsePaceLabelToSec(recoveryLap.avgPaceLabel);
    const workPaceSec = parsePaceLabelToSec(workLap.avgPaceLabel);
    expect(recoveryPaceSec).toBeCloseTo(1000/1.3, 0);
    expect(recoveryPaceSec).toBeGreaterThan(workPaceSec); // slower pace = bigger sec/km
  });

  it('computes a real recoveryHRDropBpm for recovery/cooldown laps from the actual HR drop', () => {
    const result = computeAnalysisMetrics(streams, laps, 170, false);
    const recoveryLap = result.laps.find(l=>l.role==='recovery');
    // HR ramps 178->140 linearly over 90s; drop over the first 60s should be roughly 2/3 of that range.
    expect(recoveryLap.recoveryHRDropBpm).toBeGreaterThan(15);
    expect(recoveryLap.recoveryHRDropBpm).toBeLessThan(35);
  });

  it('computes real totalDistanceKm/totalDurationMin/avgHR for the whole activity', () => {
    const result = computeAnalysisMetrics(streams, laps, 170, false);
    const expectedDistKm = Math.round((streams.distance.data.at(-1)/1000)*100)/100;
    const expectedAvgHR = Math.round(streams.heartrate.data.reduce((a,b)=>a+b,0)/streams.heartrate.data.length);
    expect(result.totalDistanceKm).toBeCloseTo(expectedDistKm, 2);
    expect(result.totalDurationMin).toBeCloseTo(330/60, 1);
    expect(result.avgHR).toBe(expectedAvgHR);
  });

  it('derives vo2maxEstimate from the longest work lap via the ACSM formula, not an LLM guess', () => {
    const result = computeAnalysisMetrics(streams, laps, 170, false);
    const speedKmh = 3.6*4.5;
    // Close to, not exactly, the formula on the raw input speed - the function re-derives
    // speed from the already-formatted (second-rounded) avgPaceLabel, same number the
    // table actually displays, so a little precision is expected to be lost in that round-trip.
    const expected = 3.33*speedKmh+3.5;
    expect(result.vo2maxEstimate).toBeCloseTo(expected, 0);
  });

  it('sets paceSource from the actual treadmill/outdoor context, not a guess', () => {
    const outdoor = computeAnalysisMetrics(streams, laps, 170, false);
    const treadmill = computeAnalysisMetrics(streams, laps, 170, true);
    expect(outdoor.laps.find(l=>l.role==='work').paceSource).toBe('gps');
    expect(treadmill.laps.find(l=>l.role==='work').paceSource).toBe('accelerometer');
  });

  it('falls back to the full segment average when a work lap never reaches the target HR', () => {
    const easySegments = [{durationSec:120, speedMps:3.0, hrStart:130, hrEnd:145}];
    const easyStream = buildStream(easySegments);
    const easyLaps = [{lapNum:1, role:'work', startSec:0, endSec:120}];
    const result = computeAnalysisMetrics(easyStream, easyLaps, 170, false); // floor never reached
    const lap = result.laps[0];
    expect(lap.timeToTargetSec).toBeUndefined();
    expect(lap.avgHR).toBeCloseTo((130+145)/2, -1); // rounding can land 137 or 138, either is correct
  });

  it('returns laps unchanged when streams are missing', () => {
    const result = computeAnalysisMetrics(null, laps, 170, false);
    expect(result.laps).toBe(laps);
  });
});

describe('isPlausibleLapStructure', () => {
  it('recognizes real alternating work/recovery laps as plausible (high distance variance)', () => {
    // warmup, work/recovery x3, cooldown - real interval-session distance pattern
    const realLaps = [
      {lapNum:1, distanceM:1200}, {lapNum:2, distanceM:1000}, {lapNum:3, distanceM:400},
      {lapNum:4, distanceM:1000}, {lapNum:5, distanceM:420}, {lapNum:6, distanceM:1000},
      {lapNum:7, distanceM:900},
    ];
    expect(isPlausibleLapStructure(realLaps)).toBe(true);
  });

  it('rejects a default fixed-distance autolap (laps all close to the same distance)', () => {
    const autolaps = [
      {lapNum:1, distanceM:1000}, {lapNum:2, distanceM:1005}, {lapNum:3, distanceM:998},
      {lapNum:4, distanceM:1002}, {lapNum:5, distanceM:995}, {lapNum:6, distanceM:1010},
    ];
    expect(isPlausibleLapStructure(autolaps)).toBe(false);
  });

  it('rejects fewer than 3 laps regardless of distance pattern', () => {
    expect(isPlausibleLapStructure([{lapNum:1, distanceM:1000}, {lapNum:2, distanceM:400}])).toBe(false);
  });

  it('rejects when any lap is missing distance data', () => {
    const laps = [{lapNum:1, distanceM:1000}, {lapNum:2, distanceM:400}, {lapNum:3, distanceM:null}];
    expect(isPlausibleLapStructure(laps)).toBe(false);
  });

  it('handles null/empty input without throwing', () => {
    expect(isPlausibleLapStructure(null)).toBe(false);
    expect(isPlausibleLapStructure([])).toBe(false);
  });
});

describe('buildBoundariesFromStravaLaps', () => {
  it('accumulates elapsedTimeSec into contiguous startSec/endSec boundaries', () => {
    const rawLaps = [
      {lapNum:1, elapsedTimeSec:60},
      {lapNum:2, elapsedTimeSec:240},
      {lapNum:3, elapsedTimeSec:90},
    ];
    const boundaries = buildBoundariesFromStravaLaps(rawLaps);
    expect(boundaries).toEqual([
      {lapNum:1, startSec:0, endSec:60},
      {lapNum:2, startSec:60, endSec:300},
      {lapNum:3, startSec:300, endSec:390},
    ]);
  });

  it('treats a missing elapsedTimeSec as zero-length rather than throwing', () => {
    const boundaries = buildBoundariesFromStravaLaps([{lapNum:1, elapsedTimeSec:null}, {lapNum:2, elapsedTimeSec:60}]);
    expect(boundaries[0]).toEqual({lapNum:1, startSec:0, endSec:0});
    expect(boundaries[1]).toEqual({lapNum:2, startSec:0, endSec:60});
  });
});
