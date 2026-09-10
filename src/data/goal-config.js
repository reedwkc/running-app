// @ts-nocheck
import { dateToYMD } from '../lib/dates.js';
import { saveWithRetry } from '../lib/storage.js';

// Reproduces today's implicit, hardcoded goals exactly - the fallback used until a plan
// override ever writes a real 'goal-config', so nothing changes for the current HM/10K
// block. zoneKey ties a goal to the matching computeZones() slot (GOAL/RACE10K); goalId
// ties it to the matching race day in plan.js (see the goalId fields added there).
export function defaultGoalConfig(){
  return {
    version: 1,
    phase: 'race-build',
    activeGoals: [
      {
        goalId: 'hm-sub135', type: 'HM', zoneKey: 'GOAL', label: 'Half Marathon',
        raceName: 'Lierlopet Halvmaraton', distanceKm: 21.0975, raceDate: '2026-09-27',
        goalTimeSec: 5700, goalTimeLabel: 'Sub-1:35:00', goalPaceSec: 269, goalPaceLabel: '4:29/km',
        goalHR: '168-172',
      },
      {
        goalId: '10k-lierlopet', type: '10K', zoneKey: 'RACE10K', label: '10K',
        raceName: 'Lierlopet', distanceKm: 10, raceDate: '2026-08-30',
        goalTimeSec: 2580, goalTimeLabel: 'Sub-43:00', goalPaceSec: 258, goalPaceLabel: '4:18/km',
        goalHR: '175-185',
      },
    ],
  };
}

export async function loadGoalConfig(){
  try{
    const r = await window.storage.get('goal-config', false);
    if(r) return JSON.parse(r.value);
  }catch(e){ console.error('loadGoalConfig failed, using default', e); }
  return defaultGoalConfig();
}

export async function saveGoalConfig(cfg){
  await saveWithRetry('goal-config', cfg, false);
}

// Every caller that resets blockStartedAt (a materially different active-goal set - see
// plan-override.js's applyPlanOverride and ui/modals.js's New/Delete Goal handlers) also
// stamps blockStartWeekN here, at the SAME moment, to the next week number that hasn't been
// used yet (max existing week + 1). The internal week.n stays a single continuous, stable
// sequence forever - every logged workout is keyed off it (workoutKey(weekN, tag)), and
// renumbering those on every new goal would corrupt history - but the runner asked, reasonably,
// why a brand new training block doesn't visibly start at "Week 1" the way a fresh block
// obviously should. blockRelativeWeekN below answers that for DISPLAY ONLY: it's what the nav
// tabs and week header show, while every internal reference (routing, storage keys, adherence
// windows, the coach's own prompts) keeps using the real w.n untouched.
export function stampNewBlock(cfg, weeks){
  const maxN = Math.max(0, ...(weeks||[]).map(w=>w.n));
  cfg.blockStartedAt = new Date().toISOString();
  cfg.blockStartWeekN = maxN+1;
  return cfg;
}

// Maps a real, stable week.n to the number that should actually be DISPLAYED to the runner -
// 1 for the first week of the current block, counting up from there. Falls back to the raw
// n itself (today's original single-block behavior, unchanged) when no block start has ever
// been stamped, so an app that's never had a goal change renders exactly as it always has.
export function blockRelativeWeekN(n, goalConfig){
  const startN = goalConfig && goalConfig.blockStartWeekN;
  return (startN!=null && n>=startN) ? (n-startN+1) : n;
}

// Locates a goal's actual race day in the (possibly overridden) plan - by goalId first
// (the reliable path once plan.js/a plan override tags its race days), falling back to
// closest-distance match for any hand-edited plan that never got tagged.
export function findGoalRaceDay(weeks, goal){
  if(!goal) return null;
  for(const week of (weeks||[])){
    for(const day of (week.days||[])){
      if(day.type!=='race') continue;
      if(goal.goalId && day.goalId===goal.goalId) return {week, day};
    }
  }
  // The distance-fallback is only for a hand-edited race day that was never tagged with any
  // goalId at all - it must NOT match a day already tagged for a DIFFERENT goal. Without
  // !day.goalId here, a brand new goal at the same common distance (e.g. another half
  // marathon) silently matched an already-completed OLD goal's own race day purely by
  // distance, showing that old result - a real logged 1:42:36 - as if it were this new,
  // not-yet-run goal's outcome. Caught live: a fresh "sub-1:30 in a year" goal immediately
  // showed "complete, missed goal by 12:36" against a race that happened for a different goal.
  if(goal.distanceKm!=null){
    for(const week of (weeks||[])){
      for(const day of (week.days||[])){
        if(day.type==='race' && !day.goalId && day.data && Math.abs((day.data.km||0)-goal.distanceKm)<0.5) return {week, day};
      }
    }
  }
  return null;
}

// The one place that decides which goal currently occupies the two PACE-PRESCRIPTION slots
// (zoneKey 'GOAL'/'RACE10K') that computeZones()/goalZonesFromConfig actually know how to
// read - plan.js is a static template whose day definitions only ever reference these two
// zone keys, so however many goals are being TRACKED (activeGoals can now hold any number),
// only the nearest two by race date actively drive session pace targets at any moment. Not
// a user choice - purely a function of race dates, recomputed by every caller that mutates
// activeGoals (see applyGoalConfigChange in ui/modals.js) so it can never drift out of sync
// with what's actually nearest. A goal whose race date has already passed is excluded from
// ranking entirely (it should be archived, not still occupying a slot) but is otherwise left
// in the list untouched - callers own removing it. Goals beyond the nearest two keep
// whatever other fields they have but get zoneKey:null - tracked (a card, a trajectory
// reading once genericized) but not yet feeding any prescribed session's pace, until an
// earlier goal completes/is removed and promotes them up.
export function reassignGoalZoneKeys(activeGoals){
  const list = (activeGoals||[]).slice();
  const todayStr = dateToYMD(new Date());
  const upcoming = list.filter(g=>g.raceDate && g.raceDate>=todayStr).sort((a,b)=> a.raceDate.localeCompare(b.raceDate));
  const nearestId = upcoming[0] && upcoming[0].goalId;
  const secondId = upcoming[1] && upcoming[1].goalId;
  return list.map(g=>{
    const zoneKey = g.goalId===nearestId ? 'GOAL' : g.goalId===secondId ? 'RACE10K' : null;
    return zoneKey===g.zoneKey ? g : Object.assign({}, g, {zoneKey});
  });
}

// Builds the GOAL/RACE10K zone entries computeZones() needs from whichever goals are
// currently active. An empty slot (maintenance phase, no matching goal) gets a synthetic,
// profile-derived fallback pace so a stray zone:'GOAL'/'RACE10K' reference in an old or
// hand-edited day can't crash the app - validatePlanOverride flags synthetic usage as a
// real warning rather than silently treating it as meaningful.
export function goalZonesFromConfig(goalConfig, profile){
  const cfg = goalConfig || defaultGoalConfig();
  const goalSlot = (cfg.activeGoals||[]).find(g=>g.zoneKey==='GOAL');
  const race10kSlot = (cfg.activeGoals||[]).find(g=>g.zoneKey==='RACE10K');
  const lt = profile ? profile.ltPaceSec : null;
  const lthr = profile ? profile.lthr : null;
  return {
    // derivedHR is only present when the band was actually derived - an explicit goalHR
    // keeps the zone object exactly the shape it has always had.
    GOAL: goalSlot
      ? (hasRealHRBand(goalSlot.goalHR) ? {hr: goalSlot.goalHR, pace: goalSlot.goalPaceSec}
                                        : {hr: derivedGoalHR(lthr, GOAL_HR_LTHR_BAND), pace: goalSlot.goalPaceSec, derivedHR:true})
      : {hr: derivedGoalHR(lthr, GOAL_HR_LTHR_BAND), pace: lt!=null ? Math.round(lt*1.05) : 0, synthetic:true, derivedHR:true},
    RACE10K: race10kSlot
      ? (hasRealHRBand(race10kSlot.goalHR) ? {hr: race10kSlot.goalHR, pace: race10kSlot.goalPaceSec}
                                           : {hr: derivedGoalHR(lthr, RACE10K_HR_LTHR_BAND), pace: race10kSlot.goalPaceSec, derivedHR:true})
      : {hr: derivedGoalHR(lthr, RACE10K_HR_LTHR_BAND), pace: lt!=null ? Math.round(lt*1.02) : 0, synthetic:true, derivedHR:true},
  };
}

// A goal created without an explicit target HR used to leave its zone's band as the literal
// string 'n/a', which then rendered as "n/abpm" on every goal-pace session card and on every
// goal-pace segment of every long run - across a race-specific phase that is mostly exactly
// those sessions. Worse, on a treadmill the card's own primary-target line says HR is the
// real target whatever the session type, so it was pointing at a number that did not exist.
//
// Derived from LTHR instead, which is the anchor every other zone in this app already uses.
// Half-marathon race effort sits around threshold - a little under it early, a little over
// it late - so the band spans LTHR rather than sitting below it; a 10K runs higher still.
// Marked derivedHR so a caller can say where the number came from. An explicit goalHR on the
// goal always wins, and with no LTHR on file at all there is genuinely nothing to derive
// from, so it stays 'n/a' and the renderers below simply omit the HR fragment.
// A goal saved without a target HR does not store an empty field - it stores the literal
// string 'n/a' (see commitGoalEdit / the New Goal form), which is perfectly truthy. Checking
// only for a missing value therefore never fired on the case that actually occurs in real
// saved data, which is exactly how the live sub-1:30 goal ended up rendering "n/abpm".
function hasRealHRBand(v){
  return typeof v === 'string' && v.trim() !== '' && v.trim().toLowerCase() !== 'n/a';
}

const GOAL_HR_LTHR_BAND = [0.95, 1.02];
const RACE10K_HR_LTHR_BAND = [1.00, 1.06];
function derivedGoalHR(lthr, band){
  if(!lthr) return 'n/a';
  return Math.round(lthr*band[0])+'-'+Math.round(lthr*band[1]);
}
