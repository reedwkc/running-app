// @ts-nocheck
import { state } from '../state.js';
import { autoCoachMessage } from '../coach/chat.js';
import { stravaGetStreams, stravaListActivities } from '../coach/api.js';
import { updateLastActivityDate } from '../coach/tier-estimates.js';
import { applyPlanOverrides, buildWeeks, computeZones, vo2max } from '../data/plan.js';
import { calendarWeekKey, getFullWeekDayList, parseDayTagDate } from '../lib/dates.js';
import { fmtPace, formatMinutesToClock, parseDurationToMinutes } from '../lib/format.js';
import { decodeRunLogKey, workoutKey } from '../lib/keys.js';
import { readJsonObject } from '../lib/data-store.js';
import { notifyError } from '../lib/notify.js';
import { saveWithRetry } from '../lib/storage.js';
import { computeTRIMP } from '../lib/trimp.js';
import { batchMap, sleep } from '../lib/utils.js';
import { renderRunHistory } from './history-view.js';
import { renderCurrentWeek, renderNav } from './nav.js';
import { renderBikeProgress } from './progress-view.js';
import { loadWorkoutLog, renderWeek } from './week-view.js';

export async function openPerformPicker(weekN, dayTag){
  const w = state.WEEKS.find(x=>x.n===weekN);
  if(!w) return;
  const listEl = document.getElementById('performPickerList');
  listEl.innerHTML = '<div class="note">Loading...</div>';
  document.getElementById('performPickerModal').classList.add('open');
  document.getElementById('overlay').classList.add('open');
  const candidates = [];
  for(const d of w.days){
    if(d.type==='race') continue;
    const log = await loadWorkoutLog(weekN, d.tag);
    if(!(log && (log.completed||log.skipped||log.swapped||log.moved))){
      candidates.push(d);
    }
  }
  if(!candidates.length){
    listEl.innerHTML = '<div class="note">No unresolved planned sessions this week.</div>';
    return;
  }
  listEl.innerHTML = candidates.map(d=>
    '<button class="log-toggle" style="display:block; width:100%; text-align:left; margin-bottom:6px;" onclick="choosePerformedSession('+weekN+',\''+d.tag+'\',\''+dayTag+'\')">'+d.tag+' - '+d.name+'</button>'
  ).join('');
}

export function closePerformPicker(){
  document.getElementById('performPickerModal').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
}

export async function openReschedulePicker(weekN, dayTag, sessionName){
  const w = state.WEEKS.find(x=>x.n===weekN);
  if(!w) return;
  const listEl = document.getElementById('reschedulePickerList');
  listEl.innerHTML = '<div class="note">Loading...</div>';
  document.getElementById('reschedulePickerModal').classList.add('open');
  document.getElementById('overlay').classList.add('open');
  const fullList = getFullWeekDayList(w);
  const candidates = fullList.filter(d=>d.tag!==dayTag);
  if(!candidates.length){
    listEl.innerHTML = '<div class="note">No other days this week.</div>';
    return;
  }
  const labeled = [];
  for(const d of candidates){
    let label = d.type==='open' ? 'Open' : d.name;
    const log = await loadWorkoutLog(weekN, d.tag);
    if(log && log.completed) label += ' (already logged)';
    labeled.push({tag:d.tag, label});
  }
  listEl.innerHTML = labeled.map(item=>
    '<button class="log-toggle" style="display:block; width:100%; text-align:left; margin-bottom:6px;" onclick="confirmReschedule('+weekN+',\''+dayTag+'\',\''+item.tag+'\')">'+item.tag+' - '+item.label+'</button>'
  ).join('');
}

export function closeReschedulePicker(){
  document.getElementById('reschedulePickerModal').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
}

export async function confirmReschedule(weekN, dayTag, toTag){
  closeReschedulePicker();
  const id = workoutKey(weekN, dayTag);
  // Fall back to storage, not just {}, when the cache is cold - otherwise this silently
  // drops whatever else was saved on this key (see saveWorkoutLog for the same fix).
  let obj = (await loadWorkoutLog(weekN, dayTag)) || {};
  obj.rescheduled = true;
  obj.rescheduledToTag = toTag;
  await saveWithRetry(id, obj, false);
  state.recentSaveCache[id] = obj;
  if(state.view==='history') renderRunHistory(); else if(state.view==='plan') renderWeek(state.currentWeek);
}

export async function choosePerformedSession(sourceWeekN, sourceDayTag, targetDayTag){
  closePerformPicker();
  const sourceId = workoutKey(sourceWeekN, sourceDayTag);
  let sourceObj = (await loadWorkoutLog(sourceWeekN, sourceDayTag)) || {};
  sourceObj.performedOnTag = targetDayTag;
  await saveWithRetry(sourceId, sourceObj, false);
  state.recentSaveCache[sourceId] = sourceObj;
  if(state.view==='history') renderRunHistory(); else if(state.view==='plan') renderWeek(state.currentWeek);
}

export function toggleBikeProfile(open){
  document.getElementById('bikeProfileModal').classList.toggle('open', open);
  document.getElementById('overlay').classList.toggle('open', open);
  if(open){
    document.getElementById('bp-ftp').value = state.bikeProfile.ftp||'';
    document.getElementById('bp-thr').value = state.bikeProfile.thr||'';
    document.getElementById('bp-status').innerText='';
  }
}

export async function saveBikeProfileFromForm(){
  state.bikeProfile.ftp = document.getElementById('bp-ftp').value;
  state.bikeProfile.thr = document.getElementById('bp-thr').value;
  document.getElementById('bp-status').innerText = 'Saving...';
  try{
    await saveWithRetry('bike-profile', state.bikeProfile, false);
    document.getElementById('bp-status').innerText = 'Saved.';
    renderCurrentWeek();
  }catch(e){
    document.getElementById('bp-status').innerText = 'Could not save (' + (e.message||'unknown error') + ') - try again.';
  }
}

export function openGlobalAddWorkout(){
  state.pendingSwapLink = null;
  toggleFreeWorkout(true);
}

export function openAddWorkoutForDay(weekN, dayTag){
  state.pendingSwapLink = null;
  toggleFreeWorkout(true);
  const dDate = parseDayTagDate(dayTag);
  if(dDate){
    const dateEl = document.getElementById('fw-date');
    if(dateEl) dateEl.value = dDate.toISOString().slice(0,10);
  }
}

export function openSwapWorkout(weekN, dayTag, sessionName){
  state.pendingSwapLink = {weekN, dayTag, sessionName};
  toggleFreeWorkout(true);
  const banner = document.getElementById('fw-swapbanner');
  if(banner) banner.innerHTML = 'Replacing: <b>'+sessionName+'</b> (this planned session will be marked as swapped, not left pending) - <a href="#" onclick="pendingSwapLink=null; this.parentElement.style.display=\'none\'; return false;" style="color:var(--dim);">remove link</a>';
  if(banner) banner.style.display = 'block';
}

export function toggleFreeWorkout(open){
  document.getElementById('freeWorkoutModal').classList.toggle('open', open);
  document.getElementById('overlay').classList.toggle('open', open);
  if(open){
    document.getElementById('fw-date').value = new Date().toISOString().slice(0,10);
    document.getElementById('fw-status').innerText = '';
    document.getElementById('fw-stravastatus').innerHTML = '';
    state.freeWorkoutStravaCache = null;
    if(!state.pendingSwapLink){
      const banner = document.getElementById('fw-swapbanner');
      if(banner) banner.style.display = 'none';
    }
  } else {
    state.pendingSwapLink = null;
  }
}

export function toggleMetrics(open){
  document.getElementById('metricsModal').classList.toggle('open', open);
  document.getElementById('overlay').classList.toggle('open', open);
  if(open){
    document.getElementById('dm-date').value = new Date().toISOString().slice(0,10);
    document.getElementById('dm-status').innerText='';
    prefillMetricsForm();
  }
}

export async function prefillMetricsForm(){
  const date = document.getElementById('dm-date').value;
  const latest = await getLatestDailyEntry(date);
  const fields = {sleep:'dm-sleep', readiness:'dm-readiness', hrv:'dm-hrv', hrvStatus:'dm-hrvstatus', trainingStatus:'dm-trainingstatus', notes:'dm-notes'};
  document.getElementById('dm-context').value = '';
  Object.keys(fields).forEach(k=>{
    document.getElementById(fields[k]).value = latest ? (latest[k]||'') : '';
  });
  const status = document.getElementById('dm-status');
  status.innerHTML = latest ? ('Pre-filled from your last check-in for this date, logged at <b>'+(latest.time||'earlier')+'</b> - only change what\'s different.') : '';
}

export async function getLatestDailyEntry(date){
  try{
    const r = await window.storage.get('dmetrics-'+calendarWeekKey(date), false);
    if(!r) return null;
    const blob = JSON.parse(r.value);
    return blob[date] || null;
  }catch(e){ return null; }
}

export async function maybeSaveTrainingStatus(formId){
  const el = document.getElementById(formId+'-trainingstatus');
  if(!el || !el.value) return;
  const today = new Date().toISOString().slice(0,10);
  const latest = await getLatestDailyEntry(today) || {};
  latest.trainingStatus = el.value;
  latest.time = new Date().toTimeString().slice(0,5);
  const key = 'dmetrics-'+calendarWeekKey(today);
  const read = await readJsonObject(key);
  if(!read.ok) return;
  const blob = read.value;
  blob[today] = latest;
  try{ await saveWithRetry(key, blob, false); }
  catch(e){ notifyError('Could not save training status - try again.'); }
}

export function findDayForDate(dateStr){
  const target = new Date(dateStr+'T00:00:00').toDateString();
  for(const w of state.WEEKS){
    const fullList = getFullWeekDayList(w);
    for(const d of fullList){
      const pd = parseDayTagDate(d.tag);
      if(pd && pd.toDateString()===target) return {weekN: w.n, day: d};
    }
  }
  return null;
}

export async function saveFreeWorkout(){
  const date = document.getElementById('fw-date').value;
  const statusEl = document.getElementById('fw-status');
  if(!date){ statusEl.innerHTML = 'Pick a date first.'; return; }
  const found = findDayForDate(date);
  if(!found){ statusEl.innerHTML = 'That date is outside the current training block - pick a date within the plan.'; return; }
  const activityType = document.getElementById('fw-type').value;
  const name = document.getElementById('fw-name').value || activityType;
  const distance = document.getElementById('fw-dist').value;
  const durationMin = parseDurationToMinutes(document.getElementById('fw-dur').value);
  const obj = {
    completed: true, freeform: true,
    completedAt: new Date(date+'T12:00:00').toISOString(),
    activityType, name,
    actualDist: distance, actualDur: durationMin,
    avgHR: document.getElementById('fw-avghr').value,
    rpe: document.getElementById('fw-rpe').value,
    teAero: document.getElementById('fw-teaero').value,
    teAnaero: document.getElementById('fw-teanaero').value,
    conditions: document.getElementById('fw-conditions').value,
    notes: document.getElementById('fw-notes').value
  };
  if(state.freeWorkoutStravaCache) obj.stravaImport = state.freeWorkoutStravaCache;
  if(state.pendingSwapLink) obj.replacesPlannedDay = {weekN: state.pendingSwapLink.weekN, dayTag: state.pendingSwapLink.dayTag, sessionName: state.pendingSwapLink.sessionName};
  statusEl.innerHTML = 'Saving...';
  try{
    const targetId = workoutKey(found.weekN, found.day.tag);
    await saveWithRetry(targetId, obj, false);
    state.recentSaveCache[targetId] = obj;
    await updateLastActivityDate(obj.completedAt);
    if(state.pendingSwapLink){
      const swapId = workoutKey(state.pendingSwapLink.weekN, state.pendingSwapLink.dayTag);
      let plannedObj = state.recentSaveCache[swapId] || {};
      plannedObj.swapped = true;
      plannedObj.completed = false;
      plannedObj.swappedForName = name+(distance?(' ('+distance+'km)'):'');
      plannedObj.swappedAt = new Date().toISOString();
      await saveWithRetry(swapId, plannedObj, false);
      state.recentSaveCache[swapId] = plannedObj;
    }
    statusEl.innerHTML = 'Saved - the coach is taking a look.';
    autoCoachMessage('freeworkout', {obj});
    state.freeWorkoutStravaCache = null;
    setTimeout(()=>{ toggleFreeWorkout(false); if(state.view==='plan') renderWeek(state.currentWeek); }, 900);
  }catch(e){
    statusEl.innerHTML = 'Could not save (' + (e.message||'unknown error') + ') - your entries are still here, try again.';
  }
}

// saveFreeWorkout actually writes free workouts into the same workout-w{N}-{dayTag}
// keyspace as any other logged day (marked with freeform:true), not a separate
// 'freeworkouts-{weekKey}' collection - so this scans that real keyspace and filters,
// rather than reading a key nothing has ever written to.
export async function loadFreeWorkouts(){
  let entries = [];
  try{
    const list = await window.storage.list('workout-w', false);
    if(list && list.keys){
      const decodedList = list.keys.map(k=>({k, decoded:decodeRunLogKey(k)})).filter(x=>x.decoded);
      const results = await batchMap(decodedList, 6, async x=>{
        let entry = state.recentSaveCache[x.k];
        if(!entry){
          try{ const r = await window.storage.get(x.k, false); if(r) entry = JSON.parse(r.value); }catch(e){}
        }
        if(!entry || !entry.freeform) return null;
        const date = entry.completedAt ? entry.completedAt.slice(0,10) : null;
        if(!date) return null;
        return {
          weekN: x.decoded.weekN, dayTag: x.decoded.day.tag, date,
          activityType: entry.activityType, name: entry.name,
          distance: entry.actualDist, duration: entry.actualDur, avgHR: entry.avgHR,
          rpe: entry.rpe, teAero: entry.teAero, teAnaero: entry.teAnaero,
          conditions: entry.conditions, notes: entry.notes
        };
      });
      results.forEach(r=>{ if(r) entries.push(r); });
    }
  }catch(e){}
  entries.sort((a,b)=> a.date.localeCompare(b.date));
  return entries;
}

const FW_STRAVA_TYPE_MAP = {Run:'Run', TrailRun:'Run', VirtualRun:'Run', Ride:'Bike', VirtualRide:'Bike', Swim:'Swim'};

// No Claude call needed here at all - name/type/distance/duration/avgHR come straight
// from Strava's own activity data, and TRIMP is a fixed formula (see lib/trimp.js),
// not a judgment call. Free, and more accurate than an LLM approximating it.
export async function importFreeWorkoutFromStrava(btnEl){
  const date = document.getElementById('fw-date').value;
  const statusEl = document.getElementById('fw-stravastatus');
  if(!date){ statusEl.innerHTML = '<div class="note">Pick a date first.</div>'; return; }
  const origText = btnEl.innerText;
  btnEl.disabled = true; btnEl.innerText = 'Checking...'; btnEl.style.opacity = '0.6';
  statusEl.innerHTML = '<div class="note">Checking Strava...</div>';
  try{
    const dDate = new Date(date+'T00:00:00');
    const afterSec = Math.floor(dDate.getTime()/1000) - 3600;
    const beforeSec = afterSec + 2*86400;
    const activities = await stravaListActivities(afterSec, beforeSec);
    const sameDate = activities.filter(a => a.start_date_local && a.start_date_local.slice(0,10)===date);
    if(!sameDate.length){
      statusEl.innerHTML = '<div class="note">No Strava activity found for that date - fill in manually.</div>';
      return;
    }
    if(sameDate.length===1){
      await applyFreeWorkoutStravaChoice(sameDate[0]);
    } else {
      state.stravaCandidatesCache['freeworkout'] = sameDate;
      statusEl.innerHTML = renderFreeWorkoutStravaPicker(sameDate);
    }
  }catch(e){
    statusEl.innerHTML = '<div class="note">Could not reach Strava (' + (e.message||'unknown error') + ') - fill in manually.</div>';
  }finally{
    btnEl.disabled = false; btnEl.innerText = origText; btnEl.style.opacity = '';
  }
}

function renderFreeWorkoutStravaPicker(activities){
  const rows = activities.map(a=>{
    const detail = [a.distance_km?(a.distance_km+'km'):'', a.moving_time_min?(Math.round(a.moving_time_min)+'min'):''].filter(Boolean).join(' &middot; ');
    return '<button class="ghost-btn" style="display:block; width:100%; text-align:left; margin-top:6px; padding:8px 10px;" onclick="selectFreeWorkoutStrava('+a.id+')"><b>'+(a.name||'Activity')+'</b> ('+(a.type||'')+')<br><span style="color:var(--dim); font-size:11px;">'+detail+'</span></button>';
  }).join('');
  return '<div class="note" style="border-top:none; padding-top:0;">Multiple activities that day - which one?</div>'+rows;
}

export async function selectFreeWorkoutStrava(activityId){
  const candidates = state.stravaCandidatesCache['freeworkout'] || [];
  const chosen = candidates.find(a=>a.id===activityId);
  if(chosen) await applyFreeWorkoutStravaChoice(chosen);
}

async function applyFreeWorkoutStravaChoice(activity){
  const statusEl = document.getElementById('fw-stravastatus');
  statusEl.innerHTML = '<div class="note">Loading...</div>';
  let trimp = null;
  try{
    const streams = await stravaGetStreams(activity.id);
    trimp = computeTRIMP(streams, state.profile);
  }catch(e){}
  const parsed = {
    activityName: activity.name, sportType: activity.type,
    totalDistanceKm: activity.distance_km, totalDurationMin: activity.moving_time_min,
    avgHR: activity.average_heartrate, estimatedTRIMP: trimp,
  };
  state.freeWorkoutStravaCache = parsed;
  if(parsed.totalDistanceKm) document.getElementById('fw-dist').value = parsed.totalDistanceKm;
  if(parsed.totalDurationMin) document.getElementById('fw-dur').value = formatMinutesToClock(parsed.totalDurationMin);
  if(parsed.avgHR) document.getElementById('fw-avghr').value = Math.round(parsed.avgHR);
  if(parsed.activityName && !document.getElementById('fw-name').value) document.getElementById('fw-name').value = parsed.activityName;
  if(parsed.sportType && FW_STRAVA_TYPE_MAP[parsed.sportType]) document.getElementById('fw-type').value = FW_STRAVA_TYPE_MAP[parsed.sportType];
  statusEl.innerHTML = '<div class="note" style="color:var(--easy);">Imported: '+parsed.activityName+(parsed.estimatedTRIMP?(' - TRIMP ~'+parsed.estimatedTRIMP+' (estimated)'):'')+'</div>';
}

export async function saveDailyMetrics(){
  const date = document.getElementById('dm-date').value;
  const obj = {
    time: new Date().toTimeString().slice(0,5),
    context: document.getElementById('dm-context').value,
    sleep:document.getElementById('dm-sleep').value, readiness:document.getElementById('dm-readiness').value,
    hrv:document.getElementById('dm-hrv').value, hrvStatus:document.getElementById('dm-hrvstatus').value,
    trainingStatus:document.getElementById('dm-trainingstatus').value,
    notes:document.getElementById('dm-notes').value
  };
  document.getElementById('dm-status').innerHTML = 'Saving...';
  const key = 'dmetrics-'+calendarWeekKey(date);
  const read = await readJsonObject(key);
  if(!read.ok){
    document.getElementById('dm-status').innerHTML = 'Could not save - existing data for this week looked corrupted, so nothing was overwritten. Your entries are still here, try again.';
    return;
  }
  const blob = read.value;
  blob[date] = obj;
  try{
    await saveWithRetry(key, blob, false);
    document.getElementById('dm-status').innerHTML = 'Logged at <b>'+obj.time+'</b>. If anything changes before tonight\'s run, log again - I\'ll always use your most recent check-in.';
    autoCoachMessage('metrics', obj);
  }catch(e){ document.getElementById('dm-status').innerHTML = 'Could not save (' + (e.message||'unknown error') + ') - your entries are still here, try again.'; }
}

export function closeAll(){
  document.getElementById('chatPanel').classList.remove('open');
  document.getElementById('profileModal').classList.remove('open');
  document.getElementById('metricsModal').classList.remove('open');
  document.getElementById('bikeProfileModal').classList.remove('open');
  document.getElementById('freeWorkoutModal').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
}

export function toggleProfile(open){
  document.getElementById('profileModal').classList.toggle('open', open);
  document.getElementById('overlay').classList.toggle('open', open);
  if(open){
    document.getElementById('pf-lthr').value = state.profile.lthr;
    document.getElementById('pf-ltpace').value = fmtPace(state.profile.ltPaceSec).replace('/km','');
    document.getElementById('pf-maxhr').value = state.profile.maxHR;
    document.getElementById('pf-resthr').value = state.profile.restHR;
    document.getElementById('pf-vo2').value = state.profile.vo2max;
    document.getElementById('pf-status').innerText='';
  }
}

export async function saveProfileFromForm(){
  const lthr = parseFloat(document.getElementById('pf-lthr').value);
  if(lthr) state.profile.lthr = lthr;
  const paceStr = document.getElementById('pf-ltpace').value;
  if(paceStr && paceStr.includes(':')){ const parts=paceStr.split(':').map(Number); state.profile.ltPaceSec = parts[0]*60+parts[1]; }
  const maxhr = parseFloat(document.getElementById('pf-maxhr').value); if(maxhr) state.profile.maxHR = maxhr;
  const resthr = parseFloat(document.getElementById('pf-resthr').value); if(resthr) state.profile.restHR = resthr;
  const vo2 = parseFloat(document.getElementById('pf-vo2').value); if(vo2) state.profile.vo2max = vo2;
  document.getElementById('pf-status').innerText = 'Saving...';
  try{
    await saveWithRetry('profile', state.profile, false);
    let history = [];
    try{ const r = await window.storage.get('profile-history', false); if(r) history = JSON.parse(r.value); }catch(e){}
    history.push({date:new Date().toISOString().slice(0,10), lthr:state.profile.lthr, ltPaceSec:state.profile.ltPaceSec, maxHR:state.profile.maxHR, vo2max:state.profile.vo2max, restHR:state.profile.restHR});
    await saveWithRetry('profile-history', history, false);
  }catch(e){
    document.getElementById('pf-status').innerText = 'Could not save (' + (e.message||'unknown error') + ') - try again.';
    return;
  }
  state.Z = computeZones(state.profile);
  state.WEEKS = await applyPlanOverrides(buildWeeks());
  renderNav();
  if(state.view==='history'){ if(state.appMode==='bike') renderBikeProgress(); else renderRunHistory(); } else { renderCurrentWeek(); }
  document.getElementById('pf-status').innerText = 'Saved - zones and paces updated.';
  autoCoachMessage('profile', state.profile);
}

window.openPerformPicker = openPerformPicker;
window.closePerformPicker = closePerformPicker;
window.openReschedulePicker = openReschedulePicker;
window.closeReschedulePicker = closeReschedulePicker;
window.confirmReschedule = confirmReschedule;
window.choosePerformedSession = choosePerformedSession;
window.toggleBikeProfile = toggleBikeProfile;
window.saveBikeProfileFromForm = saveBikeProfileFromForm;
window.openGlobalAddWorkout = openGlobalAddWorkout;
window.openAddWorkoutForDay = openAddWorkoutForDay;
window.openSwapWorkout = openSwapWorkout;
window.toggleFreeWorkout = toggleFreeWorkout;
window.toggleMetrics = toggleMetrics;
window.prefillMetricsForm = prefillMetricsForm;
window.saveFreeWorkout = saveFreeWorkout;
window.importFreeWorkoutFromStrava = importFreeWorkoutFromStrava;
window.selectFreeWorkoutStrava = selectFreeWorkoutStrava;
window.saveDailyMetrics = saveDailyMetrics;
window.closeAll = closeAll;
window.toggleProfile = toggleProfile;
window.saveProfileFromForm = saveProfileFromForm;
