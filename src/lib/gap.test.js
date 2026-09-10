// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { effectiveCostOverRange, equivalentSteadyGrade, flatTargetToGradedPaceSec, gradeAdjustedPaceOverRange, gradeAdjustedPaceSec } from './gap.js';

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

// Minetti AE et al., J Appl Physiol 2002 - running cost, J/(kg*m):
//   Cr = 155.4i^5 - 30.4i^4 - 43.3i^3 + 46.3i^2 + 19.5i + 3.6
// Computed here independently so the implementation is checked against the published
// polynomial rather than against itself.
const published = i => 155.4*i**5 - 30.4*i**4 - 43.3*i**3 + 46.3*i**2 + 19.5*i + 3.6;

// A synthetic route: constant sample spacing, altitude supplied by a profile function.
function route(lengthM, stepM, altAt){
  const dist = [], altitude = [];
  for(let d = 0; d <= lengthM; d += stepM){ dist.push(d); altitude.push(altAt(d)); }
  return {dist, altitude, last: dist.length - 1};
}

describe('the Minetti cost curve matches the published paper', () => {
  it('is exactly 3.6 J/kg/m on the flat', () => {
    expect(gradeAdjustedPaceSec(300, 0)).toBeCloseTo(300, 6);
  });

  it('reproduces the published cost ratio at representative grades', () => {
    [-0.15, -0.10, -0.05, 0.05, 0.10, 0.20, 0.30].forEach(i => {
      // gradeAdjustedPaceSec is pace * (flatCost / costAtGrade), so the implied cost is
      // recoverable and can be checked straight against the paper's polynomial.
      const impliedCost = 3.6 / (gradeAdjustedPaceSec(300, i) / 300);
      expect(impliedCost).toBeCloseTo(published(i), 6);
    });
  });

  it('reproduces the curve\'s known shape: a gentle descent is cheaper than flat, a steep one is not', () => {
    expect(published(-0.10)).toBeLessThan(published(0));
    expect(published(-0.40)).toBeGreaterThan(published(0));
    // The cost minimum for running sits near -20%, which is the paper's headline finding.
    let min = 0, minCost = Infinity;
    for(let i = -0.45; i <= 0; i += 0.005){ const c = published(i); if(c < minCost){ minCost = c; min = i; } }
    expect(min).toBeGreaterThan(-0.26);
    expect(min).toBeLessThan(-0.15);
  });

  it('flatTargetToGradedPaceSec is the exact inverse of gradeAdjustedPaceSec', () => {
    [0.05, 0.10, -0.08].forEach(i => {
      expect(flatTargetToGradedPaceSec(gradeAdjustedPaceSec(280, i), i)).toBeCloseTo(280, 6);
    });
  });
});

describe('integrating cost along the route instead of collapsing it to a net grade', () => {
  it('leaves genuinely flat ground alone', () => {
    const r = route(2000, 20, () => 100);
    expect(effectiveCostOverRange(r.altitude, r.dist, 0, r.last)).toBeCloseTo(3.6, 4);
    expect(gradeAdjustedPaceOverRange(300, r.altitude, r.dist, 0, r.last)).toBeCloseTo(300, 3);
  });

  it('agrees with the point formula on a steady climb, where both are valid', () => {
    const r = route(2000, 20, d => 100 + d*0.06); // constant +6%
    expect(effectiveCostOverRange(r.altitude, r.dist, 0, r.last)).toBeCloseTo(published(0.06), 3);
    expect(gradeAdjustedPaceOverRange(330, r.altitude, r.dist, 0, r.last))
      .toBeCloseTo(gradeAdjustedPaceSec(330, 0.06), 2);
  });

  // The bug this replaced. Net elevation change is zero over a rolling lap, so the old
  // calculation declared it flat and applied no adjustment at all - on precisely the terrain
  // grade adjustment exists for.
  it('sees a rolling route that nets to zero, which the net-grade calculation could not', () => {
    // 100m up at 8%, 100m down at 8%, repeated - net altitude change exactly zero.
    const r = route(2000, 10, d => { const c = Math.floor(d/100); const into = d - c*100; return (c % 2 === 0 ? into : 100 - into) * 0.08; });
    const netGrade = (r.altitude[r.last] - r.altitude[0]) / (r.dist[r.last] - r.dist[0]);
    expect(netGrade).toBeCloseTo(0, 6);
    expect(gradeAdjustedPaceSec(330, netGrade)).toBeCloseTo(330, 6); // old behaviour: no adjustment

    const cost = effectiveCostOverRange(r.altitude, r.dist, 0, r.last);
    expect(cost).toBeGreaterThan(3.6);                                   // climbing costs more than descending saves
    const gap = gradeAdjustedPaceOverRange(330, r.altitude, r.dist, 0, r.last);
    expect(gap).toBeLessThan(330);                                       // so the flat equivalent is genuinely faster
    expect(gap).toBeLessThan(320);                                       // and by a material amount, not a rounding wobble
  });

  it('describes that rolling route with a real equivalent grade rather than 0%', () => {
    const r = route(2000, 10, d => { const c = Math.floor(d/100); const into = d - c*100; return (c % 2 === 0 ? into : 100 - into) * 0.08; });
    const eq = equivalentSteadyGrade(effectiveCostOverRange(r.altitude, r.dist, 0, r.last));
    expect(eq).toBeGreaterThan(0.01);
    expect(eq).toBeLessThan(0.08);
  });

  it('returns null where no single uphill grade could describe the terrain', () => {
    expect(equivalentSteadyGrade(3.6)).toBeNull();   // exactly flat
    expect(equivalentSteadyGrade(2.0)).toBeNull();   // net downhill, cheaper than flat
    expect(equivalentSteadyGrade(null)).toBeNull();
  });

  it('refuses rather than guesses when the data cannot support an answer', () => {
    expect(effectiveCostOverRange(null, null, 0, 5)).toBeNull();
    expect(effectiveCostOverRange([1,2], [0,0], 0, 1)).toBeNull(); // no distance covered
    expect(gradeAdjustedPaceOverRange(0, [1,2], [0,100], 0, 1)).toBeNull();
  });

  // Altitude streams are noisy to about a metre; over a 10-20m sample gap that is a fake
  // grade of 5-10%, and the cost curve is steep enough that it would not average out.
  it('is not fooled into inventing cost out of metre-scale altitude noise on flat ground', () => {
    const r = route(2000, 10, d => 100 + ((d/10) % 2 === 0 ? 0.5 : -0.5));
    const cost = effectiveCostOverRange(r.altitude, r.dist, 0, r.last);
    expect(cost).toBeGreaterThan(3.5);
    expect(cost).toBeLessThan(3.8); // within a few percent of flat, not a manufactured climb
  });
});
