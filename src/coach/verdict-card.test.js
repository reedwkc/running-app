import { describe, expect, it } from 'vitest';
import { isCardVerdict, orderCardVerdicts } from './verdict-card.js';

const v = (over) => Object.assign({ kind: 'workout', text: 'read', date: '2026-09-10T18:00:00.000Z' }, over);

describe('isCardVerdict', () => {
  it('only lets performed workouts onto the card', () => {
    expect(isCardVerdict(v({ kind: 'workout' }))).toBe(true);
    expect(isCardVerdict(v({ kind: 'freeworkout' }))).toBe(true);
    ['skip', 'profile', 'metrics', 'goalset', 'rebuild'].forEach(kind => {
      expect(isCardVerdict(v({ kind }))).toBe(false);
    });
    expect(isCardVerdict(null)).toBe(false);
    expect(isCardVerdict(v({ text: '' }))).toBe(false);
  });
});

describe('orderCardVerdicts', () => {
  it('a skip logged after today\'s run does not displace the run', () => {
    const run = v({ sessionKey: 'w-10-Thu', eventDate: '2026-09-10T06:00:00.000Z', date: '2026-09-10T18:00:00.000Z' });
    const skip = v({ kind: 'skip', sessionKey: 'w-10-Wed', date: '2026-09-10T18:05:00.000Z' });
    expect(orderCardVerdicts([skip, run])[0]).toBe(run);
  });

  it('orders by when the workout was done, not when it was logged', () => {
    const today = v({ sessionKey: 'w-10-Thu', eventDate: '2026-09-10T06:00:00.000Z', date: '2026-09-10T08:00:00.000Z' });
    const backfilled = v({ sessionKey: 'w-10-Mon', eventDate: '2026-09-07T06:00:00.000Z', date: '2026-09-10T20:00:00.000Z' });
    expect(orderCardVerdicts([backfilled, today])).toEqual([today, backfilled]);
  });

  it('within one day, the most recently logged wins (noon placeholders are not real times)', () => {
    const morningRun = v({ sessionKey: 'w-10-Thu', eventDate: '2026-09-10T05:00:00.000Z', date: '2026-09-10T19:00:00.000Z' });
    const noonPlaceholderExtra = v({ kind: 'freeworkout', eventDate: '2026-09-10T10:00:00.000Z', date: '2026-09-10T08:00:00.000Z' });
    expect(orderCardVerdicts([noonPlaceholderExtra, morningRun])[0]).toBe(morningRun);
  });

  it('a re-saved session replaces its own earlier verdict instead of becoming the "previous" one', () => {
    const first = v({ sessionKey: 'w-10-Thu', text: 'first read', eventDate: '2026-09-10T06:00:00.000Z', date: '2026-09-10T08:00:00.000Z' });
    const resaved = v({ sessionKey: 'w-10-Thu', text: 'corrected read', eventDate: '2026-09-10T06:00:00.000Z', date: '2026-09-10T09:00:00.000Z' });
    const older = v({ sessionKey: 'w-10-Tue', eventDate: '2026-09-08T06:00:00.000Z', date: '2026-09-08T08:00:00.000Z' });
    expect(orderCardVerdicts([first, older, resaved])).toEqual([resaved, older]);
  });

  it('legacy verdicts with no eventDate fall back to when they were written', () => {
    const legacy = v({ date: '2026-09-08T08:00:00.000Z' });
    const fresh = v({ sessionKey: 'w-10-Thu', eventDate: '2026-09-10T06:00:00.000Z', date: '2026-09-10T08:00:00.000Z' });
    expect(orderCardVerdicts([legacy, fresh])).toEqual([fresh, legacy]);
  });

  it('respects the limit and tolerates junk', () => {
    const a = v({ sessionKey: 'a', eventDate: '2026-09-10T06:00:00.000Z' });
    const b = v({ sessionKey: 'b', eventDate: '2026-09-09T06:00:00.000Z' });
    expect(orderCardVerdicts([null, a, undefined, b], 1)).toEqual([a]);
    expect(orderCardVerdicts(null)).toEqual([]);
  });
});
