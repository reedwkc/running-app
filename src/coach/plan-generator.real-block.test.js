// @ts-nocheck
// The generator run against the runner's OWN block, in the exact situation that was failing.
//
// The unit tests above build a clean synthetic block to exercise the arithmetic. This one runs
// on the real thing - sub130-block.json, 54 weeks of it, with its real dates, its real race,
// its real phases and its real existing audit failures - because a plan generator that only
// works on tidy input is not a plan generator. It is also the direct regression test for the
// report that prompted all of this: an injury rebuild that came back "the plan change still
// breaks the app's own rules after 3 rounds of corrections, so nothing has been changed",
// naming the ramp weeks for carrying no quality work during a medically-indicated quality hold.
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { state } from '../state.js';
import { computeWeekPlannedKm, computeZones, materializeWeek } from '../data/plan.js';
import { defaultGoalConfig } from '../data/goal-config.js';
import { auditBlock, MAX_WEEKLY_RAMP } from './plan-audit.js';
import { generatePlanWeeks, scopeToJoin, MAX_SCOPE_WEEKS } from './plan-generator.js';

const BLOCK_START_N = 7;
let weeks;

beforeAll(() => {
  const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'sub130-block.json'), 'utf8'));
  weeks = Object.keys(raw.weeksByN).map(Number).sort((a, b) => a - b).map(n => raw.weeksByN[n]);
  const goalConfig = Object.assign(defaultGoalConfig(), {blockStartWeekN: BLOCK_START_N});
  state.goalConfig = goalConfig;
  state.Z = computeZones({ltPaceSec: 275, lthr: 178}, goalConfig);   // LT 4:35/km, LTHR 178
});

const kmAt = n => { const w = weeks.find(x => x.n === n); return w ? computeWeekPlannedKm(materializeWeek(w)) : null; };

// A moderate injury tier from return-to-run.js: 45% of the pre-injury week, +20 points a week,
// over a three-week ramp, with quality held for the first two.
function injuryRebuild({fromN, restWeeks = 1, holdWeeks = 2}){
  const preInjuryKm = kmAt(fromN - 1) || 30;
  const ceilingFor = idx => idx < 3 ? Math.round(preInjuryKm * Math.min(100, 45 + 20 * idx)) / 100 : null;
  const openingKm = ceilingFor(0);
  const scope = scopeToJoin({weeks, fromN, openingKm, restWeeks, blockEndN: Math.max(...weeks.map(w => w.n)), ceilingFor});
  const spec = {
    weeks, fromN, toN: scope.toN, openingKm, joinKm: scope.joinKm,
    peakKm: ceilingFor,
    longCapKm: idx => idx < 3 ? Math.round(preInjuryKm * 0.33 * (0.45 + 0.2 * idx) * 10) / 10 : null,
    restWeeks, qualityHoldWeeks: holdWeeks, goalActive: true,
    restNote: 'No running - still resting.',
    callout: 'Rebuilt around the injury.',
  };
  return {scope, preInjuryKm, result: generatePlanWeeks(spec)};
}

const splice = proposed => {
  const byN = new Map(weeks.map(w => [w.n, materializeWeek(w)]));
  proposed.forEach(w => byN.set(w.n, materializeWeek(w)));
  return Array.from(byN.values()).sort((a, b) => a.n - b.n);
};

describe('the real sub-1:30 block', () => {
  it('loads as a 54-week block that already has its own audit failures', () => {
    expect(weeks.length).toBe(54);
    // The generator is held to "introduces no NEW failure", not "fixes everything that was
    // already wrong" - so it matters that the baseline genuinely has some.
    const before = auditBlock(weeks.map(materializeWeek), {blockStartN: BLOCK_START_N});
    expect(before.failures.length).toBeGreaterThan(0);
  });

  // fromN 7..14 walks the rebuild across the base phase, its cutbacks and the weeks around
  // them - one injury is one situation, and a generator that only handles that one is luck.
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(fromN => {
    describe('an injury return starting at n' + fromN + ' (w' + (fromN - BLOCK_START_N + 1) + ')', () => {
      it('introduces no audit failure', () => {
        const {result} = injuryRebuild({fromN});
        const before = auditBlock(weeks.map(materializeWeek), {blockStartN: BLOCK_START_N});
        const after = auditBlock(splice(result.weeks), {blockStartN: BLOCK_START_N});
        const had = new Set(before.failures.map(f => f.id));
        expect(after.failures.filter(f => !had.has(f.id))).toEqual([]);
      });

      it('holds quality for the hold window and brings it back straight after', () => {
        const {result} = injuryRebuild({fromN});
        const running = result.weeks.filter(w => (w.days||[]).some(d => d.type !== 'open'));
        expect(running.slice(0, 2).some(w => w.days.some(d => d.type === 'threshold' || d.type === 'vo2max'))).toBe(false);
        expect(running.slice(2).some(w => w.days.some(d => d.type === 'threshold' || d.type === 'vo2max'))).toBe(true);
      });

      it('opens at the protocol volume and never steps up faster than the rule allows', () => {
        const {result, preInjuryKm} = injuryRebuild({fromN});
        const running = result.weeks.filter(w => computeWeekPlannedKm(materializeWeek(w)) > 0);
        expect(computeWeekPlannedKm(materializeWeek(running[0]))).toBeLessThanOrEqual(preInjuryKm * 0.45 * 1.15);
        // Build week against previous BUILD week, which is what the audit measures - the climb
        // out of a cutback is measured from the week before it, not from the cutback itself.
        let prevBuild = null;
        running.forEach(w => {
          if(w.cutback) return;
          const km = computeWeekPlannedKm(materializeWeek(w));
          if(prevBuild != null) expect(km / prevBuild).toBeLessThanOrEqual(1 + MAX_WEEKLY_RAMP + 1e-9);
          prevBuild = km;
        });
      });

      it('either hands back without a spike, or reports the step it is leaving', () => {
        const {scope, result} = injuryRebuild({fromN});
        if(scope.joinKm == null) return;
        // seamStepPct is measured off the weeks actually built, so it is the number the runner
        // would really step across. A gap too big to close inside MAX_SCOPE_WEEKS is a real
        // fact about the plan: it gets reported, not hidden and not buried under a rewrite of
        // half the block.
        if(result.seamStepPct > MAX_WEEKLY_RAMP * 100) expect(scope.clampedByMaxWeeks).toBe(true);
      });

      it('rewrites only the weeks the injury actually touches, never the year', () => {
        const {result} = injuryRebuild({fromN});
        expect(result.weeks.length).toBeLessThanOrEqual(MAX_SCOPE_WEEKS);
      });
    });
  });

  // A real guard, not a formality. Adding the per-day 'has this date passed?' checks made the
  // generator call weekdayTag a few hundred times a rebuild, and weekdayTag was formatting
  // fourteen locale strings per call - which turned a 250ms rebuild into a five-second one and
  // hung this very suite. A loose bound would have let that through.
  it('builds a whole return in well under a second - nothing here is a round trip', () => {
    injuryRebuild({fromN: 9});   // warm the module, as a real page load already would be
    const started = Date.now();
    injuryRebuild({fromN: 9});
    expect(Date.now() - started).toBeLessThan(300);
  });
});
