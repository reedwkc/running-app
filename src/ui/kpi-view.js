// @ts-nocheck
import { state } from '../state.js';
import { loadTierEstimate } from '../coach/tier-estimates.js';
import { threshold, vo2max } from '../data/plan.js';
import { fmtPace, timeAgo } from '../lib/format.js';
import { workoutKey } from '../lib/keys.js';
import { batchMap } from '../lib/utils.js';
import { toggleProfile } from './modals.js';
import { renderNav } from './nav.js';

export function sparkline(points, color){
  if(points.length<2) return '<div class="note">Not enough history yet - update your Garmin numbers again after your next change to see a trend.</div>';
  const w=320,h=70,pad=8;
  const vals = points.map(p=>p.v);
  const min=Math.min(...vals), max=Math.max(...vals);
  const range = (max-min)||1;
  const step = (w-pad*2)/(points.length-1);
  const coords = points.map((p,i)=>{
    const x = pad+i*step;
    const y = h-pad-((p.v-min)/range)*(h-pad*2);
    return x+','+y;
  }).join(' ');
  return '<svg viewBox="0 0 '+w+' '+h+'" style="width:100%;height:70px;"><polyline points="'+coords+'" fill="none" stroke="'+color+'" stroke-width="2"/></svg>'+
    '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--dim);margin-top:4px;"><span>'+points[0].date+'</span><span>'+points[points.length-1].date+'</span></div>';
}

export async function showKPIPage(){
  if(!state.WEEKS) return;
  state.view='kpi';
  renderNav();
  renderKPIPage();
}

export async function renderKPIPage(){
  const el = document.getElementById('weekContent');
  const tier1 = {lthr:state.profile.lthr, ltPaceSec:state.profile.ltPaceSec, maxHR:state.profile.maxHR, vo2max:state.profile.vo2max, restHR:state.profile.restHR};
  const tier2 = await loadTierEstimate(2);
  const tier3 = await loadTierEstimate(3);
  const rows = [
    {label:'LTHR', fmt:v=>v!=null?(v+' bpm'):'-'},
    {label:'LT Pace', fmt:v=>v!=null?fmtPace(v):'-'},
    {label:'VO2max Pace', fmt:v=>v!=null?fmtPace(v):'-'},
    {label:'Max HR', fmt:v=>v!=null?(v+' bpm'):'-'},
    {label:'VO2max', fmt:v=>v!=null?v:'-'},
    {label:'Resting HR', fmt:v=>v!=null?(v+' bpm'):'-'}
  ];
  const keys = ['lthr','ltPaceSec','vo2maxPaceSec','maxHR','vo2max','restHR'];
  function cellHTML(obj, i, isPrimary){
    if(!obj) return '<div class="kpi-cell kpi-empty">No data yet</div>';
    const v = obj[keys[i]];
    return '<div class="kpi-cell'+(isPrimary?' kpi-primary':'')+'">'+rows[i].fmt(v)+'</div>';
  }
  let html = '<div class="week-head"><h2>Key Performance Indicators</h2><div class="callout">Three views of your current fitness: your actual Garmin numbers (manually updated, ground truth), a live outdoor estimate from Strava-verified sessions, and a live indoor estimate from treadmill sessions - useful in winter when outdoor data goes quiet. Tier 2 and 3 update automatically after qualifying sessions; Tier 1 only updates when you tell it to.</div></div>';
  html += '<div class="kpi-grid">';
  html += '<div class="kpi-col-head"></div><div class="kpi-col-head kpi-primary">Garmin (Tier 1)</div><div class="kpi-col-head">Outdoor estimate (Tier 2)</div><div class="kpi-col-head">Indoor estimate (Tier 3)</div>';
  rows.forEach((r,i)=>{
    html += '<div class="kpi-row-label">'+r.label+'</div>';
    html += cellHTML(tier1, i, true);
    html += cellHTML(tier2, i, false);
    html += cellHTML(tier3, i, false);
  });
  html += '</div>';
  html += '<div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">';
  html += '<button class="save-btn" onclick="toggleProfile(true)">Update Garmin numbers</button>';
  html += '</div>';
  const tier2Meta = tier2 ? ('<div class="kpi-meta">Tier 2 last updated '+timeAgo(tier2.updatedAt)+(tier2.basedOn?(' - based on: '+tier2.basedOn):'')+'</div>') : '';
  const tier3Meta = tier3 ? ('<div class="kpi-meta">Tier 3 last updated '+timeAgo(tier3.updatedAt)+(tier3.basedOn?(' - based on: '+tier3.basedOn):'')+'</div>') : '';
  html += tier2Meta+tier3Meta;
  html += '<div class="note" style="margin-top:14px;">Tier 2 updates automatically after a Strava-verified outdoor threshold or VO2max session. Tier 3 updates after a treadmill threshold or VO2max session with Training Effect logged (and, for LT Pace specifically, the finishing speed of work rep 2). Treadmill-derived LT Pace runs faster than true outdoor pace at the same effort - treat it as directional, not a direct swap for your outdoor number. VO2max Pace has no Garmin equivalent (that\'s why Tier 1 always shows "-" there) and only comes from Tier 2/3, specifically from a logged VO2max session\'s own evidence - a threshold session updates LT Pace but never VO2max Pace, and vice versa. Unlike every other row here, VO2max Pace is also the one number that feeds directly into your actual VO2max session cards, not just this comparison table.</div>';
  el.innerHTML = html;
}

export async function loadDailyMetricsHistory(){
  let entries = [];
  try{
    const list = await window.storage.list('dmetrics-', false);
    if(list && list.keys){
      const results = await batchMap(list.keys, 6, async k=>{
        try{ const r = await window.storage.get(k, false); return r ? JSON.parse(r.value) : {}; }catch(e){ return {}; }
      });
      results.forEach(blob=>{
        Object.keys(blob).forEach(date=>{ entries.push({date, obj:blob[date]}); });
      });
    }
  }catch(e){}
  entries.sort((a,b)=> a.date.localeCompare(b.date));
  return entries;
}

export async function loadWeeklyMileage(){
  const flat = [];
  state.WEEKS.forEach(w=> w.days.forEach(d=> flat.push({w,d})));
  const entries = await batchMap(flat, 6, async item=>{
    const key = workoutKey(item.w.n, item.d.tag);
    if(state.recentSaveCache[key]) return state.recentSaveCache[key];
    try{ const r = await window.storage.get(key, false); return r ? JSON.parse(r.value) : null; }catch(e){ return null; }
  });
  return state.WEEKS.map(w=>{
    let planned = 0, actual = 0, hasActual = false;
    w.days.forEach(d=>{
      const idx = flat.findIndex(f=>f.w===w && f.d===d);
      let plannedKm = 0;
      if(d.type==='easy') plannedKm = d.data.km;
      else if(d.type==='threshold' || d.type==='vo2max' || d.type==='long') plannedKm = parseFloat(d.data.totalKm)||0;
      else if(d.type==='race') plannedKm = d.data.km;
      planned += plannedKm;
      const entry = entries[idx];
      if(entry && entry.completed){
        hasActual = true;
        actual += entry.actualDist ? parseFloat(entry.actualDist) : plannedKm;
      }
    });
    return {weekN:w.n, planned:Math.round(planned*10)/10, actual:Math.round(actual*10)/10, hasActual};
  });
}

export function weeklyMileageChart(data){
  const w=340, h=110, pad=10, groupW=(w-pad*2)/data.length;
  const maxVal = Math.max(...data.map(d=>Math.max(d.planned, d.actual)), 1);
  const barW = groupW*0.32;
  let svg = '<svg viewBox="0 0 '+w+' '+h+'" style="width:100%;height:110px;">';
  data.forEach((d,i)=>{
    const x = pad+i*groupW+groupW*0.15;
    const plannedH = (d.planned/maxVal)*(h-pad*2-14);
    svg += '<rect x="'+x+'" y="'+(h-pad-14-plannedH)+'" width="'+barW+'" height="'+plannedH+'" fill="#7C93A8" opacity="0.55"/>';
    if(d.hasActual){
      const actualH = (d.actual/maxVal)*(h-pad*2-14);
      svg += '<rect x="'+(x+barW+3)+'" y="'+(h-pad-14-actualH)+'" width="'+barW+'" height="'+actualH+'" fill="#E8A33D"/>';
    }
    svg += '<text x="'+(x+barW)+'" y="'+(h-2)+'" font-size="8" fill="#93A6B2" text-anchor="middle">Wk'+d.weekN+'</text>';
  });
  svg += '</svg>';
  return svg;
}

export async function loadTrainingStatusHistory(){
  let entries = [];
  try{
    const list = await window.storage.list('dmetrics-', false);
    if(list && list.keys){
      const results = await batchMap(list.keys, 6, async k=>{
        try{ const r = await window.storage.get(k, false); return r ? JSON.parse(r.value) : {}; }catch(e){ return {}; }
      });
      results.forEach(blob=>{
        Object.keys(blob).forEach(date=>{
          if(blob[date] && blob[date].trainingStatus) entries.push({date, status:blob[date].trainingStatus});
        });
      });
    }
  }catch(e){}
  entries.sort((a,b)=> a.date.localeCompare(b.date));
  return entries;
}

window.showKPIPage = showKPIPage;
