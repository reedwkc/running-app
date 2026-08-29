import { state } from '../state.js';
import { getBestAvailableLTPace, getBestFitnessLTPace, getEfficiencyTrend, getLayoffAdjustment, getTrendSummary, loadTierEstimate, loadTierHistories } from './tier-estimates.js';
import { computeReadinessSignal } from './readiness.js';
// Re-exported so existing importers (tests included) can keep pulling the tier-merge logic
// from here - the merge itself now lives in tier-estimates.js so getBestFitnessLTPace can
// share it instead of the two functions independently re-implementing the same ranking.
export { getBestAvailableLTPace };
import { computeZones, threshold } from '../data/plan.js';
import { defaultGoalConfig, findGoalRaceDay } from '../data/goal-config.js';
import { parseDayTagDate, parseWeekEndDate, parseWeekStartDate } from '../lib/dates.js';
import { fmtDuration, fmtPace, fmtPaceExact, fmtTime, formatMinutesToClock, timeAgo } from '../lib/format.js';
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

const RACE_PREDICTION_DISTANCES = [
  {label:'5K', D:5},
  {label:'10K', D:10},
  {label:'Half Marathon', D:21.0975},
  {label:'Marathon', D:42.195},
];

// Powers the "Predicted race times" card (Progress page and Key Metrics page). Built on
// getBestAvailableLTPace's hybrid Tier 1/2/3 ranking - the same "most recent evidence"
// pace already used for the goal-trajectory projections above - and the same layoff
// pace-softening already applied to actual prescribed training paces (see recomputeZones),
// not a separate raw-Garmin-only number computed a different way that could quietly
// disagree with what the plan is actually prescribing. Previously this read
// state.profile.ltPaceSec directly, which meant it silently ignored a more current Tier
// 2/3 read (or a fresh post-illness Tier 1 read once that's the ruling one) and any active
// layoff softening - stale relative to whatever's actually driving training paces right now.
export async function computeRacePredictions(){
  const best = await getBestAvailableLTPace();
  if(best.ltPaceSec==null) return null;
  const layoffAdjustment = await getLayoffAdjustment();
  const effectiveLtPaceSec = layoffAdjustment ? Math.round(best.ltPaceSec*(1+layoffAdjustment.ltPacePenaltyPct/100)) : best.ltPaceSec;
  const rows = RACE_PREDICTION_DISTANCES.map(({label,D})=>{
    const time = projectedTimeFromLTPace(effectiveLtPaceSec, D);
    return {label, D, time, paceSec: time/D};
  });
  return {rows, ltPaceSec: effectiveLtPaceSec, source: best.source, updatedAt: best.updatedAt, layoffAdjustment};
}

// Shared markup for the "Predicted race times" card - identical on the Progress page and
// the Key Metrics page, so the two can never quietly disagree with each other the way the
// old Progress-only version (raw state.profile.ltPaceSec) could disagree with what Key
// Metrics shows as the actually-ruling tier.
export function racePredictionsHTML(data){
  if(!data || !data.rows) return '<div class="card"><div class="sess-name" style="margin-bottom:10px;">Predicted race times</div><div class="note">No LT pace evidence yet - update your Garmin numbers, or log and analyze a session, to see predictions here.</div></div>';
  const sourceLabel = data.source==='tier1' ? 'your Garmin numbers' : data.source==='tier2' ? 'recent outdoor sessions' : 'recent treadmill sessions';
  const freshness = data.updatedAt ? (', '+timeAgo(data.updatedAt)) : '';
  const layoffNote = data.layoffAdjustment ? (' Paces are temporarily softened '+data.layoffAdjustment.ltPacePenaltyPct+'% ('+data.layoffAdjustment.days+' days since your last logged activity) until fresh evidence lands.') : '';
  let html = '<div class="card"><div class="sess-name" style="margin-bottom:10px;">Predicted race times</div>';
  html += '<div class="note" style="border-top:none; padding-top:0; margin-bottom:10px;">Based on <b style="color:var(--text);">'+fmtPaceExact(data.ltPaceSec)+'</b> LT pace, from '+sourceLabel+freshness+'.'+layoffNote+'</div>';
  html += '<table class="pred-table"><tr><th>Distance</th><th>Est. time</th><th>Est. pace</th></tr>';
  data.rows.forEach(r=>{ html += '<tr><td>'+r.label+'</td><td>'+fmtDuration(r.time)+'</td><td>'+fmtPaceExact(r.paceSec)+'</td></tr>'; });
  html += '</table></div>';
  return html;
}

export function interpolateLinear(startDate, startVal, endDate, endVal, atDate){
  const total = endDate - startDate;
  if(total<=0) return endVal;
  const elapsed = atDate - startDate;
  const frac = Math.max(0, Math.min(1, elapsed/total));
  return startVal + (endVal-startVal)*frac;
}

// "What counts as a real, meaningful pace gap" - one constant reused everywhere that
// question comes up (the position formula's sensitivity floor, achievability's
// already-there gate), instead of an unrelated magic number in each place separately.
export const MEANINGFUL_FINISH_GAP_SEC = 60;

// Thresholds for evaluateAheadOfSchedule below - "bound don't block, named tiers" house
// style, same as estimateLayoffImpact/importanceForGoalDistance in the other coach files.
// AHEAD_MEANINGFUL_POSITION: real margin past the passive on-track/ahead line (67) used by
// computeGoalPosition's own status label - a push suggestion is a bigger ask than a badge.
// PUSH_MIN_BUILD_DAYS_REMAINING: mirrors the behind-side "not-enough-time" concept - a
// taper week or the final ~2 weeks before race day is the wrong moment to suggest adding
// load, however good the pace trend looks.
// AHEAD_ACCELERATION_BAR: achievability.accelerationFactor (observed trend rate divided by
// the rate actually required) must beat the requirement by a real margin, not just meet it.
export const AHEAD_MEANINGFUL_POSITION = 75;
export const PUSH_MIN_BUILD_DAYS_REMAINING = 14;
export const AHEAD_ACCELERATION_BAR = 1.3;

// Day-by-day breakdown of [startDate, raceDate) into "build" vs "cutback/taper" days, based
// on which state.WEEKS week (if any) covers each day - a taper/recovery week is expected to
// HOLD fitness, not build it, so it shouldn't count as runway to close a gap, nor as
// "elapsed schedule" demanding the gap already be closed. A day outside any known week
// defaults to "build" (the safe, inclusive default) - this is also what makes the whole
// thing degrade automatically to plain calendar-day counting when weeks is empty/doesn't
// cover the window, with no separate fallback path needed.
export function computeBuildDaysBreakdown(weeks, startDate, raceDate, now){
  now = now || new Date();
  const totalMs = raceDate.getTime()-startDate.getTime();
  if(!isFinite(totalMs) || totalMs<=0){
    return {buildDaysTotal:0, buildDaysElapsed:0, buildDaysRemaining:0, elapsedFrac:1};
  }
  const weekRanges = (weeks||[]).map(w=>({start:parseWeekStartDate(w), end:parseWeekEndDate(w), cutback:!!w.cutback})).filter(r=>r.start&&r.end);
  const isCutbackDay = (date) => {
    const r = weekRanges.find(r=>date>=r.start && date<=r.end);
    return !!(r && r.cutback);
  };
  let buildDaysTotal = 0, buildDaysElapsed = 0;
  const cursor = new Date(startDate); cursor.setHours(0,0,0,0);
  const end = new Date(raceDate); end.setHours(0,0,0,0);
  const today = new Date(now); today.setHours(0,0,0,0);
  while(cursor < end){
    if(!isCutbackDay(cursor)){
      buildDaysTotal++;
      if(cursor < today) buildDaysElapsed++;
    }
    cursor.setDate(cursor.getDate()+1);
  }
  const elapsedFrac = buildDaysTotal>0
    ? Math.max(0, Math.min(1, buildDaysElapsed/buildDaysTotal))
    : Math.max(0, Math.min(1, (now.getTime()-startDate.getTime())/totalMs));
  return {buildDaysTotal, buildDaysElapsed, buildDaysRemaining: Math.max(0, buildDaysTotal-buildDaysElapsed), elapsedFrac};
}

// Shared math behind both goal trackers' "how are we tracking against the timeline" read:
// the gap is expected to close linearly from startGapSec to 0 as REAL BUILD time (not raw
// calendar time - see computeBuildDaysBreakdown) elapses; position 50 means the current gap
// matches that expectation exactly, 0/100 are the extremes of meaningfully behind/ahead.
// Both startGapSec and currentGapSec MUST already be Riegel-consistent (LT pace minus
// impliedLTPaceForGoal(...), never a goal's raw literal race-pace) - mixing units here is
// the root cause a "strong ahead despite a real gap" reading traced back to.
// normFactor's floor is MEANINGFUL_FINISH_GAP_SEC converted to sec/km for this race's
// distance (replacing a prior unrelated flat "5") - ties the position scale's sensitivity to
// the same "what counts as a real gap" definition used elsewhere in this file.
export function computeGoalPosition(startGapSec, elapsedFrac, currentGapSec, distanceKm){
  elapsedFrac = Math.max(0, Math.min(1, elapsedFrac||0));
  const expectedGapNow = startGapSec*(1-elapsedFrac);
  const aheadBehind = expectedGapNow - currentGapSec;
  const meaningfulGapPerKm = MEANINGFUL_FINISH_GAP_SEC/(distanceKm||21.0975);
  const normFactor = Math.max(Math.abs(startGapSec)*0.5, meaningfulGapPerKm);
  let position = 50 + (aheadBehind/normFactor)*50;
  position = Math.max(0, Math.min(100, position));
  const status = position<33 ? 'behind' : position>67 ? 'ahead' : 'on track';
  return {position, status, aheadBehindSec: aheadBehind};
}

// Merges Tier1+2+3 pace history into one date-sorted series, excluding any point whose date
// falls inside a cutback:true week - a taper/recovery dip or plateau is expected there, not
// a real fitness signal, and counting it would bias the trend rate. extraPoints (e.g. the
// 10K-checkpoint-recalibrated value below) are appended AFTER filtering and never excluded -
// deliberately curated evidence, not routine noise.
export function buildMergedLTPaceSeries(tier1Hist, tier2Hist, tier3Hist, weeks, extraPoints){
  const weekRanges = (weeks||[]).map(w=>({start:parseWeekStartDate(w), end:parseWeekEndDate(w), cutback:!!w.cutback})).filter(r=>r.start&&r.end);
  const isCutbackDate = (date) => {
    const r = weekRanges.find(r=>date>=r.start && date<=r.end);
    return !!(r && r.cutback);
  };
  const merged = [].concat(tier1Hist||[], tier2Hist||[], tier3Hist||[])
    .filter(p=>p && p.ltPaceSec!=null && p.date)
    .map(p=>({date:new Date(p.date), ltPaceSec:p.ltPaceSec}))
    .filter(p=>isFinite(p.date.getTime()) && !isCutbackDate(p.date));
  (extraPoints||[]).forEach(p=>{
    if(!p || p.ltPaceSec==null || !p.date) return;
    merged.push({date: p.date instanceof Date ? p.date : new Date(p.date), ltPaceSec: p.ltPaceSec});
  });
  merged.sort((a,b)=>a.date-b.date);
  return merged;
}

const TREND_MIN_POINTS = 4;
const TREND_MIN_SPAN_DAYS = 14;

// Real per-week rate of LT pace change (sec/km per week, positive = IMPROVING/faster), from
// a merged series. Median-split (median of the chronologically-first half vs. median of the
// second half) rather than a least-squares regression slope - this codebase's one existing
// trend precedent (getTrendSummary/getEfficiencyTrend in tier-estimates.js) already uses
// median-of-recent-vs-prior-window specifically for robustness to one noisy/misread session,
// and a median split is far easier to sanity-check by eye than a regression coefficient.
// Requires a minimum point count AND date span - below either, a week-scale rate isn't
// meaningful, so this returns null and callers degrade gracefully rather than showing a
// wild or overconfident number off 2-3 points spanning a few days.
export function computeLTPaceTrendRate(points){
  if(!points || points.length<TREND_MIN_POINTS) return null;
  const sorted = points.slice().sort((a,b)=>a.date-b.date);
  const spanDays = (sorted[sorted.length-1].date-sorted[0].date)/86400000;
  if(spanDays<TREND_MIN_SPAN_DAYS) return null;
  const mid = Math.floor(sorted.length/2);
  const firstHalf = sorted.slice(0, mid), secondHalf = sorted.slice(mid);
  const median = arr => { const s=arr.slice().sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
  const firstMedianPace = median(firstHalf.map(p=>p.ltPaceSec));
  const secondMedianPace = median(secondHalf.map(p=>p.ltPaceSec));
  const firstMedianDate = median(firstHalf.map(p=>p.date.getTime()));
  const secondMedianDate = median(secondHalf.map(p=>p.date.getTime()));
  const daysBetween = (secondMedianDate-firstMedianDate)/86400000;
  if(daysBetween<=0) return null;
  const rateSecPerWeek = ((firstMedianPace-secondMedianPace)/daysBetween)*7;
  return {rateSecPerWeek, pointCount: sorted.length, spanDays: Math.round(spanDays)};
}

// Deterministic "is this goal achievable at the current trend, given the time left"
// classification - the first genuine, reusable answer to that question in this codebase
// (previously only a soft, unenforced "let actionFlag inform whether a rebuild is
// warranted" instruction to the LLM, with zero code-level effect). currentGapSec must
// already be Riegel-consistent (see computeGoalPosition); buildDaysRemaining/
// trendRateSecPerWeek come from computeBuildDaysBreakdown/computeLTPaceTrendRate.
// How far the observed trend must miss the required rate before a "needs-to-accelerate"
// read counts as genuinely concerning rather than a normal, closable ask - shared by the
// plan-override achievability-enforcement check and the post-workout achievability
// watchdog below, so both agree on exactly the same bar for "this goal looks unreachable."
export const ACHIEVABILITY_ACCELERATION_WARN_FACTOR = 1.5;

// The single, shared answer to "is this achievability reading actually concerning" -
// not-enough-time and not-closing are concerning on their own; needs-to-accelerate only
// counts once the required rate is missed by a real margin, not just barely.
// insufficient-data/already-there/on-pace are never concerning by themselves.
export function isGoalAchievabilityConcerning(a){
  return !!(a && (a.classification==='not-enough-time' || a.classification==='not-closing' ||
    (a.classification==='needs-to-accelerate' && a.accelerationFactor!=null && a.accelerationFactor>=ACHIEVABILITY_ACCELERATION_WARN_FACTOR)));
}

export function computeGoalAchievability(currentGapSec, buildDaysRemaining, trendRateSecPerWeek, distanceKm){
  const meaningfulGapPerKm = MEANINGFUL_FINISH_GAP_SEC/(distanceKm||21.0975);
  const base = {observedRateSecPerWeek: trendRateSecPerWeek, buildDaysRemaining, gapSec: currentGapSec||0};
  if(currentGapSec==null || currentGapSec<=meaningfulGapPerKm){
    return Object.assign(base, {classification:'already-there', requiredRateSecPerWeek:0, accelerationFactor:null});
  }
  if(buildDaysRemaining<=0){
    return Object.assign(base, {classification:'not-enough-time', requiredRateSecPerWeek:Infinity, accelerationFactor:null});
  }
  const requiredRateSecPerWeek = currentGapSec/(buildDaysRemaining/7);
  if(trendRateSecPerWeek==null){
    return Object.assign(base, {classification:'insufficient-data', requiredRateSecPerWeek, accelerationFactor:null});
  }
  if(trendRateSecPerWeek<=0){
    return Object.assign(base, {classification:'not-closing', requiredRateSecPerWeek, accelerationFactor:null});
  }
  if(trendRateSecPerWeek>=requiredRateSecPerWeek){
    return Object.assign(base, {classification:'on-pace', requiredRateSecPerWeek, accelerationFactor: trendRateSecPerWeek/requiredRateSecPerWeek});
  }
  return Object.assign(base, {classification:'needs-to-accelerate', requiredRateSecPerWeek, accelerationFactor: requiredRateSecPerWeek/trendRateSecPerWeek});
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
// and the trajectory prompt sent to the coach are always looking at the same number(s).
// goal: the activeGoals entry (zoneKey 'GOAL') this baseline is for, or null if no such
// goal is currently active (e.g. a raceless maintenance phase) - returns a neutral
// sentinel immediately in that case rather than computing against a nonexistent race.
// checkpointGoal: an earlier goal (typically the 10K) whose actual result, once run,
// recalibrates this trajectory's starting point instead of trusting the original
// block-start estimate - optional, only meaningful when that earlier race has already
// happened. That same recalibrated value also becomes a real, dated point in the trend
// series (see buildMergedLTPaceSeries) instead of only affecting the position anchor.
export async function computeHMTrajectoryBaseline(goal, checkpointGoal){
  if(!goal || !goal.raceDate) return {position:50, status:'neutral', label:'No active goal to gauge trend against right now.', source:null};
  let history = [];
  try{ const r = await window.storage.get('profile-history', false); if(r) history = JSON.parse(r.value); }catch(e){}
  // Always the Riegel-implied LT-pace-equivalent of the goal, never goal.goalPaceSec (the
  // goal's literal RACE-pace target, used elsewhere for session prescriptions) - comparing
  // best.ltPaceSec against the raw race pace instead of its LT-equivalent was a real,
  // confirmed ~10s/km unit mismatch that fed directly into "the gauge disagrees with the
  // 'current fitness projects to' number," since that display already used this conversion.
  const goalImpliedLTPace = Math.round(impliedLTPaceForGoal(goal.goalTimeSec||95*60, goal.distanceKm||21.0975));
  const best = await getBestAvailableLTPace();
  const currentGap = best.ltPaceSec!=null ? (best.ltPaceSec - goalImpliedLTPace) : null;
  if(!history.length || currentGap==null){
    return {position:50, status:'neutral', label:'Not enough threshold history yet to gauge trend - showing neutral until your LT pace updates again.', source:best.source};
  }
  const first = history[0];
  let trajStartGap = first.ltPaceSec - goalImpliedLTPace;
  let trajStartDate = new Date(first.date);
  const raceDate = new Date(goal.raceDate);
  let checkpointNote = '';
  let checkpointExtraPoint = null;
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
          trajStartGap = impliedFromRace - goalImpliedLTPace;
          trajStartDate = checkpointDate;
          checkpointNote = ' (recalibrated using your actual '+(checkpointGoal.label||checkpointGoal.type||'checkpoint')+' result)';
          checkpointExtraPoint = {date: checkpointDate, ltPaceSec: impliedFromRace};
        }
      }
    }
  }
  const distanceKm = goal.distanceKm||21.0975;
  const {buildDaysRemaining, elapsedFrac} = computeBuildDaysBreakdown(state.WEEKS, trajStartDate, raceDate);
  const {position, status, aheadBehindSec} = computeGoalPosition(trajStartGap, elapsedFrac, currentGap, distanceKm);
  const {tier1Hist, tier2Hist, tier3Hist} = await loadTierHistories();
  const series = buildMergedLTPaceSeries(tier1Hist, tier2Hist, tier3Hist, state.WEEKS, checkpointExtraPoint ? [checkpointExtraPoint] : null);
  const trend = computeLTPaceTrendRate(series);
  const achievability = computeGoalAchievability(currentGap, buildDaysRemaining, trend ? trend.rateSecPerWeek : null, distanceKm);
  const goalDesc = (goal.goalTimeLabel||'the goal').toLowerCase();
  let label;
  if(status==='behind') label = 'Behind pace for '+goalDesc+' given time remaining'+checkpointNote+' - threshold needs to move faster from here.';
  else if(status==='ahead') label = 'Ahead of where you need to be for '+goalDesc+checkpointNote+' - the gap is closing faster than the timeline requires.';
  else label = 'On track for '+goalDesc+' given time remaining'+checkpointNote+'.';
  return {position, status, aheadBehindSec, label, source:best.source, trend, achievability};
}

export async function compute10KTrajectoryBaseline(goal){
  if(!goal || !goal.raceDate) return {position:50, status:'neutral', label:'No active goal to gauge trend against right now.', source:null};
  let history = [];
  try{ const r = await window.storage.get('profile-history', false); if(r) history = JSON.parse(r.value); }catch(e){}
  const goalImpliedLTPace = Math.round(impliedLTPaceForGoal(goal.goalTimeSec||43*60, goal.distanceKm||10));
  const best = await getBestAvailableLTPace();
  const currentGap = best.ltPaceSec!=null ? (best.ltPaceSec - goalImpliedLTPace) : null;
  if(!history.length || currentGap==null){
    return {position:50, status:'neutral', label:'Not enough threshold history yet to gauge trend - showing neutral until your LT pace updates again.', source:best.source};
  }
  const first = history[0];
  const startGap = first.ltPaceSec - goalImpliedLTPace;
  const startDate = new Date(first.date);
  const raceDate = new Date(goal.raceDate);
  const distanceKm = goal.distanceKm||10;
  const {buildDaysRemaining, elapsedFrac} = computeBuildDaysBreakdown(state.WEEKS, startDate, raceDate);
  const {position, status, aheadBehindSec} = computeGoalPosition(startGap, elapsedFrac, currentGap, distanceKm);
  const {tier1Hist, tier2Hist, tier3Hist} = await loadTierHistories();
  const series = buildMergedLTPaceSeries(tier1Hist, tier2Hist, tier3Hist, state.WEEKS, null);
  const trend = computeLTPaceTrendRate(series);
  const achievability = computeGoalAchievability(currentGap, buildDaysRemaining, trend ? trend.rateSecPerWeek : null, distanceKm);
  const goalDesc = (goal.goalTimeLabel||'the goal').toLowerCase();
  let label;
  if(status==='behind') label = 'Behind pace for '+goalDesc+' given time remaining - threshold needs to move faster from here.';
  else if(status==='ahead') label = 'Ahead of where you need to be for '+goalDesc+' - the gap is closing faster than the timeline requires.';
  else label = 'On track for '+goalDesc+' given time remaining.';
  return {position, status, aheadBehindSec, label, source:best.source, trend, achievability};
}

// Mirror image of the behind-schedule detectors (plan-adherence.js's missed-session gap
// checks, this file's own computeGoalAchievability): is this runner genuinely AHEAD of
// schedule, backed by REAL corroborating evidence, with real time and physiological
// headroom to safely push harder - not just "the position number crossed 67." Takes an
// already-computed HM or 10K baseline (never recomputes it - same separation of concerns
// as validatePlanOverride's existing achievability-enforcement check in plan-override.js)
// plus the readiness signal (readiness.js). Returns null (not eligible) or a signal object.
//
// Two hard gates (AND, not part of the corroboration count below):
// - readiness.status!=='overreaching' - never invite more load onto a body already
//   flashing fatigue signals, regardless of how good the pace trend looks.
// - achievability.buildDaysRemaining >= PUSH_MIN_BUILD_DAYS_REMAINING - real runway left to
//   safely progress load and let the runner absorb it, not the final taper stretch.
//
// Then requires at least 2 of 3 independent signals to agree (mirrors readiness.js's own
// "don't let one noisy metric decide" philosophy):
//   1. position is meaningfully ahead (>=AHEAD_MEANINGFUL_POSITION), not barely past the
//      passive "ahead" line.
//   2. a REAL, data-backed positive trend exists (trend && rateSecPerWeek>0) - deliberately
//      independent of position, since achievability's 'already-there' classification can
//      fire off a single stale gap reading with ZERO trend evidence (its check runs before
//      any trend check in computeGoalAchievability).
//   3. achievability classification is 'on-pace' (NOT 'already-there' - see above) with
//      accelerationFactor beating AHEAD_ACCELERATION_BAR - beating the required rate by a
//      real margin, not just matching it.
export function evaluateAheadOfSchedule(baseline, readiness){
  if(!baseline || baseline.status==='neutral' || !baseline.achievability) return null;
  if(readiness && readiness.status==='overreaching') return null;
  const a = baseline.achievability;
  if(a.buildDaysRemaining==null || a.buildDaysRemaining < PUSH_MIN_BUILD_DAYS_REMAINING) return null;

  const positionSignal = baseline.position>=AHEAD_MEANINGFUL_POSITION;
  const trendSignal = !!(baseline.trend && baseline.trend.rateSecPerWeek>0);
  const accelerationSignal = a.classification==='on-pace' && a.accelerationFactor!=null && a.accelerationFactor>=AHEAD_ACCELERATION_BAR;
  const signalCount = [positionSignal, trendSignal, accelerationSignal].filter(Boolean).length;
  if(signalCount<2) return null;

  return {
    position: baseline.position,
    aheadBehindSec: baseline.aheadBehindSec,
    trend: baseline.trend,
    buildDaysRemaining: a.buildDaysRemaining,
    classification: a.classification,
    accelerationFactor: a.accelerationFactor,
    signals: {positionSignal, trendSignal, accelerationSignal},
    label: baseline.label,
  };
}

// Runs evaluateAheadOfSchedule against both goal slots that have real trajectory math
// (GOAL and RACE10K - see compute10KTrajectoryBaseline/computeHMTrajectoryBaseline; a
// raceless maintenance phase has no achievability concept at all, see
// computeMaintenanceBaseline below, so it's not evaluated here). Mutual exclusion with the
// deficit-side missed-session rebalance: a missed, already-happened session is a more
// concrete fact than a projected pace trend, so if a SIGNIFICANT missed-session pattern is
// currently flagged, this returns [] immediately rather than showing a "you're behind on
// sessions" banner and a "push harder" banner at the same time - contradictory, not
// nuanced. Enforced here at the data layer (not just at render time) so every caller
// (main.js, week-view.js's refreshAdherenceBanners, plan-override.js's
// refreshAdherenceState) gets it for free.
export async function computeAheadOfScheduleSignals(){
  try{
    const hasSignificantMiss = (state.missedSessionAdjustments||[]).some(a=>a.severity==='significant');
    if(hasSignificantMiss) return [];

    let readiness = null;
    try{ readiness = await computeReadinessSignal(); }catch(e){}

    const results = [];
    const hmGoal = activeGoal('GOAL');
    if(hmGoal){
      const tenKGoal = activeGoal('RACE10K');
      const hmBaseline = await computeHMTrajectoryBaseline(hmGoal, tenKGoal);
      const sig = evaluateAheadOfSchedule(hmBaseline, readiness);
      if(sig) results.push(Object.assign(sig, {zoneKey:'GOAL', goalLabel: hmGoal.label||'the goal', goalTimeLabel: hmGoal.goalTimeLabel||'', distanceKm: hmGoal.distanceKm||21.0975}));
    }
    const tenKGoal = activeGoal('RACE10K');
    if(tenKGoal){
      const tenKBaseline = await compute10KTrajectoryBaseline(tenKGoal);
      const sig = evaluateAheadOfSchedule(tenKBaseline, readiness);
      if(sig) results.push(Object.assign(sig, {zoneKey:'RACE10K', goalLabel: tenKGoal.label||'10K', goalTimeLabel: tenKGoal.goalTimeLabel||'', distanceKm: tenKGoal.distanceKm||10}));
    }
    return results;
  }catch(e){ console.error('computeAheadOfScheduleSignals failed', e); return []; }
}

// A single reading is never enough to interrupt a workout log with a watchdog callout -
// mirrors MIN_MISSED_TO_FLAG=2 in plan-adherence.js's own "one occurrence isn't a
// pattern" rule. Once confirmed, reiterate an unresolved concern roughly weekly - often
// enough it can't be forgotten, not so often it reads as nagging on every session.
const WATCHDOG_CONFIRM_THRESHOLD = 2;
const WATCHDOG_RESHOW_DAYS = 7;

// Shared confirm/dedup semantics for every deterministic, chat-injected watchdog
// (achievability below, and the ahead-of-schedule push watchdog) - mirrors
// getLayoffAdjustment's (tier-estimates.js) persist-until-resolved episode pattern, plus
// the confirm-threshold above. Mutates `episodes` in place; callers persist once after
// processing every zone. `signalId` is a short fingerprint of "which flavor" the current
// read is (e.g. an achievability classification) - a change while already confirmed
// reshows immediately, since that's materially new information, but a change while still
// UNCONFIRMED just updates the fingerprint and keeps counting toward confirmation rather
// than resetting it, so two different-flavored-but-still-concerning reads in a row still
// confirm the underlying concern instead of stalling it forever.
function evaluateWatchdogZone(episodes, zoneKey, eligibleNow, signalId, now){
  const existing = episodes[zoneKey];
  if(!eligibleNow){
    if(existing){ delete episodes[zoneKey]; return {show:false, changed:true}; }
    return {show:false, changed:false};
  }
  if(!existing){
    episodes[zoneKey] = {signalId, confirmCount:1, firstDetectedAt:new Date(now).toISOString(), lastShownAt:null};
    return {show:false, changed:true};
  }
  if(existing.confirmCount < WATCHDOG_CONFIRM_THRESHOLD){
    existing.confirmCount++;
    existing.signalId = signalId;
    const confirmed = existing.confirmCount>=WATCHDOG_CONFIRM_THRESHOLD;
    if(confirmed) existing.lastShownAt = new Date(now).toISOString();
    return {show:confirmed, changed:true};
  }
  const daysSinceShown = existing.lastShownAt ? (now-new Date(existing.lastShownAt).getTime())/86400000 : Infinity;
  if(existing.signalId!==signalId || daysSinceShown>=WATCHDOG_RESHOW_DAYS){
    existing.signalId = signalId;
    existing.lastShownAt = new Date(now).toISOString();
    return {show:true, changed:true};
  }
  return {show:false, changed:false};
}

const ACHIEVABILITY_EPISODES_KEY = 'achievability-warning-episodes';

// The post-workout "watchdog" for an unreachable goal - deliberately deterministic, not
// LLM-dependent, so it can never be missed by a coach reply that simply didn't happen to
// mention it. Called from exactly one place (chat.js's autoCoachMessage, right after
// every logged/skipped session) - the storage write below is a real side effect tied to
// actually evaluating the watchdog, so this must not be called anywhere that wouldn't
// also display its result.
export async function computeAchievabilityWarnings(){
  try{
    let episodes = {};
    try{ const r = await window.storage.get(ACHIEVABILITY_EPISODES_KEY, false); if(r) episodes = JSON.parse(r.value); }catch(e){}
    const now = Date.now();
    let changed = false;
    const warnings = [];

    async function checkZone(zoneKey, goal, baseline, distanceKmDefault){
      const concerning = isGoalAchievabilityConcerning(baseline.achievability);
      const classification = concerning ? baseline.achievability.classification : null;
      const result = evaluateWatchdogZone(episodes, zoneKey, concerning, classification, now);
      if(result.changed) changed = true;
      if(!result.show) return;
      let realisticTimeLabel = null;
      try{
        const best = await getBestAvailableLTPace();
        if(best.ltPaceSec!=null){
          const projectedSec = projectedTimeFromLTPace(best.ltPaceSec, goal.distanceKm||distanceKmDefault);
          realisticTimeLabel = formatMinutesToClock(projectedSec/60);
        }
      }catch(e){}
      warnings.push({
        zoneKey, goalLabel: goal.label||(zoneKey==='GOAL'?'the goal':'10K'), currentGoalTimeLabel: goal.goalTimeLabel||'',
        classification, reasonText: formatAchievabilityNote(baseline.achievability).trim(), realisticTimeLabel,
        distanceKm: goal.distanceKm||distanceKmDefault,
      });
    }

    const hmGoal = activeGoal('GOAL');
    if(hmGoal){
      const tenKGoal = activeGoal('RACE10K');
      await checkZone('GOAL', hmGoal, await computeHMTrajectoryBaseline(hmGoal, tenKGoal), 21.0975);
    }
    const tenKGoal = activeGoal('RACE10K');
    if(tenKGoal){
      await checkZone('RACE10K', tenKGoal, await compute10KTrajectoryBaseline(tenKGoal), 10);
    }

    if(changed){
      try{ await saveWithRetry(ACHIEVABILITY_EPISODES_KEY, episodes, false); }catch(e){}
    }
    return warnings;
  }catch(e){ console.error('computeAchievabilityWarnings failed', e); return []; }
}

const PUSH_WATCHDOG_EPISODES_KEY = 'push-watchdog-episodes';

// The symmetric watchdog for the ahead-of-schedule direction - a thin wrapper, not a new
// detector: computeAheadOfScheduleSignals() (unchanged) remains fully responsible for
// eligibility (its own 2-of-3 signal corroboration inside evaluateAheadOfSchedule stays
// exactly as-is) - this just adds a second, across-session confirmation layer on top,
// same evaluateWatchdogZone semantics as the achievability watchdog above, so the two can
// never quietly disagree about what "fire on good grounds" means. Called from exactly one
// place (chat.js's autoCoachMessage), same reasoning as computeAchievabilityWarnings.
export async function computeAheadOfScheduleWarnings(){
  try{
    const signals = await computeAheadOfScheduleSignals();
    let episodes = {};
    try{ const r = await window.storage.get(PUSH_WATCHDOG_EPISODES_KEY, false); if(r) episodes = JSON.parse(r.value); }catch(e){}
    const now = Date.now();
    let changed = false;
    const warnings = [];
    // Check both possible zones explicitly (not just whatever's currently in `signals`) -
    // a zone that WAS eligible last time but isn't anymore still needs its stale episode
    // cleared, same as computeAchievabilityWarnings' explicit not-concerning branch.
    ['GOAL', 'RACE10K'].forEach(zoneKey=>{
      const sig = signals.find(s=>s.zoneKey===zoneKey);
      const result = evaluateWatchdogZone(episodes, zoneKey, !!sig, sig ? sig.classification : null, now);
      if(result.changed) changed = true;
      if(result.show && sig) warnings.push(sig);
    });
    if(changed){
      try{ await saveWithRetry(PUSH_WATCHDOG_EPISODES_KEY, episodes, false); }catch(e){}
    }
    return warnings;
  }catch(e){ console.error('computeAheadOfScheduleWarnings failed', e); return []; }
}

// A raceless maintenance phase has no fixed target/deadline to interpolate a gap toward
// the way computeGoalPosition does for a race - the useful question instead is "given the
// actual observed rate of change, is fitness holding, improving, or slipping." Takes a real
// per-week rate (from computeLTPaceTrendRate) rather than a fragile single-point-then vs.
// single-point-now comparison - the same median-split robustness fix applied to the race
// gauges now applies here too, since a maintenance phase is just as vulnerable to one noisy
// session swinging a two-point comparison. rateSecPerWeek>0 means pace is getting FASTER
// (improving). normFactor (2s/km/week) is chosen to land close to the old model's real-world
// sensitivity (that model's ~3%-of-pace-or-3s-floor delta over the ~28-day window worked out
// to roughly 2s/km/week for a typical threshold pace) while now being expressed as a rate,
// consistent with the achievability trend-rate units used elsewhere in this file.
export function computeMaintenanceTrend(rateSecPerWeek){
  if(rateSecPerWeek==null) return {position:50, status:'neutral'};
  const normFactor = 2;
  let position = 50 + (rateSecPerWeek/normFactor)*50;
  position = Math.max(0, Math.min(100, position));
  const status = position<33 ? 'declining' : position>67 ? 'improving' : 'holding steady';
  return {position, status};
}

const MAINTENANCE_TREND_WINDOW_DAYS = 28;
// Wider than the window described in the label - computeLTPaceTrendRate needs a real span to
// median-split, and a bare 28 days often won't clear its >=14-day/>=4-point minimums on a
// maintenance-phase training frequency. Widening the LOOKBACK (not the label - the label
// still describes the ~28-day read a runner actually cares about) gives the trend calc
// enough data without changing what's being communicated.
const MAINTENANCE_TREND_LOOKBACK_DAYS = 56;

// Deterministic "how's fitness holding up" baseline for a raceless maintenance phase - same
// role computeHMTrajectoryBaseline/compute10KTrajectoryBaseline play for a race, just
// anchored to a rolling recent window instead of a block-start-to-race-day timeline (there's
// no race day to interpolate toward, and no achievability concept - there's no goal to fall
// short of in maintenance). Reuses the same merged Tier1/2/3 series + cutback-week exclusion
// as the race gauges (buildMergedLTPaceSeries/computeLTPaceTrendRate) rather than reading
// Tier 1 profile-history alone - a maintenance phase happening mid-winter, when Tier 3 is the
// primary fresh signal, would otherwise judge the trend off stale Tier 1 updates while
// ignoring exactly the evidence that matters most.
export async function computeMaintenanceBaseline(){
  const best = await getBestAvailableLTPace();
  if(best.ltPaceSec==null){
    return {position:50, status:'neutral', label:'Not enough threshold data yet to gauge a maintenance trend - showing neutral until your LT pace updates again.', source:best.source};
  }
  const {tier1Hist, tier2Hist, tier3Hist} = await loadTierHistories();
  const series = buildMergedLTPaceSeries(tier1Hist, tier2Hist, tier3Hist, state.WEEKS, null);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-MAINTENANCE_TREND_LOOKBACK_DAYS);
  const recentSeries = series.filter(p=>p.date>=cutoff);
  const trend = computeLTPaceTrendRate(recentSeries);
  const {position, status} = computeMaintenanceTrend(trend ? trend.rateSecPerWeek : null);
  let label;
  if(status==='declining') label = 'Fitness trending down over the last ~'+MAINTENANCE_TREND_WINDOW_DAYS+' days - worth checking whether maintenance volume/consistency needs a bump.';
  else if(status==='improving') label = 'Fitness trending up over the last ~'+MAINTENANCE_TREND_WINDOW_DAYS+' days - genuine gains, if this holds over more sessions.';
  else if(status==='holding steady') label = 'Fitness holding steady over the last ~'+MAINTENANCE_TREND_WINDOW_DAYS+' days - exactly the point of a maintenance phase.';
  else label = 'Not enough clean, recent pace history yet to gauge a maintenance trend - showing neutral until more sessions land.';
  return {position, status, label, source:best.source, trend};
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
  const trajectoryContext = ' For the maintenance fitness-trend synthesis below (no active race goal right now, so this replaces the usual goal-trajectory read): current best-available LT pace is '+(best.ltPaceSec!=null?fmtPaceExact(best.ltPaceSec):'unknown')+' (from '+best.source+', '+(best.updatedAt?timeAgo(best.updatedAt):'no date')+').'+(effTrend?(' Aerobic efficiency trend: '+(effTrend.pctChange>=0?'+':'')+effTrend.pctChange.toFixed(1)+'% recent vs prior.'):'')+' The deterministic ~'+MAINTENANCE_TREND_WINDOW_DAYS+'-day trend baseline (a real per-week rate of change, median-split across merged Tier 1/2/3 pace history with any cutback week excluded - no target/deadline involved, since this is a raceless maintenance phase) computes to position '+Math.round(baseline.position)+'/100 ('+baseline.status+') on its own.'+formatTrendNote(baseline.trend)+prevNote;
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

// Renders computeLTPaceTrendRate's result as a hard fact for the coach prompt - stated,
// not left for the model to re-derive or eyeball from the raw numbers.
function formatTrendNote(trend){
  if(!trend) return ' Not enough clean, non-taper pace history yet to compute a reliable weekly trend rate.';
  const dir = trend.rateSecPerWeek>=0 ? 'improving' : 'slowing';
  return ' Threshold pace has moved roughly '+Math.abs(trend.rateSecPerWeek).toFixed(1)+'s/km per week ('+dir+') over the last '+trend.spanDays+' days of real (non-taper) training evidence ('+trend.pointCount+' points).';
}

// Renders computeGoalAchievability's classification as a hard fact, one short sentence per
// classification - this is the deterministic "is the goal reachable from here, given the
// time actually left" answer the coach used to have to reconstruct itself from raw numbers.
export function formatAchievabilityNote(a){
  if(!a) return '';
  switch(a.classification){
    case 'already-there':
      return ' Current fitness already meets or beats the pace this goal needs.';
    case 'not-enough-time':
      return ' There are no real build days left before race day and a gap of ~'+Math.round(a.gapSec)+'s/km is still open - this is not realistically closeable through training alone at this point, only through pacing/race-day strategy.';
    case 'not-closing':
      return ' The observed trend is flat or moving the wrong way despite '+a.buildDaysRemaining+' real build days still left - at the CURRENT trend this gap is not on track to close.';
    case 'insufficient-data':
      return ' Not enough trend data yet to judge whether the gap is closing fast enough - treat the position above as the primary signal for now.';
    case 'on-pace':
      return ' The observed trend ('+a.observedRateSecPerWeek.toFixed(1)+'s/km/week) is closing the gap at least as fast as the ~'+a.requiredRateSecPerWeek.toFixed(1)+'s/km/week needed over the '+a.buildDaysRemaining+' real build days left - achievable at the current trajectory.';
    case 'needs-to-accelerate':
      return ' The observed trend ('+a.observedRateSecPerWeek.toFixed(1)+'s/km/week) would need to run roughly '+a.accelerationFactor.toFixed(1)+'x faster (~'+a.requiredRateSecPerWeek.toFixed(1)+'s/km/week) to close the remaining ~'+Math.round(a.gapSec)+'s/km gap over the '+a.buildDaysRemaining+' real build days left - achievable, but only with a genuine step up in training stimulus, not just staying the course.';
    default:
      return '';
  }
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
  // Riegel-implied LT-pace-equivalent, same fix as computeHMTrajectoryBaseline - never
  // hmGoal.goalPaceSec (the literal race-pace target) here either, or this narrative
  // sentence would disagree with the baseline position computed two lines below it.
  const goalPaceSec = Math.round(impliedLTPaceForGoal(hmGoal.goalTimeSec||95*60, hmGoal.distanceKm||21.0975));
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
  const trajectoryContext = ' For the goal trajectory synthesis below: current best-available LT pace is '+(bestLT.ltPaceSec!=null?fmtPaceExact(bestLT.ltPaceSec):'unknown')+' (from '+bestLT.source+', '+(bestLT.updatedAt?timeAgo(bestLT.updatedAt):'no date')+'), which is '+(ltGapSec!=null?(Math.abs(ltGapSec)+'s/km '+(ltGapSec>0?'slower than':'at or faster than')+' the ~'+fmtPace(goalPaceSec)+' pace implied by the '+goalLabel+' goal'):'not yet established')+'.'+(effTrend?(' Aerobic efficiency trend: '+(effTrend.pctChange>=0?'+':'')+effTrend.pctChange.toFixed(1)+'% recent vs prior.'):'')+(tttTrend&&tttTrend.pctChange!=null?(' Time-to-target-HR trend: '+(tttTrend.pctChange<=0?'faster (improving) ':'slower ')+'by '+Math.abs(tttTrend.pctChange).toFixed(0)+'%.'):'')+(hrrTrend&&hrrTrend.pctChange!=null?(' HR recovery trend: '+(hrrTrend.pctChange>=0?'improving':'declining')+' by '+Math.abs(hrrTrend.pctChange).toFixed(0)+'%.'):'')+(decoupTrend&&decoupTrend.pctChange!=null?(' Long-run aerobic decoupling trend: '+(decoupTrend.pctChange<=0?'improving (less late-run fade)':'worsening (more late-run fade)')+' by '+Math.abs(decoupTrend.pctChange).toFixed(0)+'%.'):'')+' The deterministic timeline baseline (the gap expected to close linearly from where it started to zero as real build-days elapse, taper/recovery weeks excluded - no trend or confidence adjustment) computes to position '+Math.round(hmBaseline.position)+'/100 ('+hmBaseline.status+') on its own.'+formatTrendNote(hmBaseline.trend)+formatAchievabilityNote(hmBaseline.achievability)+prevTrajNote;
  const trajectoryPrompt = ' Also, before GOAL IMPACT, add a block on its own line starting with exactly "GOAL TRAJECTORY:" followed by a single valid JSON object synthesizing overall progress toward the '+goalLabel+' goal, using everything above - the LT pace gap, efficiency/time-to-target/HR-recovery/decoupling trends if present, this specific session, and the runner\'s learned patterns and recent history. Weigh recent evidence more than older evidence, and weigh trends (multiple sessions agreeing) more than any single session. Critically, check which phase of the plan the current week actually represents (the week callouts above say things like "peak week" or "taper begins") and calibrate your expectation to that phase, not a flat assumption of steady linear improvement throughout: build weeks should show the gap closing at a reasonable rate, a peak week is where the gap should be closing fastest, and a taper week should show the gap holding steady or closing only slightly - a flat reading during taper is the CORRECT, expected pattern, not a sign of stalling, so don\'t let it pull position down artificially. The JSON shape: {"position":0,"confidence":"low","headline":"...","actionFlag":false} - position is 0-100 where 0 is badly behind schedule for the goal given time remaining, 50 is on track, 100 is notably ahead; confidence is "low"/"medium"/"high" based on how much fresh, reliable evidence actually exists right now (low if the LT pace estimate is old or trends are thin, high if multiple fresh signals agree); headline is exactly 1 short, concrete sentence stating the current read in plain language; actionFlag is true only if the trajectory genuinely reveals something that should factor into whether the plan needs changing - a sustained behind-pace trend across multiple sessions, or a clear, evidence-backed case the goal itself should move - not from a single session\'s mood alone. Critically, use the deterministic timeline baseline given above as your starting anchor, not a fresh independent read - it already accounts for time remaining and how the gap has moved since the block started, which is exactly what "0 is badly behind... 100 is notably ahead" is meant to measure. Only move meaningfully away from that baseline (roughly 10+ points) when you have a specific, statable reason: evidence that\'s genuinely stale or thin (pull toward lower confidence, not necessarily a different position), or a real trend that contradicts the simple linear-close assumption the baseline makes (e.g. multiple sessions showing the gap closing much faster or slower than a straight line would predict). "Still early in the block" or "early days" is not by itself a reason to sit near 50 when the baseline already accounts for exactly how much time has elapsed - if the baseline says 100 because the gap is nearly closed with most of the timeline still ahead, that is what "notably ahead" means, not a reason for caution on its own. The baseline already accounts for real build-days remaining (not raw calendar days - a taper/recovery week neither advances the schedule nor counts as runway to close a gap) and, where enough evidence exists, a genuine observed weekly trend rate rather than an assumption of steady linear improvement - if you see the baseline sitting lower than the gap\'s raw closure would suggest this close to race day, that IS the correct read, not a baseline bug to correct upward. The trend rate and achievability classification given above are themselves computed facts, not something to re-derive or second-guess from the raw pace numbers - reason about what they imply for your headline and actionFlag, don\'t recompute them independently. The app also enforces the position anchor in code (your position gets pulled back toward the baseline if it strays too far), so a wildly divergent number just gets silently corrected rather than shown - stay close to the baseline and your reading will actually be the one that renders. Also make sure your headline\'s wording actually matches the numeric band you land in - don\'t write "strong ahead"/"comfortably ahead" language for a position that isn\'t actually above 67, or "behind" language for one that isn\'t below 33; the headline and the number are shown together and must agree. actionFlag must be true whenever the achievability classification above is "not-enough-time", "not-closing", or "needs-to-accelerate" with a large required multiplier - those are exactly the evidence-backed cases actionFlag exists for, not something to leave false out of caution. If actionFlag is true here, let it inform whether a PASTE TO REBUILD above is warranted - this trajectory read and that decision should agree with each other, not contradict. Critically: if the last trajectory reading is given above and your new position differs from it meaningfully (roughly 5+ points, not a trivial wobble), you MUST explicitly mention this movement in your main visible reply above, not just in the hidden JSON - say which direction it moved and briefly why, in plain language, the way a coach would actually tell you "you have moved up/down on pace for your goal, because X." If the position is essentially unchanged, there is no need to call that out explicitly.';
  let trajectory10KPrompt = '';
  if(tenKGoal){
    try{
      const found10K = findGoalRaceDay(state.WEEKS, tenKGoal);
      const race10KDateCheck = found10K ? parseDayTagDate(found10K.day.tag) : (tenKGoal.raceDate ? new Date(tenKGoal.raceDate) : null);
      if(race10KDateCheck && new Date() <= race10KDateCheck){
        // Same Riegel-implied fix as the HM section above - never tenKGoal.goalPaceSec.
        const goal10KPaceSec = Math.round(impliedLTPaceForGoal(tenKGoal.goalTimeSec||43*60, tenKGoal.distanceKm||10));
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
        const trajectory10KContext = ' For a separate 10K trajectory synthesis: current best-available LT pace is '+(ltGap10KSec!=null?(Math.abs(ltGap10KSec)+'s/km '+(ltGap10KSec>0?'slower than':'at or faster than')+' the ~'+fmtPace(goal10KPaceSec)+' pace implied by the '+goal10KLabel+' goal ('+(tenKGoal.raceDate||'')+')'):'not yet established')+'. The deterministic timeline baseline for the 10K computes to position '+Math.round(tenKBaseline.position)+'/100 ('+tenKBaseline.status+') on its own.'+formatTrendNote(tenKBaseline.trend)+formatAchievabilityNote(tenKBaseline.achievability)+prevTraj10KNote;
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
    try{ const pr = await window.storage.get('goal-trajectory-10k-prevproj', false); if(pr){ const prev = JSON.parse(pr.value); if(prev.projectedSec!=null) result.prevProjectedSec = prev.projectedSec; if(prev.projectedPaceSec!=null) result.prevProjectedPaceSec = prev.projectedPaceSec; } }catch(e){}
    try{ await saveWithRetry('goal-trajectory-10k-prevproj', {projectedSec: result.projectedSec, projectedPaceSec: result.projectedPaceSec}, false); }catch(e){}
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
    try{ const pr = await window.storage.get('goal-trajectory-prevproj', false); if(pr){ const prev = JSON.parse(pr.value); if(prev.projectedSec!=null) result.prevProjectedSec = prev.projectedSec; if(prev.projectedPaceSec!=null) result.prevProjectedPaceSec = prev.projectedPaceSec; } }catch(e){}
    try{ await saveWithRetry('goal-trajectory-prevproj', {projectedSec: result.projectedSec, projectedPaceSec: result.projectedPaceSec}, false); }catch(e){}
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
  // A real click target, not just a badge - was a plain <span> with no action at all, so
  // "worth a look" had nowhere to actually take a closer look. Opens the existing "Rebuild
  // plan" modal prefilled with the AI's own reasoning (same toggleGlobalPlanOverrideModal
  // mechanism, and the same JSON.stringify+&quot; escaping, already used by the verdict
  // card's "Draft this rebuild" button in chat.js's renderVerdictCard) - not hard-routed
  // to proposeAchievabilityFix, since actionFlag can be true for reasons broader than
  // achievability specifically (any AI-judged "worth addressing" read).
  const closerLookText = 'Take a closer look at "'+titleLabel+'": '+data.label+' - is this still the right read, and if not, what should change?';
  const actionBadge = data.actionFlag ? ' <button class="ghost-btn" style="font-size:9.5px; padding:2px 6px; background:rgba(232,163,61,0.18); color:var(--threshold); font-weight:700; border-color:transparent;" onclick="toggleGlobalPlanOverrideModal(true, '+JSON.stringify(closerLookText).replace(/"/g,'&quot;')+')">&#9888; worth a look - take a closer look</button>' : '';
  const freshness = data.updatedAt ? (' &middot; updated '+timeAgo(data.updatedAt)+(data.basedOn?(' after '+data.basedOn):'')) : '';
  // Arrow direction follows the actual numeric change (time went up or down), color follows
  // whether that's good or bad (lower projected time = faster = improvement) - kept distinct
  // from the position-gauge arrow convention above (there, up always means "better") since a
  // literal down-arrow on a time getting FASTER reads more honestly than an up-arrow would.
  const projTrendSec = (data.projectedSec!=null && data.prevProjectedSec!=null) ? (data.projectedSec-data.prevProjectedSec) : null;
  const projPaceTrendSec = (data.projectedPaceSec!=null && data.prevProjectedPaceSec!=null) ? (data.projectedPaceSec-data.prevProjectedPaceSec) : null;
  // Under a minute reads fine as bare seconds ("43s"), but a multi-minute swing ("243s")
  // forces the reader to do their own division - m:ss is the same format the projected
  // time itself is already shown in (via formatMinutesToClock), so the delta and the
  // number it's a delta OF read consistently.
  const fmtProjDelta = (sec)=>{ const abs = Math.abs(Math.round(sec)); return abs<60 ? (abs+'s') : fmtTime(abs); };
  const paceTrendText = (projPaceTrendSec!=null && Math.abs(projPaceTrendSec)>=1)
    ? (', '+Math.abs(Math.round(projPaceTrendSec))+'s/km '+(projPaceTrendSec<0?'faster':'slower'))
    : '';
  const projTrendHTML = (projTrendSec!=null && Math.abs(projTrendSec)>=1)
    ? (' <span style="color:'+(projTrendSec<0?'#5FA8A0':'#C1502E')+';">'+(projTrendSec<0?'&#9660;':'&#9650;')+' '+fmtProjDelta(projTrendSec)+paceTrendText+'</span> <span style="color:var(--dim);">(was '+formatMinutesToClock(data.prevProjectedSec/60)+(data.prevProjectedPaceSec!=null?(' &middot; '+fmtPaceExact(data.prevProjectedPaceSec)):'')+')</span>')
    : '';
  const projectedNote = data.projectedSec ? ('<div class="note" style="border-top:none; padding-top:0; margin-top:2px; margin-bottom:4px; font-size:12px; color:var(--dim);">Current fitness projects to roughly <b style="color:var(--text);">'+formatMinutesToClock(data.projectedSec/60)+'</b>'+(data.projectedPaceSec?(' (<b style="color:var(--text);">'+fmtPaceExact(data.projectedPaceSec)+'</b>)'):'')+projTrendHTML+'</div>') : '';
  return '<div class="card"><div class="sess-name" style="margin-bottom:2px; display:flex; justify-content:space-between; align-items:center;"><span>'+titleLabel+'</span>'+confBadge+'</div>'+
    '<div class="note" style="margin-top:4px; padding-top:0; border-top:none; margin-bottom:4px; font-size:13px;">'+data.label+actionBadge+'</div>'+
    projectedNote+
    svg+
    '<div class="note" style="font-size:10px; margin-top:0;">Synthesized from LT pace, aerobic efficiency, time-to-target, HR-recovery, and long-run decoupling trends where available'+freshness+' - a working estimate, not a lab measurement.</div></div>';
}

// Mirror of missedSessionBannerHTML/missedSessionRowHTML (plan-adherence.js) - one compact
// row per eligible goal, colored var(--easy) (distinct from the amber/red deficit banners)
// to read as good news, plus one combined action button.
function aheadOfScheduleRowHTML(sig){
  const trendTxt = sig.trend ? (' &middot; trend '+Math.abs(sig.trend.rateSecPerWeek).toFixed(1)+'s/km/week improving') : '';
  return '<div class="tier-diff-row"><span class="tier-diff-label" style="color:var(--easy);">&#9650; '+sig.goalLabel+': '+Math.round(sig.position)+'/100 ahead'+trendTxt+'</span><span class="tier-diff-vals">'+sig.buildDaysRemaining+'d left</span></div>';
}

export function aheadOfScheduleBannerHTML(signals){
  if(!signals || !signals.length) return '';
  const rows = signals.map(aheadOfScheduleRowHTML).join('');
  return '<div class="card"><div class="sess-name" style="margin-bottom:6px;">&#9650; Ahead of schedule</div>'+rows+
    '<div class="tier-update-actions"><button class="save-btn" onclick="proposePushFromAheadSignal()">Push plan harder</button></div>'+
    '<div id="push-proposal-combined"></div></div>';
}
