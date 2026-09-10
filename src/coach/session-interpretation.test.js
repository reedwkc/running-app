import { describe, expect, it } from 'vitest';
import { interpretSession, judgeLap, matchWorkLaps, parseZoneBand, TARGET_MODE } from './session-interpretation.js';

// The live zone table, so these read against the same numbers the app actually shows.
const Z = {
  S1:{pace:379, hr:'113-139'}, S2:{pace:334, hr:'139-155'}, S3:{pace:303, hr:'155-165'},
  S4:{pace:278, hr:'165-174'}, S5:{pace:260, hr:'174+'},   GOAL:{pace:256, hr:'165-177'}
};
const workLap = (paceSec, hr) => ({role:'work', avgPaceSec:paceSec, avgHR:hr});

describe('parseZoneBand', () => {
  it('keeps an open-ended zone open rather than rejecting it', () => {
    expect(parseZoneBand('165-174')).toEqual({lo:165, hi:174});
    expect(parseZoneBand('174+')).toEqual({lo:174, hi:null});
    expect(parseZoneBand('n/a')).toBeNull();
  });
});

describe('a progressive long run', () => {
  // The bug this module was written for: 15km S2 base + 7km S3 finish, both judged against
  // the FASTEST segment, so a correctly-run base reported as 30s/km slow with HR below zone.
  const day = {type:'long', zone:'S2', name:'Long run', data:{segments:[{km:15,zone:'S2'},{km:7,zone:'S3'}]}};

  it('gives each segment its own expectation instead of one session-wide target', () => {
    const interp = interpretSession(day, Z, 'outdoor');
    expect(interp.structure).toBe('multi-zone');
    expect(interp.segments).toHaveLength(2);
    expect(interp.segments[0]).toMatchObject({zone:'S2', mode:TARGET_MODE.CEILING});
    expect(interp.segments[1]).toMatchObject({zone:'S3', mode:TARGET_MODE.PACE});
  });

  it('reads a correctly-run base as correct, not as 30s/km slow', () => {
    const interp = interpretSession(day, Z, 'outdoor');
    const laps = [workLap(336, 148), workLap(304, 161)]; // base honest at S2, finish on S3
    const m = matchWorkLaps(interp, laps);
    expect(m.unmatchedReason).toBeNull();
    const base = judgeLap(m.matched[0].lap, m.matched[0].expectation);
    const finish = judgeLap(m.matched[1].lap, m.matched[1].expectation);
    expect(base.paceText).toBe('under ceiling');
    expect(base.paceStatus).toBe('ok');
    expect(base.hrText).toBeNull();        // in its own S2 band - nothing to say
    expect(finish.paceText).toBe('on target');
  });

  it('still flags a base run too fast, which is the one real way to get it wrong', () => {
    const interp = interpretSession(day, Z, 'outdoor');
    const v = judgeLap(workLap(310, 158), interp.segments[0]);
    expect(v.paceText).toBe('24s/km over ceiling');
    expect(v.paceStatus).toBe('bad');
    expect(v.hrText).toContain('above zone');
  });

  // Refusing to guess is the point. Judging segment 2 against segment 1's target would be a
  // confident wrong answer, which is worse than a blank column.
  it('refuses to match up when the segments run do not match the segments prescribed', () => {
    const interp = interpretSession(day, Z, 'outdoor');
    const m = matchWorkLaps(interp, [workLap(336,148), workLap(320,155), workLap(304,161)]);
    expect(m.unmatchedReason).toContain('3 segments were run against 2 prescribed');
    expect(m.matched.every(x => x.expectation === null)).toBe(true);
    expect(m.countDelta).toBe(1);
  });
});

describe('a time trial', () => {
  const tt = {type:'threshold', zone:'S4', name:'10K Time Trial', data:{main:{reps:1}}};

  it('is never judged against training zones', () => {
    const interp = interpretSession(tt, Z, 'outdoor');
    expect(interp.maximalTest).toBe(true);
    expect(interp.workExpectation).toBeNull();
    // Run at 4:23/km and 180bpm - way past threshold pace and over the S4 ceiling, which is
    // the intent of a maximal test, and previously rendered as "17s/km faster · HR above zone".
    const m = matchWorkLaps(interp, [workLap(263, 180)]);
    expect(m.matched[0].expectation).toBeNull();
    expect(judgeLap(m.matched[0].lap, m.matched[0].expectation).paceText).toBeNull();
  });

  it('treats a race the same way', () => {
    expect(interpretSession({type:'race', zone:'GOAL', name:'Half Marathon', data:{km:21.1}}, Z, 'outdoor').maximalTest).toBe(true);
  });
});

describe('VO2max reps', () => {
  const day = {type:'vo2max', zone:'S5', name:'VO2max', data:{main:{reps:5}}};

  it('never flags HR as too high, because the zone has no ceiling', () => {
    const interp = interpretSession(day, Z, 'outdoor');
    expect(interp.workExpectation.hrHi).toBeNull();
    const v = judgeLap(workLap(260, 190), interp.workExpectation);
    expect(v.hrText).toBeNull();
    expect(v.paceText).toBe('on target');
  });

  // The question this answers: "what if HR stays too low on a VO2max workout?" Hitting the
  // paces while HR never reaches the zone means the stimulus was missed - and it is the only
  // HR verdict this session type can produce.
  it('flags HR that never reached the zone, which is the only HR finding it can have', () => {
    const interp = interpretSession(day, Z, 'outdoor');
    const v = judgeLap(workLap(260, 162), interp.workExpectation);
    expect(v.paceText).toBe('on target');
    expect(v.hrText).toContain('12bpm below zone - never reached it');
    expect(v.hrStatus).toBe('bad');
  });
});

describe('threshold reps', () => {
  const day = {type:'threshold', zone:'S4', name:'Threshold', data:{main:{reps:4}}};

  it('reads HR in both directions at target pace', () => {
    const interp = interpretSession(day, Z, 'outdoor');
    expect(judgeLap(workLap(280, 177), interp.workExpectation).hrText).toContain('3bpm above zone');
    expect(judgeLap(workLap(280, 177), interp.workExpectation).hrStatus).toBe('bad');
    expect(judgeLap(workLap(280, 160), interp.workExpectation).hrText).toContain('5bpm below zone - never reached it');
    expect(judgeLap(workLap(280, 170), interp.workExpectation).hrText).toBeNull();
  });

  // Doing more or fewer reps than prescribed is a fact worth reporting, but it does not
  // prevent the comparison - every rep in a set shares one expectation, so there is no
  // ambiguity about what each should be measured against.
  it('reports a rep-count difference without refusing to judge', () => {
    const interp = interpretSession(day, Z, 'outdoor');
    expect(matchWorkLaps(interp, [workLap(280,170), workLap(280,170)]).countDelta).toBe(-2);
    const more = matchWorkLaps(interp, [1,2,3,4,5,6].map(()=>workLap(280,170)));
    expect(more.countDelta).toBe(2);
    expect(more.unmatchedReason).toBeNull();
    expect(more.matched.every(x => x.expectation !== null)).toBe(true);
  });
});

describe('hill and fartlek sessions', () => {
  const hill = {type:'vo2max', zone:'S4', name:'Hill repeats', data:{style:'hill', main:{reps:8}}};

  it('judge HR in both directions, since HR is the only evidence they have', () => {
    const interp = interpretSession(hill, Z, 'outdoor');
    expect(interp.workExpectation.mode).toBe(TARGET_MODE.EFFORT);
    expect(interp.workExpectation.paceSec).toBeNull();
    const v = judgeLap({role:'work', avgPaceSec:250, avgHR:170}, interp.workExpectation);
    expect(v.paceText).toBeNull();          // a hill pace means nothing - never judged
    expect(v.hrText).toContain('in zone');
  });
});

describe('easy runs and the treadmill', () => {
  it('treat the easy pace as a one-sided ceiling', () => {
    const interp = interpretSession({type:'easy', zone:'S2', name:'Easy run', data:{km:9}}, Z, 'outdoor');
    expect(interp.workExpectation.mode).toBe(TARGET_MODE.CEILING);
    expect(judgeLap(workLap(400, 132), interp.workExpectation).paceText).toBe('under ceiling');
    expect(judgeLap(workLap(310, 150), interp.workExpectation).paceText).toBe('24s/km over ceiling');
  });

  it('judge no pace at all on a treadmill, whatever the session type', () => {
    const interp = interpretSession({type:'threshold', zone:'S4', name:'Threshold', data:{main:{reps:4}}}, Z, 'treadmill');
    expect(judgeLap(workLap(300, 170), interp.workExpectation).paceText).toBeNull();
  });
});
