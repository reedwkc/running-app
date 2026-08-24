import { state } from '../state.js';
import { getBestAvailableLTPace, getBestFitnessLTPace, getEfficiencyTrend, getLayoffAdjustment, getTrendSummary, loadTierEstimate } from './tier-estimates.js';
// Re-exported so existing importers (tests included) can keep pulling the tier-merge logic
// from here - the merge itself now lives in tier-estimates.js so getBestFitnessLTPace can
// share it instead of the two functions independently re-implementing the same ranking.
export { getBestAvailableLTPace };
import { computeZones, threshold } from '../data/plan.js';
import { defaultGoalConfig, findGoalRaceDay } from '../data/goal-config.js';
import { parseDayTagDate } from '../lib/dates.js';
import { fmtPace, formatMinutesToClock, timeAgo } from '../lib/format.js';
import { saveWithRetry } from '../lib/storage.js';
import { loadWorkoutLog } from '../ui/week-view.js';

function activeGoal(zoneKey){
  const cfg = state.goalConfig || defaultGoalConfig();
  return (cfg.activeGoals||[]).find(g=>g.zoneKey===zoneKey) || null;
}

export function impliedLTPaceForGoal(goalTotalSec, distanceKm){
  const halfTimeImplied = goalTotalSec / Math.pow(distanceKm/21.0975, 1.06);
  const halfPaceImplied = halfTimeImplied/21.0975;
  return halfPaceImplied/1.045;
}

export function projectedTimeFromLTPace(ltPaceSec, distanceKm){
  const halfPaceImplied = ltPaceSec * 1.045;
  const halfTimeImplied = halfPaceImplied * 21.0975;
  return halfTimeImplied * Math.pow(distanceKm/21.0975, 1.06);
}

export function interpolateLinear(startDate, startVal, endDate, endVal, atDate){
  const total = endDate - startDate;
  if(total<=0) return endVal;
  const elapsed = atDate - startDate;
  const frac = Math.max(0, Math.min(1, elapsed/total));
  return startVal + (endVal-startVal)*frac;
}

// Shared math behind both goal trackers' "how are we tracking against the timeline"
// read: the gap is expected to close linearly from startGap (at startDate) to 0 (at
// raceDate); position 50 means the current gap matches that expectation exactly, 0/100
// are the extremes of meaningfully behind/ahead of it.
export function computeTrajectoryPosition(startGap, startDate, raceDate, currentGap, now){
  now = now || new Date();
  let elapsedFrac = (now.getTime()-startDate.getTime())/(raceDate.getTime()-startDate.getTime());
  if(!isFinite(elapsedFrac)) elapsedFrac = 0;
  elapsedFrac = Math.max(0, Math.min(1, elapsedFrac));
  const expectedGapNow = startGap*(1-elapsedFrac);
  const aheadBehind = expectedGapNow - currentGap;
  const normFactor = Math.max(Math.abs(startGap)*0.5, 5);
  let position = 50 + (aheadBehind/normFactor)*50;
  position = Math.max(0, Math.min(100, position));
  const status = position<33 ? 'behind' : position>67 ? 'ahead' : 'on track';
  return {position, status};
}

// computeTrajectoryPosition's normFactor scales with how big the gap was AT BLOCK START -
// a large original gap makes a smaller (but still very real) remaining gap swing position
// high, even with almost no runway left to close it further. That's backwards this close to
// the race: a real pace gap that would cost more than MEANINGFUL_FINISH_GAP_SEC over the
// full race distance has no more time to "grow into" a favorable reading, however fast it
// closed relative to a straight-line schedule. Caught live: ~13 days out, current pace still
// ~60s+ (finish-time-equivalent) slower than goal, the gauge read "strong ahead."
// Deliberately reuses the SAME currentGap (sec/km) already driving computeTrajectoryPosition
// above, just scaled by distance - not the separate Riegel-based projectedSec/goalTimeSec
// figures shown in the "current fitness projects to" note, which are calibrated differently
// (a ~1.045 LT-to-race-pace factor baked in) and would systematically over-fire this ceiling
// if mixed in here.
export const NEAR_RACE_DAYS = 14;
export const MEANINGFUL_FINISH_GAP_SEC = 60;
export const NEAR_RACE_POSITION_CEILING = 40;
export function applyNearRaceGapCeiling(position, currentGapSec, distanceKm, raceDate, now){
  if(currentGapSec==null) return position;
  now = now || new Date();
  const daysToRace = (raceDate.getTime()-now.getTime())/86400000;
  if(daysToRace<0 || daysToRace>NEAR_RACE_DAYS) return position;
  const finishGapSec = currentGapSec * (distanceKm||21.0975);
  if(finishGapSec < MEANINGFUL_FINISH_GAP_SEC) return position;
  return Math.min(position, NEAR_RACE_POSITION_CEILING);
}

// "Bound, don't block" - mirrors the deterministic-clamp philosophy used for tier estimates
// and plan-override proposals elsewhere in this codebase. The coach's own synthesis prompt
// asks it to stay within ~10 points of the deterministic baseline unless it states a
// specific reason, but nothing enforces that - a wayward AI reading (a "strong ahead"
// headline when the actual numbers say otherwise) would otherwise render completely
// unclamped. Applied at load time (not just at save time) so it also self-corrects any
// already-saved reading, not just future ones.
export function clampAIPositionToBaseline(aiPosition, baseline, band){
  if(aiPosition==null || !baseline || baseline.position==null || baseline.status==='neutral') return aiPosition;
  band = band==null ? 20 : band;
  const lo = Math.max(0, baseline.position-band), hi = Math.min(100, baseline.position+band);
  return Math.max(lo, Math.min(hi, aiPosition));
}

// Shared "what does the deterministic timeline math say on its own" baseline - computed
// once here so both the UI's pre-AI fallback (loadGoalTrackerData/load10KGoalTrackerData)
// and the trajectory prompt sent to the coach are always looking at the same number. Before
// this, the coach's synthesis invented its own 0-100 reading from scratch with nothing to
// anchor it to computeTrajectoryPosition's math, which let it land arbitrarily far away -
// e.g. a 3s/km gap with 45+ days still left computed to 100 ("Ahead", pinned at max) here,
// but the coach synthesized 58 ("barely on track") completely independently.
// goal: the activeGoals entry (zoneKey 'GOAL') this baseline is for, or null if no such
// goal is currently active (e.g. a raceless maintenance phase) - returns a neutral
// sentinel immediately in that case rather than computing against a nonexistent race.
// checkpointGoal: an earlier goal (typically the 10K) whose actual result, once run,
// recalibrates this trajectory's starting point instead of trusting the original
// block-start estimate - optional, only meaningful when that earlier race has already
// happened.
export async function computeHMTrajectoryBaseline(goal, checkpointGoal){
  if(!goal || !goal.raceDate) return {position:50, status:'neutral', label:'No active goal to gauge trend against right now.', source:null};
  let history = [];
  try{ const r = await window.storage.get('profile-history', false); if(r) history = JSON.parse(r.value); }catch(e){}
  const goalPaceSec = goal.goalPaceSec!=null ? goal.goalPaceSec : Math.round(impliedLTPaceForGoal(goal.goalTimeSec||95*60, goal.distanceKm||21.0975));
  const best = await getBestAvailableLTPace();
  const currentGap = best.ltPaceSec!=null ? (best.ltPaceSec - goalPaceSec) : null;
  if(!history.length || currentGap==null){
    return {position:50, status:'neutral', label:'Not enough threshold history yet to gauge trend - showing neutral until your LT pace updates again.', source:best.source};
  }
  const first = history[0];
  let trajStartGap = first.ltPaceSec - goalPaceSec;
  let trajStartDate = new Date(first.date);
  const raceDate = new Date(goal.raceDate);
  let checkpointNote = '';
  if(checkpointGoal){
    const found = findGoalRaceDay(state.WEEKS, checkpointGoal);
    if(found){
      const checkpointDate = parseDayTagDate(found.day.tag);
      const checkpointLog = await loadWorkoutLog(found.week.n, found.day.tag);
      if(checkpointDate && checkpointLog && checkpointLog.completed && checkpointLog.actualDist && checkpointLog.actualDur && new Date() > checkpointDate){
        const actualDist = parseFloat(checkpointLog.actualDist);
        const actualDurSec = parseFloat(checkpointLog.actualDur)*60;
        if(actualDist>0 && actualDurSec>0){
          const goalDistanceKm = goal.distanceKm||21.0975;
          const equivalentSec = actualDurSec * Math.pow(goalDistanceKm/actualDist, 1.06);
          const impliedFromRace = Math.round(impliedLTPaceForGoal(equivalentSec, goalDistanceKm));
          trajStartGap = impliedFromRace - goalPaceSec;
          trajStartDate = checkpointDate;
          checkpointNote = ' (recalibrated using your actual '+(checkpointGoal.label||checkpointGoal.type||'checkpoint')+' result)';
        }
      }
    }
  }
  const distanceKm = goal.distanceKm||21.0975;
  const rawPos = computeTrajectoryPosition(trajStartGap, trajStartDate, raceDate, currentGap);
  const position = applyNearRaceGapCeiling(rawPos.position, currentGap, distanceKm, raceDate);
  const capped = position < rawPos.position;
  const status = position<33 ? 'behind' : position>67 ? 'ahead' : 'on track';
  const goalDesc = (goal.goalTimeLabel||'the goal').toLowerCase();
  let label;
  if(status==='behind') label = 'Behind pace for '+goalDesc+' given time remaining'+checkpointNote+' - threshold needs to move faster from here.';
  else if(status==='ahead') label = 'Ahead of where you need to be for '+goalDesc+checkpointNote+' - the gap is closing faster than the timeline requires.';
  else label = 'On track for '+goalDesc+' given time remaining'+checkpointNote+'.';
  if(capped) label += ' Current pace is still ~'+Math.round(currentGap*distanceKm)+'s slower (finish-time equivalent) than goal pace with under '+NEAR_RACE_DAYS+' days left - not enough runway to call this comfortably ahead yet.';
  return {position, status, label, source:best.source};
}

export async function compute10KTrajectoryBaseline(goal){
  if(!goal || !goal.raceDate) return {position:50, status:'neutral', label:'No active goal to gauge trend against right now.', source:null};
  let history = [];
  try{ const r = await window.storage.get('profile-history', false); if(r) history = JSON.parse(r.value); }catch(e){}
  const goalPaceSec = goal.goalPaceSec!=null ? goal.goalPaceSec : Math.round(impliedLTPaceForGoal(goal.goalTimeSec||43*60, goal.distanceKm||10));
  const best = await getBestAvailableLTPace();
  const currentGap = best.ltPaceSec!=null ? (best.ltPaceSec - goalPaceSec) : null;
  if(!history.length || currentGap==null){
    return {position:50, status:'neutral', label:'Not enough threshold history yet to gauge trend - showing neutral until your LT pace updates again.', source:best.source};
  }
  const first = history[0];
  const startGap = first.ltPaceSec - goalPaceSec;
  const startDate = new Date(first.date);
  const raceDate = new Date(goal.raceDate);
  const distanceKm = goal.distanceKm||10;
  const rawPos = computeTrajectoryPosition(startGap, startDate, raceDate, currentGap);
  const position = applyNearRaceGapCeiling(rawPos.position, currentGap, distanceKm, raceDate);
  const capped = position < rawPos.position;
  const status = position<33 ? 'behind' : position>67 ? 'ahead' : 'on track';
  const goalDesc = (goal.goalTimeLabel||'the goal').toLowerCase();
  let label;
  if(status==='behind') label = 'Behind pace for '+goalDesc+' given time remaining - threshold needs to move faster from here.';
  else if(status==='ahead') label = 'Ahead of where you need to be for '+goalDesc+' - the gap is closing faster than the timeline requires.';
  else label = 'On track for '+goalDesc+' given time remaining.';
  if(capped) label += ' Current pace is still ~'+Math.round(currentGap*distanceKm)+'s slower (finish-time equivalent) than goal pace with under '+NEAR_RACE_DAYS+' days left - not enough runway to call this comfortably ahead yet.';
  return {position, status, label, source:best.source};
}

// A raceless maintenance phase has no fixed target/deadline to interpolate a gap toward
// the way computeTrajectoryPosition does for a race - the useful question instead is
// "compared to a few weeks ago, is fitness holding, improving, or slipping." referencePace/
// currentPace are both LT-pace-in-seconds (higher = slower); deltaSec>0 means pace got
// FASTER (improved) over the window. normFactor treats roughly a 3% pace change over the
// window as the meaningful edge of "clearly moved," same spirit as computeTrajectoryPosition's
// own normFactor but without a race-timeline to anchor it to instead.
export function computeMaintenanceTrend(referencePaceSec, currentPaceSec){
  if(referencePaceSec==null || currentPaceSec==null) return {position:50, status:'neutral'};
  const deltaSec = referencePaceSec - currentPaceSec;
  const normFactor = Math.max(Math.abs(referencePaceSec)*0.03, 3);
  let position = 50 + (deltaSec/normFactor)*50;
  position = Math.max(0, Math.min(100, position));
  const status = position<33 ? 'declining' : position>67 ? 'improving' : 'holding steady';
  return {position, status};
}

const MAINTENANCE_TREND_WINDOW_DAYS = 28;

// Deterministic "how's fitness holding up" baseline for a raceless maintenance phase -
// same role computeHMTrajectoryBaseline/compute10KTrajectoryBaseline play for a race, just
// anchored to a rolling ~4-week window instead of a block-start-to-race-day timeline (there
// is no race day to interpolate toward here).
export async function computeMaintenanceBaseline(){
  let history = [];
  try{ const r = await window.storage.get('profile-history', false); if(r) history = JSON.parse(r.value); }catch(e){}
  const best = await getBestAvailableLTPace();
  if(!history.length || best.ltPaceSec==null){
    return {position:50, status:'neutral', label:'Not enough threshold history yet to gauge a maintenance trend - showing neutral until your LT pace updates again.', source:best.source};
  }
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-MAINTENANCE_TREND_WINDOW_DAYS);
  const withinWindow = history.filter(h=> new Date(h.date) <= cutoff);
  const reference = withinWindow.length ? withinWindow[withinWindow.length-1] : history[0];
  const {position, status} = computeMaintenanceTrend(reference.ltPaceSec, best.ltPaceSec);
  let label;
  if(status==='declining') label = 'Fitness trending down over the last ~'+MAINTENANCE_TREND_WINDOW_DAYS+' days - worth checking whether maintenance volume/consistency needs a bump.';
  else if(status==='improving') label = 'Fitness trending up over the last ~'+MAINTENANCE_TREND_WINDOW_DAYS+' days - genuine gains, if this holds over more sessions.';
  else label = 'Fitness holding steady over the last ~'+MAINTENANCE_TREND_WINDOW_DAYS+' days - exactly the point of a maintenance phase.';
  return {position, status, label, source:best.source};
}

async function buildMaintenanceTrajectoryPrompt(){
  const baseline = await computeMaintenanceBaseline();
  const best = await getBestAvailableLTPace();
  const effTrend = await getEfficiencyTrend();
  let prevNote = '';
  try{
    const pr = await window.storage.get('goal-trajectory-maintenance-latest', false);
    if(pr){
      const p = JSON.parse(pr.value);
      if(p && p.position!=null) prevNote = ' The last maintenance trajectory reading (from '+(p.basedOn||'a prior session')+', '+(p.updatedAt?timeAgo(p.updatedAt):'unknown time')+') was position '+p.position+' ("'+(p.headline||'')+'").';
    }
  }catch(e){}
  const trajectoryContext = ' For the maintenance fitness-trend synthesis below (no active race goal right now, so this replaces the usual goal-trajectory read): current best-available LT pace is '+(best.ltPaceSec!=null?fmtPace(best.ltPaceSec):'unknown')+' (from '+best.source+', '+(best.updatedAt?timeAgo(best.updatedAt):'no date')+').'+(effTrend?(' Aerobic efficiency trend: '+(effTrend.pctChange>=0?'+':'')+effTrend.pctChange.toFixed(1)+'% recent vs prior.'):'')+' The deterministic ~'+MAINTENANCE_TREND_WINDOW_DAYS+'-day trend baseline (comparing current best pace to the pace from roughly that many days ago - no target/deadline involved, since this is a raceless maintenance phase) computes to position '+Math.round(baseline.position)+'/100 ('+baseline.status+') on its own.'+prevNote;
  const trajectoryPrompt = ' Also, before GOAL IMPACT, add a block on its own line starting with exactly "MAINTENANCE TRAJECTORY:" followed by a single valid JSON object synthesizing whether fitness is holding steady, improving, or declining during this raceless maintenance phase, using everything above - the pace trend, efficiency trend if present, this specific session, and the runner\'s learned patterns and recent history. Weigh recent evidence more than older evidence, and weigh trends (multiple sessions agreeing) over any single session. The JSON shape: {"position":0,"confidence":"low","headline":"...","actionFlag":false} - position is 0-100 where 0 is clearly declining, 50 is holding steady, 100 is clearly improving; confidence is "low"/"medium"/"high" based on how much fresh evidence exists; headline is exactly 1 short, concrete sentence stating the current read in plain language; actionFlag is true only if there\'s a genuine, evidence-backed case the maintenance structure itself should change - a sustained decline suggesting volume/consistency needs a bump, or a case fitness has held/grown enough that resuming a real race build is worth considering - not from a single session\'s mood alone. Use the deterministic baseline above as your starting anchor, only moving meaningfully away from it (roughly 10+ points) with a specific, statable reason. If the last maintenance reading is given above and your new position differs meaningfully (roughly 5+ points), mention that movement explicitly in your main visible reply, the way a coach would actually say "your fitness looks like it\'s held/slipped/picked up since we last talked."';
  return {trajectoryContext, trajectoryPrompt, trajectory10KPrompt:''};
}

// Mirrors loadGoalTrackerData/load10KGoalTrackerData's shape exactly so goalTrackerHTML can
// render it the same way - {active:false} whenever a real race goal exists (this gauge is
// only for the genuinely raceless case, the HM/10K gauges already cover the rest).
export async function loadMaintenanceTrackerData(){
  const cfg = state.goalConfig || defaultGoalConfig();
  const hasRaceGoal = (cfg.activeGoals||[]).some(g=>g.zoneKey==='GOAL'||g.zoneKey==='RACE10K');
  if(hasRaceGoal) return {active:false};
  const baseline = await computeMaintenanceBaseline();

  let ai = null;
  try{ const r = await window.storage.get('goal-trajectory-maintenance-latest', false); if(r) ai = JSON.parse(r.value); }catch(e){}

  /** @type {import('../types.js').GoalTrajectoryReading} */
  let result;
  if(ai && ai.position!=null){
    result = {
      position: ai.position, confidence: ai.confidence||'medium', label: ai.headline||baseline.label,
      actionFlag: !!ai.actionFlag, source: 'coach synthesis', updatedAt: ai.updatedAt, basedOn: ai.basedOn
    };
  } else {
    result = Object.assign({confidence:'low', actionFlag:false, updatedAt:null, basedOn:null}, baseline);
  }

  let prevPosition = null;
  try{ const pr = await window.storage.get('goal-trajectory-maintenance-prevpos', false); if(pr) prevPosition = JSON.parse(pr.value).position; }catch(e){}
  result.trend = (prevPosition!=null) ? (result.position - prevPosition) : 0;
  try{ await saveWithRetry('goal-trajectory-maintenance-prevpos', {position: result.position}, false); }catch(e){}
  result.active = true;
  result.titleLabel = 'Fitness maintenance trend';
  return result;
}

export function parseGoalTimeToSec(goalTimeLabel){
  if(!goalTimeLabel) return null;
  const cleaned = String(goalTimeLabel).replace(/^Sub-/i,'').trim();
  const parts = cleaned.split(':').map(p=>parseInt(p,10));
  if(parts.some(isNaN)) return null;
  if(parts.length===3) return parts[0]*3600+parts[1]*60+parts[2];
  if(parts.length===2) return parts[0]*60+parts[1];
  return null;
}

// Returns whatever goals are actually active instead of the old all-or-nothing null -
// e.g. just the 10K side when only a 10K goal is active, or null entirely only when
// NEITHER goal slot has anything active (a genuine no-race maintenance phase, nothing to
// report progress against). tenK/hm are each null when that specific slot is inactive.
export async function computeGoalProgress(){
  try{
    const tenKGoal = activeGoal('RACE10K');
    const hmGoal = activeGoal('GOAL');
    if(!tenKGoal && !hmGoal) return null;

    const blockStartDate = (state.WEEKS[0] && state.WEEKS[0].days.length) ? parseDayTagDate(state.WEEKS[0].days[0].tag) : null;
    if(!blockStartDate) return null;

    let history = [];
    try{ const r = await window.storage.get('profile-history', false); if(r) history = JSON.parse(r.value); }catch(e){}
    const startingLTPace = history.length ? history[0].ltPaceSec : state.profile.ltPaceSec;
    const today = new Date();
    const bestPace = await getBestFitnessLTPace();

    let tenK = null;
    if(tenKGoal){
      const found = findGoalRaceDay(state.WEEKS, tenKGoal);
      const raceDate = found ? parseDayTagDate(found.day.tag) : (tenKGoal.raceDate ? new Date(tenKGoal.raceDate) : null);
      if(raceDate){
        const distanceKm = tenKGoal.distanceKm||10;
        const goalSec = tenKGoal.goalTimeSec || (found && parseGoalTimeToSec(found.day.data.goalTime)) || 43*60;
        const implied = impliedLTPaceForGoal(goalSec, distanceKm);
        let hasResult = false, checkpointLTPace = implied;
        if(found){
          const log = await loadWorkoutLog(found.week.n, found.day.tag);
          hasResult = !!(log && log.completed && log.actualDist && log.actualDur);
          if(hasResult){
            const actualDist = parseFloat(log.actualDist);
            const actualDurSec = parseFloat(log.actualDur)*60;
            if(actualDist>0 && actualDurSec>0){
              const equivSec = actualDurSec * Math.pow(distanceKm/actualDist, 1.06);
              checkpointLTPace = impliedLTPaceForGoal(equivSec, distanceKm);
            }
          }
        }
        const expectedPaceToday = (today > raceDate) ? implied : interpolateLinear(blockStartDate, startingLTPace, raceDate, implied, today);
        tenK = {
          goalId: tenKGoal.goalId, label: tenKGoal.label||'10K',
          implied10KLT: implied, expected10KPaceToday: Math.round(expectedPaceToday),
          gap10KSec: Math.round(bestPace.value - expectedPaceToday),
          has10KResult: hasResult, checkpointLTPace: Math.round(checkpointLTPace),
          race10KDate: raceDate.toISOString().slice(0,10), todayPastRace10K: today > raceDate,
        };
      }
    }

    let hm = null;
    if(hmGoal){
      const found = findGoalRaceDay(state.WEEKS, hmGoal);
      const raceDate = found ? parseDayTagDate(found.day.tag) : (hmGoal.raceDate ? new Date(hmGoal.raceDate) : null);
      if(raceDate){
        const distanceKm = hmGoal.distanceKm||21.0975;
        const goalSec = hmGoal.goalTimeSec || (found && parseGoalTimeToSec(found.day.data.goalTime)) || 95*60;
        const implied = impliedLTPaceForGoal(goalSec, distanceKm);
        const expectedPaceToday = (tenK && tenK.todayPastRace10K)
          ? interpolateLinear(new Date(tenK.race10KDate), tenK.checkpointLTPace, raceDate, implied, today)
          : interpolateLinear(blockStartDate, startingLTPace, raceDate, implied, today);
        hm = {
          goalId: hmGoal.goalId, label: hmGoal.label||'Half Marathon',
          impliedHMLT: implied, expectedHMPaceToday: Math.round(expectedPaceToday),
          gapHMSec: Math.round(bestPace.value - expectedPaceToday),
          raceHMDate: raceDate.toISOString().slice(0,10),
        };
      }
    }

    if(!tenK && !hm) return null;
    return {bestPace, startingLTPace, tenK, hm};
  }catch(e){ console.error('computeGoalProgress failed', e); return null; }
}

export async function buildTrajectoryPrompts(){
  const hmGoal = activeGoal('GOAL');
  const tenKGoal = activeGoal('RACE10K');
  // Genuinely raceless (no HM- or 10K-equivalent goal active at all) - a real maintenance
  // phase, not just "the HM is done but a 10K is still upcoming" or vice versa. Reuses the
  // same trajectoryContext/trajectoryPrompt slots every call site already concatenates, so
  // no call site needs to change to also handle this case.
  if(!hmGoal && !tenKGoal) return await buildMaintenanceTrajectoryPrompt();
  // No half-marathon-equivalent goal active right now, but a 10K still is (handled by its
  // own trajectory10KPrompt block below independently) - nothing to synthesize an HM
  // trajectory against, so emit nothing rather than computing prompt text anchored to a
  // goal that no longer exists.
  if(!hmGoal) return {trajectoryContext:'', trajectoryPrompt:'', trajectory10KPrompt:''};
  const goalPaceSec = hmGoal.goalPaceSec!=null ? hmGoal.goalPaceSec : Math.round(impliedLTPaceForGoal(hmGoal.goalTimeSec||95*60, hmGoal.distanceKm||21.0975));
  const goalLabel = (hmGoal.goalTimeLabel||'the goal').toLowerCase()+' '+(hmGoal.label||'').toLowerCase();
  const bestLT = await getBestAvailableLTPace();
  const ltGapSec = bestLT.ltPaceSec!=null ? (bestLT.ltPaceSec - goalPaceSec) : null;
  const hmBaseline = await computeHMTrajectoryBaseline(hmGoal, tenKGoal);
  const effTrend = await getEfficiencyTrend();
  const tttTrend = await getTrendSummary('timetotarget-history');
  const hrrTrend = await getTrendSummary('hrrecovery-history');
  const decoupTrend = await getTrendSummary('decoupling-history');
  let prevTrajNote = '';
  try{
    const pr = await window.storage.get('goal-trajectory-latest', false);
    if(pr){
      const p = JSON.parse(pr.value);
      if(p && p.position!=null) prevTrajNote = ' The last trajectory reading (from '+(p.basedOn||'a prior session')+', '+(p.updatedAt?timeAgo(p.updatedAt):'unknown time')+') was position '+p.position+' ("'+(p.headline||'')+'").';
    }
  }catch(e){}
  const trajectoryContext = ' For the goal trajectory synthesis below: current best-available LT pace is '+(bestLT.ltPaceSec!=null?fmtPace(bestLT.ltPaceSec):'unknown')+' (from '+bestLT.source+', '+(bestLT.updatedAt?timeAgo(bestLT.updatedAt):'no date')+'), which is '+(ltGapSec!=null?(Math.abs(ltGapSec)+'s/km '+(ltGapSec>0?'slower than':'at or faster than')+' the ~'+fmtPace(goalPaceSec)+' pace implied by the '+goalLabel+' goal'):'not yet established')+'.'+(effTrend?(' Aerobic efficiency trend: '+(effTrend.pctChange>=0?'+':'')+effTrend.pctChange.toFixed(1)+'% recent vs prior.'):'')+(tttTrend&&tttTrend.pctChange!=null?(' Time-to-target-HR trend: '+(tttTrend.pctChange<=0?'faster (improving) ':'slower ')+'by '+Math.abs(tttTrend.pctChange).toFixed(0)+'%.'):'')+(hrrTrend&&hrrTrend.pctChange!=null?(' HR recovery trend: '+(hrrTrend.pctChange>=0?'improving':'declining')+' by '+Math.abs(hrrTrend.pctChange).toFixed(0)+'%.'):'')+(decoupTrend&&decoupTrend.pctChange!=null?(' Long-run aerobic decoupling trend: '+(decoupTrend.pctChange<=0?'improving (less late-run fade)':'worsening (more late-run fade)')+' by '+Math.abs(decoupTrend.pctChange).toFixed(0)+'%.'):'')+' The deterministic timeline baseline (the gap expected to close linearly from where it started to zero by race day, purely from how much time has actually elapsed - no trend or confidence adjustment) computes to position '+Math.round(hmBaseline.position)+'/100 ('+hmBaseline.status+') on its own.'+prevTrajNote;
  const trajectoryPrompt = ' Also, before GOAL IMPACT, add a block on its own line starting with exactly "GOAL TRAJECTORY:" followed by a single valid JSON object synthesizing overall progress toward the '+goalLabel+' goal, using everything above - the LT pace gap, efficiency/time-to-target/HR-recovery/decoupling trends if present, this specific session, and the runner\'s learned patterns and recent history. Weigh recent evidence more than older evidence, and weigh trends (multiple sessions agreeing) more than any single session. Critically, check which phase of the plan the current week actually represents (the week callouts above say things like "peak week" or "taper begins") and calibrate your expectation to that phase, not a flat assumption of steady linear improvement throughout: build weeks should show the gap closing at a reasonable rate, a peak week is where the gap should be closing fastest, and a taper week should show the gap holding steady or closing only slightly - a flat reading during taper is the CORRECT, expected pattern, not a sign of stalling, so don\'t let it pull position down artificially. The JSON shape: {"position":0,"confidence":"low","headline":"...","actionFlag":false} - position is 0-100 where 0 is badly behind schedule for the goal given time remaining, 50 is on track, 100 is notably ahead; confidence is "low"/"medium"/"high" based on how much fresh, reliable evidence actually exists right now (low if the LT pace estimate is old or trends are thin, high if multiple fresh signals agree); headline is exactly 1 short, concrete sentence stating the current read in plain language; actionFlag is true only if the trajectory genuinely reveals something that should factor into whether the plan needs changing - a sustained behind-pace trend across multiple sessions, or a clear, evidence-backed case the goal itself should move - not from a single session\'s mood alone. Critically, use the deterministic timeline baseline given above as your starting anchor, not a fresh independent read - it already accounts for time remaining and how the gap has moved since the block started, which is exactly what "0 is badly behind... 100 is notably ahead" is meant to measure. Only move meaningfully away from that baseline (roughly 10+ points) when you have a specific, statable reason: evidence that\'s genuinely stale or thin (pull toward lower confidence, not necessarily a different position), or a real trend that contradicts the simple linear-close assumption the baseline makes (e.g. multiple sessions showing the gap closing much faster or slower than a straight line would predict). "Still early in the block" or "early days" is not by itself a reason to sit near 50 when the baseline already accounts for exactly how much time has elapsed - if the baseline says 100 because the gap is nearly closed with most of the timeline still ahead, that is what "notably ahead" means, not a reason for caution on its own. Note the baseline itself already applies a hard ceiling when the race is under 2 weeks away and a real pace gap (60s+ over the full race distance) is still open - if you see the baseline sitting in the 30s/40s despite the gap having closed a lot relative to how it started, that IS the correct read this close to race day, not a baseline bug to correct upward. The app also enforces this anchor in code (your position gets pulled back toward the baseline if it strays too far), so a wildly divergent number just gets silently corrected rather than shown - stay close to the baseline and your reading will actually be the one that renders. Also make sure your headline\'s wording actually matches the numeric band you land in - don\'t write "strong ahead"/"comfortably ahead" language for a position that isn\'t actually above 67, or "behind" language for one that isn\'t below 33; the headline and the number are shown together and must agree. If actionFlag is true here, let it inform whether a PASTE TO REBUILD above is warranted - this trajectory read and that decision should agree with each other, not contradict. Critically: if the last trajectory reading is given above and your new position differs from it meaningfully (roughly 5+ points, not a trivial wobble), you MUST explicitly mention this movement in your main visible reply above, not just in the hidden JSON - say which direction it moved and briefly why, in plain language, the way a coach would actually tell you "you have moved up/down on pace for your goal, because X." If the position is essentially unchanged, there is no need to call that out explicitly.';
  let trajectory10KPrompt = '';
  if(tenKGoal){
    try{
      const found10K = findGoalRaceDay(state.WEEKS, tenKGoal);
      const race10KDateCheck = found10K ? parseDayTagDate(found10K.day.tag) : (tenKGoal.raceDate ? new Date(tenKGoal.raceDate) : null);
      if(race10KDateCheck && new Date() <= race10KDateCheck){
        const goal10KPaceSec = tenKGoal.goalPaceSec!=null ? tenKGoal.goalPaceSec : Math.round(impliedLTPaceForGoal(tenKGoal.goalTimeSec||43*60, tenKGoal.distanceKm||10));
        const goal10KLabel = (tenKGoal.goalTimeLabel||'the goal').toLowerCase()+' '+(tenKGoal.label||'').toLowerCase();
        const ltGap10KSec = bestLT.ltPaceSec!=null ? (bestLT.ltPaceSec - goal10KPaceSec) : null;
        const tenKBaseline = await compute10KTrajectoryBaseline(tenKGoal);
        let prevTraj10KNote = '';
        try{
          const pr10 = await window.storage.get('goal-trajectory-10k-latest', false);
          if(pr10){
            const p10 = JSON.parse(pr10.value);
            if(p10 && p10.position!=null) prevTraj10KNote = ' The last 10K trajectory reading (from '+(p10.basedOn||'a prior session')+', '+(p10.updatedAt?timeAgo(p10.updatedAt):'unknown time')+') was position '+p10.position+' ("'+(p10.headline||'')+'").';
          }
        }catch(e){}
        const trajectory10KContext = ' For a separate 10K trajectory synthesis: current best-available LT pace is '+(ltGap10KSec!=null?(Math.abs(ltGap10KSec)+'s/km '+(ltGap10KSec>0?'slower than':'at or faster than')+' the ~'+fmtPace(goal10KPaceSec)+' pace implied by the '+goal10KLabel+' goal ('+(tenKGoal.raceDate||'')+')'):'not yet established')+'. The deterministic timeline baseline for the 10K computes to position '+Math.round(tenKBaseline.position)+'/100 ('+tenKBaseline.status+') on its own.'+prevTraj10KNote;
        trajectory10KPrompt = trajectory10KContext+' Also add a block on its own line starting with exactly "GOAL TRAJECTORY 10K:" followed by a single valid JSON object synthesizing progress toward the '+goal10KLabel+' goal specifically - same JSON shape and reasoning approach as the half marathon GOAL TRAJECTORY above, just focused on this goal and its own race date instead, including using its own deterministic baseline given above as the starting anchor rather than an independent read. The same periodization-phase calibration applies here too, just over the shorter build-up window to this earlier race - check the current week\'s callout (pre-race peak week vs the taper week itself) and calibrate expectations accordingly rather than assuming flat linear improvement throughout; a taper week specifically should show the gap holding steady, not continuing to close at the build-phase rate. Same rule as the half marathon trajectory: if your new 10K position differs meaningfully (roughly 5+ points) from the last reading given above, explicitly mention that movement in your main visible reply too, not just the hidden JSON.';
      }
    }catch(e){}
  }
  return {trajectoryContext, trajectoryPrompt, trajectory10KPrompt};
}

// vo2maxGapSec is a PERSONALIZED, evidence-based gap (threshold pace minus VO2max pace,
// as measured the last time a real VO2max session was actually logged and analyzed) - not
// the raw VO2max pace itself. Tier 1 has no VO2max-pace concept at all (Garmin doesn't
// give you one), so there's no tier1 candidate here.
export async function getBestAvailableVO2maxGap(){
  let candidates = [];
  try{
    const t2 = await loadTierEstimate(2);
    if(t2 && t2.vo2maxGapSec!=null) candidates.push({source:'tier2', vo2maxGapSec: t2.vo2maxGapSec, updatedAt: t2.updatedAt});
  }catch(e){}
  try{
    const t3 = await loadTierEstimate(3);
    if(t3 && t3.vo2maxGapSec!=null) candidates.push({source:'tier3', vo2maxGapSec: t3.vo2maxGapSec, updatedAt: t3.updatedAt});
  }catch(e){}
  if(!candidates.length) return {source:null, vo2maxGapSec: null, updatedAt: null};
  candidates.sort((a,b)=> new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return candidates[0];
}

// VO2max/interval pace is also anchored to the best-available (Tier 1/2/3 merged)
// threshold pace, not a rarely-updated raw VO2max entry - LTHR stays Tier 1-only (a stable
// ceiling, and even Tier 2/3 estimates already treat it conservatively), but pace is the
// number that actually drifts session to session, and freezing it to a manual entry defeats
// much of the point of having a live estimate at all. Deliberately NOT "use the raw VO2max
// pace last observed" either - this plan only has 3 VO2max-type sessions across all 8 weeks
// (vs 8 threshold sessions), so a frozen raw number would go stale for a month at a time
// while threshold pace keeps improving in the background between them. Instead: apply the
// best-known GAP (real, personalized once measured; ~18s/km, a generic Daniels-table
// threshold-to-interval assumption, until then) to whatever threshold pace is *right now* -
// so real VO2max evidence still wins over the generic assumption once it exists, but the
// result keeps tracking threshold improvements between the rare sessions that actually test
// it directly, rather than freezing in place. Rounded to a clean 5-second increment.
export async function computeVO2maxPaceSec(){
  const gapInfo = await getBestAvailableVO2maxGap();
  const effectiveGap = gapInfo.vo2maxGapSec!=null ? gapInfo.vo2maxGapSec : 18;
  const best = await getBestAvailableLTPace();
  if(best.ltPaceSec==null) return null;
  return Math.round((best.ltPaceSec - effectiveGap)/5)*5;
}

// Recomputes state.Z (S1-S5, GOAL, RACE10K) anchored to the BEST AVAILABLE LT pace - the
// same Tier 1/2/3 merge getBestAvailableLTPace already does for goal-trajectory gap math -
// instead of Tier 1's raw profile.ltPaceSec alone. Per explicit request: a solid Tier 2/3
// threshold read should genuinely override Garmin for the paces actually prescribed on
// sessions (threshold reps, easy/long-run pace via the S1-S3 ratios, S4 itself), not just
// for the gap-tracking bar - "that's almost the whole point" of having Tier 2/3 estimates at
// all. Every zone is re-derived from the SAME anchor together (S1-S4 are fixed ratios of the
// threshold pace in computeZones) so the zone ladder stays internally consistent, rather than
// only patching one zone and leaving the others computed off a different, older number.
// LTHR (the HR ceiling driving every zone's HR range) stays Tier 1-only, same as before -
// only the PACE anchor switches. Falls back to the caller's profile.ltPaceSec unchanged if
// no tier estimate is available at all (identical to today's behavior in that case).
// Returns {Z, layoffAdjustment} rather than bare Z - layoffAdjustment (null when no gap is
// active, see getLayoffAdjustment in tier-estimates.js) is a side effect the CALLER owns
// (assigns to state.layoffAdjustment for the UI banner), same separation this function
// already keeps for Z itself. When active, it temporarily inflates the pace anchors
// (slower = higher sec/km, the correct direction for an easier prescribed pace) on top of
// whichever Tier 1/2/3 evidence is otherwise authoritative - genuine injury-prevention for
// the window between resuming after a real gap and the first fresh Tier reading, not a
// permanent change. LTHR stays untouched, same precedent as the existing Tier 2/3 hybrid
// work - only pace anchors move.
export async function recomputeZones(profile, goalConfig){
  const best = await getBestAvailableLTPace();
  const layoffAdjustment = await getLayoffAdjustment();
  let effectiveLtPaceSec = best.ltPaceSec;
  if(layoffAdjustment && effectiveLtPaceSec!=null){
    effectiveLtPaceSec = Math.round(effectiveLtPaceSec * (1 + layoffAdjustment.ltPacePenaltyPct/100));
  }
  const effectiveProfile = effectiveLtPaceSec!=null ? Object.assign({}, profile, {ltPaceSec: effectiveLtPaceSec}) : profile;
  const Z = computeZones(effectiveProfile, goalConfig);
  try{
    let v = await computeVO2maxPaceSec();
    if(layoffAdjustment && v!=null) v = Math.round(v*(1+layoffAdjustment.vo2maxPenaltyPct/100)/5)*5;
    if(v!=null) Z.S5.pace = v;
  }catch(e){}
  return {Z, layoffAdjustment};
}

export async function load10KGoalTrackerData(){
  const goal = activeGoal('RACE10K');
  if(!goal) return {active:false};
  const best = await getBestAvailableLTPace();
  const baseline = await compute10KTrajectoryBaseline(goal);

  let ai = null;
  try{ const r = await window.storage.get('goal-trajectory-10k-latest', false); if(r) ai = JSON.parse(r.value); }catch(e){}

  /** @type {import('../types.js').GoalTrajectoryReading} */
  let result;
  if(ai && ai.position!=null){
    result = {
      position: clampAIPositionToBaseline(ai.position, baseline), confidence: ai.confidence||'medium', label: ai.headline||baseline.label,
      actionFlag: !!ai.actionFlag, source: 'coach synthesis', updatedAt: ai.updatedAt, basedOn: ai.basedOn
    };
  } else {
    result = Object.assign({confidence:'low', actionFlag:false, updatedAt:null, basedOn:null}, baseline);
  }

  let prevPosition = null;
  try{ const pr = await window.storage.get('goal-trajectory-10k-prevpos', false); if(pr) prevPosition = JSON.parse(pr.value).position; }catch(e){}
  result.trend = (prevPosition!=null) ? (result.position - prevPosition) : 0;
  try{ await saveWithRetry('goal-trajectory-10k-prevpos', {position: result.position}, false); }catch(e){}
  if(best.ltPaceSec!=null){ result.projectedSec = projectedTimeFromLTPace(best.ltPaceSec, goal.distanceKm||10); result.projectedPaceSec = result.projectedSec/(goal.distanceKm||10); }
  if(result.projectedSec!=null){
    try{ const pr = await window.storage.get('goal-trajectory-10k-prevproj', false); if(pr){ const prev = JSON.parse(pr.value).projectedSec; if(prev!=null) result.prevProjectedSec = prev; } }catch(e){}
    try{ await saveWithRetry('goal-trajectory-10k-prevproj', {projectedSec: result.projectedSec}, false); }catch(e){}
  }
  result.active = true;
  result.titleLabel = 'Goal trajectory - '+(goal.label||'10K')+' '+(goal.goalTimeLabel||'').toLowerCase();

  return result;
}

export async function loadGoalTrackerData(){
  const goal = activeGoal('GOAL');
  if(!goal) return {active:false};
  const checkpointGoal = activeGoal('RACE10K');
  const best = await getBestAvailableLTPace();
  const baseline = await computeHMTrajectoryBaseline(goal, checkpointGoal);

  let ai = null;
  try{ const r = await window.storage.get('goal-trajectory-latest', false); if(r) ai = JSON.parse(r.value); }catch(e){}

  /** @type {import('../types.js').GoalTrajectoryReading} */
  let result;
  if(ai && ai.position!=null){
    result = {
      position: clampAIPositionToBaseline(ai.position, baseline), confidence: ai.confidence||'medium', label: ai.headline||baseline.label,
      actionFlag: !!ai.actionFlag, source: 'coach synthesis', updatedAt: ai.updatedAt, basedOn: ai.basedOn
    };
  } else {
    result = Object.assign({confidence:'low', actionFlag:false, updatedAt:null, basedOn:null}, baseline);
  }

  let prevPosition = null;
  try{ const pr = await window.storage.get('goal-trajectory-prevpos', false); if(pr) prevPosition = JSON.parse(pr.value).position; }catch(e){}
  result.trend = (prevPosition!=null) ? (result.position - prevPosition) : 0;
  try{ await saveWithRetry('goal-trajectory-prevpos', {position: result.position}, false); }catch(e){}
  if(best.ltPaceSec!=null){ result.projectedSec = projectedTimeFromLTPace(best.ltPaceSec, goal.distanceKm||21.0975); result.projectedPaceSec = result.projectedSec/(goal.distanceKm||21.0975); }
  if(result.projectedSec!=null){
    try{ const pr = await window.storage.get('goal-trajectory-prevproj', false); if(pr){ const prev = JSON.parse(pr.value).projectedSec; if(prev!=null) result.prevProjectedSec = prev; } }catch(e){}
    try{ await saveWithRetry('goal-trajectory-prevproj', {projectedSec: result.projectedSec}, false); }catch(e){}
  }
  result.active = true;
  result.titleLabel = 'Goal trajectory - '+(goal.label||'Goal')+' '+(goal.goalTimeLabel||'').toLowerCase();

  return result;
}

export function goalTrackerHTML(data, titleLabel, axisLabels){
  titleLabel = titleLabel || data.titleLabel || 'Goal trajectory';
  axisLabels = axisLabels || ['Behind', 'On track', 'Ahead'];
  const w=340, h=64, barY=22, barH=10, pad=10;
  const usableW = w-pad*2;
  const confSize = data.confidence==='high' ? 9 : data.confidence==='medium' ? 7.5 : 6;
  // Inset the marker's travel range by its own radius so it stays flush with the bar's
  // edges at position 0/100 instead of overflowing past them - the center previously
  // traveled the bar's full width, but a circle with nonzero radius centered exactly on
  // an edge visually pokes outside it.
  const markerX = (pad+confSize) + (data.position/100)*(usableW-confSize*2);
  const confOpacity = data.confidence==='high' ? 1 : data.confidence==='medium' ? 0.85 : 0.6;
  const gradId = 'goalgrad'+Math.floor(Math.random()*100000);
  let svg = '<svg viewBox="0 0 '+w+' '+h+'" style="width:100%;height:64px;">';
  svg += '<defs><linearGradient id="'+gradId+'" x1="0" x2="1" y1="0" y2="0">'+
    '<stop offset="0%" stop-color="#C1502E"/><stop offset="50%" stop-color="#E8A33D"/><stop offset="100%" stop-color="#5FA8A0"/>'+
    '</linearGradient></defs>';
  svg += '<rect x="'+pad+'" y="'+barY+'" width="'+usableW+'" height="'+barH+'" rx="5" fill="url(#'+gradId+')" opacity="0.85"/>';
  if(data.trend && Math.abs(data.trend)>=1){
    const trendUp = data.trend>0;
    const arrowX = markerX + (trendUp?-16:16);
    svg += '<text x="'+arrowX+'" y="'+(barY+barH/2+4)+'" font-size="11" text-anchor="middle" fill="'+(trendUp?'#5FA8A0':'#C1502E')+'">'+(trendUp?'&#9650;':'&#9660;')+'</text>';
  }
  svg += '<circle cx="'+markerX+'" cy="'+(barY+barH/2)+'" r="'+confSize+'" fill="#EDEAE3" fill-opacity="'+confOpacity+'" stroke="#0F1B24" stroke-width="2.5"/>';
  svg += '<text x="'+pad+'" y="'+(barY+barH+16)+'" font-size="9" fill="#93A6B2">'+axisLabels[0]+'</text>';
  svg += '<text x="'+(w/2)+'" y="'+(barY+barH+16)+'" font-size="9" text-anchor="middle" fill="#93A6B2">'+axisLabels[1]+'</text>';
  svg += '<text x="'+(w-pad)+'" y="'+(barY+barH+16)+'" font-size="9" text-anchor="end" fill="#93A6B2">'+axisLabels[2]+'</text>';
  svg += '</svg>';
  const confBadge = '<span style="font-size:9.5px; text-transform:uppercase; letter-spacing:0.04em; padding:2px 6px; border-radius:4px; background:rgba(255,255,255,0.08); color:var(--dim);">'+data.confidence+' confidence</span>';
  const actionBadge = data.actionFlag ? ' <span style="font-size:9.5px; padding:2px 6px; border-radius:4px; background:rgba(232,163,61,0.18); color:var(--threshold); font-weight:700;">&#9888; worth a look</span>' : '';
  const freshness = data.updatedAt ? (' &middot; updated '+timeAgo(data.updatedAt)+(data.basedOn?(' after '+data.basedOn):'')) : '';
  // Arrow direction follows the actual numeric change (time went up or down), color follows
  // whether that's good or bad (lower projected time = faster = improvement) - kept distinct
  // from the position-gauge arrow convention above (there, up always means "better") since a
  // literal down-arrow on a time getting FASTER reads more honestly than an up-arrow would.
  const projTrendSec = (data.projectedSec!=null && data.prevProjectedSec!=null) ? (data.projectedSec-data.prevProjectedSec) : null;
  const projTrendHTML = (projTrendSec!=null && Math.abs(projTrendSec)>=1)
    ? (' <span style="color:'+(projTrendSec<0?'#5FA8A0':'#C1502E')+';">'+(projTrendSec<0?'&#9660;':'&#9650;')+' '+Math.abs(Math.round(projTrendSec))+'s</span> <span style="color:var(--dim);">(was '+formatMinutesToClock(data.prevProjectedSec/60)+')</span>')
    : '';
  const projectedNote = data.projectedSec ? ('<div class="note" style="border-top:none; padding-top:0; margin-top:2px; margin-bottom:4px; font-size:12px; color:var(--dim);">Current fitness projects to roughly <b style="color:var(--text);">'+formatMinutesToClock(data.projectedSec/60)+'</b>'+(data.projectedPaceSec?(' (<b style="color:var(--text);">'+fmtPace(data.projectedPaceSec)+'</b>)'):'')+projTrendHTML+'</div>') : '';
  return '<div class="card"><div class="sess-name" style="margin-bottom:2px; display:flex; justify-content:space-between; align-items:center;"><span>'+titleLabel+'</span>'+confBadge+'</div>'+
    '<div class="note" style="margin-top:4px; padding-top:0; border-top:none; margin-bottom:4px; font-size:13px;">'+data.label+actionBadge+'</div>'+
    projectedNote+
    svg+
    '<div class="note" style="font-size:10px; margin-top:0;">Synthesized from LT pace, aerobic efficiency, time-to-target, HR-recovery, and long-run decoupling trends where available'+freshness+' - a working estimate, not a lab measurement.</div></div>';
}
