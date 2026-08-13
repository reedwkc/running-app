import { state } from '../state.js';
import { vo2max } from '../data/plan.js';
import { fmtPace } from '../lib/format.js';
import { readJsonArray } from '../lib/data-store.js';
import { notifyError } from '../lib/notify.js';
import { saveWithRetry } from '../lib/storage.js';

// Median instead of mean for the recent/older trend windows: a single weather-wrecked or
// poorly-executed run can swing a 5-run mean and read as a real fitness change, but has
// far less effect on the median of the same 5. Field names below stay avgRecent/avgOlder
// (existing coach-prompt code already reads those names) even though the values are now
// medians - only the robustness of the underlying statistic changed, not the API shape.
function median(nums){
  const sorted = [...nums].sort((a,b)=>a-b);
  const mid = Math.floor(sorted.length/2);
  return sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
}

export async function appendTrendPoint(storageKey, date, dataObj){
  const read = await readJsonArray(storageKey);
  if(!read.ok) return;
  let hist = read.value;
  hist.push(Object.assign({date}, dataObj));
  if(hist.length>200) hist = hist.slice(hist.length-200);
  try{ await saveWithRetry(storageKey, hist, false); }
  catch(e){ notifyError('Could not save trend point ('+storageKey+') - try again.'); }
}

export async function getTrendSummary(storageKey, minPoints){
  try{
    const r = await window.storage.get(storageKey, false);
    if(!r) return null;
    const hist = JSON.parse(r.value);
    if(hist.length < (minPoints||6)) return null;
    const recent = hist.slice(-5);
    const older = hist.slice(-10, -5);
    if(older.length < 3) return null;
    const avgRecent = median(recent.map(p=>p.value));
    const avgOlder = median(older.map(p=>p.value));
    const pctChange = avgOlder!==0 ? ((avgRecent-avgOlder)/avgOlder*100) : null;
    return {avgRecent, avgOlder, pctChange, count:hist.length};
  }catch(e){ return null; }
}

export async function getIndoorWearableCalibration(){
  try{
    const r = await window.storage.get('indoor-wearable-calibration', false);
    if(!r) return null;
    const hist = JSON.parse(r.value);
    if(hist.length < 2) return null;
    const recent = hist.slice(-5);
    const avgOffsetSec = Math.round(recent.reduce((s,p)=>s+p.offsetSec,0)/recent.length);
    return {avgOffsetSec, count:hist.length, mostRecentSource: recent[recent.length-1].source};
  }catch(e){ return null; }
}

export async function getSourceCalibrationOffset(){
  try{
    const r = await window.storage.get('efficiency-history', false);
    if(!r) return null;
    const hist = JSON.parse(r.value);
    const strydPoints = hist.filter(p=>p.source==='stryd');
    const gpsPoints = hist.filter(p=>p.source==='gps');
    if(strydPoints.length < 3 || gpsPoints.length < 3) return null;
    const strydAvg = strydPoints.reduce((s,p)=>s+p.ef,0)/strydPoints.length;
    const gpsAvg = gpsPoints.reduce((s,p)=>s+p.ef,0)/gpsPoints.length;
    return {strydAvg, gpsAvg, ratio: strydAvg/gpsAvg, strydCount:strydPoints.length, gpsCount:gpsPoints.length};
  }catch(e){ return null; }
}

export async function getEfficiencyTrend(){
  try{
    const r = await window.storage.get('efficiency-history', false);
    if(!r) return null;
    let hist = JSON.parse(r.value);
    if(hist.length < 6) return null;
    const calib = await getSourceCalibrationOffset();
    if(calib){
      hist = hist.map(p=> p.source==='gps' ? Object.assign({}, p, {ef: p.ef*calib.ratio}) : p);
    }
    const recent = hist.slice(-5);
    const older = hist.slice(-10, -5);
    if(older.length < 3) return null;
    const avgRecent = median(recent.map(p=>p.ef));
    const avgOlder = median(older.map(p=>p.ef));
    const pctChange = ((avgRecent-avgOlder)/avgOlder*100);
    return {avgRecent, avgOlder, pctChange, count:hist.length, calibrated: !!calib};
  }catch(e){ return null; }
}

export async function appendEfficiencyPoint(date, ef, avgHR, speedKmh, source){
  const read = await readJsonArray('efficiency-history');
  if(!read.ok) return;
  let hist = read.value;
  hist.push({date, ef:Math.round(ef*1000)/1000, avgHR, speedKmh:Math.round(speedKmh*100)/100, source:source||'unknown'});
  if(hist.length>200) hist = hist.slice(hist.length-200);
  try{ await saveWithRetry('efficiency-history', hist, false); }
  catch(e){ notifyError('Could not save efficiency point - try again.'); }
}

export async function updateLastActivityDate(dateISO){
  if(!dateISO) return;
  try{
    let current = null;
    try{ const r = await window.storage.get('last-activity-date', false); if(r) current = JSON.parse(r.value).date; }catch(e){}
    if(!current || dateISO.slice(0,10) > current){
      await saveWithRetry('last-activity-date', {date: dateISO.slice(0,10)}, false);
    }
  }catch(e){ console.error('last-activity-date update failed', e); }
}

export async function getDaysSinceLastActivity(){
  try{
    const r = await window.storage.get('last-activity-date', false);
    if(!r) return null;
    const last = JSON.parse(r.value).date;
    const lastDate = new Date(last+'T00:00:00');
    const today = new Date(); today.setHours(0,0,0,0);
    return {days: Math.round((today.getTime()-lastDate.getTime())/86400000), lastDate: last};
  }catch(e){ return null; }
}

export function renderTierUpdateNotice(elId, notifications){
  const el = document.getElementById(elId);
  if(!el) return;
  const fieldLabels = {lthr:'LTHR', ltPaceSec:'LT Pace', maxHR:'Max HR', vo2max:'VO2max', restHR:'Resting HR', suggestedNextSpeed:'Suggested LT speed (km/h)', suggestedNextVO2Speed:'Suggested VO2max speed (km/h)'};
  const fieldFmt = {ltPaceSec: v=>fmtPace(v)};
  notifications.forEach(n=>{
    let diffHTML = '';
    Object.keys(fieldLabels).forEach(k=>{
      const beforeVal = n.before ? n.before[k] : null;
      const afterVal = n.after[k];
      if(afterVal==null) return;
      if(beforeVal!=null && beforeVal===afterVal) return;
      const fmt = fieldFmt[k] || (v=>v);
      diffHTML += '<div class="tier-diff-row"><span class="tier-diff-label">'+fieldLabels[k]+'</span><span class="tier-diff-vals">'+(beforeVal!=null ? (fmt(beforeVal)+' &rarr; ') : '(new) ')+'<b>'+fmt(afterVal)+'</b></span></div>';
    });
    if(!diffHTML) return;
    const uid = 'tn'+Date.now()+Math.floor(Math.random()*1000);
    const box = document.createElement('div');
    box.className = 'tier-update-box';
    box.id = uid;
    box.innerHTML = '<div class="tier-update-head">&#128200; Tier '+n.tierNum+' fitness estimate updated</div>'+
      diffHTML+
      (n.after.basedOn ? ('<div class="tier-diff-reason">'+n.after.basedOn+'</div>') : '')+
      (n.after.clampedFields && n.after.clampedFields.length ? ('<div class="tier-diff-reason" style="color:var(--threshold);">Capped: the model\'s raw estimate for '+n.after.clampedFields.map(k=>fieldLabels[k]||k).join(', ')+' exceeded the per-session limit and was reduced to the max allowed change.</div>') : '')+
      '<div class="tier-update-actions"><button class="ghost-btn" onclick="dismissTierNotice(\''+uid+'\')">Looks right</button><button class="ghost-btn" onclick="revertTierEstimate('+n.tierNum+',\''+uid+'\')">This looks wrong - revert</button></div>';
    el.appendChild(box);
  });
}

export function dismissTierNotice(uid){
  const box = document.getElementById(uid);
  if(box) box.innerHTML = '<div class="tier-diff-reason" style="color:var(--easy);">&#10003; Kept.</div>';
}

export async function revertTierEstimate(tierNum, uid){
  const box = document.getElementById(uid);
  try{
    const prev = await window.storage.get('tier'+tierNum+'-estimate-previous', false);
    if(prev){
      await saveWithRetry('tier'+tierNum+'-estimate', JSON.parse(prev.value), false);
    } else {
      await window.storage.delete('tier'+tierNum+'-estimate', false);
    }
    if(box) box.innerHTML = '<div class="tier-diff-reason" style="color:var(--dim);">Reverted to the previous estimate.</div>';
  }catch(e){
    console.error('revert failed', e);
    if(box) box.innerHTML += '<div class="tier-diff-reason" style="color:#ff6b6b;">Revert failed - try again from the Key Metrics page.</div>';
  }
}

// How far a fresh Tier2-vs-Tier3 offset can move from the previously stored calibration
// before it's flagged rather than silently overwritten - the offset is expected to be
// roughly stable (it reflects a real physical treadmill/outdoor difference for this
// runner), so a big swing is more likely one tier having a bad/misread session than the
// underlying difference actually changing, and is worth a heads-up either way.
const CALIBRATION_DIVERGENCE_THRESHOLD = {ltPaceOffsetSec: 10, lthrOffset: 5};

export async function maybeUpdateTreadmillCalibration(){
  try{
    const t2 = await loadTierEstimate(2);
    const t3 = await loadTierEstimate(3);
    if(!t2 || !t3 || t2.ltPaceSec==null || t3.ltPaceSec==null) return null;
    const t2Age = (Date.now() - new Date(t2.updatedAt).getTime()) / 86400000;
    const t3Age = (Date.now() - new Date(t3.updatedAt).getTime()) / 86400000;
    if(t2Age > 21 || t3Age > 21) return null;
    const calib = {
      ltPaceOffsetSec: t2.ltPaceSec - t3.ltPaceSec,
      lthrOffset: (t2.lthr!=null && t3.lthr!=null) ? (t2.lthr - t3.lthr) : null,
      computedAt: new Date().toISOString(),
      basedOnT2Date: t2.updatedAt,
      basedOnT3Date: t3.updatedAt
    };
    let divergence = null;
    try{
      const prevRaw = await window.storage.get('treadmill-calibration', false);
      if(prevRaw){
        const prev = JSON.parse(prevRaw.value);
        const paceDelta = Math.abs(calib.ltPaceOffsetSec - prev.ltPaceOffsetSec);
        const lthrDelta = (calib.lthrOffset!=null && prev.lthrOffset!=null) ? Math.abs(calib.lthrOffset - prev.lthrOffset) : 0;
        if(paceDelta > CALIBRATION_DIVERGENCE_THRESHOLD.ltPaceOffsetSec || lthrDelta > CALIBRATION_DIVERGENCE_THRESHOLD.lthrOffset){
          divergence = {paceDelta: Math.round(paceDelta), lthrDelta: Math.round(lthrDelta), prevOffsetSec: prev.ltPaceOffsetSec, newOffsetSec: calib.ltPaceOffsetSec};
        }
      }
    }catch(e){}
    await saveWithRetry('treadmill-calibration', calib, false);
    return divergence;
  }catch(e){ console.error('calibration update failed', e); return null; }
}

// Hard ceiling on how much a single session's LLM-produced tier estimate can move a
// number from its anchor. The prompt already asks for "a small nudge, not a big swing"
// but that's a soft instruction the model can drift from session to session; this is the
// deterministic backstop so one odd or hallucinated reading can't corrupt what's actually
// used as a live training target. maxHR is included even though it's meant to only ratchet
// upward - a wild upward jump from a misread is exactly as corrupting as a downward one.
const TIER_MAX_DELTA = {lthr:3, ltPaceSec:8, vo2maxPaceSec:8, maxHR:4, vo2max:1.5, restHR:3};

export function clampTierEstimate(anchor, parsed){
  if(!anchor) return parsed;
  const clamped = Object.assign({}, parsed);
  const clampedFields = [];
  Object.keys(TIER_MAX_DELTA).forEach(k=>{
    const anchorVal = anchor[k];
    const parsedVal = parsed[k];
    if(anchorVal==null || parsedVal==null) return;
    const maxDelta = TIER_MAX_DELTA[k];
    const delta = parsedVal - anchorVal;
    if(Math.abs(delta) > maxDelta){
      clamped[k] = Math.round((anchorVal + Math.sign(delta)*maxDelta)*1000)/1000;
      clampedFields.push(k);
    }
  });
  if(clampedFields.length) clamped.clampedFields = clampedFields;
  return clamped;
}

// Formalizes what was previously just a manually-tracked decision ("wait for a few more
// real threshold sessions before treating threshold pace the same live/hybrid way VO2max
// pace already is"): count qualifying threshold-type sessions that actually produced a
// Tier 2/3 update, so the app can surface readiness itself instead of it being tracked by
// hand. This only tracks and surfaces the count - it does NOT change which tier is
// authoritative for prescribed threshold targets; that stays a deliberate human call.
const THRESHOLD_HYBRID_TARGET_SESSIONS = 3;

export async function recordThresholdHybridProgress(sessionTag){
  if(!sessionTag) return null;
  try{
    const r = await window.storage.get('threshold-hybrid-progress', false);
    let prog = r ? JSON.parse(r.value) : {tags: []};
    if(!prog.tags.includes(sessionTag)) prog.tags.push(sessionTag);
    await saveWithRetry('threshold-hybrid-progress', prog, false);
    return prog;
  }catch(e){ console.error('threshold hybrid progress update failed', e); return null; }
}

export async function getThresholdHybridReadiness(){
  try{
    const r = await window.storage.get('threshold-hybrid-progress', false);
    const prog = r ? JSON.parse(r.value) : {tags: []};
    const count = prog.tags.length;
    return {count, target: THRESHOLD_HYBRID_TARGET_SESSIONS, ready: count >= THRESHOLD_HYBRID_TARGET_SESSIONS};
  }catch(e){ return {count:0, target:THRESHOLD_HYBRID_TARGET_SESSIONS, ready:false}; }
}

export async function getBestFitnessLTPace(){
  let best = {value: state.profile.ltPaceSec, source:'tier1', updatedAt: null};
  try{
    let history = [];
    try{ const r = await window.storage.get('profile-history', false); if(r) history = JSON.parse(r.value); }catch(e){}
    if(history.length) best.updatedAt = history[history.length-1].date;
  }catch(e){}
  const t2 = await loadTierEstimate(2);
  const t3 = await loadTierEstimate(3);
  [{t:t2, label:'tier2'}, {t:t3, label:'tier3'}].forEach(({t,label})=>{
    if(t && t.ltPaceSec!=null && t.updatedAt){
      if(!best.updatedAt || new Date(t.updatedAt) > new Date(best.updatedAt)){
        best = {value: t.ltPaceSec, source: label, updatedAt: t.updatedAt};
      }
    }
  });
  return best;
}

export async function loadTierEstimate(tier){
  try{ const r = await window.storage.get('tier'+tier+'-estimate', false); return r ? JSON.parse(r.value) : null; }catch(e){ return null; }
}

export async function saveTierEstimate(tier, obj){
  try{ await saveWithRetry('tier'+tier+'-estimate', obj, false); }catch(e){ console.error('tier'+tier+' estimate save failed', e); }
  // Every update also lands a point in the persistent history - the "current estimate"
  // key alone only ever holds the latest value, and "-previous" only the one before that,
  // neither is enough to actually chart a trend over time.
  try{ await appendTrendPoint('tier'+tier+'-history', (obj.updatedAt||new Date().toISOString()), obj); }
  catch(e){ console.error('tier'+tier+' history append failed', e); }
}

window.dismissTierNotice = dismissTierNotice;
window.revertTierEstimate = revertTierEstimate;
