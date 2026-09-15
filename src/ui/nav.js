// @ts-nocheck
import { state } from '../state.js';
import { getMethodology } from '../coach/methodology-reference.js';
import { blockRelativeWeekN, defaultGoalConfig } from '../data/goal-config.js';
import { classifyReducedWeek } from '../data/plan.js';
import { findNextUpcomingWeek } from '../lib/dates.js';
import { renderBikeWeek, renderWeek } from './week-view.js';

// index.html ships with generic placeholder copy (a personal AI coach, not hardcoded to
// any one race) - this fills in the real current goals/methodology once state.goalConfig
// has loaded. Re-run after anything that can change either: boot (main.js) and a
// plan-override apply/revert (a goalConfigPatch or methodology switch).
export async function renderPageHeader(){
  const cfg = state.goalConfig || defaultGoalConfig();
  const goals = cfg.activeGoals || [];

  let methodologyId = 'norwegian-subthreshold';
  try{
    const r = await window.storage.get('plan-override', false);
    if(r){ const o = JSON.parse(r.value); if(o.activeMethodology) methodologyId = o.activeMethodology; }
  }catch(e){}
  const methodology = getMethodology(methodologyId);
  const phaseLabel = cfg.phase==='maintenance' ? 'Maintenance phase' : cfg.phase==='race-build' ? 'Race-build phase' : (cfg.phase||'');

  const eyebrowEl = document.getElementById('pageEyebrow');
  if(eyebrowEl) eyebrowEl.textContent = methodology.name+(phaseLabel?(' · '+phaseLabel):'');

  const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric', year:'numeric'}); };
  const subEl = document.getElementById('pageSub');
  if(subEl){
    if(goals.length){
      subEl.innerHTML = goals.map(g=>
        '<div style="margin-top:4px; display:flex; gap:6px; align-items:baseline;">'+
        '<span style="color:var(--threshold);">&#9679;</span>'+
        '<span><b style="color:var(--threshold);">'+(g.label||g.type||'Goal')+'</b> '+(g.raceName?(g.raceName+', '):'')+(g.raceDate?fmtDate(g.raceDate):'date TBD')+' &middot; goal '+(g.goalTimeLabel||'').toLowerCase()+'</span>'+
        '</div>'
      ).join('');
    } else {
      subEl.textContent = 'Currently in a maintenance phase - no race on the calendar right now.';
    }
  }

  const primaryGoal = goals.find(g=>g.zoneKey==='GOAL') || goals[0];
  document.title = 'Training Hub'+(primaryGoal ? (' · '+(primaryGoal.label||primaryGoal.type)) : (goals.length ? '' : ' · Maintenance'));
}

// Same "current week" logic used to pick the initial week on page load in main.js -
// the first week that isn't fully logged yet, or whose date range includes today if
// every week so far is done. Reused here rather than a separate today's-date check, so
// "Home" always agrees with what a fresh page load would show.
export async function goHome(){
  if(!state.WEEKS) return;
  state.view = 'plan';
  state.currentWeek = await findNextUpcomingWeek();
  renderNav();
  renderCurrentWeek();
}

export function setMode(m){
  state.mode=m;
  document.getElementById('btn-outdoor').classList.toggle('on', m==='outdoor');
  document.getElementById('btn-treadmill').classList.toggle('on', m==='treadmill');
  if(!state.WEEKS) return;
  state.view='plan';
  renderNav();
  renderCurrentWeek();
}

export function goToBikeVersion(weekN, dayTag){
  state.appMode = 'bike';
  document.getElementById('btn-app-run').classList.toggle('on', false);
  document.getElementById('btn-app-bike').classList.toggle('on', true);
  document.getElementById('runOnlyToggle').style.display = 'none';
  state.view = 'plan';
  state.currentWeek = weekN;
  renderNav();
  renderBikeWeek(weekN);
}

// Weeks belonging to a finished block are collapsed behind a single chip once a new block
// starts. They are still real, still logged, still reachable in one tap - but a 51-week block
// already makes for a long strip, and the weeks the runner is actually training through
// should not open six scroll-lengths in, behind a block that is over. Expanding is
// per-session and never sticky: jumping back to look at a finished week is a visit, not a new
// default. goToWeek on a hidden week expands automatically (see below), so nothing the app
// links to can end up pointing at a week the strip refuses to show.
export function togglePreviousBlockWeeks(){
  state.showPreviousBlockWeeks = !state.showPreviousBlockWeeks;
  renderNav();
}
window.togglePreviousBlockWeeks = togglePreviousBlockWeeks;

export function renderNav(){
  if(!state.WEEKS) return;
  const nav=document.getElementById('weekNav'); nav.innerHTML='';
  const cfgForNav = state.goalConfig||defaultGoalConfig();
  const blockStartN = cfgForNav.blockStartWeekN;
  const priorWeeks = blockStartN!=null ? state.WEEKS.filter(w=>w.n<blockStartN) : [];
  // The week being viewed always gets a tab, even when it belongs to the collapsed block -
  // an active week with no tab would leave the strip looking like nothing is selected.
  const showingPrior = state.showPreviousBlockWeeks || (state.view==='plan' && priorWeeks.some(w=>w.n===state.currentWeek));
  // Expanded, the same chip puts them away again - but not while one of those weeks is the
  // one being viewed, since collapsing would take the active tab off the strip.
  const viewingPrior = state.view==='plan' && priorWeeks.some(w=>w.n===state.currentWeek);
  if(priorWeeks.length && (!showingPrior || !viewingPrior)){
    const chip = document.createElement('button');
    chip.className = 'week-btn week-btn-prior';
    chip.title = showingPrior ? 'Hide your previous block\'s weeks' : 'Weeks from your previous block - finished, still logged';
    chip.innerHTML = showingPrior
      ? '&#8250; Hide<span class="wk-tag">earlier</span>'
      : '&#8249; Earlier<span class="wk-tag">'+priorWeeks.length+' week'+(priorWeeks.length===1?'':'s')+'</span>';
    chip.onclick = togglePreviousBlockWeeks;
    nav.appendChild(chip);
  }
  state.WEEKS.forEach(w=>{
    if(!showingPrior && blockStartN!=null && w.n<blockStartN) return;
    // A new block's display numbering restarts at 1 (blockRelativeWeekN), which can land on
    // the exact same number an OLDER block's week already used (e.g. both happen to be 6
    // weeks long) - genuinely ambiguous at a glance with no visual break. A thin divider
    // right where the new block actually starts (not a text label on every button) keeps
    // every button's own real week number/date correct on click either way, it just makes
    // the "numbering reset here" boundary visible instead of two identical-looking "Week 3"
    // buttons sitting side by side.
    // Only worth drawing when both sides of the boundary are actually on screen.
    if(blockStartN!=null && w.n===blockStartN && showingPrior && priorWeeks.length){
      const divider = document.createElement('div');
      divider.className = 'week-nav-block-divider';
      divider.title = 'New training block starts here';
      nav.appendChild(divider);
    }
    const b=document.createElement('button');
    b.className = 'week-btn'+(w.n===state.currentWeek && state.view==='plan'?' active':'');
    // A genuine standalone mid-block cutback week (not tied to any nearby race - see
    // classifyReducedWeek in data/plan.js) is neither a recovery nor a taper week and
    // shouldn't be mislabeled as one just because this used to be a binary choice.
    const classification = w.cutback ? classifyReducedWeek(state.WEEKS, w.n) : null;
    const reducedLabel = classification ? (classification.kind==='recovery' ? 'recovery' : classification.kind==='taper' ? 'taper' : 'cutback') : '';
    b.innerHTML = 'Week '+blockRelativeWeekN(w.n, cfgForNav)+'<span class="wk-tag">'+(w.race?'RACE':reducedLabel)+'</span>';
    b.onclick=()=>goToWeek(w.n);
    nav.appendChild(b);
  });
}

export function setAppMode(m){
  state.appMode = m;
  document.getElementById('btn-app-run').classList.toggle('on', m==='run');
  document.getElementById('btn-app-bike').classList.toggle('on', m==='bike');
  document.getElementById('runOnlyToggle').style.display = 'none';
  if(!state.WEEKS) return;
  state.view = 'plan';
  renderNav();
  renderCurrentWeek();
}

export function renderCurrentWeek(){
  if(state.appMode==='run') renderWeek(state.currentWeek); else renderBikeWeek(state.currentWeek);
}

// Shared "switch to week N" behavior - the ONLY path that should ever change which week is
// selected, since it's the one place that keeps state.currentWeek, the nav tab highlight,
// and the rendered week content all in sync. Anything that lets the runner jump to a
// specific week (nav tabs above, and the mileage-bar-wrap's own per-week bars/number labels
// in week-view.js) must call this, not renderWeek/renderBikeWeek directly - calling those
// directly (as the mileage bar used to) moves the content and its own mileage bar to the new
// week but never re-renders the nav tabs, leaving them stuck showing whichever week was last
// selected THROUGH the nav tabs specifically. Exposed on window since week-view.js's
// mileage-bar HTML wires this as a plain onclick string, not a JS import (avoids a circular
// import between nav.js and week-view.js, which already imports the other direction).
export function goToWeek(n){
  state.view = 'plan';
  state.currentWeek = n;
  // Anything that navigates into the collapsed previous block opens it, rather than landing
  // the runner on a week whose own tab isn't in the strip.
  const cfgForJump = state.goalConfig||defaultGoalConfig();
  if(cfgForJump.blockStartWeekN!=null && n<cfgForJump.blockStartWeekN) state.showPreviousBlockWeeks = true;
  renderNav();
  renderCurrentWeek();
}
window.goToWeek = goToWeek;

window.setMode = setMode;
window.goToBikeVersion = goToBikeVersion;
window.setAppMode = setAppMode;
window.goHome = goHome;
