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
  if(goal.distanceKm!=null){
    for(const week of (weeks||[])){
      for(const day of (week.days||[])){
        if(day.type==='race' && day.data && Math.abs((day.data.km||0)-goal.distanceKm)<0.5) return {week, day};
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
  return {
    GOAL: goalSlot
      ? {hr: goalSlot.goalHR||'n/a', pace: goalSlot.goalPaceSec}
      : {hr:'n/a', pace: lt!=null ? Math.round(lt*1.05) : 0, synthetic:true},
    RACE10K: race10kSlot
      ? {hr: race10kSlot.goalHR||'n/a', pace: race10kSlot.goalPaceSec}
      : {hr:'n/a', pace: lt!=null ? Math.round(lt*1.02) : 0, synthetic:true},
  };
}
