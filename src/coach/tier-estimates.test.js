// @ts-nocheck - pure-function test, no window.storage mocking needed
import { describe, expect, it } from 'vitest';
import { clampTierEstimate } from './tier-estimates.js';

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
