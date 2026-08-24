// @ts-nocheck - window.storage test mocks intentionally implement only what's used
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendEfficiencyPoint, appendTrendPoint, clampTierEstimate, computeTreadmillCalibrationPoint, estimateLayoffImpact, estimateVO2FromTreadmillSpeed, findLTPaceEffectiveDate, getLayoffAdjustment, TREADMILL_DEFAULT_INCLINE_PCT, treadmillFlatEquivalentPaceSec, treadmillFlatEquivalentSpeedKmh } from './tier-estimates.js';

describe('estimateLayoffImpact', () => {
  it('returns null under 7 days (normal week-to-week variation, no note at all)', () => {
    expect(estimateLayoffImpact(0)).toBeNull();
    expect(estimateLayoffImpact(6)).toBeNull();
    expect(estimateLayoffImpact(null)).toBeNull();
  });

  it('7-13 days: negligible severity, zero penalty/ramp - keeps today\'s light heads-up only', () => {
    expect(estimateLayoffImpact(7)).toMatchObject({severity:'negligible', ltPacePenaltyPct:0, vo2maxPenaltyPct:0, rampWeeksRecommended:0});
    expect(estimateLayoffImpact(13)).toMatchObject({severity:'negligible', rampWeeksRecommended:0});
  });

  it('14-27 days: mild severity with a real ramp recommendation', () => {
    expect(estimateLayoffImpact(14)).toMatchObject({severity:'mild', ltPacePenaltyPct:2, vo2maxPenaltyPct:4, rampWeeksRecommended:1});
    expect(estimateLayoffImpact(27)).toMatchObject({severity:'mild', rampWeeksRecommended:1});
  });

  it('28-56 days: moderate severity', () => {
    expect(estimateLayoffImpact(28)).toMatchObject({severity:'moderate', ltPacePenaltyPct:5, vo2maxPenaltyPct:9, rampWeeksRecommended:2});
    expect(estimateLayoffImpact(56)).toMatchObject({severity:'moderate', rampWeeksRecommended:2});
  });

  it('57-90 days: significant severity - roughly 2-3 months off', () => {
    expect(estimateLayoffImpact(57)).toMatchObject({severity:'significant', ltPacePenaltyPct:8, vo2maxPenaltyPct:14, rampWeeksRecommended:3});
    expect(estimateLayoffImpact(90)).toMatchObject({severity:'significant', rampWeeksRecommended:3});
  });

  it('90+ days: substantial severity - genuinely differentiates a long layoff from a short one, per William\'s ask', () => {
    expect(estimateLayoffImpact(91)).toMatchObject({severity:'substantial', ltPacePenaltyPct:12, vo2maxPenaltyPct:18, rampWeeksRecommended:4});
    expect(estimateLayoffImpact(365)).toMatchObject({severity:'substantial', rampWeeksRecommended:4});
  });

  it('a 3-month layoff is estimated as strictly worse than a 1-month layoff', () => {
    const oneMonth = estimateLayoffImpact(30);
    const threeMonths = estimateLayoffImpact(90);
    expect(threeMonths.ltPacePenaltyPct).toBeGreaterThan(oneMonth.ltPacePenaltyPct);
    expect(threeMonths.vo2maxPenaltyPct).toBeGreaterThan(oneMonth.vo2maxPenaltyPct);
    expect(threeMonths.rampWeeksRecommended).toBeGreaterThan(oneMonth.rampWeeksRecommended);
  });

  it('always includes the raw days count and a plain-language note', () => {
    const result = estimateLayoffImpact(20);
    expect(result.days).toBe(20);
    expect(typeof result.note).toBe('string');
    expect(result.note.length).toBeGreaterThan(0);
  });
});

describe('getLayoffAdjustment', () => {
  it('returns null and writes nothing when no gap is logged at all', async () => {
    window.storage = {get: vi.fn().mockResolvedValue(null), set: vi.fn()};
    const result = await getLayoffAdjustment();
    expect(result).toBeNull();
    expect(window.storage.set).not.toHaveBeenCalled();
  });

  it('mid-gap: returns the current tier and persists an episode with today as firstDetectedAt', async () => {
    const oldDate = new Date(Date.now() - 20*86400000).toISOString().slice(0,10); // 20 days -> mild
    window.storage = {
      get: vi.fn(async (key) => key==='last-activity-date' ? {value: JSON.stringify({date: oldDate})} : null),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const result = await getLayoffAdjustment();
    expect(result).toMatchObject({severity:'mild', ltPacePenaltyPct:2, vo2maxPenaltyPct:4, rampWeeksRecommended:1});
    expect(typeof result.firstDetectedAt).toBe('string');
    expect(window.storage.set).toHaveBeenCalledWith('layoff-episode', expect.any(String), false);
  });

  it('mid-gap: keeps an existing episode\'s firstDetectedAt stable while escalating severity as the gap grows', async () => {
    const originalDetection = '2026-01-01T00:00:00.000Z';
    const oldDate = new Date(Date.now() - 40*86400000).toISOString().slice(0,10); // now 40 days -> moderate (28-56)
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='layoff-episode') return {value: JSON.stringify({firstDetectedAt:originalDetection, days:20, severity:'mild', ltPacePenaltyPct:2, vo2maxPenaltyPct:4, rampWeeksRecommended:1})};
        if(key==='last-activity-date') return {value: JSON.stringify({date: oldDate})};
        return null;
      }),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const result = await getLayoffAdjustment();
    expect(result.severity).toBe('moderate');
    expect(result.firstDetectedAt).toBe(originalDetection);
  });

  it('resumed, no fresh evidence yet: keeps returning the stored episode unchanged', async () => {
    const episode = {firstDetectedAt: new Date(Date.now()-10*86400000).toISOString(), days:20, severity:'mild', ltPacePenaltyPct:2, vo2maxPenaltyPct:4, rampWeeksRecommended:1};
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='layoff-episode') return {value: JSON.stringify(episode)};
        if(key==='last-activity-date') return {value: JSON.stringify({date: new Date().toISOString().slice(0,10)})}; // resumed today
        return null; // no fresher Tier 1/2/3 evidence at all
      }),
      delete: vi.fn(),
    };
    const result = await getLayoffAdjustment();
    expect(result).toMatchObject({severity:'mild', ltPacePenaltyPct:2});
    expect(window.storage.delete).not.toHaveBeenCalled();
  });

  it('resumed, fresh evidence has landed since the gap was flagged: clears the episode and returns null', async () => {
    const gapFirstFlagged = new Date(Date.now()-15*86400000).toISOString();
    const freshEvidenceDate = new Date(Date.now()-1*86400000).toISOString(); // newer than the flag
    const episode = {firstDetectedAt: gapFirstFlagged, days:15, severity:'mild', ltPacePenaltyPct:2, vo2maxPenaltyPct:4, rampWeeksRecommended:1};
    window.storage = {
      get: vi.fn(async (key) => {
        if(key==='layoff-episode') return {value: JSON.stringify(episode)};
        if(key==='last-activity-date') return {value: JSON.stringify({date: new Date().toISOString().slice(0,10)})};
        if(key==='profile-history') return {value: JSON.stringify([{ltPaceSec:270, date:freshEvidenceDate}])};
        return null;
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const result = await getLayoffAdjustment();
    expect(result).toBeNull();
    expect(window.storage.delete).toHaveBeenCalledWith('layoff-episode', false);
  });
});

describe('findLTPaceEffectiveDate', () => {
  it('returns null for empty history', () => {
    expect(findLTPaceEffectiveDate([])).toBeNull();
    expect(findLTPaceEffectiveDate(null)).toBeNull();
  });

  it('returns the single entry\'s date when there is only one', () => {
    expect(findLTPaceEffectiveDate([{ltPaceSec:275, date:'2026-08-01'}])).toBe('2026-08-01');
  });

  it('walks back to when the CURRENT value first appeared, not the latest save date', () => {
    const history = [
      {ltPaceSec:280, date:'2026-07-01'},
      {ltPaceSec:275, date:'2026-08-01'}, // value changed here
      {ltPaceSec:275, date:'2026-08-17'}, // re-saved, same value (e.g. vo2max-only update)
    ];
    expect(findLTPaceEffectiveDate(history)).toBe('2026-08-01');
  });

  it('returns the latest date when the value actually changed there', () => {
    const history = [
      {ltPaceSec:280, date:'2026-07-01'},
      {ltPaceSec:275, date:'2026-08-01'},
      {ltPaceSec:265, date:'2026-08-17'}, // genuine change
    ];
    expect(findLTPaceEffectiveDate(history)).toBe('2026-08-17');
  });
});

describe('clampTierEstimate', () => {
  const anchor = { lthr: 165, ltPaceSec: 270, vo2maxPaceSec: 240, maxHR: 190, vo2max: 55, restHR: 50 };

  it('passes through a small, in-bounds nudge unchanged', () => {
    const parsed = { ...anchor, ltPaceSec: 267, basedOn: 'good threshold session' };
    const result = clampTierEstimate(anchor, parsed);
    expect(result.ltPaceSec).toBe(267);
    expect(result.clampedFields).toBeUndefined();
  });

  it('caps a single-session swing beyond the max delta', () => {
    const parsed = { ...anchor, ltPaceSec: 240 }; // 30s/km faster in one session - implausible
    const result = clampTierEstimate(anchor, parsed);
    expect(result.ltPaceSec).toBe(262); // anchor 270 - 8s cap
    expect(result.clampedFields).toContain('ltPaceSec');
  });

  it('caps in the downward direction too, not just upward', () => {
    const parsed = { ...anchor, ltPaceSec: 320 };
    const result = clampTierEstimate(anchor, parsed);
    expect(result.ltPaceSec).toBe(278); // anchor 270 + 8s cap
    expect(result.clampedFields).toContain('ltPaceSec');
  });

  it('only flags the fields that actually exceeded their bound', () => {
    const parsed = { ...anchor, ltPaceSec: 240, vo2maxPaceSec: 242 }; // vo2max within bounds
    const result = clampTierEstimate(anchor, parsed);
    expect(result.clampedFields).toEqual(['ltPaceSec']);
    expect(result.vo2maxPaceSec).toBe(242);
  });

  it('returns parsed unchanged when there is no anchor to clamp against', () => {
    const parsed = { ltPaceSec: 240 };
    expect(clampTierEstimate(null, parsed)).toBe(parsed);
  });

  it('leaves fields the model omitted untouched', () => {
    const parsed = { ltPaceSec: 267, basedOn: 'x' };
    const result = clampTierEstimate(anchor, parsed);
    expect(result.vo2maxPaceSec).toBeUndefined();
  });

  it('caps suggestedNextSpeed/suggestedNextVO2Speed too, not just the Tier 1/2/3-shared fields (these previously had no deterministic backstop at all)', () => {
    const speedAnchor = { suggestedNextSpeed: 12.0, suggestedNextVO2Speed: 15.0 };
    const parsed = { suggestedNextSpeed: 14.0, suggestedNextVO2Speed: 12.0 }; // both a wild 2+ km/h swing
    const result = clampTierEstimate(speedAnchor, parsed);
    expect(result.suggestedNextSpeed).toBe(12.3); // anchor 12.0 + 0.3 cap
    expect(result.suggestedNextVO2Speed).toBe(14.7); // anchor 15.0 - 0.3 cap
    expect(result.clampedFields).toEqual(expect.arrayContaining(['suggestedNextSpeed', 'suggestedNextVO2Speed']));
  });
});

describe('estimateVO2FromTreadmillSpeed (ACSM running equation, with the grade term)', () => {
  it('matches the flat-ground (0% incline) ACSM formula when incline is 0', () => {
    // VO2 = 3.5 + 0.2*speed(m/min); 12km/h = 200 m/min -> 3.5+40 = 43.5
    expect(estimateVO2FromTreadmillSpeed(12, 0)).toBeCloseTo(43.5, 5);
  });

  it('adds a real grade term at a nonzero incline, strictly more than the flat-ground figure', () => {
    const flat = estimateVO2FromTreadmillSpeed(12, 0);
    const inclined = estimateVO2FromTreadmillSpeed(12, 1);
    expect(inclined).toBeGreaterThan(flat);
    expect(inclined).toBeCloseTo(45.3, 5); // 43.5 + 0.9*200*0.01
  });

  it('treats a missing/null incline as 0% for this raw formula (the default-to-1% assumption lives in treadmillFlatEquivalentSpeedKmh, not here)', () => {
    expect(estimateVO2FromTreadmillSpeed(12, null)).toBeCloseTo(estimateVO2FromTreadmillSpeed(12, 0), 5);
  });
});

describe('treadmillFlatEquivalentSpeedKmh / treadmillFlatEquivalentPaceSec (outdoor-flat-equivalent correction)', () => {
  it('returns the raw speed unchanged at exactly the reference incline (~1%) - the standard "simulates outdoor" setup needs no correction', () => {
    expect(treadmillFlatEquivalentSpeedKmh(12, TREADMILL_DEFAULT_INCLINE_PCT)).toBe(12);
  });

  it('defaults a missing incline to the reference (~1%), returning the raw speed unchanged - assumes the standing advice was followed, not a flat belt', () => {
    expect(treadmillFlatEquivalentSpeedKmh(12, null)).toBe(12);
    expect(treadmillFlatEquivalentSpeedKmh(12, undefined)).toBe(12);
  });

  it('a 0%-incline (flat) session reads SLOWER as an outdoor-equivalent than its raw treadmill speed - flat treadmill running is genuinely easier than outdoor at the same displayed speed', () => {
    const equiv = treadmillFlatEquivalentSpeedKmh(12, 0);
    expect(equiv).toBeLessThan(12);
    expect(equiv).toBeCloseTo(11.48, 1);
  });

  it('an incline above the reference reads FASTER as an outdoor-equivalent than its raw treadmill speed - a steeper incline is harder, not easier, than the outdoor-equivalent setup', () => {
    const equiv = treadmillFlatEquivalentSpeedKmh(12, 2);
    expect(equiv).toBeGreaterThan(12);
    expect(equiv).toBeCloseTo(12.52, 1);
  });

  it('treadmillFlatEquivalentPaceSec is the inverse pace (sec/km) of the equivalent speed, correctly directional (0% incline -> a SLOWER/higher-sec pace than naive 3600/speed)', () => {
    const naivePaceSec = 3600/12;
    const correctedPaceSec = treadmillFlatEquivalentPaceSec(12, 0);
    expect(correctedPaceSec).toBeGreaterThan(naivePaceSec);
  });
});

describe('computeTreadmillCalibrationPoint', () => {
  it('returns null (not Infinity) for a zero speed - the direct regression test for the Infinity-corruption bug', () => {
    expect(computeTreadmillCalibrationPoint(280, 0, 1, 'gps')).toBeNull();
  });

  it('returns null for a blank/NaN speed', () => {
    expect(computeTreadmillCalibrationPoint(280, NaN, 1, 'gps')).toBeNull();
    expect(computeTreadmillCalibrationPoint(280, parseFloat(''), 1, 'gps')).toBeNull();
  });

  it('returns null for a pace-shaped typo below the sane speed floor (e.g. "3.5" meaning ~3:30/km digits, not 3.5 km/h - slower than a walk)', () => {
    expect(computeTreadmillCalibrationPoint(280, 3.5, 1, 'gps')).toBeNull();
  });

  it('returns null for an implausibly fast speed above the sane ceiling', () => {
    expect(computeTreadmillCalibrationPoint(280, 30, 1, 'gps')).toBeNull();
  });

  it('returns null when there is no wearable pace to compare against', () => {
    expect(computeTreadmillCalibrationPoint(null, 12, 1, 'gps')).toBeNull();
  });

  it('computes a real, correctly-signed calibration point for a sane input at the reference incline', () => {
    const point = computeTreadmillCalibrationPoint(290, 12, 1, 'gps');
    expect(point).not.toBeNull();
    expect(point.treadmillPaceSec).toBe(300); // 3600/12, unchanged at the reference incline
    expect(point.offsetSec).toBe(-10); // 290 - 300
    expect(point.source).toBe('gps');
  });

  it('defaults source to "unknown" when the wearable lap has none', () => {
    const point = computeTreadmillCalibrationPoint(290, 12, 1, undefined);
    expect(point.source).toBe('unknown');
  });
});

// Re-saving the same real-world session (e.g. re-importing corrected Strava data for a
// workout that was already logged once) must replace its point in these histories, not
// add a second one for the same actual workout - see the dedupe comment in each function.
describe('appendTrendPoint / appendEfficiencyPoint dedupe by sessionId', () => {
  let saved;
  beforeEach(() => {
    saved = null;
    window.storage = {
      get: vi.fn(async () => saved ? {value: JSON.stringify(saved)} : null),
      set: vi.fn(async (key, value) => { saved = JSON.parse(value); }),
    };
  });

  it('replaces an existing trend point with the same sessionId instead of appending a duplicate', async () => {
    await appendTrendPoint('timetotarget-history', '2026-08-13', {value: 40, sessionId: 'workout-w2-WedAug12'});
    await appendTrendPoint('timetotarget-history', '2026-08-13', {value: 22, sessionId: 'workout-w2-WedAug12'});
    expect(saved.length).toBe(1);
    expect(saved[0].value).toBe(22);
  });

  it('leaves other sessions untouched when replacing one', async () => {
    await appendTrendPoint('timetotarget-history', '2026-08-11', {value: 30, sessionId: 'workout-w2-TueAug11'});
    await appendTrendPoint('timetotarget-history', '2026-08-13', {value: 40, sessionId: 'workout-w2-WedAug12'});
    await appendTrendPoint('timetotarget-history', '2026-08-13', {value: 22, sessionId: 'workout-w2-WedAug12'});
    expect(saved.length).toBe(2);
    expect(saved.find(p=>p.sessionId==='workout-w2-TueAug11').value).toBe(30);
    expect(saved.find(p=>p.sessionId==='workout-w2-WedAug12').value).toBe(22);
  });

  it('keeps old append-only behavior (no dedupe) when no sessionId is given', async () => {
    await appendTrendPoint('hrrecovery-history', '2026-08-13', {value: 20});
    await appendTrendPoint('hrrecovery-history', '2026-08-13', {value: 25});
    expect(saved.length).toBe(2);
  });

  it('replaces an existing efficiency point with the same sessionId', async () => {
    await appendEfficiencyPoint('2026-08-13', 0.06, 140, 8.4, 'gps', 'workout-w2-ThuAug13');
    await appendEfficiencyPoint('2026-08-13', 0.065, 138, 9.0, 'gps', 'workout-w2-ThuAug13');
    expect(saved.length).toBe(1);
    expect(saved[0].avgHR).toBe(138);
  });
});
