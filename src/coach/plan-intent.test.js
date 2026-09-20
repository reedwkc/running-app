// @ts-nocheck
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPlanIntentSystemPrompt, buildPlanTable, intentToSpec, parsePlanIntent, PLAN_INTENT_MARKER } from './plan-intent.js';
import { state } from '../state.js';

const ZONES = {
  S1: {pace: 375}, S2: {pace: 330}, S3: {pace: 300}, S4: {pace: 275}, S5: {pace: 255},
  GOAL: {pace: 256}, RACE10K: {pace: 248},
};

const CFG = {
  blockStartWeekN: 7,
  activeGoals: [{goalId: 'hm-sub130', zoneKey: 'GOAL', label: 'Half marathon', distanceKm: 21.0975, raceDate: '2027-09-04', goalTimeLabel: 'sub-1:30:00', goalTimeSec: 5400}],
};

const WEEKS = [
  {n: 7, dates: 'Sep 14-20', phase: 'base', days: [
    {tag: 'Wed - Sep 16', type: 'threshold', recipe: {fn: 'threshold', args: {reps: 5, repM: 1000, recoverySec: 90, wuKm: 2, cdKm: 1.5}}},
    {tag: 'Sat - Sep 19', type: 'long', recipe: {fn: 'longRun', args: {segments: [{km: 14, zone: 'S2'}]}}},
  ]},
  {n: 8, dates: 'Sep 21-27', phase: 'base', cutback: true, days: [
    {tag: 'Sat - Sep 26', type: 'long', recipe: {fn: 'longRun', args: {segments: [{km: 12, zone: 'S2'}]}}},
  ]},
];

describe('plan-intent', () => {
  beforeEach(() => { state.Z = ZONES; state.goalConfig = CFG; });

  describe('buildPlanTable', () => {
    // The table exists to replace sending the whole plan as JSON. If it ever grew back toward
    // carrying session detail it would quietly undo the saving it was built for.
    it('is one line per week, carrying only the shape a spec decision depends on', () => {
      const lines = buildPlanTable(WEEKS, CFG).split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('w1 (n7)');
      expect(lines[0]).toContain('base');
      expect(lines[0]).toContain('1 quality');
      expect(lines[0]).toContain('long 14km');
      expect(lines[1]).toContain('CUTBACK');
    });

    it('states both numberings, so the model can answer in the one the runner sees', () => {
      expect(buildPlanTable(WEEKS, CFG)).toContain('w2 (n8)');
    });

    it('is a small fraction of the size of the plan JSON it replaced', () => {
      const table = buildPlanTable(WEEKS, CFG);
      expect(table.length).toBeLessThan(JSON.stringify(WEEKS).length / 2);
    });
  });

  describe('buildPlanIntentSystemPrompt', () => {
    it('tells the model what the app already guarantees, so it does not try to specify it', () => {
      const text = buildPlanIntentSystemPrompt(WEEKS, CFG)[0].text;
      expect(text).toContain('10% over the previous build week');
      expect(text).toContain('Mon/Wed/Thu/Sat');
      expect(text).toContain(PLAN_INTENT_MARKER);
    });

    it('names the real goal fields, so a goal change cannot be written with invented ones', () => {
      const text = buildPlanIntentSystemPrompt(WEEKS, CFG)[0].text;
      expect(text).toContain('goalId "hm-sub130"');
      expect(text).toContain('zoneKey "GOAL"');
    });

    it('carries extra context when a revision supplies it', () => {
      expect(buildPlanIntentSystemPrompt(WEEKS, CFG, 'THE CHANGE YOU JUST PROPOSED: weeks n9, n10.')[0].text)
        .toContain('THE CHANGE YOU JUST PROPOSED');
    });
  });

  describe('parsePlanIntent', () => {
    it('keeps the coach\'s own explanation alongside the spec', () => {
      const out = parsePlanIntent('Easing the next month back.\n\n' + PLAN_INTENT_MARKER + ' {"action":"rebuild","openingKm":38}');
      expect(out.ok).toBe(true);
      expect(out.prose).toBe('Easing the next month back.');
      expect(out.intent.openingKm).toBe(38);
    });

    it('still returns the prose when no spec block came back at all - a plain answer is a real answer', () => {
      const out = parsePlanIntent('Nothing needs to change here.');
      expect(out.ok).toBe(false);
      expect(out.prose).toBe('Nothing needs to change here.');
    });

    it('reports unparseable JSON rather than throwing', () => {
      const out = parsePlanIntent(PLAN_INTENT_MARKER + ' {"action": rebuild}');
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('bad-json');
    });
  });

  describe('intentToSpec', () => {
    const ctx = {weeks: WEEKS, fromN: 7, toN: 12, joinKm: 44, currentWeekN: 7, blockEndN: 20, fallbackOpeningKm: 40, goalActive: true};

    it('passes sensible values straight through', () => {
      const spec = intentToSpec({openingKm: 36, peakKm: 58, qualityPerWeek: 2, longCapKm: 22, callout: 'Easing back.'}, ctx);
      expect(spec.openingKm).toBe(36);
      expect(spec.peakKm).toBe(58);
      expect(spec.qualityPerWeek).toBe(2);
      expect(spec.longCapKm).toBe(22);
      expect(spec.callout).toBe('Easing back.');
    });

    // The spec is the one place a bad number could still reach the plan, and it is small
    // enough to check completely - so it is checked completely rather than trusted.
    it('clamps a wild volume rather than letting it through', () => {
      expect(intentToSpec({openingKm: 900}, ctx).openingKm).toBe(200);
      expect(intentToSpec({openingKm: 0.2}, ctx).openingKm).toBe(5);
    });

    it('falls back to the plan\'s own volume when none was given', () => {
      expect(intentToSpec({}, ctx).openingKm).toBe(40);
    });

    it('never lets the rest weeks swallow more than the scope itself', () => {
      expect(intentToSpec({restWeeks: 40}, ctx).restWeeks).toBe(5);
    });

    it('ignores a quality count that is not 1 or 2', () => {
      expect(intentToSpec({qualityPerWeek: 4}, ctx).qualityPerWeek).toBe(null);
      expect(intentToSpec({qualityPerWeek: 1}, ctx).qualityPerWeek).toBe(1);
    });

    it('drops a callout long enough to be a paragraph', () => {
      expect(intentToSpec({callout: 'x'.repeat(400)}, ctx).callout).toBe(null);
    });
  });
});
