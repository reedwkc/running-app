import { state } from '../state.js';
import { autoCoachMessage } from '../coach/chat.js';
import { updateLastActivityDate } from '../coach/tier-estimates.js';
import { applyPlanOverrides, buildWeeks, computeZones, vo2max } from '../data/plan.js';
import { calendarWeekKey, getFullWeekDayList, parseDayTagDate } from '../lib/dates.js';
import { fmtPace, formatMinutesToClock, parseDurationToMinutes } from '../lib/format.js';
import { workoutKey } from '../lib/keys.js';
import { saveWithRetry } from '../lib/storage.js';
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
  let obj = state.recentSaveCache[id] || {};
  obj.rescheduled = true;
  obj.rescheduledToTag = toTag;
  await saveWithRetry(id, obj, false);
  state.recentSaveCache[id] = obj;
  if(state.view==='plan') renderWeek(state.currentWeek);
}

export async function choosePerformedSession(sourceWeekN, sourceDayTag, targetDayTag){
  closePerformPicker();
  const sourceId = workoutKey(sourceWeekN, sourceDayTag);
  let sourceObj = state.recentSaveCache[sourceId] || {};
  sourceObj.performedOnTag = targetDayTag;
  await saveWithRetry(sourceId, sourceObj, false);
  state.recentSaveCache[sourceId] = sourceObj;
  if(state.view==='plan') renderWeek(state.currentWeek);
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
  try{
    const key = 'dmetrics-'+calendarWeekKey(today);
    let blob = {};
    try{ const r = await window.storage.get(key, false); if(r) blob = JSON.parse(r.value); }catch(e){}
    blob[today] = latest;
    await saveWithRetry(key, blob, false);
  }catch(e){ console.error('training status save failed', e); }
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

export async function loadFreeWorkouts(){
  let entries = [];
  try{
    const list = await window.storage.list('freeworkouts-', false);
    if(list && list.keys){
      const results = await batchMap(list.keys, 6, async k=>{
        try{ const r = await window.storage.get(k, false); return r ? JSON.parse(r.value) : []; }catch(e){ return []; }
      });
      results.forEach(arr=>{ if(Array.isArray(arr)) entries = entries.concat(arr); });
    }
  }catch(e){}
  entries.sort((a,b)=> a.date.localeCompare(b.date));
  return entries;
}

export async function importFreeWorkoutFromStrava(btnEl){
  const date = document.getElementById('fw-date').value;
  const statusEl = document.getElementById('fw-stravastatus');
  if(!date){ statusEl.innerHTML = '<div class="note">Pick a date first.</div>'; return; }
  const origText = btnEl.innerText;
  btnEl.disabled = true; btnEl.innerText = 'Importing...'; btnEl.style.opacity = '0.6';
  statusEl.innerHTML = '<div class="note">Contacting Strava...</div>';
  const dDate = new Date(date+'T00:00:00');
  const dateStr = dDate.toDateString();
  try{
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2500,
        system: "You have access to the user's Strava account via MCP tools. Work silently: do not narrate what you are doing, do not describe which tools you are calling. Call whatever tools you need first, then produce your final answer. Your entire final text output must be a single valid JSON object and nothing else - no markdown fences, no preamble, no commentary before or after.",
        messages: [{role:"user", content: "Find my Strava activity (any sport) from "+dateStr+". Only return found:true if an activity's recorded date genuinely matches "+dateStr+" - if nothing exists for this exact date, return exactly {\"found\":false}. If found, report its real name, date, sport type, distance, duration, and average HR if available. Also pull the HR stream if it's a running or cycling activity and compute estimatedTRIMP - a Banister-style Training Impulse score using this runner's profile (resting HR "+state.profile.restHR+"bpm, max HR "+state.profile.maxHR+"bpm, LTHR "+state.profile.lthr+"bpm): compute a heart-rate-reserve fraction (HR-rest)/(max-rest) for the stream, apply the standard exponential TRIMP weighting (0.64*e^(1.92*fraction)) per moment, integrate over duration, return the final number only, 2-3 significant figures. Omit this key entirely if no HR stream is available. Return JSON in exactly this shape: {\"found\":true,\"activityName\":\"...\",\"activityDate\":\"e.g. Mon Aug 3\",\"activityDateISO\":\"YYYY-MM-DD, the real recorded date\",\"sportType\":\"Run/Ride/Swim/etc\",\"totalDistanceKm\":0.0,\"totalDurationMin\":0.0,\"avgHR\":0,\"estimatedTRIMP\":0}. Return ONLY the JSON, nothing else, no matter what."}],
        mcp_servers: [{type:"url", url:"https://mcp.strava.com/mcp", name:"strava-mcp"}]
      })
    });
    if(!response.ok) throw new Error('HTTP '+response.status);
    const data = await response.json();
    const textParts = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text);
    let raw = textParts.join('\n').trim().replace(/```json|```/g,'').trim();
    let parsed;
    try{ parsed = JSON.parse(raw); }
    catch(e){
      const fb = raw.indexOf('{'), lb = raw.lastIndexOf('}');
      if(fb!==-1 && lb>fb){ try{ parsed = JSON.parse(raw.slice(fb, lb+1)); }catch(e2){} }
    }
    if(!parsed || !parsed.found){
      statusEl.innerHTML = '<div class="note">No matching Strava activity found for that date - fill in manually.</div>';
      return;
    }
    state.freeWorkoutStravaCache = parsed;
    if(parsed.totalDistanceKm) document.getElementById('fw-dist').value = parsed.totalDistanceKm;
    if(parsed.totalDurationMin) document.getElementById('fw-dur').value = formatMinutesToClock(parsed.totalDurationMin);
    if(parsed.avgHR) document.getElementById('fw-avghr').value = parsed.avgHR;
    if(parsed.activityName && !document.getElementById('fw-name').value) document.getElementById('fw-name').value = parsed.activityName;
    const typeMap = {Run:'Run', Ride:'Bike', Swim:'Swim'};
    if(parsed.sportType && typeMap[parsed.sportType]) document.getElementById('fw-type').value = typeMap[parsed.sportType];
    statusEl.innerHTML = '<div class="note" style="color:var(--easy);">Imported: '+parsed.activityName+(parsed.estimatedTRIMP?(' - TRIMP ~'+parsed.estimatedTRIMP+' (Claude\'s estimate, not device-measured)'):'')+'</div>';
  }catch(e){
    statusEl.innerHTML = '<div class="note">Import failed (' + (e.message||'unknown error') + ') - fill in manually.</div>';
  }finally{
    btnEl.disabled = false; btnEl.innerText = origText; btnEl.style.opacity = '';
  }
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
  try{
    const key = 'dmetrics-'+calendarWeekKey(date);
    let blob = {};
    try{ const r = await window.storage.get(key, false); if(r) blob = JSON.parse(r.value); }catch(e){}
    blob[date] = obj;
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
window.saveDailyMetrics = saveDailyMetrics;
window.closeAll = closeAll;
window.toggleProfile = toggleProfile;
window.saveProfileFromForm = saveProfileFromForm;
