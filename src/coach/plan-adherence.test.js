// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../state.js';
import { workoutKey } from '../lib/keys.js';
import { computeZones } from '../data/plan.js';
import { defaultGoalConfig } from '../data/goal-config.js';
import { computeSessionTRIMP } from '../lib/trimp.js';
import { buildSwapProposal, classifySessionAdherence, countMissedSessionsByType, deliveredDoseTRIMP, detectConsistentShortfalls, detectHardSessionProximity, detectScheduledHardSessionProximity, detectLikelySwaps, effectiveSessionTypes, getHardSessionProximityFlags, getLikelySwapSuggestions, getMissedSessionAdjustments, hardSessionProximityBannerHTML, importanceForGoalDistance, missedSessionBannerHTML, prescribedDoseTRIMP, prescribedWholeSessionDoseTRIMP, swapSuggestionBannerHTML } from './plan-adherence.js';

const PROFILE = {lthr:171, ltPaceSec:275, maxHR:191, vo2max:53, restHR:40};
// Same optimal-HR-per-zone values plan-adherence.js's own optimalHRForZone uses (mirrors
// computeOptimalHR in ui/week-view.js) - reproduced here only to compute EXPECTED test
// values via the real computeSessionTRIMP formula, not to duplicate the production logic.
const OPT_HR = {S2: Math.round(PROFILE.lthr*0.83), S4: Math.round(PROFILE.lthr*0.975), S5: Math.round(PROFILE.maxHR*0.95)};

function day(tag, type, opts){
  opts = opts || {};
  let data;
  const zone = opts.zone || (type==='threshold'?'S4':type==='vo2max'?'S5':'S2');
  if(type==='easy') data = {km: opts.km!=null?opts.km:8};
  else if(type==='long') data = {segments: opts.segments || [{km: opts.km!=null?opts.km:16, zone: opts.zone||'S2'}]};
  else {
    const reps = opts.reps!=null?opts.reps:4;
    const repTimeSec = opts.repTimeSec!=null?opts.repTimeSec:300;
    const paceSpk = opts.paceSpk!=null ? opts.paceSpk : (state.Z && state.Z[zone] ? state.Z[zone].pace : undefined);
    data = {
      main:{reps, repTimeSec, recoverySec: opts.recoverySec!=null?opts.recoverySec:120, paceSpk, label: reps+' x '+repTimeSec+'s'},
      wu:{km: opts.wuKm!=null?opts.wuKm:1.5}, cd:{km: opts.cdKm!=null?opts.cdKm:1.5},
    };
  }
  return {tag, name: opts.name||(type+' session'), type, zone, data};
}

describe('prescribedDoseTRIMP', () => {
  beforeEach(() => { state.Z = computeZones(PROFILE, defaultGoalConfig()); });

  it('threshold: matches computeSessionTRIMP at the zone\'s optimal HR for the prescribed work time', () => {
    const d = day('x', 'threshold', {reps:6, repTimeSec:240}); // 6 x 4min = 24min work
    const expected = computeSessionTRIMP(OPT_HR.S4, (6*240)/60, PROFILE);
    expect(prescribedDoseTRIMP(d, PROFILE)).toBeCloseTo(expected, 5);
  });

  it('vo2max: uses the S5 (near-max) optimal HR, not the threshold one', () => {
    const d = day('x', 'vo2max', {reps:6, repTimeSec:180});
    const expected = computeSessionTRIMP(OPT_HR.S5, (6*180)/60, PROFILE);
    expect(prescribedDoseTRIMP(d, PROFILE)).toBeCloseTo(expected, 5);
  });

  it('long: sums each segment\'s own zone-appropriate dose (a progression long run, not one flat number)', () => {
    const d = day('x', 'long', {segments:[{km:8, zone:'S2'}, {km:4, zone:'S3'}]});
    const s1min = (8*state.Z.S2.pace)/60, s2min = (4*state.Z.S3.pace)/60;
    const expected = computeSessionTRIMP(OPT_HR.S2, s1min, PROFILE) + computeSessionTRIMP(Math.round(PROFILE.lthr*0.92), s2min, PROFILE);
    expect(prescribedDoseTRIMP(d, PROFILE)).toBeCloseTo(expected, 5);
  });

  it('easy: single S2-zone segment for the prescribed km', () => {
    const d = day('x', 'easy', {km:10});
    const expected = computeSessionTRIMP(OPT_HR.S2, (10*state.Z.S2.pace)/60, PROFILE);
    expect(prescribedDoseTRIMP(d, PROFILE)).toBeCloseTo(expected, 5);
  });

  it('a threshold day prescribed HOTTER (or with more reps) has a strictly higher prescribed dose', () => {
    const base = prescribedDoseTRIMP(day('x','threshold',{reps:6, repTimeSec:240}), PROFILE);
    const moreReps = prescribedDoseTRIMP(day('x','threshold',{reps:8, repTimeSec:240}), PROFILE);
    expect(moreReps).toBeGreaterThan(base);
  });

  it('returns null when the day/profile/data needed to compute a dose is missing', () => {
    expect(prescribedDoseTRIMP(null, PROFILE)).toBeNull();
    expect(prescribedDoseTRIMP(day('x','threshold'), null)).toBeNull();
    expect(prescribedDoseTRIMP({type:'threshold', data:{}}, PROFILE)).toBeNull();
  });
});

describe('deliveredDoseTRIMP', () => {
  it('threshold: sums computeSessionTRIMP over each real work lap\'s own avgHR and duration (both genuinely threshold-zone, not near-max)', () => {
    const entry = {stravaImport:{laps:[
      {role:'warmup'}, {role:'work', avgHR:168, durationSec:240}, {role:'recovery'},
      {role:'work', avgHR:170, durationSec:240}, {role:'cooldown'},
    ]}};
    const expected = computeSessionTRIMP(168, 4, PROFILE) + computeSessionTRIMP(170, 4, PROFILE);
    expect(deliveredDoseTRIMP(entry, 'threshold', PROFILE)).toBeCloseTo(expected, 5);
  });

  it('threshold: excludes a rep run at genuinely near-max HR from threshold\'s own delivered dose - that\'s VO2max-zone effort, not threshold, however much extra TRIMP it would otherwise appear to hand to the wrong slot', () => {
    const entry = {stravaImport:{laps:[
      {role:'work', avgHR:168, durationSec:240}, {role:'work', avgHR:185, durationSec:240}, // 185 is near-max, not threshold-zone
    ]}};
    const expected = computeSessionTRIMP(168, 4, PROFILE); // only the genuinely threshold-zone rep counts
    expect(deliveredDoseTRIMP(entry, 'threshold', PROFILE)).toBeCloseTo(expected, 5);
  });

  it('vo2max: does NOT exclude near-max reps (there\'s no higher zone to misattribute to) - both laps count', () => {
    const entry = {stravaImport:{laps:[{role:'work', avgHR:185, durationSec:180}, {role:'work', avgHR:188, durationSec:180}]}};
    const expected = computeSessionTRIMP(185, 3, PROFILE) + computeSessionTRIMP(188, 3, PROFILE);
    expect(deliveredDoseTRIMP(entry, 'vo2max', PROFILE)).toBeCloseTo(expected, 5);
  });

  it('threshold/vo2max: continuousEffort (a flat easy curve, not real interval work) delivers exactly zero', () => {
    const entry = {stravaImport:{continuousEffort:true, laps:[{role:'work', avgHR:135, durationSec:1800}]}};
    expect(deliveredDoseTRIMP(entry, 'threshold', PROFILE)).toBe(0);
  });

  it('threshold/vo2max: genuinely no data at all (no import, no manual avgHR/duration) returns null - trust the schedule upstream', () => {
    expect(deliveredDoseTRIMP({}, 'threshold', PROFILE)).toBeNull();
  });

  it('long/easy: prefers the real, full-stream-integrated estimatedTRIMP when present', () => {
    const entry = {stravaImport:{estimatedTRIMP:123.4}};
    expect(deliveredDoseTRIMP(entry, 'long', PROFILE)).toBe(123.4);
  });

  it('long/easy: falls back to the avgHR+duration formula with no Strava import', () => {
    const entry = {avgHR:150, actualDur:60};
    const expected = computeSessionTRIMP(150, 60, PROFILE);
    expect(deliveredDoseTRIMP(entry, 'long', PROFILE)).toBeCloseTo(expected, 5);
  });

  it('long/easy: null when there is truly nothing to compute from', () => {
    expect(deliveredDoseTRIMP({}, 'long', PROFILE)).toBeNull();
  });
});

describe('prescribedWholeSessionDoseTRIMP', () => {
  beforeEach(() => { state.Z = computeZones(PROFILE, defaultGoalConfig()); });

  it('sums warmup + work + between-rep recovery + cooldown, each at its own realistic zone, not just the work-only figure', () => {
    const d = day('x', 'threshold', {reps:4, repTimeSec:300, recoverySec:120, wuKm:1.5, cdKm:1.5});
    const whole = prescribedWholeSessionDoseTRIMP(d, PROFILE);
    const workOnly = prescribedDoseTRIMP(d, PROFILE);
    expect(whole).toBeGreaterThan(workOnly); // warmup/recovery/cooldown time adds real dose on top of the work-only figure
  });

  it('returns null when there is nothing to compute a whole-session figure from', () => {
    expect(prescribedWholeSessionDoseTRIMP(null, PROFILE)).toBeNull();
    expect(prescribedWholeSessionDoseTRIMP({type:'threshold', zone:'S4', data:{}}, PROFILE)).toBeNull();
  });
});

describe('effectiveSessionTypes (dose-based credit)', () => {
  beforeEach(() => { state.Z = computeZones(PROFILE, defaultGoalConfig()); });

  it('THE EXACT SCENARIO ASKED ABOUT: a 40min/142bpm run manually logged (no Strava import) against a threshold day earns real, honestly-computed partial credit - not full trust-the-schedule credit, and not an arbitrarily low number either', () => {
    const scheduled = day('x', 'threshold', {reps:4, repTimeSec:300, recoverySec:120, wuKm:1.5, cdKm:1.5});
    const entry = {completed:true, avgHR:142, actualDur:40};
    const types = effectiveSessionTypes(entry, scheduled, PROFILE);
    const expectedRatio = Math.min(1, computeSessionTRIMP(142, 40, PROFILE) / prescribedWholeSessionDoseTRIMP(scheduled, PROFILE));
    expect(types.threshold).toBeCloseTo(expectedRatio, 5);
    expect(types.threshold).toBeLessThan(1); // never rounds up to full credit just because something was logged
    // For THIS profile (maxHR 191, restHR 40), 142bpm sits almost exactly at the S2/steady
    // zone HR (~142), not the S1/easy zone (~123) - so a 40min/142bpm run is genuinely a
    // moderate-dose effort here, not a trivial one, and a high partial-credit number is the
    // correct answer, not a bug. Different profiles (higher easy HR) would score this lower.
    expect(types.threshold).toBeGreaterThan(0.5);
  });

  it('a manually-logged whole-session avgHR/duration that DOES plausibly match a real threshold session is not penalized by the whole-session-vs-work-only mismatch', () => {
    const scheduled = day('x', 'threshold', {reps:4, repTimeSec:300, recoverySec:120, wuKm:1.5, cdKm:1.5});
    // Roughly the real whole-session shape: mostly at/near threshold effort.
    const entry = {completed:true, avgHR:160, actualDur:35};
    const types = effectiveSessionTypes(entry, scheduled, PROFILE);
    expect(types.threshold).toBeGreaterThan(0.6);
  });

  it('with genuinely no data (no import, no manual avgHR/duration), still trusts the schedule fully', () => {
    const scheduled = day('x', 'threshold');
    expect(effectiveSessionTypes({completed:true}, scheduled, PROFILE)).toEqual({threshold:1});
  });

  it('doing 2 of 8 prescribed reps AT the target HR gives real proportional credit close to 2/8, not full credit', () => {
    const scheduled = day('x', 'threshold', {reps:8, repTimeSec:240});
    const entry = {completed:true, stravaImport:{laps:[
      {role:'work', durationSec:240, avgHR:OPT_HR.S4}, {role:'work', durationSec:240, avgHR:OPT_HR.S4},
    ]}};
    const types = effectiveSessionTypes(entry, scheduled, PROFILE);
    const expected = deliveredDoseTRIMP(entry, 'threshold', PROFILE) / prescribedDoseTRIMP(scheduled, PROFILE);
    expect(types.threshold).toBeCloseTo(Math.min(1, expected), 5);
    expect(types.threshold).toBeLessThan(0.4); // nowhere near full credit for 2 of 8
  });

  it('THE ACTUAL QUESTION ASKED: 5 reps at a higher-than-target HR earns MORE credit than 5 reps at exactly target HR - intensity genuinely offsets missing volume, it isn\'t ignored', () => {
    const scheduled = day('x', 'threshold', {reps:6, repTimeSec:240}); // 6 x 4min @ optimal HR 167ish prescribed
    const atTarget = {completed:true, stravaImport:{laps: Array.from({length:5},()=>({role:'work', durationSec:240, avgHR:OPT_HR.S4}))}};
    const hotter = {completed:true, stravaImport:{laps: Array.from({length:5},()=>({role:'work', durationSec:240, avgHR:OPT_HR.S4+3}))}}; // still real threshold-zone effort, not so hot it crosses into VO2max territory
    const creditAtTarget = effectiveSessionTypes(atTarget, scheduled, PROFILE).threshold;
    const creditHotter = effectiveSessionTypes(hotter, scheduled, PROFILE).threshold;
    expect(creditHotter).toBeGreaterThan(creditAtTarget);
  });

  it('more reps than prescribed but at a LOWER HR than target can net out to LESS credit than fewer reps at target, or more - it\'s a real computed tradeoff, not a fixed rule either way', () => {
    const scheduled = day('x', 'threshold', {reps:6, repTimeSec:240});
    // 7 reps (more than the 6 prescribed) but well under target HR.
    const moreRepsLowHR = {completed:true, stravaImport:{laps: Array.from({length:7},()=>({role:'work', durationSec:240, avgHR:OPT_HR.S4-15}))}};
    const types = effectiveSessionTypes(moreRepsLowHR, scheduled, PROFILE);
    const expected = Math.min(1, deliveredDoseTRIMP(moreRepsLowHR, 'threshold', PROFILE) / prescribedDoseTRIMP(scheduled, PROFILE));
    expect(types.threshold).toBeCloseTo(expected, 5); // whatever the real dose math says, not "7>6 so it's fine"
  });

  it('long run: a shorter run at a genuinely higher HR earns more credit than the same shorter duration at target HR', () => {
    const scheduled = day('x', 'long', {km:16, zone:'S2'}); // 16km prescribed at easy HR
    const shortAtTarget = {completed:true, avgHR:OPT_HR.S2, actualDur:60};
    const shortHotter = {completed:true, avgHR:OPT_HR.S2+10, actualDur:60};
    const c1 = effectiveSessionTypes(shortAtTarget, scheduled, PROFILE).long;
    const c2 = effectiveSessionTypes(shortHotter, scheduled, PROFILE).long;
    expect(c2).toBeGreaterThan(c1);
  });

  it('a long run and an easy run differ only in how much dose is PRESCRIBED (mostly duration), not in the accounting rule - same formula, different inputs', () => {
    const longDay = day('x', 'long', {km:18, zone:'S2'});
    const easyDay = day('x', 'easy', {km:18});
    // Same distance/zone prescribed - the two should come out to essentially the same
    // prescribed dose, because "long vs easy" was never a separate rule, just a different
    // prescribed duration/zone in practice.
    expect(prescribedDoseTRIMP(longDay, PROFILE)).toBeCloseTo(prescribedDoseTRIMP(easyDay, PROFILE), 5);
  });

  it('real data showing NO qualifying work at all withholds threshold/vo2max credit entirely (a genuinely different session) - falls back to easy', () => {
    const entry = {completed:true, stravaImport:{continuousEffort:true, laps:[{role:'work', durationSec:1800, avgHR:135}]}};
    const types = effectiveSessionTypes(entry, day('x','threshold'), PROFILE);
    expect(types.threshold).toBeUndefined();
    expect(types.easy).toBe(1);
  });

  it('no Strava data at all is NOT treated as contrary evidence - trusts the schedule fully', () => {
    expect(effectiveSessionTypes({completed:true, rpe:7}, day('x','vo2max'), PROFILE).vo2max).toBe(1);
  });

  it('bonus VO2max credit from a real per-lap near-max effort on a day scheduled as something else (the surprise-workout case) does not override a scheduled type\'s own dose credit', () => {
    const scheduled = day('x', 'long', {km:16, zone:'S2'});
    const entry = {completed:true, actualDur:25, avgHR:null, stravaImport:{laps:[{role:'work', avgHR:180, durationSec:300}]}};
    const types = effectiveSessionTypes(entry, scheduled, PROFILE);
    expect(types.vo2max).toBe(1); // 180 >= 191*0.9, 300s >= 120s - real near-max evidence
    expect(types.long).toBeGreaterThan(0); // the real (short) duration still earns its own honest, smaller dose credit
    expect(types.long).toBeLessThan(1);
  });

  it('bonus credit does not re-trigger for the SAME type the proportional branch already measured (would silently overwrite a precise ratio back to full credit)', () => {
    const scheduled = day('x', 'vo2max', {reps:8, repTimeSec:240});
    // 6 of 8 reps, all genuinely near-max HR (which would ALSO qualify for the bonus path if not excluded for same-type).
    const entry = {completed:true, stravaImport:{laps: Array.from({length:6},()=>({role:'work', durationSec:240, avgHR:185}))}};
    const types = effectiveSessionTypes(entry, scheduled, PROFILE);
    const expected = Math.min(1, deliveredDoseTRIMP(entry, 'vo2max', PROFILE) / prescribedDoseTRIMP(scheduled, PROFILE));
    expect(types.vo2max).toBeCloseTo(expected, 5);
    expect(types.vo2max).toBeLessThan(1); // NOT silently bumped to full credit by the bonus path
  });
});

describe('countMissedSessionsByType / getMissedSessionAdjustments (integration)', () => {
  beforeEach(() => {
    state.WEEKS = [];
    state.recentSaveCache = {};
    state.profile = PROFILE;
    state.Z = computeZones(PROFILE, defaultGoalConfig());
    state.goalConfig = undefined;
  });

  it('counts a past, never-logged session as missed', async () => {
    state.WEEKS = [{n:1, dates:'Aug 3-9', days:[day('Wed - Aug 5', 'long')]}];
    window.storage = {get: vi.fn(async ()=>null)};
    const result = await countMissedSessionsByType('long', 6);
    expect(result.scheduled).toBe(1);
    expect(result.missed).toBe(1);
  });

  it('does not count a completed session with no comparable data as missed (trusts the schedule)', async () => {
    state.WEEKS = [{n:1, dates:'Aug 3-9', days:[day('Wed - Aug 5', 'threshold')]}];
    window.storage = {get: vi.fn(async ()=>({value: JSON.stringify({completed:true})}))};
    expect((await countMissedSessionsByType('threshold', 6)).missed).toBe(0);
  });

  it('counts a skipped session as missed', async () => {
    state.WEEKS = [{n:1, dates:'Aug 3-9', days:[day('Wed - Aug 5', 'vo2max')]}];
    window.storage = {get: vi.fn(async ()=>({value: JSON.stringify({completed:false, skipped:true})}))};
    expect((await countMissedSessionsByType('vo2max', 6)).missed).toBe(1);
  });

  it('does not count a rescheduled-and-completed session as missed', async () => {
    state.WEEKS = [{n:1, dates:'Aug 3-9', days:[day('Wed - Aug 5', 'long')]}];
    window.storage = {get: vi.fn(async ()=>({value: JSON.stringify({completed:true, performedOnTag:'Thu - Aug 6'})}))};
    expect((await countMissedSessionsByType('long', 6)).missed).toBe(0);
  });

  it('picks up a real workout logged on an otherwise-open day - the swap/free-workout gap this closes', async () => {
    state.WEEKS = [{n:1, dates:'Aug 3-9', days:[day('Wed - Aug 5', 'vo2max')]}];
    window.storage = {get: vi.fn(async (key)=>{
      if(key.includes('FriAug7')) return {value: JSON.stringify({completed:true, freeform:true, actualDur:35, stravaImport:{laps:[{role:'work', avgHR:180, durationSec:300}]}})};
      return null;
    })};
    const result = await countMissedSessionsByType('vo2max', 6);
    expect(result.scheduled).toBe(1);
    expect(result.delivered).toBeGreaterThan(0);
    expect(result.missed).toBeLessThan(1);
  });

  it('the exact scenario asked about: 2 of 8 reps produces a real flagged pattern, not a silently-full-credit non-event', async () => {
    state.goalConfig = {activeGoals:[{zoneKey:'GOAL', distanceKm:21.1}]}; // HM -> threshold critical
    state.WEEKS = [{n:1, dates:'Jul 20-26', days:[day('Wed - Jul 22', 'threshold', {reps:8, repTimeSec:240})]},
      {n:2, dates:'Jul 27-Aug 2', days:[day('Wed - Jul 29', 'threshold', {reps:8, repTimeSec:240})]},
      {n:3, dates:'Aug 3-9', days:[day('Wed - Aug 5', 'threshold', {reps:8, repTimeSec:240})]}];
    window.storage = {get: vi.fn(async ()=>({value: JSON.stringify({completed:true, stravaImport:{laps:[
      {role:'work', durationSec:240, avgHR:170}, {role:'work', durationSec:240, avgHR:172},
    ]}})}))};
    const adjustments = await getMissedSessionAdjustments();
    const thresholdAdj = adjustments.find(a=>a.type==='threshold');
    expect(thresholdAdj).toBeDefined();
    expect(thresholdAdj.severity).toBe('significant');
  });

  it('rounds missed/delivered to at most 1 decimal - fractional per-session credit must not leak raw floating-point noise into the banner', async () => {
    state.goalConfig = {activeGoals:[{zoneKey:'GOAL', distanceKm:42.2}]}; // marathon -> long critical
    state.WEEKS = [
      {n:1, dates:'Jul 20-26', days:[day('Sat - Jul 25', 'long', {km:16})]},
      {n:2, dates:'Jul 27-Aug 2', days:[day('Sat - Aug 1', 'long', {km:16})]},
      {n:3, dates:'Aug 3-9', days:[day('Sat - Aug 8', 'long', {km:16})]},
    ];
    // A manually-logged partial long run (real avgHR+duration, no Strava stream) produces a
    // delivered TRIMP that divides unevenly against the prescribed dose - exactly the kind of
    // input that used to surface as 2.0855165595650025 in the banner instead of a clean 2.1.
    window.storage = {get: vi.fn(async (key)=>{
      if(key.includes('SatJul25')) return {value: JSON.stringify({completed:true, actualDur:37, avgHR:151})};
      return null;
    })};
    const adjustments = await getMissedSessionAdjustments();
    const longAdj = adjustments.find(a=>a.type==='long');
    expect(longAdj).toBeDefined();
    const decimalsOf = n => (String(n).split('.')[1]||'').length;
    expect(decimalsOf(longAdj.missed)).toBeLessThanOrEqual(1);
    expect(decimalsOf(longAdj.delivered)).toBeLessThanOrEqual(1);
  });

  it('does not clamp the window when no goal change has ever happened (no blockStartedAt)', async () => {
    state.goalConfig = defaultGoalConfig(); // no blockStartedAt field at all
    state.WEEKS = [{n:1, dates:'Jul 20-26', days:[day('Wed - Jul 22', 'long')]}];
    window.storage = {get: vi.fn(async ()=>null)};
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-01T12:00:00'));
    try{
      const result = await countMissedSessionsByType('long', 6);
      expect(result.scheduled).toBe(1);
      expect(result.missed).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('does not count a session from BEFORE the current training block started, even if it falls inside windowWeeks', async () => {
    state.goalConfig = Object.assign({}, defaultGoalConfig(), {blockStartedAt: '2026-07-30T00:00:00.000Z'});
    state.WEEKS = [{n:1, dates:'Jul 20-26', days:[day('Wed - Jul 22', 'long')]}]; // before the new block
    window.storage = {get: vi.fn(async ()=>null)};
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-01T12:00:00'));
    try{
      const result = await countMissedSessionsByType('long', 6);
      expect(result.scheduled).toBe(0); // excluded - happened before this block began
      expect(result.missed).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('still counts a session AFTER the current block started, inside the same window', async () => {
    state.goalConfig = Object.assign({}, defaultGoalConfig(), {blockStartedAt: '2026-07-30T00:00:00.000Z'});
    state.WEEKS = [{n:1, dates:'Jul 20-Aug 2', days:[day('Sat - Aug 1', 'long')]}]; // after the block started
    window.storage = {get: vi.fn(async ()=>null)};
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-02T12:00:00'));
    try{
      const result = await countMissedSessionsByType('long', 6);
      expect(result.scheduled).toBe(1);
      expect(result.missed).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('the exact scenario asked about: consistently running one threshold rep short every week across a full HM block gets flagged, where the gap check alone would miss it', async () => {
    state.goalConfig = {activeGoals:[{zoneKey:'GOAL', distanceKm:21.1}]}; // HM -> threshold critical
    const tags = ['Wed - Jul 22', 'Wed - Jul 29', 'Wed - Aug 5', 'Wed - Aug 12', 'Wed - Aug 19', 'Wed - Aug 26'];
    state.WEEKS = tags.map((tag,i)=>({n:i+1, dates:tag, days:[day(tag, 'threshold', {reps:6, repTimeSec:240})]}));
    // 5 of 6 reps, every single week, run at EXACTLY the S4 target HR (167 = round(171*0.975))
    // so the dose ratio isolates the missing rep itself, not an HR bonus/penalty on top of
    // it - never a missed session (always completed), never a growing gap (the same ratio
    // every week forever).
    window.storage = {get: vi.fn(async ()=>({value: JSON.stringify({completed:true, stravaImport:{laps:
      Array.from({length:5}, ()=>({role:'work', durationSec:240, avgHR:167}))
    }})}))};
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-01T12:00:00'));
    try{
      const adjustments = await getMissedSessionAdjustments();
      const consistent = adjustments.find(a=>a.type==='threshold' && a.kind==='consistentShortfall');
      expect(consistent).toBeDefined();
      // ~5/6 reps -> roughly 83%; not pinned exactly since TRIMP's HR-rounding introduces a
      // point or two of noise around the pure reps ratio
      expect(consistent.avgPct).toBeGreaterThanOrEqual(78);
      expect(consistent.avgPct).toBeLessThanOrEqual(88);
      // the whole point: the OLD scheduled-vs-delivered gap check alone does NOT catch this,
      // because a steady ~17% shortfall every week never crosses its fraction thresholds
      const gapFlag = adjustments.find(a=>a.type==='threshold' && a.kind==='gap');
      expect(gapFlag).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});

describe('importanceForGoalDistance', () => {
  it('weights VO2max as critical for a 5K-ish goal, threshold critical for 10K, threshold critical/long important for HM, long critical for marathon', () => {
    expect(importanceForGoalDistance(5).vo2max).toBe('critical');
    expect(importanceForGoalDistance(10).threshold).toBe('critical');
    expect(importanceForGoalDistance(21.1).threshold).toBe('critical');
    expect(importanceForGoalDistance(21.1).long).toBe('important');
    expect(importanceForGoalDistance(42.2).long).toBe('critical');
  });

  it('easy is always supportive, regardless of goal distance', () => {
    [5, 10, 21.1, 42.2, null].forEach(d=> expect(importanceForGoalDistance(d).easy).toBe('supportive'));
  });

  it('falls back to a balanced weighting with no specific active goal (maintenance phase)', () => {
    const imp = importanceForGoalDistance(null);
    expect(imp.threshold).toBe('important');
    expect(imp.vo2max).toBe('important');
    expect(imp.long).toBe('important');
  });
});

describe('classifySessionAdherence', () => {
  it('never flags a single missed session, whatever the importance', () => {
    expect(classifySessionAdherence({type:'threshold', scheduled:6, missed:1, windowWeeks:6}, 'critical')).toBeNull();
  });

  it('critical: moderate then significant as the missed fraction rises', () => {
    expect(classifySessionAdherence({type:'threshold', scheduled:8, missed:3, windowWeeks:6}, 'critical').severity).toBe('moderate'); // 0.375
    expect(classifySessionAdherence({type:'long', scheduled:6, missed:4, windowWeeks:6}, 'critical').severity).toBe('significant'); // 0.667
  });

  it('supportive tolerates a much higher fraction before flagging anything', () => {
    expect(classifySessionAdherence({type:'easy', scheduled:10, missed:5, windowWeeks:6}, 'supportive')).toBeNull();
    expect(classifySessionAdherence({type:'easy', scheduled:10, missed:8, windowWeeks:6}, 'supportive').flagGoalConfidence).toBe(false);
  });

  it('the SAME raw numbers classify differently depending on importance - this is the whole point', () => {
    const counts = {type:'x', scheduled:8, missed:3, windowWeeks:6};
    expect(classifySessionAdherence(counts, 'critical').severity).toBe('moderate');
    expect(classifySessionAdherence(counts, 'important')).toBeNull();
    expect(classifySessionAdherence(counts, 'supportive')).toBeNull();
  });

  it('returns null for missing/empty counts', () => {
    expect(classifySessionAdherence(null, 'critical')).toBeNull();
  });
});

describe('detectConsistentShortfalls', () => {
  function sessionsOf(type, ratios){
    return ratios.map((r,i)=>({weekN:i+1, dayTag:'Wed - Week'+(i+1), name:type+' session', scheduledType:type, credits:{[type]:r}}));
  }

  it('the exact scenario asked about: consistently running one threshold rep short every week never accumulates into a big enough scheduled-vs-delivered gap to be caught any other way', () => {
    // 6x1000 prescribed, 5x1000 delivered, every single week - never a "missed session"
    // (day always marked completed), never a growing gap (same ratio forever) - only this
    // consistency-focused check can see it.
    const sessionLog = sessionsOf('threshold', [5/6, 5/6, 5/6, 5/6, 5/6, 5/6]);
    const results = detectConsistentShortfalls(sessionLog, {threshold:'critical'});
    const thresholdResult = results.find(r=>r.type==='threshold');
    expect(thresholdResult).toBeDefined();
    expect(thresholdResult.kind).toBe('consistentShortfall');
    expect(thresholdResult.avgPct).toBe(83);
  });

  it('does not flag fewer than MIN_SESSIONS data points as a pattern', () => {
    const sessionLog = sessionsOf('threshold', [0.5, 0.5]); // only 2 real sessions logged
    expect(detectConsistentShortfalls(sessionLog, {threshold:'critical'})).toEqual([]);
  });

  it('does not flag sessions that are actually being completed at/near full prescription', () => {
    const sessionLog = sessionsOf('easy', [1, 1, 0.95, 1, 1]);
    expect(detectConsistentShortfalls(sessionLog, {easy:'supportive'})).toEqual([]);
  });

  it('tolerates one off day among several without losing a real pattern', () => {
    const sessionLog = sessionsOf('vo2max', [0.7, 0.7, 0.7, 0.7, 1.0]); // 4 of 5 consistently short
    const result = detectConsistentShortfalls(sessionLog, {vo2max:'important'}).find(r=>r.type==='vo2max');
    expect(result).toBeDefined();
  });

  it('does NOT flag when too many sessions are actually fine (below the pattern fraction)', () => {
    const sessionLog = sessionsOf('vo2max', [0.7, 0.7, 1.0, 1.0, 1.0]); // only 2 of 5 short
    expect(detectConsistentShortfalls(sessionLog, {vo2max:'important'})).toEqual([]);
  });

  it('critical importance flags a smaller shortfall than supportive would tolerate', () => {
    const ratios = [0.88, 0.88, 0.88, 0.88]; // below the critical shortBar (0.92) but above supportive's (0.85)
    const sessionLog = sessionsOf('threshold', ratios);
    expect(detectConsistentShortfalls(sessionLog, {threshold:'critical'}).find(r=>r.type==='threshold')).toBeDefined();
    expect(detectConsistentShortfalls(sessionLog, {threshold:'supportive'}).find(r=>r.type==='threshold')).toBeUndefined();
  });

  it('severity is significant when the average ratio falls below the importance-specific significantBar', () => {
    const shallow = sessionsOf('threshold', [0.88, 0.88, 0.88, 0.88]); // moderate for critical (0.85 bar)
    const deep = sessionsOf('threshold', [0.75, 0.75, 0.75, 0.75]); // significant for critical
    expect(detectConsistentShortfalls(shallow, {threshold:'critical'}).find(r=>r.type==='threshold').severity).toBe('moderate');
    expect(detectConsistentShortfalls(deep, {threshold:'critical'}).find(r=>r.type==='threshold').severity).toBe('significant');
  });

  it('ignores bonus credit for a type that was not actually scheduled that day', () => {
    // a real vo2max effort logged on a day scheduled as something else shouldn't count as
    // evidence about how the runner executes actual vo2max DAYS.
    const sessionLog = [
      {weekN:1, dayTag:'d1', scheduledType:'easy', credits:{easy:1, vo2max:1}},
      {weekN:2, dayTag:'d2', scheduledType:'easy', credits:{easy:1, vo2max:1}},
      {weekN:3, dayTag:'d3', scheduledType:'easy', credits:{easy:1, vo2max:1}},
    ];
    expect(detectConsistentShortfalls(sessionLog, {vo2max:'critical'})).toEqual([]);
  });
});

describe('missedSessionBannerHTML', () => {
  it('renders nothing for an empty/null list', () => {
    expect(missedSessionBannerHTML([])).toBe('');
  });

  it('renders exactly ONE card total, with one compact row per flagged type - not a card per type plus a separate card for the note/action', () => {
    const html = missedSessionBannerHTML([
      {type:'long', missed:2, scheduled:3, windowWeeks:6, importance:'important', note:'Note L.', severity:'moderate'},
      {type:'easy', missed:3, scheduled:4, windowWeeks:6, importance:'supportive', note:'Note E.', severity:'moderate'},
    ]);
    expect((html.match(/class="card"/g)||[]).length).toBe(1);
    expect(html).toContain('long');
    expect(html).toContain('easy');
    // the long, LLM-facing rationale text stays off the card entirely now - too much
    // information was the actual complaint this redesign fixes
    expect(html).not.toContain('Note L.');
    expect(html).not.toContain('Note E.');
  });

  it('shows a whole-number count, never the raw dose-weighted decimal (e.g. "2.1 of 3" is not a sentence a runner can parse)', () => {
    const html = missedSessionBannerHTML([{type:'long', missed:2.0855165595650025, scheduled:3, windowWeeks:6, importance:'important', note:'Note.', severity:'moderate'}]);
    expect(html).toContain('2 of 3 missed');
    expect(html).not.toContain('2.0855');
    expect(html).not.toContain('2.1');
  });

  it('the single combined action button and its proposal target live INSIDE the same card as the rows, never a separate card', () => {
    const html = missedSessionBannerHTML([
      {type:'long', missed:2, scheduled:3, windowWeeks:6, importance:'important', note:'Note L.', severity:'significant'},
      {type:'easy', missed:3, scheduled:4, windowWeeks:6, importance:'supportive', note:'Note E.', severity:'significant'},
    ]);
    expect((html.match(/class="card"/g)||[]).length).toBe(1);
    expect((html.match(/proposeReRampFromAdjustments\(\)/g)||[]).length).toBe(1);
    expect((html.match(/reramp-proposal-combined/g)||[]).length).toBe(1);
    // the action markup appears BEFORE the card's own closing tag, i.e. inside it
    expect(html.indexOf('proposeReRampFromAdjustments')).toBeLessThan(html.lastIndexOf('</div>'));
  });

  it('omits the combined action when nothing is severity=significant', () => {
    const html = missedSessionBannerHTML([{type:'easy', missed:2, scheduled:4, windowWeeks:6, importance:'supportive', note:'Note.', severity:'moderate'}]);
    expect(html).not.toContain('proposeReRampFromAdjustments');
  });

  it('renders a distinct row for a consistentShortfall adjustment instead of the "X of Y missed" phrasing', () => {
    const html = missedSessionBannerHTML([{type:'threshold', kind:'consistentShortfall', avgPct:83, windowWeeks:6, importance:'critical', note:'Note.', severity:'significant'}]);
    expect(html).toContain('consistently ~83% of prescribed work');
    expect(html).not.toContain('undefined');
  });
});

describe('detectLikelySwaps', () => {
  it('detects the exact scenario described: VO2max delivered on a day scheduled as threshold, while the real VO2max day is still missing', () => {
    const sessionLog = [
      {weekN:1, dayTag:'Mon - Aug 3', name:'Threshold', scheduledType:'threshold', credits:{vo2max:1, threshold:0.1}},
    ];
    const misses = {vo2max:[{weekN:1, dayTag:'Wed - Aug 5', name:'VO2max'}], threshold:[]};
    const suggestions = detectLikelySwaps(sessionLog, misses);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].actualDay.dayTag).toBe('Mon - Aug 3');
    expect(suggestions[0].scheduledType).toBe('threshold');
    expect(suggestions[0].deliveredType).toBe('vo2max');
    expect(suggestions[0].missingDay.dayTag).toBe('Wed - Aug 5');
  });

  it('does not suggest a swap when the day still substantially delivered its own scheduled type too (a genuine bonus, not a swap)', () => {
    const sessionLog = [
      {weekN:1, dayTag:'Mon - Aug 3', name:'Long run', scheduledType:'long', credits:{long:0.9, threshold:1}},
    ];
    const misses = {threshold:[{weekN:1, dayTag:'Wed - Aug 5', name:'Threshold'}]};
    expect(detectLikelySwaps(sessionLog, misses)).toEqual([]);
  });

  it('does not suggest a swap when there is no genuine gap of the delivered type to fill', () => {
    const sessionLog = [
      {weekN:1, dayTag:'Mon - Aug 3', name:'Threshold', scheduledType:'threshold', credits:{vo2max:1, threshold:0.1}},
    ];
    const misses = {vo2max:[], threshold:[]}; // nothing actually missing to swap into
    expect(detectLikelySwaps(sessionLog, misses)).toEqual([]);
  });

  it('does not double-match the same missing day to two different swap candidates', () => {
    const sessionLog = [
      {weekN:1, dayTag:'Mon - Aug 3', name:'Threshold', scheduledType:'threshold', credits:{vo2max:1, threshold:0.1}},
      {weekN:1, dayTag:'Fri - Aug 7', name:'Easy', scheduledType:'easy', credits:{vo2max:1, easy:0.1}},
    ];
    const misses = {vo2max:[{weekN:1, dayTag:'Wed - Aug 5', name:'VO2max'}]}; // only one real gap
    const suggestions = detectLikelySwaps(sessionLog, misses);
    expect(suggestions).toHaveLength(1); // only one candidate actually gets matched
  });
});

describe('getLikelySwapSuggestions (integration)', () => {
  beforeEach(() => {
    state.WEEKS = [];
    state.recentSaveCache = {};
    state.profile = PROFILE;
    state.Z = computeZones(PROFILE, defaultGoalConfig());
  });

  it('surfaces a real swap suggestion end to end: VO2max effort logged on the threshold day, threshold day\'s own VO2max slot still missing', async () => {
    state.WEEKS = [{n:1, dates:'Aug 3-9', days:[
      day('Mon - Aug 3', 'threshold', {reps:6, repTimeSec:240}),
      day('Wed - Aug 5', 'vo2max', {reps:6, repTimeSec:180}),
    ]}];
    window.storage = {get: vi.fn(async (key)=>{
      if(key.includes('MonAug3')){
        // Real near-max effort logged on the threshold day - genuinely a VO2max session.
        return {value: JSON.stringify({completed:true, stravaImport:{laps: Array.from({length:6},()=>({role:'work', durationSec:180, avgHR:185}))}})};
      }
      return null; // Wednesday's real VO2max day never logged at all
    })};
    const suggestions = await getLikelySwapSuggestions();
    expect(suggestions.length).toBeGreaterThan(0);
    const s = suggestions.find(x=>x.actualDay.dayTag==='Mon - Aug 3');
    expect(s).toBeDefined();
    expect(s.deliveredType).toBe('vo2max');
    expect(s.missingDay.dayTag).toBe('Wed - Aug 5');
  });
});

describe('swapSuggestionBannerHTML', () => {
  it('renders nothing for an empty list', () => {
    expect(swapSuggestionBannerHTML([])).toBe('');
    expect(swapSuggestionBannerHTML(null)).toBe('');
  });

  it('renders a concrete, actionable suggestion naming both days and both types, with an apply button referencing its own index', () => {
    const html = swapSuggestionBannerHTML([{
      actualDay:{weekN:1, dayTag:'Mon - Aug 3', name:'Threshold'},
      scheduledType:'threshold', deliveredType:'vo2max',
      missingDay:{weekN:1, dayTag:'Wed - Aug 5', name:'VO2max'},
    }]);
    expect(html).toContain('Mon - Aug 3');
    expect(html).toContain('Wed - Aug 5');
    expect(html).toContain('vo2max');
    expect(html).toContain('threshold');
    expect(html).toContain('proposeSwapFromSuggestion(0)');
  });
});

describe('buildSwapProposal', () => {
  it('swaps the prescription (type/zone/data/name) between two days in the SAME week, leaving tags/dates untouched', () => {
    const dayA = day('Mon - Aug 3', 'threshold', {reps:6, repTimeSec:240});
    const dayB = day('Wed - Aug 5', 'vo2max', {reps:6, repTimeSec:180});
    const week = {n:1, dates:'Aug 3-9', days:[dayA, dayB]};
    const suggestion = {
      actualDay:{weekN:1, dayTag:'Mon - Aug 3', name:dayA.name},
      scheduledType:'threshold', deliveredType:'vo2max',
      missingDay:{weekN:1, dayTag:'Wed - Aug 5', name:dayB.name},
    };
    const proposal = buildSwapProposal(suggestion, [week]);
    expect(proposal.weeks).toHaveLength(1);
    const newDayA = proposal.weeks[0].days.find(d=>d.tag==='Mon - Aug 3');
    const newDayB = proposal.weeks[0].days.find(d=>d.tag==='Wed - Aug 5');
    expect(newDayA.type).toBe('vo2max');
    expect(newDayA.data).toEqual(dayB.data);
    expect(newDayB.type).toBe('threshold');
    expect(newDayB.data).toEqual(dayA.data);
  });

  it('swaps across two DIFFERENT weeks, returning both full week objects', () => {
    const dayA = day('Mon - Aug 3', 'threshold');
    const dayB = day('Wed - Aug 12', 'vo2max');
    const weekA = {n:1, dates:'Aug 3-9', days:[dayA]};
    const weekB = {n:2, dates:'Aug 10-16', days:[dayB]};
    const suggestion = {
      actualDay:{weekN:1, dayTag:'Mon - Aug 3', name:dayA.name},
      scheduledType:'threshold', deliveredType:'vo2max',
      missingDay:{weekN:2, dayTag:'Wed - Aug 12', name:dayB.name},
    };
    const proposal = buildSwapProposal(suggestion, [weekA, weekB]);
    expect(proposal.weeks).toHaveLength(2);
    expect(proposal.weeks.find(w=>w.n===1).days[0].type).toBe('vo2max');
    expect(proposal.weeks.find(w=>w.n===2).days[0].type).toBe('threshold');
  });

  it('returns null when a referenced day/week can no longer be found - the plan changed since the suggestion was computed', () => {
    const week = {n:1, dates:'Aug 3-9', days:[day('Mon - Aug 3', 'threshold')]};
    const suggestion = {
      actualDay:{weekN:1, dayTag:'Mon - Aug 3', name:'x'},
      missingDay:{weekN:1, dayTag:'Thu - Aug 6', name:'y'}, // no such day in the week
    };
    expect(buildSwapProposal(suggestion, [week])).toBeNull();
    expect(buildSwapProposal(null, [week])).toBeNull();
  });
});

describe('detectHardSessionProximity', () => {
  function hardSession(dayTag, type, credit, completedAt){
    return {weekN:1, dayTag, name:type+' session', scheduledType:type, credits:{[type]:credit}, completedAt};
  }

  it('flags two substantial hard sessions less than 48h apart as moderate', () => {
    const log = [
      hardSession('Mon - Aug 3', 'threshold', 1, '2026-08-03T08:00:00.000Z'),
      hardSession('Wed - Aug 5', 'vo2max', 1, '2026-08-04T08:00:00.000Z'), // 24h later
    ];
    const flags = detectHardSessionProximity(log, null);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('moderate');
    expect(flags[0].hoursApart).toBeCloseTo(24, 1);
  });

  it('flags two hard sessions less than 24h apart as urgent', () => {
    const log = [
      hardSession('Mon - Aug 3', 'vo2max', 1, '2026-08-03T08:00:00.000Z'),
      hardSession('Tue - Aug 4', 'vo2max', 1, '2026-08-04T00:00:00.000Z'), // 16h later
    ];
    const flags = detectHardSessionProximity(log, null);
    expect(flags[0].severity).toBe('urgent');
  });

  it('applies to LONG runs too, not just VO2max/threshold - several long runs close together flags exactly like two close hard interval sessions', () => {
    const log = [
      hardSession('Mon - Aug 3', 'long', 1, '2026-08-03T08:00:00.000Z'),
      hardSession('Wed - Aug 5', 'long', 1, '2026-08-04T08:00:00.000Z'), // 24h later
    ];
    const flags = detectHardSessionProximity(log, null);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('moderate');
  });

  it('gives a durability/glycogen-specific rationale for two close long runs, not the interval-session "neuromuscular" phrasing', () => {
    const log = [
      hardSession('Mon - Aug 3', 'long', 1, '2026-08-03T08:00:00.000Z'),
      hardSession('Tue - Aug 4', 'long', 1, '2026-08-04T00:00:00.000Z'), // 16h later - urgent
    ];
    const note = detectHardSessionProximity(log, null)[0].note;
    expect(note).toContain('durability');
    expect(note).not.toContain('neuromuscular');
  });

  it('flags a hard interval session close to a long run too (combines both fatigue types), with a rationale naming both', () => {
    const log = [
      hardSession('Mon - Aug 3', 'long', 1, '2026-08-03T08:00:00.000Z'),
      hardSession('Tue - Aug 4', 'vo2max', 1, '2026-08-04T00:00:00.000Z'), // 16h later
    ];
    const note = detectHardSessionProximity(log, null)[0].note;
    expect(note).toContain('neuromuscular');
    expect(note).toContain('durability');
  });

  it('does not flag two hard sessions with real recovery spacing (48h+)', () => {
    const log = [
      hardSession('Mon - Aug 3', 'threshold', 1, '2026-08-03T08:00:00.000Z'),
      hardSession('Wed - Aug 5', 'vo2max', 1, '2026-08-05T08:00:00.000Z'), // 48h later
    ];
    expect(detectHardSessionProximity(log, null)).toEqual([]);
  });

  it('does not flag when one side was only a token effort at moderate (not urgent) proximity - "sometimes two close sessions are fine" depends on how hard each really was', () => {
    const log = [
      hardSession('Mon - Aug 3', 'threshold', 1, '2026-08-03T08:00:00.000Z'),
      hardSession('Wed - Aug 5', 'vo2max', 0.1, '2026-08-04T08:00:00.000Z'), // barely any real vo2max dose - 24h later
    ];
    expect(detectHardSessionProximity(log, null)).toEqual([]);
  });

  it('still flags urgent-proximity pairs even if one side was only a token effort - same/next-day stacking is a real concern regardless of size', () => {
    const log = [
      hardSession('Mon - Aug 3', 'vo2max', 1, '2026-08-03T08:00:00.000Z'),
      hardSession('Tue - Aug 4', 'threshold', 0.1, '2026-08-04T00:00:00.000Z'), // 16h later, token effort
    ];
    expect(detectHardSessionProximity(log, null)).toHaveLength(1);
  });

  it('elevated acute:chronic load (High) escalates a moderate-proximity pair to urgent', () => {
    const log = [
      hardSession('Mon - Aug 3', 'threshold', 1, '2026-08-03T08:00:00.000Z'),
      hardSession('Wed - Aug 5', 'vo2max', 1, '2026-08-04T08:00:00.000Z'), // 24h -> moderate on its own
    ];
    const flagsNormalLoad = detectHardSessionProximity(log, {status:'Optimal'});
    const flagsHighLoad = detectHardSessionProximity(log, {status:'High'});
    expect(flagsNormalLoad[0].severity).toBe('moderate');
    expect(flagsHighLoad[0].severity).toBe('urgent');
  });

  it('ignores sessions with no real completedAt timestamp', () => {
    const log = [
      hardSession('Mon - Aug 3', 'threshold', 1, null),
      hardSession('Wed - Aug 5', 'vo2max', 1, '2026-08-04T08:00:00.000Z'),
    ];
    expect(detectHardSessionProximity(log, null)).toEqual([]);
  });
});

describe('detectScheduledHardSessionProximity', () => {
  it('flags two scheduled hard-type days less than 48h apart in a proposed week array, same as real logged sessions', () => {
    const week = {n:1, dates:'Aug 3-9', days:[
      day('Mon - Aug 3', 'threshold', {reps:6, repTimeSec:240}),
      day('Tue - Aug 4', 'vo2max', {reps:6, repTimeSec:180}), // 24h later -> moderate
    ]};
    const flags = detectScheduledHardSessionProximity([week], null);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('moderate');
  });

  it('does not flag scheduled days with real recovery spacing (48h+)', () => {
    const week = {n:1, dates:'Aug 3-9', days:[
      day('Mon - Aug 3', 'threshold', {reps:6, repTimeSec:240}),
      day('Wed - Aug 5', 'vo2max', {reps:6, repTimeSec:180}), // 48h later
    ]};
    expect(detectScheduledHardSessionProximity([week], null)).toEqual([]);
  });

  it('checks across week boundaries, not just within a single week object', () => {
    const week1 = {n:1, dates:'Jul 27-Aug 1', days:[day('Sat - Aug 1', 'long', {km:20})]};
    const week2 = {n:2, dates:'Aug 2-9', days:[day('Sun - Aug 2', 'threshold', {reps:6, repTimeSec:240})]};
    // Aug 1 (long) and Aug 2 (threshold) are only 24h apart despite landing in different week objects
    const flags = detectScheduledHardSessionProximity([week1, week2], null);
    expect(flags).toHaveLength(1);
  });

  it('elevated acute:chronic load (High) escalates a moderate-proximity pair to urgent, same as the logged-history check', () => {
    const week = {n:1, dates:'Aug 3-9', days:[
      day('Mon - Aug 3', 'threshold', {reps:6, repTimeSec:240}),
      day('Tue - Aug 4', 'vo2max', {reps:6, repTimeSec:180}),
    ]};
    const flagsNormalLoad = detectScheduledHardSessionProximity([week], {status:'Optimal'});
    const flagsHighLoad = detectScheduledHardSessionProximity([week], {status:'High'});
    expect(flagsNormalLoad[0].severity).toBe('moderate');
    expect(flagsHighLoad[0].severity).toBe('urgent');
  });

  it('ignores easy/race days - only HARD_TYPES (vo2max/threshold/long) count', () => {
    const week = {n:1, dates:'Aug 3-9', days:[
      day('Mon - Aug 3', 'easy', {km:10}),
      day('Tue - Aug 4', 'easy', {km:8}),
    ]};
    expect(detectScheduledHardSessionProximity([week], null)).toEqual([]);
  });
});

describe('getHardSessionProximityFlags (integration)', () => {
  beforeEach(() => {
    state.WEEKS = [];
    state.recentSaveCache = {};
    state.profile = PROFILE;
    state.Z = computeZones(PROFILE, defaultGoalConfig());
  });

  it('surfaces a real proximity flag end to end from two logged hard sessions close together', async () => {
    state.WEEKS = [{n:1, dates:'Aug 3-9', days:[
      day('Mon - Aug 3', 'threshold', {reps:6, repTimeSec:240}),
      day('Tue - Aug 4', 'vo2max', {reps:6, repTimeSec:180}),
    ]}];
    window.storage = {get: vi.fn(async (key)=>{
      if(key.includes('MonAug3')) return {value: JSON.stringify({completed:true, completedAt:'2026-08-03T08:00:00.000Z', stravaImport:{laps: Array.from({length:6},()=>({role:'work', durationSec:240, avgHR:168}))}})};
      if(key.includes('TueAug4')) return {value: JSON.stringify({completed:true, completedAt:'2026-08-04T00:00:00.000Z', stravaImport:{laps: Array.from({length:6},()=>({role:'work', durationSec:180, avgHR:185}))}})}; // ~16h later
      return null;
    })};
    const flags = await getHardSessionProximityFlags();
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0].severity).toBe('urgent');
  });
});

describe('hardSessionProximityBannerHTML', () => {
  it('renders nothing for an empty list', () => {
    expect(hardSessionProximityBannerHTML([])).toBe('');
    expect(hardSessionProximityBannerHTML(null)).toBe('');
  });

  it('renders the note text for each flag', () => {
    const html = hardSessionProximityBannerHTML([{severity:'urgent', note:'A real concern here.'}]);
    expect(html).toContain('A real concern here.');
  });
});
