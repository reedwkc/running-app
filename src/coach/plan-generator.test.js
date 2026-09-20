// @ts-nocheck
import { beforeEach, describe, expect, it } from 'vitest';
import { generatePlanWeeks, placeCutbacks, volumeCurve, weekdayTag, measureDayKm, weeksNeededToJoin, scopeToJoin, TRAINING_DAYS, describeGeneratedPlan } from './plan-generator.js';
import { auditBlock, MAX_WEEKLY_RAMP } from './plan-audit.js';
import { materializeWeek, computeWeekPlannedKm } from '../data/plan.js';
import { state } from '../state.js';

// Zones roughly matching this runner: LT 4:35/km.
const ZONES = {
  S1: {pace: 375, hr: '120-148'},
  S2: {pace: 330, hr: '148-164'},
  S3: {pace: 300, hr: '164-175'},
  S4: {pace: 275, hr: '175-184'},
  S5: {pace: 255, hr: '184+'},
  GOAL: {pace: 256, hr: '175-184'},
  RACE10K: {pace: 248, hr: '180+'},
};

// Set at module load, not only in beforeEach: the scenario table below builds its plans at
// collection time, before any hook has run.
state.Z = ZONES;
state.goalConfig = {activeGoals: []};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = d => MONTHS[d.getMonth()] + ' ' + d.getDate();

// A plain, sound block to rebuild inside: Monday-start weeks, four training days, two quality
// sessions, a long run, an even ramp. Built programmatically so the dates are real dates.
function fixtureBlock({count = 24, startKm = 40, startDate = new Date(2026, 8, 14)} = {}){
  const weeks = [];
  for(let i = 0; i < count; i++){
    const start = new Date(startDate);
    start.setDate(startDate.getDate() + i * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const cutback = (i + 1) % 5 === 0;
    const km = startKm * Math.pow(1.03, i) * (cutback ? 0.82 : 1);
    const phase = i < 8 ? 'base' : i < 16 ? 'strength' : 'threshold';
    const dayDate = k => { const d = new Date(start); d.setDate(start.getDate() + k); return d.toLocaleDateString('en-US', {weekday: 'short'}) + ' - ' + md(d); };
    const longKm = Math.round(km * 0.33 * 2) / 2;
    weeks.push({
      n: i + 1,
      dates: md(start) + '-' + (start.getMonth() === end.getMonth() ? end.getDate() : md(end)),
      year: start.getFullYear() === 2026 ? undefined : start.getFullYear(),
      phase, cutback,
      days: [
        {tag: dayDate(0), name: 'VO2max 5 x 3min', zone: 'S5', type: 'vo2max', recipe: {fn: 'vo2max', args: {reps: 5, repMin: 3, recoveryMin: 2.5, wuKm: 2, cdKm: 1.5}}},
        {tag: dayDate(2), name: 'Threshold', zone: 'S4', type: 'threshold', recipe: {fn: 'threshold', args: {reps: 5 + (i % 3), repM: 1000, recoverySec: 90, recoveryLabel: 'jog', wuKm: 2, cdKm: 1.5}}},
        {tag: dayDate(3), name: 'Medium-long run', zone: 'S2', type: 'easy', recipe: {fn: 'easyS', args: {km: Math.round(km * 0.2)}}},
        {tag: dayDate(5), name: 'Long run', zone: 'S2', type: 'long', recipe: {fn: 'longRun', args: {segments: [{km: longKm - 3, zone: 'S2'}, {km: 3 + (i % 4) * 0.5, zone: 'S3'}]}}},
      ],
    });
  }
  return weeks;
}

const splice = (current, proposed) => {
  const byN = new Map(current.map(w => [w.n, materializeWeek(w)]));
  proposed.forEach(w => byN.set(w.n, materializeWeek(w)));
  return Array.from(byN.values()).sort((a, b) => a.n - b.n);
};

// The bar every generated plan has to clear: it may not introduce an audit FAILURE the block
// did not already have. Mirrors introducedFailures() in plan-override.js, which is what
// actually gates Apply.
function newFailures(before, after){
  const had = new Set(before.failures.map(f => f.id));
  return after.failures.filter(f => !had.has(f.id));
}

describe('plan-generator', () => {
  beforeEach(() => { state.Z = ZONES; state.goalConfig = {activeGoals: []}; });

  describe('weekdayTag', () => {
    it('resolves a weekday to the real date inside that week', () => {
      const w = {n: 1, dates: 'Sep 14-20'};
      expect(weekdayTag(w, 'Mon')).toBe('Mon - Sep 14');
      expect(weekdayTag(w, 'Sat')).toBe('Sat - Sep 19');
    });

    it('returns null rather than inventing a date when the week has no parseable range', () => {
      expect(weekdayTag({n: 1}, 'Mon')).toBe(null);
    });
  });

  describe('placeCutbacks', () => {
    it('never lets more than CUTBACK_MAX_GAP build weeks pass without one', () => {
      const slots = new Array(12).fill(0).map(() => ({kind: 'build'}));
      const kinds = placeCutbacks(slots, 0, 4);
      let run = 0;
      kinds.forEach(k => { if(k === 'cutback') run = 0; else run++; expect(run).toBeLessThanOrEqual(4); });
    });

    it('counts the build weeks that already ran before the rebuild, so the cadence crosses the seam', () => {
      const slots = new Array(6).fill(0).map(() => ({kind: 'build'}));
      expect(placeCutbacks(slots, 4, 4)[0]).toBe('cutback');
      expect(placeCutbacks(slots, 0, 4)[0]).toBe('build');
    });

    it('never ends the rebuilt stretch on a cutback - the last week hands back to real training', () => {
      const slots = new Array(5).fill(0).map(() => ({kind: 'build'}));
      expect(placeCutbacks(slots, 4, 4)[4]).not.toBe('cutback');
    });
  });

  describe('volumeCurve', () => {
    it('ramps evenly and never exceeds the weekly ceiling between build weeks', () => {
      const kinds = ['build', 'build', 'build', 'build', 'cutback', 'build'];
      const {km} = volumeCurve({kinds, slots: kinds.map(() => ({})), openingKm: 30, joinKm: 48});
      const builds = km.filter((_, i) => kinds[i] === 'build');
      for(let i = 1; i < builds.length; i++){
        expect(builds[i] / builds[i - 1]).toBeLessThanOrEqual(1 + MAX_WEEKLY_RAMP + 1e-9);
      }
    });

    it('cuts a cutback week well past the 12% the audit demands', () => {
      const kinds = ['build', 'cutback'];
      const {km} = volumeCurve({kinds, slots: kinds.map(() => ({})), openingKm: 50, joinKm: null});
      expect(km[1]).toBeLessThan(km[0] * 0.88);
    });

    it('reports the seam step rather than jumping to meet an out-of-reach join', () => {
      const kinds = ['build', 'build'];
      const out = volumeCurve({kinds, slots: kinds.map(() => ({})), openingKm: 20, joinKm: 60});
      expect(out.endKm).toBeLessThanOrEqual(22.1);
      expect(out.seamStepPct).toBeGreaterThan(10);
    });

    it('closes the seam exactly when the scope is long enough for it', () => {
      const kinds = new Array(8).fill('build');
      const out = volumeCurve({kinds, slots: kinds.map(() => ({})), openingKm: 25, joinKm: 42});
      expect(out.seamStepPct).toBeLessThanOrEqual(MAX_WEEKLY_RAMP * 100);
    });
  });

  describe('an injury return', () => {
    // The exact case that could never pass before: two weeks of no running, then a ramp with a
    // two-week quality hold, rejoining the untouched plan.
    const build = () => {
      const weeks = fixtureBlock({count: 24, startKm: 42});
      const fromN = 5, restWeeks = 2, openingKm = 19;
      // The pre-injury week was 42km, and the protocol opens at 45% of it and climbs 20 points
      // a week - a ceiling that RISES and then stops applying, which is what lets the join
      // weeks rejoin the plan's own progression.
      const peakKm = idx => idx < 4 ? 42 * Math.min(1, 0.45 + 0.20 * idx) : null;
      // The scope is SIZED by the same arithmetic that fills it - this is the whole point:
      // how many weeks a return needs is computed, not guessed and then found wanting at
      // audit time after a dozen model calls.
      const scope = scopeToJoin({weeks, fromN, openingKm, restWeeks, ceilingFor: peakKm});
      return {
        weeks, scope,
        result: generatePlanWeeks({
          weeks, fromN, toN: scope.toN,
          openingKm, joinKm: scope.joinKm, peakKm,
          restWeeks, qualityHoldWeeks: 2,
          longCapKm: idx => 8 + idx * 3,
          restNote: 'Resting the quad - no running.',
          callout: 'Rebuilt around the quad strain.',
        }),
      };
    };

    it('introduces no audit failure - including the "every week carries quality" one that used to make this impossible', () => {
      const {weeks, result} = build();
      const before = auditBlock(weeks.map(materializeWeek), {blockStartN: 1});
      const after = auditBlock(splice(weeks, result.weeks), {blockStartN: 1});
      expect(newFailures(before, after)).toEqual([]);
    });

    it('leaves no running at all on the rest weeks', () => {
      const {result} = build();
      const rest = result.weeks.slice(0, 2);
      rest.forEach(w => {
        expect(w.days.every(d => d.type === 'open')).toBe(true);
        expect(computeWeekPlannedKm(materializeWeek(w))).toBe(0);
        expect(w.noQuality).toBe(true);
      });
    });

    it('holds threshold and VO2max work for exactly the weeks the protocol says', () => {
      const {result} = build();
      const running = result.weeks.slice(2);
      expect(running[0].days.some(d => d.type === 'threshold' || d.type === 'vo2max')).toBe(false);
      expect(running[1].days.some(d => d.type === 'threshold' || d.type === 'vo2max')).toBe(false);
      expect(running[2].days.some(d => d.type === 'threshold' || d.type === 'vo2max')).toBe(true);
    });

    it('keeps the long run under its own return-to-run ceiling', () => {
      const {result} = build();
      result.weeks.slice(2).forEach((w, i) => {
        const long = w.days.find(d => d.type === 'long');
        if(!long) return;
        expect(measureDayKm(long)).toBeLessThanOrEqual(8 + i * 3 + 0.01);
      });
    });

    it('opens at the prescribed first-week volume rather than wherever the ramp felt like starting', () => {
      const {result} = build();
      const firstBack = materializeWeek(result.weeks[2]);
      expect(computeWeekPlannedKm(firstBack)).toBeGreaterThan(16);
      expect(computeWeekPlannedKm(firstBack)).toBeLessThanOrEqual(20.9);
    });

    it('either hands back without a spike, or says plainly that it could not', () => {
      const {scope, result} = build();
      // Opening at 19km against a plan already running in the forties is a gap that genuinely
      // needs more than MAX_SCOPE_WEEKS of climbing. The honest answer is to say so - not to
      // jump the seam, and not to rewrite half the block to hide it.
      if(result.seamStepPct > MAX_WEEKLY_RAMP * 100) expect(scope.clampedByMaxWeeks).toBe(true);
      else expect(scope.clampedByMaxWeeks).toBeFalsy();
    });
  });

  describe('every generated week, whatever the scenario', () => {
    const scenarios = [
      ['injury return', {fromN: 5, toN: 12, openingKm: 18, restWeeks: 2, qualityHoldWeeks: 2, peakKm: idx => idx < 4 ? 42 * Math.min(1, 0.45 + 0.20 * idx) : null, longCapKm: idx => 8 + idx * 3}],
      ['rebalance down', {fromN: 6, toN: 13, openingKm: 34, peakKm: 44}],
      ['push harder', {fromN: 6, toN: 15, openingKm: 46, peakKm: 62}],
      ['a long rebuild', {fromN: 3, toN: 23, openingKm: 38, peakKm: 64}],
      ['a two-week tweak', {fromN: 8, toN: 9, openingKm: 44, peakKm: 48}],
    ];

    scenarios.forEach(([label, spec]) => {
      describe(label, () => {
        const weeks = fixtureBlock({count: 24, startKm: 42});
        const joinWeek = weeks.find(w => w.n === spec.toN + 1);
        const result = generatePlanWeeks(Object.assign({
          weeks,
          joinKm: joinWeek ? computeWeekPlannedKm(materializeWeek(joinWeek)) : null,
        }, spec));

        it('introduces no audit failure', () => {
          const before = auditBlock(weeks.map(materializeWeek), {blockStartN: 1});
          const after = auditBlock(splice(weeks, result.weeks), {blockStartN: 1});
          expect(newFailures(before, after)).toEqual([]);
        });

        it('puts every session on one of the four training days', () => {
          result.weeks.forEach(w => w.days.forEach(d => {
            if(d.type === 'race') return;
            expect(TRAINING_DAYS).toContain(d.tag.split(' - ')[0]);
          }));
        });

        it('never puts two hard days back to back', () => {
          const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
          result.weeks.forEach(w => {
            const idx = w.days.filter(d => ['threshold', 'vo2max', 'long', 'race'].includes(d.type))
              .map(d => order.indexOf(d.tag.split(' - ')[0])).sort((a, b) => a - b);
            for(let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1]).toBeGreaterThan(1);
          });
        });

        it('writes every training day as a recipe, never as frozen numbers', () => {
          result.weeks.forEach(w => w.days.forEach(d => {
            if(d.type === 'open' || d.type === 'race') return;
            expect(d.recipe).toBeTruthy();
          }));
        });

        it('lands each week within a few percent of the volume it planned', () => {
          result.rows.filter(r => r.targetKm > 0).forEach(r => {
            expect(Math.abs(r.actualKm - r.targetKm) / r.targetKm).toBeLessThan(0.12);
          });
        });

        it('keeps the long run under 40% of its own week', () => {
          result.weeks.forEach(w => {
            const km = computeWeekPlannedKm(materializeWeek(w));
            const long = w.days.find(d => d.type === 'long');
            if(!km || !long) return;
            expect(measureDayKm(long) / km).toBeLessThan(0.40);
          });
        });
      });
    });
  });

  describe('session variety', () => {
    it('rotates the quality session shape rather than prescribing the same week twenty times', () => {
      const weeks = fixtureBlock({count: 24, startKm: 42});
      const result = generatePlanWeeks({weeks, fromN: 3, toN: 20, openingKm: 38, peakKm: 62});
      const names = new Set();
      result.weeks.forEach(w => w.days.filter(d => d.type === 'threshold' || d.type === 'vo2max')
        .forEach(d => names.add(d.name.replace(/\d+/g, 'N'))));
      expect(names.size).toBeGreaterThanOrEqual(4);
    });
  });

  describe('describeGeneratedPlan', () => {
    it('says what the weeks actually do, with real numbers', () => {
      const text = describeGeneratedPlan([
        {n: 5, kind: 'rest', actualKm: 0},
        {n: 6, kind: 'build', actualKm: 20},
        {n: 7, kind: 'build', actualKm: 24},
        {n: 8, kind: 'cutback', actualKm: 20},
      ], {holdWeeks: 2, joinN: 9});
      expect(text).toContain('Week 5');
      expect(text).toContain('20km');
      expect(text).toContain('Cutback week: 8.');
      expect(text).toContain('No threshold or VO2max work for the first 2 weeks');
    });
  });
});
