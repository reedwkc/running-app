// @ts-nocheck
import { beforeEach, describe, expect, it } from 'vitest';
import { generatePlanWeeks, placeCutbacks, volumeCurve, weekdayTag, measureDayKm, weeksNeededToJoin, scopeToJoin, firstRebuildableWeekN, TRAINING_DAYS, describeGeneratedPlan } from './plan-generator.js';
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

// The bug this section exists for: a rebuild started on a Sunday produced four sessions dated
// Mon/Wed/Thu/Sat of the week that had just finished. The generator had no concept of "today"
// at all, so it happily rewrote days that were already gone - and the validator then rejected
// the whole proposal for "scheduling running" on dates in the past, which is not something
// anyone can act on. A plan may not reschedule a day that has already happened.
describe('a rebuild never rewrites a day that has already passed', () => {
  const weeks = fixtureBlock({count: 12, startKm: 42, startDate: new Date(2026, 8, 14)});
  // Sunday Sep 20 - the last day of week 1 (Sep 14-20). Every training day in it is behind us.
  const SUNDAY = '2026-09-20';
  const WEDNESDAY = '2026-09-23';   // mid-week 2 (Sep 21-27): Mon gone, Wed/Thu/Sat ahead

  const dayDates = result => result.weeks.flatMap(w => w.days.map(d => {
    const md = d.tag.split(' - ')[1];
    return new Date(md + ', 2026').toISOString().slice(0, 10);
  }));

  it('skips a week whose training days have all been and gone', () => {
    const n = firstRebuildableWeekN(weeks, 1, SUNDAY);
    expect(n).toBe(2);   // week 1 is spent; the rebuild starts at week 2
  });

  it('starts at the current week when it still has days left in it', () => {
    expect(firstRebuildableWeekN(weeks, 1, WEDNESDAY)).toBe(2);
  });

  it('writes no session dated before today, even when handed the spent week', () => {
    const result = generatePlanWeeks({weeks, fromN: 1, toN: 8, openingKm: 21, todayYMD: SUNDAY});
    dayDates(result).forEach(d => expect(d >= SUNDAY).toBe(true));
  });

  it('carries the elapsed part of a half-finished week through untouched', () => {
    const before = weeks.find(w => w.n === 2);
    const mondayBefore = before.days.find(d => d.tag.startsWith('Mon'));
    const result = generatePlanWeeks({weeks, fromN: 2, toN: 8, openingKm: 34, todayYMD: WEDNESDAY});
    const monday = result.weeks[0].days.find(d => d.tag.startsWith('Mon'));
    expect(monday).toEqual(mondayBefore);   // byte for byte, not a regenerated lookalike
  });

  it('still rebuilds the days of that week that are ahead', () => {
    const before = weeks.find(w => w.n === 2);
    const result = generatePlanWeeks({weeks, fromN: 2, toN: 8, openingKm: 34, todayYMD: WEDNESDAY});
    const sat = result.weeks[0].days.find(d => d.tag.startsWith('Sat'));
    const satBefore = before.days.find(d => d.tag.startsWith('Sat'));
    expect(sat).not.toEqual(satBefore);
  });

  // With a return date the runner gave, the days between now and it are open days rather than
  // sessions - resolved per DAY, not rounded to whole weeks.
  it('opens the days between today and the date running resumes, and trains after it', () => {
    const result = generatePlanWeeks({
      weeks, fromN: 2, toN: 8, openingKm: 22,
      todayYMD: '2026-09-21', runFromYMD: '2026-09-24',
    });
    const w2 = result.weeks[0].days;
    expect(w2.find(d => d.tag === 'Mon - Sep 21').type).toBe('open');
    expect(w2.find(d => d.tag === 'Wed - Sep 23').type).toBe('open');
    expect(w2.find(d => d.tag === 'Sat - Sep 26').type).not.toBe('open');
  });

  it('treats a week with no day at or after the return date as a rest week, without being told', () => {
    const result = generatePlanWeeks({
      weeks, fromN: 2, toN: 8, openingKm: 22,
      todayYMD: '2026-09-21', runFromYMD: '2026-09-28',
    });
    expect(result.weeks[0].days.every(d => d.type === 'open')).toBe(true);
    expect(result.weeks[0].noQuality).toBe(true);
  });

  it('reports nothing to do rather than inventing something when the whole range is spent', () => {
    const out = generatePlanWeeks({weeks, fromN: 1, toN: 1, openingKm: 30, todayYMD: SUNDAY});
    expect(out.weeks).toEqual([]);
    expect(out.notes[0]).toContain('already run');
  });
});

// Reported live: week 3 of an injury return had a long run SHORTER than that week's Thursday
// "Medium-long run". The long run is the longest run of the week - that is what makes it the
// long run - and a label cannot stand in for the distance.
describe('the long run is the longest run of the week', () => {
  const weeks = fixtureBlock({count: 20, startKm: 42});
  const longestEasy = w => Math.max(0, ...w.days.filter(d => d.type === 'easy').map(measureDayKm));
  const longRunKm = w => { const d = w.days.find(x => x.type === 'long'); return d ? measureDayKm(d) : 0; };

  // A return ramp is where this bites: the long run is held down by a medical ceiling while
  // weekly volume climbs past it, so the easy days are the ones with room to grow.
  const rampSpecs = [
    ['a tight return ceiling', {openingKm: 19, peakKm: idx => idx < 4 ? 42 * (0.45 + 0.2 * idx) : null, longCapKm: idx => 7 + idx * 3}],
    ['a very tight return ceiling', {openingKm: 24, longCapKm: idx => 6 + idx * 1.5}],
    ['no ceiling at all', {openingKm: 40}],
    ['two quality days and one easy slot', {openingKm: 44, qualityPerWeek: 2}],
  ];

  rampSpecs.forEach(([label, spec]) => {
    it('holds under ' + label, () => {
      const result = generatePlanWeeks(Object.assign({weeks, fromN: 3, toN: 16, qualityHoldWeeks: 2}, spec));
      result.weeks.forEach(w => {
        const long = longRunKm(w);
        if(!long) return;   // a week with no long run at all is a separate, deliberate case
        expect(longestEasy(w)).toBeLessThan(long);
      });
    });
  });

  it('calls a day "Medium-long run" only when it really sits between the easy days and the long run', () => {
    const result = generatePlanWeeks({weeks, fromN: 3, toN: 16, openingKm: 40});
    result.weeks.forEach(w => {
      const long = longRunKm(w);
      w.days.filter(d => /Medium-long/.test(d.name || '')).forEach(d => {
        expect(measureDayKm(d)).toBeLessThan(long);
        expect(measureDayKm(d)).toBeGreaterThanOrEqual(long * 0.7);
      });
    });
  });

  // The other half of the same rule: when a medical ceiling holds the long run below an even
  // share of the week, the week simply has no long run - three or four similar easy runs is
  // what the first weeks back actually are. Better that than a 5km "long run" beside a 6km
  // easy day.
  it('gives a week no long run at all rather than one that is not the longest', () => {
    const result = generatePlanWeeks({weeks, fromN: 3, toN: 8, openingKm: 30, longCapKm: () => 5});
    const noLong = result.weeks.filter(w => !w.days.some(d => d.type === 'long'));
    expect(noLong.length).toBeGreaterThan(0);
    noLong.forEach(w => expect(w.days.some(d => d.type === 'easy')).toBe(true));
  });

  // The fix for the above must not quietly cost the week its volume: the next week's ceiling is
  // 10% of what this one ACTUALLY came to, so a shortfall compounds down the whole ramp.
  it('still lands each week on the volume it planned', () => {
    const result = generatePlanWeeks({weeks, fromN: 3, toN: 16, openingKm: 19, qualityHoldWeeks: 2,
      longCapKm: idx => 7 + idx * 3});
    result.rows.filter(r => r.targetKm > 0).forEach(r => {
      expect(Math.abs(r.actualKm - r.targetKm) / r.targetKm).toBeLessThan(0.08);
    });
  });
});

// A proposal must never write through to the plan it is a proposal ABOUT.
//
// The volume trim was handed the whole assembled week, which includes the elapsed days carried
// through from the existing plan - and those are the very same objects state.WEEKS holds. So
// every rebuild quietly shortened the runner's real weeks in memory, and running one twice
// shortened them twice: a 46km week read as 21km after a few passes, and the scope arithmetic
// then sized the whole return against numbers it had itself destroyed.
describe('generating a plan never touches the plan it is generating from', () => {
  const snapshot = weeks => JSON.stringify(weeks);

  it('leaves the source weeks byte-identical', () => {
    const weeks = fixtureBlock({count: 16, startKm: 42});
    const before = snapshot(weeks);
    generatePlanWeeks({weeks, fromN: 3, toN: 14, openingKm: 22, qualityHoldWeeks: 2, longCapKm: idx => 7 + idx * 3});
    expect(snapshot(weeks)).toBe(before);
  });

  it('gives the same answer the second time it is asked', () => {
    const weeks = fixtureBlock({count: 16, startKm: 42});
    const spec = {weeks, fromN: 3, toN: 14, openingKm: 22, qualityHoldWeeks: 2, longCapKm: idx => 7 + idx * 3};
    const first = generatePlanWeeks(spec);
    const second = generatePlanWeeks(spec);
    expect(second.rows.map(r => r.actualKm)).toEqual(first.rows.map(r => r.actualKm));
  });

  it('still carries the elapsed days through untouched while trimming the new ones', () => {
    const weeks = fixtureBlock({count: 16, startKm: 42});
    const WEDNESDAY = weeks[1].days[2].tag.replace(/^\w+/, 'Thu');   // mid-week 2
    const before = JSON.parse(JSON.stringify(weeks.find(w => w.n === 2)));
    const result = generatePlanWeeks({weeks, fromN: 2, toN: 10, openingKm: 30, todayYMD: '2026-09-23'});
    const monday = result.weeks[0].days.find(d => d.tag.startsWith('Mon'));
    expect(monday).toEqual(before.days.find(d => d.tag.startsWith('Mon')));
    expect(WEDNESDAY).toBeTruthy();
  });
});
