// @ts-nocheck
import { state } from '../state.js';
import { getMethodology } from '../coach/methodology-reference.js';
import { defaultGoalConfig } from '../data/goal-config.js';
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

export function renderNav(){
  if(!state.WEEKS) return;
  const nav=document.getElementById('weekNav'); nav.innerHTML='';
  state.WEEKS.forEach(w=>{
    const b=document.createElement('button');
    b.className = 'week-btn'+(w.n===state.currentWeek && state.view==='plan'?' active':'');
    const reducedLabel = w.cutback ? (classifyReducedWeek(state.WEEKS, w.n)?.kind==='recovery' ? 'recovery' : 'taper') : '';
    b.innerHTML = 'Week '+w.n+'<span class="wk-tag">'+(w.race?'RACE':reducedLabel)+'</span>';
    b.onclick=()=>{ state.view='plan'; state.currentWeek=w.n; renderNav(); renderCurrentWeek(); };
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

window.setMode = setMode;
window.goToBikeVersion = goToBikeVersion;
window.setAppMode = setAppMode;
window.goHome = goHome;
