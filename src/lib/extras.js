// @ts-nocheck
// "Extra workouts" - anything logged on a day WITHOUT replacing that day's own
// planned-session outcome record (workoutKey in keys.js). Deliberately a separate, flat,
// id-deduped array (same append-only pattern trimp-history/goal-history already use) so
// every existing consumer of the single-object-per-day model (plan-adherence.js's scan,
// chat.js's plan summary, kpi-view.js's weekly mileage, progression.js, goal-trajectory.js,
// plan-override.js's validation - 13+ call sites, all confirmed to assume one object per
// workoutKey) needs zero changes to keep working exactly as before. Extras are additive:
// logging one never touches workout-w{N}-{tag}, so it can never silently overwrite
// whatever a day's own planned-session slot already holds - see saveFreeWorkout in
// modals.js for the one exception (a genuine swap still writes into the day's own slot,
// since that's an intentional 1:1 replacement, not an addition).
import { parseDayTagDate, parseWeekEndDate } from './dates.js';
import { readJsonArray } from './data-store.js';
import { saveWithRetry } from './storage.js';

const STORAGE_KEY = 'extra-workouts';

function newExtraId(){ return 'extra-'+Date.now()+'-'+Math.random().toString(36).slice(2,8); }

export async function loadAllExtraWorkouts(){
  const read = await readJsonArray(STORAGE_KEY);
  return read.ok ? read.value : [];
}

// Same date-range-filter approach loadFreeWorkoutsForPlanWeek (week-view.js) already uses
// for the old freeform-on-workoutKey entries - a plain calendar-date window over the
// week's own first/last day, not a stored weekN match (a retry logged out-of-week-order,
// or a date near a boundary, should still land on the week whose dates actually contain it).
export async function loadExtraWorkoutsForWeek(w, allExtras){
  if(!w || !w.days.length) return [];
  const start = parseDayTagDate(w.days[0].tag);
  const end = parseWeekEndDate(w);
  if(!start || !end) return [];
  const startStr = start.toISOString().slice(0,10);
  const endStr = end.toISOString().slice(0,10);
  const all = allExtras || await loadAllExtraWorkouts();
  return all.filter(e => e.date >= startStr && e.date <= endStr);
}

export function extraWorkoutsForDay(allExtras, dayTag){
  return (allExtras||[]).filter(e => e.dayTag===dayTag);
}

// entry: {date, dayTag, weekN, activityType, name, actualDist, actualDur, avgHR, rpe,
// conditions, notes, stravaImport, completedAt, retryOfTag}. Pass entry.id to edit an
// existing extra in place instead of creating a new one.
export async function saveExtraWorkout(entry){
  const read = await readJsonArray(STORAGE_KEY);
  if(!read.ok) return {ok:false, id:null};
  const id = entry.id || newExtraId();
  const obj = Object.assign({}, entry, {id});
  const arr = read.value.filter(e=>e.id!==id).concat([obj]);
  await saveWithRetry(STORAGE_KEY, arr, false);
  return {ok:true, id};
}

export async function deleteExtraWorkout(id){
  const read = await readJsonArray(STORAGE_KEY);
  if(!read.ok) return false;
  await saveWithRetry(STORAGE_KEY, read.value.filter(e=>e.id!==id), false);
  return true;
}
