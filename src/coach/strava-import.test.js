// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { buildBoundariesFromStravaLaps, computeAnalysisMetrics, isPlausibleLapStructure, renderStravaLapTable } from './strava-import.js';
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

  it('stores a precise avgPaceSec alongside the whole-second-rounded avgPaceLabel, so downstream math never has to re-parse the display string', () => {
    const result = computeAnalysisMetrics(streams, laps, 170, false);
    const workLap = result.laps.find(l=>l.role==='work');
    // Real constant speed -> avgPaceSec should be exact (to float precision), not rounded
    // to the nearest whole second the way avgPaceLabel deliberately is.
    expect(workLap.avgPaceSec).toBeCloseTo(1000/4.5, 2);
    expect(parsePaceLabelToSec(workLap.avgPaceLabel)).toBe(Math.round(workLap.avgPaceSec));
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

  it('derives vo2maxEstimate from the longest work lap via the ACSM formula, not an LLM guess - gated on the lap\'s own observed HR reading as genuinely near-max for this runner, not on whatever was scheduled that day', () => {
    // Work lap's held-window avgHR lands around 174 (see the timeToTarget test above) -
    // near-max relative to a 185 maxHR (0.90*185=166.5), so this should compute regardless
    // of what session type was planned.
    const result = computeAnalysisMetrics(streams, laps, 170, false, {maxHR: 185});
    const speedKmh = 3.6*4.5;
    // Tight tolerance - this reads avgPaceSec (precise), not a re-parse of the rounded
    // display label, so it should land right on the formula's result from the raw speed.
    const expected = 3.33*speedKmh+3.5;
    expect(result.vo2maxEstimate).toBeCloseTo(expected, 1);
  });

  it('does not compute a vo2maxEstimate when the work lap\'s own HR falls short of near-max effort for this runner (e.g. threshold pace against a higher real maxHR) - the ACSM equation only approximates VO2max at near-maximal effort, and applying it to submaximal laps silently underestimates it', () => {
    // Same ~174 avgHR, but now submaximal relative to a 220 maxHR (0.90*220=198) - same
    // session, same session type, different runner profile, correctly no estimate.
    const result = computeAnalysisMetrics(streams, laps, 170, false, {maxHR: 220});
    expect(result.vo2maxEstimate).toBeNull();
  });

  it('does not compute a vo2maxEstimate when no profile/maxHR is available', () => {
    const result = computeAnalysisMetrics(streams, laps, 170, false);
    expect(result.vo2maxEstimate).toBeNull();
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

  it('computes avgCadence per lap, doubled from Strava\'s one-leg steps/min to a real steps/min reading', () => {
    const cadenceStream = Object.assign({}, streams, {cadence:{data: streams.time.data.map(()=>85)}});
    const result = computeAnalysisMetrics(cadenceStream, laps, 170, false);
    expect(result.laps.find(l=>l.role==='work').avgCadence).toBe(170);
  });

  it('omits avgCadence entirely when there is no cadence stream (not every activity has one)', () => {
    const result = computeAnalysisMetrics(streams, laps, 170, false);
    expect(result.laps.find(l=>l.role==='work').avgCadence).toBeUndefined();
  });

  it('returns laps unchanged when streams are missing', () => {
    const result = computeAnalysisMetrics(null, laps, 170, false);
    expect(result.laps).toBe(laps);
  });
});

describe('computeAnalysisMetrics - grade-adjusted pace (Minetti)', () => {
  // Constant speed and constant grade, so avgGradePct/gapPaceSec should land very close to
  // the exact analytic value with no curve-shape ambiguity to worry about.
  function buildGradedStream(durationSec, speedMps, gradeFraction, hr){
    const time=[], heartrate=[], velocity_smooth=[], distance=[], altitude=[];
    let t=0, d=0, alt=100;
    for(let i=0;i<durationSec;i++){
      time.push(t); heartrate.push(hr); velocity_smooth.push(speedMps); distance.push(d); altitude.push(alt);
      d += speedMps;
      alt += speedMps*gradeFraction;
      t += 1;
    }
    return {time:{data:time}, heartrate:{data:heartrate}, velocity_smooth:{data:velocity_smooth}, distance:{data:distance}, altitude:{data:altitude}};
  }

  it('computes avgGradePct and a faster gapPaceSec than avgPaceSec for a steady climb', () => {
    const stream = buildGradedStream(120, 4, 0.1, 150); // 10% climb at 4m/s
    const laps = [{lapNum:1, role:'work', startSec:0, endSec:120}];
    const lap = computeAnalysisMetrics(stream, laps, null, false).laps[0];
    expect(lap.avgGradePct).toBeCloseTo(10, 0);
    expect(lap.gapPaceSec).toBeLessThan(lap.avgPaceSec); // uphill -> faster flat-equivalent
    expect(lap.gapPaceLabel).toBeTruthy();
  });

  it('computes a slower gapPaceSec than avgPaceSec for a gentle descent', () => {
    const stream = buildGradedStream(120, 4, -0.08, 150);
    const laps = [{lapNum:1, role:'work', startSec:0, endSec:120}];
    const lap = computeAnalysisMetrics(stream, laps, null, false).laps[0];
    expect(lap.avgGradePct).toBeCloseTo(-8, 0);
    expect(lap.gapPaceSec).toBeGreaterThan(lap.avgPaceSec); // gentle downhill -> slower flat-equivalent
  });

  it('omits avgGradePct/gapPaceLabel entirely when there is no altitude stream', () => {
    const stream = buildGradedStream(120, 4, 0.1, 150);
    delete stream.altitude;
    const laps = [{lapNum:1, role:'work', startSec:0, endSec:120}];
    const lap = computeAnalysisMetrics(stream, laps, null, false).laps[0];
    expect(lap.avgGradePct).toBeUndefined();
    expect(lap.gapPaceLabel).toBeUndefined();
  });
});

describe('computeAnalysisMetrics - real device lap pace/distance take priority over the resampled stream', () => {
  // The reported bug: a short (~200m/~45s) VO2max-pace rep's DISPLAYED pace read
  // meaningfully slower than the same rep's real pace on Strava/Garmin/a third-party app.
  // Root cause - "velocity_smooth" is a Strava-applied LOW-PASS FILTER, and a short, sharp
  // accelerate-from-a-jog rep is exactly where that filter's lag matters most; a real device
  // lap's own avgSpeedMps is computed by the watch itself at full resolution and doesn't
  // have this problem. Simulated here with a stream reporting a slow, unrealistic constant
  // speed (standing in for smoothing-lag-distorted samples) alongside a raw lap object
  // reporting the genuinely faster real average - the real number must win.
  function buildStream(segments){
    const time=[], heartrate=[], velocity_smooth=[], distance=[];
    let t=0, d=0;
    segments.forEach(seg=>{
      for(let i=0;i<seg.durationSec;i++){
        heartrate.push(seg.hr); velocity_smooth.push(seg.speedMps); time.push(t); distance.push(d);
        d += seg.speedMps; t += 1;
      }
    });
    return {time:{data:time}, heartrate:{data:heartrate}, velocity_smooth:{data:velocity_smooth}, distance:{data:distance}};
  }

  it('uses the raw device lap\'s own avgSpeedMps for avgPaceSec, not the resampled (smoothing-lag-distorted) stream average', () => {
    // Stream says ~4.0m/s (4:10/km) throughout the "work" window - simulating a filtered
    // signal that hasn't caught up to the rep's true speed. The real device lap reports
    // 4.55m/s (3:40/km) - genuinely faster, and what must win.
    const stream = buildStream([
      {durationSec:20, speedMps:2.5, hr:130},
      {durationSec:45, speedMps:4.0, hr:160},
      {durationSec:60, speedMps:2.0, hr:140},
    ]);
    const laps = [
      {lapNum:1, role:'warmup', startSec:0, endSec:20},
      {lapNum:2, role:'work', startSec:20, endSec:65, rawAvgSpeedMps:4.55, rawDistanceM:204.75},
      {lapNum:3, role:'recovery', startSec:65, endSec:125},
    ];
    const result = computeAnalysisMetrics(stream, laps, null, false);
    const workLap = result.laps.find(l=>l.role==='work');
    expect(workLap.avgPaceSec).toBeCloseTo(1000/4.55, 2);
    expect(workLap.avgPaceSec).not.toBeCloseTo(1000/4.0, 0);
    expect(workLap.distanceKm).toBe(0.2); // distanceKm is rounded to 2 decimals, same convention as the stream-derived path
    expect(workLap.paceSource).toBe('gps');
  });

  it('falls back to the resampled stream when no raw lap data is present (curve-reading path, unchanged behavior)', () => {
    const stream = buildStream([{durationSec:45, speedMps:4.0, hr:160}]);
    const laps = [{lapNum:1, role:'work', startSec:0, endSec:45}]; // no rawAvgSpeedMps - curve-reading fallback
    const result = computeAnalysisMetrics(stream, laps, null, false);
    const workLap = result.laps[0];
    expect(workLap.avgPaceSec).toBeCloseTo(1000/4.0, 2);
  });

  it('HR still uses the stream (not a flat raw-lap average) even when a raw device lap is present - the target-reached-and-held trim is a real correction Strava\'s own lap average can\'t provide', () => {
    const stream = buildStream([
      {durationSec:20, speedMps:2.5, hr:120},
      {durationSec:45, speedMps:4.0, hr:178}, // HR already at/above a 170 floor for the whole work window in this simplified fixture
      {durationSec:60, speedMps:2.0, hr:140},
    ]);
    const laps = [
      {lapNum:1, role:'warmup', startSec:0, endSec:20},
      {lapNum:2, role:'work', startSec:20, endSec:65, rawAvgSpeedMps:4.55, rawAvgHR:165, rawDistanceM:204.75},
      {lapNum:3, role:'recovery', startSec:65, endSec:125},
    ];
    const result = computeAnalysisMetrics(stream, laps, 170, false);
    const workLap = result.laps.find(l=>l.role==='work');
    // Stream-derived (178), not the raw lap's own rawAvgHR (165) - confirms HR intentionally
    // did not switch over to the raw-lap value the way pace/distance did.
    expect(workLap.avgHR).toBe(178);
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

describe('renderStravaLapTable "vs Target" column', () => {
  // Real reported bug: an easy run's target.pace is deliberately '' (week-view.js - "route
  // is uneven enough that a pace target would be misleading"), so the pace-only vs-Target
  // logic left this column blank ("-") on every single lap of exactly the session type
  // where HR, not pace, is the real target - even though a real HR zone (target.hr) and
  // real lap HR were both right there the whole time.
  const easyParsed = {laps:[
    {lapNum:1, role:'warmup', distanceKm:0.26, avgPaceLabel:'5:50/km', avgHR:119},
    {lapNum:2, role:'work', distanceKm:6.32, avgPaceLabel:'5:35/km', avgHR:145},
    {lapNum:3, role:'cooldown', distanceKm:0.11, avgPaceLabel:'5:46/km', avgHR:145},
  ], continuousEffort:true, lapsReliable:true};

  it('falls back to an HR-zone comparison for the work/main-effort lap when there is no pace target, instead of leaving it blank', () => {
    const html = renderStravaLapTable(easyParsed, {pace:'', hr:'138-154'});
    // The work lap (145bpm, inside 138-154) gets a real comparison now - warmup/cooldown
    // correctly stay blank, same as the pace-based branch already only judges work laps.
    expect(html).toContain('in zone');
    expect((html.match(/color:var\(--dim\);">-<\/td>/g)||[]).length).toBe(2); // just warmup + cooldown
  });

  it('reports how far outside the HR zone a lap ran, above or below', () => {
    const below = renderStravaLapTable({laps:[{lapNum:1, role:'work', avgHR:120}], continuousEffort:true, lapsReliable:true}, {pace:'', hr:'138-154'});
    expect(below).toContain('18bpm below zone');
    const above = renderStravaLapTable({laps:[{lapNum:1, role:'work', avgHR:160}], continuousEffort:true, lapsReliable:true}, {pace:'', hr:'138-154'});
    expect(above).toContain('6bpm above zone');
  });

  it('the "Prescribed" banner reads as a bare HR range, not a malformed "- @ ...bpm", when there is no pace target', () => {
    const html = renderStravaLapTable(easyParsed, {pace:'', hr:'138-154'});
    expect(html).toContain('Prescribed:</b> 138-154bpm');
    expect(html).not.toContain('- @ 138-154bpm');
  });

  it('still uses the real pace-based comparison for a genuine interval session with a real pace target', () => {
    const html = renderStravaLapTable({laps:[{lapNum:1, role:'work', avgPaceSec:260, avgPaceLabel:'4:20/km', avgHR:170}], continuousEffort:false, lapsReliable:true}, {pace:'4:20/km', hr:'165-175'});
    expect(html).toContain('on target');
  });
});
