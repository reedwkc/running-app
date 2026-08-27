// @ts-nocheck
import { state } from './state.js';
import { loadLatestVerdict } from './coach/chat.js';
import { recomputeZones } from './coach/goal-trajectory.js';
import { getHardSessionProximityFlags, getLikelySwapSuggestions, getMissedSessionAdjustments } from './coach/plan-adherence.js';
import { loadGoalConfig } from './data/goal-config.js';
import { applyPlanOverrides, buildWeeks } from './data/plan.js';
import { findNextUpcomingWeek } from './lib/dates.js';
import { renderNav, renderPageHeader } from './ui/nav.js';
import { renderWeek } from './ui/week-view.js';
import './coach/goal-trajectory.js';
import './coach/plan-override.js';
import './coach/strava-import.js';
import './coach/tier-estimates.js';
import './coach/weekly-summary.js';
import './lib/format.js';
import './lib/keys.js';
import './lib/storage.js';
import './lib/utils.js';
import './ui/chat-panel.js';
import './ui/export-import.js';
import './ui/history-view.js';
import './ui/kpi-view.js';
import './ui/modals.js';
import './ui/progress-view.js';

(async function init(){
  try{
    const r = await window.storage.get('profile', false);
    if(r) state.profile = Object.assign(state.profile, JSON.parse(r.value));
  }catch(e){}
  try{
    const r2 = await window.storage.get('bike-profile', false);
    if(r2) state.bikeProfile = Object.assign(state.bikeProfile, JSON.parse(r2.value));
  }catch(e){}
  state.goalConfig = await loadGoalConfig();
  renderPageHeader();
  { const r = await recomputeZones(state.profile, state.goalConfig); state.Z = r.Z; state.layoffAdjustment = r.layoffAdjustment; }
  state.WEEKS = await applyPlanOverrides(buildWeeks());
  // Needs state.WEEKS (scans the actual schedule for past sessions by type) AND
  // state.goalConfig (weights each type's importance by the currently active goal
  // distance), so this can't run alongside the layoffAdjustment computation above, which
  // precedes both being ready.
  try{ state.missedSessionAdjustments = await getMissedSessionAdjustments(); }catch(e){}
  try{ state.likelySwapSuggestions = await getLikelySwapSuggestions(); }catch(e){}
  try{ state.hardSessionProximityFlags = await getHardSessionProximityFlags(); }catch(e){}
  renderNav();
  loadLatestVerdict();
  const initialCurrentWeek = state.currentWeek;
  const startWeek = await findNextUpcomingWeek();
  if(state.currentWeek === initialCurrentWeek){
    state.currentWeek = startWeek;
    renderNav();
    renderWeek(startWeek);
  }
})();
