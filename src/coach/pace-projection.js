import { state } from '../state.js';
import { computeZones } from '../data/plan.js';
import { parseDayTagDate } from '../lib/dates.js';

import {
  activeGoal, computeBuildDaysBreakdown, getBestAvailableLTPace,
  impliedLTPaceForGoal, resolveTrajectoryStart
} from './goal-trajectory.js';

// Where the plan's own pace targets SHOULD have got to by a given week, shown beside where
// they actually are.
//
// Every session in the block currently prescribes the same paces, and correctly so - they are
// rebuilt from today's real threshold pace on every load, and that number has not moved yet.
// But the block is a claim: that threshold pace will travel from where it is now to what
// sub-1:30 requires, by race day. Rendering that claim week by week turns it into something
// watchable - the gap between the prescribed pace and the on-curve pace IS the ahead/behind
// signal, expressed in the same units the runner actually executes in, rather than as a gauge
// position they have to take on trust.
//
// Deliberately derived from the SAME curve the trajectory gauge judges against, rather than a
// second one built for display. Two independently-defined "where you should be" curves would
// eventually disagree, and a runner shown two different answers has no way to know which to
// believe - the exact failure this app has spent a lot of effort removing elsewhere.
//
// The elapsed fraction is build-day weighted (computeBuildDaysBreakdown), so cutback and
// taper weeks do not demand progress: they are meant to hold fitness, not build it, and a
// naive calendar interpolation would quietly mark every taper week as falling behind.

// Below this, the difference is inside the noise of a threshold estimate and showing it would
// invite chasing a number that hasn't really moved.
export const PROJECTION_MEANINGFUL_SEC = 2;

/**
 * The on-curve threshold pace for each of a set of dates, plus today's actual one.
 * Returns null when there is no active goal, no started block, or no fitness history to
 * anchor to - in which case nothing should be displayed at all rather than a guess.
 */
export async function computePaceProjection(dates){
  const goal = activeGoal('GOAL');
  if(!goal || !goal.raceDate) return null;
  // Deliberately NOT gated on the block having started, unlike the trajectory gauge. The
  // gauge answers "are you on track so far", which is meaningless before there is a so-far.
  // This answers "what should this week's paces be", which is well defined for every week of
  // the block from the moment it is written - and in the days before a block begins, EVERY
  // week is a future week, so gating it here would have shown the runner nothing at exactly
  // the point the whole curve is still ahead of them.

  let history = [];
  try{ const r = await window.storage.get('profile-history', false); if(r) history = JSON.parse(r.value); }catch(e){}
  if(!history.length) return null;

  const goalImpliedLTPace = Math.round(impliedLTPaceForGoal(goal.goalTimeSec || 95*60, goal.distanceKm || 21.0975));
  const best = await getBestAvailableLTPace();
  if(best.ltPaceSec == null) return null;

  const trajStart = await resolveTrajectoryStart(history, goalImpliedLTPace);
  if(trajStart.gap == null || !trajStart.date) return null;
  const raceDate = new Date(goal.raceDate);

  const at = {};
  (dates || []).forEach(d => {
    if(!d) return;
    // elapsedFrac is how much of the block's BUILD runway has been used by this date; the
    // remaining share of the original gap is what the curve still allows to be outstanding.
    const {elapsedFrac} = computeBuildDaysBreakdown(state.WEEKS, trajStart.date, raceDate, d);
    at[d.getTime()] = Math.round(goalImpliedLTPace + trajStart.gap * (1 - elapsedFrac));
  });

  return {
    currentLtPaceSec: best.ltPaceSec,
    goalImpliedLTPaceSec: goalImpliedLTPace,
    startLtPaceSec: Math.round(goalImpliedLTPace + trajStart.gap),
    startDate: trajStart.date,
    raceDate,
    at,
  };
}

/** The on-curve LT pace for one date, or null if it wasn't computed. */
export function projectedLTPaceFor(projection, date){
  if(!projection || !date) return null;
  const v = projection.at[date.getTime()];
  return v == null ? null : v;
}

/**
 * A full zone table built from a projected threshold pace, so a projected session pace comes
 * from the SAME zone maths as the real one (S2 = LT x 1.2, and so on) rather than a separate
 * scaling rule that could drift from it. HR bands come along unchanged, which is correct:
 * the whole point of a threshold pace improving is running faster at the same heart rate.
 */
export function projectedZones(projectedLtPaceSec){
  if(projectedLtPaceSec == null || !state.profile) return null;
  return computeZones(Object.assign({}, state.profile, {ltPaceSec: projectedLtPaceSec}), state.goalConfig);
}

// Zones whose pace is a fixed target rather than a readout of fitness - the goal pace IS the
// destination, so there is no "where it should be by week 30": it is the same number all
// block. Projecting them would imply a moving target that does not move.
const FIXED_TARGET_ZONES = ['GOAL', 'RACE10K'];

/**
 * The on-curve pace for one zone, honouring how that zone's LIVE pace is actually derived.
 *
 * S1-S4 come off threshold pace by fixed ratios, so rebuilding them from the projected
 * threshold pace is exact. S5 does not: its live value is overwritten by a separately
 * measured VO2max pace (see recomputeZones), so rebuilding it from the LT ratio would compare
 * a projected number against a live number that came from somewhere else entirely - two
 * different derivations sitting side by side pretending to be comparable. It is scaled in
 * proportion instead, which states the honest assumption plainly: VO2max pace improves
 * roughly in step with threshold pace.
 */
export function projectedPaceForZone(zoneKey, projectedLtPaceSec, currentLtPaceSec){
  if(!zoneKey || FIXED_TARGET_ZONES.includes(zoneKey)) return null;
  if(projectedLtPaceSec == null || !currentLtPaceSec) return null;
  const live = state.Z && state.Z[zoneKey];
  if(!live || live.pace == null) return null;
  if(zoneKey === 'S5') return Math.round(live.pace * (projectedLtPaceSec / currentLtPaceSec));
  const z = projectedZones(projectedLtPaceSec);
  return z && z[zoneKey] ? z[zoneKey].pace : null;
}

/** Every dated day in a week, for asking the projection about them in one pass. */
export function weekDates(week){
  return ((week && week.days) || []).map(d => parseDayTagDate(d.tag)).filter(Boolean);
}

/**
 * How this week's on-curve pace compares to the real one, as a plain sentence.
 * Returns null when there is nothing meaningful to say - which is the correct output early in
 * a block, where the curve has barely moved and any difference is estimation noise.
 */
export function describeWeekProjection(projection, date){
  const projected = projectedLTPaceFor(projection, date);
  if(projected == null || !projection.currentLtPaceSec) return null;
  const deltaSec = projection.currentLtPaceSec - projected;
  return {
    projectedLtPaceSec: projected,
    currentLtPaceSec: projection.currentLtPaceSec,
    deltaSec,
    meaningful: Math.abs(deltaSec) >= PROJECTION_MEANINGFUL_SEC,
    // Positive delta = current pace is slower (a higher sec/km) than the curve wants by now.
    status: Math.abs(deltaSec) < PROJECTION_MEANINGFUL_SEC ? 'on-curve' : (deltaSec > 0 ? 'behind' : 'ahead'),
  };
}
