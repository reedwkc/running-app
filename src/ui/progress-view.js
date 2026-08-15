// @ts-nocheck
import { state } from '../state.js';
import { computeGoalProgress } from '../coach/goal-trajectory.js';
import { bikeSessionName, threshold, vo2max } from '../data/plan.js';
import { fmtDuration, fmtPace, fmtTime } from '../lib/format.js';
import { sleep } from '../lib/utils.js';
import { loadBikeLogs } from './history-view.js';
import { loadDailyMetricsHistory, loadTrainingStatusHistory, loadWeeklyMileage, sparkline, weeklyMileageChart } from './kpi-view.js';
import { renderNav } from './nav.js';
import { segRow } from './week-view.js';

export async function showProgress(){
  if(!state.WEEKS) return;
  state.view='progress';
  renderNav();
  if(state.appMode==='bike'){ renderBikeProgress(); return; }
  try{
    await renderProgressBody();
  }catch(e){
    console.error('showProgress failed', e);
    document.getElementById('weekContent').innerHTML = '<div class="card"><div class="note">Progress page hit an error (' + (e.message||'unknown') + '). Try tapping Progress again - if it keeps happening, tell Claude the exact error text so it can be fixed.</div></div>';
  }
}

export async function renderProgressBody(){
  const myToken = ++state.renderToken;
  let history = [];
  try{ const r = await window.storage.get('profile-history', false); if(r) history = JSON.parse(r.value); }catch(e){}
  if(!history.length || history[history.length-1].lthr!==state.profile.lthr || history[history.length-1].ltPaceSec!==state.profile.ltPaceSec){
    // Full timestamp - see the matching comment in modals.js saveProfileFromForm for why
    // a date-only string here breaks getBestAvailableLTPace's recency comparison.
    history.push({date:new Date().toISOString(), lthr:state.profile.lthr, ltPaceSec:state.profile.ltPaceSec, maxHR:state.profile.maxHR, vo2max:state.profile.vo2max, restHR:state.profile.restHR});
  }
  const lthrPts = history.map(h=>({date:h.date, v:h.lthr}));
  const pacePts = history.map(h=>({date:h.date, v:-h.ltPaceSec})); // invert so faster (lower sec) trends upward visually
  const vo2Pts = history.map(h=>({date:h.date, v:h.vo2max}));

  const lt = state.profile.ltPaceSec;
  const halfPace = Math.round(lt*1.045/5)*5;
  const halfTime = halfPace*21.0975;
  const riegel = (D)=> halfTime*Math.pow(D/21.0975,1.06);
  const rows = [
    {label:'5K', D:5, time:riegel(5)},
    {label:'10K', D:10, time:riegel(10)},
    {label:'Half Marathon', D:21.0975, time:halfTime},
    {label:'Marathon', D:42.195, time:riegel(42.195)}
  ];

  let html = '<div class="week-head"><h2>Progress</h2><div class="callout">Predictions below are a rough estimate anchored to your current threshold pace, using the standard Riegel cross-distance formula - not a lab test. They\'ll shift automatically whenever you update your Garmin numbers, or whenever we revise your threshold together after analyzing a run.</div></div>';

  const goalProgress = await computeGoalProgress();
  if(goalProgress && (goalProgress.tenK || goalProgress.hm)){
    function gapLabel(gapSec){
      if(Math.abs(gapSec)<=2) return {text:'On track', color:'var(--easy)'};
      if(gapSec<0) return {text:Math.abs(gapSec)+'s/km ahead of schedule', color:'var(--easy)'};
      return {text:gapSec+'s/km behind schedule', color: gapSec>8 ? '#ff6b6b' : 'var(--threshold)'};
    }
    html += '<div class="card">';
    html += '<div class="sess-name" style="margin-bottom:10px;">On track toward your goals?</div>';
    html += '<div class="note" style="border-top:none; padding-top:0; margin-bottom:12px;">Best current fitness estimate: <b>'+fmtPace(goalProgress.bestPace.value)+'</b> LT pace (from '+(goalProgress.bestPace.source==='tier1'?'your Garmin numbers':goalProgress.bestPace.source==='tier2'?'recent outdoor sessions':'recent treadmill sessions')+'), vs. where the plan expects you to be today.</div>';
    if(goalProgress.tenK){
      const g10 = gapLabel(goalProgress.tenK.gap10KSec);
      html += '<div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-top:1px solid var(--line);"><div><b>'+goalProgress.tenK.label+'</b> ('+goalProgress.tenK.race10KDate+')</div><div style="color:'+g10.color+'; font-weight:700; font-size:13px;">'+g10.text+'</div></div>';
    }
    if(goalProgress.hm){
      const gHM = gapLabel(goalProgress.hm.gapHMSec);
      html += '<div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-top:1px solid var(--line);"><div><b>'+goalProgress.hm.label+'</b> ('+goalProgress.hm.raceHMDate+')</div><div style="color:'+gHM.color+'; font-weight:700; font-size:13px;">'+gHM.text+'</div></div>';
    }
    if(goalProgress.hm && goalProgress.tenK && goalProgress.tenK.has10KResult){
      html += '<div class="note" style="margin-top:10px;">'+goalProgress.hm.label+' trajectory has been recalibrated using your actual '+goalProgress.tenK.label+' result, not just the pre-race plan.</div>';
    }
    html += '</div>';
  }

  html += '<div class="card"><div class="sess-name" style="margin-bottom:10px;">Threshold heart rate (LTHR)</div><div class="chart-box">'+sparkline(lthrPts,'#E8A33D')+'</div>';
  html += '<div class="sess-name" style="margin:16px 0 10px;">Threshold pace (faster = trending up)</div><div class="chart-box">'+sparkline(pacePts,'#5FA8A0')+'</div>';
  html += '<div class="sess-name" style="margin:16px 0 10px;">VO2max</div><div class="chart-box">'+sparkline(vo2Pts,'#C1502E')+'</div></div>';

  let statusHistory = [], dailyHistory = [];
  try{ statusHistory = await loadTrainingStatusHistory(); }catch(e){ console.error('statusHistory failed', e); }
  try{ dailyHistory = await loadDailyMetricsHistory(); }catch(e){ console.error('dailyHistory failed', e); }
  // Weekly mileage chart temporarily disabled - was the heaviest batch of storage requests on this page
  // and a likely contributor to a display bug where completed workouts appeared to vanish after
  // visiting Progress. Re-enable once that's confirmed fully resolved. See loadWeeklyMileage/weeklyMileageChart.


  html += '<div class="card"><div class="sess-name" style="margin-bottom:10px;">Recovery & readiness trends</div>';
  if(dailyHistory.length < 2){
    html += '<div class="note">Log Daily metrics a few more times to see trends here - Sleep Score, Training Readiness, and HRV all get more useful as a trend than as a single reading.</div>';
  } else {
    const sleepPts = dailyHistory.filter(e=>e.obj.sleep).map(e=>({date:e.date, v:parseFloat(e.obj.sleep)}));
    const readinessPts = dailyHistory.filter(e=>e.obj.readiness).map(e=>({date:e.date, v:parseFloat(e.obj.readiness)}));
    const hrvPts = dailyHistory.filter(e=>e.obj.hrv).map(e=>({date:e.date, v:parseFloat(e.obj.hrv)}));
    if(sleepPts.length>1) html += '<div class="sess-name" style="margin-bottom:10px;">Sleep score</div><div class="chart-box">'+sparkline(sleepPts,'#5FA8A0')+'</div>';
    if(readinessPts.length>1) html += '<div class="sess-name" style="margin:16px 0 10px;">Training readiness</div><div class="chart-box">'+sparkline(readinessPts,'#E8A33D')+'</div>';
    if(hrvPts.length>1) html += '<div class="sess-name" style="margin:16px 0 10px;">HRV (ms)</div><div class="chart-box">'+sparkline(hrvPts,'#C1502E')+'</div>';
  }
  html += '</div>';

  html += '<div class="card"><div class="sess-name" style="margin-bottom:10px;">Training status</div>';
  if(!statusHistory.length){
    html += '<div class="note">Log it in Daily metrics whenever you check Garmin - seeing the trend (Productive, Peaking, Overreaching, etc.) over a few weeks is more useful than any single reading.</div>';
  } else {
    [...statusHistory].reverse().slice(0,10).forEach(s=>{ html += segRow(s.date, s.status); });
  }
  html += '</div>';

  html += '<div class="card"><div class="sess-name" style="margin-bottom:10px;">Predicted race times</div>';
  html += '<table class="pred-table"><tr><th>Distance</th><th>Est. time</th><th>Est. pace</th></tr>';
  rows.forEach(r=>{ html += '<tr><td>'+r.label+'</td><td>'+fmtDuration(r.time)+'</td><td>'+fmtPace(r.time/r.D)+'</td></tr>'; });
  html += '</table></div>';

  if(myToken !== state.renderToken || state.view!=='progress' || state.appMode!=='run') return;
  document.getElementById('weekContent').innerHTML = html;
}

export async function renderBikeProgress(){
  const myToken = ++state.renderToken;
  let logs = [];
  try{ logs = await loadBikeLogs(); }catch(e){ console.error('loadBikeLogs failed', e); }
  let html = '<div class="week-head"><h2>Cycling Progress</h2><div class="callout">Built from the workout logs on your bike sessions - kept separate from running Progress since ride load and running load are different fitness signals and shouldn\'t blend into one trend line.</div></div>';

  if(logs.length < 2){
    html += '<div class="card"><div class="note">Log a couple more bike sessions (use "+ Log this workout" on any bike day) to see trends here - duration, session load, and RPE over time.</div></div>';
  } else {
    const durPts = logs.map(l=>({date:l.day.tag, v: l.eq ? Math.round(l.eq.totalSec/60) : 0}));
    const loadPts = logs.map(l=>({date:l.day.tag, v: parseFloat(l.entry.sessionLoad)||0}));
    const rpePts = logs.map(l=>({date:l.day.tag, v: parseFloat(l.entry.rpe)||0}));
    html += '<div class="card"><div class="sess-name" style="margin-bottom:10px;">Session duration (min)</div><div class="chart-box">'+sparkline(durPts,'#5FA8A0')+'</div>';
    html += '<div class="sess-name" style="margin:16px 0 10px;">Session load</div><div class="chart-box">'+sparkline(loadPts,'#E8A33D')+'</div>';
    html += '<div class="sess-name" style="margin:16px 0 10px;">RPE</div><div class="chart-box">'+sparkline(rpePts,'#C1502E')+'</div></div>';
  }

  html += '<div class="card"><div class="sess-name" style="margin-bottom:10px;">Logged bike sessions ('+logs.length+')</div>';
  if(!logs.length){
    html += '<div class="note">No bike sessions logged yet.</div>';
  } else {
    [...logs].reverse().forEach(l=>{
      const dur = l.eq ? fmtTime(l.eq.totalSec) : '?';
      const actualKmh = (l.entry.actualDist && l.entry.actualDur) ? (parseFloat(l.entry.actualDist)/(parseFloat(l.entry.actualDur)/60)).toFixed(1)+' km/h - ' : '';
      const detail = actualKmh+(l.entry.rpe?('RPE '+l.entry.rpe+' - '):'')+(l.entry.loadStatus?(l.entry.loadStatus+' load'):'');
      html += segRow('Wk'+l.weekN+' '+l.day.tag+' - '+bikeSessionName(l.eq?l.eq.kind:null)+' ('+dur+')', detail);
    });
  }
  html += '</div>';
  if(myToken !== state.renderToken || (state.view!=='progress' && state.view!=='history') || state.appMode!=='bike') return;
  document.getElementById('weekContent').innerHTML = html;
}
