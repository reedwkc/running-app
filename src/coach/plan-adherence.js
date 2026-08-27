// @ts-nocheck
// Deterministic missed-session detection, generalized across every session type and
// weighted by how specifically each type serves the CURRENT active goal - not a flat "you
// missed N sessions" count. Mirrors tier-estimates.js's layoff system in spirit (named,
// literature-grounded tiers rather than an invented continuous formula; computed
// automatically, no action needed; surfaced via a standing banner AND checked against any
// actual rebuild proposal in plan-override.js; never silently auto-applies a plan change).
import { state } from '../state.js';
import { getFullWeekDayList, parseDayTagDate } from '../lib/dates.js';
import { workoutKey } from '../lib/keys.js';
import { distTime, fmtTime } from '../lib/format.js';
import { computeSessionTRIMP } from '../lib/trimp.js';
import { computeACWR, loadTrimpHistory } from './training-load.js';
import { defaultGoalConfig } from '../data/goal-config.js';

const WINDOW_WEEKS = 6;
const SESSION_TYPES = ['easy', 'threshold', 'vo2max', 'long'];

// Same near-max-effort threshold already used to gate the VO2max fitness estimate itself
// in strava-import.js's computeAnalysisMetrics - deliberately the identical number, not a
// second one invented for this file, so "was this a real VO2max effort" means the same
// thing everywhere in the app.
const NEAR_MAX_HR_FRACTION = 0.90;
const MIN_VO2MAX_WORK_SEC = 120;
// vs LTHR - close to computeZones' own S4 band (95-100% of LTHR), widened slightly since
// real efforts vary a bit either side of the exact prescribed zone.
const THRESHOLD_HR_LOW_FRACTION = 0.93;
const THRESHOLD_HR_HIGH_FRACTION = 1.05;
const MIN_THRESHOLD_WORK_SEC = 480; // 8 min - a realistic minimum threshold-rep length
// For a session that ran long but WASN'T scheduled as 'long' (nothing prescribed to compare
// against, so the dose accounting below doesn't apply) - a flat floor is the best available
// honest measure of "this incidentally delivered a real long-duration stimulus".
const UNSCHEDULED_LONG_CREDIT_MIN = 75;

// Mirrors computeOptimalHR in ui/week-view.js (duplicated, not imported - week-view.js
// itself imports FROM this file for the adherence banner, and this file is coach/training
// logic that shouldn't depend on a UI-rendering module) - the exact same target-HR-per-zone
// values already used to prescribe every session elsewhere in the app.
function optimalHRForZone(zoneKey, profile){
  const lthr = profile.lthr, maxHR = profile.maxHR;
  if(zoneKey==='GOAL') return 170;
  if(zoneKey==='RACE10K') return 180;
  if(zoneKey==='S1') return Math.round(lthr*0.72);
  if(zoneKey==='S2') return Math.round(lthr*0.83);
  if(zoneKey==='S3') return Math.round(lthr*0.92);
  if(zoneKey==='S4') return Math.round(lthr*0.975);
  if(zoneKey==='S5') return Math.round(maxHR*0.95);
  return Math.round(lthr*0.83);
}

// What TRIMP (see lib/trimp.js - Banister's exponential HR x duration training-impulse
// formula, already the app's one established currency for combining intensity and duration
// into a single training dose) this session would produce if executed exactly as prescribed:
// the plan's own target HR for each zone (optimalHRForZone, the same number the coach already
// prescribes elsewhere) held for the plan's own prescribed duration. This is the real answer
// to "what stimulus should this workout give me" - duration ALONE was never the right unit,
// since a rep run hotter than target genuinely delivers more dose per minute than one run at
// or under target (TRIMP's weighting is exponential in HR fraction, not linear) - two reps
// short of a prescribed eight isn't just "25% of the reps", it's whatever dose those two
// reps actually produced, which depends on how hard they were run too.
export function prescribedDoseTRIMP(day, profile){
  if(!day || !day.data || !profile) return null;
  if((day.type==='threshold'||day.type==='vo2max') && day.data.main && day.data.main.reps!=null && day.data.main.repTimeSec!=null){
    const hr = optimalHRForZone(day.zone, profile);
    return computeSessionTRIMP(hr, (day.data.main.reps*day.data.main.repTimeSec)/60, profile); // work time only - excludes warmup/cooldown/recovery
  }
  if(day.type==='long' && Array.isArray(day.data.segments) && state.Z){
    let total = 0, any = false;
    day.data.segments.forEach(s=>{
      const z = state.Z[s.zone];
      if(!z || !z.pace) return;
      const hr = optimalHRForZone(s.zone, profile);
      const segMin = distTime(s.km, z.pace)/60;
      const t = computeSessionTRIMP(hr, segMin, profile);
      if(t!=null){ total += t; any = true; }
    });
    return any ? total : null;
  }
  if(day.type==='easy' && day.data.km!=null && state.Z && state.Z.S2 && state.Z.S2.pace){
    const hr = optimalHRForZone('S2', profile);
    return computeSessionTRIMP(hr, distTime(day.data.km, state.Z.S2.pace)/60, profile);
  }
  return null;
}

// The FULL prescribed session dose for a threshold/vo2max day - warmup, work reps,
// between-rep recovery, and cooldown, each at its own realistic zone (easy for everything
// but the work reps themselves) - not just the work-only figure prescribedDoseTRIMP above
// returns. Exists specifically so a manually-logged WHOLE-SESSION avgHR+duration (no
// Strava per-lap breakdown to isolate the work portion) has something fair to compare
// against: comparing a whole-session average to a work-only prescribed number is apples to
// oranges (a session's total duration is always longer than just its work time), and would
// silently under-flag exactly the mismatch this whole check exists to catch - see
// effectiveSessionTypes' whole-session fallback branch below.
export function prescribedWholeSessionDoseTRIMP(day, profile){
  if(!day || !day.data || !profile || !state.Z || !state.Z.S1) return null;
  const m = day.data.main;
  if(!m || m.reps==null || m.repTimeSec==null) return null;
  const workHR = optimalHRForZone(day.zone, profile);
  const easyHR = optimalHRForZone('S1', profile);
  const wuMin = day.data.wu && day.data.wu.km!=null && state.Z.S1.pace ? distTime(day.data.wu.km, state.Z.S1.pace)/60 : 0;
  const cdMin = day.data.cd && day.data.cd.km!=null && state.Z.S1.pace ? distTime(day.data.cd.km, state.Z.S1.pace)/60 : 0;
  const recoveryMin = (m.recoverySec!=null && m.reps>1) ? (m.recoverySec*(m.reps-1))/60 : 0;
  const workMin = (m.reps*m.repTimeSec)/60;
  const total = (computeSessionTRIMP(easyHR, wuMin, profile)||0)
    + (computeSessionTRIMP(workHR, workMin, profile)||0)
    + (computeSessionTRIMP(easyHR, recoveryMin, profile)||0)
    + (computeSessionTRIMP(easyHR, cdMin, profile)||0);
  return total>0 ? total : null;
}

// Real delivered dose (TRIMP) from what actually happened - work-laps only for threshold/
// vo2max (matching prescribedDoseTRIMP's work-only scope: each real work lap's own avgHR and
// duration run through the same Banister formula, then summed - the session-average variant
// of TRIMP, not an approximation invented for this file, just the coarser per-segment form of
// the identical formula computeTRIMP already integrates over a full raw stream elsewhere).
// Whole session for long/easy, preferring the real, full-stream-integrated TRIMP already
// computed at import time (estimatedTRIMP) when available - only falling back to the coarser
// avgHR-based formula for a manually-logged session with no Strava stream to integrate.
// null = no real data to compare against (trust the schedule); a number (including 0) = a
// real measurement, which can legitimately be zero (e.g. a continuousEffort easy run logged
// against a threshold day - 'work' there means "main segment of a flat easy effort", not a
// real interval, so it's explicitly excluded rather than counted as delivered work).
export function deliveredDoseTRIMP(entry, dayType, profile){
  const si = entry.stravaImport;
  if(dayType==='threshold' || dayType==='vo2max'){
    // No per-lap Strava data to isolate real work reps from warmup/recovery/cooldown -
    // null here (no per-lap comparison possible), NOT 0. A manually-logged whole-session
    // avgHR+duration is still real evidence, just not directly comparable to this
    // function's work-only figure (see deliveredWholeSessionDoseTRIMP below, which
    // effectiveSessionTypes falls back to instead - comparing a whole-session average
    // against a work-ONLY prescribed number would be apples to oranges: a 40min easy run's
    // raw duration alone can outweigh a 20min work-only prescription even though it's
    // obviously not the same session).
    if(!si || !Array.isArray(si.laps)) return null;
    if(si.continuousEffort===true) return 0;
    let workLaps = si.laps.filter(l=>l.role==='work' && l.avgHR!=null && l.durationSec);
    // A rep run at genuine near-max HR is real VO2max-zone dose, not threshold dose,
    // however much "credit" running it hot would otherwise appear to hand to the
    // threshold slot - TRIMP's magnitude alone can't tell zones apart (it just rewards
    // higher HR, monotonically, whatever the type), so those reps are excluded here and
    // counted toward vo2max instead (see the bonus-credit block in effectiveSessionTypes).
    // Without this, a session run dramatically hotter than prescribed would misreport as
    // "delivered plenty of threshold dose" instead of "this was actually a different,
    // harder session" - exactly the swap this whole feature exists to detect correctly.
    if(dayType==='threshold' && profile.maxHR){
      workLaps = workLaps.filter(l=>l.avgHR < profile.maxHR*NEAR_MAX_HR_FRACTION);
    }
    if(!workLaps.length) return 0;
    let total = 0;
    workLaps.forEach(l=>{ const t = computeSessionTRIMP(l.avgHR, l.durationSec/60, profile); if(t!=null) total += t; });
    return total;
  }
  if(dayType==='long' || dayType==='easy'){
    if(si && si.estimatedTRIMP!=null) return si.estimatedTRIMP;
    const durationMin = entry.actualDur!=null && entry.actualDur!=='' ? parseFloat(entry.actualDur) : (si && si.totalDurationMin);
    if(durationMin==null || !isFinite(durationMin)) return null;
    const avgHR = entry.avgHR!=null && entry.avgHR!=='' ? parseFloat(entry.avgHR) : null;
    // Real avgHR preferred; a real known DURATION with no HR at all is still real evidence
    // (better than crediting nothing, or silently falling all the way back to "trust the
    // schedule" regardless of how short it actually was) - assumes a typical easy/aerobic
    // effort (S2 zone) as a neutral stand-in, not a guess at how hard it actually felt.
    const hr = avgHR!=null ? avgHR : optimalHRForZone('S2', profile);
    return computeSessionTRIMP(hr, durationMin, profile);
  }
  return null;
}

// Recognizes what type(s) of training stimulus a LOGGED session actually delivered, from
// its own real data - independent of which scheduled day/type it happened to land on, and
// independent of how closely it matched the plan mid-session. Returns {type: creditFraction}
// (0 < credit <= 1) rather than a flat yes/no list - deviations are a spectrum in real life
// and collapsing that to a binary would misrepresent both ends of it.
//
// Trusts the SCHEDULE by default (it's the best available information about what a session
// was unless real data actively contradicts it) - EVERY type gets credit proportional to
// real delivered DOSE vs. the plan's own prescribed dose for that day (see
// prescribedDoseTRIMP/deliveredDoseTRIMP) whenever there's real data to compare; with no
// comparable data at all, the schedule is trusted fully rather than guessed at. Dose, not
// duration alone: a rep run hotter than target partially or fully offsets one fewer rep, a
// long run cut short but held at higher HR delivers more than its raw minutes alone would
// suggest, an easy run and a long run differ only in how much prescribed dose they carry
// (a longer prescribed duration, mostly), not in kind - the same accounting handles all
// four types uniformly rather than treating 'easy' as exempt from the question. On top of
// that baseline, real per-lap HR data can ADD bonus credit for a harder/different stimulus
// than what was scheduled - additive, not exclusive, since one session can genuinely deliver
// more than one type of stimulus at once (a long run with a threshold-effort finish, a
// friend's surprise VO2max workout on a day scheduled as something else entirely).
export function effectiveSessionTypes(entry, day, profile){
  const credits = {};
  // A zero-or-below credit (e.g. real data showing no qualifying work at all) is a no-op,
  // not an explicit zero entry - it must NOT block the 'easy' fallback below the way a real
  // key with value 0 would (Object.keys(credits).length would stay >0 even though nothing
  // meaningful was actually credited).
  const credit = (type, amount)=>{ if(amount>0) credits[type] = Math.max(credits[type]||0, amount); };
  if(!entry || !entry.completed) return credits;
  const si = entry.stravaImport;
  const dayType = day && day.type;

  if((dayType==='threshold' || dayType==='vo2max') && (!si || !Array.isArray(si.laps))){
    // No per-lap Strava data - fall back to the coarser but still real whole-session
    // comparison (see prescribedWholeSessionDoseTRIMP) instead of the work-only figure the
    // per-lap path below uses, so a manually-logged avgHR+duration gets a fair, apples-to-
    // apples denominator rather than either being ignored or unfairly penalized/inflated.
    const avgHR = entry.avgHR!=null && entry.avgHR!=='' ? parseFloat(entry.avgHR) : null;
    const durationMin = entry.actualDur!=null && entry.actualDur!=='' ? parseFloat(entry.actualDur) : null;
    if(avgHR!=null && durationMin!=null && isFinite(durationMin) && durationMin>0){
      const delivered = computeSessionTRIMP(avgHR, durationMin, profile);
      const wholePrescribed = prescribedWholeSessionDoseTRIMP(day, profile);
      credit(dayType, (delivered!=null && wholePrescribed) ? Math.min(1, delivered/wholePrescribed) : 1);
    } else {
      credit(dayType, 1); // truly nothing to compare - trust the schedule
    }
  } else if(dayType && SESSION_TYPES.includes(dayType)){
    const prescribed = prescribedDoseTRIMP(day, profile);
    const delivered = deliveredDoseTRIMP(entry, dayType, profile);
    credit(dayType, (prescribed && delivered!=null) ? Math.min(1, delivered/prescribed) : 1);
  }

  // Bonus HR-based credit only for a DIFFERENT type than whatever was already handled by the
  // proportional branch above - when dayType IS 'vo2max'/'threshold', that branch already
  // gave the precise, real completion-ratio number for it; re-triggering a binary "any one
  // qualifying lap = full credit" here for the SAME type would silently overwrite a precise
  // 0.75 (6 of 8 reps) back up to a flat 1 just because those reps individually reached
  // near-max HR - exactly the "any completion counts as full" bug this whole rework exists
  // to fix. A real vo2max effort logged on a day scheduled as something ELSE (a surprise
  // workout, a threshold day that ran hotter than planned) still gets full bonus credit,
  // since there's no proportional number for that type to preserve.
  if(si && Array.isArray(si.laps) && profile){
    const workLaps = si.laps.filter(l=>l.role==='work' && l.avgHR!=null && l.durationSec);
    if(dayType!=='vo2max' && profile.maxHR && workLaps.some(l=>l.avgHR >= profile.maxHR*NEAR_MAX_HR_FRACTION && l.durationSec>=MIN_VO2MAX_WORK_SEC)){
      credit('vo2max', 1);
    }
    if(dayType!=='threshold' && profile.lthr && workLaps.some(l=>l.avgHR >= profile.lthr*THRESHOLD_HR_LOW_FRACTION && l.avgHR <= profile.lthr*THRESHOLD_HR_HIGH_FRACTION && l.durationSec>=MIN_THRESHOLD_WORK_SEC)){
      credit('threshold', 1);
    }
  }
  // Bonus 'long' credit from real duration evidence alone, regardless of what was scheduled -
  // nothing was prescribed as 'long' here (that case is handled by the proportional branch
  // above), so a flat, reasonable floor is the most honest available measure. credit() takes
  // the max against anything already set, so this never downgrades a scheduled long run.
  if(dayType!=='long'){
    const bonusDurationMin = entry.actualDur!=null && entry.actualDur!=='' ? parseFloat(entry.actualDur) : (si && si.totalDurationMin);
    if(bonusDurationMin!=null && isFinite(bonusDurationMin) && bonusDurationMin>=UNSCHEDULED_LONG_CREDIT_MIN) credit('long', 1);
  }

  if(!Object.keys(credits).length) credit('easy', 1); // genuinely completed, no stronger signal - still real aerobic volume
  return credits;
}

// Single pass over every calendar day in the window (getFullWeekDayList, not just the
// prescribed w.days - this is what actually picks up a swap or a free/unplanned workout
// logged on an otherwise-open day, which previously wasn't scanned at all: both the swap
// and free-workout flows save under the SAME workoutKey(weekN, tag) scheme this scan already
// reads, keyed to whatever day naturally falls on the date chosen, open days included).
// Reads each real log entry once, building both sides of the adherence question at once:
// scheduled[type] (what the plan called for) and delivered[type] (what actually happened,
// credited by REAL delivered stimulus via effectiveSessionTypes, not by which slot it was
// logged under - and now fractional, not just integer, to reflect graded credit).
// misses[type] lists the specific scheduled slots that weren't individually completed, for
// display - the actual missed COUNT below is the scheduled-vs-delivered gap, which a bonus
// session elsewhere in the window can close even though no single slot's own "misses" entry
// goes away.
// Never looks back past the start of the CURRENT training block - a new goal's plan is
// built fresh around whatever fitness the runner has NOW, so adherence against a goal
// that's no longer the one being trained for isn't a real signal about the current plan
// (missing sessions toward an HM that got replaced by a 10K a month later isn't "missed
// sessions" for the 10K block). goalConfig.blockStartedAt is stamped in plan-override.js's
// applyPlanOverride only when a goalConfigPatch actually changes the active goal(s) - see
// there for why a phase-only or pace-only patch doesn't reset it. No blockStartedAt at all
// (the common case - no goal has ever changed) means don't clamp beyond the plain
// windowWeeks cutoff, same as before this existed. Cross-block concerns like layoffs,
// injuries, and block-progression memory are tracked elsewhere (tier-estimates.js,
// coach/plan-override.js's layoff handling) and are deliberately NOT affected by this -
// this clamp is specific to the missed-SESSION adherence check, not the whole coach's
// memory of the runner.
function windowCutoff(windowWeeks, now){
  let cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - windowWeeks*7);
  const blockStartedAt = state.goalConfig && state.goalConfig.blockStartedAt;
  if(blockStartedAt){
    const blockStart = new Date(blockStartedAt); blockStart.setHours(0,0,0,0);
    if(!isNaN(blockStart) && blockStart > cutoff) cutoff = blockStart;
  }
  return cutoff;
}

async function scanAdherenceWindow(windowWeeks){
  const now = new Date(); now.setHours(0,0,0,0);
  const cutoff = windowCutoff(windowWeeks, now);
  const scheduled = {}, delivered = {}, misses = {};
  SESSION_TYPES.forEach(t=>{ scheduled[t]=0; delivered[t]=0; misses[t]=[]; });
  const sessionLog = []; // every real day in the window with its own credits - see detectLikelySwaps
  for(const w of (state.WEEKS||[])){
    for(const d of getFullWeekDayList(w)){
      const dDate = parseDayTagDate(d.tag);
      if(!dDate || dDate < cutoff || dDate >= now) continue;
      const runKey = workoutKey(w.n, d.tag);
      let entry = state.recentSaveCache[runKey];
      if(entry===undefined){
        try{ const r = await window.storage.get(runKey, false); if(r) entry = JSON.parse(r.value); }catch(e){}
      }
      if(SESSION_TYPES.includes(d.type)){
        scheduled[d.type]++;
        if(!entry || !entry.completed) misses[d.type].push({weekN:w.n, dayTag:d.tag, name:d.name});
      }
      const credits = effectiveSessionTypes(entry, d, state.profile);
      Object.keys(credits).forEach(t=>{ if(delivered[t]!=null) delivered[t] += credits[t]; });
      if(Object.keys(credits).length) sessionLog.push({weekN:w.n, dayTag:d.tag, name:d.name, scheduledType:d.type, credits, completedAt: entry && entry.completedAt});
    }
  }
  return {scheduled, delivered, misses, sessionLog, windowWeeks};
}

// Per-type view onto scanAdherenceWindow, for callers (and tests) that only care about one
// type at a time - missed is the net scheduled-vs-delivered gap (rounded to one decimal,
// since delivered can now be fractional from partial-credit long runs), so a real bonus
// session logged under a DIFFERENT day (e.g. a surprise VO2max effort on a scheduled long-
// run day) can reduce it even though that specific slot still shows up in `misses`.
export async function countMissedSessionsByType(type, windowWeeks){
  const scan = await scanAdherenceWindow(windowWeeks);
  const missed = Math.round(Math.max(0, scan.scheduled[type] - scan.delivered[type])*10)/10;
  return {type, windowWeeks, scheduled: scan.scheduled[type], delivered: Math.round(scan.delivered[type]*10)/10, missed, misses: scan.misses[type]};
}

// Which session type serves each race distance most SPECIFICALLY - grounded in standard
// distance-training guidance (Daniels' Running Formula; Pfitzinger & Douglas, Advanced
// Marathoning; standard 5K/10K interval-training principles): a 5K is raced at/near
// VO2max-adjacent intensity, making VO2max work the hardest-to-substitute stimulus for it;
// a half marathon is raced very close to lactate-threshold pace, making threshold work
// specific to it; a marathon's defining physiological demands (glycogen utilization, fat
// oxidation at prolonged duration, musculoskeletal durability) are built almost entirely by
// the long run, making it the LEAST substitutable session of all for that distance. Easy
// volume is always 'supportive' regardless of goal - it's the most fungible, easiest-to-
// make-up training component for every distance, never the specific limiter. Distance BANDS
// (not exact-match), same "named tiers, not an invented continuous formula" reasoning as
// estimateLayoffImpact - more honest about how coarse this mapping actually is.
export function importanceForGoalDistance(distanceKm){
  if(distanceKm==null) return {vo2max:'important', threshold:'important', long:'important', easy:'supportive'};
  if(distanceKm <= 7)  return {vo2max:'critical',  threshold:'important', long:'supportive', easy:'supportive'}; // 5K-ish
  if(distanceKm <= 15) return {vo2max:'important', threshold:'critical',  long:'supportive', easy:'supportive'}; // 10K-ish
  if(distanceKm <= 30) return {vo2max:'supportive', threshold:'critical', long:'important',  easy:'supportive'}; // half marathon-ish
  return                      {vo2max:'supportive', threshold:'important', long:'critical',  easy:'supportive'}; // marathon+
}

// The GOAL zone slot is this app's own established "primary goal" concept elsewhere (see
// goal-trajectory.js's achievability checks, which are HM/GOAL-only) - mirrored here rather
// than inventing a separate precedence rule. Falls back to RACE10K if no GOAL is active, and
// to no-specific-goal (maintenance phase) if neither is.
function activeGoalDistanceKm(goalConfig){
  const cfg = goalConfig || defaultGoalConfig();
  const goal = (cfg.activeGoals||[]).find(g=>g.zoneKey==='GOAL') || (cfg.activeGoals||[]).find(g=>g.zoneKey==='RACE10K');
  return goal ? goal.distanceKm : null;
}

const TYPE_RATIONALE = {
  long: 'musculoskeletal durability, fueling/glycogen-utilization rehearsal, and time-on-feet adaptation that easy volume alone doesn\'t build',
  threshold: 'lactate-threshold-specific adaptation - the pace most closely tied to sustainable effort at this goal distance',
  vo2max: 'top-end aerobic power and running economy at faster-than-race pace',
  easy: 'aerobic base volume - the most substitutable, easiest-to-make-up training component',
};

function buildAdherenceNote(type, importance, severity){
  const rationale = TYPE_RATIONALE[type];
  if(importance==='critical'){
    return severity==='significant'
      ? 'This is the session type your current goal depends on most specifically ('+rationale+') - a pattern this size meaningfully threatens race-specific readiness, not just today\'s fitness. Genuinely re-ramp over the next 2+ weeks rather than cramming it back in, and treat current goal-pace confidence as reduced until fresh evidence accumulates.'
      : 'This is the session type your current goal depends on most specifically ('+rationale+'). A pattern like this is worth a real re-ramp next time out rather than resuming at full prescribed load immediately.';
  }
  if(importance==='important'){
    return severity==='significant'
      ? 'This meaningfully supports your current goal ('+rationale+') and enough have been missed that it\'s worth a genuine re-ramp, though it isn\'t the single most race-specific limiter for this distance.'
      : 'This supports your current goal ('+rationale+') - worth stepping back up gradually rather than resuming full load immediately.';
  }
  return 'The most substitutable, least race-specific session type for your current goal ('+rationale+') - still worth a modest step back up given how many were missed, but not a threat to race readiness the way a pattern in key sessions would be.';
}

// Fraction of SCHEDULED sessions missed within the window, not raw count, so the same
// tiers work correctly regardless of how often a given type is actually scheduled (long/
// threshold/vo2max ~1x/week vs easy ~3-4x/week) - a fixed raw-count threshold would
// otherwise flag missed easy runs far too early relative to how much less specific each
// individual one is. A single miss is NEVER flagged, whatever the type or importance -
// "missed one" isn't a pattern; MIN_MISSED_TO_FLAG enforces that as a hard floor
// independent of fraction.
const IMPORTANCE_THRESHOLDS = {
  critical:   {warnFraction:1/3, flagFraction:1/2},
  important:  {warnFraction:0.45, flagFraction:0.6},
  supportive: {warnFraction:0.6, flagFraction:0.75},
};
const MIN_MISSED_TO_FLAG = 2;
const MIN_SCHEDULED_TO_JUDGE = 2; // can't read a pattern from 0-1 scheduled instances

export function classifySessionAdherence(counts, importance){
  if(!counts || counts.scheduled < MIN_SCHEDULED_TO_JUDGE || counts.missed < MIN_MISSED_TO_FLAG) return null;
  const fraction = counts.missed / counts.scheduled;
  const t = IMPORTANCE_THRESHOLDS[importance] || IMPORTANCE_THRESHOLDS.supportive;
  if(fraction < t.warnFraction) return null;
  const severity = fraction >= t.flagFraction ? 'significant' : 'moderate';
  return Object.assign({}, counts, {
    importance, severity, reramp:true, kind:'gap',
    // Easy volume is the most fungible training component for every goal distance - missing
    // a lot of it is worth ramping back into, but never itself grounds for treating goal-pace
    // confidence as reduced the way a pattern in a critical/important session type does.
    flagGoalConfidence: severity==='significant' && importance!=='supportive',
    note: buildAdherenceNote(counts.type, importance, severity),
  });
}

// A DIFFERENT failure mode than the scheduled-vs-delivered gap check above, and one that
// gap check structurally cannot catch: consistently running slightly short of a session's
// OWN prescription every single time it happens (e.g. one rep less than prescribed on every
// threshold session all block) never accumulates into a big enough scheduled-vs-delivered
// GAP to cross classifySessionAdherence's fraction thresholds, because the shortfall is the
// same small fraction in every rolling window forever - it never gets "worse", so a check
// built to catch a growing/accumulating gap never fires no matter how many blocks go by.
// This checks a different question entirely: not "how much total dose is missing" but "does
// this type's OWN completion ratio look the same, session after session, and is that ratio
// consistently below a realistic bar" - i.e. is the runner quietly not hitting this
// session's actual prescription as a matter of course, not as an occasional bad day.
// Per-type importance-scaled bars, same "critical sessions get less slack" philosophy as
// IMPORTANCE_THRESHOLDS above: a critical session type (the one THIS goal depends on most)
// is flagged at a smaller shortfall than a merely-supportive one.
const CONSISTENT_SHORTFALL_MIN_SESSIONS = 3; // can't call 1-2 data points a "pattern"
const CONSISTENT_SHORTFALL_PATTERN_FRACTION = 0.8; // at least 4 of 5 - tolerates one off day without losing a real signal
const CONSISTENT_SHORTFALL_THRESHOLDS = {
  critical:   {shortBar:0.92, significantBar:0.85},
  important:  {shortBar:0.90, significantBar:0.80},
  supportive: {shortBar:0.85, significantBar:0.75},
};

function buildConsistentShortfallNote(type, importance, severity, avgPct, sessionsChecked, shortCount){
  const rationale = TYPE_RATIONALE[type];
  const base = 'Real logged data shows this isn\'t an occasional off day - '+shortCount+' of the last '+sessionsChecked+' '+type+' sessions have each landed around '+avgPct+'% of their own prescribed work, a steady pattern rather than a one-off shortfall.';
  if(importance==='critical'){
    return severity==='significant'
      ? base+' This is the session type your current goal depends on most specifically ('+rationale+') - worth recalibrating the prescription to match what\'s actually happening rather than continuing to ask for volume that consistently isn\'t landing, and treating current goal-pace confidence as reduced until fresh evidence accumulates.'
      : base+' This is the session type your current goal depends on most specifically ('+rationale+') - worth a closer look at whether the current prescription still fits.';
  }
  if(importance==='important'){
    return severity==='significant'
      ? base+' This meaningfully supports your current goal ('+rationale+') - worth recalibrating rather than continuing to prescribe volume that consistently isn\'t landing.'
      : base+' This supports your current goal ('+rationale+') - worth a closer look at whether the prescription still fits.';
  }
  return base+' The most substitutable session type for your current goal ('+rationale+'), but still worth recalibrating to a realistic number rather than a prescription that\'s quietly not being met.';
}

// sessionLog entries only exist for actually-completed days (effectiveSessionTypes returns
// {} for anything not completed - see scanAdherenceWindow), and only a ratio strictly below
// 1 can ever come from real comparative dose data (the "nothing to compare, trust the
// schedule" fallback in effectiveSessionTypes always credits exactly 1, never a lesser real
// number) - so filtering on s.scheduledType===type and reading s.credits[type] directly
// naturally restricts this to genuine, data-backed completion ratios for that type's OWN
// prescription, never a bonus credit borrowed from a different scheduled type.
export function detectConsistentShortfalls(sessionLog, importanceByType){
  const byType = {}; SESSION_TYPES.forEach(t=>{ byType[t]=[]; });
  (sessionLog||[]).forEach(s=>{
    const t = s.scheduledType;
    if(!t || !byType[t]) return;
    const ratio = s.credits[t];
    if(ratio==null) return;
    byType[t].push(ratio);
  });
  const results = [];
  SESSION_TYPES.forEach(type=>{
    const ratios = byType[type];
    if(ratios.length < CONSISTENT_SHORTFALL_MIN_SESSIONS) return;
    const importance = (importanceByType && importanceByType[type]) || 'supportive';
    const t = CONSISTENT_SHORTFALL_THRESHOLDS[importance] || CONSISTENT_SHORTFALL_THRESHOLDS.supportive;
    const shortRatios = ratios.filter(r=> r < t.shortBar);
    if(shortRatios.length/ratios.length < CONSISTENT_SHORTFALL_PATTERN_FRACTION) return;
    const avgRatio = ratios.reduce((a,b)=>a+b,0)/ratios.length;
    const severity = avgRatio < t.significantBar ? 'significant' : 'moderate';
    const avgPct = Math.round(avgRatio*100);
    results.push({
      type, importance, severity, reramp:true, kind:'consistentShortfall',
      windowWeeks: WINDOW_WEEKS, sessionsChecked: ratios.length, shortCount: shortRatios.length,
      avgRatio: Math.round(avgRatio*100)/100, avgPct,
      flagGoalConfidence: severity==='significant' && importance!=='supportive',
      note: buildConsistentShortfallNote(type, importance, severity, avgPct, ratios.length, shortRatios.length),
    });
  });
  return results;
}

// Runs the check across every session type, each weighted by how specifically it serves
// whatever goal is currently active - the actual generalization this module exists for.
// Returns an array (0, 1, or several types can be flagged at once - e.g. both missed
// threshold AND missed long runs during a rough training stretch).
export async function getMissedSessionAdjustments(){
  try{
    const importance = importanceForGoalDistance(activeGoalDistanceKm(state.goalConfig));
    // One scan for every type, not four - scanAdherenceWindow already reads every entry in
    // the window once regardless of how many types are asked about.
    const scan = await scanAdherenceWindow(WINDOW_WEEKS);
    const results = [];
    for(const type of SESSION_TYPES){
      // Rounded to 1 decimal, same convention as countMissedSessionsByType - delivered is a
      // sum of fractional per-session credits, so the raw subtraction below can otherwise
      // carry binary floating-point noise all the way out to the display (e.g.
      // 2.0855165595650025 instead of a clean 2.1).
      const delivered = Math.round(scan.delivered[type]*10)/10;
      const missed = Math.round(Math.max(0, scan.scheduled[type] - delivered)*10)/10;
      const counts = {type, windowWeeks: WINDOW_WEEKS, scheduled: scan.scheduled[type], delivered, missed, misses: scan.misses[type]};
      const classified = classifySessionAdherence(counts, importance[type]);
      if(classified) results.push(classified);
    }
    // A second, independent detector - see detectConsistentShortfalls' own comment for why
    // the scheduled-vs-delivered gap check above structurally can't catch a small, steady
    // per-session shortfall that never grows into a big enough gap to cross its thresholds.
    results.push(...detectConsistentShortfalls(scan.sessionLog, importance));
    // Most goal-relevant first: significant before moderate, critical before important
    // before supportive within the same severity - the banner and any rebuild-validation
    // consumer should see the most urgent gap first.
    const severityRank = {significant:0, moderate:1};
    const importanceRank = {critical:0, important:1, supportive:2};
    results.sort((a,b)=> (severityRank[a.severity]-severityRank[b.severity]) || (importanceRank[a.importance]-importanceRank[b.importance]));
    return results;
  }catch(e){ return []; }
}

// A 'moderate' pattern is a heads-up worth naming honestly but not yet worth proposing an
// actual plan edit for - it may resolve on its own next week. 'Significant' is where the
// underlying note already says "genuinely re-ramp" / "worth a real re-ramp" - at that point
// the banner should offer the concrete change, not just describe it and leave the runner to
// translate that into an edit themselves by hand.
//
// ONE card total, however many types are flagged at once - a compact row per type (count/
// percentage + importance, color-coded by severity, same tier-diff-row language the rest of
// the app already uses for a diff summary) rather than a full paragraph of rationale each.
// The full explanatory note (buildAdherenceNote/buildConsistentShortfallNote) stays on the
// adjustment object and still reaches the coach via chat.js's prompt-building - it's just no
// longer dumped into this UI, which was the actual complaint (two cards, each dense with
// prose, then a THIRD card containing only the button). The single combined action lives
// inside this same card, never a separate one below it.
function missedSessionRowHTML(adj){
  const label = adj.kind==='consistentShortfall'
    ? adj.type+': consistently ~'+adj.avgPct+'% of prescribed work'
    // adj.missed is a dose-weighted float (partial credit can make it e.g. 2.1) - fine for
    // classification math, but "2.1 of 3 sessions" isn't a sentence a runner can parse as a
    // real count, so it's rounded to a whole number for display only.
    : adj.type+': '+Math.round(adj.missed)+' of '+adj.scheduled+' missed';
  const color = adj.severity==='significant' ? 'var(--vo2)' : 'var(--threshold)';
  return '<div class="tier-diff-row"><span class="tier-diff-label" style="color:'+color+';">&#9888; '+label+'</span><span class="tier-diff-vals">'+adj.importance+'</span></div>';
}

export function missedSessionBannerHTML(adjustments){
  if(!adjustments || !adjustments.length) return '';
  const rows = adjustments.map(missedSessionRowHTML).join('');
  const hasSignificant = adjustments.some(a=>a.severity==='significant');
  const action = hasSignificant
    ? '<div class="tier-update-actions"><button class="save-btn" onclick="proposeReRampFromAdjustments()">Adjust plan</button></div>'+
      '<div id="reramp-proposal-combined"></div>'
    : '';
  return '<div class="card"><div class="sess-name" style="margin-bottom:6px;">&#9888; Missed-session patterns (last '+adjustments[0].windowWeeks+' weeks)</div>'+rows+action+'</div>';
}

// A day whose real delivered dose strongly matches a DIFFERENT type than what was actually
// scheduled there (its own scheduled type went largely unfulfilled, per effectiveSessionTypes'
// dose accounting), paired with that other type having a genuine, still-open gap elsewhere in
// the same window - the "ran Wednesday's VO2max session on Monday instead of Monday's own
// threshold, and Wednesday's VO2max never happened" pattern. Two independent adherence flags
// (a missed threshold, a mysterious bonus VO2max) describe the same real event without
// connecting it; this makes the connection explicit instead, as a concrete "swap these two
// days" suggestion a rebuild can act on directly - not a silent auto-edit, the same
// confirm-before-changing-the-plan rule as everywhere else a plan change is suggested.
const SWAP_MATCH_CREDIT = 0.75; // "this really was a different type" bar
const SWAP_OWN_TYPE_CREDIT_CEILING = 0.4; // and its own scheduled type genuinely fell short too

export function detectLikelySwaps(sessionLog, misses){
  const suggestions = [];
  const consumed = new Set(); // 'type|weekN|dayTag' of a miss already matched to a swap
  (sessionLog||[]).forEach(s=>{
    Object.keys(s.credits).forEach(otherType=>{
      if(otherType===s.scheduledType) return;
      if(s.credits[otherType] < SWAP_MATCH_CREDIT) return;
      if((s.credits[s.scheduledType]||0) >= SWAP_OWN_TYPE_CREDIT_CEILING) return; // still basically delivered its own thing too - additive bonus, not a swap
      const candidate = ((misses||{})[otherType]||[]).find(m=>!consumed.has(otherType+'|'+m.weekN+'|'+m.dayTag));
      if(!candidate) return;
      consumed.add(otherType+'|'+candidate.weekN+'|'+candidate.dayTag);
      suggestions.push({
        actualDay: {weekN:s.weekN, dayTag:s.dayTag, name:s.name},
        scheduledType: s.scheduledType,
        deliveredType: otherType,
        missingDay: candidate,
      });
    });
  });
  return suggestions;
}

export async function getLikelySwapSuggestions(){
  try{
    const scan = await scanAdherenceWindow(WINDOW_WEEKS);
    return detectLikelySwaps(scan.sessionLog, scan.misses);
  }catch(e){ return []; }
}

export function swapSuggestionBannerHTML(suggestions){
  if(!suggestions || !suggestions.length) return '';
  const cards = suggestions.map((s,i)=>
    '<div class="card"><div class="sess-name" style="margin-bottom:4px;">&#8646; Looks like a swap</div>'+
    '<div class="note" style="border-top:none; padding-top:0; font-size:13px;">'+s.actualDay.dayTag+' (\''+s.actualDay.name+'\') reads as a real '+s.deliveredType+' effort, not the scheduled '+s.scheduledType+' - and '+s.missingDay.dayTag+' (\''+s.missingDay.name+'\') never got its own '+s.deliveredType+' done.</div>'+
    '<div class="tier-update-actions"><button class="save-btn" onclick="proposeSwapFromSuggestion('+i+')">Propose swapping these two days</button></div>'+
    '<div id="swap-proposal-'+i+'"></div>'+
    '</div>'
  );
  return cards.join('');
}

// Turns a detected swap into a real, applicable plan-rebuild proposal - swaps only the
// PRESCRIPTION (type/zone/data/name) between the two days, leaving their real calendar tags/
// dates untouched (the point is putting the right workout on the right day, not moving days
// around). Deterministic, not LLM-authored - the exact same "compute the real thing
// directly" reasoning as everywhere else in this app that could ask an LLM to reconstruct
// precise data but doesn't need to, since the two full day objects already exist verbatim in
// currentWeeks. Returns null if either day can no longer be found (the plan changed since
// the suggestion was computed) - the caller should treat that as "no longer applicable"
// rather than silently applying something stale.
export function buildSwapProposal(suggestion, currentWeeks){
  if(!suggestion || !currentWeeks) return null;
  const weekA = currentWeeks.find(w=>w.n===suggestion.actualDay.weekN);
  const weekB = currentWeeks.find(w=>w.n===suggestion.missingDay.weekN);
  if(!weekA || !weekB) return null;
  const dayA = (weekA.days||[]).find(d=>d.tag===suggestion.actualDay.dayTag);
  const dayB = (weekB.days||[]).find(d=>d.tag===suggestion.missingDay.dayTag);
  if(!dayA || !dayB) return null;
  const swappedA = Object.assign({}, dayA, {type:dayB.type, zone:dayB.zone, data:dayB.data, name:dayB.name});
  const swappedB = Object.assign({}, dayB, {type:dayA.type, zone:dayA.zone, data:dayA.data, name:dayA.name});
  if(weekA.n===weekB.n){
    const days = weekA.days.map(d=> d.tag===dayA.tag ? swappedA : d.tag===dayB.tag ? swappedB : d);
    return {weeks:[Object.assign({}, weekA, {days})]};
  }
  const daysA = weekA.days.map(d=> d.tag===dayA.tag ? swappedA : d);
  const daysB = weekB.days.map(d=> d.tag===dayB.tag ? swappedB : d);
  return {weeks:[Object.assign({}, weekA, {days:daysA}), Object.assign({}, weekB, {days:daysB})]};
}

// A concrete, deterministic "ease back in" proposal for a flagged missed-session pattern -
// the same literature-grounded principle already coded for post-layoff ramps
// (estimateLayoffImpact, the layoff-intensity check in plan-override.js): resuming a
// demanding session at its full originally-prescribed load right after a real pattern of
// missing it is the anti-pattern this exists to avoid, not silently ignore. Eases only the
// SINGLE next upcoming occurrence of the flagged type still left in the plan - a proposal
// small enough to actually review, the same one-change-at-a-time footprint as
// buildSwapProposal above, not a rewrite of every future week. Deterministic, not
// LLM-authored, for the same reason buildSwapProposal is: the exact numbers already exist,
// no need to ask an LLM to reconstruct them. Returns null when there's no upcoming
// occurrence left to ease, or nothing meaningful left to cut (already at the floor).
const RERAMP_INTENSITY_FACTOR = 0.7; // ~30% cut - in line with the manual re-ramps already
// authored elsewhere in this plan (e.g. 6x1500->5x1500 post-race, 25km->19km peak long run)
const RERAMP_MIN_REPS = 3;
const RERAMP_MIN_KM = 3;

function isQualityZone(zone){ return zone==='S3' || zone==='GOAL' || zone==='RACE10K'; }

// What the cut is FOR determines how big it should be. A scheduled-vs-delivered GAP
// (missed sessions, a real interruption) gets the flat, conservative post-layoff-style cut -
// the runner hasn't been giving real evidence about what volume they can actually sustain,
// so guessing safely low is the right move. A CONSISTENT SHORTFALL is different: the runner
// HAS been giving real evidence, session after session, about what they can actually
// deliver - adjustment.avgRatio IS that evidence - so the honest recalibration is to match
// the prescription to reality (avgRatio), not to additionally guess with a second, unrelated
// flat cut on top of a number that was already wrong.
function reRampFactor(adjustment){
  return (adjustment.kind==='consistentShortfall' && adjustment.avgRatio!=null) ? adjustment.avgRatio : RERAMP_INTENSITY_FACTOR;
}

function reRampReasonPhrase(adjustment){
  if(adjustment.kind==='consistentShortfall'){
    return 'recent '+adjustment.type+' sessions have consistently landed around '+adjustment.avgPct+'% of the prescribed work over the last '+adjustment.windowWeeks+' weeks (a steady pattern, not one bad day), so the prescription is recalibrated to match what\'s actually been happening rather than keep asking for volume that isn\'t landing';
  }
  return Math.round(adjustment.missed)+' of '+adjustment.scheduled+' '+adjustment.type+' sessions were missed over the last '+adjustment.windowWeeks+' weeks, so this resumes at reduced volume rather than jumping straight back to the full prescription';
}

export function buildReRampProposal(adjustment, currentWeeks){
  if(!adjustment || !currentWeeks || !state.Z) return null;
  const type = adjustment.type;
  const factor = reRampFactor(adjustment);
  const now = new Date(); now.setHours(0,0,0,0);
  let target = null; // {week, day, date}
  for(const w of currentWeeks){
    for(const d of getFullWeekDayList(w)){
      if(d.type !== type) continue;
      const dDate = parseDayTagDate(d.tag);
      if(!dDate || dDate < now) continue;
      if(!target || dDate < target.date) target = {week:w, day:d, date:dDate};
    }
  }
  if(!target) return null;
  const { week, day } = target;
  let newData, changeNote;

  if(type==='threshold' || type==='vo2max'){
    const m = day.data.main;
    if(!m || !day.data.wu || !day.data.cd) return null;
    const newReps = Math.max(RERAMP_MIN_REPS, Math.round(m.reps*factor));
    if(newReps >= m.reps) return null;
    const repKm = m.paceSpk ? m.repTimeSec/m.paceSpk : null;
    const mainTime = newReps*m.repTimeSec + (newReps-1)*m.recoverySec;
    const wuTime = distTime(day.data.wu.km, state.Z.S1.pace);
    const cdTime = distTime(day.data.cd.km, state.Z.S1.pace);
    changeNote = 'Eased from '+m.reps+' to '+newReps+' reps - '+reRampReasonPhrase(adjustment)+'.';
    newData = Object.assign({}, day.data, {
      totalKm: repKm!=null ? (day.data.wu.km+newReps*repKm+day.data.cd.km).toFixed(1) : day.data.totalKm,
      totalSec: wuTime+mainTime+cdTime, totalTime: fmtTime(wuTime+mainTime+cdTime),
      main: Object.assign({}, m, {reps:newReps, label: m.label.replace(m.reps+' x', newReps+' x'), time: fmtTime(mainTime)}),
    });
  } else if(type==='long'){
    const segs = day.data.segments;
    if(!Array.isArray(segs) || !segs.length) return null;
    const cuttable = segs.filter(s=>!isQualityZone(s.zone));
    const pool = cuttable.length ? cuttable : segs; // no easy base to trim - cut everything proportionally as a last resort
    const newSegments = segs.map(s=>{
      if(!pool.includes(s)) return s;
      const newKm = Math.max(RERAMP_MIN_KM/pool.length, s.km*factor);
      return Object.assign({}, s, {km: Math.round(newKm*10)/10});
    });
    const sameAsOriginal = newSegments.every((s,i)=> s.km===segs[i].km);
    if(sameAsOriginal) return null;
    let totalKm=0, totalSec=0;
    newSegments.forEach(s=>{ totalKm+=s.km; totalSec+=distTime(s.km, state.Z[s.zone].pace); });
    changeNote = 'Trimmed from '+day.data.totalKm+'km to '+totalKm.toFixed(1)+'km - '+reRampReasonPhrase(adjustment)+'.'+(cuttable.length!==segs.length && cuttable.length>0 ? ' Quality portion unchanged, only the easy base trimmed.' : '');
    newData = Object.assign({}, day.data, {segments:newSegments, totalKm:totalKm.toFixed(1), totalSec, totalTime:fmtTime(totalSec)});
  } else if(type==='easy'){
    if(day.data.km==null) return null;
    const newKm = Math.max(RERAMP_MIN_KM, Math.round(day.data.km*factor*10)/10);
    if(newKm>=day.data.km) return null;
    changeNote = 'Trimmed from '+day.data.km+'km to '+newKm+'km - '+reRampReasonPhrase(adjustment)+'.';
    newData = Object.assign({}, day.data, {km:newKm, timeSec: distTime(newKm, state.Z.S2.pace)});
  } else {
    return null;
  }

  const changeDate = now.toLocaleDateString('en-US', {month:'short', day:'numeric'});
  const newDay = Object.assign({}, day, {data:newData, changeNote, changeDate});
  const days = week.days.map(d=> d.tag===day.tag ? newDay : d);
  return {weeks:[Object.assign({}, week, {days})]};
}

// Folds every significant adjustment's own buildReRampProposal into ONE combined proposal,
// instead of the runner being asked to Apply a separate one-off change per flagged type -
// two genuinely different session types missed in the same window is still a single "ease
// back into training" moment, not two unrelated decisions. Each adjustment is built against
// the RUNNING result of the ones before it (not the original currentWeeks) so that if two
// flagged types happen to land in the same week, the later proposal's week object already
// carries the earlier change forward instead of silently clobbering it - buildReRampProposal
// always returns a full week object (every day, one changed), so building off the
// already-patched week is what makes the final merge correct rather than last-one-wins.
export function buildReRampProposals(adjustments, currentWeeks){
  if(!adjustments || !adjustments.length || !currentWeeks) return null;
  let workingWeeks = currentWeeks;
  const changedByWeekN = {};
  const handledTypes = new Set(); // a type can be flagged twice now (a scheduled-vs-delivered
  // gap AND a consistent per-session shortfall) - easing the SAME next occurrence twice would
  // compound two cuts on top of each other rather than applying one honest recalibration.
  // Callers already sort worst-first (significant before moderate, critical before important),
  // so the first adjustment seen per type is the one that wins.
  adjustments.forEach(adjustment=>{
    if(handledTypes.has(adjustment.type)) return;
    const proposal = buildReRampProposal(adjustment, workingWeeks);
    if(!proposal) return;
    handledTypes.add(adjustment.type);
    proposal.weeks.forEach(w=>{
      changedByWeekN[w.n] = w;
      workingWeeks = workingWeeks.map(existing=> existing.n===w.n ? w : existing);
    });
  });
  const weeks = Object.values(changedByWeekN);
  return weeks.length ? {weeks} : null;
}

// Two genuinely demanding efforts stacked too close together - covers VO2max, threshold,
// AND long runs, deliberately, not just high-intensity work: a long run's demand is mostly
// duration/musculoskeletal/glycogen-depletion rather than neuromuscular, a different flavor
// of fatigue than a hard interval session, but "don't stack another big stress on top of an
// unrecovered one" is the same underlying principle either way (and several long runs
// crammed close together - e.g. trying to make up missed ones, see the significant-tier note
// in classifySessionAdherence above about not cramming - is exactly the durability-focused
// version of this same risk). Standard "hard-easy" spacing guidance (e.g. Daniels' Running
// Formula's "no more than 2 quality days a week, easy days between") calls for roughly 48h
// minimum between genuinely demanding sessions of any of these three types to let recovery
// catch up; under 24h (same or next day) is a stronger concern regardless of anything else.
// This is NOT a flat "2 hard sessions = bad" rule, on purpose - it's gated on BOTH sessions
// actually being substantial (a token low-dose effort on one side lowers the concern) and,
// when real training-load history exists, scaled by the runner's current acute:chronic
// status (see training-load.js) - already-elevated recent load lowers tolerance for
// stacking another demanding effort close behind the last one, exactly matching "how close,
// how hard, what my body is expected to handle" as three real, computed inputs rather than
// one fixed threshold.
const HARD_SESSION_MIN_SPACING_HOURS = 48;
const HARD_SESSION_URGENT_SPACING_HOURS = 24;
const HARD_SESSION_SUBSTANTIAL_CREDIT = 0.5; // "this was genuinely most of a real demanding session", not a token effort
const HARD_TYPES = ['vo2max', 'threshold', 'long'];

function hardSessionInstances(sessionLog){
  const instances = [];
  (sessionLog||[]).forEach(s=>{
    if(!s.completedAt) return;
    HARD_TYPES.forEach(t=>{
      if(s.credits[t] > 0) instances.push({weekN:s.weekN, dayTag:s.dayTag, name:s.name, type:t, credit:s.credits[t], completedAt:s.completedAt});
    });
  });
  instances.sort((a,b)=> new Date(a.completedAt)-new Date(b.completedAt));
  return instances;
}

// What's actually being asked to recover, named honestly per type-pair - a hard interval
// session taxes neuromuscular/glycogen systems from INTENSITY; a long run taxes them (plus
// musculoskeletal/connective-tissue durability) from DURATION - genuinely different flavors
// of fatigue that happen to call for similar spacing, not the same fatigue restated.
function proximityRationale(prevType, curType){
  const bothLong = prevType==='long' && curType==='long';
  const eitherLong = prevType==='long' || curType==='long';
  if(bothLong) return 'musculoskeletal/connective-tissue durability and glycogen replenishment from two genuinely long efforts';
  if(eitherLong) return 'combining a high-intensity session with a long run compounds both the neuromuscular/glycogen cost of the hard effort and the durability cost of the long one';
  return 'glycogen resynthesis and neuromuscular recovery from genuinely high-intensity work';
}

function buildProximityNote(prev, cur, hoursApart, severity, acwr){
  const hrs = Math.round(hoursApart);
  const base = (prev.type===cur.type ? 'Two '+prev.type+' sessions' : prev.type+' ('+prev.dayTag+') and '+cur.type+' ('+cur.dayTag+')')+' landed only ~'+hrs+'h apart - standard hard-easy spacing calls for at least 48h between sessions demanding this much '+proximityRationale(prev.type, cur.type)+'.';
  const acwrNote = (acwr && acwr.status==='High') ? ' Recent training load is already running high, which lowers tolerance for stacking another demanding effort this close behind the last one.' : '';
  return severity==='urgent'
    ? base+acwrNote+' Worth easing the next few days - swap any upcoming quality work or long-run volume for easy running until there\'s been genuine recovery, rather than pushing through the rest of the week as scheduled.'
    : base+acwrNote+' Not necessarily a problem by itself - this can be fine depending on how hard each one really was and how recovery is tracking - but worth watching rather than stacking a third demanding day on top of it.';
}

export function detectHardSessionProximity(sessionLog, acwr){
  const instances = hardSessionInstances(sessionLog);
  const flags = [];
  for(let i=1;i<instances.length;i++){
    const prev = instances[i-1], cur = instances[i];
    const hoursApart = (new Date(cur.completedAt) - new Date(prev.completedAt))/3600000;
    if(hoursApart >= HARD_SESSION_MIN_SPACING_HOURS) continue;
    let severity = hoursApart < HARD_SESSION_URGENT_SPACING_HOURS ? 'urgent' : 'moderate';
    const bothSubstantial = prev.credit>=HARD_SESSION_SUBSTANTIAL_CREDIT && cur.credit>=HARD_SESSION_SUBSTANTIAL_CREDIT;
    if(acwr && acwr.status==='High' && severity==='moderate') severity = 'urgent'; // already-elevated load lowers tolerance regardless of individual session size
    if(!bothSubstantial && severity!=='urgent') continue; // two token efforts close together isn't the same risk
    flags.push({
      sessions:[prev, cur], hoursApart: Math.round(hoursApart*10)/10, severity,
      note: buildProximityNote(prev, cur, hoursApart, severity, acwr),
    });
  }
  return flags;
}

export async function getHardSessionProximityFlags(){
  try{
    const scan = await scanAdherenceWindow(WINDOW_WEEKS);
    let acwr = null;
    try{ acwr = computeACWR(await loadTrimpHistory()); }catch(e){}
    return detectHardSessionProximity(scan.sessionLog, acwr);
  }catch(e){ return []; }
}

export function hardSessionProximityBannerHTML(flags){
  if(!flags || !flags.length) return '';
  const cards = flags.map(f=>
    '<div class="card"><div class="sess-name" style="margin-bottom:4px; color:'+(f.severity==='urgent'?'var(--vo2)':'var(--threshold)')+';">&#9888; Hard sessions close together</div>'+
    '<div class="note" style="border-top:none; padding-top:0; font-size:13px;">'+f.note+'</div></div>'
  );
  return cards.join('');
}
