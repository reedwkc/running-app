// @ts-nocheck
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
