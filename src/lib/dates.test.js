import { beforeEach, describe, expect, it } from 'vitest';
import { state } from '../state.js';
import {
  calendarWeekKey, dateToTag, getFullWeekDayList, parseDayTagDate,
  parseWeekEndDate, parseWeekStartDate, weekHasEnded,
} from './dates.js';

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
