import { state } from '../state.js';
import { autoCoachMessage, loadCoachNotes } from '../coach/chat.js';
import { goalTrackerHTML, load10KGoalTrackerData, loadGoalTrackerData } from '../coach/goal-trajectory.js';
import { importFromStrava, renderStravaConfirmation } from '../coach/strava-import.js';
import { appendEfficiencyPoint, appendTrendPoint, loadTierEstimate, updateLastActivityDate } from '../coach/tier-estimates.js';
import { copyWeekPreviewRebuild, generateWeekPreview, getWeekPreview } from '../coach/weekly-summary.js';
import { WHY, WHY_BIKE, bikeEquivalent, bikeSessionName, computeBikeZones, threshold, vo2max } from '../data/plan.js';
import { calendarWeekKey, getFullWeekDayList, parseDayTagDate, weekHasEnded } from '../lib/dates.js';
import { distTime, fmtDuration5, fmtPace, fmtTime, fmtTime5, formatMinutesToClock, paceToKmh, parseDurationToMinutes, parsePaceLabelToSec } from '../lib/format.js';
import { bikeWorkoutKey, workoutKey } from '../lib/keys.js';
import { saveWithRetry } from '../lib/storage.js';
import { coachSessionNoteHTML, expandableNoteHTML, renderRunHistory } from './history-view.js';
import { maybeSaveTrainingStatus, openAddWorkoutForDay, openPerformPicker, openReschedulePicker, openSwapWorkout, toggleBikeProfile } from './modals.js';
import { goToBikeVersion, setAppMode } from './nav.js';
import { renderBikeProgress } from './progress-view.js';

export function setCardMode(id, m){
  state.cardModeOverride[id] = m;
  if(state.appMode!=='run') return;
  if(state.view==='plan') renderWeek(state.currentWeek);
  else if(state.view==='history') renderRunHistory();
}

export function segRow(name, detail){ return '<div class="seg-row"><div class="seg-name">'+name+'</div><div class="seg-detail">'+detail+'</div></div>'; }

export function computeOptimalHR(d, zoneKey){
  if(d.optimalHR) return d.optimalHR; // explicit override always wins - set via a coach-requested intensity adjustment
  const lthr = state.profile.lthr, maxHR = state.profile.maxHR;
  const zk = zoneKey || d.zone;
  if(zk==='GOAL') return 170;
  if(zk==='RACE10K') return 180;
  if(zk==='S1') return Math.round(lthr*0.72);
  if(zk==='S2') return Math.round(lthr*0.83); // lower-mid of easy zone - genuinely conversational, not creeping toward moderate
  if(zk==='S3') return Math.round(lthr*0.92);
  if(zk==='S4') return Math.round(lthr*0.975); // mid-zone, controlled sub-threshold - not pinned at the top
  if(zk==='S5') return Math.round(lthr + (maxHR-lthr)*0.72); // solidly upper-S5, hard but not absolute max
  return Math.round(lthr*0.83);
}

export function zoneBarHTML(optimalHR){
  const lthr = state.profile.lthr, maxHR = state.profile.maxHR;
  const bounds = {S1:[lthr*0.65, lthr*0.80], S2:[lthr*0.80, lthr*0.89], S3:[lthr*0.89, lthr*0.95], S4:[lthr*0.95, lthr*1.00], S5:[lthr*1.00, Math.max(maxHR, lthr*1.08)]};
  const colors = {S1:'#8B95A0', S2:'#6FA8DC', S3:'#5FA85F', S4:'#E8A33D', S5:'#D64550'};
  const totalLow = bounds.S1[0], totalHigh = bounds.S5[1], totalRange = totalHigh-totalLow;
  let segs = '', labels = '';
  ['S1','S2','S3','S4','S5'].forEach((z,i)=>{
    const widthPct = ((bounds[z][1]-bounds[z][0])/totalRange*100).toFixed(1);
    segs += '<div style="flex:'+widthPct+' 0 0; background:'+colors[z]+';"></div>';
    labels += '<div style="flex:'+widthPct+' 0 0; text-align:center; overflow:hidden;">Z'+(i+1)+'</div>';
  });
  const markerPct = Math.max(1, Math.min(99, ((optimalHR-totalLow)/totalRange*100))).toFixed(1);
  return '<div style="margin-top:10px; margin-bottom:4px;">'+
    '<div style="position:relative;">'+
      '<div style="height:8px; border-radius:4px; overflow:hidden; display:flex;">'+segs+'</div>'+
      '<div style="position:absolute; top:-3px; left:calc('+markerPct+'% - 6px); width:12px; height:12px; border-radius:50%; background:var(--text); border:2px solid var(--bg);"></div>'+
    '</div>'+
    '<div style="display:flex; font-size:9px; color:var(--dim); margin-top:4px;">'+labels+'</div>'+
    '<div style="font-size:9px; color:var(--text); font-weight:700; margin-top:3px;">&#9679; '+optimalHR+' optimal</div>'+
  '</div>';
}

export function actualVsPlannedHTML(existing){
  if(!existing || !existing.completed) return '';
  const parts = [];
  if(existing.actualDist) parts.push(existing.actualDist+' km');
  if(existing.actualDur) parts.push(formatMinutesToClock(existing.actualDur));
  if(existing.avgHR) parts.push('avg '+existing.avgHR+'bpm');
  if(!parts.length) return '';
  return '<div class="note" style="border-top:none; padding-top:0; margin-top:8px;"><b style="color:var(--easy);">Actual:</b> '+parts.join(' - ')+(existing.actualNote?(' ('+existing.actualNote+')'):'')+'</div>';
}

export async function unskipSession(id, weekN, dayTag){
  try{
    let obj = state.recentSaveCache[id] || {};
    obj.skipped = false;
    obj.skipReason = '';
    delete obj.skippedAt;
    await saveWithRetry(id, obj);
    state.recentSaveCache[id] = obj;
    if(state.view==='history') renderRunHistory(); else renderWeek(state.currentWeek);
  }catch(e){
    console.error('unskip failed', e);
  }
}

export async function unswapSession(id, weekN, dayTag){
  try{
    let obj = state.recentSaveCache[id] || {};
    obj.swapped = false;
    obj.swappedForName = '';
    delete obj.swappedAt;
    await saveWithRetry(id, obj);
    state.recentSaveCache[id] = obj;
    if(state.view==='history') renderRunHistory(); else renderWeek(state.currentWeek);
  }catch(e){
    console.error('unswap failed', e);
  }
}

export function toggleSkipForm(id){
  const form = document.getElementById(id+'-skipform');
  if(form) form.style.display = form.style.display==='none' ? 'block' : 'none';
}

export async function submitSkip(id, weekN, dayTag){
  const reasonEl = document.getElementById(id+'-skipreason');
  const statusEl = document.getElementById(id+'-skipstatus');
  const reason = reasonEl ? reasonEl.value.trim() : '';
  if(!reason){
    if(statusEl) statusEl.innerText = 'Add a quick reason first - even one sentence helps the coach judge whether this matters.';
    return;
  }
  if(statusEl) statusEl.innerText = 'Saving...';
  try{
    let obj = state.recentSaveCache[id] || {};
    obj.skipped = true;
    obj.skipReason = reason;
    obj.skippedAt = new Date().toISOString();
    obj.completed = false;
    await saveWithRetry(id, obj);
    state.recentSaveCache[id] = obj;
    if(state.view==='history') renderRunHistory(); else renderWeek(state.currentWeek);
    const week = state.WEEKS.find(w=>w.n===weekN);
    const day = week ? week.days.find(d=>d.tag===dayTag) : null;
    if(day) autoCoachMessage('skip', {day, weekN, reason});
  }catch(e){
    console.error('skip save failed', e);
    if(statusEl) statusEl.innerText = 'Could not save (' + (e.message||'unknown error') + ') - try again.';
  }
}

export async function saveWorkoutLog(weekN, dayTag){
  const id = workoutKey(weekN, dayTag);
  const statusEl = document.getElementById(id+'-logstatus');
  if(statusEl) statusEl.innerText = 'Saving...';
  try{
    const obj = readLogForm(id);
    obj.completed = true;
    if(state.stravaImportCache[id]) obj.stravaImport = state.stravaImportCache[id];
    if(obj.stravaImport && obj.stravaImport.activityDateISO && /^\d{4}-\d{2}-\d{2}$/.test(obj.stravaImport.activityDateISO)){
      obj.completedAt = new Date(obj.stravaImport.activityDateISO+'T12:00:00').toISOString();
    } else {
      obj.completedAt = new Date().toISOString();
    }
    await updateLastActivityDate(obj.completedAt);
    obj.performedMode = state.cardModeOverride[id] || state.mode;
    await saveWithRetry(id, obj);
    state.recentSaveCache[id] = obj;
    if(statusEl) statusEl.innerText = 'Saved.';
    await maybeSaveTrainingStatus(id);
    const week = state.WEEKS.find(w=>w.n===weekN);
    const day = week ? week.days.find(d=>d.tag===dayTag) : null;
    if(day && day.type==='easy'){
      let speedKmh = null, hr = null, source = 'unknown';
      const workLap = (obj.stravaImport && Array.isArray(obj.stravaImport.laps)) ? obj.stravaImport.laps.find(l=>l.role==='work' && l.avgPaceLabel && l.avgHR) : null;
      if(workLap){
        const paceSec = parsePaceLabelToSec(workLap.avgPaceLabel);
        if(paceSec) speedKmh = 3600/paceSec;
        hr = workLap.avgHR;
        if(workLap.paceSource) source = workLap.paceSource;
      } else if(obj.actualDist && obj.actualDur && obj.avgHR){
        const distKm = parseFloat(obj.actualDist), durHr = parseFloat(obj.actualDur)/60;
        if(distKm>0 && durHr>0){ speedKmh = distKm/durHr; hr = parseFloat(obj.avgHR); }
      }
      if(obj.manualDataSource) source = obj.manualDataSource;
      if(speedKmh && hr>0){
        await appendEfficiencyPoint(new Date().toISOString().slice(0,10), speedKmh/hr, hr, speedKmh, source);
      }
    }
    if(obj.stravaImport && Array.isArray(obj.stravaImport.laps)){
      const workLaps = obj.stravaImport.laps.filter(l=>l.role==='work' && l.timeToTargetSec!=null);
      const recoveryLaps = obj.stravaImport.laps.filter(l=>(l.role==='recovery'||l.role==='cooldown') && l.recoveryHRDropBpm!=null);
      const today = new Date().toISOString().slice(0,10);
      if(workLaps.length){
        const avgTTT = workLaps.reduce((s,l)=>s+l.timeToTargetSec,0)/workLaps.length;
        await appendTrendPoint('timetotarget-history', today, {value:Math.round(avgTTT), sessionType:day.type, sampleSize:workLaps.length});
      }
      if(recoveryLaps.length){
        const avgDrop = recoveryLaps.reduce((s,l)=>s+l.recoveryHRDropBpm,0)/recoveryLaps.length;
        await appendTrendPoint('hrrecovery-history', today, {value:Math.round(avgDrop*10)/10, sessionType:day.type, sampleSize:recoveryLaps.length});
      }
      if(obj.performedMode==='treadmill' && obj.treadmillLTSpeed){
        const wearableLap = obj.stravaImport.laps.find(l=>l.role==='work' && l.avgPaceLabel);
        if(wearableLap){
          const wearablePaceSec = parsePaceLabelToSec(wearableLap.avgPaceLabel);
          const treadmillPaceSec = Math.round(3600/parseFloat(obj.treadmillLTSpeed));
          if(wearablePaceSec!=null && treadmillPaceSec>0){
            await appendTrendPoint('indoor-wearable-calibration', today, {
              offsetSec: wearablePaceSec - treadmillPaceSec,
              source: wearableLap.paceSource||'unknown',
              treadmillPaceSec, wearablePaceSec
            });
          }
        }
      }
    }
    if(state.view==='history') renderRunHistory(); else renderWeek(state.currentWeek);
    if(day) autoCoachMessage('workout', {day, weekN, obj});
  }catch(e){
    console.error('save failed', e);
    if(statusEl) statusEl.innerText = 'Could not save (' + (e.message||'unknown error') + '). Your entries are still here - tap Save to try again.';
  }
}

export async function toggleCardExpand(id){
  if(state.toggleInProgress) return;
  state.toggleInProgress = true;
  state.expandedCards[id] = !state.expandedCards[id];
  try{
    if(state.appMode==='run'){
      if(state.view==='plan') await renderWeek(state.currentWeek);
      else if(state.view==='history') await renderRunHistory();
    }
  }finally{
    state.toggleInProgress = false;
  }
}

export async function loadFreeWorkoutsForPlanWeek(w){
  if(!w.days.length) return [];
  const firstDate = parseDayTagDate(w.days[0].tag);
  const lastDate = parseDayTagDate(w.days[w.days.length-1].tag);
  if(!firstDate || !lastDate) return [];
  const keys = new Set([calendarWeekKey(firstDate), calendarWeekKey(lastDate)]);
  let entries = [];
  for(const key of keys){
    try{
      const r = await window.storage.get('freeworkouts-'+key, false);
      if(r){ const arr = JSON.parse(r.value); entries = entries.concat(arr); }
    }catch(e){}
  }
  const startStr = firstDate.toISOString().slice(0,10);
  const endStr = lastDate.toISOString().slice(0,10);
  return entries.filter(fw => fw.date >= startStr && fw.date <= endStr);
}

export async function loadWorkoutLog(weekN, dayTag){
  const id = workoutKey(weekN, dayTag);
  if(state.recentSaveCache[id]) return state.recentSaveCache[id];
  try{ const r = await window.storage.get(id, false); return r ? JSON.parse(r.value) : null; }
  catch(e){ return null; }
}

export function toggleLogForm(id){ document.getElementById(id+'-form').classList.toggle('open'); }

export async function renderDay(d, weekN, allNotes, skipRedirectCheck){
  const id = workoutKey(weekN, d.tag);
  const effectiveMode = state.cardModeOverride[id] || state.mode;
  const existing = await loadWorkoutLog(weekN, d.tag);
  if(!skipRedirectCheck && existing && existing.performedOnTag && existing.performedOnTag!==d.tag){
    const pillClassR = d.type==='threshold'?'z-threshold':d.type==='vo2max'?'z-vo2':d.type==='long'?'z-long':d.type==='race'?'z-race':'z-easy';
    return '<div class="card" style="border:1.5px solid rgba(124,147,168,0.4); background:rgba(124,147,168,0.05);">'+
      '<div class="card-top"><div><div class="day-tag">'+d.tag+'</div><div class="sess-name">&#8594; '+d.name+'</div></div>'+
      '<div class="zone-pill '+pillClassR+'">'+d.zone+'</div></div>'+
      '<div class="note" style="margin-top:6px; padding-top:0; border-top:none; color:var(--dim);">Performed on '+existing.performedOnTag+' instead</div>'+
      '</div>';
  }
  const sessionNote = (allNotes||[]).find(n=> n.weekN===weekN && n.dayTag===d.tag) || null;
  let crossInfo = null;
  if(!existing || !existing.completed){
    const bikeKey = bikeWorkoutKey(weekN, d.tag);
    let bikeExisting = state.recentSaveCache[bikeKey];
    if(!bikeExisting){ try{ const r = await window.storage.get(bikeKey, false); bikeExisting = r ? JSON.parse(r.value) : null; }catch(e){} }
    if(bikeExisting && bikeExisting.completed) crossInfo = '&#10003; Done as bike instead';
  }
  let html = '<div class="card"><div class="card-top"><div><div class="day-tag">'+d.tag+'</div><div class="sess-name">'+d.name+'</div></div>';
  const pillClass = d.type==='threshold'?'z-threshold':d.type==='vo2max'?'z-vo2':d.type==='long'?'z-long':d.type==='race'?'z-race':'z-easy';
  html += '<div class="zone-pill '+pillClass+'">'+d.zone+'</div></div>';
  const isCompleted = existing && existing.completed;
  const isSkipped = existing && existing.skipped;
  const isSwapped = existing && existing.swapped;
  const isExpanded = state.expandedCards[id];
  if(d.type==='open' && !existing){
    return '<div class="card"><div class="card-top"><div><div class="day-tag">'+d.tag+'</div><div class="sess-name">Open day</div></div></div>'+
      '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">'+
        '<button class="log-toggle" onclick="openAddWorkoutForDay('+weekN+',\''+d.tag+'\')">Add workout</button>'+
        '<button class="log-toggle" onclick="openPerformPicker('+weekN+',\''+d.tag+'\')">Perform planned workout</button>'+
      '</div></div>';
  }
  if((isCompleted||isSkipped||isSwapped) && !isExpanded){
    const statParts = [];
    if(isSkipped){
      statParts.push(existing.skipReason ? (existing.skipReason.length>60 ? existing.skipReason.slice(0,60)+'...' : existing.skipReason) : 'No reason given');
    } else if(isSwapped){
      statParts.push(existing.swappedForName || 'Did something different');
    } else {
      if(existing.rpe) statParts.push('RPE '+existing.rpe);
      if(existing.avgHR) statParts.push(existing.avgHR+'bpm avg');
      if(existing.actualDist) statParts.push(existing.actualDist+'km');
    }
    const statLine = statParts.length ? statParts.join(' &middot; ') : (isSkipped ? 'Skipped' : 'Logged');
    const icon = isSkipped ? '&#8856;' : isSwapped ? '&#8644;' : '&#10003;';
    const frameColor = isSkipped ? 'rgba(124,147,168,0.5)' : isSwapped ? 'rgba(193,80,46,0.5)' : 'rgba(95,168,160,0.55)';
    const frameBg = isSkipped ? 'rgba(124,147,168,0.06)' : isSwapped ? 'rgba(193,80,46,0.06)' : 'rgba(95,168,160,0.07)';
    return '<div class="card" style="cursor:pointer; border:1.5px solid '+frameColor+'; background:'+frameBg+';" onclick="toggleCardExpand(\''+id+'\')">'+
      '<div class="card-top"><div><div class="day-tag">'+d.tag+'</div><div class="sess-name">'+icon+' '+d.name+'</div></div>'+
      '<div class="zone-pill '+pillClass+'">'+d.zone+'</div></div>'+
      '<div class="note" style="margin-top:8px; padding-top:0; border-top:none; display:flex; justify-content:space-between; align-items:center; gap:10px;"><span>'+statLine+'</span><span style="color:var(--threshold); font-size:11px; font-weight:700; white-space:nowrap;">Tap for details &#9660;</span></div>'+
      '</div>';
  }
  if((isCompleted||isSkipped) && isExpanded){
    html += '<div style="margin-top:-6px; margin-bottom:8px;"><button class="ghost-btn" style="padding:4px 10px; font-size:11px;" onclick="toggleCardExpand(\''+id+'\')">&#9650; Collapse</button></div>';
  }
  const expRPE = expectedRPEFor(d.type);
  if(expRPE) html += '<div class="note" style="margin-top:0; padding-top:0; border-top:none; margin-bottom:10px;">Expected RPE: <b style="color:var(--text);">'+expRPE+'</b></div>';
  if(d.type!=='race'){
    html += '<div style="display:flex; gap:8px; align-items:center; margin-bottom:12px;">'+
      '<div class="toggle" style="transform:scale(0.85); transform-origin:left;">'+
      '<button class="'+(effectiveMode==='outdoor'?'on':'')+'" onclick="setCardMode(\''+id+'\',\'outdoor\')" style="padding:6px 12px;">Outdoor</button>'+
      '<button class="'+(effectiveMode==='treadmill'?'on':'')+'" onclick="setCardMode(\''+id+'\',\'treadmill\')" style="padding:6px 12px;">Treadmill</button>'+
      '</div>'+
      '<button class="log-toggle" style="margin:0;" onclick="goToBikeVersion('+weekN+',\''+d.tag+'\')">View as bike &#8594;</button>'+
      '</div>';
  }

  if(d.type==='easy'){
    const primary = effectiveMode==='treadmill'
      ? '<span class="num">'+fmtDuration5(d.data.timeSec)+'</span><span class="lbl">Duration</span>'
      : '<span class="num">'+d.data.km+' km</span><span class="lbl">Distance</span>';
    html += '<div class="totals"><div>'+primary+'</div>';
    html += '<div><span class="num">'+state.Z.S2.hr+'</span><span class="lbl">bpm target</span></div>';
    if(effectiveMode==='treadmill') html += '<div><span class="num">~'+paceToKmh(state.Z.S2.pace)+'</span><span class="lbl">km/h</span></div>';
    html += '</div>';
    html += zoneBarHTML(computeOptimalHR(d, 'S2'));
    if(d.data.strides) html += '<div class="segments">'+segRow('Strides', d.data.strides+' x 20s, in the final km - relaxed build to fast, walk/jog back to recover')+'</div>';
    if(effectiveMode==='treadmill') html += '<div class="note">Treadmill: run by duration and HR, incline ~1%. Speed shown is a starting point - adjust to hold the HR target.</div>';
  }
  if(d.type==='threshold' || d.type==='vo2max'){
    const dat = d.data;
    if(effectiveMode==='treadmill'){
      html += '<div class="totals"><div><span class="num">'+fmtDuration5(dat.totalSec)+'</span><span class="lbl">Duration</span></div>';
      html += '<div><span class="num">'+state.Z[d.zone].hr+'</span><span class="lbl">bpm target</span></div>';
      html += '<div><span class="num">~'+paceToKmh(dat.main.paceSpk)+'</span><span class="lbl">km/h (main set)</span></div></div>';
    } else {
      html += '<div class="totals"><div><span class="num">'+dat.totalKm+' km</span><span class="lbl">Distance</span></div>';
      html += '<div><span class="num">'+fmtDuration5(dat.totalSec)+'</span><span class="lbl">Duration</span></div></div>';
    }
    html += zoneBarHTML(computeOptimalHR(d));
    html += '<div class="segments">';
    html += segRow('Warm-up', (effectiveMode==='treadmill' ? dat.wu.time+' - ~'+paceToKmh(state.Z.S1.pace)+'km/h' : dat.wu.km+' km - '+dat.wu.time)+' - '+state.Z.S1.hr+'bpm');
    const mainDetail = effectiveMode==='treadmill'
      ? '~'+paceToKmh(dat.main.paceSpk)+'km/h @ '+state.Z[d.zone].hr+'bpm - '+dat.main.recoverySec+'s '+dat.main.recoveryLabel+' recovery break between reps'
      : dat.main.pace+' @ '+state.Z[d.zone].hr+'bpm - '+dat.main.recoverySec+'s '+dat.main.recoveryLabel+' recovery break between reps';
    const mainLabel = effectiveMode==='treadmill' ? dat.main.reps+' x '+dat.main.repTime : dat.main.label;
    html += segRow(mainLabel, mainDetail);
    html += segRow('Cool-down', (effectiveMode==='treadmill' ? dat.cd.time+' - ~'+paceToKmh(state.Z.S1.pace)+'km/h' : dat.cd.km+' km - '+dat.cd.time)+' - '+state.Z.S1.hr+'bpm');
    html += '</div>';
    if(effectiveMode==='treadmill') html += '<div class="note">Treadmill: run each interval by time at target HR, incline ~1%. Speeds shown are a starting point - adjust to hold the HR target. Overall duration target is rounded to the nearest 5 min - the interval times above are exact.</div>';
    if(effectiveMode==='treadmill'){
      const tier3Est = await loadTierEstimate(3);
      const isVo2 = d.type==='vo2max';
      const suggested = tier3Est && (isVo2 ? tier3Est.suggestedNextVO2Speed : tier3Est.suggestedNextSpeed);
      const isContinuous = dat.main.reps <= 1;
      let windowDesc, suggestedLabel;
      if(isContinuous && !isVo2){
        const totalMin = dat.main.repTimeSec/60;
        const startMin = Math.round(totalMin/3);
        const endMin = Math.round(totalMin*0.9);
        windowDesc = 'hold steady from roughly minute '+startMin+' to minute '+endMin+' of this '+Math.round(totalMin)+'-minute effort (skipping the first third to let HR fully settle - the same principle behind the standard 30-min field-test protocol - and stopping before any finishing kick in the last stretch)';
        suggestedLabel = 'from minute '+startMin+' to '+endMin;
      } else {
        windowDesc = 'note the treadmill\'s finishing speed on work rep 2 (not rep 1 - HR hasn\'t caught up yet; not the last rep - fatigue drift skews it)'+(isVo2 ? ', only if this was genuinely a hard, near-max effort (HR close to max, RPE 8-9+) - a lighter effort won\'t give a valid estimate' : '');
        suggestedLabel = 'on work rep 2';
      }
      const boxLabel = isVo2 ? 'For VO2max tracking:' : 'For LT tracking:';
      html += '<div class="note" style="background:rgba(212,162,76,0.1); border-color:rgba(212,162,76,0.3);"><b style="color:#D4A24C;">'+boxLabel+'</b> '+(suggested
        ? ('try holding <b>'+suggested+' km/h</b> '+suggestedLabel+' - refined from your last session\'s result. ')
        : '')+windowDesc+', only if you held it steady rather than adjusting. Log it in the field below'+(suggested ? ' - this suggestion gets more accurate as you log more sessions' : '')+'.</div>';
    }
  }
  if(d.type==='long'){
    const dat = d.data;
    const peakZone = dat.segments[dat.segments.length-1].zone;
    if(effectiveMode==='treadmill'){
      html += '<div class="totals"><div><span class="num">'+fmtDuration5(dat.totalSec)+'</span><span class="lbl">Duration</span></div>';
      html += '<div><span class="num">'+state.Z[peakZone].hr+'</span><span class="lbl">peak bpm target</span></div>';
      html += '<div><span class="num">~'+paceToKmh(state.Z[peakZone].pace)+'</span><span class="lbl">peak km/h</span></div></div>';
    } else {
      html += '<div class="totals"><div><span class="num">'+dat.totalKm+' km</span><span class="lbl">Distance</span></div>';
      html += '<div><span class="num">'+fmtDuration5(dat.totalSec)+'</span><span class="lbl">Duration</span></div></div>';
    }
    dat.segments.forEach((s,i)=>{
      html += '<div style="font-size:10.5px; color:var(--dim); margin-top:'+(i===0?'10px':'14px')+'; margin-bottom:0;">'+(s.zone==='GOAL'?'Goal pace segment':'Zone '+s.zone+' segment')+' ('+s.km+'km)</div>';
      html += zoneBarHTML(computeOptimalHR(d, s.zone));
    });
    html += '<div class="long-seg-bar">';
    dat.segments.forEach(s=>{
      const w = (s.km/dat.totalKm*100).toFixed(1);
      const bg = s.zone==='GOAL'?'var(--vo2)':s.zone==='S3'?'var(--threshold)':'var(--long)';
      const label = effectiveMode==='treadmill' ? fmtTime(distTime(s.km, state.Z[s.zone].pace)) : s.km+'km';
      html += '<div style="width:'+w+'%; background:'+bg+';">'+label+'</div>';
    });
    html += '</div><div class="segments">';
    dat.segments.forEach(s=>{
      const detail = effectiveMode==='treadmill'
        ? fmtTime(distTime(s.km, state.Z[s.zone].pace))+' - '+state.Z[s.zone].hr+'bpm - ~'+paceToKmh(state.Z[s.zone].pace)+'km/h'
        : s.km+'km - '+state.Z[s.zone].hr+'bpm - ~'+fmtPace(state.Z[s.zone].pace);
      html += segRow(s.zone==='GOAL'?'Goal pace':'Zone '+s.zone, detail);
    });
    html += '</div>';
    if(effectiveMode==='treadmill') html += '<div class="note">Treadmill: hold each segment by duration and HR, incline ~1%. Overall duration target is rounded to the nearest 5 min - segment times above are exact.</div>';
  }
  if(d.type==='race'){
    html += '<div class="totals"><div><span class="num">'+d.data.km+' km</span><span class="lbl">Distance</span></div>';
    html += '<div><span class="num">'+d.data.goalTime+'</span><span class="lbl">Goal</span></div>';
    html += '<div><span class="num">'+d.data.goalPaceLabel+'</span><span class="lbl">Target pace</span></div></div>';
  }
  if(d.note) html += '<div class="note">'+d.note+'</div>';
  if(d.changeNote) html += '<div class="change-note"><b>Updated '+(d.changeDate||'')+':</b> '+d.changeNote+'</div>';
  html += actualVsPlannedHTML(existing);
  html += coachSessionNoteHTML(sessionNote);

  const w = WHY[d.type] || WHY.easy;
  html += '<div class="why-block"><p><b>Why:</b> '+w.why+'</p><p><b>Tip:</b> '+w.tip+'</p></div>';

  html += completionRow(id, existing, crossInfo, d, weekN);
  const runIsInterval = d.type==='threshold'||d.type==='vo2max';
  const runDistanceNote = effectiveMode==='treadmill' ? 'optional, treadmill is duration-based' : (runIsInterval ? 'optional, secondary to RPE/HR for judging intervals' : null);
  const showStravaImport = runIsInterval || d.type==='long' || d.type==='easy';
  let logFormHtml = '';
  let effectiveStravaImport = null;
  if(showStravaImport){
    if(runIsInterval){
      const m = d.data.main;
      state.sessionStructureCache[id] = m.label+' at approximately '+(m.pace||'')+', separated by '+m.recoverySec+'s '+m.recoveryLabel+' recovery, with an easy warmup before and cooldown after - the work reps should be noticeably faster/harder than the warmup, cooldown, and recovery portions.';
      state.sessionTargetCache[id] = {pace: m.pace||'', hr: state.Z[d.zone] ? state.Z[d.zone].hr : ''};
    } else if(d.type==='long'){
      const segDesc = d.data.segments.map(s=>s.km+'km at zone '+s.zone).join(', then ');
      state.sessionStructureCache[id] = 'A continuous long run with no discrete reps, building through effort zones: '+segDesc+' - pace should gradually increase through these segments, not show interval-style rep/recovery alternation.';
      const peakZ = d.data.segments[d.data.segments.length-1].zone;
      state.sessionTargetCache[id] = {pace: state.Z[peakZ] ? fmtPace(state.Z[peakZ].pace) : '', hr: state.Z[peakZ] ? state.Z[peakZ].hr : ''};
    } else if(d.type==='easy'){
      state.sessionStructureCache[id] = 'A single continuous easy run at conversational effort - no discrete reps or recovery segments, no built-in warmup structure, just one steady aerobic zone from shortly after the start to shortly before the end.';
      state.sessionTargetCache[id] = {pace: '', hr: state.Z.S2 ? state.Z.S2.hr : ''};
    }
    effectiveStravaImport = state.stravaImportCache[id] || (existing && existing.stravaImport);
    logFormHtml += '<button class="log-toggle" style="margin-bottom:10px;" onclick="importFromStrava(this,\''+id+'\',\''+d.tag+'\',\''+d.name.replace(/'/g,"")+'\')">'+(effectiveStravaImport ? 'Re-import from Strava' : 'Import from Strava')+'</button>';
    logFormHtml += '<div id="'+id+'-stravastatus">'+(effectiveStravaImport ? renderStravaConfirmation(effectiveStravaImport) : '')+'</div>';
  }
  logFormHtml += logFormFields(id, existing, runIsInterval, runDistanceNote, expectedRPEFor(d.type));
  if(effectiveMode==='outdoor'){
    const currentSource = existing && existing.manualDataSource ? existing.manualDataSource : '';
    logFormHtml += '<div class="log-field" style="grid-column:1/-1; margin-top:8px;"><label>Distance/pace source</label><select id="'+id+'-datasource">'+
      '<option value=""'+(currentSource===''?' selected':'')+'>Not sure / mixed</option>'+
      '<option value="gps"'+(currentSource==='gps'?' selected':'')+'>GPS watch</option>'+
      '<option value="stryd"'+(currentSource==='stryd'?' selected':'')+'>Stryd</option>'+
      '</select></div>';
  }
  if(effectiveMode==='treadmill' && (d.type==='threshold' || d.type==='vo2max')){
    const isVo2 = d.type==='vo2max';
    const isContinuous = d.data.main.reps <= 1;
    let speedLabel, speedPlaceholder;
    if(isContinuous && !isVo2){
      const totalMin = d.data.main.repTimeSec/60;
      const startMin = Math.round(totalMin/3);
      const endMin = Math.round(totalMin*0.9);
      speedLabel = 'Treadmill speed - min '+startMin+' to '+endMin+' (km/h)';
      speedPlaceholder = 'only if held steady across that window';
    } else {
      speedLabel = 'Treadmill speed - finish of work rep 2 (km/h)';
      speedPlaceholder = isVo2 ? 'only if genuinely near-max effort, held steady' : 'only if held steady, not adjusted, during that rep';
    }
    logFormHtml += '<div class="log-field" style="grid-column:1/-1; margin-top:8px;"><label>'+speedLabel+'</label><input type="number" step="0.1" placeholder="'+speedPlaceholder+'" id="'+id+'-treadspeed" value="'+(existing&&existing.treadmillLTSpeed||'')+'"></div>';
  }
  html += '<div class="log-form" id="'+id+'-form">'+logFormHtml+'<button class="save-btn" onclick="saveWorkoutLog('+weekN+',\''+d.tag+'\')">Save</button><div class="logged-summary" id="'+id+'-logstatus"></div></div>';
  html += '</div>';
  return html;
}

export function completionRow(id, existing, crossInfo, d, weekN){
  let html = '';
  if(crossInfo) html += '<div class="note" style="margin-top:10px; padding-top:0; border-top:none;"><b style="color:var(--easy);">'+crossInfo+'</b></div>';
  if(existing && existing.completed){
    let label = '&#10003; Completed';
    if(existing.performedMode) label += ' (as '+existing.performedMode+' run)';
    html += '<div class="completed-row"><span class="completed-badge">'+label+'</span>'+
      '<button class="log-toggle" style="margin-top:0;" onclick="toggleLogForm(\''+id+'\')">Edit log</button></div>';
  } else if(existing && existing.skipped){
    html += '<div class="completed-row"><span class="completed-badge" style="background:rgba(124,147,168,0.18); color:var(--dim);">&#8856; Skipped</span>'+
      '<button class="log-toggle" style="margin-top:0;" onclick="unskipSession(\''+id+'\','+weekN+',\''+d.tag+'\')">Undo skip</button></div>'+
      '<div class="note" style="margin-top:6px; padding-top:0; border-top:none;"><b>Reason:</b> '+expandableNoteHTML(existing.skipReason||'')+'</div>';
  } else if(existing && existing.swapped){
    html += '<div class="completed-row"><span class="completed-badge" style="background:rgba(193,80,46,0.18); color:var(--vo2);">&#8644; Swapped</span>'+
      '<button class="log-toggle" style="margin-top:0;" onclick="unswapSession(\''+id+'\','+weekN+',\''+d.tag+'\')">Undo swap</button></div>'+
      '<div class="note" style="margin-top:6px; padding-top:0; border-top:none;"><b>Did instead:</b> '+expandableNoteHTML(existing.swappedForName||'')+'</div>';
  } else {
    let overdueNote = '';
    let rescheduleNote = '';
    if(d.type!=='open'){
      const dDate = parseDayTagDate(d.tag);
      if(dDate){
        const today = new Date(); today.setHours(0,0,0,0);
        if(dDate < today){
          overdueNote = '<div class="note" style="margin-bottom:8px; padding:8px 10px; background:rgba(232,163,61,0.1); border:1px solid rgba(232,163,61,0.35); border-radius:8px; border-top:1px solid rgba(232,163,61,0.35);"><b style="color:var(--threshold);">Did you do this workout?</b> This day has passed with nothing logged - pick whichever fits below.</div>';
        }
      }
      if(existing && existing.rescheduled && existing.rescheduledToTag){
        rescheduleNote = '<div class="note" style="margin-bottom:8px; padding-top:0; border-top:none; color:var(--dim);">Planning to do this on <b>'+existing.rescheduledToTag+'</b> instead.</div>';
      }
    }
    html += overdueNote+rescheduleNote+'<div style="display:flex; gap:8px; flex-wrap:wrap;">'+
      '<button class="log-toggle" onclick="toggleLogForm(\''+id+'\')">Mark as completed</button>'+
      '<button class="log-toggle" onclick="toggleSkipForm(\''+id+'\')">Skip this session</button>'+
      '<button class="log-toggle" onclick="openSwapWorkout('+weekN+',\''+d.tag+'\',\''+d.name.replace(/'/g,"")+'\')">Do something different instead</button>'+
      (d.type!=='open' ? ('<button class="log-toggle" onclick="openReschedulePicker('+weekN+',\''+d.tag+'\',\''+d.name.replace(/'/g,"")+'\')">Planning to do it on another day</button>') : '')+
      '</div>'+
      '<div id="'+id+'-skipform" class="skip-form" style="display:none; margin-top:10px;">'+
        '<textarea id="'+id+'-skipreason" placeholder="Why are you skipping this? (e.g. short on time, feeling off, travel)" style="width:100%; min-height:60px;"></textarea>'+
        '<div style="margin-top:8px; display:flex; gap:8px; align-items:center;">'+
          '<button class="save-btn" onclick="submitSkip(\''+id+'\','+weekN+',\''+d.tag+'\')">Confirm skip</button>'+
          '<button class="ghost-btn" onclick="toggleSkipForm(\''+id+'\')">Cancel</button>'+
        '</div>'+
        '<div id="'+id+'-skipstatus" style="font-size:11.5px; color:var(--dim); margin-top:6px;"></div>'+
      '</div>';
  }
  return html;
}

export function expectedRPEFor(type){
  const map = {
    easy: '2-4 (conversational)',
    threshold: '6-7 (comfortably hard, sustainable)',
    vo2max: '8-9 (hard, not all-out)',
    long: '3-5 easy portion, up to 6-7 late if progressive',
    race: '7-9 early, building to 9-10 (true max effort) by the finish'
  };
  return map[type] || null;
}

export function logFormFields(id, existing, isInterval, distanceNote, expectedRPE){
  const e = existing||{};
  const avgHrLabel = isInterval
    ? 'Avg HR (optional - skip it for intervals)'
    : 'Avg HR - main set (steady effort, easy to read off your watch)';
  const avgHrPlaceholder = isInterval
    ? 'RPE + Training Effect below already cover this - only fill in if you have it handy'
    : 'whole-session average is fine here';
  const distLabel = distanceNote ? ('Actual distance (km) - '+distanceNote) : 'Actual distance (km)';
  const rpeLabel = expectedRPE ? ('RPE (1-10) - expect '+expectedRPE) : 'RPE (1-10)';
  let h = '<div class="log-grid">';
  h += '<div class="log-field"><label>'+distLabel+'</label><input type="number" step="0.1" id="'+id+'-actualdist" value="'+(e.actualDist||'')+'"></div>';
  h += '<div class="log-field"><label>Actual duration</label><input type="text" placeholder="e.g. 1:32:15 or 45:30" id="'+id+'-actualdur" value="'+formatMinutesToClock(e.actualDur)+'"></div>';
  h += '<div class="log-field"><label>'+avgHrLabel+'</label><input type="number" id="'+id+'-avghr" value="'+(e.avgHR||'')+'" placeholder="'+avgHrPlaceholder+'"></div>';
  if(isInterval){
    h += '<div class="log-field"><label>Rough pace on reps (optional - quick gut-check only)</label><input type="text" placeholder="e.g. felt notably faster/slower - for real per-rep pace + HR, ask Claude for a Strava check instead" id="'+id+'-mainpace" value="'+(e.mainSetPace||'')+'"></div>';
  }
  h += '<div class="log-field" style="grid-column:1/-1;"><label>What actually happened (if different from plan)</label><input type="text" placeholder="e.g. cut it short, ran easy instead, different route" id="'+id+'-actualnote" value="'+(e.actualNote||'')+'"></div>';
  h += '<div class="log-field" style="grid-column:1/-1;"><label>Conditions (optional)</label><input type="text" placeholder="e.g. 24C humid, headwind on the way out, or just skip if unremarkable" id="'+id+'-conditions" value="'+(e.conditions||'')+'"></div>';
  h += '<div class="log-field"><label>'+rpeLabel+'</label><input type="number" min="1" max="10" id="'+id+'-rpe" value="'+(e.rpe||'')+'"></div>';
  h += '<div class="log-field"><label>TE Aerobic</label><input type="number" step="0.1" min="0" max="5" id="'+id+'-teaero" value="'+(e.teAero||'')+'"></div>';
  h += '<div class="log-field"><label>TE Anaerobic</label><input type="number" step="0.1" min="0" max="5" id="'+id+'-teanaero" value="'+(e.teAnaero||'')+'"></div>';
  h += '<div class="log-field"><label>Recovery time remaining (hrs, Garmin\'s accumulated total)</label><input type="number" id="'+id+'-rec" value="'+(e.rec||'')+'"></div>';
  h += '<div class="log-field"><label>Session load</label><input type="number" id="'+id+'-sessionload" value="'+(e.sessionLoad||'')+'"></div>';
  h += '<div class="log-field"><label>Acute load (7-day)</label><input type="number" id="'+id+'-acuteload" value="'+(e.acuteLoad||'')+'"></div>';
  h += '<div class="log-field"><label>Chronic load (28-day, changes slowly - skip unless it moved)</label><input type="number" id="'+id+'-chronicload" value="'+(e.chronicLoad||'')+'"></div>';
  h += '<div class="log-field"><label>Load status</label><select id="'+id+'-loadstatus"><option value="">-</option>';
  ['Low','Optimal','High'].forEach(opt=>{ h += '<option'+(e.loadStatus===opt?' selected':'')+'>'+opt+'</option>'; });
  h += '</select></div>';
  h += '<div class="log-field"><label>Training status (optional, if checking now)</label><select id="'+id+'-trainingstatus"><option value="">-</option>';
  ['Peaking','Productive','Maintaining','Recovery','Unproductive','Detraining','Overreaching'].forEach(opt=>{ h += '<option>'+opt+'</option>'; });
  h += '</select></div>';
  h += '<div class="log-field"><textarea placeholder="How it felt, any pain, anything to flag..." id="'+id+'-notes">'+(e.notes||'')+'</textarea></div>';
  h += '</div>';
  return h;
}

export function readLogForm(id){
  const mainPaceEl = document.getElementById(id+'-mainpace');
  const treadSpeedEl = document.getElementById(id+'-treadspeed');
  const dataSourceEl = document.getElementById(id+'-datasource');
  return {
    actualDist:document.getElementById(id+'-actualdist').value,
    actualDur:parseDurationToMinutes(document.getElementById(id+'-actualdur').value),
    avgHR:document.getElementById(id+'-avghr').value,
    mainSetPace: mainPaceEl ? mainPaceEl.value : '',
    treadmillLTSpeed: treadSpeedEl ? treadSpeedEl.value : '',
    manualDataSource: dataSourceEl ? dataSourceEl.value : '',
    actualNote:document.getElementById(id+'-actualnote').value,
    conditions:document.getElementById(id+'-conditions').value,
    rpe:document.getElementById(id+'-rpe').value,
    teAero:document.getElementById(id+'-teaero').value,
    teAnaero:document.getElementById(id+'-teanaero').value,
    rec:document.getElementById(id+'-rec').value,
    sessionLoad:document.getElementById(id+'-sessionload').value,
    acuteLoad:document.getElementById(id+'-acuteload').value,
    chronicLoad:document.getElementById(id+'-chronicload').value,
    loadStatus:document.getElementById(id+'-loadstatus').value,
    notes:document.getElementById(id+'-notes').value
  };
}

export async function renderBikeDay(d, weekN, allNotes){
  const eq = bikeEquivalent(d);
  if(!eq) return '';
  const bz = computeBikeZones();
  const id = bikeWorkoutKey(weekN, d.tag);
  let existing = null;
  if(state.recentSaveCache[id]){ existing = state.recentSaveCache[id]; }
  else{ try{ const r = await window.storage.get(id, false); existing = r ? JSON.parse(r.value) : null; }catch(e){} }
  const sessionNote = (allNotes||[]).find(n=> n.weekN===weekN && n.dayTag===d.tag) || null;
  let crossInfo = null;
  if(!existing || !existing.completed){
    const runKey = workoutKey(weekN, d.tag);
    let runExisting = state.recentSaveCache[runKey];
    if(!runExisting){ try{ const r = await window.storage.get(runKey, false); runExisting = r ? JSON.parse(r.value) : null; }catch(e){} }
    if(runExisting && runExisting.completed) crossInfo = '&#10003; Done as '+(runExisting.performedMode||'outdoor')+' run instead';
  }

  const bikeName = bikeSessionName(eq.kind);
  let html = '<div class="card"><div class="card-top"><div><div class="day-tag">'+d.tag+' - bike option</div><div class="sess-name">'+bikeName+'</div></div>';
  const pillClass = eq.kind==='threshold'?'z-threshold':eq.kind==='vo2max'?'z-vo2':eq.kind==='long'?'z-long':'z-easy';
  html += '<div class="zone-pill '+pillClass+'">'+eq.zone+'</div></div>';
  const expRPEBike = expectedRPEFor(eq.kind);
  if(expRPEBike) html += '<div class="note" style="margin-top:0; padding-top:0; border-top:none; margin-bottom:10px;">Expected RPE: <b style="color:var(--text);">'+expRPEBike+'</b></div>';

  const peakZone = eq.kind==='long' ? eq.segments[eq.segments.length-1].zone : eq.zone;
  html += '<div class="totals"><div><span class="num">'+fmtDuration5(eq.totalSec)+'</span><span class="lbl">Duration</span></div>';
  html += '<div><span class="num">'+bz[peakZone].hr+'</span><span class="lbl">'+(eq.kind==='long'?'peak bpm target':'bpm target')+'</span></div></div>';

  if(eq.kind==='easy'){
    html += '<div class="segments">'+segRow('Steady spin', fmtTime(eq.totalSec)+' - '+bz[eq.zone].hr+' - ~'+bz[eq.zone].speed)+'</div>';
    if(eq.strides) html += '<div class="segments">'+segRow('Spin-ups', eq.strides+' x 20s fast pedal, final part of the ride - easy spin to recover')+'</div>';
  }
  if(eq.kind==='threshold' || eq.kind==='vo2max'){
    html += '<div class="segments">';
    html += segRow('Warm-up', fmtTime5(eq.wuSec)+' - '+bz.S2.hr+' - ~'+bz.S2.speed);
    html += segRow(eq.reps+' reps', fmtTime5(eq.repSec)+'/rep (duration) @ '+bz[eq.zone].hr+' (~'+bz[eq.zone].speed+') - '+eq.recoverySec+'s easy spin recovery');
    html += segRow('Cool-down', fmtTime5(eq.cdSec)+' - '+bz.S2.hr+' - ~'+bz.S2.speed);
    html += '</div>';
  }
  if(eq.kind==='long'){
    html += '<div class="long-seg-bar">';
    eq.segments.forEach(s=>{
      const w=(s.sec/eq.totalSec*100).toFixed(1);
      const bg = s.zone==='S4'?'var(--vo2)':s.zone==='S3'?'var(--threshold)':'var(--long)';
      html += '<div style="width:'+w+'%; background:'+bg+';">'+fmtTime5(s.sec)+'</div>';
    });
    html += '</div><div class="segments">';
    eq.segments.forEach(s=>{ html += segRow('Zone '+s.zone, fmtTime5(s.sec)+' - '+bz[s.zone].hr+' - ~'+bz[s.zone].speed); });
    html += '</div>';
  }
  html += actualVsPlannedHTML(existing);
  html += coachSessionNoteHTML(sessionNote);

  const w = WHY_BIKE[eq.kind] || WHY_BIKE.easy;
  html += '<div class="why-block"><p><b>Why:</b> '+w.why+'</p><p><b>Tip:</b> '+w.tip+'</p></div>';

  html += completionRow(id, existing, crossInfo, d, weekN);
  html += '<div class="log-form" id="'+id+'-form">'+logFormFields(id, existing, eq.kind==='threshold'||eq.kind==='vo2max', 'optional, duration is what matters for bike', expectedRPEFor(eq.kind))+'<button class="save-btn" onclick="saveBikeEqLog('+weekN+',\''+d.tag+'\')">Save</button><div class="logged-summary" id="'+id+'-logstatus"></div></div>';
  html += '</div>';
  return html;
}

export async function saveBikeEqLog(weekN, dayTag){
  const id = bikeWorkoutKey(weekN, dayTag);
  const statusEl = document.getElementById(id+'-logstatus');
  if(statusEl) statusEl.innerText = 'Saving...';
  try{
    const obj = readLogForm(id);
    obj.completed = true;
    obj.completedAt = new Date().toISOString();
    await saveWithRetry(id, obj);
    state.recentSaveCache[id] = obj;
    if(statusEl) statusEl.innerText = 'Saved.';
    await maybeSaveTrainingStatus(id);
    if(state.view==='history') renderBikeProgress(); else renderBikeWeek(state.currentWeek);
    const week = state.WEEKS.find(w=>w.n===weekN);
    const day = week ? week.days.find(d=>d.tag===dayTag) : null;
    if(day) autoCoachMessage('workout', {day, weekN, eq:bikeEquivalent(day), obj});
  }catch(e){
    console.error('save failed', e);
    if(statusEl) statusEl.innerText = 'Could not save (' + (e.message||'unknown error') + '). Your entries are still here - tap Save to try again.';
  }
}

export function bikeExtrasCard(bz){
  let html = '<div class="card"><div class="card-top"><div><div class="sess-name">HR zones (%HRR)</div></div>'+
    '<button class="ghost-btn" onclick="toggleBikeProfile(true)">Cycling numbers</button></div>';
  html += '<table class="cyc-table"><tr><th>Zone</th><th>%HRR</th><th>HR target</th><th>Typical speed</th><th>Purpose</th></tr>';
  ['S1','S2','S3','S4','S5'].forEach(k=>{
    html += '<tr><td class="cyc-zone">'+k+' '+bz[k].label+'</td><td>'+bz[k].pct+'</td><td>'+bz[k].hr+'</td><td>'+bz[k].speed+'</td><td>'+bz[k].purpose+'</td></tr>';
  });
  html += '</table>';
  html += '<div class="note">Speeds are a generic flat-terrain estimate, not derived from you - you have no logged rides yet. HR is the real target; once you log a few rides, I can swap these for your own actual speeds.</div>';
  if(state.bikeProfile.ftp || state.bikeProfile.thr){
    html += '<div class="note">'+(state.bikeProfile.ftp?('FTP: '+state.bikeProfile.ftp+'W. '):'')+(state.bikeProfile.thr?('Cycling threshold HR: '+state.bikeProfile.thr+'bpm.'):'')+'</div>';
  }
  html += '</div>';
  return html;
}

export async function renderBikeWeek(n){
  state.view = 'plan';
  state.currentWeek = n;
  const myToken = ++state.renderToken;
  const w = state.WEEKS.find(x=>x.n===n);
  const bz = computeBikeZones();
  let allNotes = [];
  try{ allNotes = await loadCoachNotes(); }catch(e){}
  const dayChecks = await Promise.all(w.days.map(async d=>{
    const eq = bikeEquivalent(d);
    if(!eq) return {d, show:false};
    const key = bikeWorkoutKey(n, d.tag);
    let log = state.recentSaveCache[key];
    if(!log){ try{ const r = await window.storage.get(key, false); log = r ? JSON.parse(r.value) : null; }catch(e){} }
    return {d, show: !(log && log.completed)};
  }));
  const visibleDays = dayChecks.filter(x=>x.show).map(x=>x.d);
  let html = '<div class="week-head"><h2>Week '+w.n+' - '+w.dates+' (bike)</h2></div>';
  html += '<button class="ghost-btn" style="margin-bottom:14px;" onclick="setAppMode(\'run\')">&#8592; Back to running plan</button>';
  html += '<div class="callout">Bike equivalents of this week\'s running sessions - same duration and structure, at your cycling HRR zones. Use these as planned cross-training, or as a direct substitute on any day you can\'t run, so fitness keeps building while an injury settles.</div>';
  if(!visibleDays.length){
    html += '<div class="card"><div class="note">No bike sessions logged as completed to hide, or every bike day this week is already done. Check History to review or edit anything.</div></div>';
  }
  if(myToken !== state.renderToken || state.view!=='plan' || state.currentWeek!==n || state.appMode!=='bike') return;
  document.getElementById('weekContent').innerHTML = html;
  const container = document.getElementById('weekContent');
  for(const d of visibleDays){
    const dayHtml = await renderBikeDay(d, w.n, allNotes);
    if(myToken !== state.renderToken || state.view!=='plan' || state.currentWeek!==n || state.appMode!=='bike') return;
    if(dayHtml) container.insertAdjacentHTML('beforeend', dayHtml);
  }
  if(myToken !== state.renderToken || state.view!=='plan' || state.currentWeek!==n || state.appMode!=='bike') return;
  container.insertAdjacentHTML('beforeend', bikeExtrasCard(bz));
}

export async function renderWeek(n){
  state.view='plan';
  state.currentWeek=n;
  const myToken = ++state.renderToken;
  const w = state.WEEKS.find(x=>x.n===n);
  let allNotes = [];
  try{ allNotes = await loadCoachNotes(); }catch(e){}
  const fullDayList = getFullWeekDayList(w);
  const dayChecks = await Promise.all(fullDayList.map(async d=>{
    const log = await loadWorkoutLog(n, d.tag);
    return {d, show:true, log};
  }));
  const visibleDays = dayChecks.map(x=>x.d);
  let weekPlannedKm = 0, weekActualKm = 0, weekHasActual = false;
  dayChecks.forEach(({d, log})=>{
    let plannedKm = 0;
    if(d.type==='easy') plannedKm = d.data.km;
    else if(d.type==='threshold' || d.type==='vo2max' || d.type==='long') plannedKm = parseFloat(d.data.totalKm)||0;
    else if(d.type==='race') plannedKm = d.data.km;
    weekPlannedKm += plannedKm;
    if(log && log.completed){
      weekHasActual = true;
      weekActualKm += log.actualDist ? parseFloat(log.actualDist) : plannedKm;
    }
  });
  weekPlannedKm = Math.round(weekPlannedKm*10)/10;
  weekActualKm = Math.round(weekActualKm*10)/10;
  let html = '<div class="week-head"><h2>Week '+w.n+' - '+w.dates+'</h2><div class="note" style="border-top:none; padding-top:0;">'+weekPlannedKm+' km planned'+(weekHasActual ? (' &middot; '+weekActualKm+' km actual so far') : '')+'</div></div>';
  try{ html += goalTrackerHTML(await loadGoalTrackerData(), 'Goal trajectory - sub-1:35'); }catch(e){ console.error('goal tracker failed', e); }
  try{ html += goalTrackerHTML(await load10KGoalTrackerData(), 'Goal trajectory - 10K sub-43:00'); }catch(e){ console.error('10K goal tracker failed', e); }
  html += '<div class="mileage-bar-wrap">';
  state.WEEKS.forEach(x=>{
    const cls = x.n===n ? 'active' : (x.cutback?'cutback':'');
    html += '<div class="mileage-bar '+cls+'" style="height:'+(30+x.n*4)+'px; cursor:pointer;" onclick="renderWeek('+x.n+')" title="Go to Week '+x.n+'"></div>';
  });
  html += '</div><div class="mileage-labels">';
  state.WEEKS.forEach(x=>{ html += '<span style="cursor:pointer;" onclick="renderWeek('+x.n+')">'+x.n+'</span>'; });
  html += '</div>';
  const prevWeekEnded = n>1 ? weekHasEnded(n-1) : false;
  let weekPreview = (n>1 && prevWeekEnded) ? await getWeekPreview(n) : null;
  if(weekPreview){
    html += '<div class="callout'+(w.race?' raceday':'')+'"><b style="color:var(--threshold);">Since last week:</b> '+weekPreview.text+'</div>';
    if(weekPreview.rebuildText){
      html += '<div class="paste-block"><div class="paste-label">Bring this to the main conversation</div><div class="paste-body">'+weekPreview.rebuildText+'</div><button class="paste-copy-btn" onclick="copyWeekPreviewRebuild('+n+',this)">Copy</button></div>';
    }
  } else if(n>1 && !prevWeekEnded){
    html += '<div class="callout">Week '+n+' is coming up - once Week '+(n-1)+' actually wraps up, I\'ll look back at how it went here.</div>';
  } else if(w.callout){
    html += '<div class="callout'+(w.race?' raceday':'')+'">'+w.callout+'</div>';
  }
  if(!visibleDays.length){
    html += '<div class="card"><div class="note">Everything logged for this week - nice work. Check History to review or edit anything, or head to another week.</div></div>';
  }
  if(myToken !== state.renderToken || state.view!=='plan' || state.currentWeek!==n || state.appMode!=='run') return;
  document.getElementById('weekContent').innerHTML = html;
  if(n>1 && prevWeekEnded && !weekPreview){
    generateWeekPreview(n).then(text=>{
      if(text && myToken===state.renderToken && state.view==='plan' && state.currentWeek===n && state.appMode==='run') renderWeek(n);
    });
  }
  const container = document.getElementById('weekContent');
  for(const d of visibleDays){
    const dayHtml = await renderDay(d, w.n, allNotes);
    if(myToken !== state.renderToken || state.view!=='plan' || state.currentWeek!==n || state.appMode!=='run') return;
    container.insertAdjacentHTML('beforeend', dayHtml);
    for(const other of w.days){
      if(other.tag===d.tag) continue;
      const otherLog = await loadWorkoutLog(w.n, other.tag);
      if(otherLog && otherLog.performedOnTag===d.tag){
        const extraHtml = await renderDay(other, w.n, allNotes, true);
        if(myToken !== state.renderToken || state.view!=='plan' || state.currentWeek!==n || state.appMode!=='run') return;
        container.insertAdjacentHTML('beforeend', extraHtml);
      }
    }
  }
  try{
    const freeWorkoutsThisWeek = await loadFreeWorkoutsForPlanWeek(w);
    if(myToken !== state.renderToken || state.view!=='plan' || state.currentWeek!==n || state.appMode!=='run') return;
    freeWorkoutsThisWeek.forEach(fw=>{
      const fwHtml = '<div class="card" style="border:1.5px solid rgba(212,162,76,0.5); background:rgba(212,162,76,0.06);">'+
        '<div class="card-top"><div><div class="day-tag">'+fw.date+'</div><div class="sess-name">&#10003; '+fw.activityType+(fw.name?(' - '+fw.name):'')+'</div></div>'+
        '<div class="zone-pill" style="background:rgba(212,162,76,0.15); color:#D4A24C;">Extra</div></div>'+
        '<div class="note" style="margin-top:8px; padding-top:0; border-top:none;">'+[fw.distance?(fw.distance+'km'):'', fw.rpe?('RPE '+fw.rpe):'', fw.avgHR?(fw.avgHR+'bpm avg'):''].filter(Boolean).join(' &middot; ')+' - not part of the prescribed plan</div>'+
        '</div>';
      container.insertAdjacentHTML('beforeend', fwHtml);
    });
  }catch(e){ console.error('freeworkout render failed', e); }
}

window.setCardMode = setCardMode;
window.unskipSession = unskipSession;
window.unswapSession = unswapSession;
window.toggleSkipForm = toggleSkipForm;
window.submitSkip = submitSkip;
window.saveWorkoutLog = saveWorkoutLog;
window.toggleCardExpand = toggleCardExpand;
window.toggleLogForm = toggleLogForm;
window.saveBikeEqLog = saveBikeEqLog;
window.renderWeek = renderWeek;
