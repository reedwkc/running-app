// @ts-nocheck
// Archive of goals removed or materially changed by a plan-override goalConfigPatch, kept
// purely for reference (see goal-config.js for the live goalConfig this snapshots FROM).
// Append-only from the runner's point of view; truncateGoalHistory exists only so a plan
// revert can undo the archive entries an apply just added, mirroring how revertPlanOverride
// already undoes the goalConfig/plan-override changes an apply made.
import { readJsonArray } from '../lib/data-store.js';
import { saveWithRetry } from '../lib/storage.js';

export async function loadGoalHistory(){
  const read = await readJsonArray('goal-history');
  return read.ok ? read.value : [];
}

// result is optional - {actualDist, actualDurSec, actualTimeLabel} when the goal's race
// already happened and has a logged result, null otherwise. Returns false (and leaves
// storage untouched) if the existing history can't be safely read, so a caller in the
// middle of a bigger apply knows not to treat this as having silently succeeded.
export async function archiveGoal(goal, reason, result){
  const read = await readJsonArray('goal-history');
  if(!read.ok) return false;
  const entry = Object.assign({}, goal, {archivedAt: new Date().toISOString(), reason: reason||'removed', result: result||null});
  await saveWithRetry('goal-history', read.value.concat([entry]), false);
  return true;
}

export async function truncateGoalHistory(len){
  if(len==null) return;
  const read = await readJsonArray('goal-history');
  if(!read.ok) return;
  if(read.value.length<=len) return;
  await saveWithRetry('goal-history', read.value.slice(0, len), false);
}

// True when an existing goal's actual target (not just incidental metadata like label/
// raceName wording) has genuinely changed - the old value is worth keeping for reference,
// not just silently overwritten.
export function goalChangedMaterially(before, after){
  if(!before || !after) return false;
  return before.goalTimeSec !== after.goalTimeSec
    || before.raceDate !== after.raceDate
    || before.distanceKm !== after.distanceKm;
}

// Pure diff: which of the CURRENT goals a new activeGoals array (from a goalConfigPatch)
// would remove or materially change, matched by the stable goalId. Doesn't decide
// 'completed' vs 'removed' for a dropped goal - that needs to know whether its race date
// has already passed and whether a result was logged, which lives outside goalConfig/
// goal-history (plan.js's WEEKS + workout logs) and is the caller's job.
export function planGoalArchival(oldGoals, newGoals){
  const newById = {};
  (newGoals||[]).forEach(g=>{ if(g && g.goalId) newById[g.goalId] = g; });
  const toArchive = [];
  (oldGoals||[]).forEach(oldGoal=>{
    if(!oldGoal || !oldGoal.goalId) return;
    const match = newById[oldGoal.goalId];
    if(!match){ toArchive.push({goal: oldGoal, reason: 'removed'}); return; }
    if(goalChangedMaterially(oldGoal, match)) toArchive.push({goal: oldGoal, reason: 'superseded', supersededBy: match});
  });
  return toArchive;
}
