// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../state.js';
import { MAX_AGE_DAYS, blockFirstWeekStartDate, describeReading, freshReading, isPreBlockReading, isStaleReading, readingAgeDays } from './cache-freshness.js';

const BLOCK_START = new Date('2026-09-14T00:00:00');

beforeEach(() => {
  state.goalConfig = {version:1, blockStartWeekN:7, activeGoals:[]};
  state.WEEKS = [
    {n:6, dates:'Sep 7-13', days:[]},
    {n:7, dates:'Sep 14-20', days:[]},
  ];
});
afterEach(() => { vi.useRealTimers(); });

describe('blockFirstWeekStartDate', () => {
  it('resolves the first TRAINING week, not when the block was drawn up', () => {
    expect(blockFirstWeekStartDate().getTime()).toBe(BLOCK_START.getTime());
  });

  it('is null when no block is configured, which disables the rule rather than guessing', () => {
    state.goalConfig = {version:1, activeGoals:[]};
    expect(blockFirstWeekStartDate()).toBe(null);
  });
});

describe('isPreBlockReading', () => {
  it('retires a reading written before the block began', () => {
    expect(isPreBlockReading('2026-09-13T08:11:10.122Z', BLOCK_START)).toBe(true);
  });

  it('keeps one written after', () => {
    expect(isPreBlockReading('2026-09-14T18:00:00.000Z', BLOCK_START)).toBe(false);
  });

  it('never retires on a missing or unparseable date, or with no block to compare against', () => {
    expect(isPreBlockReading(null, BLOCK_START)).toBe(false);
    expect(isPreBlockReading('not a date', BLOCK_START)).toBe(false);
    expect(isPreBlockReading('2020-01-01T00:00:00.000Z', null)).toBe(false);
  });
});

describe('readingAgeDays', () => {
  it('measures age in days', () => {
    const now = new Date('2026-09-20T12:00:00').getTime();
    expect(readingAgeDays('2026-09-18T12:00:00', now)).toBe(2);
    expect(readingAgeDays(null, now)).toBe(null);
    expect(readingAgeDays('nonsense', now)).toBe(null);
  });
});

describe('isStaleReading', () => {
  const now = new Date('2026-09-25T12:00:00').getTime();

  it('retires anything from before the block, at any age', () => {
    expect(isStaleReading({updatedAt:'2026-09-13T08:00:00'}, {now})).toBe(true);
  });

  it('retires a reading past its surface max age', () => {
    expect(isStaleReading({updatedAt:'2026-09-14T12:00:00'}, {now, maxAgeDays:5})).toBe(true);
    expect(isStaleReading({updatedAt:'2026-09-24T12:00:00'}, {now, maxAgeDays:5})).toBe(false);
  });

  it('applies no age limit when the surface has none', () => {
    expect(isStaleReading({updatedAt:'2026-09-14T12:00:00'}, {now, maxAgeDays:null})).toBe(false);
  });

  it('treats undated content as current - every writer stamps a date, so a missing one predates the rule itself', () => {
    expect(isStaleReading({text:'from before this rule existed'}, {now, maxAgeDays:5})).toBe(false);
  });

  it('treats nothing at all as stale', () => {
    expect(isStaleReading(null, {now})).toBe(true);
  });
});

describe('freshReading (what every caller actually uses)', () => {
  it('hands back the reading or null, by surface', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T12:00:00'));
    const trajectory = {updatedAt:'2026-09-15T12:00:00', headline:'on track'};
    // 15 days old: past the trajectory surface's 14, inside insights' no-limit.
    expect(freshReading(trajectory, 'trajectory')).toBe(null);
    expect(freshReading(trajectory, 'insights')).toBe(trajectory);
    expect(MAX_AGE_DAYS.insights).toBe(null);
  });

  it('retires a pre-block reading on every surface, including the one with no age limit', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T12:00:00'));
    const preBlock = {updatedAt:'2026-09-10T12:00:00', text:'learned last block'};
    expect(freshReading(preBlock, 'insights')).toBe(null);
    expect(freshReading(preBlock, 'trajectory')).toBe(null);
    expect(freshReading(preBlock, 'followups')).toBe(null);
  });
});

describe('describeReading (provenance a reader can actually check)', () => {
  it('states when it was written and what it was looking at', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T12:00:00'));
    expect(describeReading({updatedAt:'2026-09-14T12:00:00', basedOn:'Mon - Sep 14 Easy run'}))
      .toBe('2d ago - after Mon - Sep 14 Easy run');
  });

  it('says nothing rather than something vague when there is no date', () => {
    expect(describeReading({text:'x'})).toBe('');
    expect(describeReading(null)).toBe('');
  });
});
