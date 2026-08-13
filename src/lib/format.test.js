import { describe, expect, it } from 'vitest';
import {
  distTime, formatMinutesToClock, fmtDuration, fmtDuration5, fmtHoursMinutes, fmtPace,
  fmtSecondsLong, fmtTime, fmtTime5, paceToKmh, parseDurationToMinutes, parsePaceLabelToSec,
  parseTime, timeAgo,
} from './format.js';

describe('fmtTime', () => {
  it('formats seconds as m:ss', () => {
    expect(fmtTime(275)).toBe('4:35');
    expect(fmtTime(65)).toBe('1:05');
    expect(fmtTime(0)).toBe('0:00');
  });
  it('rounds fractional seconds', () => {
    expect(fmtTime(65.6)).toBe('1:06');
  });
});

describe('fmtDuration5 / fmtTime5', () => {
  it('rounds to the nearest 5 minutes / 5 seconds', () => {
    expect(fmtDuration5(1810)).toBe(fmtTime(1800)); // 30:10 -> 30:00
    expect(fmtDuration5(1830)).toBe(fmtTime(1800)); // 30:30 -> 30:00 (round-half-to-even-ish, Math.round(6.1)=6)
    expect(fmtTime5(63)).toBe('1:05'); // 63 -> nearest 5 = 65
  });
  it('switches to "N hour(s) M minutes" at 60 minutes or more', () => {
    expect(fmtDuration5(3600)).toBe('1 hour');
    expect(fmtDuration5(6000)).toBe('1 hour 40 minutes'); // 100:00 -> 1h40m
  });
});

describe('fmtHoursMinutes', () => {
  it('stays as plain m:ss under an hour', () => {
    expect(fmtHoursMinutes(1810)).toBe('30:10');
  });
  it('formats as "N hour(s) M minutes" at an hour or more, no rounding to 5', () => {
    expect(fmtHoursMinutes(3600)).toBe('1 hour');
    expect(fmtHoursMinutes(5732)).toBe('1 hour 36 minutes'); // 95:32 rounds to 96min -> 1h36m
    expect(fmtHoursMinutes(7500)).toBe('2 hours 5 minutes');
  });
});

describe('fmtSecondsLong', () => {
  it('stays as "Ns" under a minute', () => {
    expect(fmtSecondsLong(45)).toBe('45s');
  });
  it('formats as "N minute(s) M seconds" at 60 seconds or more', () => {
    expect(fmtSecondsLong(90)).toBe('1 minute 30 seconds');
    expect(fmtSecondsLong(60)).toBe('1 minute');
    expect(fmtSecondsLong(180)).toBe('3 minutes');
  });
});

describe('fmtDuration', () => {
  it('omits hours when under 60 minutes', () => {
    expect(fmtDuration(125)).toBe('2m 05s');
  });
  it('includes hours when at or over 60 minutes', () => {
    expect(fmtDuration(3725)).toBe('1h 02m 05s');
  });
});

describe('fmtPace', () => {
  it('rounds to the nearest 5 seconds and appends /km', () => {
    expect(fmtPace(273)).toBe('4:35/km');
  });
});

describe('paceToKmh', () => {
  it('converts sec/km pace to km/h', () => {
    expect(paceToKmh(300)).toBe('12.0');
    expect(paceToKmh(240)).toBe('15.0');
  });
});

describe('distTime', () => {
  it('multiplies distance by pace', () => {
    expect(distTime(5, 300)).toBe(1500);
  });
});

describe('parsePaceLabelToSec', () => {
  it('parses an m:ss pace label', () => {
    expect(parsePaceLabelToSec('4:35/km')).toBe(275);
  });
  it('returns null for missing or unparseable input', () => {
    expect(parsePaceLabelToSec(null)).toBeNull();
    expect(parsePaceLabelToSec('')).toBeNull();
    expect(parsePaceLabelToSec('not a pace')).toBeNull();
  });
});

describe('parseDurationToMinutes', () => {
  it('parses h:mm:ss and mm:ss into minutes', () => {
    expect(parseDurationToMinutes('1:15:30')).toBe('75.50');
    expect(parseDurationToMinutes('45:00')).toBe('45.00');
  });
  it('passes through a plain number of minutes', () => {
    expect(parseDurationToMinutes('42.5')).toBe('42.5');
  });
  it('returns empty string for empty/unparseable input', () => {
    expect(parseDurationToMinutes('')).toBe('');
    expect(parseDurationToMinutes('abc:def')).toBe('');
  });
});

describe('formatMinutesToClock', () => {
  it('formats minutes under an hour as m:ss', () => {
    expect(formatMinutesToClock(45)).toBe('45:00');
  });
  it('formats an hour or more as h:mm:ss', () => {
    expect(formatMinutesToClock(75.5)).toBe('1:15:30');
  });
  it('returns empty string for missing input', () => {
    expect(formatMinutesToClock(undefined)).toBe('');
    expect(formatMinutesToClock(null)).toBe('');
    expect(formatMinutesToClock('')).toBe('');
  });
  it('round-trips with parseDurationToMinutes', () => {
    const mins = parseDurationToMinutes('1:15:30');
    expect(formatMinutesToClock(mins)).toBe('1:15:30');
  });
});

describe('parseTime', () => {
  it('parses mm:ss into seconds', () => {
    expect(parseTime('4:35')).toBe(275);
  });
});

describe('timeAgo', () => {
  it('says "today" for a timestamp from earlier the same calendar day', () => {
    const now = new Date();
    const earlierToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 1, 0).toISOString();
    expect(timeAgo(earlierToday)).toMatch(/^today at /);
  });
  it('says "yesterday" for a timestamp exactly one calendar day back', () => {
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate()-1, 12, 0).toISOString();
    expect(timeAgo(yesterday)).toMatch(/^yesterday at /);
  });
  it('gives a "Nd ago" count for 2-6 days back', () => {
    const now = new Date();
    const threeDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate()-3, 12, 0).toISOString();
    expect(timeAgo(threeDaysAgo)).toBe('3d ago');
  });
});
