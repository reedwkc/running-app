// @ts-nocheck - window.storage test mocks intentionally implement only what's used
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendEfficiencyPoint, appendTrendPoint, clampTierEstimate } from './tier-estimates.js';

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
