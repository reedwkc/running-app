import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../state.js';
import {
  calendarWeekKey, computeNearbyQualityGapDays, dateToTag, dateToYMD, getFullWeekDayList, parseDayTagDate,
  parseWeekEndDate, parseWeekStartDate, weekHasEnded,
} from './dates.js';

// parseDayTagDate resolves a bare tag's year by searching state.WEEKS (a shared, mutable
// module singleton) when no explicit weeksOverride is given - reset here so every test in
// this file starts from a known "no plan loaded yet" state (falls back to 2026, this app's
// original single-year default) regardless of what an earlier test in this same file left
// behind, rather than depending on declaration order to happen to be safe.
beforeEach(() => { state.WEEKS = undefined; });

describe('calendarWeekKey', () => {
  it('returns a YYYY-Wnn shaped key', () => {
    expect(calendarWeekKey(new Date(2026, 7, 5))).toMatch(/^\d{4}-W\d{2}$/);
  });
  it('gives the same key for two dates in the same calendar week', () => {
    const mon = new Date(2026, 7, 3);
    const sun = new Date(2026, 7, 9);
    expect(calendarWeekKey(mon)).toBe(calendarWeekKey(sun));
  });
  it('gives a different key for dates a week apart', () => {
    expect(calendarWeekKey(new Date(2026, 7, 5))).not.toBe(calendarWeekKey(new Date(2026, 7, 12)));
  });
});

describe('parseDayTagDate', () => {
  it('parses a "Weekday - Mon D" tag into a Date', () => {
    const d = parseDayTagDate('Wed - Aug 5');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // August, 0-indexed
    expect(d.getDate()).toBe(5);
  });
  it('returns null for a tag with no " - " separator', () => {
    expect(parseDayTagDate('garbage')).toBeNull();
  });
});

describe('parseWeekStartDate / parseWeekEndDate', () => {
  it('parses a same-month week range', () => {
    const w = {dates: 'Aug 3-9'};
    const start = parseWeekStartDate(w);
    const end = parseWeekEndDate(w);
    expect(start.getMonth()).toBe(7); expect(start.getDate()).toBe(3);
    expect(end.getMonth()).toBe(7); expect(end.getDate()).toBe(9);
    expect(start.getHours()).toBe(0);
    expect(end.getHours()).toBe(23);
  });
  it('parses a week range spanning two months', () => {
    const w = {dates: 'Aug 31-Sep 6'};
    const start = parseWeekStartDate(w);
    const end = parseWeekEndDate(w);
    expect(start.getMonth()).toBe(7); expect(start.getDate()).toBe(31);
    expect(end.getMonth()).toBe(8); expect(end.getDate()).toBe(6);
  });
});

describe('multi-year plan support', () => {
  it('resolves a day tag\'s year from state.WEEKS when the owning week carries an explicit "year"', () => {
    state.WEEKS = [{n:20, dates:'Jan 4-10', year:2027, days:[{tag:'Mon - Jan 4', name:'Easy', type:'easy'}]}];
    const d = parseDayTagDate('Mon - Jan 4');
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(4);
  });

  it('falls back to 2026 for a week with no "year" field, even alongside other weeks that do have one', () => {
    state.WEEKS = [
      {n:1, dates:'Aug 3-9', days:[{tag:'Wed - Aug 5', name:'Threshold', type:'threshold'}]},
      {n:20, dates:'Jan 4-10', year:2027, days:[{tag:'Mon - Jan 4', name:'Easy', type:'easy'}]},
    ];
    expect(parseDayTagDate('Wed - Aug 5').getFullYear()).toBe(2026);
    expect(parseDayTagDate('Mon - Jan 4').getFullYear()).toBe(2027);
  });

  it('resolves against an explicit weeksOverride (e.g. a not-yet-applied proposal) instead of state.WEEKS - needed so a plan-override proposal reaching into a new year resolves correctly before it\'s ever merged into the live plan', () => {
    state.WEEKS = []; // the tag genuinely doesn't exist in the live plan yet
    const proposalWeeks = [{n:20, dates:'Jan 4-10', year:2027, days:[{tag:'Mon - Jan 4', name:'Easy', type:'easy'}]}];
    expect(parseDayTagDate('Mon - Jan 4', proposalWeeks).getFullYear()).toBe(2027);
  });

  it('falls back to 2026 for a tag found in neither the override nor state.WEEKS - an orphaned reference, matching this app\'s original single-year behavior', () => {
    state.WEEKS = [];
    expect(parseDayTagDate('Mon - Jan 4', []).getFullYear()).toBe(2026);
  });

  it('parseWeekStartDate/parseWeekEndDate read a week\'s own "year" field directly, with no state.WEEKS dependency at all', () => {
    const w = {dates:'Jan 4-10', year:2027};
    expect(parseWeekStartDate(w).getFullYear()).toBe(2027);
    expect(parseWeekEndDate(w).getFullYear()).toBe(2027);
  });

  it('correctly resolves a week that genuinely crosses a real Jan 1 boundary (e.g. "Dec 28-Jan 3") - the end date lands one calendar year after the week\'s own "year"', () => {
    const w = {dates:'Dec 28-Jan 3', year:2026};
    const start = parseWeekStartDate(w);
    const end = parseWeekEndDate(w);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(11); expect(start.getDate()).toBe(28);
    expect(end.getFullYear()).toBe(2027);
    expect(end.getMonth()).toBe(0); expect(end.getDate()).toBe(3);
  });

  it('resolves a January day tag inside a week that crosses Jan 1 to the NEXT year, not the week\'s own (December) "year" field - a week has one year field but its January days are chronologically a year later', () => {
    state.WEEKS = [{n:22, dates:'Dec 28-Jan 3', year:2026, days:[
      {tag:'Mon - Dec 28'}, {tag:'Thu - Dec 31'}, {tag:'Fri - Jan 1'}, {tag:'Sun - Jan 3'},
    ]}];
    expect(parseDayTagDate('Mon - Dec 28').getFullYear()).toBe(2026);
    expect(parseDayTagDate('Thu - Dec 31').getFullYear()).toBe(2026);
    const jan1 = parseDayTagDate('Fri - Jan 1');
    expect(jan1.getFullYear()).toBe(2027);
    expect(jan1.getMonth()).toBe(0); expect(jan1.getDate()).toBe(1);
    const jan3 = parseDayTagDate('Sun - Jan 3');
    expect(jan3.getFullYear()).toBe(2027);
  });
});

describe('dateToTag', () => {
  it('formats a Date back into the "Weekday - Mon D" tag shape', () => {
    expect(dateToTag(new Date(2026, 7, 5))).toBe('Wed - Aug 5');
  });
  it('round-trips through parseDayTagDate', () => {
    const original = new Date(2026, 7, 12);
    const tag = dateToTag(original);
    const parsed = parseDayTagDate(tag);
    expect(parsed.getMonth()).toBe(original.getMonth());
    expect(parsed.getDate()).toBe(original.getDate());
  });
});

describe('dateToYMD', () => {
  it('formats a locally-constructed Date as YYYY-MM-DD using its LOCAL parts', () => {
    expect(dateToYMD(new Date(2026, 7, 5))).toBe('2026-08-05');
  });

  it('pads single-digit month and day', () => {
    expect(dateToYMD(new Date(2026, 0, 3))).toBe('2026-01-03');
  });

  it('round-trips a parseDayTagDate result back to the matching YYYY-MM-DD, unaffected by test-runner timezone', () => {
    // This is the actual real-world call pattern (openAddWorkoutForDay/confirmRetry in
    // ui/modals.js) - parseDayTagDate("Aug 28, 2026") constructs a LOCAL date, and
    // dateToYMD must read it back using the SAME local semantics, never round-tripping
    // through UTC (see the fix this replaced: dDate.toISOString().slice(0,10), which
    // silently landed on Aug 27 for any timezone east of UTC).
    const d = parseDayTagDate('Fri - Aug 28');
    expect(dateToYMD(d)).toBe('2026-08-28');
  });

  it('reads local midnight as that same calendar day, never converting through UTC first', () => {
    // The actual bug report: dDate.toISOString().slice(0,10) on a local-midnight Date can
    // silently land on the PREVIOUS day for any timezone east of UTC. dateToYMD never
    // touches UTC at all, so this holds regardless of which timezone the test runner itself
    // is in.
    const localMidnight = new Date(2026, 7, 28, 0, 0, 0, 0);
    expect(dateToYMD(localMidnight)).toBe('2026-08-28');
  });
});

describe('getFullWeekDayList', () => {
  it('returns the week unchanged when every day already has an entry', () => {
    const w = {
      dates: 'Aug 3-4',
      days: [
        {tag:'Mon - Aug 3', name:'Threshold', type:'threshold'},
        {tag:'Tue - Aug 4', name:'Easy', type:'easy'},
      ],
    };
    const full = getFullWeekDayList(w);
    expect(full.map(d=>d.tag)).toEqual(['Mon - Aug 3', 'Tue - Aug 4']);
  });
  it('fills gaps with synthesized "Open day" entries', () => {
    const w = {
      dates: 'Aug 3-5',
      days: [
        {tag:'Mon - Aug 3', name:'Threshold', type:'threshold'},
        {tag:'Wed - Aug 5', name:'Long run', type:'long'},
      ],
    };
    const full = getFullWeekDayList(w);
    expect(full.map(d=>d.tag)).toEqual(['Mon - Aug 3', 'Tue - Aug 4', 'Wed - Aug 5']);
    expect(full[1].type).toBe('open');
    expect(full[1].name).toBe('Open day');
  });
});

describe('computeNearbyQualityGapDays', () => {
  beforeEach(() => {
    state.WEEKS = [{
      n: 2, dates: 'Aug 10-16',
      days: [
        {tag:'Mon - Aug 10', name:'Threshold (shorter)', type:'threshold'},
        {tag:'Wed - Aug 12', name:'VO2max', type:'vo2max'},
        {tag:'Thu - Aug 13', name:'Easy + strides', type:'easy'},
        {tag:'Sat - Aug 15', name:'Long run', type:'long'},
      ],
    }];
    state.recentSaveCache = {};
  });

  it('uses a nearby quality session\'s own ACTUAL date (if it was itself moved), not its planned tag - the exact case that caught the coach doing wrong freehand arithmetic', async () => {
    // Monday's threshold was itself performed on Tuesday instead; this VO2max session
    // (planned Wed) was performed Thursday. The real gap is Tue->Thu = 2 days, not the
    // 1 day you'd get by naively diffing the two PLANNED tags (Mon->Wed minus a day).
    window.storage = {get: vi.fn(async (key) => {
      if(key==='workout-w2-MonAug10') return {value: JSON.stringify({performedOnTag:'Tue - Aug 11'})};
      return null;
    })};
    const performedDate = parseDayTagDate('Thu - Aug 13');
    const gaps = await computeNearbyQualityGapDays(2, 'Wed - Aug 12', performedDate);
    expect(gaps.before).not.toBeNull();
    expect(gaps.before.tag).toBe('Mon - Aug 10');
    expect(gaps.before.gapDays).toBe(2);
  });

  it('finds the nearest quality session after, when one exists later in the week', async () => {
    window.storage = {get: vi.fn().mockResolvedValue(null)};
    const performedDate = parseDayTagDate('Mon - Aug 10');
    const gaps = await computeNearbyQualityGapDays(2, 'Sat - Aug 15', performedDate);
    expect(gaps.after).not.toBeNull();
    expect(gaps.after.tag).toBe('Wed - Aug 12');
    expect(gaps.after.gapDays).toBe(2);
  });

  it('returns before:null/after:null when no other quality session exists nearby', async () => {
    state.WEEKS = [{n:1, dates:'Aug 3-9', days:[{tag:'Wed - Aug 5', name:'Threshold', type:'threshold'}]}];
    window.storage = {get: vi.fn().mockResolvedValue(null)};
    const performedDate = parseDayTagDate('Wed - Aug 5');
    const gaps = await computeNearbyQualityGapDays(1, 'Wed - Aug 5', performedDate);
    expect(gaps.before).toBeNull();
    expect(gaps.after).toBeNull();
  });

  it('returns null entirely when performedDate is falsy', async () => {
    expect(await computeNearbyQualityGapDays(2, 'Wed - Aug 12', null)).toBeNull();
  });
});

describe('weekHasEnded', () => {
  beforeEach(() => { state.WEEKS = []; });

  it('is true for a week whose date range is in the past', () => {
    state.WEEKS = [{n:1, dates:'Jan 1-7'}];
    expect(weekHasEnded(1)).toBe(true);
  });
  it('is false for a week far in the future', () => {
    state.WEEKS = [{n:1, dates:'Dec 24-30'}];
    expect(weekHasEnded(1)).toBe(false);
  });
  it('is true (fail-safe) for a week number that does not exist', () => {
    state.WEEKS = [{n:1, dates:'Aug 3-9'}];
    expect(weekHasEnded(99)).toBe(true);
  });
});
