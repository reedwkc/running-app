// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { PROBE_EVERY, isProbeSession, nextProbeSession, probePaceFromImport, probeSessions, resolveProbePace } from './session-ceiling.js';

describe('probePaceFromImport / resolveProbePace (the watch already knows - nobody retypes it)', () => {
  const lap = (over) => Object.assign({role:'work', avgPaceSec:280, avgHR:170}, over);

  it('reads the LAST work rep, which is the free one', () => {
    const imp = {lapsReliable:true, laps:[lap({role:'warmup'}), lap({avgPaceSec:280}), lap({role:'recovery'}), lap({avgPaceSec:262, avgHR:176}), lap({role:'cooldown'})]};
    const r = probePaceFromImport(imp);
    expect(r.paceSec).toBe(262);
    expect(r.avgHR).toBe(176);
    expect(r.repCount).toBe(2);
  });

  it('prefers the grade-adjusted pace, since a hilly ceiling read means nothing against a flat target', () => {
    const imp = {lapsReliable:true, laps:[lap({avgPaceSec:272, gapPaceSec:259.4})]};
    const r = probePaceFromImport(imp);
    expect(r.paceSec).toBe(259);
    expect(r.graded).toBe(true);
  });

  it('refuses auto-split laps, which are not reps', () => {
    expect(probePaceFromImport({lapsReliable:false, laps:[lap()]})).toBe(null);
  });

  it('returns nothing rather than guessing when there is no import or no work lap', () => {
    expect(probePaceFromImport(null)).toBe(null);
    expect(probePaceFromImport({laps:[]})).toBe(null);
    expect(probePaceFromImport({laps:[lap({role:'warmup'})]})).toBe(null);
  });

  it('lets a typed pace override the machine', () => {
    const obj = {probePace:'4:15', stravaImport:{lapsReliable:true, laps:[lap({avgPaceSec:280})]}};
    const r = resolveProbePace(obj);
    expect(r.paceSec).toBe(255);
    expect(r.source).toBe('typed');
  });

  it('falls back to the import when nothing was typed', () => {
    const r = resolveProbePace({probePace:'', stravaImport:{lapsReliable:true, laps:[lap({avgPaceSec:266})]}});
    expect(r.paceSec).toBe(266);
    expect(r.source).toBe('import');
  });

  it('is null when there is neither', () => {
    expect(resolveProbePace({})).toBe(null);
    expect(resolveProbePace(null)).toBe(null);
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
