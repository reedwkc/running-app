// @ts-nocheck
import { state } from '../state.js';
import { autoCoachMessage } from '../coach/chat.js';
import { stravaGetStreams, stravaListActivities } from '../coach/api.js';
import { compute10KTrajectoryBaseline, computeHMTrajectoryBaseline, formatAchievabilityNote, isGoalAchievabilityConcerning, parseGoalTimeToSec, recomputeZones } from '../coach/goal-trajectory.js';
import { appendTrendPoint, updateLastActivityDate } from '../coach/tier-estimates.js';
import { applyPlanOverrides, buildWeeks, vo2max } from '../data/plan.js';
import { defaultGoalConfig, findGoalRaceDay, reassignGoalZoneKeys, saveGoalConfig } from '../data/goal-config.js';
import { archiveGoal, goalChangedMaterially } from '../data/goal-history.js';
import { calendarWeekKey, dateToYMD, getFullWeekDayList, parseDayTagDate } from '../lib/dates.js';
import { deleteExtraWorkout, loadAllExtraWorkouts, saveExtraWorkout } from '../lib/extras.js';
import { fmtDuration, fmtPaceExact, formatMinutesToClock, parseDurationToMinutes } from '../lib/format.js';
import { decodeRunLogKey, workoutKey } from '../lib/keys.js';
import { readJsonObject } from '../lib/data-store.js';
import { notifyError } from '../lib/notify.js';
import { saveWithRetry } from '../lib/storage.js';
import { computeSessionTRIMP, computeTRIMP } from '../lib/trimp.js';
import { batchMap, sleep } from '../lib/utils.js';
import { renderBikeProgress, renderRunHistory } from './history-view.js';
import { renderCurrentWeek, renderNav } from './nav.js';
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
    // Only a genuinely completed day is off the table - a skipped or swapped day's
    // planned session should stay reachable to perform on a different day later (that's
    // the whole point of "Perform planned workout"), not retire the moment it's touched
    // at all. `moved` is dead - grepped, nothing in this codebase ever sets it - dropped.
    if(!(log && log.completed)){
      let statusSuffix = '';
      if(log && log.skipped) statusSuffix = ' (currently marked skipped)';
      else if(log && log.swapped) statusSuffix = ' (currently marked swapped)';
      candidates.push({d, statusSuffix});
    }
  }
  if(!candidates.length){
    listEl.innerHTML = '<div class="note">No unresolved planned sessions this week.</div>';
    return;
  }
  listEl.innerHTML = candidates.map(({d, statusSuffix})=>
    '<button class="log-toggle" style="display:block; width:100%; text-align:left; margin-bottom:6px;" onclick="choosePerformedSession('+weekN+',\''+d.tag+'\',\''+dayTag+'\')">'+d.tag+' - '+d.name+statusSuffix+'</button>'
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
  state.pendingRetryLink = null;
  toggleFreeWorkout(true);
}

export function openAddWorkoutForDay(weekN, dayTag){
  state.pendingSwapLink = null;
  state.pendingRetryLink = null;
  toggleFreeWorkout(true);
  const dDate = parseDayTagDate(dayTag);
  if(dDate){
    const dateEl = document.getElementById('fw-date');
    if(dateEl) dateEl.value = dateToYMD(dDate);
  }
}

export function openSwapWorkout(weekN, dayTag, sessionName){
  state.pendingSwapLink = {weekN, dayTag, sessionName};
  state.pendingRetryLink = null;
  toggleFreeWorkout(true);
  const banner = document.getElementById('fw-swapbanner');
  if(banner) banner.innerHTML = 'Replacing: <b>'+sessionName+'</b> (this planned session will be marked as swapped, not left pending) - <a href="#" onclick="pendingSwapLink=null; this.parentElement.style.display=\'none\'; return false;" style="color:var(--dim);">remove link</a>';
  if(banner) banner.style.display = 'block';
}

// Mirrors openReschedulePicker/confirmReschedule below, but for a session that was already
// completed (possibly poorly) - picks a day to attempt it again on, then hands off to the
// free-workout modal with state.pendingRetryLink set, so saveFreeWorkout logs the attempt
// as a new, separate extra workout (see lib/extras.js) tagged retryOfTag back to the
// original day, rather than touching that day's own completed record at all.
export async function openRetryPicker(weekN, dayTag, sessionName){
  const w = state.WEEKS.find(x=>x.n===weekN);
  if(!w) return;
  const listEl = document.getElementById('retryPickerList');
  listEl.innerHTML = '<div class="note">Loading...</div>';
  document.getElementById('retryPickerModal').classList.add('open');
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
  const escapedName = sessionName.replace(/'/g,"\\'");
  listEl.innerHTML = labeled.map(item=>
    '<button class="log-toggle" style="display:block; width:100%; text-align:left; margin-bottom:6px;" onclick="confirmRetry('+weekN+',\''+dayTag+'\',\''+escapedName+'\',\''+item.tag+'\')">'+item.tag+' - '+item.label+'</button>'
  ).join('');
}

export function closeRetryPicker(){
  document.getElementById('retryPickerModal').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
}

export function confirmRetry(weekN, dayTag, sessionName, targetTag){
  closeRetryPicker();
  state.pendingSwapLink = null;
  state.pendingRetryLink = {weekN, dayTag, sessionName};
  toggleFreeWorkout(true);
  const targetDate = parseDayTagDate(targetTag);
  if(targetDate){
    const dateEl = document.getElementById('fw-date');
    if(dateEl) dateEl.value = dateToYMD(targetDate);
  }
  const banner = document.getElementById('fw-swapbanner');
  if(banner){
    banner.innerHTML = 'Retrying: <b>'+sessionName+'</b> (logged as a new, separate workout - the original completed record is untouched) - <a href="#" onclick="event.preventDefault(); toggleRetryLinkOff();" style="color:var(--dim);">remove link</a>';
    banner.style.display = 'block';
  }
}

export function toggleRetryLinkOff(){
  state.pendingRetryLink = null;
  const banner = document.getElementById('fw-swapbanner');
  if(banner) banner.style.display = 'none';
}

export function toggleFreeWorkout(open){
  document.getElementById('freeWorkoutModal').classList.toggle('open', open);
  document.getElementById('overlay').classList.toggle('open', open);
  if(open){
    document.getElementById('fw-date').value = dateToYMD(new Date());
    document.getElementById('fw-status').innerText = '';
    document.getElementById('fw-stravastatus').innerHTML = '';
    state.freeWorkoutStravaCache = null;
    if(!state.pendingSwapLink && !state.pendingRetryLink){
      const banner = document.getElementById('fw-swapbanner');
      if(banner) banner.style.display = 'none';
    }
  } else {
    state.pendingSwapLink = null;
    state.pendingRetryLink = null;
  }
}

export function toggleMetrics(open){
  document.getElementById('metricsModal').classList.toggle('open', open);
  document.getElementById('overlay').classList.toggle('open', open);
  if(open){
    document.getElementById('dm-date').value = dateToYMD(new Date());
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
  const today = dateToYMD(new Date());
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
    conditions: document.getElementById('fw-conditions').value,
    notes: document.getElementById('fw-notes').value
  };
  if(state.freeWorkoutStravaCache) obj.stravaImport = state.freeWorkoutStravaCache;
  if(state.pendingSwapLink) obj.replacesPlannedDay = {weekN: state.pendingSwapLink.weekN, dayTag: state.pendingSwapLink.dayTag, sessionName: state.pendingSwapLink.sessionName};
  statusEl.innerHTML = 'Saving...';
  try{
    if(state.pendingSwapLink){
      // A genuine swap is an intentional 1:1 replacement of what THIS SPECIFIC planned
      // day's session actually was, so it still writes into that day's own workoutKey slot -
      // unchanged from before. Anything that ISN'T a swap goes to the separate extras store
      // below instead, so logging a second (or third...) workout on a day can never silently
      // overwrite whatever's already logged for it - see lib/extras.js.
      const targetId = workoutKey(found.weekN, found.day.tag);
      await saveWithRetry(targetId, obj, false);
      state.recentSaveCache[targetId] = obj;
      await updateLastActivityDate(obj.completedAt);
      const swapId = workoutKey(state.pendingSwapLink.weekN, state.pendingSwapLink.dayTag);
      let plannedObj = state.recentSaveCache[swapId] || {};
      plannedObj.swapped = true;
      plannedObj.completed = false;
      plannedObj.swappedForName = name+(distance?(' ('+distance+'km)'):'');
      plannedObj.swappedAt = new Date().toISOString();
      await saveWithRetry(swapId, plannedObj, false);
      state.recentSaveCache[swapId] = plannedObj;
    } else {
      const extra = Object.assign({}, obj, {date, dayTag: found.day.tag, weekN: found.weekN});
      if(state.pendingRetryLink) extra.retryOfTag = state.pendingRetryLink.dayTag;
      const saved = await saveExtraWorkout(extra);
      if(!saved.ok) throw new Error('could not save extra workout');
      await updateLastActivityDate(obj.completedAt);
      // Same load-tracking contribution saveWorkoutLog makes for a planned day (week-view.js)
      // - trimp-history is a flat, sessionId-deduped array (not one-per-day), so ACWR already
      // sums however many entries share a date with zero changes needed there.
      const sessionTrimp = (obj.stravaImport && obj.stravaImport.estimatedTRIMP!=null)
        ? obj.stravaImport.estimatedTRIMP
        : computeSessionTRIMP(parseFloat(obj.avgHR), parseFloat(obj.actualDur), state.profile);
      if(sessionTrimp!=null) await appendTrendPoint('trimp-history', date, {value: sessionTrimp, sessionId: saved.id});
    }
    statusEl.innerHTML = 'Saved - the coach is taking a look.';
    autoCoachMessage('freeworkout', {obj});
    state.freeWorkoutStravaCache = null;
    state.pendingRetryLink = null;
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
  document.getElementById('planOverrideModal').classList.remove('open');
  document.getElementById('editGoalModal').classList.remove('open');
  document.getElementById('deleteGoalModal').classList.remove('open');
  document.getElementById('newGoalModal').classList.remove('open');
  document.getElementById('retryPickerModal').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
}

export function toggleProfile(open){
  document.getElementById('profileModal').classList.toggle('open', open);
  document.getElementById('overlay').classList.toggle('open', open);
  if(open){
    document.getElementById('pf-lthr').value = state.profile.lthr;
    document.getElementById('pf-ltpace').value = fmtPaceExact(state.profile.ltPaceSec).replace('/km','');
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
    // Full timestamp, not just a date - getBestAvailableLTPace ranks this against
    // tier2/tier3 estimates by exact recency, and a date-only string always parses as
    // midnight UTC, which can make same-day-or-later Tier 2/3 updates lose a same-day
    // recency comparison they should win (or vice versa depending on time of day).
    history.push({date:new Date().toISOString(), lthr:state.profile.lthr, ltPaceSec:state.profile.ltPaceSec, maxHR:state.profile.maxHR, vo2max:state.profile.vo2max, restHR:state.profile.restHR});
    await saveWithRetry('profile-history', history, false);
  }catch(e){
    document.getElementById('pf-status').innerText = 'Could not save (' + (e.message||'unknown error') + ') - try again.';
    return;
  }
  { const r = await recomputeZones(state.profile, state.goalConfig); state.Z = r.Z; state.layoffAdjustment = r.layoffAdjustment; }
  state.WEEKS = await applyPlanOverrides(buildWeeks());
  renderNav();
  if(state.view==='history'){ if(state.appMode==='bike') renderBikeProgress(); else renderRunHistory(); } else { renderCurrentWeek(); }
  document.getElementById('pf-status').innerText = 'Saved - zones and paces updated.';
  autoCoachMessage('profile', state.profile);
}

export function openEditGoalModal(goalId){
  const cfg = state.goalConfig || defaultGoalConfig();
  const goal = (cfg.activeGoals||[]).find(g=>g.goalId===goalId);
  if(!goal) return;
  // Lives on state (like pendingPlanOverride) rather than a bare module-local variable -
  // goalId-keyed (not zoneKey - zoneKey is now a derived, auto-reassigned field, see
  // reassignGoalZoneKeys in data/goal-config.js, not a stable identity) so the modal only
  // ever needs to remember WHICH goal is open, re-reading it from state.goalConfig fresh
  // each time so it can never go stale against a goal that changed elsewhere while open.
  // concerningNewSec is set only once an achievability check on the CURRENT input has
  // already come back concerning and been shown to the runner - lets a second click on the
  // same value skip straight to saving instead of re-running the check (and re-showing the
  // same warning) in a loop; any change to the input, or reopening the modal, goes through
  // a fresh check first.
  state.pendingGoalEdit = {goalId, concerningNewSec: null};
  document.getElementById('editGoalModal').classList.add('open');
  document.getElementById('overlay').classList.add('open');
  document.getElementById('eg-context').innerText = 'Change your target time for the '+(goal.label||'goal')+(goal.raceName?(' ('+goal.raceName+(goal.raceDate?(', '+goal.raceDate):'')+')'):'')+' whenever you feel like it - the plan\'s actual sessions stay scheduled as-is, only the goal (and the goal-pace target sessions are built around) updates.';
  document.getElementById('eg-time').value = (goal.goalTimeLabel||'').replace(/^Sub-/i,'');
  const achEl = document.getElementById('eg-achievability');
  achEl.style.display = 'none';
  achEl.innerHTML = '';
  document.getElementById('eg-status').innerText = '';
  const btn = document.getElementById('eg-save-btn');
  btn.innerText = 'Save';
  btn.style.background = '';
}

export function toggleEditGoalModal(open){
  document.getElementById('editGoalModal').classList.toggle('open', open);
  document.getElementById('overlay').classList.toggle('open', open);
}

// Soft safety net, not a hard block: a candidate time that the existing achievability
// engine (same deterministic classification the post-workout watchdog and plan-override's
// enforcement check already use - see isGoalAchievabilityConcerning in goal-trajectory.js)
// judges as genuinely unreachable at the current trend gets flagged and requires a second
// "Save anyway" click - but it's never refused outright, and an easier/slower goal never
// triggers this at all, since it can only ever read as 'already-there' or 'on-pace'. A goal
// beyond the nearest two (zoneKey null - see reassignGoalZoneKeys) has no achievability
// baseline machinery to check against yet (computeHMTrajectoryBaseline/
// compute10KTrajectoryBaseline are GOAL/RACE10K-specific), so it just saves straight through.
export async function saveGoalEditFromForm(){
  const pending = state.pendingGoalEdit;
  const goalId = pending && pending.goalId;
  const cfg = state.goalConfig || defaultGoalConfig();
  const goal = (cfg.activeGoals||[]).find(g=>g.goalId===goalId);
  const statusEl = document.getElementById('eg-status');
  if(!goal){ statusEl.innerText = 'No active goal to edit.'; return; }
  const timeStr = document.getElementById('eg-time').value.trim();
  const newSec = parseGoalTimeToSec(timeStr);
  if(!newSec || newSec<=0){ statusEl.innerText = 'Enter a valid time, e.g. 1:35:00 or 43:00.'; return; }

  if(pending.concerningNewSec===newSec){
    await commitGoalEdit(goalId, newSec);
    return;
  }

  let baseline = null;
  if(goal.zoneKey==='GOAL' || goal.zoneKey==='RACE10K'){
    statusEl.innerText = 'Checking...';
    try{
      const candidateGoal = Object.assign({}, goal, {goalTimeSec:newSec});
      baseline = goal.zoneKey==='GOAL'
        ? await computeHMTrajectoryBaseline(candidateGoal, (cfg.activeGoals||[]).find(g=>g.zoneKey==='RACE10K'))
        : await compute10KTrajectoryBaseline(candidateGoal);
    }catch(e){ console.error('goal-edit achievability preview failed', e); }
    statusEl.innerText = '';
  }

  const concerning = baseline && baseline.achievability && isGoalAchievabilityConcerning(baseline.achievability);
  if(concerning){
    const achEl = document.getElementById('eg-achievability');
    achEl.style.display = 'block';
    achEl.innerHTML = '<b style="color:#ff6b6b;">Heads up:</b> '+formatAchievabilityNote(baseline.achievability).trim();
    const btn = document.getElementById('eg-save-btn');
    btn.innerText = 'Save anyway';
    btn.style.background = '#ff6b6b';
    pending.concerningNewSec = newSec;
    return;
  }
  pending.concerningNewSec = null;
  await commitGoalEdit(goalId, newSec);
}

async function commitGoalEdit(goalId, newSec){
  const statusEl = document.getElementById('eg-status');
  statusEl.innerText = 'Saving...';
  const cfg = state.goalConfig || defaultGoalConfig();
  const goal = (cfg.activeGoals||[]).find(g=>g.goalId===goalId);
  if(!goal) return;
  const distanceKm = goal.distanceKm || 21.0975;
  // goalPaceSec/goalPaceLabel are the literal RACE-pace target used to prescribe GOAL/
  // RACE10K-zone sessions (goalZonesFromConfig) - direct time/distance, never the LT-pace-
  // equivalent used for gap/achievability math (see the comment on computeHMTrajectoryBaseline
  // about not mixing these two up). Recomputed here so a goal-time edit can't leave prescribed
  // session paces quietly pointing at the OLD target.
  const newPaceSec = Math.round(newSec/distanceKm);
  const newGoal = Object.assign({}, goal, {
    goalTimeSec: newSec,
    goalTimeLabel: 'Sub-'+formatMinutesToClock(newSec/60),
    goalPaceSec: newPaceSec,
    goalPaceLabel: fmtPaceExact(newPaceSec),
  });
  // Editing a TIME never changes raceDate, so it never changes which goal is nearest -
  // no reassignGoalZoneKeys needed here, unlike delete/create below.
  const newCfg = Object.assign({}, cfg, {activeGoals: (cfg.activeGoals||[]).map(g=> g.goalId===goalId ? newGoal : g)});

  if(goalChangedMaterially(goal, newGoal)){
    try{ await archiveGoal(goal, 'superseded', null); }catch(e){ console.error('archiveGoal failed', e); }
  }
  try{
    await applyGoalConfigChange(newCfg);
  }catch(e){
    statusEl.innerText = 'Could not save (' + (e.message||'unknown error') + ') - try again.';
    return;
  }
  statusEl.innerText = 'Saved - goal updated, sessions unchanged.';
  if(state.pendingGoalEdit && state.pendingGoalEdit.goalId===goalId) state.pendingGoalEdit.concerningNewSec = null;
}

// Shared apply sequence for ANY goalConfig change (edit an existing goal, delete one,
// create a new one) - saves the new config, clears the same stale AI-trajectory/watchdog
// caches applyPlanOverride already clears on a real goal change (plan-override.js, since
// they were computed against whatever goal was active before and would otherwise keep
// reading as still-current), recomputes zones, and rebuilds WEEKS from the same templates
// (same sequence a Garmin numbers update already runs) so GOAL/RACE10K-zone session paces
// stay consistent with the new config. Never restructures which sessions exist or when -
// only their pace anchors (real day-by-day restructuring across however many active goals
// is the AI-driven Rebuild-plan flow's job - see the autoCoachMessage('goalset',...) call in
// confirmDeleteGoal/saveNewGoalFromForm, which asks for exactly that as a reviewable
// proposal, never applies it silently). Throws if the save itself fails, so callers can show
// a real error and stop instead of proceeding as if it worked; the cache-clear below is
// best-effort and never blocks the rest of the sequence from completing.
async function applyGoalConfigChange(newCfg){
  // Whichever two goals are nearest by race date drive GOAL/RACE10K session pace
  // prescriptions (plan.js's static template only ever references those two zone keys) -
  // recomputed here, the one place every goalConfig mutation funnels through, so it can
  // never go stale regardless of which caller changed the goal set.
  newCfg = Object.assign({}, newCfg, {activeGoals: reassignGoalZoneKeys(newCfg.activeGoals)});
  await saveGoalConfig(newCfg);
  state.goalConfig = newCfg;
  try{
    await window.storage.delete('goal-trajectory-latest', false); await sleep(150);
    await window.storage.delete('goal-trajectory-10k-latest', false); await sleep(150);
    await window.storage.delete('goal-trajectory-prevpos', false); await sleep(150);
    await window.storage.delete('goal-trajectory-10k-prevpos', false); await sleep(150);
    await window.storage.delete('goal-trajectory-maintenance-latest', false); await sleep(150);
    await window.storage.delete('goal-trajectory-maintenance-prevpos', false); await sleep(150);
    await window.storage.delete('achievability-warning-episodes', false); await sleep(150);
    await window.storage.delete('push-watchdog-episodes', false); await sleep(150);
  }catch(e){ console.error('clearing stale goal-trajectory readings failed', e); }
  { const r = await recomputeZones(state.profile, state.goalConfig); state.Z = r.Z; state.layoffAdjustment = r.layoffAdjustment; }
  state.WEEKS = await applyPlanOverrides(buildWeeks());
  renderNav();
  if(state.view==='history'){ if(state.appMode==='bike') renderBikeProgress(); else renderRunHistory(); } else { renderCurrentWeek(); }
}

export function openDeleteGoalModal(goalId){
  const cfg = state.goalConfig || defaultGoalConfig();
  const goal = (cfg.activeGoals||[]).find(g=>g.goalId===goalId);
  if(!goal) return;
  state.pendingDeleteGoalId = goalId;
  document.getElementById('deleteGoalModal').classList.add('open');
  document.getElementById('overlay').classList.add('open');
  document.getElementById('dg-context').innerText = 'Delete the '+(goal.label||'goal')+(goal.raceName?(' ('+goal.raceName+(goal.raceDate?(', '+goal.raceDate):'')+')'):'')+'? This archives it and stops tracking it - your prescribed training days stay exactly as scheduled. If any of your other active goals should now train differently as a result, I\'ll flag it in chat with a proposal to review, not apply anything automatically.';
  document.getElementById('dg-warning').style.display = 'none';
  document.getElementById('dg-status').innerText = '';
  const btn = document.getElementById('dg-confirm-btn');
  btn.innerText = 'Delete goal';
  btn.style.background = '';
}

export function closeDeleteGoalModal(){
  document.getElementById('deleteGoalModal').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
  state.pendingDeleteGoalId = null;
}

// Always a real two-step confirm (unlike Edit Goal's conditional achievability gate) -
// deleting is consequential regardless of the target time, so the first click just reveals
// the warning and relabels the button; only the second click actually deletes.
export async function confirmDeleteGoal(){
  const goalId = state.pendingDeleteGoalId;
  const cfg = state.goalConfig || defaultGoalConfig();
  const goal = (cfg.activeGoals||[]).find(g=>g.goalId===goalId);
  const statusEl = document.getElementById('dg-status');
  if(!goal){ statusEl.innerText = 'No active goal to delete.'; return; }

  const warningEl = document.getElementById('dg-warning');
  if(warningEl.style.display!=='block'){
    warningEl.style.display = 'block';
    const btn = document.getElementById('dg-confirm-btn');
    btn.innerText = 'Yes, delete this goal';
    btn.style.background = '#ff6b6b';
    return;
  }

  statusEl.innerText = 'Deleting...';
  // A dropped goal whose race day has already passed is a completed goal, not an abandoned
  // one - same distinction and result-capture logic applyPlanOverride uses when the AI-driven
  // rebuild flow drops a goal (plan-override.js), reused here for this deterministic path so
  // the archived record reads the same way regardless of which path dropped it.
  let reason = 'removed', result = null;
  if(goal.raceDate && new Date() > new Date(goal.raceDate)){
    reason = 'completed';
    try{
      const found = findGoalRaceDay(state.WEEKS, goal);
      if(found){
        const log = await loadWorkoutLog(found.week.n, found.day.tag);
        if(log && log.completed && log.actualDist && log.actualDur){
          const actualDurSec = parseFloat(log.actualDur)*60;
          result = {actualDist: parseFloat(log.actualDist), actualDurSec, actualTimeLabel: fmtDuration(actualDurSec)};
        }
      }
    }catch(e){ console.error('goal-history: fetching race result failed', e); }
  }
  try{ await archiveGoal(goal, reason, result); }catch(e){ console.error('archiveGoal failed', e); }

  const newCfg = Object.assign({}, cfg, {activeGoals: (cfg.activeGoals||[]).filter(g=>g.goalId!==goalId)});
  // Same "a goal just went away" block-reset applyPlanOverride uses (plan-override.js) - the
  // adherence window shouldn't keep judging sessions against a goal that no longer exists.
  newCfg.blockStartedAt = new Date().toISOString();

  try{
    await applyGoalConfigChange(newCfg);
  }catch(e){
    statusEl.innerText = 'Could not save (' + (e.message||'unknown error') + ') - try again.';
    return;
  }
  statusEl.innerText = 'Deleted - goal archived, sessions unchanged. Asking the coach whether the remaining goals need a rebuild...';
  // The remaining active goals may now need to build/taper differently with one fewer race
  // to sequence around - never decided deterministically (real periodization judgment), so
  // this asks the coach for a reviewable proposal exactly like any other plan-affecting
  // event, rather than silently restructuring anything.
  try{ autoCoachMessage('goalset', {}); }catch(e){ console.error('goalset coach check failed', e); }
}

// Common-distance labels only affect the display label/type - the number the runner typed
// is always what actually drives the goal math (goalPaceSec, achievability, etc). Anything
// that doesn't land near a standard distance just gets labeled by its own km figure.
function deriveGoalTypeLabel(km){
  if(Math.abs(km-5)<0.3) return {type:'5K', label:'5K'};
  if(Math.abs(km-10)<0.5) return {type:'10K', label:'10K'};
  if(Math.abs(km-15)<0.5) return {type:'15K', label:'15K'};
  if(Math.abs(km-21.0975)<0.5) return {type:'HM', label:'Half Marathon'};
  if(Math.abs(km-42.195)<0.5) return {type:'Marathon', label:'Marathon'};
  return {type:'Custom', label:(Math.round(km*100)/100)+'K'};
}

// No zoneKey/slot argument anymore - a new goal is just added to the list, wherever it lands
// by race date once reassignGoalZoneKeys (in applyGoalConfigChange) sorts it in. Any number
// of goals can be active at once; only the nearest two ever get a live pace-target slot.
export function openNewGoalModal(){
  document.getElementById('newGoalModal').classList.add('open');
  document.getElementById('overlay').classList.add('open');
  document.getElementById('ng-name').value = '';
  document.getElementById('ng-date').value = '';
  document.getElementById('ng-dist').value = '';
  document.getElementById('ng-time').value = '';
  document.getElementById('ng-status').innerText = '';
}

export function closeNewGoalModal(){
  document.getElementById('newGoalModal').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
}

export async function saveNewGoalFromForm(){
  const statusEl = document.getElementById('ng-status');
  const name = document.getElementById('ng-name').value.trim();
  const dateStr = document.getElementById('ng-date').value;
  const distanceKm = parseFloat(document.getElementById('ng-dist').value);
  const timeStr = document.getElementById('ng-time').value.trim();
  const goalTimeSec = parseGoalTimeToSec(timeStr);

  if(!name){ statusEl.innerText = 'Give the race a name.'; return; }
  if(!dateStr){ statusEl.innerText = 'Pick a race date.'; return; }
  if(!distanceKm || distanceKm<=0 || distanceKm>200){ statusEl.innerText = 'Enter a valid distance in km (e.g. 21.0975 for a half marathon).'; return; }
  if(!goalTimeSec || goalTimeSec<=0){ statusEl.innerText = 'Enter a valid goal time, e.g. 1:35:00 or 43:00.'; return; }

  statusEl.innerText = 'Saving...';
  const {type, label} = deriveGoalTypeLabel(distanceKm);
  const goalPaceSec = Math.round(goalTimeSec/distanceKm);
  const cfg = state.goalConfig || defaultGoalConfig();
  const newGoal = {
    goalId: 'goal-'+Date.now()+'-'+Math.random().toString(36).slice(2,6),
    type, zoneKey: null, label,
    raceName: name, distanceKm, raceDate: dateStr,
    goalTimeSec, goalTimeLabel: 'Sub-'+formatMinutesToClock(goalTimeSec/60),
    goalPaceSec, goalPaceLabel: fmtPaceExact(goalPaceSec),
    goalHR: 'n/a',
  };
  const newCfg = Object.assign({}, cfg, {activeGoals: (cfg.activeGoals||[]).concat([newGoal])});
  // Same "this is a new training block" reset applyPlanOverride uses when a goal set changes
  // materially or there was no prior goal at all (plan-override.js) - a brand-new goal has
  // no adherence history against it yet, there's nothing to judge from before it existed.
  newCfg.blockStartedAt = new Date().toISOString();

  try{
    await applyGoalConfigChange(newCfg);
  }catch(e){
    statusEl.innerText = 'Could not save (' + (e.message||'unknown error') + ') - try again.';
    return;
  }
  statusEl.innerText = 'Saved - now tracking this goal. Asking the coach whether the plan needs to rebuild around it...';
  // A second (or third...) active goal genuinely changes how the whole block should be
  // sequenced (build/taper timing across multiple races) - real periodization judgment, not
  // something to decide deterministically, so this asks the coach for a reviewable proposal
  // instead of silently restructuring anything. Same event, same non-blocking fire-and-forget
  // pattern every other autoCoachMessage call in this file already uses.
  try{ autoCoachMessage('goalset', {}); }catch(e){ console.error('goalset coach check failed', e); }
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
window.openRetryPicker = openRetryPicker;
window.closeRetryPicker = closeRetryPicker;
window.confirmRetry = confirmRetry;
window.toggleRetryLinkOff = toggleRetryLinkOff;
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
window.openEditGoalModal = openEditGoalModal;
window.toggleEditGoalModal = toggleEditGoalModal;
window.saveGoalEditFromForm = saveGoalEditFromForm;
window.openDeleteGoalModal = openDeleteGoalModal;
window.closeDeleteGoalModal = closeDeleteGoalModal;
window.confirmDeleteGoal = confirmDeleteGoal;
window.openNewGoalModal = openNewGoalModal;
window.closeNewGoalModal = closeNewGoalModal;
window.saveNewGoalFromForm = saveNewGoalFromForm;
