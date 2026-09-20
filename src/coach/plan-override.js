// @ts-nocheck
// Coach-driven plan rebuild - the propose/validate/apply/revert pipeline, deliberately
// modeled on tier-estimates.js's TIER2/3 ESTIMATE pattern (clamp -> snapshot -> save ->
// inline Apply/revert card) but adapted for a much bigger, higher-stakes payload: a plan
// change is never auto-applied (tier estimates save optimistically, this doesn't), and
// revert is a bounded history STACK rather than a single -previous slot, since plan edits
// are rarer and bigger than tier nudges and a single slot would make a two-steps-back
// correction impossible.
import { state } from '../state.js';
import { fetchCoachReply, loadLatestVerdict } from './chat.js';
import { compute10KTrajectoryBaseline, computeAheadOfScheduleSignals, computeGoalProgress, computeHMTrajectoryBaseline, formatAchievabilityNote, getBestAvailableLTPace, isGoalAchievabilityConcerning, projectedTimeFromLTPace, recomputeZones } from './goal-trajectory.js';
import { buildMethodologyReferenceText } from './methodology-reference.js';
import { describeReading, freshReading } from './cache-freshness.js';
import { adherenceTypeForDay, adherenceTypeLabel, buildSwapProposal, detectScheduledHardSessionProximity, getHardSessionProximityFlags, getLikelySwapSuggestions, getMissedSessionAdjustments } from './plan-adherence.js';
import { estimateLayoffImpact, getBestFitnessLTPace, getDaysSinceLastActivity, getEfficiencyTrend, getTrendSummary, loadTierEstimate } from './tier-estimates.js';
import { computeReadinessSignal } from './readiness.js';
import { computeDurabilityAdjustedProjectionSec, formatDurabilityNote, getDurabilitySignal } from './durability.js';
import { analyzeInjuryPatterns, checkCurrentInjuryRiskPattern } from './injury-tracking.js';
import { getActiveReturnToRun, refreshInjuryState, REST_WINDOW_WITHOUT_DATE_DAYS } from './return-to-run.js';
import { computeACWR, loadTrimpHistory } from './training-load.js';
import { applyPlanOverrides, buildWeeks, classifyReducedWeek, computeWeekPlannedKm, materializeWeek, SESSION_RECIPES, alternatingSurges, continuousTempo, fartlek, flatAlternativeToHill, hillRepeats, hillSprints, ladderReps, vo2maxReps } from '../data/plan.js';
import { auditBlock, auditOutline, dispN, summarizeWeeks, MAX_WEEKLY_RAMP } from './plan-audit.js';
import { describeGeneratedPlan, firstRebuildableWeekN, generatePlanWeeks, restWeeksBefore, scopeToJoin } from './plan-generator.js';
import { intentToSpec, requestPlanIntent } from './plan-intent.js';
import { blockRelativeWeekN, defaultGoalConfig, findGoalRaceDay, loadGoalConfig, saveGoalConfig, stampNewBlock } from '../data/goal-config.js';
import { archiveGoal, loadGoalHistory, planGoalArchival, truncateGoalHistory } from '../data/goal-history.js';
import { dateToTag, dateToYMD, findNextUpcomingWeek, parseDayTagDate, parseWeekEndDate, parseWeekStartDate } from '../lib/dates.js';
import { fmtDuration, fmtPaceExact, formatMinutesToClock, timeAgo } from '../lib/format.js';
import { notifyError } from '../lib/notify.js';
import { saveWithRetry } from '../lib/storage.js';
import { sleep } from '../lib/utils.js';
import { toggleChat } from '../ui/chat-panel.js';
import { renderCurrentWeek, renderNav, renderPageHeader } from '../ui/nav.js';
import { loadWorkoutLog } from '../ui/week-view.js';

// 'open' belongs here - it's a real, fully-supported day type (lib/dates.js's
// getFullWeekDayList already synthesizes it for any day not explicitly listed, and
// week-view.js has a dedicated render branch for it), and the system prompt below
// explicitly tells the model to use it for "remove a session" requests. Missing here until
// a real reported bug: a runner asked to remove a session, got a correctly-typed "open" day
// back from the model, and the app rejected the whole proposal as "unrecognized type open" -
// this whitelist was simply never updated when 'open' became a valid model output.
// Time-to-target and HR-recovery only exist between hard reps - a continuous easy or long
// run has neither, and mixing those in produced a confident but wholly artificial trend.
// See getTrendSummary's sessionTypes filter in tier-estimates.js.
const REP_ONLY_TREND_SESSION_TYPES = ['threshold', 'vo2max'];

const KNOWN_DAY_TYPES = ['easy', 'threshold', 'vo2max', 'long', 'race', 'open'];
// The "~25-30% of the week in one run" guideline is a 5-6-day-a-week number: it assumes the
// week has enough OTHER running days to spread volume across. On a genuine 4-day week the
// long run is arithmetically forced above it - a 20km long run in a 56km week is already 36%
// - so applying the 5-day figure there doesn't flag a real overload, it just fires on every
// single week forever and trains the reader to ignore it. Worse, it pushes toward the wrong
// fix: capping the long run is exactly backwards for a runner whose limiter is durability.
// Scaled by how many days the week actually runs instead.
const LONG_RUN_SHARE_WARN_PCT_BY_DAYS = {4: 0.40, 5: 0.34};
const LONG_RUN_SHARE_WARN_PCT_DEFAULT = 0.30;
function longRunShareWarnPct(week){
  const runningDays = (week.days||[]).filter(d=>d.type!=='open').length;
  return LONG_RUN_SHARE_WARN_PCT_BY_DAYS[runningDays] || LONG_RUN_SHARE_WARN_PCT_DEFAULT;
}

// How long a long run may get before it's worth questioning, as a multiple of the goal race
// distance. A flat "never longer than the race itself" rule reads as safe but is only
// correct for one distance: it's far too permissive for a 5K/10K goal (where 2-3x race
// distance is ordinary long-run practice) and far too restrictive for a half marathon, where
// mainstream plans (Pfitzinger, Daniels) routinely prescribe 22-24km long runs precisely
// because the closing kilometers of a half are a durability problem. Only for the marathon
// is "at or under race distance" actually the operative limit, and there the real cap is
// well below it.
function longRunCapKm(goalDistanceKm){
  if(goalDistanceKm<=12) return goalDistanceKm*2.5;
  if(goalDistanceKm<=25) return goalDistanceKm*1.15;
  return goalDistanceKm*0.85;
}
const WEEKLY_OVERLOAD_WARN_PCT = 10.5;
// This runner's standing weekly training-day pattern - a non-race day landing outside this
// set is scheduling drift, not a deliberate choice, since nothing else in the app persists
// a "preferred days" setting for the model to be reminded of at rebuild time.
const PREFERRED_TRAINING_DAYS = ['Mon', 'Wed', 'Thu', 'Sat'];

// Standard post-race RECOVERY guidance, by race distance - deliberately distinct from
// pre-race TAPER (see classifyReducedWeek in plan.js): roughly 1 week of easy/no-quality
// running for a 5K/10K, roughly 2 weeks for a half marathon, and commonly 2-4+ weeks
// (genuinely more variable, can reasonably run longer) for a marathon - not just "somewhat
// lighter," a real absence of quality work for that many weeks before resuming normal build.
function recoveryGuidanceForDistance(raceKm){
  if(raceKm>25) return {minWeeks:2, text:'roughly 2-4+ weeks of easy running with no quality work (marathon recovery is more individual and can reasonably run longer)'};
  if(raceKm>12) return {minWeeks:2, text:'roughly 2 weeks of easy running with no quality work'};
  return {minWeeks:1, text:'roughly 1 week of easy running with no quality work'};
}

// Deterministic, "bound don't block" checks - mirrors clampTierEstimate's philosophy.
// Only structurally-invalid input is a hard error (blocks Apply); everything else is a
// judgment call the runner should make themselves, surfaced as a warning on the card. `opts`
// is optional; `opts.source` can be 'rebalance' (see proposeReRampFromAdjustments, a
// missed-session-triggered restructure) or 'push' (see proposePushFromAheadSignal, an
// ahead-of-schedule-triggered push). Both are held to a stricter HARD-error bar than a
// free-text ask for drifting outside the runner's existing training-day framework - see
// the weekday check below. They are DELIBERATELY ASYMMETRIC beyond that: 'rebalance' ALSO
// hard-errors when the proposal provably didn't address the real, already-happened deficit
// that triggered it (see the reramp-type check below) - 'push' has NO equivalent check,
// and must never get one. A push proposal that concludes "the current plan is genuinely
// still right" (too close to race day, marginal readiness, etc.) is a fully legitimate
// answer to an invitation, not a defect the way silently ignoring a real miss is. Do not
// "fix" this asymmetry into a matching hard error for push.
export async function validatePlanOverride(currentWeeks, proposed, opts){
  opts = opts || {};
  const errors = [];
  const warnings = [];
  // Every message below is read by the RUNNER (they render straight into the proposal card and
  // are never fed back to the model), so they must use the same week numbers the nav tabs and
  // week header show. w.n is a stable storage key that restarts-at-1 display numbering hides -
  // quoting it here meant a warning about "Week 45" pointed at a tab labelled "Week 39".
  const cfgForWeekLabels = state.goalConfig || defaultGoalConfig();
  const wk = n => 'Week '+blockRelativeWeekN(n, cfgForWeekLabels);
  const wkLower = n => 'week '+blockRelativeWeekN(n, cfgForWeekLabels);
  if(!proposed || typeof proposed!=='object' || !Array.isArray(proposed.weeks)){
    errors.push('The proposal is missing a valid "weeks" array.');
    return {errors, warnings};
  }
  if(proposed.truncateAfter!=null && typeof proposed.truncateAfter!=='number'){
    errors.push('"truncateAfter" must be a week number.');
  }
  if(proposed.goalConfigPatch!=null && typeof proposed.goalConfigPatch!=='object'){
    errors.push('"goalConfigPatch" must be an object.');
  }
  if(proposed.goalConfigPatch && proposed.goalConfigPatch.activeGoals!=null){
    if(!Array.isArray(proposed.goalConfigPatch.activeGoals)){
      errors.push('"goalConfigPatch.activeGoals" must be an array.');
    } else {
      // goalId must stay stable for an existing goal, even when its target changes - the
      // plan's own race day carries the SAME goalId (see plan.js's goalId fields) to link
      // it back to this goal-config entry; renaming the id here (e.g. because the model
      // baked the new target time into the id, "hm-sub135" -> "hm-sub132") orphans that
      // link and silently breaks goal-trajectory tracking for it. Caught via a real
      // proposal that did exactly this.
      const currentGoalConfigForCheck = state.goalConfig || defaultGoalConfig();
      const currentByZoneKey = {};
      (currentGoalConfigForCheck.activeGoals||[]).forEach(g=>{ currentByZoneKey[g.zoneKey] = g; });
      proposed.goalConfigPatch.activeGoals.forEach((g,i)=>{
        if(!g.goalId || !g.zoneKey){
          errors.push('goalConfigPatch.activeGoals['+i+'] is missing "goalId"/"zoneKey" - it must match the real goal-config field names shown in the prompt (goalId, zoneKey, label, raceName, distanceKm, raceDate, goalTimeSec, goalTimeLabel, goalPaceSec, goalPaceLabel), not invented ones - otherwise it silently fails to apply.');
          return;
        }
        const existing = currentByZoneKey[g.zoneKey];
        if(existing && existing.goalId!==g.goalId){
          errors.push('goalConfigPatch renames the existing "'+g.zoneKey+'" goal\'s id from "'+existing.goalId+'" to "'+g.goalId+'" - goalId must stay the same when updating an existing goal\'s target, or the plan\'s own race day loses its link to it.');
        }
      });
    }
  }
  // A change can be pace/goal-target-only (goalConfigPatch, no week structure touched -
  // session paces are computed live from profile/goal-config, not baked into week JSON) or
  // week-structure-only (rep counts, session types, day placement) - only reject when
  // NEITHER is present, since that's a proposal with nothing to actually apply.
  if(!proposed.weeks.length && !proposed.goalConfigPatch){
    errors.push('The proposal did not include any weeks or a goal-config change to apply.');
    return {errors, warnings};
  }

  // A goal target getting genuinely HARDER (a meaningfully faster time) is a much bigger ask
  // of the training itself than of the label on a chart - closing a real gap needs more/
  // harder volume or frequency, not just a relabeled target. Caught live: a goal change
  // (sub-1:35 -> sub-1:30, a 5-minute/~5% ask) was accepted with the exact same plan
  // underneath it - nothing about weekly structure, volume, or intensity addressed how that
  // gap would actually close. Only fires when weeks is empty; a proposal that DOES restructure
  // alongside the goal change has nothing to flag here.
  const GOAL_TIGHTEN_WARN_PCT = 3;
  if(proposed.goalConfigPatch && Array.isArray(proposed.goalConfigPatch.activeGoals) && !proposed.weeks.length){
    const currentGoalConfigForTighten = state.goalConfig || defaultGoalConfig();
    const currentByGoalId = {};
    (currentGoalConfigForTighten.activeGoals||[]).forEach(g=>{ currentByGoalId[g.goalId] = g; });
    proposed.goalConfigPatch.activeGoals.forEach(g=>{
      const before = currentByGoalId[g.goalId];
      if(!before || before.goalTimeSec==null || g.goalTimeSec==null) return;
      if(g.goalTimeSec >= before.goalTimeSec) return;
      const pctFaster = (before.goalTimeSec - g.goalTimeSec)/before.goalTimeSec*100;
      if(pctFaster > GOAL_TIGHTEN_WARN_PCT){
        warnings.push('This sets '+(g.label||g.type||'the goal')+' to a target '+pctFaster.toFixed(1)+'% faster ('+(before.goalTimeLabel||'')+' → '+(g.goalTimeLabel||'')+') with NO change to weekly structure, volume, or session types - closing a gap that size essentially never happens on the exact same plan. If this is a real goal change, ask for an actual restructure, not just a relabeled target.');
      }
    });
  }

  // The plan-side mirror of the goal-tighten check above: a rebuild that leaves weekly
  // structure completely untouched while the deterministic pace-trend baseline
  // (goal-trajectory.js) says the current gap isn't closing fast enough - or has no real
  // build time left to close at all - is the same "closing a real gap needs a real
  // structural response, not silence" problem, just triggered by the trend instead of a
  // tightened target. Previously there was NO code-level link at all between "trajectory
  // says off-track" and "the plan should change" - only a soft, unenforced prompt
  // instruction asking the model's own two judgment calls to agree with each other. Only
  // checked against the half-marathon-equivalent GOAL slot - the 10K has no plan-override
  // wiring point of its own today (its build window is too short/mid-block for a rebuild
  // proposal to meaningfully act on). Uses state.goalConfig directly (not the shared
  // `goalConfig` const below, which isn't declared yet at this point in the function).
  if(!proposed.weeks.length){
    try{
      const goalConfigForAchievability = state.goalConfig || defaultGoalConfig();
      const hmGoalForAchievability = (goalConfigForAchievability.activeGoals||[]).find(g=>g.zoneKey==='GOAL');
      if(hmGoalForAchievability){
        const tenKGoalForCheckpoint = (goalConfigForAchievability.activeGoals||[]).find(g=>g.zoneKey==='RACE10K');
        const hmBaselineForCheck = await computeHMTrajectoryBaseline(hmGoalForAchievability, tenKGoalForCheckpoint);
        const a = hmBaselineForCheck.achievability;
        if(isGoalAchievabilityConcerning(a)){
          // A goalConfigPatch that genuinely RELAXES this specific goal's target (a real,
          // slower goalTimeSec - not just a restated or tightened one) IS the correct,
          // code-level-encouraged resolution to a bad achievability read (see the matching
          // "CRITICAL - the mirror-image case" prompt paragraph above) and must not be
          // nagged at as if nothing happened. Anything else - no patch at all, a patch that
          // doesn't touch this goal, or one that keeps the same/a faster time - still
          // leaves the unreachable target in place and should still warn. Caught live: an
          // earlier version of this check fired purely on `!proposed.weeks.length`, so even
          // a genuinely relaxed goalConfigPatch response got wrongly flagged as "made no
          // change" - a false positive on exactly the outcome this check exists to encourage.
          const patchedGoal = proposed.goalConfigPatch && Array.isArray(proposed.goalConfigPatch.activeGoals)
            ? proposed.goalConfigPatch.activeGoals.find(g=>g.goalId===hmGoalForAchievability.goalId) : null;
          const genuinelyRelaxed = !!(patchedGoal && patchedGoal.goalTimeSec!=null && hmGoalForAchievability.goalTimeSec!=null
            && patchedGoal.goalTimeSec > hmGoalForAchievability.goalTimeSec);
          if(!genuinelyRelaxed){
            const why = a.classification==='not-enough-time' ? 'has no real build time left to close the current gap through training alone'
              : a.classification==='not-closing' ? 'shows the threshold-pace trend flat or moving the wrong way despite real build time still left'
              : 'needs the threshold-pace trend to run roughly '+a.accelerationFactor.toFixed(1)+'x faster than it currently is to be reached by race day';
            warnings.push('The deterministic pace trend for '+(hmGoalForAchievability.label||'the goal')+' '+why+', but this proposal makes no change to weekly structure, volume, session types, OR the goal target itself. If this is meant to actually close that gap, propose a real restructure - if the gap genuinely cannot be closed, propose a more realistic (slower) goal time (goalConfigPatch) instead - if neither, say explicitly why the current plan and target are still the right call despite the trend.');
          }
        }
      }
    }catch(e){}
  }

  proposed.weeks.forEach(w=>{
    if(typeof w.n!=='number'){ errors.push('A proposed week is missing a valid week number.'); return; }
    if(!w.dates || typeof w.dates!=='string'){ errors.push(wk(w.n)+' is missing a "dates" range.'); }
    if(w.year!=null && typeof w.year!=='number'){ errors.push(wk(w.n)+'\'s "year" must be a number (e.g. 2027), not "'+w.year+'".'); }
    if(!Array.isArray(w.days)){ errors.push(wk(w.n)+' is missing a "days" array.'); return; }
    w.days.forEach(d=>{
      if(!d.tag) errors.push(wk(w.n)+' has a day with no tag.');
      if(!KNOWN_DAY_TYPES.includes(d.type)) errors.push(wk(w.n)+', day "'+(d.tag||'?')+'" has an unrecognized type "'+d.type+'".');
      // A recipe the registry doesn't know would fail silently at render time (materializeDay
      // keeps the stored data and logs), so catch the typo here where it can still be fixed.
      if(d.recipe && !SESSION_RECIPES[d.recipe.fn]){
        errors.push(wk(w.n)+', "'+(d.name||d.type)+'" ('+d.tag+') uses an unknown recipe function "'+d.recipe.fn+'" - it must be one of: '+Object.keys(SESSION_RECIPES).join(', ')+'.');
      }
      // A race day landing on the wrong calendar date is a serious, unambiguous error, not
      // a soft guideline - caught live: a proposal correctly identified the CURRENT plan's
      // race-day tag had the wrong weekday label, but in "fixing" it shifted the actual
      // date by a day (moved the real Sep 5 race to Sep 6) instead of just correcting the
      // label. The goal's own raceDate in goal-config is authoritative for when the race
      // actually is - a proposed race day must match it exactly.
      // A non-race day landing outside this runner's standing preferred training days is
      // schedule drift, not a deliberate choice - a race day is exempt since it must land on
      // the real calendar date regardless of weekday. A free-text ask stays a warning here
      // (the runner might genuinely be asking for a 5th day), but an AUTO-TRIGGERED
      // rebalance OR push was explicitly told to stay within the existing framework unless
      // the gap/surplus truly can't fit - so a drift there is a real contract violation,
      // not a judgment call to leave for the runner to notice and reject. An 'open' day is
      // also exempt - it has no actual training on it (that's the whole point of removing a
      // session down to one), so which weekday it lands on isn't "schedule drift" the way a
      // real prescribed session would be.
      if(d.type!=='race' && d.type!=='open' && d.tag){
        const weekday = d.tag.split(' - ')[0];
        if(!PREFERRED_TRAINING_DAYS.includes(weekday)){
          const msg = wk(w.n)+', "'+(d.name||d.type)+'" ('+d.tag+') falls on a '+weekday+' - outside this runner\'s preferred training days ('+PREFERRED_TRAINING_DAYS.join('/')+').';
          (opts.source==='rebalance' || opts.source==='push' ? errors : warnings).push(msg);
        }
      }
      if(d.type==='race' && d.goalId){
        const goalConfigForRaceCheck = state.goalConfig || defaultGoalConfig();
        const matchingGoal = (goalConfigForRaceCheck.activeGoals||[]).find(g=>g.goalId===d.goalId);
        if(matchingGoal && matchingGoal.raceDate){
          // parseDayTagDate builds its Date via `new Date("Sep 5, 2026")`, which JS parses
          // at LOCAL midnight - converting that through .toISOString() (UTC) can silently
          // shift the calendar day by one depending on the runtime's timezone. Comparing
          // local calendar components (not a UTC-normalized string) on both sides avoids
          // that trap - and matchingGoal.raceDate ("2026-09-05", a bare date-only ISO
          // string) must be parsed with an explicit local time-of-day too, since JS treats
          // a bare "YYYY-MM-DD" string as UTC midnight, not local - a second, different
          // timezone trap layered on the first one if left unparsed this way.
          const parsedTagDate = parseDayTagDate(d.tag, proposed.weeks);
          const parsedRaceDate = new Date(matchingGoal.raceDate+'T00:00:00');
          const localYMD = dt => dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
          const tagDateStr = parsedTagDate ? localYMD(parsedTagDate) : null;
          const raceDateStr = localYMD(parsedRaceDate);
          if(tagDateStr && tagDateStr!==raceDateStr){
            errors.push(wk(w.n)+'\'s race day is tagged "'+d.tag+'" ('+tagDateStr+'), but the "'+d.goalId+'" goal\'s actual race date is '+raceDateStr+' - the race day must land on the real race date exactly, not be shifted while correcting weekday labels.');
          }
        }
      }
    });
  });
  // A session written as hand-authored `data` instead of a `recipe` has its prescribed paces
  // frozen at the fitness of the day it was written - permanently, and invisibly, since the
  // HR band rendered next to that dead pace number keeps updating (see SESSION_RECIPES in
  // data/plan.js for the full account). How much that matters scales with how far ahead the
  // session sits, which is what this check is gated on rather than a flat rule:
  //
  // A one- or two-week proposal is a near-term tweak - those sessions get run within days, at
  // essentially the fitness they were written against, so freezing them changes nothing real
  // and rejecting them would block ordinary edits for no benefit.
  //
  // A proposal spanning three or more weeks is a BLOCK being authored wholesale, months of it
  // at once. That is precisely the case that produced a 52-week plan prescribing one fixed
  // threshold pace from September to the following August, and it is worth refusing outright:
  // unlike a bad rep count, nothing downstream will ever surface it.
  const BLOCK_PROPOSAL_WEEKS = 3;
  if(proposed.weeks.length >= BLOCK_PROPOSAL_WEEKS){
    const frozen = [];
    proposed.weeks.forEach(w=>{
      (w.days||[]).forEach(d=>{
        if(d.type!=='open' && d.tag && !d.recipe) frozen.push(wkLower(w.n)+' "'+(d.name||d.type)+'"');
      });
    });
    if(frozen.length){
      errors.push('This proposal builds '+proposed.weeks.length+' weeks, but '+frozen.length+' of its sessions carry hand-written numbers instead of a "recipe" ('+frozen.slice(0,4).join(', ')+(frozen.length>4?', ...':'')+'). Over a block this long that freezes every one of those prescribed paces at today\'s fitness for the life of the plan - the sessions would still be prescribing today\'s threshold pace next summer. Re-emit each training day as {"recipe":{"fn":...,"args":{...}}} using the recipe functions listed in the instructions, with no "data" block.');
    }
  }

  if(errors.length) return {errors, warnings};

  // Every km/duration check below reads day.data, which a recipe-based proposal doesn't carry
  // - the app computes it. Materialize a SEPARATE copy for validation only: `proposed` itself
  // must keep its recipes, since that's what gets stored, and baking data into it here would
  // reintroduce the exact frozen-pace problem recipes exist to prevent.
  const proposedM = proposed.weeks.map(materializeWeek);

  // Merge onto a copy of the current plan (without touching storage) purely to preview
  // week-over-week totals and structure - same upsert logic applyPlanOverrides itself uses.
  const merged = currentWeeks.slice();
  proposedM.forEach(pw=>{
    const idx = merged.findIndex(w=>w.n===pw.n);
    if(idx!==-1) merged[idx] = pw; else merged.push(pw);
  });
  merged.sort((a,b)=>a.n-b.n);

  // Week-over-week overload (~10%/week ramp-rate guideline), skipped around cutback/race
  // weeks. Only surfaced for a pair where at least one week is actually part of THIS
  // proposal - the plan's own existing weeks can already have this characteristic
  // (e.g. week 1's post-taper-week ramp), which is real but not something this specific
  // change caused, and showing it anyway just reads as unexplained noise about weeks the
  // runner didn't ask about.
  const touchedWeekNums = new Set(proposed.weeks.map(w=>w.n));
  for(let i=1;i<merged.length;i++){
    const prev = merged[i-1], cur = merged[i];
    if(!touchedWeekNums.has(prev.n) && !touchedWeekNums.has(cur.n)) continue;
    if(cur.cutback || cur.race || prev.cutback || prev.race) continue;
    const prevKm = computeWeekPlannedKm(prev), curKm = computeWeekPlannedKm(cur);
    if(prevKm>0){
      const pctChange = (curKm-prevKm)/prevKm*100;
      if(pctChange>WEEKLY_OVERLOAD_WARN_PCT){
        warnings.push(wk(cur.n)+' jumps '+pctChange.toFixed(0)+'% over week '+prev.n+' ('+prevKm+'km → '+curKm+'km) - above the usual ~10%/week ramp-rate guideline.');
      }
    }
  }

  // Hard-session (vo2max/threshold/long) stacking risk - the proposal-checking counterpart
  // to plan-adherence.js's detectHardSessionProximity, which only ever runs against real
  // logged history today. A rebalance that moves sessions around across several weeks is
  // far more likely to create a new adjacency violation than a routine free-text ask, so
  // this is checked here against the actual merged result rather than left undetected until
  // the runner happens to notice it on the calendar. Scoped to flags touching a touched
  // week, same convention as the overload check above; kept a warning (not promoted for
  // opts.source==='rebalance') since - like the existing back-to-back-quality-day check
  // below - this is real judgment territory (how hard each session actually runs), not a
  // provable no-op.
  try{
    let acwr = null;
    try{ acwr = computeACWR(await loadTrimpHistory()); }catch(e){}
    const proximityFlags = detectScheduledHardSessionProximity(merged, acwr);
    proximityFlags.forEach(f=>{
      const touchesProposal = f.sessions.some(s=>touchedWeekNums.has(s.weekN));
      if(touchesProposal) warnings.push(f.note);
    });
  }catch(e){}

  // Returning from a real layoff needs a genuine ramp back in, not a proposal that resumes
  // the plan's pre-gap volume immediately just because that's what the JSON already says
  // for that week - see estimateLayoffImpact in tier-estimates.js (literature-grounded,
  // scales with how long the gap was). Checked against the EARLIEST week this proposal
  // actually touches, since that's the resumption point a real rebuild is making a claim
  // about; skipped when that week is itself a deliberate cutback/race week (already reduced
  // by definition).
  try{
    const inactivity = await getDaysSinceLastActivity();
    const layoff = inactivity ? estimateLayoffImpact(inactivity.days) : null;
    if(layoff && layoff.rampWeeksRecommended>0 && proposed.weeks.length){
      const earliestN = Math.min(...proposed.weeks.map(w=>w.n));
      const idx = merged.findIndex(w=>w.n===earliestN);
      const cur = idx!==-1 ? merged[idx] : null;
      const prev = idx>0 ? merged[idx-1] : null;
      if(cur && prev && !cur.cutback && !cur.race){
        const prevKm = computeWeekPlannedKm(prev), curKm = computeWeekPlannedKm(cur);
        if(prevKm>0 && curKm > prevKm*0.85){
          warnings.push('A '+layoff.days+'-day layoff is active ('+layoff.severity+', recommended ramp ~'+layoff.rampWeeksRecommended+' week(s)) but '+wkLower(cur.n)+' ('+curKm+'km) doesn\'t look meaningfully reduced from '+wkLower(prev.n)+' ('+prevKm+'km) - confirm this proposal actually ramps back in rather than resuming pre-gap volume immediately.');
        }
      }
      // Volume isn't the whole story - resuming full threshold/VO2max intensity immediately
      // after a real layoff carries its own injury risk independent of whether weekly km
      // looks reduced, the same reasoning the post-race recovery check below already applies
      // to racing specifically. Checked across the whole ramp window (rampWeeksRecommended
      // weeks starting at the earliest touched week), not just the first one.
      if(idx!==-1){
        for(let k=0;k<layoff.rampWeeksRecommended;k++){
          const rampWeek = merged[idx+k];
          if(!rampWeek) break;
          if(rampWeek.cutback || rampWeek.race) continue;
          const hasQuality = (rampWeek.days||[]).some(d=>d.type==='threshold'||d.type==='vo2max');
          if(hasQuality){
            warnings.push('A '+layoff.days+'-day layoff is active ('+layoff.severity+', recommended ramp ~'+layoff.rampWeeksRecommended+' week(s)) but '+wkLower(rampWeek.n)+' (within the ramp window) includes threshold/VO2max work - standard return-to-training guidance calls for easing back in with easy/moderate volume before resuming full-intensity quality work, not just reduced distance at the same intensity.');
            break;
          }
        }
      }
    }
  }catch(e){}

  // An ACTIVE injury is a harder constraint than the layoff check above, and a different one:
  // the layoff guard asks whether enough fitness was lost to warrant easing back, this asks
  // whether the tissue can take the load at all. See return-to-run.js for why they are
  // separate tier tables. The caps here are computed deterministically from the injury's own
  // duration and severity, so the model cannot talk its way past them by arguing the runner
  // feels fine - it can only propose weeks that respect them.
  //
  // Held to the same asymmetric bar as 'rebalance': for a proposal this app itself requested
  // BECAUSE of the injury (source 'injury-return'), quality work inside the medically-
  // indicated hold window is a provable failure to do the one thing it was asked to do, so it
  // hard-errors and blocks Apply. For an ordinary free-text rebuild it stays a warning - the
  // runner may have a reason, and this app does not get to refuse a plan on their behalf.
  try{
    const rtr = await getActiveReturnToRun();
    if(rtr && rtr.caps && proposed.weeks.length){
      const isReturnProposal = opts.source==='injury-return';
      const push = msg => { if(isReturnProposal) errors.push(msg); else warnings.push(msg); };
      const injuryLabel = (rtr.injury.bodyPart || 'injury')+' ('+rtr.injury.severity+', '+rtr.daysOut+' days out)';
      const earliestN = Math.min(...proposed.weeks.map(w=>w.n));
      const idx = merged.findIndex(w=>w.n===earliestN);
      // Quality is checked across the whole remaining hold window, not just the first week -
      // a proposal that pushes the threshold session one week later and calls it a return
      // ramp is exactly the failure mode worth catching.
      if(idx!==-1 && !rtr.caps.qualityAllowed){
        for(let k=0; k<rtr.caps.qualityHoldWeeksRemaining; k++){
          const holdWeek = merged[idx+k];
          if(!holdWeek) break;
          const quality = (holdWeek.days||[]).filter(d=>d.type==='threshold'||d.type==='vo2max');
          if(quality.length){
            push('Return-to-running is active for '+injuryLabel+' and threshold/VO2max work is on hold for another '+
              rtr.caps.qualityHoldWeeksRemaining+' week(s), but '+wkLower(holdWeek.n)+' still contains '+
              quality.map(d=>d.name).join(', ')+'. Volume comes back before intensity does when returning from injury.');
            break;
          }
        }
      }
      // Volume ceilings, checked only where a real pre-injury baseline was snapshotted (a
      // ramp expressed as a percentage of an unknown number is not a check, it's a guess).
      if(idx!==-1 && rtr.caps.weeklyKm!=null){
        const firstWeek = merged[idx];
        if(firstWeek){
          const km = computeWeekPlannedKm(firstWeek);
          if(km > rtr.caps.weeklyKm*1.1){
            push('Return-to-running is active for '+injuryLabel+': week '+rtr.rampWeek+' of the ramp should sit near '+
              rtr.caps.weeklyKm+'km ('+rtr.caps.volumePct+'% of the '+rtr.injury.preInjuryWeeklyKm+'km pre-injury week), but '+
              wkLower(firstWeek.n)+' is '+km+'km.');
          }
          if(rtr.caps.longRunKm!=null){
            let longest = 0, longestName = '';
            (firstWeek.days||[]).forEach(d=>{
              if(d.type!=='long' || !d.data) return;
              const k = d.data.totalKm!=null ? parseFloat(d.data.totalKm) : (parseFloat(d.data.km)||0);
              if(isFinite(k) && k>longest){ longest = k; longestName = d.name||'the long run'; }
            });
            if(longest > rtr.caps.longRunKm*1.1){
              push('Return-to-running is active for '+injuryLabel+': the long run should be back around '+
                rtr.caps.longRunKm+'km at this point in the ramp, but '+wkLower(firstWeek.n)+' prescribes '+longest+'km ('+longestName+').');
            }
          }
        }
      }
      // Still not running at all: any proposal that leaves running on the calendar before the
      // expected return date is making a claim about the injury that nothing supports.
      if(rtr.phase==='resting' && rtr.injury.expectedReturnDate){
        const runningBefore = [];
        // Only days still ahead. A proposal that spans the current week necessarily CONTAINS
        // that week's elapsed days - whole weeks are replaced, so history comes along with
        // them - and those days are not something anyone is scheduling. Flagging them told the
        // runner their plan "still schedules running on Mon - Sep 14" on September 20th, which
        // is both impossible to act on and untrue. Caught live on exactly that.
        const startOfToday = new Date(); startOfToday.setHours(0,0,0,0);
        proposed.weeks.forEach(w=>{
          const mergedWeek = merged.find(m=>m.n===w.n);
          (((mergedWeek||{}).days)||[]).forEach(d=>{
            const dt = parseDayTagDate(d.tag, merged);
            if(!dt || dt < startOfToday) return;
            const km = d.data ? (parseFloat(d.data.totalKm) || parseFloat(d.data.km) || 0) : 0;
            if(km>0 && d.type!=='open' && dt < new Date(rtr.injury.expectedReturnDate+'T00:00:00')) runningBefore.push(d.tag);
          });
        });
        if(runningBefore.length){
          push('Running is not expected to resume until '+rtr.injury.expectedReturnDate+' ('+injuryLabel+'), but this proposal still schedules running on '+
            runningBefore.slice(0,4).join(', ')+(runningBefore.length>4 ? (' and '+(runningBefore.length-4)+' more') : '')+'.');
        }
      }
    }
  }catch(e){}

  // A rebuild proposed while several sessions of some type have been missed recently (see
  // plan-adherence.js - weighted by how specifically that type serves the CURRENTLY ACTIVE
  // goal, not a flat count: missing threshold work matters more training for a half than a
  // 5K, missing long runs matters more for a marathon than a 5K, and missing easy runs is
  // never flagged as urgently as missing a goal-critical type) needs to actually address
  // that gap, not leave the already-scheduled distance for that type untouched as if the
  // gap never happened - the same "a real gap needs a real structural response, not
  // silence" reasoning as the goal-tighten/achievability checks elsewhere in this function.
  // Aggregates each flagged type's session COUNT and total km across every touched week
  // (proposed.weeks) and compares that sum against the same touched weeks' ORIGINAL count/
  // km (currentWeeks, not the proposal itself) - deliberately NOT a same-slot/same-week
  // comparison: a genuine rebalance might legitimately trim this type in one touched week
  // while adding a new occurrence of it in another, and a same-slot check would wrongly
  // flag that as "unchanged" even though the real total dose increased. Only flags when
  // BOTH the count and the total km are unchanged (or the proposal has strictly more/equal
  // km at the exact same count) - any real structural change (added/removed occurrence,
  // net km delta) means this specific check has nothing to say. getSessionKm normalizes the
  // two different data shapes in this plan (long/threshold/vo2max/race use data.totalKm,
  // easy uses data.km). An auto-triggered rebalance (opts.source==='rebalance') is held to
  // this as a hard ERROR, not a warning - a rebalance that provably didn't move the needle
  // on the very gap that triggered it shouldn't be one click from Apply; a free-text ask
  // stays a warning, since the runner may have a specific reason this type wasn't the point
  // of THIS particular request.
  try{
    const missedAdjustments = await getMissedSessionAdjustments();
    const reramp = missedAdjustments.filter(a=>a.reramp);
    if(reramp.length && proposed.weeks.length){
      const getSessionKm = day=>{
        if(!day || !day.data) return null;
        if(day.data.totalKm!=null) return parseFloat(day.data.totalKm);
        if(day.data.km!=null) return parseFloat(day.data.km);
        return null;
      };
      reramp.forEach(adj=>{
        let origTotalKm = 0, origCount = 0, pwTotalKm = 0, pwCount = 0, anyKmMissing = false;
        const touchedWeekNs = [];
        proposedM.forEach(pw=>{
          const origWeek = currentWeeks.find(w=>w.n===pw.n);
          if(!origWeek) return;
          touchedWeekNs.push(pw.n);
          (origWeek.days||[]).filter(d=>adherenceTypeForDay(d, origWeek)===adj.type).forEach(d=>{
            const km = getSessionKm(d);
            if(km==null){ anyKmMissing = true; return; }
            origTotalKm += km; origCount++;
          });
          (pw.days||[]).filter(d=>adherenceTypeForDay(d, pw)===adj.type).forEach(d=>{
            const km = getSessionKm(d);
            if(km==null){ anyKmMissing = true; return; }
            pwTotalKm += km; pwCount++;
          });
        });
        // Nothing to compare - this type wasn't scheduled in any touched week before this
        // proposal (origCount===0, so there's no "already-scheduled" baseline to check
        // against), or a km figure couldn't be read at all - not this check's concern.
        if(origCount===0 || anyKmMissing) return;
        if(pwCount===origCount && pwTotalKm>=origTotalKm){
          const gapDescription = adj.kind==='consistentShortfall'
            ? adherenceTypeLabel(adj.type)+' sessions have consistently landed around '+adj.avgPct+'% of prescribed work'
            : Math.round(adj.missed)+' of the last '+adj.scheduled+' '+adherenceTypeLabel(adj.type)+' sessions were missed';
          // Display numbering, same as every other message in this function - these join raw
          // week keys, which is why the earlier pass over 'Week '+w.n did not catch them.
          const touchedWeekLabels = touchedWeekNs.map(n=>blockRelativeWeekN(n, cfgForWeekLabels));
          const weekLabel = touchedWeekLabels.length>1 ? ('weeks '+touchedWeekLabels.join(', ')) : ('week '+touchedWeekLabels[0]);
          const msg = gapDescription+' ('+adj.windowWeeks+'-week window, '+adj.importance+' for your current goal) but across '+weekLabel+', '+adherenceTypeLabel(adj.type)+' stays at the same '+origCount+' session(s) totaling at least '+origTotalKm.toFixed(1)+'km ('+pwTotalKm.toFixed(1)+'km now) - '+adj.note;
          (opts.source==='rebalance' ? errors : warnings).push(msg);
        }
      });
    }
  }catch(e){}

  // Standard sports-science guidance calls for a genuine reduced-volume, no-quality-work
  // RECOVERY period after a race before resuming normal build/peak structure - see
  // recoveryGuidanceForDistance above for the actual thresholds (1 week for 5K/10K, 2 weeks
  // for a half marathon, 2-4+ for a marathon). Checked across the WHOLE resulting plan, not
  // just touched weeks - this is a standing structural gap worth surfacing on every rebuild
  // until it's actually fixed, not just something a specific edit needs to have caused (same
  // reasoning as why the goal-tighten check below isn't gated to a particular proposal shape).
  for(let i=0;i<merged.length-1;i++){
    const raceWeek = merged[i];
    const raceDay = (raceWeek.days||[]).find(d=>d.type==='race');
    if(!raceDay) continue;
    const raceKm = (raceDay.data && raceDay.data.km) || 0;
    const guidance = recoveryGuidanceForDistance(raceKm);
    const nextWeek = merged[i+1];
    const nextHasQuality = (nextWeek.days||[]).some(d=>d.type==='threshold'||d.type==='vo2max');
    const raceWeekKm = computeWeekPlannedKm(raceWeek);
    const nextKm = computeWeekPlannedKm(nextWeek);
    const notReduced = raceWeekKm>0 && nextKm > raceWeekKm*0.8;
    if(nextHasQuality || notReduced){
      warnings.push(wk(raceWeek.n)+'\'s race ('+(raceKm?raceKm.toFixed(1)+'km ':'')+raceDay.name+') has no real recovery week after it - week '+nextWeek.n+' '+(nextHasQuality?'includes threshold/VO2max work':('resumes similar volume ('+nextKm+'km vs. '+raceWeekKm+'km)'))+' the very next week. Standard guidance calls for '+guidance.text+' before resuming normal training after a race like this.');
      continue; // already flagged for resuming immediately - don't also check the longer window below for the same race
    }
    // A half-marathon-or-longer race needs MORE than just the first week eased back - check
    // that quality work doesn't reappear before the full recovery window guidance.minWeeks
    // calls for, not just that week 1 looked reduced.
    for(let k=1;k<guidance.minWeeks;k++){
      const recoveryWeek = merged[i+1+k];
      if(!recoveryWeek) break; // plan doesn't extend far enough yet to check further out
      if((recoveryWeek.days||[]).some(d=>d.type==='threshold'||d.type==='vo2max')){
        warnings.push(wk(raceWeek.n)+'\'s race ('+(raceKm?raceKm.toFixed(1)+'km ':'')+raceDay.name+') needs '+guidance.text+', but '+wkLower(recoveryWeek.n)+' (only '+(k+1)+' week(s) after the race) already includes threshold/VO2max work - that\'s resuming quality work sooner than standard guidance for this distance.');
        break;
      }
    }
  }

  // Standard taper guidance for a half-marathon-or-shorter goal race is roughly ONE week of
  // meaningfully reduced volume/intensity before the race, not two - the last genuine
  // fitness-building (threshold/VO2max/long) session belongs about a week out. A cutback
  // week whose START is a week or more before the race (i.e. it isn't actually race week
  // itself) is the second-taper-week pattern that's too long, UNLESS a real, currently-active
  // layoff/illness reason (see the layoff check above) genuinely calls for more - checked
  // here so that reason has to be active, not just assumed, before a longer taper is treated
  // as normal. Uses classifyReducedWeek (plan.js) rather than raw days-before-any-goal-race
  // math, so a genuine POST-race recovery week - which is also "cutback" but a different
  // thing entirely (see recoveryGuidanceForDistance above) - never gets mistaken for an
  // overlong pre-race taper.
  const goalConfig = state.goalConfig || defaultGoalConfig();
  try{
    const inactivityForTaper = await getDaysSinceLastActivity();
    const layoffForTaper = inactivityForTaper ? estimateLayoffImpact(inactivityForTaper.days) : null;
    const activeLayoffReason = layoffForTaper && layoffForTaper.rampWeeksRecommended>0 ? layoffForTaper : null;
    // Only flagged with no active layoff/illness reason on record - when one IS active, a
    // longer taper is the legitimate, deliberate call this check exists to allow, not
    // something to nag about every time.
    if(!activeLayoffReason){
      proposed.weeks.forEach(w=>{
        if(!w.cutback || w.race) return;
        const classification = classifyReducedWeek(merged, w.n);
        if(!classification || classification.kind!=='taper') return;
        const wStart = parseWeekStartDate(w);
        const raceDate = classification.raceDay && parseDayTagDate(classification.raceDay.tag, merged);
        if(!wStart || !raceDate) return;
        const daysToRace = Math.round((raceDate-wStart)/86400000);
        if(daysToRace>=7){
          warnings.push(wk(w.n)+' is marked cutback/taper starting '+daysToRace+' days before '+(classification.raceDay.name||'the race')+' - that\'s a second taper week, not race week itself. Standard guidance is roughly ONE week of reduced volume before the race, unless a real, currently-active reason calls for more - no active layoff/illness reason is on record right now, so this looks like the default taper running long rather than a deliberate call.');
        }
      });
    }
  }catch(e){}

  // Long-run share of week + exceeds the runner's own active race distance.
  const maxGoalDistanceKm = Math.max(0, ...(goalConfig.activeGoals||[]).map(g=>g.distanceKm||0));
  const goalActive = (goalConfig.activeGoals||[]).some(g=>g.zoneKey==='GOAL');
  const race10kActive = (goalConfig.activeGoals||[]).some(g=>g.zoneKey==='RACE10K');
  proposedM.forEach(w=>{
    const weekKm = computeWeekPlannedKm(w);
    w.days.forEach(d=>{
      const zoneStr = (d.zone||'').toLowerCase();
      if(!goalActive && zoneStr.includes('goal')){
        warnings.push(wk(w.n)+', "'+d.name+'" references the GOAL pace zone, but no half-marathon-equivalent goal is currently active - this zone has no real meaning right now.');
      }
      if(!race10kActive && zoneStr.includes('race10k')){
        warnings.push(wk(w.n)+', "'+d.name+'" references the RACE10K pace zone, but no 10K-equivalent goal is currently active - this zone has no real meaning right now.');
      }
      if(d.type!=='long') return;
      const longKm = parseFloat(d.data && d.data.totalKm) || 0;
      const shareCap = longRunShareWarnPct(w);
      if(weekKm>0 && longKm/weekKm > shareCap){
        warnings.push(wk(w.n)+'\'s long run ('+longKm+'km) is '+Math.round(longKm/weekKm*100)+'% of that week\'s '+weekKm+'km total - above the ~'+Math.round(shareCap*100)+'% single-run guideline for a '+(w.days||[]).filter(x=>x.type!=='open').length+'-day week.');
      }
      const longCap = maxGoalDistanceKm>0 ? longRunCapKm(maxGoalDistanceKm) : 0;
      if(longCap>0 && longKm>longCap){
        warnings.push(wk(w.n)+'\'s long run ('+longKm+'km) is past the ~'+longCap.toFixed(1)+'km sensible ceiling for a '+maxGoalDistanceKm.toFixed(1)+'km goal race.');
      }
    });
  });

  // Back-to-back quality (threshold/vo2max) days with no easy/rest day between.
  proposed.weeks.forEach(w=>{
    const qualityDays = w.days
      .filter(d=>d.type==='threshold'||d.type==='vo2max')
      .map(d=>({d, date:parseDayTagDate(d.tag, proposed.weeks)}))
      .filter(x=>x.date)
      .sort((a,b)=>a.date-b.date);
    for(let i=1;i<qualityDays.length;i++){
      const gapDays = Math.round((qualityDays[i].date - qualityDays[i-1].date)/86400000);
      if(gapDays<=1){
        warnings.push(wk(w.n)+': "'+qualityDays[i-1].d.name+'" and "'+qualityDays[i].d.name+'" sit on back-to-back days with no easy/rest day between them.');
      }
    }
  });

  // Orphaned log history: a day-tag with real logged history that a replaced week no
  // longer includes. Scoped to touched weeks only, not a full-plan scan.
  for(const pw of proposed.weeks){
    const before = currentWeeks.find(w=>w.n===pw.n);
    if(!before) continue;
    const newTags = new Set(pw.days.map(d=>d.tag));
    for(const oldDay of before.days){
      if(newTags.has(oldDay.tag)) continue;
      try{
        const log = await loadWorkoutLog(pw.n, oldDay.tag);
        if(log && (log.completed || log.skipped)){
          warnings.push(wk(pw.n)+' drops "'+oldDay.tag+'" ('+oldDay.name+'), which has logged history under it - that history won\'t be orphaned, but it also won\'t show up connected to the new plan unless a day reuses the same tag.');
        }
      }catch(e){}
    }
  }

  return {errors, warnings};
}

async function buildPersonalizationContext(){
  const parts = [];
  try{
    const best = await getBestFitnessLTPace();
    if(best.value!=null) parts.push('Current best-known LT pace: '+fmtPaceExact(best.value)+' (source: '+best.source+(best.updatedAt?(', '+timeAgo(best.updatedAt)):'')+').');
  }catch(e){}
  try{
    const t2 = await loadTierEstimate(2);
    const t3 = await loadTierEstimate(3);
    if(t2) parts.push('Tier 2 (outdoor) estimate: '+JSON.stringify(t2)+'.');
    if(t3) parts.push('Tier 3 (treadmill) estimate: '+JSON.stringify(t3)+'.');
  }catch(e){}
  try{
    const progress = await computeGoalProgress();
    if(progress){
      if(progress.tenK) parts.push(progress.tenK.label+' gap: '+progress.tenK.gap10KSec+'s/km vs. where the plan expects today.');
      if(progress.hm) parts.push(progress.hm.label+' gap: '+progress.hm.gapHMSec+'s/km vs. where the plan expects today.');
    }
  }catch(e){}
  // The deterministic "is this goal actually reachable from here" read, stated as a hard
  // fact BEFORE the model drafts anything - previously this classification only existed
  // inside validatePlanOverride's own achievability check, which only ever ran AFTER the
  // model had already drafted a response, so the model itself had no reliable way to know
  // if the goal was genuinely unreachable while writing its reply. Paired with the
  // fitness-implied projected time (the same number already shown on the front-page goal
  // gauge, "Current fitness projects to roughly...") as the concrete anchor for what a
  // genuinely more realistic alternative target should be - not a number the model has to
  // invent from scratch.
  try{
    const goalConfigForAchievabilityContext = state.goalConfig || defaultGoalConfig();
    const hmGoalForAchievabilityContext = (goalConfigForAchievabilityContext.activeGoals||[]).find(g=>g.zoneKey==='GOAL');
    if(hmGoalForAchievabilityContext){
      const tenKGoalForAchievabilityContext = (goalConfigForAchievabilityContext.activeGoals||[]).find(g=>g.zoneKey==='RACE10K');
      const hmBaselineForContext = await computeHMTrajectoryBaseline(hmGoalForAchievabilityContext, tenKGoalForAchievabilityContext);
      if(hmBaselineForContext.achievability){
        parts.push('Goal achievability for '+(hmGoalForAchievabilityContext.label||'the goal')+' ('+(hmGoalForAchievabilityContext.goalTimeLabel||'')+'), deterministic:'+formatAchievabilityNote(hmBaselineForContext.achievability));
      }
      const bestForProjection = await getBestAvailableLTPace();
      if(bestForProjection.ltPaceSec!=null){
        const projectedSec = projectedTimeFromLTPace(bestForProjection.ltPaceSec, hmGoalForAchievabilityContext.distanceKm||21.0975);
        parts.push('Current fitness projects to a realistic finish of roughly '+formatMinutesToClock(projectedSec/60)+' for this distance at today\'s best-known fitness - anchor a genuinely more achievable alternative target on this number if one is warranted, rather than inventing a figure.');
      }
    }
  }catch(e){}
  try{
    const eff = await getEfficiencyTrend();
    if(eff) parts.push('Aerobic efficiency trend: '+(eff.pctChange>=0?'+':'')+eff.pctChange.toFixed(1)+'% recent vs prior.');
  }catch(e){}
  try{
    const ttt = await getTrendSummary('timetotarget-history', undefined, {sessionTypes: REP_ONLY_TREND_SESSION_TYPES});
    if(ttt && ttt.pctChange!=null) parts.push('Time-to-target-HR trend: '+(ttt.pctChange<=0?'improving':'slower')+' by '+Math.abs(ttt.pctChange).toFixed(0)+'%.');
  }catch(e){}
  try{
    const hrr = await getTrendSummary('hrrecovery-history', undefined, {sessionTypes: REP_ONLY_TREND_SESSION_TYPES});
    if(hrr && hrr.pctChange!=null) parts.push('HR recovery trend: '+(hrr.pctChange>=0?'improving':'declining')+' by '+Math.abs(hrr.pctChange).toFixed(0)+'%.');
  }catch(e){}
  try{
    const decoup = await getTrendSummary('decoupling-history');
    if(decoup && decoup.pctChange!=null) parts.push('Long-run decoupling trend: '+(decoup.pctChange<=0?'improving':'worsening')+' by '+Math.abs(decoup.pctChange).toFixed(0)+'%.');
  }catch(e){}
  // Durability (coach/durability.js) - previously only ever reached this prompt via the
  // dedicated durability-watchdog button's own request text (proposeDurabilityFix below),
  // meaning an ordinary free-text rebuild request (e.g. "build the next phase") had no way
  // to know if durability was a real limiter unless the runner happened to mention it
  // themselves. Included here unconditionally now, same as every other fitness signal above,
  // so any plan request reasons about it, not just one specifically triggered by the watchdog.
  try{
    const durability = await getDurabilitySignal();
    if(durability.classification!=='insufficient-data') parts.push(formatDurabilityNote(durability));
  }catch(e){}
  try{
    const acwr = computeACWR(await loadTrimpHistory());
    if(acwr) parts.push('Acute:chronic training-load ratio: '+acwr.ratio.toFixed(2)+' ('+acwr.status+').');
  }catch(e){}
  // Injury/ache pattern (coach/injury-tracking.js) - a real, learned precursor read (not
  // just today's current-risk check, which is what proposeInjuryRiskFix's own request text
  // already covers) so an ordinary free-text request ("build the next phase") can factor in
  // what has actually preceded this runner's own logged aches/pains/injuries historically,
  // not just react to a current spike. Only included once enough events exist to say
  // anything real - see analyzeInjuryPatterns' own MIN_EVENTS_FOR_PATTERN bar.
  try{
    const injuryPattern = await analyzeInjuryPatterns();
    if(injuryPattern.classification==='pattern-available'){
      parts.push('Injury/ache pattern from '+injuryPattern.count+' logged event(s): '+(injuryPattern.highACWRIsCommonPrecursor
        ? (injuryPattern.highACWRCount+' of '+injuryPattern.withACWRCount+' were preceded by an elevated (High) acute:chronic training-load ratio - a real, learned risk factor for this runner specifically, worth actively avoiding when proposing near-term load.')
        : 'no single training-load factor (acute:chronic ratio) stands out as a common precursor yet across the events logged so far.'));
    }
  }catch(e){}
  try{
    const inactivity = await getDaysSinceLastActivity();
    const layoff = inactivity ? estimateLayoffImpact(inactivity.days) : null;
    if(layoff){
      parts.push('Days since last logged activity: '+inactivity.days+' (severity: '+layoff.severity+'). '+layoff.note
        +(layoff.rampWeeksRecommended>0
          ? ' Estimated (literature-based, not measured): roughly '+layoff.ltPacePenaltyPct+'% slower LT pace, '+layoff.vo2maxPenaltyPct+'% lower VO2max, until new evidence says otherwise. Recommended ramp before resuming prior intensity: roughly '+layoff.rampWeeksRecommended+' week(s) of meaningfully reduced volume/intensity - a proposal that resumes at pre-gap load immediately is not appropriate here.'
          : ''));
    }
  }catch(e){}
  try{
    const ir = await window.storage.get('runner-insights', false);
    // Same block-boundary rule as the other two readers (coach/cache-freshness.js) - patterns
    // from a previous block must not shape a rebuild of this one.
    const iobj = ir ? freshReading(JSON.parse(ir.value), 'insights') : null;
    if(iobj && iobj.text) parts.push('What\'s been learned about this runner over time ('+describeReading(iobj)+'): '+iobj.text);
  }catch(e){}
  return parts.join(' ');
}

async function buildPlanOverrideSystemPrompt(opts){
  opts = opts || {};
  const goalConfig = state.goalConfig || defaultGoalConfig();
  // A recipe-carrying day is sent to the model as its RECIPE, not as the materialized data
  // block the app computed from it. Two reasons, both load-bearing: it's what the model has
  // to write back (see the recipe paragraph in the prompt below), and sending both halves
  // would roughly double an already-large plan JSON for a year-long block while inviting the
  // model to copy the frozen numbers instead of the live recipe. plannedKm is kept so weekly
  // volume reasoning still has a number to work with.
  const dayForPrompt = d => {
    if(!d || !d.recipe) return d;
    const km = d.data && (d.data.totalKm!=null ? d.data.totalKm : d.data.km);
    const {data, alt, ...rest} = d;
    const out = Object.assign({}, rest);
    if(km!=null) out.plannedKm = Number(km);
    if(alt) out.alt = alt.recipe ? {name:alt.name, recipe:alt.recipe} : alt;
    return out;
  };
  // Two numbers per week, deliberately. `n` is the stable storage key every logged workout is
  // filed under, so it must be what a proposal writes back and can never be renumbered.
  // `displayN` is what the runner sees in the app, which restarts at 1 each block - the two
  // therefore diverge by the length of every previous block. Supplying both explicitly, rather
  // than leaving the model to infer an offset, is what stops a reply naming a week number that
  // appears nowhere on screen.
  const planJSON = JSON.stringify(state.WEEKS.map(w=>({n:w.n, displayN:blockRelativeWeekN(w.n, goalConfig), dates:w.dates, year:w.year, phase:w.phase||null, cutback:!!w.cutback, race:!!w.race, callout:w.callout||null, days:(w.days||[]).map(dayForPrompt)})));
  const methodologyRef = buildMethodologyReferenceText();
  let currentMethodology = 'norwegian-subthreshold';
  try{
    const r = await window.storage.get('plan-override', false);
    if(r){ const o = JSON.parse(r.value); if(o.activeMethodology) currentMethodology = o.activeMethodology; }
  }catch(e){}
  const personalization = await buildPersonalizationContext();
  const goalsDesc = (goalConfig.activeGoals||[]).length
    ? goalConfig.activeGoals.map(g=>(g.label||g.type)+': '+(g.raceName||'')+', '+g.raceDate+', goal '+(g.goalTimeLabel||'')).join('; ')
    : 'No active race goal right now (phase: '+(goalConfig.phase||'maintenance')+').';
  const goalConfigJSON = JSON.stringify(goalConfig);
  // Stated explicitly rather than left for the model to infer from the plan JSON's own week
  // dates - cheap, and removes a real failure mode: a "build the next phase" request with no
  // stated anchor date has no reliable way to know whether the LAST week in the plan JSON
  // below is already in the past (nothing left to continue from) or still upcoming, especially
  // across a year boundary (see the "year" field rule further down).
  const todayLabel = new Date().toLocaleDateString('en-US', {weekday:'long', year:'numeric', month:'long', day:'numeric'});

  return [{type:'text', text:
    'You are a running coach drafting a structured update to a runner\'s training plan, grounded in real, named training methodologies rather than improvising.\n'+
    'Today\'s real date is '+todayLabel+' - use this as the anchor for "where we are right now" (which weeks in the plan JSON below are already in the past vs. upcoming, how much real time is left before any goal race date) rather than inferring it from the plan JSON alone.\n'+
    'Reference methodologies (pick and commit to exactly ONE as the primary organizing method for whatever you propose - don\'t blend all four, name which one and why in methodologyRationale):\n'+methodologyRef+'\n'+
    'The plan currently follows: '+currentMethodology+'. Only propose switching methodology if the request or a genuine phase change (e.g. moving from race-build to a raceless maintenance phase) actually warrants it - stay consistent with the current one otherwise, since methodology-hopping mid-block defeats the point of any of them. Some flexibility within the chosen methodology is normal (see its "normal flexibility" note above); inventing structure outside any named methodology is not.\n'+
    'Current goal(s): '+goalsDesc+'\n'+
    'This runner\'s standing preferred training days are Monday, Wednesday, Thursday, and Saturday - every non-race day you place (quality, easy, long run) MUST land on one of those four weekdays unless the request itself explicitly asks to change the weekly pattern. A race day is the one exception, since it must land on its real calendar date regardless of weekday.\n'+
    'A day\'s type and data can be freely changed simply by resupplying that week\'s complete "days" array with a different type/data for that day - there is no separate mechanism needed to "add" or "remove" a session, converting one existing day to a different type IS how you do that. REMOVING a session means converting that day to {"type":"open","zone":"","data":{},"name":"Open day"} (optionally with a "note" explaining why, e.g. "Removed at your request - recovery focus this week") - this is a real, fully-supported day type that renders as a genuine open slot (Add workout / Perform planned workout buttons), NOT a fake tiny "easy" session with an invented small distance. Never invent a "type":"easy" day with a token distance (like 0km, or "rest") to represent removing a session - that reads as a strange, meaningless workout rather than the actual open day the runner asked for, and was a real, reported bug. A "cutback":true week does not need to be adjacent to a race - a standalone reduced-volume week in the middle of the block is valid when the situation genuinely calls for it (e.g. signs of overreaching), and it is not automatically the same thing as a pre-race taper.\n'+
    'For genuine short, fast STRUCTURED intervals - e.g. a request for "5x200m" or similar sharp reps at roughly 5K/VO2max effort - use a "vo2max" type day with METERS-based reps, a distinct shape from the TIME-based reps (e.g. "6 x 3min") on the existing vo2max days above. This is not the same thing as a few relaxed strides tacked onto an easy day\'s end (that stays exactly as it is now: a "strides" field on an "easy" day, e.g. easyS-shaped days above) - a deliberate rep set with its own explicit recovery between reps is a real quality session and deserves its own day and a proper interval card, not a sentence buried in an easy day\'s note (which is what happens if you fold it in there instead - the runner explicitly flagged this as a real gap, not a style preference). Live-computed example using this runner\'s CURRENT VO2max pace (5 x 200m, 90s jog recovery, 1.5km warm-up, 1km cool-down here - adjust reps/distance/recovery/warm-up/cool-down to whatever the actual request calls for, but reuse this exact field shape/names verbatim): '+JSON.stringify(vo2maxReps(5,200,90,'jog',1.5,1))+'.\n'+
    'The session vocabulary is NOT limited to the discrete-reps threshold/vo2max shapes above - use real variety where it is genuinely evidence-based and actually fits the request/methodology, not novelty for its own sake and not as a replacement for the core sub-threshold/threshold structure the active methodology calls for. Six more real, well-established shapes, each with a live-computed example (adjust every number to what the request/week actually calls for, but reuse the field shape/names verbatim):\n'+
    '- CONTINUOUS TEMPO (a single sustained effort at threshold pace, no reps or recovery breaks at all - the genuine Pfitzinger-style tempo run named in that methodology above, distinct from threshold()\'s broken-up reps): a "threshold" type day, reps:1. Example (20min continuous, 1.5km warm-up, 1km cool-down): '+JSON.stringify(continuousTempo(20,1.5,1))+'.\n'+
    '- HILL REPEATS (hard, controlled TIME-based efforts run uphill, jog/walk back down as recovery - a real VO2max/power/economy stimulus with no meaningful flat-pace number, since gradient varies by route; "pace"/"paceSpk" are deliberately null here and the app renders this by effort/RPE instead, not a broken card): a "vo2max" type day. Example (8 x 45s hard uphill, walk/jog back down, 1.5km warm-up, 1km cool-down): '+JSON.stringify(hillRepeats(8,45,'jog/walk down',1.5,1))+'.\n'+
    '- HILL SPRINTS (a genuinely DIFFERENT stimulus from hill repeats despite the same shape/fields, plus "sprint":true - very short, roughly 8-15s, TRUE maximal effort with FULL recovery between reps, about neuromuscular power/economy rather than cardiovascular load, so it carries very little fatigue cost even close to a taper or alongside an easy day): a "vo2max" type day. Example (8 x 10s maximal uphill, full recovery, 1.5km warm-up, 1km cool-down): '+JSON.stringify(hillSprints(8,10,1.5,1))+'.\n'+
    '- FARTLEK ("speed play" - deliberately UNSTRUCTURED alternating surge/float by feel over a total duration, no fixed rep count or pace target; genuinely fun and low-mental-load precisely because there\'s nothing exact to hit, while still a real quality stimulus - Scandinavian in origin, the same tradition the default methodology above draws on): a "vo2max" type day, reps:1, "pace"/"paceSpk" null (same reasoning as hill repeats). Example (20min): '+JSON.stringify(fartlek(20,1.5,1))+'.\n'+
    '- LADDER / PYRAMID (reps of DIFFERENT lengths within one set, e.g. 400-800-1200-800-400m - builds pace-holding under genuinely accumulating fatigue at multiple durations in one session, and reads as far less repetitive than N identical reps for the same underlying stimulus): a "threshold" (zone S4) or "vo2max" (zone S5) type day depending how sharp it should be - "main.steps" carries the real per-rung list, do NOT just average it into a single repTime the way older shapes do. Example (400-800-1200-800-400m at VO2max pace, 90s jog recovery, 1.5km warm-up, 1km cool-down): '+JSON.stringify(ladderReps([400,800,1200,800,400],90,'jog',1.5,1,'S5'))+'.\n'+
    '- ALTERNATING STRUCTURED SURGES (fixed-duration hard/easy blocks where BOTH portions carry a real pace target, not a jog/rest recovery - the float is genuinely RUN at easy pace, which is what makes this different from every uniform-rep shape above; structurally the "Yasso 800s" family - equal- or fixed-duration hard/easy - without the marathon-specific pace-matching heuristic, since that\'s tied to a marathon goal specifically): a "threshold" (workZone "S4") or "vo2max" (workZone "S5") type day - "main.steps" carries the true surge/float sequence, alternating "surge" and "float" entries. Example (6 x 3min surge @ threshold / 2min float @ easy pace, 1.5km warm-up, 1km cool-down): '+JSON.stringify(alternatingSurges(6,180,120,'S4',1.5,1))+'.\n'+
    'None of these six change what "quality day" means for adherence/taper/spacing purposes - they still count as real threshold/VO2max sessions for every rule elsewhere in this prompt (back-to-back spacing, taper timing, etc.), they just prescribe the work differently. Don\'t force one of these into a week where it doesn\'t genuinely fit the request or the runner\'s current phase/goal just to add variety - a build week close to a goal race with a specific gap to close should usually still get the most targeted session for that gap, not a fartlek for novelty\'s sake.\n'+
    'A seventh real, already-supported shape worth using more deliberately: a PROGRESSION RUN (a single continuous run that gets progressively faster in stages - e.g. Daniels-style easy-into-moderate-into-threshold) is just a "long" type day whose "segments" list moves through multiple zones in increasing-intensity order (the exact same "segments" mechanism the existing long-run days above already use for a goal-pace finish) - no new shape needed, just remember it\'s available for a request that calls for gradually building intensity within one run rather than a fixed-pace finish.\n'+
    'GENUINE VARIETY, deliberately: this runner has said the plan feels monotonous (too many near-identical sessions week to week) and asked for this to actually be addressed, not just accommodated when explicitly requested. Actively vary WHICH of the shapes above (plus the classic uniform-rep threshold()/vo2max() reps) you reach for across weeks/cycles for the SAME underlying stimulus slot - don\'t default to the same rep-count-and-distance threshold/VO2max structure every single week purely out of habit. The constraint is real: the methodology\'s underlying weekly stimulus (frequency, total sub-threshold/threshold volume, intensity distribution) must stay intact - vary the FORMAT the stimulus is delivered in, not the amount or type of stimulus itself. A genuinely well-reasoned single format repeated for a specific block-progression reason (e.g. building the same ladder longer week to week to track real progress on one benchmark) is a legitimate, deliberate choice - the failure mode this addresses is unexamined default repetition, not all repetition.\n'+
    'HILLS SPECIFICALLY (hill repeats AND hill sprints): this runner has said they are not always keen on hill work and expects to skip it "often." Whenever you prescribe either hill format, always attach a real, selectable second card via an "alt" field on that SAME day - {"name":"...", "data":{...}} - a genuine flat-pace equivalent of the SAME rep count and per-rep duration (never distance - a hill\'s stimulus is effort/duration, not ground covered), so the runner can pick whichever one they actually did as a real card, not a note they have to act on manually. Do NOT just describe a substitute in the "note" field - that was tried and explicitly flagged as not good enough; a real "alt" field is required. Live-computed example (the flat alternative to the hill-repeats example above, same 8 reps/45s/recovery, run flat at this runner\'s current VO2max pace instead): "alt":'+JSON.stringify({name:'Flat alternative - 8x45s @ VO2max pace', data:flatAlternativeToHill(hillRepeats(8,45,'jog/walk down',1.5,1),'S5')})+'. Do not stop prescribing hill work entirely just because of this preference - it is a legitimate, real stimulus and the point is a graceful opt-out on a given day via the alt card, not removing the format from the rotation.\n'+
    (opts.source==='rebalance' ? 'This specific request is an AUTOMATED REBALANCE, triggered by a detected training-adherence gap and/or readiness signal, not a free-text ask from the runner directly - you are explicitly expected to consider adjusting, adding, removing, or lightening sessions across the remaining weeks of the block to close the specific gap(s) named below, not just ease the next single occurrence of a flagged type. Stay within the existing four-day-per-week framework unless the gap genuinely cannot be closed within it - if you do add a fifth day, say explicitly why in your reply.\n' : '')+
    (opts.source==='push' ? 'This specific request is an AUTOMATED AHEAD-OF-SCHEDULE PUSH, triggered because fitness is genuinely running ahead of what the current goal target requires - real, corroborating deterministic evidence, not a single stale reading (see the request text for the specifics) - and not a free-text ask from the runner directly. You have explicit permission to genuinely INCREASE load across the remaining weeks of the block for the flagged goal(s): more reps or a longer rep block on quality sessions, more total volume, a faster prescribed pace zone, and/or a tightened (faster) goal target with the structural changes to genuinely support it - not just rearranging the same total stimulus, and not just relabeling a faster target onto the unchanged plan. See the "don\'t default to the safest-sounding option" guidance below - it explicitly covers exactly this situation (a runner already ahead of the goal-pace target). All the same physiological guardrails elsewhere in this prompt and enforced deterministically after your reply (the ~10%/week ramp cap, back-to-back quality-day spacing, long-run share/distance caps) still apply in full - pushing harder does not mean ignoring them. Stay within the existing four-day-per-week framework - the extra capacity should be absorbed there first - unless the surplus genuinely cannot be used within four days a week, in which case say explicitly why. Declining to push (concluding the current plan is genuinely still right as-is - e.g. too close to race day, or a specific personalization-context reason) is a fully legitimate response to this request; say so plainly if that\'s your read, don\'t manufacture a change just because this request exists.\n' : '')+
    'Taper (BEFORE a race) vs. recovery (AFTER a race) are two different things - don\'t use the words interchangeably, and don\'t let one quietly become the default value of the other:\n'+
    '- TAPER, as its OWN rule, independent of any layoff/illness adjustment below: for a half-marathon-or-shorter goal race, meaningfully reduced volume/intensity should span roughly the FINAL WEEK before the race only, not two weeks - the last genuine fitness-building (threshold/VO2max/long) session belongs about a week out, on whichever preferred day lands closest to that. Only stretch the taper longer than one week when a specific, currently-active reason (real illness/injury symptoms still present, an active layoff ramp - see the personalization context below) genuinely calls for it, and say so explicitly in your reply as the reason, rather than defaulting to a long taper silently.\n'+
    '- RECOVERY, after a race: roughly 1 week of easy/no-quality running after a 5K/10K, roughly 2 weeks after a half marathon, commonly 2-4+ weeks (genuinely more individual, can reasonably run longer) after a marathon - a real absence of threshold/VO2max work for that long, not just "somewhat lighter" for a few days. This is about getting the runner back and ready for the next real training block, not a second taper.\n'+
    'What\'s known about this runner specifically right now: '+(personalization||'no additional fitness/trend data available yet.')+'\n'+
    'Current goal-config, verbatim - if you set "goalConfigPatch", it MUST use this exact shape/field names ({"phase":"...", "activeGoals":[{"goalId":"...","type":"...","zoneKey":"GOAL"|"RACE10K","label":"...","raceName":"...","distanceKm":0,"raceDate":"YYYY-MM-DD","goalTimeSec":0,"goalTimeLabel":"...","goalPaceSec":0,"goalPaceLabel":"...","goalHR":"..."}]}) - do NOT invent different field names (e.g. "goals"/"id"/"targetTime" are wrong and will silently fail to apply). A patch is shallow-merged onto this object, so include the FULL "activeGoals" array (not just the entries changing) whenever you touch it, or an untouched goal will vanish. CRITICAL: "goalId" is a STABLE identifier for the goal/race itself (also referenced by that race\'s day in the plan JSON below, via its own "goalId" field) - it does NOT encode the current target time, so it must NEVER change when you update an existing goal\'s target, even if the target time changes completely (e.g. updating the "hm-sub135" goal to a sub-1:32:00 target still uses goalId "hm-sub135" - do not rename it to something like "hm-sub132"). Only invent a new goalId when adding a genuinely new goal that has no existing entry above. Verbatim current goal-config: '+goalConfigJSON+'\n'+
    'Current full plan as a JSON array of week objects (reuse this exact shape for any day/field you don\'t intend to change): '+planJSON+'\n'+
    'WEEK NUMBERS - each week carries two. "n" is the internal storage key: use it, and only it, as the "n" field of any week you emit in the PLAN OVERRIDE JSON. "displayN" is the number the runner actually sees in the app. When you write PROSE to the runner, refer to a week by its displayN or by its date range, and never mention "n" - display numbering restarts at 1 for each new training block, so the two diverge by the length of every previous block, and quoting the internal one names a week that appears nowhere on their screen.\n'+
    'CRITICAL - HOW TO SPECIFY A SESSION ("recipe", not numbers). Every training day you propose MUST describe the session as a RECIPE - what the session IS - and must NOT contain a "data" object with computed paces, times or totals. The app builds "data" itself from the recipe, against the runner\'s CURRENT fitness, every single time the plan loads. This is not a stylistic preference: a hand-written "data" block freezes that session\'s prescribed pace at whatever fitness was current the day you wrote it, permanently, and a long block written that way will still be prescribing today\'s paces a year from now while the runner\'s actual threshold has moved on. Weekly km ("plannedKm" above) is likewise computed, not authored - treat the figures above as the current sizing, and reason about volume in those terms, but never write them back.\n'+
    'A day object is: {"tag":"Wed - Sep 16","name":"Threshold","zone":"S4","type":"threshold","recipe":{"fn":"...","args":{...}}} plus optional "note"/"changeNote"/"changeDate"/"goalId". The available recipe functions and their exact args:\n'+
    '  easyS {km, strides?} - an easy or medium-long run (type "easy"; strides optional). Also used for a shakeout.\n'+
    '  longRun {segments:[{km, zone}]} - type "long"; zone is "S2", "S3" or "GOAL" per segment. A progressive long run is just several segments; a goal-pace finish is a trailing {"zone":"GOAL"} segment.\n'+
    '  threshold {reps, repM, recoverySec, recoveryLabel?, wuKm, cdKm} - N identical distance-based reps at LT pace. reps:1 with a large repM is how a time trial or a single sustained distance effort is written.\n'+
    '  continuousTempo {totalMin, wuKm, cdKm} - one sustained tempo effort, no reps.\n'+
    '  ladderReps {distancesM:[...], recoverySec, recoveryLabel?, wuKm, cdKm, zone} - reps of DIFFERENT lengths; zone "S4" or "S5".\n'+
    '  alternatingSurges {reps, workSec, floatSec, workZone, wuKm, cdKm} - hard/float blocks where the float is run, not rested.\n'+
    '  vo2max {reps, repMin, recoveryMin, wuKm, cdKm} - time-based VO2max reps. vo2maxReps {reps, repM, recoverySec, recoveryLabel?, wuKm, cdKm} - distance-based ones.\n'+
    '  hillRepeats {reps, repSec, recoveryLabel?, wuKm, cdKm} / hillSprints {reps, repSec, wuKm, cdKm} - effort-based, no pace target by design.\n'+
    '  fartlek {totalMin, wuKm, cdKm} - deliberately unstructured.\n'+
    '  raceOpener {reps, repMin, recoveryMin, wuKm, cdKm} - short race-pace openers in a race week.\n'+
    '  raceEv {km, goalTime, goalPaceLabel, goalId} - type "race", for the goal race day itself.\n'+
    'A session named with "Time Trial" (e.g. "5K Time Trial", "10K Time Trial") automatically renders as an all-out effort test rather than a paced session - use that naming for a fitness checkpoint.\n'+
    'A week object may also carry "phase" ("base" | "strength" | "threshold" | "specific" | "taper"), which is shown in the week header. Set it on any week you propose as part of a multi-week block so the runner can see where in the plan that week sits.\n'+
    'CRITICAL - read before deciding what to include in "weeks": every session\'s actual pace (threshold/VO2max/long-run zone paces, GOAL/RACE10K pace) is computed LIVE from the runner\'s current profile and goal-config every time the plan renders - it is NOT hardcoded into the week/day JSON above. This means a request that\'s really about updating LT pace or the goal race-pace targets themselves (not the session STRUCTURE - rep counts, session types, which days, distances) needs ONLY a "goalConfigPatch" (or, if it\'s really a Garmin/Tier-1 LT pace update rather than a goal target, say so in your reply text and note that\'s a separate "Update Garmin numbers" action, not something this block can do) - leave "weeks" EMPTY in that case, BUT ONLY when the new target is realistically within reach of the plan\'s current training load (see the very next paragraph for when it is not). Do not re-emit unchanged weeks just to reflect a pace number; that produces a huge, mostly-redundant response and risks getting cut off. Only include a week in "weeks" when its actual structure is changing.\n'+
    'CRITICAL: if a goalConfigPatch you\'re proposing makes an existing goal meaningfully FASTER/harder - not a small few-second/km nudge that reflects fitness already gained, but a genuinely bigger ask (roughly 3%+ faster goal time, e.g. several minutes off a half marathon) - you MUST also propose real structural changes to the plan (more threshold/quality frequency or volume, longer or more specific sessions, an extended build, etc.) that would actually be needed to close that gap. NEVER emit a goalConfigPatch alone that just relabels the target time on the exact same training - a goal isn\'t achieved by renaming it, and doing this reads as a lazy, non-responsive coach, not a real plan for closing the gap. If you genuinely believe the current structure is already sufficient to reach the new target (e.g. the runner is already ahead of schedule and this is just formalizing where their fitness already has them), say so explicitly and specifically in your plain-language reply, with the reasoning - don\'t leave it unaddressed.\n'+
    'CRITICAL - the mirror-image case, when the goal is NOT reachable: the personalization context above states a deterministic "Goal achievability" read and, when available, the realistic finish time current fitness actually projects to. If that achievability classification is "not-enough-time" (no real build time left to close the gap) or "not-closing" (the trend is flat or moving the wrong way despite real time left), or "needs-to-accelerate" with a large required multiplier, and NOTHING in your response - neither a structural change nor already-in-flight momentum - would realistically close that gap by race day, do NOT leave it unaddressed and do NOT soften it with vague hedging ("it will be tight," "push hard and see"). Say so PLAINLY and DIRECTLY in your plain-language reply, citing the real numbers (the gap, the required vs. observed rate, real build days remaining), and set "goalConfigPatch" to a SPECIFIC, concrete, more realistically achievable target time - anchored on the projected-finish number given in the personalization context, not invented - for the runner to review and explicitly accept or reject (this app always requires a second explicit confirmation before any goal-config change actually applies, so proposing this is safe and expected, never presumptuous). This is the exact opposite failure mode from relabeling a goal FASTER above: here, the failure is staying silent or vague about a goal that plainly will not be hit rather than giving the runner a real, specific number to decide on.\n'+
    'Self-check before answering (the app also verifies these deterministically, but get them right the first time): every non-race day lands on Monday, Wednesday, Thursday, or Saturday; a "cutback" week starts no more than ~1 week before the race unless a currently-active layoff/illness reason justifies more; don\'t increase a week\'s total km by more than ~10% over the prior week outside a deliberate cutback/taper; a long run should generally stay under ~25-30% of that week\'s own total and never exceed the runner\'s active race distance; don\'t schedule two threshold/VO2max days back-to-back with no easy/rest day between them; keep your JSON as compact as possible - never include a week unless something about its actual structure is changing. If the personalization context above reports a real layoff (a "Recommended ramp" figure), the plan you propose must show meaningfully reduced volume/intensity for roughly that many weeks before resuming prior load - never resume at pre-gap intensity immediately just because that\'s what the existing plan JSON shows for that week. Any week(s) immediately following a race day (in the plan JSON above, or a new week you\'re adding after one) must be genuine recovery weeks - significantly reduced volume, no threshold/VO2max sessions - before resuming normal build/peak structure: roughly 1 week of easy running after a 5K/10K, roughly 2 weeks after a half marathon, commonly 2-4+ weeks after a marathon (see the taper-vs-recovery paragraph above), whether that race is mid-block (like the current 10K) or the block\'s final race followed by a new phase.\n'+
    'CRITICAL - don\'t default to the safest-SOUNDING option without weighing whether it\'s actually the best plan for the real situation: caught live, a runner-reported real gap (a cold causing missed long runs, with the goal race still 13 days out and fitness already ahead of the goal-pace target) got an initial rebuild that defaulted to a generic conservative taper template - the runner had to push back and ask why that wasn\'t proposed better the first time. A cautious-sounding response (just adding rest days, tapering early, doing nothing) is NOT automatically the right answer just because it sounds safe - it can just be the least effort one. Read the actual situation: how many genuinely useful training days are actually left before the race, whether current fitness is ahead of or behind the goal-pace target, and what SPECIFIC gap (missed long runs, missed quality work, an unresolved durability question) the remaining time would be best spent closing. Propose the plan that makes the best real use of the time actually available to address that specific gap - only default to a purely conservative/rest-heavy plan when the specific evidence (active illness/injury symptoms still present, genuinely little time left, a real overreaching signal) actually supports it, not as a reflexive default.\n'+
    'Start your reply with 1-3 short sentences in plain language explaining what you\'re proposing and why (which methodology, what\'s actually changing) - the runner sees this text directly, it\'s not hidden. If part or all of the request genuinely can\'t be done through this mechanism (most commonly: it\'s actually about the runner\'s OWN current LT pace / Tier-1 Garmin numbers, not a goal-race target or the plan\'s session structure - this block can update goal-config and session structure, but NOT the runner\'s own profile numbers), say that plainly here too, and name the separate action needed ("update your Garmin numbers" / "Update Garmin numbers" button) - don\'t silently ignore that part of the request.\n'+
    'Then, ONLY if there is an actual plan/goal-config change to propose, follow with a block starting on its own line with exactly "PLAN OVERRIDE:" followed by one valid JSON object: {"weeks":[<complete week object(s) that are changing, in the exact shape shown above>],"methodology":"<one of the reference methodology ids>","methodologyRationale":"one or two sentences citing the chosen methodology and why it fits this request and situation","truncateAfter":null,"goalConfigPatch":null}. Nothing after this JSON object - it\'s the last thing in your reply. If NOTHING about the plan or goal-config actually needs to change (e.g. the request is entirely a Tier-1 LT pace matter), omit the PLAN OVERRIDE block entirely and end your reply after the explanation above.\n'+
    '"weeks" may be an EMPTY array when the change is entirely a goalConfigPatch (see above) - don\'t force a week into it just to have something there. When weeks are included, only the ones actually changing, each supplied as a COMPLETE week object - copy every unchanged field/day through verbatim from what was given above, don\'t invent new structure or silently drop existing notes/callouts you weren\'t asked to change. Only set "truncateAfter" (a week number) for a genuine full phase transition that should end the current block after that week and not carry forward any of its later untouched weeks - omit/null it otherwise. Only set "goalConfigPatch" (a partial goal-config object) when the request genuinely changes an active goal\'s target pace/time, the active goal(s) themselves, or the phase (e.g. a race is done and the next phase has no race goal - phase becomes "maintenance", activeGoals becomes []) - omit/null it for ordinary in-block tweaks.\n'+
    'CRITICAL - "year" field: a day tag ("Wed - Aug 5") and a week\'s "dates" range never encode which calendar year they belong to on their own - that comes from the week object\'s own optional "year" field, which defaults to 2026 when omitted (this training block\'s original year). Any week you propose whose real calendar dates fall in a year OTHER than 2026 (e.g. a multi-month/multi-phase plan reaching into next year) MUST set "year" explicitly on that week object (e.g. "year":2027 for a week dated "Jan 4-10" that\'s actually January 2027, not 2026) - every week you copy through unchanged from the current plan above should keep whatever "year" it already has (including none, meaning 2026). Getting this wrong silently mis-sorts weeks, breaks taper/race-countdown math, and corrupts week-passed detection for anything in the wrong year.'
  }];
}

// ---------------------------------------------------------------------------
// Building a plan too large for one reply
// ---------------------------------------------------------------------------
//
// A rebuild is one model reply containing one JSON object, and a reply has a token ceiling
// (8000, see worker/src/anthropic.js). That was raised once already, then given up to two
// "continue where you were cut off" passes, and a year-long block still doesn't fit: ~50
// weeks of four recipe-days each is well past what three concatenated replies can hold. The
// failure isn't graceful either - a rebuild that runs out of room mid-JSON produces nothing
// at all, which is exactly what happened when a full-year block was asked for.
//
// Continuing further is the wrong lever. Each continuation is a blind resume with no view of
// the whole, so coherence across a long block (volume progression, where the cutbacks fall,
// when phases turn over) degrades precisely where it matters most - and the ceiling comes
// back at whatever length the next request happens to be.
//
// So a long block is built in two phases instead. First an OUTLINE: one compact line per
// week - phase, target volume, which session types, whether it's a cutback - for the entire
// span, small enough to fit in one reply with room to spare. The outline is where the real
// planning decisions get made, and being able to see the whole block at once is what makes
// them coherent. Then each batch of weeks is EXPANDED into full week objects against that
// agreed outline, a handful at a time, each call far inside the ceiling. The model's own
// prior batches stay in chat history (see fetchCoachReply), so it writes each batch knowing
// exactly what it just wrote.
//
// The outline is not shown to the runner and is not stored - it exists only to make the
// expansion coherent. What gets validated and applied is the merged result, as one proposal,
// through exactly the same validator and confirm-gated apply as any other rebuild.

// Above this many weeks, a rebuild goes straight to the two-phase path rather than trying a
// single reply first. Sized from the real ceiling: roughly 250-350 output tokens per fully
// expanded week means a single 8000-token reply comfortably holds well over 14 weeks plus
// prose, so anything at or under this genuinely does fit in one call and shouldn't pay for
// an extra round trip. Anything larger gets the outline.
export const PLAN_BATCH_TRIGGER_WEEKS = 14;
// Weeks per expansion call. Deliberately well under what would fit (8 weeks is ~2,800
// tokens against an 8000 ceiling) - the headroom is what stops a week with an unusually
// wordy note or an extra session from truncating a batch and losing the whole run.
export const PLAN_BATCH_SIZE = 8;

// Every auto-generated rebuild request has to say which weeks are in scope, and the obvious
// way to write that sentence - "rebuild week 7 through week 57" - quietly undid the system
// prompt's own week-numbering rule. `n` is a storage key that keeps counting across training
// blocks; the runner's screen restarts at 1 for each new block, so this block's week 7 is
// their Week 1. Naming the internal number in a user-role message, in prose, right next to an
// instruction telling the model not to do exactly that, is a contradiction the model resolves
// the wrong way: it was caught echoing "weeks 7-8" back to a runner whose app says weeks 1-2.
//
// So the scope is stated in both numberings at once, with each one's job spelled out: the
// internal n because the JSON genuinely needs it, the display number because that is the only
// one the runner can act on.
// These strings are read by the runner, not only by the model - the proposal card shows the
// coach's own words back. "1 week(s)" is the kind of detail that makes a careful plan look
// machine-generated, so counts are written out properly.
function plural(n, word){ return n + ' ' + word + (n === 1 ? '' : 's'); }
// A rebuild is several sequential model calls, and it can run well past a minute. Setting one
// line of innerText and leaving it there for the duration reads as a button that did nothing -
// which is exactly how it was reported. This shows what step is actually running, how long it
// has been going, and an honest indeterminate bar (the number of repair rounds is genuinely
// not knowable in advance, and a fake percentage stalling at 80% is worse than not claiming).
function rebuildProgress(loadingId){
  const startedAt = Date.now();
  let timer = null, current = '';
  const paint = () => {
    const el = document.getElementById(loadingId);
    if(!el) return;
    const secs = Math.round((Date.now()-startedAt)/1000);
    const elapsed = secs < 60 ? (secs+'s') : (Math.floor(secs/60)+'m '+(secs%60)+'s');
    el.innerHTML = '<div>'+escapeHTML(current)+'</div>'+
      '<div class="rebuild-progress">'+
        '<div class="rebuild-progress-step"><span>Working</span><span>'+elapsed+'</span></div>'+
        '<div class="rebuild-progress-bar"><div class="rebuild-progress-fill"></div></div>'+
      '</div>';
  };
  return {
    set(label){
      current = label;
      paint();
      if(!timer) timer = setInterval(paint, 1000);
    },
    // Hands the element back as plain text - every finishing path writes real content into it.
    done(){ if(timer){ clearInterval(timer); timer = null; } },
  };
}

function escapeHTML(s2){ return String(s2==null?'':s2).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// How many weeks a rebuild genuinely needs is not a constant, and it is not the rest of the
// block either. The honest answer is the horizon the problem was MEASURED over: a deficit
// counted across six weeks of adherence is answered across six weeks of training, a fitness
// trend read over five weeks of evidence is acted on over five weeks of plan. Responding over
// a longer horizon than the evidence covers is not thoroughness, it is overreach.
//
// This sets the MINIMUM span; how many weeks the change then needs in order to hand back to
// untouched training without a spike is arithmetic, and lives with the curve that has to do it
// (scopeToJoin in plan-generator.js). The prose-based scoping helpers that used to describe all
// of this to a model - weekScopeSentence, joinRequirementSentence, bridgeWeeksNeeded,
// rebuildScope, returnToRunRebuildScope - are gone: the generator no longer has to be told
// where the join is, because it is the thing building it.
export const MIN_CORE_REBUILD_WEEKS = 4;
export const MAX_CORE_REBUILD_WEEKS = 12;

export function coreWeeksForSignal(measuredWeeks){
  const w = Math.round(measuredWeeks||0);
  if(!isFinite(w) || w<=0) return MIN_CORE_REBUILD_WEEKS;
  return Math.min(MAX_CORE_REBUILD_WEEKS, Math.max(MIN_CORE_REBUILD_WEEKS, w));
}

// Where the rebuilt stretch is expected to leave the runner, in km - what the join climbs from.
// Read off the plan's own last in-scope week, since a rebalance or a push reshapes the existing
// weeks rather than replacing them with a known ramp figure.
function plannedKmAt(weeks, n){
  const w = (weeks||[]).find(x=>x.n===n);
  if(!w) return null;
  try{ return computeWeekPlannedKm(materializeWeek(w)); }catch(e){ return null; }
}

// One shared way to say "rebuild this much, then join cleanly onto the rest" - used by every
// rebuild type, because the principle is not specific to injuries: change what genuinely needs
// changing and hand it back to untouched training perfectly. `coreWeeks` is however long the
// actual problem takes to address; the join is computed from the volume gap at the seam.

export function planBatches(weekNumbers, size){
  const ns = (weekNumbers||[]).slice().sort((a,b)=>a-b);
  const batchSize = size || PLAN_BATCH_SIZE;
  const out = [];
  for(let i=0; i<ns.length; i+=batchSize) out.push(ns.slice(i, i+batchSize));
  return out;
}

// Pulls the JSON object or array that follows a marker. Shared by both phases and by the
// single-call path, which each previously re-implemented the same indexOf/slice/parse dance.
export function extractJsonBlock(text, marker, openChar){
  if(!text) return {ok:false, reason:'no-text'};
  const idx = text.indexOf(marker);
  if(idx===-1) return {ok:false, reason:'no-marker'};
  const raw = text.slice(idx+marker.length);
  const open = openChar || '{';
  const close = open==='[' ? ']' : '}';
  const fb = raw.indexOf(open), lb = raw.lastIndexOf(close);
  if(fb===-1 || lb<=fb) return {ok:false, reason:'no-json', prose: text.slice(0, idx).trim()};
  try{
    return {ok:true, value: JSON.parse(raw.slice(fb, lb+1)), prose: text.slice(0, idx).trim()};
  }catch(e){
    return {ok:false, reason:'bad-json', prose: text.slice(0, idx).trim()};
  }
}

export function buildOutlineRequestText(userRequest){
  return userRequest+
    '\n\n---\nIMPORTANT - this request covers too many weeks to write out in one reply, so it is being built in two phases and THIS IS PHASE 1 OF 2: the OUTLINE only. Do NOT emit a "PLAN OVERRIDE:" block in this reply, and do NOT write out any full week objects, recipes or day objects - phase 2 will ask you for those, a few weeks at a time, and will hold you to what you decide here.\n'+
    'Plan the WHOLE span now, as one coherent block. This is the one moment you can see all of it at once, so this is where the real decisions belong: where each phase starts and ends, how weekly volume actually progresses, where the cutback weeks fall, where quality work steps up, where any race or checkpoint sits, and how the block finishes. Every self-check in your instructions above still applies here (the ~10%/week ramp ceiling, long run as a share of the week, no back-to-back quality days, recovery after a race, Monday/Wednesday/Thursday/Saturday) - an outline that breaks them just produces weeks that get rejected in phase 2.\n'+
    'Start with 1-3 short sentences in plain language explaining the shape of the block and why - the runner reads this. Then a block on its own line starting with exactly "PLAN OUTLINE:" followed by one valid JSON object:\n'+
    '{"weeks":[{"n":9,"dates":"Sep 28 - Oct 4","year":2027,"phase":"base","cutback":false,"race":false,"targetKm":46,"days":[{"tag":"Mon - Sep 28","type":"easy"},{"tag":"Wed - Sep 30","type":"threshold"},{"tag":"Thu - Oct 1","type":"easy"},{"tag":"Sat - Oct 3","type":"long"}],"focus":"threshold reps return; long run to 17km"}],"methodology":"<one of the reference methodology ids>","methodologyRationale":"one or two sentences","truncateAfter":null,"goalConfigPatch":null}\n'+
    'One entry per week you intend to change or add, in ascending week order, covering the full span - do not stop early and do not summarize a stretch of weeks as one entry. "year" follows the same rule as always (omit for 2026, set it explicitly for any week whose real calendar dates fall in another year). "targetKm" is the weekly total you intend that week to land near, and "focus" is a short phrase, not a paragraph. Keep it compact: this whole object has to fit in one reply.';
}

// The outline entries for this batch are restated in the request itself rather than left to
// chat history. fetchCoachReply keeps only the last 24 messages, and a year-long block runs
// to seven expansion calls plus the outline - so on exactly the longest blocks, the ones this
// path exists for, the outline would scroll out of context partway through and the later
// batches would be written against nothing. Restating costs a few hundred tokens and makes
// each batch self-contained.
export function buildExpansionRequestText(batchNs, batchIndex, batchCount, outlineEntries){
  const range = batchNs.length===1 ? ('week '+batchNs[0]) : ('weeks '+batchNs[0]+'-'+batchNs[batchNs.length-1]);
  const entries = (outlineEntries||[]).filter(e=>e && batchNs.indexOf(e.n)!==-1);
  const restated = entries.length
    ? ('\nThese are the outline entries you committed to for exactly these weeks - match them:\n'+JSON.stringify(entries)+'\n')
    : '';
  return 'PHASE 2 OF 2, part '+(batchIndex+1)+' of '+batchCount+'. Now write out the FULL week objects for exactly '+range+' from the outline you produced - these week numbers and no others: ['+batchNs.join(', ')+'].\n'+
    restated+
    'Each week must match its outline entry: the same dates, year, phase, cutback/race flags, the same day tags and session types, and a weekly total that actually lands near the "targetKm" committed to there. Expand each day into a real session using the recipe functions and the exact day-object shape given in your instructions - every training day as {"recipe":{"fn":...,"args":{...}}}, never a hand-written "data" block.\n'+
    'Reply with NOTHING except a block starting on its own line with exactly "PLAN OVERRIDE:" followed by one valid JSON object {"weeks":[...]} containing only those weeks. No explanation, no preamble, no methodology or goalConfigPatch fields - those were settled in the outline. Nothing after the JSON object.';
}

// Stitches the outline's decisions together with the expanded batches. The outline owns
// everything block-wide (methodology, truncateAfter, goalConfigPatch); the batches own the
// week objects. A week the outline promised but no batch delivered is reported rather than
// quietly dropped - silently applying a plan with a hole in it is far worse than failing.
export function mergeBatchedProposal(outline, batchWeekArrays){
  const byN = new Map();
  (batchWeekArrays||[]).forEach(arr=>{
    (arr||[]).forEach(w=>{ if(w && w.n!=null) byN.set(w.n, w); });
  });
  const outlinedNs = ((outline && outline.weeks) || []).map(w=>w.n).filter(n=>n!=null);
  const missing = outlinedNs.filter(n=>!byN.has(n));
  const weeks = Array.from(byN.values()).sort((a,b)=>a.n-b.n);
  return {
    proposal: {
      weeks,
      methodology: outline && outline.methodology,
      methodologyRationale: outline && outline.methodologyRationale,
      truncateAfter: outline && outline.truncateAfter!=null ? outline.truncateAfter : null,
      goalConfigPatch: (outline && outline.goalConfigPatch) || null,
    },
    missing,
  };
}

// A free-text plan request, answered through the spec path first.
//
// The model is asked one small question - what should change, how much, over how many weeks -
// and the app builds the weeks. That is one call with a compact prompt instead of an outline
// plus seven expansions plus repair rounds, each carrying the whole plan as JSON.
//
// It falls back to the original week-writing path in exactly two cases, and no others: the
// model itself says the request is about specific named days ("custom"), or the spec call did
// not come back usable at all. Nothing the old path could do has been removed - it has stopped
// being the FIRST thing tried for requests that never needed it.
export async function requestPlanOverride(userRequest, opts){
  opts = opts || {};
  if(!opts.forceLegacy){
    const handled = await tryGeneratedPlanRequest(userRequest, opts);
    if(handled) return;
  }
  return requestPlanOverrideViaModelWrittenWeeks(userRequest, opts);
}

// Returns true when the request was answered here; false to fall through to the old path.
async function tryGeneratedPlanRequest(userRequest, opts){
  let intent = null, prose = '';
  toggleChat(true);
  const box = document.getElementById('chatMessages');
  box.insertAdjacentHTML('beforeend', '<div class="msg user">'+escapeHTML(opts.displayText||userRequest)+'</div>');
  const thinkingId = 'plan-intent-'+Date.now();
  box.insertAdjacentHTML('beforeend', '<div class="msg assistant" id="'+thinkingId+'">Working out what should change...</div>');
  box.scrollTop = box.scrollHeight;
  const removeThinking = () => { const el = document.getElementById(thinkingId); if(el) el.remove(); };
  try{
    state.goalConfig = await loadGoalConfig();
    // A revision of a proposal the runner just looked at carries that proposal forward, so a
    // follow-up ("same thing but start a week later") is answered on the same cheap path
    // rather than falling back to writing every week out again.
    const priorContext = opts.priorProposal
      ? ('THE CHANGE YOU JUST PROPOSED, which this request is a revision of: weeks n' +
         (opts.priorProposal.weeks||[]).map(w=>w.n).join(', n') + '.')
      : null;
    const parsed = await requestPlanIntent(userRequest, state.WEEKS, state.goalConfig, priorContext);
    intent = parsed.ok ? parsed.intent : null;
    prose = parsed.prose || '';
    if(!intent){ removeThinking(); return false; }
  }catch(e){
    console.error('plan intent call failed', e);
    removeThinking();
    return false;
  }

  const cfg = state.goalConfig || defaultGoalConfig();
  const disp = dispFor();
  // The model answers in DISPLAY week numbers, which is the only numbering it is ever shown -
  // mapped back to storage keys here, in code, rather than asking it to do the offset.
  const toStorageN = displayN => {
    const match = state.WEEKS.find(w => blockRelativeWeekN(w.n, cfg) === Math.round(displayN));
    return match ? match.n : null;
  };

  if(intent.action === 'none'){
    const el = document.getElementById(thinkingId);
    if(el) el.innerText = prose || 'Nothing in the plan needs to change for that.';
    return true;
  }
  if(intent.action === 'custom'){ removeThinking(); return false; }
  if(intent.action === 'goal'){
    removeThinking();
    await deliverGeneratedPlan({
      displayText: opts.displayText || userRequest,
      spec: {weeksOnlyGoalChange: true, goalConfigPatch: intent.goalConfigPatch},
      prose, opts,
    });
    return true;
  }

  const currentWeekN = await findNextUpcomingWeek();
  const blockEndN = Math.max(...state.WEEKS.map(w => w.n));
  const fromN = toStorageN(intent.fromWeek) || currentWeekN;
  const fallbackOpeningKm = currentKmAt(fromN) || 40;
  const openingKm = (parseFloat(intent.openingKm) > 0) ? parseFloat(intent.openingKm) : fallbackOpeningKm;
  const restWeeks = Math.round(Math.max(0, Math.min(6, parseFloat(intent.restWeeks) || 0)));
  const peakKm = parseFloat(intent.peakKm) > 0 ? parseFloat(intent.peakKm) : null;
  // How long the change runs is the model's call where it made one, and otherwise the same
  // arithmetic every other rebuild uses: long enough to climb back to untouched training
  // legally, never longer.
  const askedWeeks = parseFloat(intent.weeks);
  const scope = scopeToJoin({
    weeks: state.WEEKS, fromN, openingKm, restWeeks, blockEndN,
    minWeeks: isFinite(askedWeeks) && askedWeeks > 0 ? Math.round(askedWeeks) : 1,
    ceilingFor: peakKm ? (() => peakKm) : null,
  });
  const spec = intentToSpec(intent, {
    weeks: state.WEEKS, fromN, toN: scope.toN, joinKm: scope.joinKm,
    currentWeekN, blockEndN, fallbackOpeningKm,
    goalActive: (cfg.activeGoals||[]).some(g => g.zoneKey === 'GOAL'),
  });

  removeThinking();
  await deliverGeneratedPlan({
    displayText: opts.displayText || userRequest,
    spec,
    prose: built => (prose ? (prose + '\n\n') : '') +
      describeGeneratedPlan(built.rows, {displayN: disp, holdWeeks: spec.qualityHoldWeeks, joinN: scope.joinN}),
    opts,
  });
  return true;
}

async function requestPlanOverrideViaModelWrittenWeeks(userRequest, opts){
  opts = opts || {};
  toggleChat(true);
  const box = document.getElementById('chatMessages');
  // opts.displayText lets a caller that auto-generates a long, technical request (see
  // proposeReRampFromAdjustments below) show something short and readable in the visible
  // chat log instead of dumping the full generated paragraph into it - the actual full
  // userRequest text is still exactly what's sent to the model below, unaffected.
  box.insertAdjacentHTML('beforeend', '<div class="msg user">'+(opts.displayText||userRequest)+'</div>');
  const loadingId = 'plan-override-'+Date.now();
  box.insertAdjacentHTML('beforeend', '<div class="msg assistant" id="'+loadingId+'"></div>');
  box.scrollTop = box.scrollHeight;
  const progress = rebuildProgress(loadingId);
  progress.set('Drafting a plan update...');

  try{
    // Refresh from storage rather than trusting whatever state.goalConfig already holds
    // in memory - it's only ever set once at page load (main.js) or by a prior apply in
    // this same tab, so if the goal-config changed by any other path since this page was
    // opened, an in-memory read here would silently diff/prompt against a stale "current"
    // value. Same class of staleness already found and fixed for storage.js elsewhere.
    state.goalConfig = await loadGoalConfig();
    const system = await buildPlanOverrideSystemPrompt(opts);
    const userText = opts.priorProposal
      ? ('About the plan change you just proposed (weeks '+(opts.priorProposal.weeks||[]).map(w=>w.n).join(', ')+', methodology '+(opts.priorProposal.methodology||'unspecified')+'): '+userRequest)
      : userRequest;
    // A caller that already knows it is asking for a whole remaining block (see
    // proposeReturnToRunPlan / proposeReRampFromAdjustments / proposePushFromAheadSignal)
    // passes its size, so a year-long rebuild goes straight to the two-phase path instead of
    // burning three full-ceiling replies discovering it doesn't fit. A free-text request has
    // no declared size and still discovers it by truncating - which now recovers instead of
    // giving up.
    if(opts.spanWeeks && opts.spanWeeks > PLAN_BATCH_TRIGGER_WEEKS){
      const built = await buildProposalInBatches(system, userText, loadingId, opts, progress);
      progress.done();
      if(built) await finishPlanOverride(built.proposal, built.prose, loadingId, opts);
      return;
    }
    // Everything the single-call attempt appends to chat history has to come back off it if
    // that attempt is abandoned - otherwise phase 1 opens with a truncated half-JSON in its
    // own context and tries to continue it instead of writing an outline.
    const historyMark = state.chatHistory.length;
    // A response cut off by the token ceiling gets a couple of "continue where you left off"
    // passes first (see fetchWithContinuations) - that's enough for an ordinary rebuild that
    // simply ran a bit long, and avoids paying for an outline round trip to solve a problem
    // one more pass already solves.
    const first = await fetchWithContinuations(system, userText, loadingId, 'Drafting a plan update...', progress);
    const textResp = first.text;
    const truncated = first.truncated;
    // Running out of room is no longer a dead end. The request was simply bigger than one
    // reply, which is a fact about its size, not about whether it can be done - so it gets
    // rebuilt through the outline-then-expand path instead of handing the runner a "try
    // asking for fewer weeks" instruction they have no way to act on sensibly.
    if(truncated){
      state.chatHistory = state.chatHistory.slice(0, historyMark);
      const built = await buildProposalInBatches(system, userText, loadingId, opts, progress);
      progress.done();
      if(built) await finishPlanOverride(built.proposal, built.prose, loadingId, opts);
      return;
    }
    const truncatedHint = '';
    const marker = 'PLAN OVERRIDE:';
    const idx = textResp.indexOf(marker);
    // The coach's own explanation (which methodology, what's changing, and critically -
    // when part of the request can't be done through this mechanism at all, e.g. it's
    // really the runner's own Tier-1 LT pace, not a goal target - that gets said here)
    // always gets shown, whether or not an actual PLAN OVERRIDE block follows it. This
    // used to be silently discarded in favor of a generic "Here's the proposed change"
    // label, which is exactly what made a Tier-1-only reply look like nothing happened.
    const prose = (idx===-1 ? textResp : textResp.slice(0, idx)).trim();
    const loadingEl = document.getElementById(loadingId);
    if(idx===-1){
      loadingEl.innerText = prose || ('The coach didn\'t return a usable reply - try rephrasing the request.'+truncatedHint);
      return;
    }
    progress.done();
    loadingEl.innerText = prose;
    const raw = textResp.slice(idx+marker.length).trim();
    const fb = raw.indexOf('{'), lb = raw.lastIndexOf('}');
    if(fb===-1 || lb<=fb){
      loadingEl.innerText = (prose ? prose+'\n\n' : '')+'The coach\'s proposed-change block wasn\'t valid JSON - try again.'+truncatedHint;
      return;
    }
    let proposal;
    try{ proposal = JSON.parse(raw.slice(fb, lb+1)); }
    catch(e){
      loadingEl.innerText = (prose ? prose+'\n\n' : '')+'Could not parse the coach\'s proposed change - try again.'+truncatedHint;
      return;
    }
    // The same gate the long path uses. A short rebuild is not exempt from the block's rules -
    // four weeks can break its shape as effectively as fifty, and the injury return is now
    // deliberately short (see returnToRunRebuildScope), so without this the case that prompted
    // all of it would be the one case that skipped the check. A proposal that only changes the
    // goal config has no weeks to audit and goes straight through.
    if(Array.isArray(proposal.weeks) && proposal.weeks.length){
      const failHere = msg => { progress.done(); const el = document.getElementById(loadingId); if(el) el.innerText = (prose ? prose+'\n\n' : '')+msg; return null; };
      const setLabelHere = txt => progress.set(txt);
      const gated = await repairUntilClean(system, proposal, loadingId, opts, failHere, setLabelHere, progress);
      progress.done();
      if(!gated) return;
      proposal = gated.proposal;
    }
    progress.done();
    await finishPlanOverride(proposal, prose, loadingId, opts);
  }catch(e){
    const msg = e.status===529 ? 'Claude\'s API is briefly overloaded - try again in a moment' : (e.message||'unknown error');
    const el = document.getElementById(loadingId);
    if(el) el.innerText = 'Could not draft a plan change (' + msg + ').';
    console.error(e);
  }finally{
    // No early return or thrown error may leave a bar spinning forever.
    progress.done();
  }
}

// The tail shared by both paths: heal the day tags, re-read the goal config, validate, show
// the confirm-gated card. A batched proposal goes through exactly this, so a year-long block
// gets the same validation and the same explicit Apply as a one-session tweak.
async function finishPlanOverride(proposal, prose, loadingId, opts){
  const loadingEl = document.getElementById(loadingId);
  if(loadingEl && prose) loadingEl.innerText = prose;
  // Self-heal the weekday label in each day tag (e.g. "Fri - Sep 5") - caught live with a
  // real Sep 5, 2026 race day mislabeled "Fri" when it's actually a Saturday, even though
  // the month/day itself was right. parseDayTagDate/dateToTag already give a fully
  // reliable way to compute the correct weekday for a date - no reason to trust the
  // model's own weekday arithmetic when a deterministic answer already exists, especially
  // since every date computation elsewhere in the app only ever reads the month/day part
  // anyway (this was cosmetic-but-confusing, not a deeper date-math bug, but still worth
  // guaranteeing correct rather than leaving to chance).
  if(Array.isArray(proposal.weeks)){
    proposal.weeks.forEach(w=>{
      (w.days||[]).forEach(d=>{
        if(!d.tag) return;
        const parsed = parseDayTagDate(d.tag, proposal.weeks);
        if(parsed) d.tag = dateToTag(parsed);
      });
    });
  }
  // Refresh again right before validating/rendering, not just at the top of this
  // function - the LLM call above can take 10-20s, long enough for state.goalConfig to
  // have changed again in the meantime (this exact staleness was caught live: an
  // identical goal-config patch rendered as "(new)"/"removed" instead of no diff,
  // because state.goalConfig at render time didn't match what was actually persisted).
  state.goalConfig = await loadGoalConfig();
  const validation = await validatePlanOverride(state.WEEKS, proposal, opts);
  renderPlanOverrideNotice(loadingId, proposal, validation);
}

// One model call plus up to MAX_CONTINUATIONS resumes if it runs long. Both phases use it,
// so a batch that overruns still recovers the same way a single-call rebuild always has.
const MAX_CONTINUATIONS = 2;
async function fetchWithContinuations(system, text, loadingId, progressLabel, progress){
  const data = await fetchCoachReply(system, text, 'plan-override');
  let out = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  let stopReason = data.stop_reason;
  for(let cont=0; stopReason==='max_tokens' && cont<MAX_CONTINUATIONS; cont++){
    const label = progressLabel+' (long response, continuing part '+(cont+2)+')';
    if(progress) progress.set(label);
    else { const el = document.getElementById(loadingId); if(el) el.innerText = label; }
    const continueText = 'Continue exactly where your last reply was cut off - do not repeat anything you already sent, do not restart or re-summarize any of it, just resume writing from the exact point it stopped (including finishing the JSON object if that\'s where it was cut off).';
    const moreData = await fetchCoachReply(system, continueText, 'plan-override');
    out += (moreData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    stopReason = moreData.stop_reason;
  }
  return {text: out, truncated: stopReason==='max_tokens'};
}

// How many times a phase may be sent back with its own specific defects before the whole
// rebuild is abandoned. A first attempt that misses a rule is ordinary; the same defect
// surviving three corrections is a model that cannot satisfy the constraint, and continuing
// past that just spends tokens on the same answer.
export const MAX_REPAIR_ROUNDS = 3;

// Every rule the block audit knows, restated for the model as the bar it has to clear. These
// are not suggestions to weigh - they are the checks the app runs on the result, so a block
// that breaks one is a block that gets thrown away.
function auditRulesBrief(){
  return 'HARD RULES - the app audits the finished block against exactly these and rejects it if any FAIL:\n'+
    '- Every non-race week carries real quality work (a threshold or VO2max session). No dead weeks.\n'+
    '- No two hard days (threshold, VO2max, long, race) on consecutive calendar days.\n'+
    '- Build-week volume never rises more than 10% over the previous build week.\n'+
    '- A cutback week at least every 4 build weeks, and a cutback must be at least 12% lighter than the surrounding build weeks.\n'+
    '- The long run stays under 40% of its own week\'s volume.\n'+
    '- Long-run progression never goes flat on BOTH distance and fast-portion for 6 build weeks running; weekly quality minutes never flat for 6 build weeks running.\n'+
    '- Quality minutes rise from phase to phase (taper excepted - shedding quality is what a taper is).\n'+
    '- Goal-pace work exists and grows across the specific phase.\n'+
    '- The race week is at least 20% below the peak week.\n'+
    '- Every non-race day falls on Monday, Wednesday, Thursday or Saturday.\n';
}

// A compact table of the block as it currently stands, so a repair round can see the shape it
// is correcting rather than guessing from the failure messages alone.
function blockTableForPrompt(weeks, blockStartN){
  const rows = summarizeWeeks(weeks, blockStartN);
  return rows.map(r => 'w'+r.disp+' (n'+r.n+') '+(r.phase||'-')+(r.cutback?' CUTBACK':'')+(r.race?' RACE':'')+
    ' '+Math.round(r.km)+'km, long '+Math.round(r.longKm)+'km, quality '+r.quality+'x/'+r.qMin+'min').join('\n');
}

export function buildOutlineRepairRequestText(failures, warnings){
  return 'That outline does not pass the app\'s own block audit. These are real, deterministic failures measured from the numbers you gave, not opinions:\n'+
    failures.map(f=>'- FAIL ['+f.id+'] '+f.message).join('\n')+
    (warnings && warnings.length ? ('\nAlso worth fixing while you are here:\n'+warnings.map(w=>'- '+w.message).join('\n')) : '')+
    '\n\nWeek labels above are DISPLAY numbers (w1 = the first week of this block). Re-emit the COMPLETE corrected outline - every week again, not just the broken ones - as a single "PLAN OUTLINE:" block in the same shape as before. Fix the causes rather than nudging numbers until the check passes: if volume ramps too fast, lower the earlier weeks or raise fewer; if a week has no quality, give it a session; if a cutback is too shallow, cut it properly.';
}

export function buildBatchRepairRequestText(batchNs, defects, outlineEntries){
  const entries = (outlineEntries||[]).filter(e=>e && batchNs.indexOf(e.n)!==-1);
  return 'Those week objects were rejected. Specific defects:\n'+
    defects.map(d=>'- '+d).join('\n')+
    '\n\nRe-emit ALL of weeks ['+batchNs.join(', ')+'] again, corrected, as one "PLAN OVERRIDE:" block containing {"weeks":[...]} and nothing else.'+
    (entries.length ? ('\nThe outline entries you are matching:\n'+JSON.stringify(entries)) : '');
}

export function buildBlockRepairRequestText(failures, warnings, table){
  return 'The full block is now written out, and it FAILS the app\'s own audit. These are deterministic measurements over the whole block - the kind of problem that is invisible week by week and obvious in a table:\n'+
    failures.map(f=>'- FAIL ['+f.id+'] '+f.message).join('\n')+
    (warnings && warnings.length ? ('\nAlso flagged, fix these too if the same edit can:\n'+warnings.map(w=>'- WARN ['+w.id+'] '+w.message).join('\n')) : '')+
    '\n\nThe block as it currently stands (w = DISPLAY week number, n = the internal key to use in JSON):\n'+table+
    '\n\nEmit a "PLAN OVERRIDE:" block containing {"weeks":[...]} with COMPLETE corrected week objects for ONLY the weeks you need to change to clear every failure above - by their internal "n". Change as few weeks as genuinely fixes the cause. Do not restate weeks you are leaving alone. No prose, nothing after the JSON.';
}

// Deterministic structural check on one freshly-expanded batch, before it is allowed into the
// merged block. Catches the mechanical failures (wrong weeks, a missing recipe, a session on
// the wrong weekday, a volume that ignores the outline) at the point they can still be fixed
// cheaply, rather than letting them surface fifty weeks later as a whole-block audit failure
// nobody can attribute.
export function auditBatchStructure(weeks, batchNs, outlineEntries){
  const defects = [];
  const byN = new Map((weeks||[]).filter(w=>w && w.n!=null).map(w=>[w.n, w]));
  batchNs.forEach(n=>{ if(!byN.has(n)) defects.push('week n'+n+' is missing from the reply entirely'); });
  (weeks||[]).forEach(w=>{ if(w && w.n!=null && batchNs.indexOf(w.n)===-1) defects.push('week n'+w.n+' was not asked for in this batch - only ['+batchNs.join(', ')+']'); });

  const outlineByN = new Map((outlineEntries||[]).filter(e=>e && e.n!=null).map(e=>[e.n, e]));
  byN.forEach((w, n)=>{
    const days = w.days||[];
    if(!days.length){ defects.push('week n'+n+' has no days'); return; }
    days.forEach(d=>{
      if(!d || !d.tag){ defects.push('week n'+n+' has a day with no tag'); return; }
      const weekday = String(d.tag).split(' ')[0];
      if(d.type!=='race' && PREFERRED_TRAINING_DAYS.indexOf(weekday)===-1){
        defects.push('week n'+n+' puts "'+(d.name||d.type)+'" on '+weekday+' - training days are '+PREFERRED_TRAINING_DAYS.join('/'));
      }
      if(d.type!=='open' && d.type!=='race' && !d.recipe){
        defects.push('week n'+n+' day "'+(d.name||d.type)+'" has no "recipe" - hand-written "data" freezes its paces for the life of the plan');
      }
      if(d.recipe && !SESSION_RECIPES[d.recipe.fn]){
        defects.push('week n'+n+' day "'+(d.name||d.type)+'" uses unknown recipe "'+d.recipe.fn+'" - must be one of: '+Object.keys(SESSION_RECIPES).join(', '));
      }
    });
    // Against the outline it committed to. A wide tolerance on purpose: the point is to catch a
    // week that ignored its target, not to police rounding.
    const entry = outlineByN.get(n);
    if(entry && entry.targetKm){
      let km = 0;
      try{ km = computeWeekPlannedKm(materializeWeek(w)); }catch(e){ km = 0; }
      const target = parseFloat(entry.targetKm);
      if(km && target && (km > target*1.15 || km < target*0.85)){
        defects.push('week n'+n+' comes to '+Math.round(km)+'km but its outline committed to about '+target+'km');
      }
    }
  });
  return defects;
}

// The proposed weeks laid over the current plan, materialized, exactly as applyPlanOverrides
// would - so the audit judges the block the runner would actually get, not the proposal in
// isolation (which would miss every cross-boundary problem: a volume spike from the last
// unchanged week into the first new one, a cutback gap straddling the join).
function spliceProposedWeeks(currentWeeks, proposedWeeks){
  const byN = new Map((currentWeeks||[]).map(w=>[w.n, w]));
  (proposedWeeks||[]).forEach(w=>{
    if(!w || w.n==null) return;
    let m = w;
    try{ m = materializeWeek(w); }catch(e){}
    byN.set(w.n, m);
  });
  return Array.from(byN.values()).sort((a,b)=>a.n-b.n);
}

// Outline, then expand, then repair until the result actually passes the app's own audit.
//
// Generating a year of training in one pass and hoping is not a plan, it is a lottery ticket -
// and a block with a dead week or a 20% volume spike buried at week 30 is not something a
// runner can be handed and told to check themselves. So the audit that already defines a sound
// block (plan-audit.js, shared with the command-line script and the Plan health panel) is the
// acceptance test here: the outline is audited before a single week is expanded against it,
// each batch is structurally checked as it lands, and the finished block is audited whole,
// spliced onto the real plan. Every failure goes back as the specific, measured defect it is.
//
// Returns null - having written the reason into the chat - rather than delivering a block that
// still fails. That is the deal: a plan that clears every rule, or none.
async function buildProposalInBatches(system, userRequest, loadingId, opts, progress){
  const fail = msg => { if(progress) progress.done(); const el = document.getElementById(loadingId); if(el) el.innerText = msg; return null; };
  const setLabel = txt => { if(progress) progress.set(txt); else { const el = document.getElementById(loadingId); if(el) el.innerText = txt; } };
  const blockStartN = (state.goalConfig||{}).blockStartWeekN;
  const rulesNote = '\n\n'+auditRulesBrief();

  // --- Phase 1: the outline, audited before anything is expanded against it ---
  let outline = null, outlineProse = '';
  for(let round=0; round<MAX_REPAIR_ROUNDS; round++){
    setLabel(round===0 ? 'Planning the shape of the whole block first...' : 'Correcting the block outline (round '+round+')...');
    const text = round===0 ? (buildOutlineRequestText(userRequest)+rulesNote) : buildOutlineRepairRequestText(outline.__failures, outline.__warnings);
    const reply = await fetchWithContinuations(system, text, loadingId, 'Planning the shape of the whole block');
    const parsed = extractJsonBlock(reply.text, 'PLAN OUTLINE:', '{');
    if(!parsed.ok){
      // No outline at all is most often the coach concluding no plan change is warranted,
      // which is a legitimate answer and should be shown exactly as written.
      if(round===0) return fail((parsed.prose || reply.text || '').trim() || 'The coach could not outline a block that long - try describing the request more specifically.');
      return fail('The block outline could not be corrected after '+round+' attempt(s). Nothing has been changed.');
    }
    const candidate = parsed.value;
    const outlineWeeks = (candidate.weeks)||[];
    if(!outlineWeeks.length){
      // An outline with no weeks but a goalConfigPatch is a real answer: the request turned
      // out to be entirely about the target rather than the structure.
      if(candidate.goalConfigPatch) return {proposal: {weeks: [], methodology: candidate.methodology, methodologyRationale: candidate.methodologyRationale, truncateAfter: candidate.truncateAfter!=null ? candidate.truncateAfter : null, goalConfigPatch: candidate.goalConfigPatch}, prose: parsed.prose};
      return fail(parsed.prose || 'The coach outlined no weeks to change.');
    }
    const audit = auditOutline(outlineWeeks, {blockStartN});
    outline = candidate;
    outline.__failures = audit.failures;
    outline.__warnings = audit.warnings;
    outlineProse = parsed.prose || outlineProse;
    if(!audit.failures.length) break;
    if(round===MAX_REPAIR_ROUNDS-1){
      return fail('The block outline still breaks its own rules after '+MAX_REPAIR_ROUNDS+' attempts, so nothing has been changed:\n- '+audit.failures.map(f=>f.message).join('\n- '));
    }
  }

  // --- Phase 2: expand, batch by batch, each one checked as it lands ---
  const outlineNs = ((outline.weeks)||[]).map(w=>w.n).filter(n=>n!=null);
  const batches = planBatches(outlineNs, PLAN_BATCH_SIZE);
  const collected = [];
  for(let i=0; i<batches.length; i++){
    const b = batches[i];
    const span = 'w'+dispN(b[0], blockStartN)+'-w'+dispN(b[b.length-1], blockStartN);
    let accepted = null, defects = [];
    for(let attempt=0; attempt<MAX_REPAIR_ROUNDS; attempt++){
      setLabel('Building weeks '+span+' (part '+(i+1)+' of '+batches.length+')'+(attempt ? ' - correcting' : '')+'...');
      const text = attempt===0
        ? buildExpansionRequestText(b, i, batches.length, outline.weeks)
        : buildBatchRepairRequestText(b, defects, outline.weeks);
      const reply = await fetchWithContinuations(system, text, loadingId, 'Building weeks '+span);
      const parsed = extractJsonBlock(reply.text, 'PLAN OVERRIDE:', '{');
      if(!parsed.ok || !Array.isArray(parsed.value.weeks)){
        defects = ['the reply contained no usable {"weeks":[...]} JSON object'];
        continue;
      }
      defects = auditBatchStructure(parsed.value.weeks, b, outline.weeks);
      if(!defects.length){ accepted = parsed.value.weeks; break; }
    }
    if(!accepted) return fail('Weeks '+span+' could not be written correctly after '+MAX_REPAIR_ROUNDS+' attempts, so nothing has been changed:\n- '+defects.join('\n- '));
    collected.push(accepted);
  }

  let merged = mergeBatchedProposal(outline, collected);
  if(merged.missing.length){
    return fail('The block came back incomplete - '+merged.missing.length+' of the '+outlineNs.length+' outlined weeks were never written out. Nothing has been changed.');
  }

  // --- Phase 3: audit the finished block as a whole, and repair what it finds ---
  const gated = await repairUntilClean(system, merged.proposal, loadingId, opts, fail, setLabel);
  if(!gated) return null;
  return {proposal: gated.proposal, prose: outlineProse, audit: gated.audit};
}

// A failure the proposal is responsible for, as opposed to one the block already had. A small
// rebuild must not be held hostage to a pre-existing problem somewhere else in the year - but
// it must not be allowed to introduce one either, and it must fix one it makes worse in a week
// it is touching. So a failure counts when its check was passing before, or when it names a
// week this proposal actually rewrote.
export function introducedFailures(beforeFailures, afterFailures, changedLabels){
  const wasFailing = new Set((beforeFailures||[]).map(f=>f.id));
  const labels = changedLabels||[];
  return (afterFailures||[]).filter(f =>
    !wasFailing.has(f.id) || labels.some(l => new RegExp('\\b'+l+'\\b').test(f.message)));
}

// The gate every rebuild passes through, long or short: splice the proposal onto the real
// plan, audit the whole thing, and hand back anything this change is responsible for until it
// comes back clean. Kept separate from the batched generator precisely so the short path gets
// it too - an injury return now rewrites four weeks rather than fifty, and four weeks can
// break the block's shape just as effectively as fifty.
async function repairUntilClean(system, proposal, loadingId, opts, fail, setLabel, progress){
  const blockStartN = (state.goalConfig||{}).blockStartWeekN;
  const before = auditBlock(state.WEEKS, {blockStartN});
  let current = proposal;
  let lastAudit = before;
  for(let round=0; round<=MAX_REPAIR_ROUNDS; round++){
    if(setLabel) setLabel(round===0 ? 'Checking it against the whole block...' : 'Fixing what the audit found (round '+round+' of '+MAX_REPAIR_ROUNDS+')...');
    const spliced = spliceProposedWeeks(state.WEEKS, current.weeks);
    lastAudit = auditBlock(spliced, {blockStartN});
    const changedLabels = (current.weeks||[]).filter(w=>w && w.n!=null).map(w=>'w'+dispN(w.n, blockStartN));
    // The applier's own hard rules count too. Without this, a block could clear the structural
    // audit and then be refused at the very last step by validatePlanOverride - handing the
    // runner a rejection after a dozen model calls, for defects that were fixable all along.
    let validationErrors = [];
    try{ validationErrors = (await validatePlanOverride(state.WEEKS, current, opts)).errors || []; }catch(e){}
    const problems = introducedFailures(before.failures, lastAudit.failures, changedLabels)
      .map(f=>({id:f.id, message:f.message}))
      .concat(validationErrors.map(msg=>({id:'validator', message:msg})));
    if(!problems.length) break;
    if(round===MAX_REPAIR_ROUNDS){
      return fail('The plan change still breaks the app\'s own rules after '+MAX_REPAIR_ROUNDS+' rounds of corrections, so nothing has been changed:\n- '+problems.map(p=>p.message).join('\n- '));
    }
    const repairText = buildBlockRepairRequestText(problems, lastAudit.warnings, blockTableForPrompt(spliced, blockStartN));
    const reply = await fetchWithContinuations(system, repairText, loadingId, 'Fixing what the audit found');
    const parsed = extractJsonBlock(reply.text, 'PLAN OVERRIDE:', '{');
    if(!parsed.ok || !Array.isArray(parsed.value.weeks) || !parsed.value.weeks.length){
      return fail('The audit found problems the coach did not return a correction for, so nothing has been changed:\n- '+problems.map(p=>p.message).join('\n- '));
    }
    // Corrections replace the weeks they name and leave the rest alone.
    const byN = new Map((current.weeks||[]).map(w=>[w.n, w]));
    parsed.value.weeks.forEach(w=>{ if(w && w.n!=null) byN.set(w.n, w); });
    current = Object.assign({}, current, {weeks: Array.from(byN.values()).sort((a,b)=>a.n-b.n)});
  }
  return {proposal: current, audit: lastAudit};
}

// Human-readable diff for goalConfigPatch, same spirit as the week-km diff rows - the raw
// JSON shape the prompt requires the model to emit (see buildPlanOverrideSystemPrompt) is
// meant for the model to produce reliably, not for a runner to read directly.
export function goalConfigPatchDiffHTML(patch){
  if(!patch) return '';
  const rows = [];
  const current = state.goalConfig || defaultGoalConfig();
  if(patch.phase!=null && patch.phase!==current.phase){
    rows.push('<div class="tier-diff-row"><span class="tier-diff-label">Phase</span><span class="tier-diff-vals">'+(current.phase||'-')+' → <b>'+patch.phase+'</b></span></div>');
  }
  if(Array.isArray(patch.activeGoals)){
    const beforeById = {};
    (current.activeGoals||[]).forEach(g=>{ beforeById[g.goalId] = g; });
    const afterIds = new Set(patch.activeGoals.map(g=>g.goalId));
    const fmtGoal = g => (g.goalTimeLabel||'')+(g.goalPaceLabel?(' ('+g.goalPaceLabel+')'):'');
    patch.activeGoals.forEach(g=>{
      const before = beforeById[g.goalId];
      const afterLabel = fmtGoal(g);
      if(!before){
        rows.push('<div class="tier-diff-row"><span class="tier-diff-label">'+(g.label||g.type||'Goal')+'</span><span class="tier-diff-vals">(new) <b>'+afterLabel+'</b></span></div>');
      } else {
        const beforeLabel = fmtGoal(before);
        if(beforeLabel!==afterLabel){
          rows.push('<div class="tier-diff-row"><span class="tier-diff-label">'+(g.label||g.type||'Goal')+'</span><span class="tier-diff-vals">'+beforeLabel+' → <b>'+afterLabel+'</b></span></div>');
        }
      }
    });
    (current.activeGoals||[]).forEach(g=>{
      if(!afterIds.has(g.goalId)){
        rows.push('<div class="tier-diff-row"><span class="tier-diff-label">'+(g.label||g.type||'Goal')+'</span><span class="tier-diff-vals">removed</span></div>');
      }
    });
  }
  return rows.join('');
}

export function renderPlanOverrideNotice(elId, proposal, validation){
  const el = document.getElementById(elId);
  if(!el) return;
  if(validation.errors.length){
    // Edit/Dismiss actions here too, not a dead end - this used to only ever fire for
    // genuinely malformed JSON (rare), but promoting real findings (weekday drift, a
    // rebalance that didn't address its own trigger) to hard errors for an auto-triggered
    // rebalance (see validatePlanOverride's opts.source==='rebalance' checks) means this
    // branch now fires routinely, and a runner stuck looking at a static error with no way
    // to ask for a revision is a real dead end, not just a rare edge case.
    const uid = 'po'+Date.now()+Math.floor(Math.random()*1000);
    state.pendingPlanOverride[uid] = proposal;
    const box = document.createElement('div');
    box.className = 'plan-override-box';
    box.id = uid;
    box.innerHTML = '<div class="tier-update-head">Plan change could not be applied</div>'+
      validation.errors.map(e=>'<div class="tier-diff-reason" style="color:#ff6b6b;">'+e+'</div>').join('')+
      '<div class="tier-update-actions"><button class="ghost-btn" onclick="editPlanOverride(\''+uid+'\')">Edit</button><button class="ghost-btn" onclick="dismissPlanOverrideNotice(\''+uid+'\')">Dismiss</button></div>';
    el.appendChild(box);
    return;
  }
  const uid = 'po'+Date.now()+Math.floor(Math.random()*1000);
  state.pendingPlanOverride[uid] = proposal;
  const weekDiffHTML = proposal.weeks.map(w=>{
    const before = state.WEEKS.find(x=>x.n===w.n);
    const beforeKm = before ? computeWeekPlannedKm(before) : null;
    // Materialized first: a recipe-based week carries no `data` until the app builds it, so
    // summing the raw proposal would report every proposed week as "0km" in this preview.
    const afterKm = computeWeekPlannedKm(materializeWeek(w));
    return '<div class="tier-diff-row"><span class="tier-diff-label">Week '+blockRelativeWeekN(w.n, state.goalConfig || defaultGoalConfig())+'</span><span class="tier-diff-vals">'+(beforeKm!=null?(beforeKm+'km → '):'(new week) ')+'<b>'+afterKm+'km</b></span></div>';
  }).join('');
  const truncateNote = proposal.truncateAfter!=null ? ('<div class="tier-diff-reason">Ends the current block after week '+proposal.truncateAfter+' - later untouched weeks won\'t carry forward.</div>') : '';
  const goalPatchHTML = goalConfigPatchDiffHTML(proposal.goalConfigPatch);
  const box = document.createElement('div');
  box.className = 'plan-override-box';
  box.id = uid;
  // A goal-config change (your actual race target, or the phase itself) is a much bigger
  // decision than a routine session tweak and deserves to be unmistakable, not just
  // another line in a card with the same "Apply" button as a rep-count change - caught
  // live: a goal change was accepted without the runner realizing that's what "Apply" did.
  // Flagged prominently up top AND gated behind a second, explicit confirmation step.
  const touchesGoal = !!proposal.goalConfigPatch;
  const goalChangeBanner = touchesGoal
    ? '<div class="tier-diff-reason" style="color:#ff6b6b; font-weight:700; margin-top:0;">&#9888; This also changes your actual race goal, not just the plan structure:</div>'+goalPatchHTML
    : '';
  const applyButtonHTML = touchesGoal
    ? '<button class="save-btn" style="background:#ff6b6b;" onclick="promptGoalChangeConfirmation(\''+uid+'\')">Review goal change</button>'
    : '<button class="save-btn" onclick="applyPlanOverride(\''+uid+'\')">Apply</button>';
  box.innerHTML = '<div class="tier-update-head">&#128221; Plan change proposed'+(proposal.methodology?(' - '+proposal.methodology):'')+'</div>'+
    (proposal.methodologyRationale ? ('<div class="tier-diff-reason">'+proposal.methodologyRationale+'</div>') : '')+
    goalChangeBanner+
    weekDiffHTML+
    truncateNote+
    validation.warnings.map(w=>'<div class="tier-diff-reason" style="color:var(--threshold);">'+w+'</div>').join('')+
    '<div class="tier-update-actions">'+applyButtonHTML+'<button class="ghost-btn" onclick="editPlanOverride(\''+uid+'\')">Edit</button><button class="ghost-btn" onclick="dismissPlanOverrideNotice(\''+uid+'\')">Dismiss</button></div>';
  el.appendChild(box);
}

// Second, explicit confirmation step specifically for a goal-changing proposal - the
// runner must see the goal diff again and actively choose to accept it, not just click
// the same button they'd use for an ordinary rep-count tweak.
export function promptGoalChangeConfirmation(uid){
  const box = document.getElementById(uid);
  const proposal = state.pendingPlanOverride[uid];
  if(!box || !proposal) return;
  const goalPatchHTML = goalConfigPatchDiffHTML(proposal.goalConfigPatch);
  const actionsEl = box.querySelector('.tier-update-actions');
  if(!actionsEl) return;
  actionsEl.outerHTML = '<div class="tier-diff-reason" style="color:#ff6b6b; font-weight:700;">Confirm: this changes your race goal to -</div>'+
    goalPatchHTML+
    '<div class="tier-update-actions"><button class="save-btn" style="background:#ff6b6b;" onclick="applyPlanOverride(\''+uid+'\')">Yes, change my goal</button><button class="ghost-btn" onclick="dismissPlanOverrideNotice(\''+uid+'\')">Cancel - keep current goal</button></div>';
}

export function dismissPlanOverrideNotice(uid){
  const box = document.getElementById(uid);
  if(box) box.innerHTML = '<div class="tier-diff-reason" style="color:var(--dim);">Dismissed - nothing changed.</div>';
  delete state.pendingPlanOverride[uid];
}

export function editPlanOverride(uid){
  const proposal = state.pendingPlanOverride[uid];
  if(!proposal) return;
  toggleGlobalPlanOverrideModal(true);
  const input = document.getElementById('planOverrideInput');
  if(input){
    input.placeholder = 'Tell the coach what to change about this proposal...';
    input.dataset.priorPlanOverrideUid = uid;
  }
}

export async function applyPlanOverride(uid){
  const box = document.getElementById(uid);
  const proposal = state.pendingPlanOverride[uid];
  if(!proposal){
    if(box) box.innerHTML = '<div class="tier-diff-reason" style="color:#ff6b6b;">This proposal is no longer available - ask the coach again.</div>';
    return;
  }
  try{
    let existing = {version:1, weeksByN:{}, truncateAfter:null, activeMethodology:null};
    try{ const r = await window.storage.get('plan-override', false); if(r) existing = JSON.parse(r.value); }catch(e){}
    const existingGoalConfig = state.goalConfig || defaultGoalConfig();
    // Captured before any archiving below happens in this same Apply, so a later revert
    // knows exactly how many goal-history entries to trim back off - see truncateGoalHistory
    // in revertPlanOverride.
    const goalHistoryLengthBefore = (await loadGoalHistory()).length;

    // Snapshot both the plan-override AND the goal-config together, since a single Apply
    // can change either or both (goalConfigPatch) - reverting one without the other would
    // leave a phase/goal change permanent even after "undoing" the plan change it came with.
    let history = [];
    try{ const hr = await window.storage.get('plan-override-history', false); if(hr) history = JSON.parse(hr.value); }catch(e){}
    history.unshift({planOverride: existing, goalConfig: existingGoalConfig, goalHistoryLengthBefore});
    if(history.length>15) history = history.slice(0,15);
    await saveWithRetry('plan-override-history', history, false);
    await sleep(150);

    const weeksByN = Object.assign({}, existing.weeksByN);
    proposal.weeks.forEach(w=>{ weeksByN[String(w.n)] = w; });
    const merged = {
      version: 1, weeksByN,
      truncateAfter: proposal.truncateAfter!=null ? proposal.truncateAfter : (existing.truncateAfter!=null ? existing.truncateAfter : null),
      activeMethodology: proposal.methodology || existing.activeMethodology || null,
      updatedAt: new Date().toISOString(),
    };
    await saveWithRetry('plan-override', merged, false);
    await sleep(150);

    if(proposal.goalConfigPatch){
      const currentGoalConfig = state.goalConfig || defaultGoalConfig();
      const newGoalConfig = Object.assign({}, currentGoalConfig, proposal.goalConfigPatch);

      // Snapshot any goal this patch drops or materially changes to goal-history BEFORE
      // overwriting it, so it stays visible for reference (e.g. after the Sep 27 HM goal
      // gets swapped for a different race) - see planGoalArchival/archiveGoal in
      // data/goal-history.js. Only runs when the patch actually touches activeGoals; a
      // pace-only or phase-only patch has nothing to diff here.
      if(Array.isArray(proposal.goalConfigPatch.activeGoals)){
        const toArchive = planGoalArchival(currentGoalConfig.activeGoals||[], proposal.goalConfigPatch.activeGoals);
        for(const {goal, reason} of toArchive){
          let finalReason = reason;
          let result = null;
          // A dropped (not superseded) goal whose race day has already passed is a
          // completed goal, not an abandoned one - worth a different label, and worth
          // attaching the actual result if one was logged.
          if(reason==='removed' && goal.raceDate && new Date() > new Date(goal.raceDate)){
            finalReason = 'completed';
            try{
              const found = findGoalRaceDay(state.WEEKS, goal);
              if(found){
                const log = await loadWorkoutLog(found.week.n, found.day.tag);
                if(log && log.completed && log.actualDist && log.actualDur){
                  const actualDurSec = parseFloat(log.actualDur)*60;
                  result = {actualDist: parseFloat(log.actualDist), actualDurSec, actualTimeLabel: fmtDuration(actualDurSec)};
                }
              }
            }catch(e){ console.error('goal-history: fetching race result failed', e); }
          }
          try{ await archiveGoal(goal, finalReason, result); await sleep(150); }
          catch(e){ console.error('archiveGoal failed', e); }
        }
        // A materially different active-goal set (something above just got archived, or
        // there was no prior goal at all) is a new training block - the plan from here is
        // built around current fitness, not a continuation of adherence to whatever goal
        // used to be active. Stamped here, not on every apply, so a same-goal patch (a pace
        // tweak, a phase-only change) doesn't reset it - see scanAdherenceWindow's
        // blockStartedAt clamp in plan-adherence.js, the only thing that reads this.
        if(toArchive.length || !(currentGoalConfig.activeGoals||[]).length){
          const allWeeksNow = await applyPlanOverrides(buildWeeks());
          stampNewBlock(newGoalConfig, allWeeksNow);
        }
      }

      await saveGoalConfig(newGoalConfig);
      await sleep(150);
      state.goalConfig = newGoalConfig;
      // The AI-synthesized trajectory readings (position/confidence/headline) were
      // computed against whatever goal was active at the time - once the goal itself
      // changes, that reading no longer means anything relative to the new target but
      // stays displayed as if it still does. Caught live: a goal made meaningfully harder
      // left a stale "83/100, clearly ahead of schedule" reading on screen, flatly
      // contradicting the runner's own actual current-fitness projection. Clearing these
      // forces a fresh deterministic-baseline read until the next real coach interaction
      // recomputes a new AI synthesis against the goal that's actually active now.
      try{
        await window.storage.delete('goal-trajectory-latest', false);
        await sleep(150);
        await window.storage.delete('goal-trajectory-10k-latest', false);
        await sleep(150);
        await window.storage.delete('goal-trajectory-prevpos', false);
        await sleep(150);
        await window.storage.delete('goal-trajectory-10k-prevpos', false);
        await sleep(150);
        await window.storage.delete('goal-trajectory-maintenance-latest', false);
        await sleep(150);
        await window.storage.delete('goal-trajectory-maintenance-prevpos', false);
        await sleep(150);
        // A real goal change resets both watchdogs' memory too - the old episode (if any)
        // was about the goal that no longer exists, so a fresh reading against the new
        // target should surface as a brand-new detection if it recurs, not silently stay
        // muted by an episode that's no longer about anything real.
        await window.storage.delete('achievability-warning-episodes', false);
        await sleep(150);
        await window.storage.delete('push-watchdog-episodes', false);
        await sleep(150);
      }catch(e){ console.error('clearing stale goal-trajectory readings failed', e); }
    }

    // Z must be recomputed BEFORE buildWeeks() runs, not after - threshold()/vo2max()/etc.
    // (in plan.js) read state.Z.S4/.S5.pace at BUILD time and bake the resulting number into
    // each day's data, they don't re-read it live at render time. Getting this backwards
    // means the freshly-built weeks would bake in the pace from before this Apply, only
    // picking up the real one on the next unrelated re-render that happens to rebuild weeks.
    { const r = await recomputeZones(state.profile, state.goalConfig); state.Z = r.Z; state.layoffAdjustment = r.layoffAdjustment; state.paceSource = r.paceSource; }
    state.WEEKS = await applyPlanOverrides(buildWeeks());
    await clearStaleRebuildSuggestions();
    await refreshAdherenceState();
    renderPageHeader();
    renderNav();
    renderCurrentWeek();

    if(box) box.innerHTML = '<div class="tier-diff-reason" style="color:var(--easy);">&#10003; Applied - the plan above now reflects this change.</div>';
    delete state.pendingPlanOverride[uid];
  }catch(e){
    console.error('applyPlanOverride failed', e);
    notifyError('Could not apply this plan change - try again.');
  }
}

// Backs the drag-and-drop reordering in week-view.js (initWeekDragAndDrop) - a deliberately
// direct, no-review-step apply, unlike proposeSwapFromSuggestion above (which shows a diff
// card the runner confirms before anything is written). That review step exists because
// THAT flow is the app inferring a swap MIGHT have happened and proposing to formalize it -
// worth a second look. This is the opposite: the runner just dragged one specific card onto
// another specific card, a fully deliberate, mechanical action with no inference involved -
// Runna-style "drag it, drop it, done" directness, with a real Undo (reusing the exact same
// plan-override-history snapshot revertPlanOverride already reads) as the safety net instead
// of a confirm click. buildSwapProposal (plan-adherence.js) does the actual content swap -
// same deterministic, already-tested logic proposeSwapFromSuggestion uses, just applied
// immediately instead of staged for review.
export async function applyDaySwapDirect(dayA, dayB){
  const proposal = buildSwapProposal({actualDay:dayA, missingDay:dayB}, state.WEEKS);
  if(!proposal){
    // Diagnostic detail for the console (not the user-facing toast, which stays short) -
    // reported live with no visible cause from the UI alone; this pins down exactly which
    // side failed to resolve (wrong week, or the tag not found in that week's real days)
    // the next time it happens, rather than guessing again from a screenshot.
    console.error('applyDaySwapDirect: buildSwapProposal returned null', {
      dayA, dayB,
      weekAFound: !!state.WEEKS.find(w=>w.n===dayA.weekN),
      weekBFound: !!state.WEEKS.find(w=>w.n===dayB.weekN),
      weekADayTags: (state.WEEKS.find(w=>w.n===dayA.weekN)||{days:[]}).days.map(d=>d.tag),
      weekBDayTags: (state.WEEKS.find(w=>w.n===dayB.weekN)||{days:[]}).days.map(d=>d.tag),
    });
    return {ok:false, error:'Could not find both days to swap - try again.'};
  }
  try{
    let existing = {version:1, weeksByN:{}, truncateAfter:null, activeMethodology:null};
    try{ const r = await window.storage.get('plan-override', false); if(r) existing = JSON.parse(r.value); }catch(e){}
    let history = [];
    try{ const hr = await window.storage.get('plan-override-history', false); if(hr) history = JSON.parse(hr.value); }catch(e){}
    const goalHistoryLengthBefore = (await loadGoalHistory()).length;
    history.unshift({planOverride: existing, goalConfig: state.goalConfig || defaultGoalConfig(), goalHistoryLengthBefore});
    if(history.length>15) history = history.slice(0,15);
    await saveWithRetry('plan-override-history', history, false);
    await sleep(150);

    const weeksByN = Object.assign({}, existing.weeksByN);
    proposal.weeks.forEach(w=>{ weeksByN[String(w.n)] = w; });
    const merged = {version:1, weeksByN, truncateAfter: existing.truncateAfter!=null?existing.truncateAfter:null, activeMethodology: existing.activeMethodology||null, updatedAt:new Date().toISOString()};
    await saveWithRetry('plan-override', merged, false);
    await sleep(150);

    state.WEEKS = await applyPlanOverrides(buildWeeks());
    await clearStaleRebuildSuggestions();
    await refreshAdherenceState();
    renderPageHeader();
    renderNav();
    renderCurrentWeek();
    return {ok:true};
  }catch(e){
    console.error('applyDaySwapDirect failed', e);
    return {ok:false, error: e.message||'unknown error'};
  }
}

// These three are otherwise only computed once, at page load (see main.js) - real, but
// stale the moment a plan change actually lands mid-session (Apply/revert both rebuild
// state.WEEKS without a reload). Left uncorrected, a just-applied re-ramp would leave its
// own "significant" banner and Propose button up as if nothing happened, and an applied
// swap would leave the same swap suggested again. Re-running all three against the fresh
// state.WEEKS after every Apply/revert keeps the banners honest without needing a reload.
async function refreshAdherenceState(){
  try{ state.missedSessionAdjustments = await getMissedSessionAdjustments(); }catch(e){}
  // Must run AFTER missedSessionAdjustments - computeAheadOfScheduleSignals reads it for
  // its mutual-exclusion gate (see the doc comment on that function in goal-trajectory.js).
  try{ state.aheadOfScheduleSignals = await computeAheadOfScheduleSignals(); }catch(e){}
  try{ state.likelySwapSuggestions = await getLikelySwapSuggestions(); }catch(e){}
  try{ state.hardSessionProximityFlags = await getHardSessionProximityFlags(); }catch(e){}
  try{ await refreshInjuryState(); }catch(e){}
}

// Whatever "Suggested plan change" text originally prompted this Apply (the verdict card
// and/or a week's "Since last week" preview) is now stale - it already got acted on, so
// leaving its "Draft this rebuild"/Copy affordance up just invites requesting the same
// change again. Doesn't try to trace which specific suggestion led here (the request text
// is free-form, not tied back to a card id) - simplest correct behavior is clearing every
// currently-cached rebuild suggestion, since all of them describe a pre-apply plan state.
async function clearStaleRebuildSuggestions(){
  // Both keys, not just latest-verdict: the card shows the newest PERFORMED-workout verdict
  // (coach/verdict-card.js), which in storage written before that rule can sit in
  // verdict-history while latest-verdict holds a skip. Re-rendering through loadLatestVerdict
  // rather than the object just edited keeps that choice in one place.
  try{
    let cleared = false;
    const vr = await window.storage.get('latest-verdict', false);
    if(vr){
      const verdict = JSON.parse(vr.value);
      if(verdict && verdict.rebuildText){
        verdict.rebuildText = null;
        await saveWithRetry('latest-verdict', verdict, false);
        cleared = true;
      }
    }
    const hr = await window.storage.get('verdict-history', false);
    if(hr){
      const history = JSON.parse(hr.value);
      if(Array.isArray(history) && history.some(v=>v && v.rebuildText)){
        await saveWithRetry('verdict-history', history.map(v=>(v && v.rebuildText) ? Object.assign({}, v, {rebuildText:null}) : v), false);
        cleared = true;
      }
    }
    if(cleared){ await loadLatestVerdict(); await sleep(150); }
  }catch(e){ console.error('clearStaleRebuildSuggestions: verdict clear failed', e); }
  try{
    const list = await window.storage.list('week-preview-w', false);
    if(list && list.keys){
      for(const key of list.keys){
        try{
          const r = await window.storage.get(key, false);
          if(!r) continue;
          const preview = JSON.parse(r.value);
          if(!preview.rebuildText) continue;
          preview.rebuildText = null;
          await saveWithRetry(key, preview, false);
          const weekN = parseInt(key.replace('week-preview-w', ''), 10);
          if(!isNaN(weekN)) state.weekPreviewCache[weekN] = preview;
          await sleep(150);
        }catch(e){}
      }
    }
  }catch(e){ console.error('clearStaleRebuildSuggestions: week-preview clear failed', e); }
}

// Turns a detected type-swap (see plan-adherence.js's getLikelySwapSuggestions) into a real,
// reviewable rebuild proposal using the exact same validate -> render -> Apply pipeline as
// every other plan change here. A swap is completely mechanical and unambiguous - two known
// day objects, prescriptions exchanged - so there's no reason to route it through an LLM
// rebuild conversation first; it still goes through the same validation and still requires
// the same explicit Apply click before anything is saved, same as any other proposal.
export async function proposeSwapFromSuggestion(index){
  const suggestion = state.likelySwapSuggestions && state.likelySwapSuggestions[index];
  const elId = 'swap-proposal-'+index;
  const el = document.getElementById(elId);
  if(!suggestion){
    if(el) el.innerHTML = '<div class="tier-diff-reason" style="color:#ff6b6b;">This suggestion is no longer available.</div>';
    return;
  }
  const proposal = buildSwapProposal(suggestion, state.WEEKS);
  if(!proposal){
    if(el) el.innerHTML = '<div class="tier-diff-reason" style="color:#ff6b6b;">Could not build this swap - the plan may have changed since this was suggested.</div>';
    return;
  }
  const validation = await validatePlanOverride(state.WEEKS, proposal);
  renderPlanOverrideNotice(elId, proposal, validation);
}

// Turns every significant flagged missed-session pattern (see plan-adherence.js's
// getMissedSessionAdjustments) plus the readiness signal (readiness.js) into ONE
// natural-language rebalance request, sent through the exact same coach-drafted
// requestPlanOverride() pipeline the free-text "Rebuild plan" button uses - a real
// restructure across the remaining weeks of the block (adjust intensity, add/remove/
// convert sessions, lighten a whole week if overreaching), not a single-session patch.
// Quantifies the gap(s) directly from adj.note/type/importance/severity - already rich,
// literature-grounded prose computed by plan-adherence.js, not reinvented here.
// ===========================================================================
// The generated path: a plan change that costs nothing and cannot come back broken
// ===========================================================================
//
// Everything below this line replaces a round trip - often a dozen of them - with arithmetic.
// The three automatic rebuilds (injury return, rebalance, ahead-of-schedule push) all describe
// a situation the app has ALREADY measured precisely: how many weeks are affected, what volume
// the runner may carry, how long intensity stays off the table. There was never a question in
// any of them for a language model to answer - only a plan to write out, which is exactly what
// plan-generator.js does, in milliseconds, for free, and by construction within every rule.
//
// The old path is still there for free-text asks the generator's spec cannot express (see
// requestPlanOverride), but nothing automatic goes through it any more.

// Opens the chat, generates, self-checks, and hands the same proposal card every other rebuild
// produces. Deliberately shares finishPlanOverride with the model-written path, so a generated
// plan is validated, diffed, confirmed and reverted through exactly the same machinery - the
// only thing that changed is who wrote the weeks.
async function deliverGeneratedPlan({displayText, spec, prose, opts}){
  toggleChat(true);
  const box = document.getElementById('chatMessages');
  box.insertAdjacentHTML('beforeend', '<div class="msg user">'+escapeHTML(displayText)+'</div>');
  const loadingId = 'plan-override-'+Date.now();
  box.insertAdjacentHTML('beforeend', '<div class="msg assistant" id="'+loadingId+'">Building it...</div>');
  box.scrollTop = box.scrollHeight;
  const fail = msg => { const el = document.getElementById(loadingId); if(el) el.innerText = msg; };
  try{
    state.goalConfig = await loadGoalConfig();
    // A goal-only change has no weeks to build and is a completely legitimate proposal - the
    // session paces are computed live from the goal config, so moving a target genuinely does
    // not need the plan rewritten underneath it.
    const result = spec.weeksOnlyGoalChange ? {weeks: [], rows: []} : generatePlanWeeks(spec);
    if(!result.weeks.length && !spec.goalConfigPatch) return fail('There are no weeks in that range to rebuild.');

    // The same gate the model-written path goes through, run here as a self-check rather than
    // as a negotiation: if the generator has produced something the audit rejects, that is a
    // bug in this app to be reported honestly, not a prompt to be retried at the runner's
    // expense. In practice it does not fire - plan-generator.test.js asserts exactly this
    // property across every rebuild shape - but a silent assumption is not a guarantee.
    const blockStartN = (state.goalConfig||{}).blockStartWeekN;
    const before = auditBlock(state.WEEKS, {blockStartN});
    const after = auditBlock(spliceProposedWeeks(state.WEEKS, result.weeks), {blockStartN});
    const changedLabels = result.weeks.map(w=>'w'+dispN(w.n, blockStartN));
    const problems = introducedFailures(before.failures, after.failures, changedLabels);
    if(problems.length){
      return fail('The generated plan does not pass this app\'s own block audit, so nothing has been changed. This is a bug worth reporting:\n- '+problems.map(p=>p.message).join('\n- '));
    }

    const proposal = {
      weeks: result.weeks,
      methodology: spec.methodology || null,
      methodologyRationale: spec.methodologyRationale || null,
      truncateAfter: null,
      goalConfigPatch: spec.goalConfigPatch || null,
    };
    // `prose` may be a function of the finished plan, so a caller can describe what was built
    // without building it twice just to talk about it.
    let text = typeof prose === 'function' ? prose(result) : prose;
    // An open seam is said out loud. The rebuild is capped at MAX_SCOPE_WEEKS deliberately - it
    // will not rewrite half a year over one injury - so when the gap is genuinely too big to
    // close inside that, the step it leaves behind is a real fact about the plan and belongs in
    // front of the runner, not buried in a warning nobody connects to this change.
    if(result.seamStepPct > MAX_WEEKLY_RAMP * 100 + 0.5){
      const joinDisp = dispFor()(result.weeks[result.weeks.length - 1].n + 1);
      text = (text ? text + '\n\n' : '') +
        'One thing worth saying plainly: even after these weeks, week ' + joinDisp + ' still steps up about ' +
        Math.round(result.seamStepPct) + '% - more than the 10% a week this plan holds itself to. The gap is too big to close inside ' +
        'a rebuild this size, and rewriting months of otherwise sound training to hide it would be the wrong trade. ' +
        'Worth asking for a proper rebuild of the block from there once you are running normally again.';
    }
    await finishPlanOverride(proposal, text, loadingId, opts);
  }catch(e){
    console.error('deliverGeneratedPlan failed', e);
    fail('Could not build the plan change ('+(e.message||'unknown error')+').');
  }
}

// The runner-facing week number, for prose the generator writes.
function dispFor(){
  const cfg = state.goalConfig || defaultGoalConfig();
  return n => blockRelativeWeekN(n, cfg);
}

// What the first week the rebuild touches is currently running - the number the ramp has to
// start from or step down from, rather than a figure chosen in the abstract.
function currentKmAt(n){
  const km = plannedKmAt(state.WEEKS, n);
  return km != null && km > 0 ? km : null;
}

export const REBALANCE_MIN_FACTOR = 0.80;
export const REBALANCE_MAX_FACTOR = 0.95;
export function rebalanceFactor(adjustments){
  const pcts = (adjustments||[]).map(a=>{
    if(a.kind === 'consistentShortfall' && a.avgPct) return a.avgPct / 100;
    if(a.scheduled) return 1 - (a.missed / a.scheduled);
    return null;
  }).filter(v => v != null && isFinite(v));
  if(!pcts.length) return 0.9;
  const worst = Math.min.apply(null, pcts);
  return Math.min(REBALANCE_MAX_FACTOR, Math.max(REBALANCE_MIN_FACTOR, worst));
}

export async function proposeReRampFromAdjustments(){
  const adjustments = (state.missedSessionAdjustments||[]).filter(a=>a.severity==='significant');
  const elId = 'reramp-proposal-combined';
  const el = document.getElementById(elId);
  if(!adjustments.length){
    if(el) el.innerHTML = '<div class="tier-diff-reason" style="color:#ff6b6b;">This suggestion is no longer available.</div>';
    return;
  }
  let readiness = null;
  try{ readiness = await computeReadinessSignal(); }catch(e){}
  const currentWeekN = await findNextUpcomingWeek();
  const blockEndN = Math.max(...state.WEEKS.map(w=>w.n));
  // Answered over the same horizon the deficit was measured over - see coreWeeksForSignal.
  const measured = Math.max.apply(null, adjustments.map(a=>a.windowWeeks||0).concat([0]));
  const core = coreWeeksForSignal(measured);
  // An overreaching readiness read is corroborating evidence for a deeper cut, exactly as the
  // old prompt asked the model to treat it - now applied as a number instead of a suggestion.
  const factor = rebalanceFactor(adjustments) * ((readiness && readiness.status === 'overreaching') ? 0.95 : 1);
  const baseKm = currentKmAt(currentWeekN) || 40;
  const openingKm = Math.round(baseKm * factor * 10) / 10;
  const scope = scopeToJoin({
    weeks: state.WEEKS, fromN: currentWeekN, openingKm, blockEndN,
    minWeeks: core,
  });
  const disp = dispFor();
  const spec = {
    weeks: state.WEEKS,
    fromN: currentWeekN, toN: scope.toN,
    openingKm, joinKm: scope.joinKm,
    goalActive: ((state.goalConfig||{}).activeGoals||[]).some(g=>g.zoneKey==='GOAL'),
    callout: 'Rebalanced around what training has actually been getting done.',
  };
  const gaps = adjustments.map(a => a.kind === 'consistentShortfall'
    ? (adherenceTypeLabel(a.type)+' sessions landing around '+a.avgPct+'% of what was prescribed over '+plural(a.windowWeeks, 'week'))
    : (Math.round(a.missed)+' of '+a.scheduled+' '+adherenceTypeLabel(a.type)+' sessions missed over '+plural(a.windowWeeks, 'week')));
  const readinessLine = (readiness && readiness.status === 'overreaching')
    ? ' The readiness signal reads overreaching on top of that ('+readiness.evidence.join('; ')+'), so the cut is a little deeper than the adherence gap alone would call for.'
    : '';
  const prose = built => 'Rebalancing around what has actually been getting done: '+gaps.join('; ')+'.'+readinessLine+' '+
    'The next weeks are rebuilt at '+Math.round((1-factor)*100)+'% below where the plan had them - '+Math.round(openingKm)+'km instead of '+Math.round(baseKm)+'km - and climb back from there. '+
    describeGeneratedPlan(built.rows, {displayN: disp, joinN: scope.joinN});

  await deliverGeneratedPlan({
    displayText: 'Rebalance the plan for recent missed-session and readiness patterns',
    spec, prose,
    opts: {source: 'rebalance', spanWeeks: scope.toN - currentWeekN + 1},
  });
}

// The return-to-running restructure. Unlike every other propose* function here, this one
// hands the model HARD NUMBERS rather than a situation to interpret: the volume ceiling, the
// long-run ceiling and the quality-hold window are all computed deterministically by
// return-to-run.js from the injury's own duration and severity, and the validator enforces
// them independently (see validatePlanOverride). The model's job is to redistribute the
// remaining block around those limits intelligently - which weeks absorb the lost work, what
// the goal timeline now realistically looks like - not to decide how cautious to be.
export function returnRampProfile(rtr){
  const p = rtr.protocol || {};
  const inj = rtr.injury || {};
  // Where in the ramp the runner already is: still resting means the ramp has not started, so
  // its first week is week 1; already running means it continues from where it got to.
  const startIdx = rtr.phase === 'resting' ? 0 : Math.max(0, (rtr.rampWeek || 1) - 1);
  const pctAt = idx => Math.min(100, (p.firstWeekVolumePct || 50) + (p.weeklyStepPct || 20) * (startIdx + idx));
  const longPctAt = idx => Math.min(100, (p.firstLongRunPct || 50) + (p.weeklyStepPct || 20) * (startIdx + idx));
  const rampLeft = Math.max(1, (p.rampWeeks || 1) - startIdx);
  const preKm = inj.preInjuryWeeklyKm || null;
  const preLongKm = inj.preInjuryLongRunKm || null;
  return {
    startIdx, rampLeft, preKm, preLongKm,
    // Past the end of the ramp the cap simply stops applying - the join weeks exist precisely
    // to climb back into the plan's own progression, and a ramp ceiling that outstays the ramp
    // would make that arithmetically impossible.
    ceilingFor: idx => (preKm && idx < rampLeft) ? Math.round(preKm * pctAt(idx)) / 100 : null,
    longCapFor: idx => (preLongKm && idx < rampLeft) ? Math.round(preLongKm * longPctAt(idx)) / 100 : null,
    openingKm: preKm ? Math.round(preKm * pctAt(0)) / 100 : null,
  };
}

// The date running may resume from - the single fact the whole rebuild is shaped around.
//
// There used to be two mechanisms answering this: a count of whole rest WEEKS here, and the
// generator's own per-DAY reading of the return date. They disagreed the moment they were both
// used - "I can run today", answered on a Sunday, produced a rebuild whose first week was
// rest, because the week-counter was measuring from a week the day-reader had already skipped.
// Two functions answering one question is how this app has drifted before, so there is now
// one: this returns a date, the generator resolves everything from it, and nothing counts
// weeks.
//
// With no date on record the runner has told us only that they are not running now, and this
// app has already decided what that honestly covers - REST_WINDOW_WITHOUT_DATE_DAYS, the same
// window the card's "take these off the calendar" offer uses. The two agree by construction
// rather than by coincidence.
export function runFromDateFor(rtr, todayYMD){
  const today = todayYMD || dateToYMD(new Date());
  if(!rtr || rtr.phase !== 'resting') return today;
  const stated = rtr.injury && rtr.injury.expectedReturnDate;
  if(stated) return stated > today ? stated : today;
  const d = new Date(today+'T00:00:00');
  d.setDate(d.getDate() + REST_WINDOW_WITHOUT_DATE_DAYS);
  return dateToYMD(d);
}

export async function proposeReturnToRunPlan(){
  const elId = 'rtr-proposal-combined';
  const el = document.getElementById(elId);
  // Re-fetched fresh rather than trusting whatever the banner was rendered from - same
  // "don't trust a stale closure" rule as every other propose* function here.
  const rtr = await getActiveReturnToRun();
  if(!rtr || !rtr.caps){
    if(el) el.innerHTML = '<div class="tier-diff-reason" style="color:#ff6b6b;">No active injury return - nothing to adjust.</div>';
    return;
  }
  const blockEndN = Math.max(...state.WEEKS.map(w=>w.n));
  const todayYMD = dateToYMD(new Date());
  // Not "the current week" - the first week with a training day that has not already happened.
  // Run on a Sunday, "the current week" is four sessions that are all in the past, and a
  // rebuild starting there writes a plan for days that are gone.
  const currentWeekN = firstRebuildableWeekN(state.WEEKS, await findNextUpcomingWeek(), todayYMD) ?? blockEndN;
  const profile = returnRampProfile(rtr);
  // One date, and everything else follows from it - see runFromDateFor. Whole weeks before it
  // become rest weeks and individual days before it become open days, both worked out per day
  // by the generator rather than counted here.
  const runFromYMD = runFromDateFor(rtr, todayYMD);
  const restWeeks = restWeeksBefore(state.WEEKS, currentWeekN, runFromYMD);
  // No pre-injury baseline on record means there is no percentage to ramp from. Half of what
  // the plan already had that week is a deliberately cautious stand-in, and the note says so
  // rather than presenting a guess as a computed figure.
  const openingKm = profile.openingKm || Math.round((currentKmAt(currentWeekN + restWeeks) || 30) * 0.5);
  // The scope is the weeks the injury actually touches plus however many the arithmetic needs
  // to climb back - computed, not chosen. A three-week problem never rewrites the year.
  const scope = scopeToJoin({
    weeks: state.WEEKS, fromN: currentWeekN, openingKm, restWeeks, blockEndN,
    ceilingFor: profile.ceilingFor,
  });
  const holdWeeks = rtr.phase === 'resting' ? (rtr.protocol.qualityHoldWeeks || 0) : (rtr.caps.qualityHoldWeeksRemaining || 0);
  const where = rtr.injury.bodyPart || 'the injury';
  const disp = dispFor();
  const spanWeeks = scope.toN - currentWeekN + 1;

  const spec = {
    weeks: state.WEEKS,
    fromN: currentWeekN, toN: scope.toN,
    openingKm, joinKm: scope.joinKm,
    peakKm: profile.ceilingFor,
    longCapKm: profile.longCapFor,
    restWeeks, qualityHoldWeeks: holdWeeks,
    todayYMD, runFromYMD,
    goalActive: ((state.goalConfig||{}).activeGoals||[]).some(g=>g.zoneKey==='GOAL'),
    restNote: 'No running - '+where+' is still resting.',
    callout: 'Rebuilt around '+where+'. Volume comes back before intensity does.',
  };

  const rampText = profile.preKm
    ? ('Volume opens at '+Math.round(openingKm)+'km - '+Math.round(openingKm/profile.preKm*100)+'% of the '+profile.preKm+'km week you were running before - and climbs from there.')
    : ('There is no pre-injury weekly volume on record, so this opens deliberately low at '+Math.round(openingKm)+'km and climbs from there.');
  const prose = built => 'Returning from '+where+' ('+rtr.injury.severity+', '+rtr.daysOut+' days out). '+rampText+' '+
    describeGeneratedPlan(built.rows, {displayN: disp, holdWeeks, joinN: scope.joinN}) +
    '\n\nThe goal itself is not changed here - this rebuilds the weeks the injury touches and hands them back to the plan you already have. If the time you have lost genuinely puts the target out of reach, the trajectory gauge will say so on its own evidence rather than this guessing at it now.';

  await deliverGeneratedPlan({
    displayText: 'Ease back into the plan after '+where+' ('+spanWeeks+' weeks)',
    spec, prose,
    opts: {source: 'injury-return', spanWeeks},
  });
}

// Mirror image of buildRebalanceRequestText - quantifies each ahead-of-schedule signal
// (goal-trajectory.js's evaluateAheadOfSchedule) and explicitly invites the coach to
// INCREASE load, not just restructure it. Ends with an explicit permission-to-decline
// paragraph - the prompt-level twin of the deliberate validator asymmetry (see the doc
// comment on validatePlanOverride): a push declining to act is a legitimate answer, so the
// model shouldn't feel pressure to manufacture a change just because this request exists.
export const PUSH_OPENING_FACTOR = 1.05;
export const PUSH_PEAK_FACTOR = 1.15;

export async function proposePushFromAheadSignal(){
  const signals = state.aheadOfScheduleSignals||[];
  const elId = 'push-proposal-combined';
  const el = document.getElementById(elId);
  if(!signals.length){
    if(el) el.innerHTML = '<div class="tier-diff-reason" style="color:#ff6b6b;">This suggestion is no longer available.</div>';
    return;
  }
  let readiness = null;
  try{ readiness = await computeReadinessSignal(); }catch(e){}
  const currentWeekN = await findNextUpcomingWeek();
  const blockEndN = Math.max(...state.WEEKS.map(w=>w.n));
  // A push is acted on over the horizon its own trend evidence actually covers.
  const trendWeeks = Math.max.apply(null, signals.map(s2=>(s2.trend && s2.trend.spanDays) ? s2.trend.spanDays/7 : 0).concat([0]));
  const core = coreWeeksForSignal(trendWeeks);
  const baseKm = currentKmAt(currentWeekN) || 40;
  const openingKm = Math.round(baseKm * PUSH_OPENING_FACTOR * 10) / 10;
  // The ceiling is set against the biggest week the plan itself already asks for in this
  // stretch - a push adds to what the block was going to do, it does not invent a volume out
  // of nowhere.
  const plannedPeak = Math.max.apply(null, [baseKm].concat(
    new Array(core).fill(0).map((_, i) => currentKmAt(currentWeekN + i) || 0)));
  const peakKm = Math.round(plannedPeak * PUSH_PEAK_FACTOR * 10) / 10;
  const scope = scopeToJoin({
    weeks: state.WEEKS, fromN: currentWeekN, openingKm, blockEndN,
    minWeeks: core, ceilingFor: () => peakKm,
  });
  const disp = dispFor();
  const spec = {
    weeks: state.WEEKS,
    fromN: currentWeekN, toN: scope.toN,
    openingKm, joinKm: scope.joinKm, peakKm,
    // The surplus is absorbed inside the existing four-day week, as a second quality session
    // rather than a fifth running day - the same instruction the old prompt gave, now a fact
    // about how the weeks are built.
    qualityPerWeek: 2,
    goalActive: ((state.goalConfig||{}).activeGoals||[]).some(g=>g.zoneKey==='GOAL'),
    callout: 'Pushed - fitness is running ahead of what the current target needs.',
  };
  const lines = signals.map(sig => sig.goalLabel + ' is ' +
    (sig.aheadBehindSec != null ? (Math.abs(Math.round(sig.aheadBehindSec))+'s/km ahead of where the timeline expects it') : 'ahead of the timeline') +
    (sig.trend ? (', improving '+Math.abs(sig.trend.rateSecPerWeek).toFixed(1)+'s/km a week over '+sig.trend.spanDays+' days') : ''));
  const prose = built => 'Fitness is genuinely ahead of what the current target needs: '+lines.join('; ')+'. '+
    'These weeks take that up: volume opens at '+Math.round(openingKm)+'km instead of '+Math.round(baseKm)+'km and climbs toward '+Math.round(peakKm)+'km, '+
    'and every build week now carries two quality sessions rather than one - inside the same four training days, not a fifth. '+
    describeGeneratedPlan(built.rows, {displayN: disp, joinN: scope.joinN})+
    '\n\nThe goal time itself is left alone. Training harder is the thing that closes a gap; relabelling the target is not, and if the trend keeps running this far ahead the trajectory gauge will make the case for a faster goal on its own evidence.';

  await deliverGeneratedPlan({
    displayText: 'Push the plan harder - fitness is ahead of the current target',
    spec, prose,
    opts: {source: 'push', spanWeeks: scope.toN - currentWeekN + 1},
  });
}

// Backs the "Review a realistic goal update" button on the deterministic post-workout
// achievability watchdog message (goal-trajectory.js's computeAchievabilityWarnings,
// rendered by chat.js's autoCoachMessage) - re-fetches the baseline fresh rather than
// trusting anything cached in the warning object the button was rendered from, same
// "don't trust a stale closure" reasoning as every other propose* function here.
export function buildAchievabilityFixRequestText(warning, currentWeekN, blockEndN){
  const realisticTxt = warning.realisticTimeLabel ? ('roughly '+warning.realisticTimeLabel)
    : 'a more realistic time based on current fitness (not enough data yet for a precise figure - use your best judgment from the numbers above)';
  return 'Automatic goal-achievability check requested. The deterministic pace-trend baseline for '+warning.goalLabel+' ('+warning.currentGoalTimeLabel+') currently reads as unreachable, not just tight:\n'+
    '- '+warning.reasonText.trim()+
    '\n\nA realistic target based on current fitness is '+realisticTxt+'.'+
    '\n\nPropose a specific, concrete "goalConfigPatch" moving this goal to a genuinely more achievable target, anchored on the realistic figure above rather than invented - only touch weekly structure if a genuine restructure (not a target change) is actually the right call instead. If, having reviewed the real situation, you conclude the current target is still the right one to keep chasing despite this reading, say so plainly and explain why - declining to change the goal is a legitimate answer here too.';
}

export async function proposeAchievabilityFix(zoneKey){
  const goalConfig = state.goalConfig || defaultGoalConfig();
  const goal = (goalConfig.activeGoals||[]).find(g=>g.zoneKey===zoneKey);
  if(!goal) return;
  const baseline = zoneKey==='RACE10K' ? await compute10KTrajectoryBaseline(goal)
    : await computeHMTrajectoryBaseline(goal, (goalConfig.activeGoals||[]).find(g=>g.zoneKey==='RACE10K'));
  let realisticTimeLabel = null;
  try{
    const best = await getBestAvailableLTPace();
    if(best.ltPaceSec!=null){
      const projectedSec = projectedTimeFromLTPace(best.ltPaceSec, goal.distanceKm||(zoneKey==='RACE10K'?10:21.0975));
      realisticTimeLabel = formatMinutesToClock(projectedSec/60);
    }
  }catch(e){}
  const warning = {
    goalLabel: goal.label||(zoneKey==='RACE10K'?'10K':'the goal'), currentGoalTimeLabel: goal.goalTimeLabel||'',
    reasonText: formatAchievabilityNote(baseline.achievability), realisticTimeLabel,
  };
  const currentWeekN = await findNextUpcomingWeek();
  const blockEndN = Math.max(...state.WEEKS.map(w=>w.n));
  const requestText = buildAchievabilityFixRequestText(warning, currentWeekN, blockEndN);
  await requestPlanOverride(requestText, {displayText:'Review a realistic goal update'});
}

// Backs the "Review a durability-focused plan change" button on the deterministic
// post-workout durability watchdog message (goal-trajectory.js's computeDurabilityWarnings,
// rendered by chat.js's autoCoachMessage) - same "re-fetch fresh, don't trust a stale
// closure" reasoning as proposeAchievabilityFix above. Unlike an achievability fix (which
// asks for a different GOAL), this asks for a different PLAN CONTENT - more long-run
// volume at or near goal pace, more back-to-back fatigue work, extending long-run duration -
// since durability is trained, not adjusted around, the way a genuinely unreachable time
// target is.
export function buildDurabilityFixRequestText(warning, currentWeekN, blockEndN){
  const gapTxt = (warning.pureTimeLabel && warning.adjustedTimeLabel && warning.pureTimeLabel!==warning.adjustedTimeLabel)
    ? ('Pace alone projects roughly '+warning.pureTimeLabel+', but accounting for the observed fade a more realistic estimate is roughly '+warning.adjustedTimeLabel+'.')
    : '';
  return 'Automatic durability check requested. The tracked aerobic-decoupling/cadence-fade read for '+warning.goalLabel+' ('+warning.currentGoalTimeLabel+') currently shows a genuine durability limiter, not just a pace gap:\n'+
    '- '+warning.reasonText.trim()+
    '\n\n'+gapTxt+
    '\n\nThis is a "stiff legs / loss of power over distance" pattern, not a fitness-ceiling problem - the fix is training content that specifically builds fatigue resistance (more time at or near goal pace within long runs, back-to-back moderate-effort days, progressively longer long-run duration), not lowering the goal. Review weeks '+currentWeekN+'-'+blockEndN+' and propose concrete changes that build durability specifically, explaining what would change and why. If nothing in the remaining plan actually needs to change (already well-covered), say so plainly instead of forcing a change.';
}

export async function proposeDurabilityFix(zoneKey){
  const goalConfig = state.goalConfig || defaultGoalConfig();
  const goal = (goalConfig.activeGoals||[]).find(g=>g.zoneKey===zoneKey);
  if(!goal) return;
  const durability = await getDurabilitySignal();
  let pureTimeLabel = null, adjustedTimeLabel = null;
  try{
    const best = await getBestAvailableLTPace();
    if(best.ltPaceSec!=null){
      const pureProjectedSec = projectedTimeFromLTPace(best.ltPaceSec, goal.distanceKm||(zoneKey==='RACE10K'?10:21.0975));
      const adjustedProjectedSec = computeDurabilityAdjustedProjectionSec(pureProjectedSec, durability, goal.distanceKm||(zoneKey==='RACE10K'?10:21.0975));
      pureTimeLabel = formatMinutesToClock(pureProjectedSec/60);
      if(adjustedProjectedSec!=null) adjustedTimeLabel = formatMinutesToClock(adjustedProjectedSec/60);
    }
  }catch(e){}
  const warning = {
    goalLabel: goal.label||(zoneKey==='RACE10K'?'10K':'the goal'), currentGoalTimeLabel: goal.goalTimeLabel||'',
    reasonText: formatDurabilityNote(durability), pureTimeLabel, adjustedTimeLabel,
  };
  const currentWeekN = await findNextUpcomingWeek();
  const blockEndN = Math.max(...state.WEEKS.map(w=>w.n));
  const requestText = buildDurabilityFixRequestText(warning, currentWeekN, blockEndN);
  await requestPlanOverride(requestText, {displayText:'Review a durability-focused plan change'});
}

// Backs the "Review a load-reduction plan change" button on the deterministic post-workout
// injury-risk watchdog message (coach/injury-tracking.js's computeInjuryRiskWarnings,
// rendered by chat.js's autoCoachMessage) - not per-goal like achievability/durability,
// since injury risk isn't tied to a specific race target, so this asks broadly for reduced
// load across whatever weeks are coming up rather than naming a zone.
export async function proposeInjuryRiskFix(){
  const risk = await checkCurrentInjuryRiskPattern();
  if(!risk) return;
  const currentWeekN = await findNextUpcomingWeek();
  const blockEndN = Math.max(...state.WEEKS.map(w=>w.n));
  const requestText = 'Automatic injury-risk check requested. '+risk.note+
    '\n\nThis is real, evidence-based pattern matching from this runner\'s own logged history, not a guess - treat it seriously. Review weeks '+currentWeekN+'-'+blockEndN+' and propose a genuine reduction in training load (fewer or shorter quality sessions, more easy volume, an extra recovery day) for the immediate near-term specifically to bring the acute:chronic ratio back down, then explain what would change and why. If the upcoming plan already has enough of a lighter stretch built in to address this on its own, say so plainly instead of forcing a change.';
  await requestPlanOverride(requestText, {displayText:'Review a load-reduction plan change'});
}

export async function revertPlanOverride(){
  try{
    let history = [];
    try{ const hr = await window.storage.get('plan-override-history', false); if(hr) history = JSON.parse(hr.value); }catch(e){}
    if(!history.length){
      await window.storage.delete('plan-override', false);
    } else {
      const entry = history.shift();
      // Defensive: an older history entry saved before goalConfig snapshotting was added
      // is just the bare plan-override object, not {planOverride, goalConfig}.
      const restoredPlanOverride = entry.planOverride!==undefined ? entry.planOverride : entry;
      const restoredGoalConfig = entry.goalConfig!==undefined ? entry.goalConfig : null;
      await saveWithRetry('plan-override', restoredPlanOverride, false);
      await sleep(150);
      await saveWithRetry('plan-override-history', history, false);
      if(restoredGoalConfig){
        await sleep(150);
        await saveGoalConfig(restoredGoalConfig);
        state.goalConfig = restoredGoalConfig;
      }
      // Undo any goal-history entries the apply being reverted added - defensive fallback
      // for a history entry saved before this field existed (entry.goalHistoryLengthBefore
      // undefined), same style as the entry.goalConfig fallback above.
      if(entry.goalHistoryLengthBefore!=null){
        await sleep(150);
        try{ await truncateGoalHistory(entry.goalHistoryLengthBefore); }catch(e){ console.error('truncateGoalHistory failed', e); }
      }
    }
    // Same ordering requirement as applyPlanOverride above - Z before buildWeeks().
    { const r = await recomputeZones(state.profile, state.goalConfig); state.Z = r.Z; state.layoffAdjustment = r.layoffAdjustment; state.paceSource = r.paceSource; }
    state.WEEKS = await applyPlanOverrides(buildWeeks());
    await refreshAdherenceState();
    renderPageHeader();
    renderNav();
    renderCurrentWeek();
  }catch(e){
    console.error('revertPlanOverride failed', e);
    notifyError('Could not undo the most recent plan change - try again.');
  }
}

window.applyPlanOverride = applyPlanOverride;
window.proposeSwapFromSuggestion = proposeSwapFromSuggestion;
window.proposeReRampFromAdjustments = proposeReRampFromAdjustments;
window.proposePushFromAheadSignal = proposePushFromAheadSignal;
window.proposeAchievabilityFix = proposeAchievabilityFix;
window.proposeDurabilityFix = proposeDurabilityFix;
window.proposeInjuryRiskFix = proposeInjuryRiskFix;
window.proposeReturnToRunPlan = proposeReturnToRunPlan;
window.dismissPlanOverrideNotice = dismissPlanOverrideNotice;
window.editPlanOverride = editPlanOverride;
window.revertPlanOverride = revertPlanOverride;
window.promptGoalChangeConfirmation = promptGoalChangeConfirmation;

export async function submitPlanOverrideRequest(){
  const input = document.getElementById('planOverrideInput');
  const text = input.value.trim();
  if(!text) return;
  const priorUid = input.dataset.priorPlanOverrideUid;
  const opts = priorUid && state.pendingPlanOverride[priorUid] ? {priorProposal: state.pendingPlanOverride[priorUid]} : {};
  delete input.dataset.priorPlanOverrideUid;
  input.value = '';
  input.placeholder = 'e.g. Add a second threshold day starting week 3, or draft a winter maintenance block once racing is done';
  toggleGlobalPlanOverrideModal(false);
  await requestPlanOverride(text, opts);
}

export function toggleGlobalPlanOverrideModal(open, prefillText){
  document.getElementById('planOverrideModal').classList.toggle('open', open);
  document.getElementById('overlay').classList.toggle('open', open);
  if(open){
    const input = document.getElementById('planOverrideInput');
    input.value = prefillText || '';
    input.focus();
  }
}

window.toggleGlobalPlanOverrideModal = toggleGlobalPlanOverrideModal;
window.submitPlanOverrideRequest = submitPlanOverrideRequest;
