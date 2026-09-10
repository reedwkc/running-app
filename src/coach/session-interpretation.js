import { fmtPace } from '../lib/format.js';

// ONE canonical answer to "what was this session asking for, and how should the result be
// read" - for every session type, in one place.
//
// This module exists because that answer was previously restated independently in about six
// places (the card's target line, the session tip text, the Strava target cache, the
// vs-Target column, the trend gating, and the coach's tier-estimate instructions). Nothing
// derived from anything else, so they drifted, and the drift produced exactly the kind of
// confident-but-wrong interpretation that is worse than no interpretation at all:
//
//   - a progressive long run's Zone 2 base was judged against the FASTEST segment's pace and
//     HR band, because the target cache could only hold one pace and one HR for a whole
//     session. A correctly-run 15km base under a 7km S3 finish reported as "30s/km slower"
//     and "HR below zone" - a correct session displayed as a failed one.
//   - a time trial was judged against threshold pace and the S4 HR band, so a maximal test
//     (the entire point of which is to exceed both) reported as running too hard.
//   - a VO2max rep could not be judged by HR at all, in either direction, because its zone
//     is open-ended ("174+") - so "hit the paces but HR never got near VO2max", which is a
//     real and useful signal, was invisible.
//
// The principle throughout: an expectation is per-SEGMENT, not per-session, and when the
// prescribed segments cannot be confidently matched to what was actually run, this returns
// "unmatched" rather than guessing. Silence is a correct answer; a wrong verdict is not.

/** How the runner was asked to govern a segment. */
export const TARGET_MODE = {
  PACE: 'pace',         // hit this pace; HR is the secondary check
  CEILING: 'ceiling',   // stay at or under this pace; HR is the actual target
  EFFORT: 'effort',     // no pace target exists (hills, fartlek, time trials)
};

// A time trial is a measurement, not a prescription. Nothing about it should be judged
// against a training zone: exceeding threshold pace and threshold HR is the intent, and
// flagging either as a deviation actively misreads the session. Its result is evidence,
// which is a different thing from adherence.
export function isMaximalTest(day){
  return !!(day && typeof day.name === 'string' && /time trial/i.test(day.name)) || (day && day.type === 'race');
}

// "165-174" -> {lo:165, hi:174}; "174+" -> {lo:174, hi:null}; anything else -> null.
// The open-ended form is not a parse failure - it is the VO2max zone, and its missing ceiling
// is meaningful: HR is SUPPOSED to climb across a VO2max set, so there is nothing to overshoot.
export function parseZoneBand(hrText){
  const s = String(hrText || '').trim();
  const closed = s.match(/^(\d+)\s*[^\d+]+\s*(\d+)$/);
  if(closed){
    const lo = parseInt(closed[1]), hi = parseInt(closed[2]);
    return hi > lo ? {lo, hi} : null;
  }
  const open = s.match(/^(\d+)\s*\+$/);
  if(open) return {lo: parseInt(open[1]), hi: null};
  return null;
}

function expectation(zone, Z, mode, opts){
  const z = (Z || {})[zone];
  if(!z) return null;
  const band = parseZoneBand(z.hr);
  return Object.assign({
    zone,
    mode,
    paceSec: z.pace != null ? z.pace : null,
    paceLabel: z.pace != null ? fmtPace(z.pace) : '',
    hrLo: band ? band.lo : null,
    hrHi: band ? band.hi : null,
    // Whether HR landing outside the band is worth saying anything about, per side.
    // Above the ceiling always matters - it means the session ran harder than intended.
    // Below the floor only matters where REACHING the zone is the point of the session:
    // on a threshold or VO2max rep it means the stimulus was missed, while on an easy run
    // or a Z2 long-run base it just means the run was comfortable, which is correct.
    flagAbove: true,
    flagBelow: false,
  }, opts || {});
}

/**
 * The canonical reading of a planned day.
 *
 * Returns {maximalTest, structure, segments, workExpectation, prescribedWorkCount, note}:
 *  - segments: ordered per-segment expectations, for sessions whose parts differ from each
 *    other (a progressive long run). Work laps map to these IN ORDER.
 *  - workExpectation: the single expectation shared by every work rep, for sessions whose
 *    parts are all alike (interval sets, easy runs).
 * Exactly one of the two is populated, so a consumer can never silently apply the wrong one.
 */
export function interpretSession(day, Z, effectiveMode){
  if(!day) return null;

  // On a treadmill HR governs every session type without exception - a belt's displayed
  // speed drifts from true effort - so no pace expectation is emitted at all rather than one
  // that would be judged and shouldn't be.
  if(effectiveMode === 'treadmill'){
    return {
      maximalTest: isMaximalTest(day), structure: 'treadmill', segments: null,
      workExpectation: expectation(day.zone, Z, TARGET_MODE.EFFORT, {flagAbove: false, flagBelow: false}),
      prescribedWorkCount: null,
      note: 'Treadmill: HR governs, belt speed is a starting point only - pace is not judged.'
    };
  }

  if(isMaximalTest(day)){
    return {
      maximalTest: true, structure: 'maximal-test', segments: null, workExpectation: null,
      prescribedWorkCount: 1,
      note: 'A maximal test. Exceeding training-zone pace and HR is the intent, not a deviation - the result is evidence about fitness, and nothing here should be judged for adherence.'
    };
  }

  if(day.type === 'easy'){
    return {
      maximalTest: false, structure: 'continuous', segments: null,
      workExpectation: expectation('S2', Z, TARGET_MODE.CEILING),
      prescribedWorkCount: 1,
      note: 'Zone 2, governed by HR. The pace is a ceiling: at or under it is correct at any margin, only exceeding it is a finding.'
    };
  }

  if(day.type === 'long'){
    const segs = (day.data && Array.isArray(day.data.segments)) ? day.data.segments : [];
    if(!segs.length) return null;
    return {
      maximalTest: false,
      structure: segs.length > 1 ? 'multi-zone' : 'continuous',
      segments: segs.map(s => {
        const isBase = s.zone === 'S2' || s.zone === 'S1';
        return Object.assign(
          expectation(s.zone, Z, isBase ? TARGET_MODE.CEILING : TARGET_MODE.PACE) || {zone: s.zone, mode: TARGET_MODE.EFFORT},
          {km: s.km}
        );
      }),
      workExpectation: null,
      prescribedWorkCount: segs.length,
      note: segs.length > 1
        ? 'Each segment carries its own expectation and they are NOT interchangeable - the Zone 2 base is a pace ceiling governed by HR, the faster segments are real pace targets. Judge each against its own, in order.'
        : 'Zone 2 aerobic volume, governed by HR. The pace is a ceiling, not a target.'
    };
  }

  if(day.type === 'threshold' || day.type === 'vo2max'){
    const style = day.data && day.data.style;
    // Hill repeats and fartlek deliberately carry no pace target - gradient varies on a hill,
    // and a fartlek is unstructured by design. plan.js leaves main.paceSpk null for both
    // rather than fabricating a number, and that must not be quietly filled in here.
    if(style === 'hill' || style === 'fartlek'){
      return {
        maximalTest: false, structure: 'reps', segments: null,
        // No pace, but HR is judged in BOTH directions here - with no pace target it is the
        // only evidence the session has, so staying silent about it would leave these reps
        // with no verdict at all (a real, previously-reported bug).
        workExpectation: expectation(day.zone, Z, TARGET_MODE.EFFORT, {paceSec: null, paceLabel: '', flagBelow: true}),
        prescribedWorkCount: (day.data && day.data.main && day.data.main.reps) || null,
        note: 'Effort-governed by design - gradient or unstructured surging makes a pace target meaningless here, so HR is the only evidence and is read in both directions.'
      };
    }
    const isVo2 = day.type === 'vo2max';
    return {
      maximalTest: false, structure: 'reps', segments: null,
      // flagBelow is the half that was missing: on a quality rep, REACHING the zone is the
      // stimulus, so HR under the floor is as real a finding as HR over the ceiling. It is
      // the only HR finding available on a VO2max rep at all, whose zone has no ceiling.
      workExpectation: expectation(day.zone, Z, TARGET_MODE.PACE, {flagBelow: true}),
      prescribedWorkCount: (day.data && day.data.main && day.data.main.reps) || null,
      note: isVo2
        ? 'VO2max reps: pace is the target. HR lags 60-90s into each rep and climbs across the set, so a high reading late is expected and is not a finding - the zone has no ceiling. HR failing to REACH the zone floor across the set is the finding, and means the stimulus was missed.'
        : 'Threshold reps: pace is the target, HR is the check in both directions - above the ceiling means the session ran harder than threshold, below the floor means it never reached it.'
    };
  }

  if(day.type === 'race'){
    return {
      maximalTest: true, structure: 'maximal-test', segments: null, workExpectation: null,
      prescribedWorkCount: 1,
      note: 'A race. The result is the evidence; training zones do not apply.'
    };
  }

  return null;
}

/**
 * Rebuild an interpretation from the older flat {pace, hr, paceCeiling} target shape.
 *
 * Any caller that hasn't been given a full interpretation still gets a correct one rather
 * than an empty verdict column - a stored import re-rendered from an older log, a test, or
 * any future call site that forgets. Requiring the rich shape everywhere would mean a single
 * missed hand-off silently blanks the comparison, which is precisely the class of quiet
 * breakage this module was written to end.
 */
export function interpretFromLegacyTarget(target){
  if(!target || (!target.pace && !target.hr && !target.paceCeiling)) return null;
  const band = parseZoneBand(target.hr);
  const paceLabel = target.paceCeiling || target.pace || '';
  const m = String(paceLabel).match(/^(\d+):(\d\d)/);
  const paceSec = m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null;
  const mode = target.paceCeiling ? TARGET_MODE.CEILING : (paceSec != null ? TARGET_MODE.PACE : TARGET_MODE.EFFORT);
  return {
    maximalTest: false, structure: 'legacy', segments: null, prescribedWorkCount: null,
    workExpectation: {
      zone: null, mode, paceSec: mode === TARGET_MODE.EFFORT ? null : paceSec, paceLabel,
      hrLo: band ? band.lo : null, hrHi: band ? band.hi : null,
      // No session type is known here, so the floor is only flagged where HR is the sole
      // evidence - guessing "this rep should have reached the zone" without knowing whether
      // it was a quality session would invent findings.
      flagAbove: true, flagBelow: mode === TARGET_MODE.EFFORT,
    },
    note: 'Reconstructed from a stored target without full session context.'
  };
}

/**
 * Map the work laps actually run onto the prescribed expectations.
 *
 * The honest-failure case is the whole point: on a multi-zone session whose prescribed
 * segment count does not match the work laps found, this returns every lap unmatched with a
 * reason, rather than pairing them up positionally and producing confident nonsense. A
 * segment judged against the wrong segment's target is worse than a blank column.
 *
 * Single-expectation sessions (interval sets, easy runs) have no such ambiguity - every work
 * rep shares one expectation - so a rep count that differs from the prescription is reported
 * as a fact (countDelta) without preventing the comparison.
 */
export function matchWorkLaps(interp, workLaps){
  const laps = Array.isArray(workLaps) ? workLaps : [];
  if(!interp || !laps.length) return {matched: [], unmatchedReason: null, countDelta: null};

  if(interp.maximalTest){
    return {matched: laps.map(l => ({lap: l, expectation: null})), unmatchedReason: 'maximal test - not judged against zones', countDelta: null};
  }

  if(interp.segments){
    if(interp.segments.length !== laps.length){
      return {
        matched: laps.map(l => ({lap: l, expectation: null})),
        unmatchedReason: laps.length + ' segments were run against ' + interp.segments.length + ' prescribed - not matched up, because judging a segment against the wrong segment\'s target is worse than saying nothing',
        countDelta: laps.length - interp.segments.length
      };
    }
    return {matched: laps.map((l, i) => ({lap: l, expectation: interp.segments[i]})), unmatchedReason: null, countDelta: 0};
  }

  const countDelta = interp.prescribedWorkCount != null ? (laps.length - interp.prescribedWorkCount) : null;
  return {matched: laps.map(l => ({lap: l, expectation: interp.workExpectation})), unmatchedReason: null, countDelta};
}

/**
 * The same reading, written out for the coach.
 *
 * The point is that the coach and the on-screen table are now answering from ONE source. Two
 * separately-maintained readings of the same session is how the app ended up telling the
 * runner "under ceiling" in a table while the coach called the identical segment slow - and
 * a runner who is shown two verdicts for one run has no way to know which to believe.
 */
export function describeInterpretationForPrompt(interp, workLaps){
  if(!interp) return '';
  const laps = Array.isArray(workLaps) ? workLaps : [];

  if(interp.maximalTest){
    return ' HOW TO READ THIS SESSION: ' + interp.note +
      ' Do not describe exceeding threshold pace or the threshold HR band as running too hard, going out too fast, or any kind of deviation - that is what a maximal effort IS, and saying otherwise misreads the session entirely. Judge the RESULT: what time/pace was actually produced, and what that implies about current fitness.';
  }

  if(interp.segments){
    const segText = interp.segments.map((s, i) => {
      const band = s.hrLo != null ? (s.hrHi != null ? (s.hrLo + '-' + s.hrHi + 'bpm') : (s.hrLo + 'bpm+')) : 'no HR band';
      return 'segment ' + (i + 1) + ' (' + s.km + 'km, zone ' + s.zone + '): ' +
        (s.mode === TARGET_MODE.CEILING
          ? ('pace CEILING ' + s.paceLabel + ' - at or under it is correct at any margin, running SLOWER than it is not a shortfall and must not be reported as one; only exceeding it is a finding')
          : ('pace TARGET ' + s.paceLabel)) + ', HR ' + band;
    }).join('; ');
    let out = ' HOW TO READ THIS SESSION: ' + interp.note + ' The segments in order are - ' + segText + '.' +
      ' Judge each segment against its OWN expectation and never against another segment\'s: the aerobic base is not underperforming because it is slower than the finish segment, that is the prescription working.';
    if(laps.length && laps.length !== interp.segments.length){
      out += ' Note the runner\'s actual data has ' + laps.length + ' work segments against ' + interp.segments.length + ' prescribed, so they cannot be lined up reliably - say what each real segment did on its own terms rather than assigning it to a prescribed one.';
    }
    return out;
  }

  const e = interp.workExpectation;
  if(!e) return ' HOW TO READ THIS SESSION: ' + interp.note;
  const band = e.hrLo != null ? (e.hrHi != null ? (e.hrLo + '-' + e.hrHi + 'bpm') : (e.hrLo + 'bpm and up, no ceiling')) : 'no HR band';
  let out = ' HOW TO READ THIS SESSION: ' + interp.note + ' Every work rep shares one expectation: ' +
    (e.mode === TARGET_MODE.EFFORT
      ? 'no pace target at all (do not judge pace)'
      : (e.mode === TARGET_MODE.CEILING
        ? ('pace CEILING ' + e.paceLabel + ' - at or under it is correct at any margin, and running slower than it must never be reported as a shortfall')
        : ('pace TARGET ' + e.paceLabel))) + ', HR ' + band + '.';
  if(e.hrHi == null && e.hrLo != null){
    out += ' This zone has NO upper bound, so HR reading high is never a finding here - the only HR finding available is HR failing to reach ' + e.hrLo + 'bpm, which means the intended stimulus was missed.';
  }
  if(laps.length && interp.prescribedWorkCount != null && laps.length !== interp.prescribedWorkCount){
    const more = laps.length > interp.prescribedWorkCount;
    out += ' The runner did ' + laps.length + ' work reps against ' + interp.prescribedWorkCount + ' prescribed - ' +
      Math.abs(laps.length - interp.prescribedWorkCount) + ' ' + (more ? 'MORE' : 'FEWER') + '. Say so plainly and factor it in' +
      (more
        ? ' - extra reps mean extra load that the plan did not account for, which matters for the days either side of this one, and repeated over-delivery is worth naming rather than quietly praising.'
        : ' - a short set is a smaller stimulus than prescribed, and whether that was a deliberate call or the session falling apart changes what it means.') +
      ' Every rep still shares the same expectation, so judge each of them against it normally.';
  }
  return out;
}

/**
 * The verdict for one work lap against its own expectation.
 * Returns {paceText, paceStatus, hrText, hrStatus} with nulls where nothing should be said.
 */
export function judgeLap(lap, exp, tolSec){
  const tol = tolSec == null ? 3 : tolSec;
  const out = {paceText: null, paceStatus: null, hrText: null, hrStatus: null};
  if(!lap || !exp) return out;

  const lapSec = lap.gapPaceSec != null ? lap.gapPaceSec : (lap.avgPaceSec != null ? lap.avgPaceSec : null);
  if(lapSec != null && exp.paceSec != null && exp.mode !== TARGET_MODE.EFFORT){
    if(exp.mode === TARGET_MODE.CEILING){
      if(lapSec < exp.paceSec - tol){ out.paceText = Math.round(exp.paceSec - lapSec) + 's/km over ceiling'; out.paceStatus = 'bad'; }
      else { out.paceText = 'under ceiling'; out.paceStatus = 'ok'; }
    } else {
      const diff = exp.paceSec - lapSec;
      if(diff > tol){ out.paceText = Math.round(diff) + 's/km faster'; out.paceStatus = 'fast'; }
      else if(diff < -tol){ out.paceText = Math.round(-diff) + 's/km slower'; out.paceStatus = 'slow'; }
      else { out.paceText = 'on target'; out.paceStatus = 'ok'; }
    }
  }

  if(lap.avgHR){
    const above = exp.hrHi != null && lap.avgHR > exp.hrHi;
    const below = exp.hrLo != null && lap.avgHR < exp.hrLo;
    if(above && exp.flagAbove){
      out.hrText = 'HR ' + lap.avgHR + ' (' + (lap.avgHR - exp.hrHi) + 'bpm above zone)'; out.hrStatus = 'bad';
    } else if(below && exp.flagBelow){
      // On a quality rep, REACHING the zone is the stimulus - so failing to is a miss, not
      // a nicety. This is the only HR verdict a VO2max rep can produce, its zone having no
      // ceiling, and it is the answer to "what if HR stays too low on VO2max".
      out.hrText = 'HR ' + lap.avgHR + ' (' + (exp.hrLo - lap.avgHR) + 'bpm below zone - never reached it)'; out.hrStatus = 'bad';
    } else if(below && exp.mode === TARGET_MODE.PACE){
      // At target pace where the floor isn't a requirement, a low HR is the "this target may
      // be undershooting you" signal - information, not a miss.
      out.hrText = 'HR ' + lap.avgHR + ' (' + (exp.hrLo - lap.avgHR) + 'bpm below zone)'; out.hrStatus = 'good';
    } else if(!above && !below && exp.mode === TARGET_MODE.EFFORT && exp.hrLo != null){
      // Where HR is the ONLY evidence (no pace target at all), landing in the zone deserves
      // saying so - otherwise these reps show a blank verdict despite being fully judged.
      out.hrText = 'HR ' + lap.avgHR + ' in zone'; out.hrStatus = 'good';
    }
  }
  return out;
}
