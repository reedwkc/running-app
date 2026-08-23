// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { hardSessionRecoveryNote, skipPatternNote } from './progression.js';

describe('skipPatternNote', () => {
  it('returns null when nothing has been skipped or left unlogged', () => {
    const tally = {easy:{completed:5, skipped:0, unlogged:0}, threshold:{completed:3, skipped:0, unlogged:0}};
    expect(skipPatternNote(tally)).toBeNull();
  });

  it('mentions only the session types with a real skip or unlogged gap', () => {
    const tally = {
      easy: {completed:6, skipped:3, unlogged:0},
      threshold: {completed:4, skipped:0, unlogged:0},
    };
    const note = skipPatternNote(tally);
    expect(note).toContain('easy runs: 6/9 completed, 3 skipped');
    expect(note).not.toContain('threshold');
  });

  it('reports never-logged days separately from skips', () => {
    const tally = {long: {completed:1, skipped:0, unlogged:2}};
    const note = skipPatternNote(tally);
    expect(note).toContain('1/3 completed');
    expect(note).toContain('2 never logged');
  });

  it('returns null for an empty tally', () => {
    expect(skipPatternNote({})).toBeNull();
    expect(skipPatternNote(null)).toBeNull();
  });
});

describe('hardSessionRecoveryNote', () => {
  it('returns null when there are too few qualifying sessions to report a rate', () => {
    const tally = {readiness: {dropped:1, total:2}, hrv: {dropped:0, total:1}};
    expect(hardSessionRecoveryNote(tally)).toBeNull();
  });

  it('reports a metric once it has enough qualifying sessions', () => {
    const tally = {readiness: {dropped:4, total:5}, hrv: {dropped:0, total:1}};
    const note = hardSessionRecoveryNote(tally);
    expect(note).toContain('training readiness dropped meaningfully below its trailing baseline the day after a hard session 4 of 5 times');
    expect(note).not.toContain('HRV');
  });

  it('returns null for an empty tally', () => {
    expect(hardSessionRecoveryNote({})).toBeNull();
    expect(hardSessionRecoveryNote(null)).toBeNull();
  });
});
