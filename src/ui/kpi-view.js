// @ts-nocheck
import { state } from '../state.js';
import { getSourceCalibrationOffset, loadTierEstimate } from '../coach/tier-estimates.js';
import { threshold, vo2max } from '../data/plan.js';
import { fmtPace, timeAgo } from '../lib/format.js';
import { workoutKey } from '../lib/keys.js';
import { batchMap } from '../lib/utils.js';
import { toggleProfile } from './modals.js';
import { renderNav } from './nav.js';

// Real date-axis (not index-based like sparkline()) multi-series chart, since tier1/2/3
// histories update on completely different schedules and plotting them by index would
// misalign them in time. series: [{label, color, points:[{date, v}]}], points already
// sorted ascending by date; a single-point series draws as a dot instead of a line.
export function tierTrendChartHTML(title, series, formatValue){
  const w=340, h=130, padL=40, padR=8, padT=10, padB=18;
  const fmt = formatValue || (v=>v);
  const allPoints = series.flatMap(s=>s.points);
  if(allPoints.length<1) return '<div class="sess-name" style="margin-bottom:6px;">'+title+'</div><div class="note">Not enough history yet.</div>';
  const times = allPoints.map(p=>new Date(p.date).getTime());
  const minT = Math.min(...times), maxT = Math.max(...times);
  const tRange = (maxT-minT)||1;
  const vals = allPoints.map(p=>p.v);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const vPad = (maxV-minV)*0.15 || Math.abs(maxV)*0.05 || 1;
  const loV = minV-vPad, hiV = maxV+vPad, vRange = (hiV-loV)||1;
  const usableW = w-padL-padR, usableH = h-padT-padB;
  const xPos = t => padL + ((t-minT)/tRange)*usableW;
  const yPos = v => padT + usableH - ((v-loV)/vRange)*usableH;
  let svg = '<svg viewBox="0 0 '+w+' '+h+'" style="width:100%;height:130px;">';
  // Y-axis: gridline + value label at top, middle, and bottom of the plotted range, so
  // the chart can be read on its own without cross-referencing the legend below. These are
  // drawn at the actual data extremes (minV/maxV), not the padded scale bounds (hiV/loV) -
  // hiV/loV only exist to give points breathing room off the very top/bottom edge. Labeling
  // at the padded bounds instead would draw a gridline that LOOKS like it should pass
  // through the topmost/bottommost point but visually sits above/below it, since a small
  // pad offset can round to the exact same displayed text (e.g. fmtPace rounds to the
  // nearest 5s) while still being a genuinely different, unpadded height on the chart.
  [maxV, (maxV+minV)/2, minV].forEach(v=>{
    const y = yPos(v);
    svg += '<line x1="'+padL+'" y1="'+y+'" x2="'+(padL+usableW)+'" y2="'+y+'" stroke="var(--line)" stroke-width="0.5" stroke-dasharray="2,2"/>';
    svg += '<text x="'+(padL-6)+'" y="'+(y+3)+'" font-size="8" fill="var(--dim)" text-anchor="end">'+fmt(v)+'</text>';
  });
  series.forEach(s=>{
    if(!s.points.length) return;
    if(s.points.length===1){
      const p = s.points[0];
      svg += '<circle cx="'+xPos(new Date(p.date).getTime())+'" cy="'+yPos(p.v)+'" r="4" fill="'+s.color+'"/>';
    } else {
      const coords = s.points.map(p=> xPos(new Date(p.date).getTime())+','+yPos(p.v)).join(' ');
      svg += '<polyline points="'+coords+'" fill="none" stroke="'+s.color+'" stroke-width="2.25"/>';
      s.points.forEach(p=> svg += '<circle cx="'+xPos(new Date(p.date).getTime())+'" cy="'+yPos(p.v)+'" r="2.75" fill="'+s.color+'"/>');
    }
  });
  const fmtDate = t => new Date(t).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  svg += '<text x="'+padL+'" y="'+(h-4)+'" font-size="8.5" fill="var(--dim)">'+fmtDate(minT)+'</text>';
  svg += '<text x="'+(padL+usableW)+'" y="'+(h-4)+'" font-size="8.5" fill="var(--dim)" text-anchor="end">'+fmtDate(maxT)+'</text>';
  svg += '</svg>';
  let legend = '<div style="display:flex; gap:14px; flex-wrap:wrap; margin-top:2px;">';
  series.forEach(s=>{
    if(!s.points.length) return;
    const last = s.points[s.points.length-1];
    legend += '<div style="display:flex; align-items:center; gap:5px; font-size:10.5px; color:var(--dim);"><span style="width:8px;height:8px;border-radius:50%;background:'+s.color+';display:inline-block;flex-shrink:0;"></span>'+s.label+': <b style="color:var(--text);">'+fmt(last.v)+'</b></div>';
  });
  legend += '</div>';
  return '<div class="sess-name" style="margin-bottom:2px;">'+title+'</div>'+svg+legend;
}

export async function loadTierHistories(){
  let tier1Hist = [];
  try{ const r = await window.storage.get('profile-history', false); if(r) tier1Hist = JSON.parse(r.value); }catch(e){}
  let tier2Hist = [];
  try{ const r = await window.storage.get('tier2-history', false); if(r) tier2Hist = JSON.parse(r.value); }catch(e){}
  let tier3Hist = [];
  try{ const r = await window.storage.get('tier3-history', false); if(r) tier3Hist = JSON.parse(r.value); }catch(e){}
  return {tier1Hist, tier2Hist, tier3Hist};
}

// Pace is inverted (v = -seconds) so faster (lower sec/km) trends visually upward,
// matching the same convention already used for the pace sparkline on the Progress page.
export function tierPaceTrendHTML(tier1Hist, tier2Hist, tier3Hist, field, title){
  const toPoints = hist => hist.filter(h=>h[field]!=null).map(h=>({date:h.date, v:-h[field]}));
  const series = [
    {label:'Garmin (Tier 1)', color:'#8B95A0', points: toPoints(tier1Hist)},
    {label:'Outdoor (Tier 2)', color:'#5FA85F', points: toPoints(tier2Hist)},
    {label:'Indoor (Tier 3)', color:'#6FA8DC', points: toPoints(tier3Hist)},
  ].filter(s=>s.points.length);
  return tierTrendChartHTML(title, series, v=>fmtPace(-v));
}

export function tierNumberTrendHTML(tier1Hist, tier2Hist, tier3Hist, field, title, suffix){
  const toPoints = hist => hist.filter(h=>h[field]!=null).map(h=>({date:h.date, v:h[field]}));
  const series = [
    {label:'Garmin (Tier 1)', color:'#8B95A0', points: toPoints(tier1Hist)},
    {label:'Outdoor (Tier 2)', color:'#5FA85F', points: toPoints(tier2Hist)},
    {label:'Indoor (Tier 3)', color:'#6FA8DC', points: toPoints(tier3Hist)},
  ].filter(s=>s.points.length);
  return tierTrendChartHTML(title, series, v=>Math.round(v)+(suffix||''));
}

// A single-series version of tierTrendChartHTML's date-axis chart, for the trend series
// that only ever have one source (unlike LT pace/VO2max, which are genuinely multi-tier).
export function singleSeriesTrendHTML(title, points, color, formatValue){
  return tierTrendChartHTML(title, [{label:title, color, points}], formatValue);
}

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
  html += '<div class="note" style="margin-top:14px;">Tier 2 updates automatically after a Strava-verified outdoor threshold or VO2max session. Tier 3 updates after a treadmill threshold or VO2max session with Training Effect logged (and, for LT Pace specifically, the finishing speed of work rep 2). Treadmill-derived LT Pace runs faster than true outdoor pace at the same effort - treat it as directional, not a direct swap for your outdoor number. VO2max Pace has no Garmin equivalent (that\'s why Tier 1 always shows "-" there) and only comes from Tier 2/3, specifically from a logged VO2max session\'s own evidence - a threshold session updates LT Pace but never VO2max Pace, and vice versa. The number shown here is the raw value from that last VO2max session specifically - your actual VO2max session cards use a live-tracking figure instead (that session\'s measured gap below LT pace, reapplied to whatever LT pace is right now), so it can keep moving with your threshold progress between the rare VO2max sessions this plan actually includes, rather than freezing on this exact number for weeks.</div>';

  const {tier1Hist, tier2Hist, tier3Hist} = await loadTierHistories();
  const anyHistory = tier1Hist.length || tier2Hist.length || tier3Hist.length;
  html += '<div class="week-head" style="margin-top:20px;"><h2>Fitness trends</h2><div class="callout">How each tier\'s numbers have actually moved over time - Tier 1 only gets a new point when you update Garmin numbers, Tier 2/3 add one automatically every time a qualifying session refines the estimate.</div></div>';
  if(!anyHistory){
    html += '<div class="card"><div class="note">Nothing to chart yet - history builds up as Tier 2/3 update from qualifying sessions and you update Garmin numbers.</div></div>';
  } else {
    html += '<div class="card">'+tierPaceTrendHTML(tier1Hist, tier2Hist, tier3Hist, 'ltPaceSec', 'LT Pace')+'</div>';
    html += '<div class="card" style="margin-top:12px;">'+tierPaceTrendHTML(tier1Hist, tier2Hist, tier3Hist, 'vo2maxPaceSec', 'VO2max Pace')+'</div>';
    html += '<div class="card" style="margin-top:12px;">'+tierNumberTrendHTML(tier1Hist, tier2Hist, tier3Hist, 'lthr', 'LTHR', 'bpm')+'</div>';
    html += '<div class="card" style="margin-top:12px;">'+tierNumberTrendHTML(tier1Hist, tier2Hist, tier3Hist, 'vo2max', 'VO2max', '')+'</div>';
  }

  // These four signals used to exist only as sentences in the coach's prompt context -
  // real data with no way to eyeball it yourself or catch a computation bug. Charted here
  // with the same date-axis chart the tiers use above, each independently since they build
  // up at very different rates (efficiency from every easy run, decoupling only from long
  // runs with a Strava import, etc).
  let effHist = [], tttHist = [], hrrHist = [], decoupHist = [];
  try{ const r = await window.storage.get('efficiency-history', false); if(r) effHist = JSON.parse(r.value); }catch(e){}
  try{ const r = await window.storage.get('timetotarget-history', false); if(r) tttHist = JSON.parse(r.value); }catch(e){}
  try{ const r = await window.storage.get('hrrecovery-history', false); if(r) hrrHist = JSON.parse(r.value); }catch(e){}
  try{ const r = await window.storage.get('decoupling-history', false); if(r) decoupHist = JSON.parse(r.value); }catch(e){}
  // Always shown, same as the Fitness trends section above (which always renders VO2max
  // Pace's "Not enough history yet." placeholder even at zero points) - previously each
  // card here only appeared once it had 2+ points, so with only one of the four actually
  // populated, the other three didn't show up at all: no title, no placeholder, nothing to
  // indicate they were even being tracked. singleSeriesTrendHTML already falls through to
  // that same placeholder message on its own for 0-1 points, so there's no need to gate here.
  html += '<div class="week-head" style="margin-top:20px;"><h2>Supplementary trends</h2><div class="callout">Signals the coach already factors in, now visible directly rather than only as prose - each builds up independently from a different kind of session, so some may still be thin early on.</div></div>';
  {
    const calib = await getSourceCalibrationOffset();
    const effPoints = effHist.map(p=>({date:p.date, v: (calib && p.source==='gps') ? p.ef*calib.ratio : p.ef}));
    html += '<div class="card">'+singleSeriesTrendHTML('Aerobic efficiency (easy runs, speed per heartbeat - higher is better)', effPoints, '#5FA85F', v=>v.toFixed(3))+'</div>';
  }
  {
    const points = tttHist.map(p=>({date:p.date, v:-p.value}));
    html += '<div class="card" style="margin-top:12px;">'+singleSeriesTrendHTML('Time-to-target HR (speed work - faster is better)', points, '#E8A33D', v=>Math.round(-v)+'s')+'</div>';
  }
  {
    const points = hrrHist.map(p=>({date:p.date, v:p.value}));
    html += '<div class="card" style="margin-top:12px;">'+singleSeriesTrendHTML('HR recovery drop (speed work - more is better)', points, '#6FA8DC', v=>Math.round(v)+'bpm')+'</div>';
  }
  {
    const points = decoupHist.map(p=>({date:p.date, v:-p.value}));
    html += '<div class="card" style="margin-top:12px;">'+singleSeriesTrendHTML('Aerobic decoupling (long runs - lower is better)', points, '#C1502E', v=>(-v).toFixed(1)+'%')+'</div>';
  }
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
