import { state } from '../state.js';
import { renderBikeWeek, renderWeek } from './week-view.js';

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
    b.innerHTML = 'Week '+w.n+'<span class="wk-tag">'+(w.race?'RACE':w.cutback?'taper':'')+'</span>';
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
