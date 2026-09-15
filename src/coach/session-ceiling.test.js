// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { PROBE_EVERY, RESERVE_MIN_POINTS, RESERVE_OPTIONS, describeReserve, interpretReserveTrend, isProbeSession, nextProbeSession, probeSessions, reserveNumeric } from './session-ceiling.js';

describe('reserve scale', () => {
  it('is ordinal, spanning both directions of the question', () => {
    expect(RESERVE_OPTIONS.map(o=>o.n)).toEqual([-1, 0, 1, 2]);
    expect(reserveNumeric('eased')).toBe(-1);
    expect(reserveNumeric('twoPlus')).toBe(2);
    expect(reserveNumeric('nonsense')).toBe(null);
    expect(describeReserve('limit')).toContain('limit');
    expect(describeReserve('nonsense')).toBe('');
  });
});

describe('interpretReserveTrend', () => {
  const pts = (...vals) => vals.map(v=>({value:v}));

  it('says nothing at all from one or two sessions', () => {
    expect(interpretReserveTrend(pts(2, 2)).status).toBe('insufficient');
    expect(interpretReserveTrend([]).status).toBe('insufficient');
    expect(RESERVE_MIN_POINTS).toBe(3);
  });

  it('flags a target set too fast when every recent session had to ease off', () => {
    const r = interpretReserveTrend(pts(0, -1, -1, -1));
    expect(r.status).toBe('overreaching');
    expect(r.note).toContain('too fast');
  });

  it('flags a target leaving capacity unused', () => {
    expect(interpretReserveTrend(pts(0, 2, 2, 2)).status).toBe('undershooting');
  });

  it('reads a real rise as improvement, and a real fall as cost', () => {
    expect(interpretReserveTrend(pts(0, 0, 0, 1, 1, 1)).status).toBe('improving');
    expect(interpretReserveTrend(pts(2, 2, 2, 1, 0, 0)).status).toBe('declining');
  });

  it('holds steady rather than reading noise as a trend', () => {
    expect(interpretReserveTrend(pts(1, 0, 1, 1, 0, 1)).status).toBe('steady');
  });

  it('ignores junk points', () => {
    expect(interpretReserveTrend([{value:null},{value:1},{value:1},{value:1}]).status).not.toBe('insufficient');
  });
});

describe('probe scheduling', () => {
  const week = (n, opts={}) => ({
    n, dates:'wk'+n, cutback: !!opts.cutback,
    days: (opts.days || [{tag:'Wed - x', type:'threshold', name:'Threshold', data:{main:{reps:5}}}]),
  });

  it('marks every fourth threshold session, not the first', () => {
    const weeks = [1,2,3,4,5,6,7,8].map(n=>week(n));
    const probes = probeSessions(weeks);
    expect(probes.map(p=>p.weekN)).toEqual([4, 8]);
    expect(PROBE_EVERY).toBe(4);
  });

  it('counts sessions, not weeks - a week with two threshold days advances the count twice', () => {
    const weeks = [
      week(1, {days:[{tag:'Mon - x', type:'threshold', data:{main:{reps:4}}}, {tag:'Thu - x', type:'threshold', data:{main:{reps:4}}}]}),
      week(2, {days:[{tag:'Mon - x', type:'threshold', data:{main:{reps:4}}}, {tag:'Thu - x', type:'threshold', data:{main:{reps:4}}}]}),
    ];
    expect(probeSessions(weeks)).toEqual([{weekN:2, dayTag:'Thu - x', name:undefined}]);
  });

  it('never lands a maximal rep in a cutback or race week - it carries to the next session', () => {
    const weeks = [week(1), week(2), week(3), week(4, {cutback:true}), week(5), week(6)];
    const probes = probeSessions(weeks);
    expect(probes.map(p=>p.weekN)).toEqual([5]); // w4 skipped entirely, so the 4th eligible is w5
    const withRace = [week(1), week(2), week(3), week(4, {days:[{tag:'Sat - x', type:'race'}, {tag:'Wed - x', type:'threshold', data:{main:{reps:5}}}]}), week(5)];
    expect(probeSessions(withRace).map(p=>p.weekN)).toEqual([5]);
  });

  it('ignores weeks before the block start', () => {
    const weeks = [week(1), week(2), week(3), week(4), week(5), week(6), week(7), week(8)];
    expect(probeSessions(weeks, {blockStartN:5}).map(p=>p.weekN)).toEqual([8]);
  });

  it('answers the per-session question the card asks', () => {
    const weeks = [1,2,3,4].map(n=>week(n));
    expect(isProbeSession(weeks, 4, 'Wed - x')).toBe(true);
    expect(isProbeSession(weeks, 3, 'Wed - x')).toBe(false);
    expect(isProbeSession(weeks, 4, 'Mon - x')).toBe(false);
  });

  it('finds the next probe from a given week', () => {
    const weeks = [1,2,3,4,5,6,7,8].map(n=>week(n));
    expect(nextProbeSession(weeks, {afterWeekN:5}).weekN).toBe(8);
    expect(nextProbeSession(weeks, {afterWeekN:9})).toBe(null);
  });

  it('never probes a session that has no last rep to free, or one that is already maximal', () => {
    const weeks = [
      week(1, {days:[{tag:'Wed - x', type:'threshold', name:'Continuous tempo', data:{style:'continuous', main:{reps:1}}}]}),
      week(2, {days:[{tag:'Wed - x', type:'threshold', name:'5K Time Trial', data:{main:{reps:1}}}]}),
      week(3, {days:[{tag:'Wed - x', type:'threshold', name:'10K Time Trial', data:{main:{reps:4}}}]}), // named, even with reps
      week(4), week(5), week(6), week(7),
    ];
    const probes = probeSessions(weeks);
    // Only the plain rep sessions count toward the every-fourth tally, so the first probe
    // lands on the 4th of those (w7), not the 4th week.
    expect(probes.map(p=>p.weekN)).toEqual([7]);
  });

  it('survives an empty or malformed plan', () => {
    expect(probeSessions(null)).toEqual([]);
    expect(probeSessions([{n:1}, null])).toEqual([]);
  });
});
