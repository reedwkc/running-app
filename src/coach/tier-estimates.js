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
  // Re-saving the same real-world session (e.g. after a Strava re-import correcting
  // earlier bad data) must replace its existing point here, not add a second one - two
  // points for one actual workout would silently double-count it in every trend/median
  // calculation that reads this history. Only dedupes when the caller supplies a stable
  // sessionId; older call sites without one keep the previous append-only behavior.
  if(dataObj.sessionId) hist = hist.filter(h=>h.sessionId!==dataObj.sessionId);
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

// Moved here from ui/kpi-view.js (its only prior consumer) so goal-trajectory.js's trend
// computation can reuse it too, without a coach-logic file importing a ui/ file to get it.
export async function loadTierHistories(){
  let tier1Hist = [];
  try{ const r = await window.storage.get('profile-history', false); if(r) tier1Hist = JSON.parse(r.value); }catch(e){}
  let tier2Hist = [];
  try{ const r = await window.storage.get('tier2-history', false); if(r) tier2Hist = JSON.parse(r.value); }catch(e){}
  let tier3Hist = [];
  try{ const r = await window.storage.get('tier3-history', false); if(r) tier3Hist = JSON.parse(r.value); }catch(e){}
  return {tier1Hist, tier2Hist, tier3Hist};
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

// Sane bounds for a manually-typed treadmill speed (km/h) - catches the two realistic
// failure modes: a blank/zero entry (which would otherwise divide-by-zero into Infinity
// and silently poison every average that reads it) and a pace-shaped number typed into the
// speed field by mistake (e.g. "6.3" meaning 6:30/km, not 6.3 km/h - that's an easy-jog
// speed, implausible for a threshold/VO2max work interval). 4 km/h is a brisk walk; 25 km/h
// is faster than any recreational runner's interval pace.
export const TREADMILL_SPEED_MIN_KMH = 4;
export const TREADMILL_SPEED_MAX_KMH = 25;
// When incline isn't logged, assume the app's own standing advice (see the "incline ~1%"
// notes throughout week-view.js) was actually followed, rather than silently assuming a
// flat belt - a flat-belt assumption is the LESS likely real setup given that advice is
// shown on every treadmill session card.
export const TREADMILL_DEFAULT_INCLINE_PCT = 1;

// Standard ACSM running metabolic equation - VO2 (ml/kg/min) = 3.5 + 0.2*speed(m/min) +
// 0.9*speed(m/min)*grade(fraction). The app's earlier VO2max cross-check (in chat.js's
// coach prompt) used only the first two terms, silently dropping the grade term entirely -
// harmless at 0% incline, meaningfully wrong at the ~1%+ this app itself recommends.
export function estimateVO2FromTreadmillSpeed(speedKmh, inclinePct){
  const speedMMin = speedKmh*1000/60;
  const gradeFrac = (inclinePct||0)/100;
  return 3.5 + 0.2*speedMMin + 0.9*speedMMin*gradeFrac;
}

// The ACSM equation itself is calibrated FOR TREADMILL running - it has no separate
// air-resistance term, so it doesn't by itself tell you "outdoor-equivalent" anything. The
// commonly-cited ~1% incline convention (the same one this app already tells every
// treadmill runner to use) is the bridge: running a treadmill at ~1% incline is the
// standard approximation for making its metabolic cost match outdoor flat-ground running
// (the incline compensates for the wind resistance a treadmill belt doesn't provide). So
// TREADMILL_DEFAULT_INCLINE_PCT doubles as the "outdoor-equivalent" reference incline here
// - a session run AT that incline needs no correction at all, while one run at 0% (easier
// than outdoor) or well above 1% (harder) gets translated to the speed that would cost the
// same VO2 AT the reference incline, i.e. a genuine outdoor-flat-equivalent speed rather
// than just an uncorrected treadmill-panel number.
export function treadmillFlatEquivalentSpeedKmh(speedKmh, inclinePct){
  const incline = inclinePct==null ? TREADMILL_DEFAULT_INCLINE_PCT : inclinePct;
  if(incline===TREADMILL_DEFAULT_INCLINE_PCT) return speedKmh;
  const vo2 = estimateVO2FromTreadmillSpeed(speedKmh, incline);
  const refGradeFrac = TREADMILL_DEFAULT_INCLINE_PCT/100;
  const refSpeedMMin = (vo2-3.5)/(0.2+0.9*refGradeFrac);
  return refSpeedMMin*60/1000;
}

export function treadmillFlatEquivalentPaceSec(speedKmh, inclinePct){
  const flatKmh = treadmillFlatEquivalentSpeedKmh(speedKmh, inclinePct);
  return flatKmh>0 ? 3600/flatKmh : null;
}

// Converts a manually-logged treadmill speed+incline into a real Tier2-vs-Tier3 calibration
// data point against a wearable's own pace reading for the same work segment. Returns null
// for any input that can't produce a physically sane result - the direct fix for a logged
// speed of 0 (or blank coerced to 0) previously computing 3600/0 = Infinity, which passed
// the old "treadmillPaceSec>0" guard (Infinity>0 is true) and silently corrupted the
// indoor-wearable-calibration average for up to 5 sessions afterward with no error anywhere.
export function computeTreadmillCalibrationPoint(wearablePaceSec, speedKmh, inclinePct, source){
  if(wearablePaceSec==null || !Number.isFinite(speedKmh) || speedKmh<TREADMILL_SPEED_MIN_KMH || speedKmh>TREADMILL_SPEED_MAX_KMH) return null;
  const treadmillPaceSec = Math.round(treadmillFlatEquivalentPaceSec(speedKmh, inclinePct));
  if(!Number.isFinite(treadmillPaceSec) || treadmillPaceSec<=0) return null;
  return {offsetSec: wearablePaceSec-treadmillPaceSec, treadmillPaceSec, wearablePaceSec, source: source||'unknown'};
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

export async function appendEfficiencyPoint(date, ef, avgHR, speedKmh, source, sessionId){
  const read = await readJsonArray('efficiency-history');
  if(!read.ok) return;
  let hist = read.value;
  // Same re-save-replaces-not-duplicates reasoning as appendTrendPoint above.
  if(sessionId) hist = hist.filter(h=>h.sessionId!==sessionId);
  hist.push({date, ef:Math.round(ef*1000)/1000, avgHR, speedKmh:Math.round(speedKmh*100)/100, source:source||'unknown', sessionId: sessionId||undefined});
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

// Grounded in the standard endurance detraining literature (Mujika & Padilla's detraining
// reviews, Medicine & Science in Sports & Exercise / Sports Medicine, 2000-2001): VO2max
// and performance loss is negligible in the first ~1-2 weeks off, becomes measurable by
// 2-4 weeks (commonly cited ~4-14% VO2max decline in trained endurance athletes over 4
// weeks of cessation), and continues but DECELERATES over following months rather than
// declining indefinitely - a genuine training history retains a meaningfully higher floor
// than a truly untrained baseline even after months off. A small set of named tiers (each
// with its own short rationale) is more honest about how coarse this evidence actually is
// than an invented smooth continuous formula would be - same treatment this file already
// gives the ACSM VO2max formula and the generic threshold-to-VO2max pace gap elsewhere.
// Deliberately informational only - unlike a real Tier 1/2/3 reading, this is an estimate
// from elapsed time, not measured evidence, so it must never silently move state.Z/
// prescribed paces the way an actual fitness reading does (see the "Tier 1 always stays
// authoritative" rule in chat.js). It's meant to shape how a REBUILD plans a return to
// training - ramping volume/intensity back in - not to relabel today's numbers.
const LAYOFF_TIERS = [
  {maxDays:13, severity:'negligible', ltPacePenaltyPct:0, vo2maxPenaltyPct:0, rampWeeksRecommended:0,
    note:'Under 2 weeks off - normal week-to-week variation, not a real fitness loss yet.'},
  {maxDays:27, severity:'mild', ltPacePenaltyPct:2, vo2maxPenaltyPct:4, rampWeeksRecommended:1,
    note:'2-4 weeks off - early, modest aerobic decline (mostly blood-volume/cardiovascular, not yet muscular) - a short ~1-week ramp before resuming full prescribed intensity.'},
  {maxDays:56, severity:'moderate', ltPacePenaltyPct:5, vo2maxPenaltyPct:9, rampWeeksRecommended:2,
    note:'4-8 weeks off - measurable VO2max/threshold decline - resume with meaningfully reduced volume/intensity for roughly 2 weeks before ramping back to full prescribed load.'},
  {maxDays:90, severity:'significant', ltPacePenaltyPct:8, vo2maxPenaltyPct:14, rampWeeksRecommended:3,
    note:'2-3 months off - substantial deconditioning - treat as closer to a fresh base-building restart than a resumption, roughly a 3-week ramp before meaningful quality work.'},
  {maxDays:Infinity, severity:'substantial', ltPacePenaltyPct:12, vo2maxPenaltyPct:18, rampWeeksRecommended:4,
    note:'3+ months off - most endurance-specific adaptation has faded (though training history still provides some advantage over a genuinely untrained starting point) - a genuine multi-week aerobic-base rebuild before any race-specific structure, roughly 4 weeks minimum.'},
];

// null under 7 days (no note at all - matches today's existing behavior of only mentioning
// this once a week has passed); 7-13 days keeps today's light heads-up (the 'negligible'
// tier) with zero penalty/ramp, just now routed through this one shared, scaled function.
export function estimateLayoffImpact(days){
  if(days==null || days<7) return null;
  const tier = LAYOFF_TIERS.find(t=>days<=t.maxDays);
  return {days, severity:tier.severity, ltPacePenaltyPct:tier.ltPacePenaltyPct, vo2maxPenaltyPct:tier.vo2maxPenaltyPct, rampWeeksRecommended:tier.rampWeeksRecommended, note:tier.note};
}

// Turns estimateLayoffImpact's elapsed-time guess into something that actually softens
// PRESCRIBED paces (see recomputeZones in goal-trajectory.js) while there's no real
// evidence yet of how a gap affected this runner specifically - genuine injury-prevention
// for the first sessions back, not a permanent downgrade. The hard part is knowing when to
// stop: getDaysSinceLastActivity's day-count resets to ~0 the moment ANY activity is
// logged (even an easy jog), far too early to trust full pre-gap intensity again - real
// evidence only exists once a genuine Tier 1 (Garmin) update or Tier 2/3 qualifying-session
// estimate actually lands. So this persists a small episode marker (storage key
// 'layoff-episode') rather than trusting the live day-count alone: it keeps returning the
// same penalty figures across the resumption window until getBestAvailableLTPace's
// updatedAt is genuinely newer than when this gap was first flagged - at which point real
// evidence has arrived and the normal Tier 1/2/3 ranking takes over exactly as before,
// unassisted. An updatedAt of null (no dated evidence at all yet) is treated conservatively
// as "not fresh" - keep the adjustment rather than guess it's safe to drop.
export async function getLayoffAdjustment(){
  try{
    const inactivity = await getDaysSinceLastActivity();
    const layoffNow = inactivity ? estimateLayoffImpact(inactivity.days) : null;
    let episode = null;
    try{ const r = await window.storage.get('layoff-episode', false); if(r) episode = JSON.parse(r.value); }catch(e){}

    if(layoffNow && layoffNow.rampWeeksRecommended>0){
      // Still mid-gap (or freshly detected this call) - keep the ORIGINAL detection date
      // stable across re-checks (it's the fixed reference point for "has real evidence
      // landed since"), but refresh the severity/penalty figures in case the gap has grown.
      const firstDetectedAt = (episode && episode.firstDetectedAt) || new Date().toISOString();
      const updated = Object.assign({}, layoffNow, {firstDetectedAt});
      try{ await saveWithRetry('layoff-episode', updated, false); }catch(e){}
      return updated;
    }

    if(!episode) return null; // no gap ever flagged, or already resolved - nothing to apply

    const best = await getBestAvailableLTPace();
    const hasFreshEvidence = !!best.updatedAt && new Date(best.updatedAt) > new Date(episode.firstDetectedAt);
    if(hasFreshEvidence){
      try{ await window.storage.delete('layoff-episode', false); }catch(e){}
      return null;
    }
    return episode;
  }catch(e){ return null; }
}

export function layoffAdjustmentBannerHTML(adj){
  if(!adj) return '';
  return '<div class="card"><div class="sess-name" style="margin-bottom:4px;">&#9888; Paces temporarily softened</div>'+
    '<div class="note" style="border-top:none; padding-top:0; font-size:13px;">'+adj.days+' days since your last logged activity ('+adj.severity+') - prescribed threshold pace is running about '+adj.ltPacePenaltyPct+'% slower and VO2max pace about '+adj.vo2maxPenaltyPct+'% slower than your last known fitness, as a precaution while there\'s no real evidence yet of where you\'re actually at. This clears itself automatically the moment a real session (Strava-verified or treadmill) or a Garmin numbers update gives an actual reading - no need to change anything yourself.</div></div>';
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
// suggestedNextSpeed/suggestedNextVO2Speed (Tier 3-only) were previously absent from this
// map entirely - the prompt asks the model to keep them within ~0.2-0.3 km/h of the prior
// value, but with no field here that instruction had no deterministic backstop at all,
// unlike every other tier-estimate field.
const TIER_MAX_DELTA = {lthr:3, ltPaceSec:8, vo2maxPaceSec:8, maxHR:4, vo2max:1.5, restHR:3, suggestedNextSpeed:0.3, suggestedNextVO2Speed:0.3};

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

// A profile-history entry gets a fresh date whenever ANY Garmin field is re-saved (e.g.
// VO2max alone), not just when ltPaceSec itself changes - using the latest entry's date
// as "when Tier 1's LT pace was last updated" then makes an unrelated re-save (same LT
// pace, different VO2max) look like fresher LT-pace evidence than it is, potentially
// outranking a genuinely more recent Tier 2/3 read purely on a timestamp technicality.
// Caught live: a VO2max-only re-save the same day as a Tier 2 threshold update flipped
// which one "won" for LT pace, even though the LT pace figure itself hadn't moved.
// Walks back to the date THIS ltPaceSec value first appeared, not the last save date.
export function findLTPaceEffectiveDate(history){
  if(!history || !history.length) return null;
  const currentVal = history[history.length-1].ltPaceSec;
  let idx = history.length-1;
  while(idx>0 && history[idx-1].ltPaceSec===currentVal) idx--;
  return history[idx].date;
}

// Once a Tier 2/3 (session-verified) estimate exists and isn't stale, it's treated as the
// more reliable read UNLESS Tier 1 (Garmin) shows genuinely BETTER fitness - a lower
// ltPaceSec (an actually faster pace), not merely a more recent save. Garmin's own
// threshold/VO2max recalibration is slow and, per direct feedback from actually living with
// both side by side, tends to lag/undercount real fitness gains relative to session-level
// Tier 2/3 analysis - so a fresh-but-conservative Garmin update should not be allowed to
// outrank a solid existing Tier 2/3 read purely on recency, the way plain timestamp-sorting
// used to (that flipped the ruling estimate on an unrelated same-day Garmin re-save that
// hadn't even changed ltPaceSec - see findLTPaceEffectiveDate above). Only when the best
// Tier 2/3 read has gone stale (no update in a while) does this fall back to plain recency,
// so an old Tier 2/3 estimate can't rule forever over a much newer Tier 1 read either.
export const TIER23_RULING_MAX_AGE_DAYS = 45;

export async function getBestAvailableLTPace(){
  let tier1 = {source:'tier1', ltPaceSec: state.profile.ltPaceSec, updatedAt: null};
  try{
    const r = await window.storage.get('profile-history', false);
    if(r){
      const hist = JSON.parse(r.value);
      if(hist.length) tier1 = {source:'tier1', ltPaceSec: hist[hist.length-1].ltPaceSec, updatedAt: findLTPaceEffectiveDate(hist)};
    }
  }catch(e){}

  let tier23 = [];
  try{
    const t2 = await loadTierEstimate(2);
    if(t2 && t2.ltPaceSec!=null) tier23.push({source:'tier2', ltPaceSec: t2.ltPaceSec, updatedAt: t2.updatedAt});
  }catch(e){}
  try{
    const t3 = await loadTierEstimate(3);
    if(t3 && t3.ltPaceSec!=null) tier23.push({source:'tier3', ltPaceSec: t3.ltPaceSec, updatedAt: t3.updatedAt});
  }catch(e){}
  if(!tier23.length) return tier1;

  tier23.sort((a,b)=> new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const bestT23 = tier23[0];
  const t23AgeDays = bestT23.updatedAt ? (Date.now()-new Date(bestT23.updatedAt).getTime())/86400000 : Infinity;

  if(t23AgeDays > TIER23_RULING_MAX_AGE_DAYS){
    return (tier1.updatedAt && new Date(tier1.updatedAt) > new Date(bestT23.updatedAt)) ? tier1 : bestT23;
  }
  if(tier1.ltPaceSec!=null && tier1.ltPaceSec < bestT23.ltPaceSec) return tier1;
  return bestT23;
}

export async function getBestFitnessLTPace(){
  const best = await getBestAvailableLTPace();
  return {value: best.ltPaceSec, source: best.source, updatedAt: best.updatedAt};
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
