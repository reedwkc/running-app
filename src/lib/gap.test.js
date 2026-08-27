// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { flatTargetToGradedPaceSec, gradeAdjustedPaceSec } from './gap.js';

describe('gradeAdjustedPaceSec (Minetti energy-cost-of-running model)', () => {
  it('returns the actual pace unchanged on flat ground', () => {
    expect(gradeAdjustedPaceSec(300, 0)).toBeCloseTo(300, 1);
  });

  it('maps an uphill pace to a faster (lower-sec/km) flat-equivalent pace - climbing costs more per meter, so the same effort would cover flat ground quicker', () => {
    const gap = gradeAdjustedPaceSec(300, 0.1); // 5:00/km at a 10% grade
    expect(gap).toBeLessThan(300);
    expect(gap).toBeGreaterThan(0);
  });

  it('maps a gentle downhill pace to a slower (higher-sec/km) flat-equivalent pace - that pace is metabolically cheaper downhill than the same pace would be on flat', () => {
    const gap = gradeAdjustedPaceSec(300, -0.08); // 5:00/km at a gentle -8% grade
    expect(gap).toBeGreaterThan(300);
  });

  it('pulls the flat-equivalent back down toward the actual pace on a steep descent, not further away - the model\'s cost curve rises again past its minimum (real eccentric/braking cost), it does not credit descents forever the way a naive linear correction would', () => {
    const gentle = gradeAdjustedPaceSec(300, -0.08);
    const steep = gradeAdjustedPaceSec(300, -0.35);
    expect(steep).toBeGreaterThan(300); // still some downhill credit
    expect(steep).toBeLessThan(gentle); // but less than at the curve's cheapest point
  });

  it('scales proportionally with actual pace at a fixed grade (a pure cost ratio, not grade-and-speed-dependent)', () => {
    const a = gradeAdjustedPaceSec(300, 0.05);
    const b = gradeAdjustedPaceSec(600, 0.05);
    expect(b).toBeCloseTo(a*2, 1);
  });

  it('returns null for missing/invalid inputs rather than a fabricated number', () => {
    expect(gradeAdjustedPaceSec(null, 0.05)).toBeNull();
    expect(gradeAdjustedPaceSec(0, 0.05)).toBeNull();
    expect(gradeAdjustedPaceSec(300, null)).toBeNull();
    expect(gradeAdjustedPaceSec(300, NaN)).toBeNull();
  });

  it('clamps extreme grades to the model\'s validated +-45% range rather than extrapolating a published polynomial past where it was fit', () => {
    const at45 = gradeAdjustedPaceSec(300, 0.45);
    const beyond = gradeAdjustedPaceSec(300, 0.9);
    expect(beyond).toBeCloseTo(at45, 5);
  });
});

describe('flatTargetToGradedPaceSec (the inverse question: what pace to target on a grade)', () => {
  it('returns the flat target pace unchanged at zero grade', () => {
    expect(flatTargetToGradedPaceSec(270, 0)).toBeCloseTo(270, 1);
  });

  it('is the exact inverse of gradeAdjustedPaceSec at the same grade (round-trips back to the original pace)', () => {
    const grade = 0.07;
    const original = 280;
    const flatEquivalent = gradeAdjustedPaceSec(original, grade);
    const roundTripped = flatTargetToGradedPaceSec(flatEquivalent, grade);
    expect(roundTripped).toBeCloseTo(original, 1);
  });

  it('gives a slower (higher-sec/km) target on an uphill route than the flat pace it was derived from - the same clock pace uphill would demand more than the intended effort', () => {
    const route = flatTargetToGradedPaceSec(270, 0.08); // flat threshold pace 4:30/km, 8% climb
    expect(route).toBeGreaterThan(270);
  });

  it('gives a faster (lower-sec/km) target on a gentle downhill route than the flat pace - the flat effort demands more speed downhill where running is metabolically cheaper', () => {
    const route = flatTargetToGradedPaceSec(270, -0.08);
    expect(route).toBeLessThan(270);
  });

  it('returns null for missing/invalid inputs rather than a fabricated number', () => {
    expect(flatTargetToGradedPaceSec(null, 0.05)).toBeNull();
    expect(flatTargetToGradedPaceSec(0, 0.05)).toBeNull();
    expect(flatTargetToGradedPaceSec(270, null)).toBeNull();
    expect(flatTargetToGradedPaceSec(270, NaN)).toBeNull();
  });
});
