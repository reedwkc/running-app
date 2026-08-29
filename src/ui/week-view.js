// @ts-nocheck
import { state } from '../state.js';
import { autoCoachMessage, loadCoachNotes } from '../coach/chat.js';
import { aheadOfScheduleBannerHTML, computeAheadOfScheduleSignals, goalTrackerHTML, load10KGoalTrackerData, loadGoalTrackerData, loadMaintenanceTrackerData } from '../coach/goal-trajectory.js';
import { importFromStrava, renderStravaConfirmation } from '../coach/strava-import.js';
import { appendEfficiencyPoint, appendTrendPoint, computeTreadmillCalibrationPoint, layoffAdjustmentBannerHTML, loadTierEstimate, TREADMILL_DEFAULT_INCLINE_PCT, TREADMILL_SPEED_MAX_KMH, TREADMILL_SPEED_MIN_KMH, updateLastActivityDate } from '../coach/tier-estimates.js';
import { copyWeekPreviewRebuild, generateWeekPreview, getWeekPreview } from '../coach/weekly-summary.js';
import { WHY, WHY_BIKE, bikeEquivalent, bikeSessionName, computeBikeZones, computeWeekPlannedKm, threshold, vo2max } from '../data/plan.js';
import { getFullWeekDayList, parseDayTagDate, weekHasEnded } from '../lib/dates.js';
import { deleteExtraWorkout, extraWorkoutsForDay, loadExtraWorkoutsForWeek } from '../lib/extras.js';
import { distTime, fmtDuration5, fmtPace, fmtSecondsLong, fmtTime, fmtTime5, formatMinutesToClock, paceToKmh, parseDurationToMinutes, parsePaceLabelToSec } from '../lib/format.js';
import { bikeWorkoutKey, workoutKey } from '../lib/keys.js';
import { saveWithRetry } from '../lib/storage.js';
import { computeSessionTRIMP } from '../lib/trimp.js';
import { getHardSessionProximityFlags, getLikelySwapSuggestions, getMissedSessionAdjustments, hardSessionProximityBannerHTML, missedSessionBannerHTML, swapSuggestionBannerHTML } from '../coach/plan-adherence.js';
import { coachSessionNoteHTML, expandableNoteHTML, renderBikeProgress, renderRunHistory } from './history-view.js';
import { loadFreeWorkouts, maybeSaveTrainingStatus, openAddWorkoutForDay, openPerformPicker, openReschedulePicker, openSwapWorkout, toggleBikeProfile } from './modals.js';
import { goToBikeVersion, setAppMode } from './nav.js';

// Otherwise these three only ever get recomputed at page load (see main.js) or after a plan
// Apply/revert (see refreshAdherenceState in coach/plan-override.js) - stale the moment a
// session actually gets logged or skipped, since that's exactly the event most likely to
// change all three (a missed-type pattern closing or worsening, a swap becoming detectable,
// two hard sessions landing close together). Best-effort: a failure here shouldn't block
// whatever save already succeeded before this was called.
async function refreshAdherenceBanners(){
  try{
    state.missedSessionAdjustments = await getMissedSessionAdjustments();
    // Must run after missedSessionAdjustments - it reads that for its mutual-exclusion gate.
    state.aheadOfScheduleSignals = await computeAheadOfScheduleSignals();
    state.likelySwapSuggestions = await getLikelySwapSuggestions();
    state.hardSessionProximityFlags = await getHardSessionProximityFlags();
  }catch(e){}
}

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
  // ~95% of Max HR - the standard exercise-physiology benchmark for VO2max-effort HR
  // (literature generally puts true VO2max intensity around 90-100% HRmax). Critically,
  // this is a target for the FINAL rep(s) of a set, not a flat number to hold from rep
  // one - see computeVO2maxBuildStartHR below for why, and don't reuse this as a flat
  // per-rep target the way S1-S4 are used.
  if(zk==='S5') return Math.round(maxHR*0.95);
  return Math.round(lthr*0.83);
}

// VO2max HR realistically climbs across a set of reps, not just within each one: the
// first rep's target is meaningfully lower than the last, both because VO2/HR kinetics
// take longer than a single 3-5min rep to fully catch up to a new, harder effort (beyond
// just the 60-120s per-rep lag already noted elsewhere), and because real cardiac drift
// accumulates rep over rep as the set goes on - this runner's own Aug 10/11 threshold
// data showed exactly this pattern (HR climbing steadily rep to rep at a held pace).
// Treating computeOptimalHR's S5 value as a flat hold-from-rep-one target overstates what
// the first rep or two can safely reach and risks exactly the "burn out early" the
// runner flagged - ~88% Max HR is a realistic opening-rep mark to build up from instead.
export function computeVO2maxBuildStartHR(){
  return Math.round(state.profile.maxHR*0.88);
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
    // Fall back to storage, not just {}, when the cache is cold (e.g. right after a
    // page reload) - otherwise this silently drops whatever else was saved on this key.
    let obj = (await loadWorkoutLog(weekN, dayTag)) || {};
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
    let obj = (await loadWorkoutLog(weekN, dayTag)) || {};
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

export async function unrescheduleSession(id, weekN, dayTag){
  try{
    let obj = (await loadWorkoutLog(weekN, dayTag)) || {};
    obj.rescheduled = false;
    delete obj.rescheduledToTag;
    await saveWithRetry(id, obj);
    state.recentSaveCache[id] = obj;
    if(state.view==='history') renderRunHistory(); else renderWeek(state.currentWeek);
  }catch(e){
    console.error('unreschedule failed', e);
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
    let obj = (await loadWorkoutLog(weekN, dayTag)) || {};
    obj.skipped = true;
    obj.skipReason = reason;
    obj.skippedAt = new Date().toISOString();
    obj.completed = false;
    await saveWithRetry(id, obj);
    state.recentSaveCache[id] = obj;
    await refreshAdherenceBanners();
    if(state.view==='history') renderRunHistory(); else renderWeek(state.currentWeek);
    const week = state.WEEKS.find(w=>w.n===weekN);
    const day = week ? week.days.find(d=>d.tag===dayTag) : null;
    if(day) autoCoachMessage('skip', {day, weekN, reason});
  }catch(e){
    console.error('skip save failed', e);
    if(statusEl) statusEl.innerText = 'Could not save (' + (e.message||'unknown error') + ') - try again.';
  }
}

// Corrects an already-logged skip's reason text (e.g. a typo) without undoing the skip
// itself - unlike unskipSession (a full undo) or submitSkip (a brand-new skip), this keeps
// skippedAt as when the skip actually happened and re-runs the coach's skip analysis with
// the corrected reason, explicitly telling it to revise/retract anything it concluded from
// the wrong one (see the isCorrection branch in chat.js's autoCoachMessage) - the existing
// per-day note/verdict save logic already overwrites rather than duplicates, so this just
// needs to trigger a fresh analysis, not build a separate correction pipeline.
export async function submitSkipReasonEdit(id, weekN, dayTag){
  const reasonEl = document.getElementById(id+'-skipreason');
  const statusEl = document.getElementById(id+'-skipstatus');
  const reason = reasonEl ? reasonEl.value.trim() : '';
  if(!reason){
    if(statusEl) statusEl.innerText = 'Add a reason first.';
    return;
  }
  try{
    let obj = (await loadWorkoutLog(weekN, dayTag)) || {};
    const previousReason = obj.skipReason || '';
    if(reason === previousReason){
      if(statusEl) statusEl.innerText = 'No change from the current reason.';
      return;
    }
    if(statusEl) statusEl.innerText = 'Saving correction...';
    obj.skipReason = reason;
    obj.skipReasonEditedAt = new Date().toISOString();
    await saveWithRetry(id, obj);
    state.recentSaveCache[id] = obj;
    if(state.view==='history') renderRunHistory(); else renderWeek(state.currentWeek);
    const week = state.WEEKS.find(w=>w.n===weekN);
    const day = week ? week.days.find(d=>d.tag===dayTag) : null;
    if(day) autoCoachMessage('skip', {day, weekN, reason, isCorrection:true, previousReason});
  }catch(e){
    console.error('skip reason edit failed', e);
    if(statusEl) statusEl.innerText = 'Could not save (' + (e.message||'unknown error') + ') - try again.';
  }
}

export async function saveWorkoutLog(weekN, dayTag){
  const id = workoutKey(weekN, dayTag);
  const statusEl = document.getElementById(id+'-logstatus');
  if(statusEl) statusEl.innerText = 'Saving...';
  try{
    // Merge onto the existing saved entry rather than replacing it outright - readLogForm
    // only knows about the visible form fields, so a plain overwrite would silently drop
    // anything else already stored on this key (stravaImport when it's not freshly
    // re-imported this session, performedOnTag, etc.) every time an already-logged
    // session gets edited and re-saved.
    const existing = (await loadWorkoutLog(weekN, dayTag)) || {};
    const obj = Object.assign({}, existing, readLogForm(id));
    obj.completed = true;
    obj.skipped = false;
    obj.swapped = false;
    obj.rescheduled = false;
    // A session that was "planned to move" (rescheduledToTag set, via the reschedule flow)
    // and is now actually being completed needs to convert into a real "performed on a
    // different day" record. Every render path that knows how to display a moved session
    // at its target day (both this day's own stub in renderDay, and the pre-render loop in
    // renderWeek) checks performedOnTag, and unlike rescheduled+rescheduledToTag that check
    // isn't gated on completed being false - so without this, completing a rescheduled
    // session silently reverts to showing as completed on the original day, with no trace
    // it was actually performed on the day it was moved to.
    if(existing.rescheduledToTag && !obj.performedOnTag) obj.performedOnTag = existing.rescheduledToTag;
    if(state.stravaImportCache[id]) obj.stravaImport = state.stravaImportCache[id];
    if(obj.stravaImport && obj.stravaImport.activityDateISO && /^\d{4}-\d{2}-\d{2}$/.test(obj.stravaImport.activityDateISO)){
      obj.completedAt = new Date(obj.stravaImport.activityDateISO+'T12:00:00').toISOString();
    } else {
      obj.completedAt = new Date().toISOString();
    }
    await updateLastActivityDate(obj.completedAt);
    // The date every trend point below gets stamped with - the workout's own real date
    // (from completedAt, itself now correctly Strava-derived when available), not "now".
    // Using new Date() here would date every point by when Save was clicked instead of
    // when the session happened, most visible on a re-import done days after the fact.
    const completedDateStr = obj.completedAt.slice(0,10);
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
        // avgPaceSec (precise) over re-parsing avgPaceLabel (whole-second-rounded for
        // display) - this feeds the persisted efficiency-history trend, so avoid stacking
        // an extra rounding step onto every point in it.
        const paceSec = workLap.avgPaceSec!=null ? workLap.avgPaceSec : parsePaceLabelToSec(workLap.avgPaceLabel);
        if(paceSec) speedKmh = 3600/paceSec;
        hr = workLap.avgHR;
        if(workLap.paceSource) source = workLap.paceSource;
      } else if(obj.actualDist && obj.actualDur && obj.avgHR){
        const distKm = parseFloat(obj.actualDist), durHr = parseFloat(obj.actualDur)/60;
        if(distKm>0 && durHr>0){ speedKmh = distKm/durHr; hr = parseFloat(obj.avgHR); }
      }
      if(obj.manualDataSource) source = obj.manualDataSource;
      if(speedKmh && hr>0){
        await appendEfficiencyPoint(completedDateStr, speedKmh/hr, hr, speedKmh, source, id);
      }
    }
    if(day && day.type==='long' && obj.stravaImport && obj.stravaImport.decoupling && obj.stravaImport.decoupling.decouplingPct!=null){
      await appendTrendPoint('decoupling-history', completedDateStr, {value: obj.stravaImport.decoupling.decouplingPct, sessionId:id});
    }
    if(day && day.type==='long' && obj.stravaImport && obj.stravaImport.cadenceFade && obj.stravaImport.cadenceFade.fadePct!=null){
      await appendTrendPoint('cadence-fade-history', completedDateStr, {value: obj.stravaImport.cadenceFade.fadePct, sessionId:id});
    }
    // Training load (see coach/training-load.js's ACWR): every real numeric estimate of
    // THIS session's own load, not the plan's expectation of it - a Strava-derived
    // full-stream TRIMP when available, else the session-average formula from a manually-
    // typed avgHR (the same formula Banister's TRIMP was originally defined with), else
    // nothing rather than a fabricated number. Any run type contributes, not just long or
    // interval days - the acute:chronic ratio needs the whole training picture, easy days
    // included, to mean anything.
    if(day){
      const sessionTrimp = (obj.stravaImport && obj.stravaImport.estimatedTRIMP!=null)
        ? obj.stravaImport.estimatedTRIMP
        : computeSessionTRIMP(parseFloat(obj.avgHR), parseFloat(obj.actualDur), state.profile);
      if(sessionTrimp!=null) await appendTrendPoint('trimp-history', completedDateStr, {value: sessionTrimp, sessionId:id});
    }
    if(obj.stravaImport && Array.isArray(obj.stravaImport.laps)){
      const workLaps = obj.stravaImport.laps.filter(l=>l.role==='work' && l.timeToTargetSec!=null);
      const recoveryLaps = obj.stravaImport.laps.filter(l=>(l.role==='recovery'||l.role==='cooldown') && l.recoveryHRDropBpm!=null);
      if(workLaps.length){
        const avgTTT = workLaps.reduce((s,l)=>s+l.timeToTargetSec,0)/workLaps.length;
        await appendTrendPoint('timetotarget-history', completedDateStr, {value:Math.round(avgTTT), sessionType:day.type, sampleSize:workLaps.length, sessionId:id});
      }
      if(recoveryLaps.length){
        const avgDrop = recoveryLaps.reduce((s,l)=>s+l.recoveryHRDropBpm,0)/recoveryLaps.length;
        await appendTrendPoint('hrrecovery-history', completedDateStr, {value:Math.round(avgDrop*10)/10, sessionType:day.type, sampleSize:recoveryLaps.length, sessionId:id});
      }
      if(obj.performedMode==='treadmill' && obj.treadmillLTSpeed){
        const wearableLap = obj.stravaImport.laps.find(l=>l.role==='work' && l.avgPaceLabel);
        if(wearableLap){
          const wearablePaceSec = wearableLap.avgPaceSec!=null ? wearableLap.avgPaceSec : parsePaceLabelToSec(wearableLap.avgPaceLabel);
          const inclinePct = (obj.treadmillIncline!=null && obj.treadmillIncline!=='') ? parseFloat(obj.treadmillIncline) : TREADMILL_DEFAULT_INCLINE_PCT;
          const point = computeTreadmillCalibrationPoint(wearablePaceSec, parseFloat(obj.treadmillLTSpeed), inclinePct, wearableLap.paceSource);
          if(point){
            // dayType tags which pace band this point was captured at (threshold vs vo2max) -
            // see getIndoorWearableCalibration's same-band-preferred matching in tier-estimates.js.
            await appendTrendPoint('indoor-wearable-calibration', completedDateStr, Object.assign({sessionId:id, dayType: day.type}, point));
          }
        }
      }
    }
    await refreshAdherenceBanners();
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
  const startStr = firstDate.toISOString().slice(0,10);
  const endStr = lastDate.toISOString().slice(0,10);
  // Excludes every REAL day (getFullWeekDayList, open days included) the main render loop
  // in renderWeek below already covers - was excluding only w.days (planned days), which
  // made an old freeform entry saved on an open day double-render: once as that open day's
  // own card in the main loop (which already walks the full day list, open days included),
  // once again here. New saves never land here at all now (see saveFreeWorkout in
  // modals.js) - this is purely for whatever old-style entries already exist.
  const dayTags = new Set(getFullWeekDayList(w).map(d=>d.tag));
  const all = await loadFreeWorkouts();
  return all.filter(fw => fw.weekN===w.n && fw.date >= startStr && fw.date <= endStr && !dayTags.has(fw.dayTag));
}

// One mini-card per extra workout (lib/extras.js), stacked under whichever day it was
// actually logged for - same visual treatment the old bottom-of-week "Extra" cards used,
// just rendered on the real day now instead of only for entries that happened to land on
// an uncovered/open day.
export function extraWorkoutCardHTML(fw){
  const detail = [fw.actualDist?(fw.actualDist+'km'):'', fw.actualDur?formatMinutesToClock(fw.actualDur):'', fw.rpe?('RPE '+fw.rpe):'', fw.avgHR?(fw.avgHR+'bpm avg'):''].filter(Boolean).join(' &middot; ');
  return '<div class="card" style="border:1.5px solid rgba(212,162,76,0.5); background:rgba(212,162,76,0.06);">'+
    '<div class="card-top"><div><div class="sess-name">&#10003; '+fw.activityType+(fw.name?(' - '+fw.name):'')+'</div></div>'+
    '<div class="zone-pill" style="background:rgba(212,162,76,0.15); color:#D4A24C;">Extra</div></div>'+
    '<div class="note" style="margin-top:8px; padding-top:0; border-top:none;">'+(detail?(detail+' - '):'')+'not part of the prescribed plan'+(fw.retryOfTag?(' &middot; retry attempt of '+fw.retryOfTag):'')+'</div>'+
    (fw.notes ? ('<div class="note" style="margin-top:2px; padding-top:0; border-top:none;">'+expandableNoteHTML(fw.notes)+'</div>') : '')+
    '<div style="margin-top:8px;"><button class="log-toggle" onclick="deleteExtraWorkoutAndRefresh(\''+fw.id+'\')">Delete</button></div>'+
    '</div>';
}

export async function deleteExtraWorkoutAndRefresh(id){
  await deleteExtraWorkout(id);
  if(state.view==='history') renderRunHistory(); else if(state.view==='plan') renderWeek(state.currentWeek);
}

export async function loadWorkoutLog(weekN, dayTag){
  const id = workoutKey(weekN, dayTag);
  if(state.recentSaveCache[id]) return state.recentSaveCache[id];
  try{ const r = await window.storage.get(id, false); return r ? JSON.parse(r.value) : null; }
  catch(e){ return null; }
}

export function toggleLogForm(id){ document.getElementById(id+'-form').classList.toggle('open'); }

export async function renderDay(d, weekN, allNotes, performedContext){
  const id = workoutKey(weekN, d.tag);
  const effectiveMode = state.cardModeOverride[id] || state.mode;
  const existing = await loadWorkoutLog(weekN, d.tag);
  if(!performedContext && existing && existing.performedOnTag && existing.performedOnTag!==d.tag){
    const pillClassR = d.type==='threshold'?'z-threshold':d.type==='vo2max'?'z-vo2':d.type==='long'?'z-long':d.type==='race'?'z-race':'z-easy';
    return '<div class="card" style="border:1.5px solid rgba(124,147,168,0.4); background:rgba(124,147,168,0.05);">'+
      '<div class="card-top"><div><div class="day-tag">'+d.tag+'</div><div class="sess-name">&#8594; '+d.name+'</div></div>'+
      '<div class="zone-pill '+pillClassR+'">'+d.zone+'</div></div>'+
      '<div class="note" style="margin-top:6px; padding-top:0; border-top:none; color:var(--dim);">Performed on '+existing.performedOnTag+' instead</div>'+
      '</div>';
  }
  // Same idea as the performedOnTag stub above, just forward-looking instead of
  // retrospective: collapse the original slot to a small pointer and let the full,
  // interactive card render at the target day instead (via the performedContext branch
  // in renderWeek) - rather than showing the full card twice with a note bolted on.
  if(!performedContext && existing && existing.rescheduled && existing.rescheduledToTag && !existing.completed){
    const pillClassM = d.type==='threshold'?'z-threshold':d.type==='vo2max'?'z-vo2':d.type==='long'?'z-long':d.type==='race'?'z-race':'z-easy';
    return '<div class="card" style="border:1.5px dashed rgba(232,163,61,0.45); background:rgba(232,163,61,0.05);">'+
      '<div class="card-top"><div><div class="day-tag">'+d.tag+'</div><div class="sess-name">&#8594; '+d.name+'</div></div>'+
      '<div class="zone-pill '+pillClassM+'">'+d.zone+'</div></div>'+
      '<div class="note" style="margin-top:6px; padding-top:0; border-top:none;">Planning to do this on <b>'+existing.rescheduledToTag+'</b> instead - full card is over there.</div>'+
      '<button class="log-toggle" style="margin-top:8px;" onclick="unrescheduleSession(\''+id+'\','+weekN+',\''+d.tag+'\')">Undo move</button>'+
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
  const isCompleted = existing && existing.completed;
  const isSkipped = existing && existing.skipped;
  const isSwapped = existing && existing.swapped;
  const isExpanded = state.expandedCards[id];
  // Same "this day has passed with nothing resolved" signal completionRow's overdueNote
  // uses below, computed once here so the card itself can carry a visual cue too, not
  // just buried text - open days included, since those previously showed nothing at all.
  // Uses the display date (where the card actually visually sits) when this is a
  // performedContext render, not the original day's own date - otherwise a session moved
  // onto today would wrongly show "Day passed" just because its original slot already did.
  const dDateForOverdue = parseDayTagDate(performedContext ? performedContext.displayTag : d.tag);
  const todayForOverdue = new Date(); todayForOverdue.setHours(0,0,0,0);
  const isPastUnresolved = !!(dDateForOverdue && dDateForOverdue < todayForOverdue && !isCompleted && !isSkipped && !isSwapped);
  const pastCardStyle = isPastUnresolved ? ' style="border:1.5px solid rgba(232,163,61,0.35); background:rgba(232,163,61,0.05);"' : '';
  const pastBadgeHTML = isPastUnresolved ? '<div class="zone-pill" style="background:rgba(232,163,61,0.18); color:var(--threshold);">Day passed</div>' : '';
  if(d.type==='open' && !existing){
    // Same collapse-by-default treatment as the workout-detail cards below, for the same
    // reason - a week with several rest days that have already passed shouldn't take up
    // any more room than one with none, and this shares the same expandedCards state/id
    // so the interaction is identical to every other card type.
    if(isPastUnresolved && !isExpanded){
      return '<div class="card" style="cursor:pointer; border:1.5px solid rgba(232,163,61,0.5); background:rgba(232,163,61,0.06);" onclick="toggleCardExpand(\''+id+'\')">'+
        '<div class="card-top"><div><div class="day-tag">'+d.tag+'</div><div class="sess-name">&#9675; Open day</div></div></div>'+
        '<div class="note" style="margin-top:8px; padding-top:0; border-top:none; display:flex; justify-content:space-between; align-items:center; gap:10px;"><span>Nothing logged</span><span style="color:var(--threshold); font-size:11px; font-weight:700; white-space:nowrap;">Tap to log or view &#9660;</span></div>'+
        '</div>';
    }
    return '<div class="card"'+pastCardStyle+'><div class="card-top"><div><div class="day-tag">'+d.tag+'</div><div class="sess-name">Open day</div></div>'+pastBadgeHTML+'</div>'+
      (isPastUnresolved ? '<div class="note" style="margin-top:8px; padding-top:0; border-top:none; color:var(--dim);">This day passed with nothing logged.</div>' : '')+
      (isPastUnresolved ? '<div style="margin-top:4px; margin-bottom:-2px;"><button class="ghost-btn" style="padding:4px 10px; font-size:11px;" onclick="toggleCardExpand(\''+id+'\')">&#9650; Collapse</button></div>' : '')+
      '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">'+
        '<button class="log-toggle" onclick="openAddWorkoutForDay('+weekN+',\''+d.tag+'\')">Add workout</button>'+
        '<button class="log-toggle" onclick="openPerformPicker('+weekN+',\''+d.tag+'\')">Perform planned workout</button>'+
      '</div></div>';
  }
  let html = '<div class="card"'+pastCardStyle+'><div class="card-top"><div><div class="day-tag">'+(performedContext?performedContext.displayTag:d.tag)+'</div><div class="sess-name">'+d.name+'</div></div>';
  const pillClass = d.type==='threshold'?'z-threshold':d.type==='vo2max'?'z-vo2':d.type==='long'?'z-long':d.type==='race'?'z-race':'z-easy';
  html += '<div class="zone-pill '+pillClass+'">'+d.zone+'</div>'+pastBadgeHTML+'</div>';
  if(performedContext) html += '<div class="note" style="margin-top:6px; padding-top:0; border-top:none; color:var(--dim);">Originally scheduled '+performedContext.originalTag+'.</div>';
  if((isCompleted||isSkipped||isSwapped||isPastUnresolved) && !isExpanded){
    let icon, frameColor, frameBg, statLine, tapLabel = 'Tap for details &#9660;';
    if(isPastUnresolved){
      // A day that just went by with nothing logged at all - previously rendered as the
      // full, uncollapsed workout-detail card (totals, zone bar, segments, log form...)
      // with only a small "Day passed" badge to distinguish it, which made a week with a
      // few gaps in it much taller than one with none. Same collapse-by-default treatment
      // as completed/skipped/swapped below, in the same amber already used for that badge.
      icon = '&#9675;';
      frameColor = 'rgba(232,163,61,0.5)';
      frameBg = 'rgba(232,163,61,0.06)';
      statLine = 'Nothing logged';
      tapLabel = 'Tap to log or view &#9660;';
    } else {
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
      if(performedContext && !isSkipped && !isSwapped) statParts.unshift('originally '+performedContext.originalTag);
      statLine = statParts.length ? statParts.join(' &middot; ') : (isSkipped ? 'Skipped' : 'Logged');
      icon = isSkipped ? '&#8856;' : isSwapped ? '&#8644;' : '&#10003;';
      frameColor = isSkipped ? 'rgba(124,147,168,0.5)' : isSwapped ? 'rgba(193,80,46,0.5)' : 'rgba(95,168,160,0.55)';
      frameBg = isSkipped ? 'rgba(124,147,168,0.06)' : isSwapped ? 'rgba(193,80,46,0.06)' : 'rgba(95,168,160,0.07)';
    }
    return '<div class="card" style="cursor:pointer; border:1.5px solid '+frameColor+'; background:'+frameBg+';" onclick="toggleCardExpand(\''+id+'\')">'+
      '<div class="card-top"><div><div class="day-tag">'+(performedContext?performedContext.displayTag:d.tag)+'</div><div class="sess-name">'+icon+' '+d.name+'</div></div>'+
      '<div class="zone-pill '+pillClass+'">'+d.zone+'</div></div>'+
      '<div class="note" style="margin-top:8px; padding-top:0; border-top:none; display:flex; justify-content:space-between; align-items:center; gap:10px;"><span>'+statLine+'</span><span style="color:var(--threshold); font-size:11px; font-weight:700; white-space:nowrap;">'+tapLabel+'</span></div>'+
      '</div>';
  }
  if((isCompleted||isSkipped||isSwapped||isPastUnresolved) && isExpanded){
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
    const isVo2 = d.type==='vo2max';
    if(effectiveMode==='treadmill'){
      html += '<div class="totals"><div><span class="num">'+fmtDuration5(dat.totalSec)+'</span><span class="lbl">Duration</span></div>';
      if(isVo2){
        // Pace leads for VO2max - it's the primary target here, HR is a secondary
        // readout (see the segment detail below and the tip block for why).
        html += '<div><span class="num">~'+paceToKmh(dat.main.paceSpk)+'</span><span class="lbl">km/h target (main set)</span></div>';
        html += '<div><span class="num">'+state.Z[d.zone].hr+'</span><span class="lbl">bpm, informational</span></div></div>';
      } else {
        html += '<div><span class="num">'+state.Z[d.zone].hr+'</span><span class="lbl">bpm target</span></div>';
        html += '<div><span class="num">~'+paceToKmh(dat.main.paceSpk)+'</span><span class="lbl">km/h (main set)</span></div></div>';
      }
    } else {
      html += '<div class="totals"><div><span class="num">'+dat.totalKm+' km</span><span class="lbl">Distance</span></div>';
      html += '<div><span class="num">'+fmtDuration5(dat.totalSec)+'</span><span class="lbl">Duration</span></div></div>';
    }
    html += zoneBarHTML(computeOptimalHR(d));
    html += '<div class="segments">';
    html += segRow('Warm-up', (effectiveMode==='treadmill' ? dat.wu.time+' - ~'+paceToKmh(state.Z.S1.pace)+'km/h' : dat.wu.km+' km - '+dat.wu.time)+' - '+state.Z.S1.hr+'bpm');
    let mainDetail;
    const recoveryText = fmtSecondsLong(dat.main.recoverySec);
    if(isVo2){
      const buildStart = computeVO2maxBuildStartHR(), peak = computeOptimalHR(d);
      mainDetail = effectiveMode==='treadmill'
        ? '~'+paceToKmh(dat.main.paceSpk)+'km/h (target - hold this) - '+recoveryText+' '+dat.main.recoveryLabel+' recovery. HR: expect ~'+buildStart+' rising to ~'+peak+'+bpm across reps - informational, don\'t adjust pace to chase it'
        : dat.main.pace+' (target - hold this) - '+recoveryText+' '+dat.main.recoveryLabel+' recovery. HR: expect ~'+buildStart+' rising to ~'+peak+'+bpm across reps - informational, don\'t adjust pace to chase it';
    } else {
      mainDetail = effectiveMode==='treadmill'
        ? '~'+paceToKmh(dat.main.paceSpk)+'km/h @ '+state.Z[d.zone].hr+'bpm - '+recoveryText+' '+dat.main.recoveryLabel+' recovery break between reps'
        : dat.main.pace+' @ '+state.Z[d.zone].hr+'bpm - '+recoveryText+' '+dat.main.recoveryLabel+' recovery break between reps';
    }
    const mainLabel = effectiveMode==='treadmill' ? dat.main.reps+' x '+dat.main.repTime : dat.main.label;
    html += segRow(mainLabel, mainDetail);
    html += segRow('Cool-down', (effectiveMode==='treadmill' ? dat.cd.time+' - ~'+paceToKmh(state.Z.S1.pace)+'km/h' : dat.cd.km+' km - '+dat.cd.time)+' - '+state.Z.S1.hr+'bpm');
    html += '</div>';
    if(effectiveMode==='treadmill'){
      html += isVo2
        ? '<div class="note">Treadmill: run each interval by time at the target speed above, incline ~1%. Hold that speed - don\'t adjust it to chase the HR readout, that\'s exactly the mistake this session type invites. Overall duration target is rounded to the nearest 5 min - the interval times above are exact.</div>'
        : '<div class="note">Treadmill: run each interval by time at target HR, incline ~1%. Speeds shown are a starting point - adjust to hold the HR target. Overall duration target is rounded to the nearest 5 min - the interval times above are exact.</div>';
    }
    if(effectiveMode==='treadmill'){
      const tier3Est = await loadTierEstimate(3);
      const isVo2 = d.type==='vo2max';
      const suggested = tier3Est && (isVo2 ? tier3Est.suggestedNextVO2Speed : tier3Est.suggestedNextSpeed);
      const isContinuous = dat.main.reps <= 1;
      let windowDesc, suggestedLabel;
      // ONE rule, no judgment call while running: read the display at a single, fixed
      // trigger moment - "right as this ends." No averaging, no "which part was
      // representative," nothing to watch a clock for mid-effort. A prescribed treadmill
      // session is normally run at one set speed for the whole work portion anyway (the dial
      // gets set once), so the reading at that moment IS the number that matters - this isn't
      // a compromise, it's the actual number.
      if(isContinuous && !isVo2){
        suggestedLabel = 'for this effort';
        windowDesc = 'read the display the instant this effort ends - whatever it shows right as you finish, before slowing down for cooldown';
      } else {
        suggestedLabel = 'on work rep 2';
        windowDesc = 'read the display the instant work rep 2 ends specifically (not rep 1 - HR hasn\'t caught up yet; not the last rep - fatigue drift skews it) - whatever it shows right then'+(isVo2 ? ', only if this was genuinely a hard, near-max effort (HR close to max, RPE 8-9+) - a lighter effort won\'t give a valid estimate' : '');
      }
      const boxLabel = isVo2 ? 'For VO2max tracking:' : 'For LT tracking:';
      html += '<div class="note" style="background:rgba(212,162,76,0.1); border-color:rgba(212,162,76,0.3);"><b style="color:#D4A24C;">'+boxLabel+'</b> '+(suggested
        ? ('try holding <b>'+suggested+' km/h</b> '+suggestedLabel+' - refined from your last session\'s result. ')
        : '')+windowDesc+'. Log it in the field below, along with the incline actually used if it wasn\'t the usual ~1%'+(suggested ? ' - this suggestion gets more accurate as you log more sessions' : '')+'.</div>';
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

  html += completionRow(id, existing, crossInfo, d, weekN, performedContext);
  const runIsInterval = d.type==='threshold'||d.type==='vo2max';
  const runDistanceNote = effectiveMode==='treadmill' ? 'optional, treadmill is duration-based' : (runIsInterval ? 'optional, secondary to RPE/HR for judging intervals' : null);
  const showStravaImport = runIsInterval || d.type==='long' || d.type==='easy';
  let logFormHtml = '';
  let effectiveStravaImport = null;
  if(showStravaImport){
    state.sessionTypeCache[id] = d.type;
    if(runIsInterval){
      const m = d.data.main;
      state.sessionStructureCache[id] = m.label+' at approximately '+(m.pace||'')+', separated by '+m.recoverySec+'s '+m.recoveryLabel+' recovery, with an easy warmup before and cooldown after - the work reps should be noticeably faster/harder than the warmup, cooldown, and recovery portions.';
      state.sessionTargetCache[id] = {pace: m.pace||'', hr: state.Z[d.zone] ? state.Z[d.zone].hr : ''};
    } else if(d.type==='long'){
      const segDesc = d.data.segments.map(s=>s.km+'km at zone '+s.zone).join(', then ');
      state.sessionStructureCache[id] = 'A continuous long run with no discrete reps, building through effort zones: '+segDesc+' - effort should genuinely change (not necessarily monotonically increasing - a goal-pace segment can be sandwiched between easier ones, not just tacked on at the end) at each zone boundary, not show interval-style rep/recovery alternation.';
      // The hardest (fastest-pace) segment is the real target for this session, wherever it
      // falls in the list - a goal-pace segment is routinely sandwiched mid-run (e.g. 5km
      // S2, 3km GOAL, 5km S2, see plan.js), not always last, so "last segment" was silently
      // picking the wrong (easier) target pace/HR for any structure shaped like that: wrong
      // Prescribed banner, wrong vs-Target comparison, and wrong terrainPaceNote input.
      // Comparing zones by their own numeric pace (lower = faster = harder) sidesteps
      // needing a hardcoded S1..S5/GOAL/RACE10K hardness ordering entirely.
      const peakSeg = d.data.segments.reduce((hardest, s)=>{
        const z = state.Z[s.zone];
        if(!z) return hardest;
        const hardestZ = hardest ? state.Z[hardest.zone] : null;
        return (!hardestZ || z.pace < hardestZ.pace) ? s : hardest;
      }, null);
      const peakZ = peakSeg ? peakSeg.zone : d.data.segments[d.data.segments.length-1].zone;
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
  // A single "Treadmill calibration" card, not fields scattered through the generic form -
  // teAero moved here from logFormFields because it's only ever actually READ for a
  // treadmill session (see qualifiesTier3 in chat.js: performedMode==='treadmill' is a hard
  // requirement), so showing it on every outdoor session too was pure clutter with nothing
  // behind it. Widened beyond threshold/vo2max to a treadmill goal-pace long run too -
  // qualifiesTier3 accepts type==='long' on teAero alone (no treadmillLTSpeed required for
  // that case), so restricting this card to threshold/vo2max would have silently dropped a
  // capability that already existed.
  const isGoalPaceLong = d.type==='long' && Array.isArray(d.data.segments) && d.data.segments.some(s=>s.zone==='GOAL');
  if(effectiveMode==='treadmill' && (d.type==='threshold' || d.type==='vo2max' || isGoalPaceLong)){
    logFormHtml += '<div class="card" style="margin-top:12px; padding:14px 16px; background:var(--bg-alt);">';
    logFormHtml += '<div class="sess-name" style="font-size:14px; margin-bottom:10px;">Treadmill calibration</div>';
    logFormHtml += '<div class="log-field"><label>TE Aerobic (Garmin Training Effect - unlocks a fitness-estimate refresh from this session)</label><input type="number" step="0.1" min="0" max="5" id="'+id+'-teaero" value="'+(existing&&existing.teAero||'')+'"></div>';
    if(d.type==='threshold' || d.type==='vo2max'){
      const isVo2 = d.type==='vo2max';
      const isContinuous = d.data.main.reps <= 1;
      let speedLabel, speedPlaceholder;
      if(isContinuous && !isVo2){
        // A single, fixed trigger moment - "right as it ends" - not a window to watch or an
        // average to judge. Whatever the display shows at that instant is the number, no
        // exceptions to reason about mid-run.
        speedLabel = 'Treadmill speed at the end of this effort (km/h)';
        speedPlaceholder = 'whatever the display shows the instant you finish';
      } else {
        speedLabel = 'Treadmill speed - end of work rep 2 (km/h)';
        speedPlaceholder = isVo2 ? 'the instant rep 2 ends - only if it was genuinely near-max' : 'the instant rep 2 ends';
      }
      logFormHtml += '<div class="log-field" style="margin-top:8px;"><label>'+speedLabel+'</label><input type="number" step="0.1" min="'+TREADMILL_SPEED_MIN_KMH+'" max="'+TREADMILL_SPEED_MAX_KMH+'" placeholder="'+speedPlaceholder+'" id="'+id+'-treadspeed" value="'+(existing&&existing.treadmillLTSpeed||'')+'"></div>';
      // Nothing captured incline before this - every treadmill session card tells the runner
      // to set ~1%, but the number itself was never logged, so there was no way to correct
      // for it (or even know whether it was actually followed) in the pace/VO2 math. Left
      // truly optional (not required) since some sessions genuinely won't have it noted -
      // computeTreadmillCalibrationPoint and the coach prompt both assume ~1% when this is
      // blank, matching the app's own standing advice, rather than silently assuming flat.
      logFormHtml += '<div class="log-field" style="margin-top:8px;"><label>Incline (%, optional)</label><input type="number" step="0.5" min="0" max="15" placeholder="defaults to ~1% if left blank" id="'+id+'-treadincline" value="'+(existing&&existing.treadmillIncline||'')+'"></div>';
    }
    logFormHtml += '</div>';
  }
  html += '<div class="log-form" id="'+id+'-form">'+logFormHtml+'<button class="save-btn" onclick="saveWorkoutLog('+weekN+',\''+d.tag+'\')">Save</button><div class="logged-summary" id="'+id+'-logstatus"></div></div>';
  html += '</div>';
  return html;
}

export function completionRow(id, existing, crossInfo, d, weekN, performedContext){
  let html = '';
  if(crossInfo) html += '<div class="note" style="margin-top:10px; padding-top:0; border-top:none;"><b style="color:var(--easy);">'+crossInfo+'</b></div>';
  // Available on every branch below, regardless of what this day's own planned session
  // already resolved to - logging it always goes to the separate extras store (lib/extras.js
  // via saveFreeWorkout/openAddWorkoutForDay in modals.js), never this day's own workoutKey
  // slot, so it can never overwrite whatever's already here.
  const addExtraBtn = '<button class="log-toggle" style="margin-top:0;" onclick="openAddWorkoutForDay('+weekN+',\''+d.tag+'\')">+ Add another workout</button>';
  if(existing && existing.completed){
    let label = '&#10003; Completed';
    if(existing.performedMode) label += ' (as '+existing.performedMode+' run)';
    html += '<div class="completed-row"><span class="completed-badge">'+label+'</span>'+
      '<button class="log-toggle" style="margin-top:0;" onclick="toggleLogForm(\''+id+'\')">Edit log</button>'+
      (d.type!=='open' ? ('<button class="log-toggle" style="margin-top:0;" onclick="openRetryPicker('+weekN+',\''+d.tag+'\',\''+d.name.replace(/'/g,"")+'\')">Try this session again</button>') : '')+
      addExtraBtn+'</div>';
  } else if(existing && existing.skipped){
    html += '<div class="completed-row"><span class="completed-badge" style="background:rgba(124,147,168,0.18); color:var(--dim);">&#8856; Skipped</span>'+
      '<button class="log-toggle" style="margin-top:0;" onclick="toggleSkipForm(\''+id+'\')">Edit reason</button>'+
      '<button class="log-toggle" style="margin-top:0;" onclick="unskipSession(\''+id+'\','+weekN+',\''+d.tag+'\')">Undo skip</button>'+
      addExtraBtn+'</div>'+
      '<div class="note" style="margin-top:6px; padding-top:0; border-top:none;"><b>Reason:</b> '+expandableNoteHTML(existing.skipReason||'')+'</div>'+
      '<div id="'+id+'-skipform" class="skip-form" style="display:none; margin-top:10px;">'+
        '<textarea id="'+id+'-skipreason" style="width:100%; min-height:60px;">'+(existing.skipReason||'').replace(/</g,'&lt;')+'</textarea>'+
        '<div style="margin-top:8px; display:flex; gap:8px; align-items:center;">'+
          '<button class="save-btn" onclick="submitSkipReasonEdit(\''+id+'\','+weekN+',\''+d.tag+'\')">Save correction</button>'+
          '<button class="ghost-btn" onclick="toggleSkipForm(\''+id+'\')">Cancel</button>'+
        '</div>'+
        '<div id="'+id+'-skipstatus" style="font-size:11.5px; color:var(--dim); margin-top:6px;"></div>'+
      '</div>';
  } else if(existing && existing.swapped){
    html += '<div class="completed-row"><span class="completed-badge" style="background:rgba(193,80,46,0.18); color:var(--vo2);">&#8644; Swapped</span>'+
      '<button class="log-toggle" style="margin-top:0;" onclick="unswapSession(\''+id+'\','+weekN+',\''+d.tag+'\')">Undo swap</button>'+
      addExtraBtn+'</div>'+
      '<div class="note" style="margin-top:6px; padding-top:0; border-top:none;"><b>Did instead:</b> '+expandableNoteHTML(existing.swappedForName||'')+'</div>';
  } else {
    let overdueNote = '';
    if(d.type!=='open'){
      // Display date, not the original day's own date, when this is a moved/performed-
      // elsewhere card - see the matching comment on isPastUnresolved in renderDay.
      const dDate = parseDayTagDate(performedContext ? performedContext.displayTag : d.tag);
      if(dDate){
        const today = new Date(); today.setHours(0,0,0,0);
        if(dDate < today){
          overdueNote = '<div class="note" style="margin-bottom:8px; padding:8px 10px; background:rgba(232,163,61,0.1); border:1px solid rgba(232,163,61,0.35); border-radius:8px; border-top:1px solid rgba(232,163,61,0.35);"><b style="color:var(--threshold);">Did you do this workout?</b> This day has passed with nothing logged - pick whichever fits below.</div>';
        }
      }
      // The "planning to do it on another day" note itself now renders up near the top
      // of the card (see renderDay) - not repeated here, just the action buttons below.
    }
    html += overdueNote+'<div style="display:flex; gap:8px; flex-wrap:wrap;">'+
      '<button class="log-toggle" onclick="toggleLogForm(\''+id+'\')">Mark as completed</button>'+
      '<button class="log-toggle" onclick="toggleSkipForm(\''+id+'\')">Skip this session</button>'+
      '<button class="log-toggle" onclick="openSwapWorkout('+weekN+',\''+d.tag+'\',\''+d.name.replace(/'/g,"")+'\')">Do something different instead</button>'+
      (d.type!=='open' ? ('<button class="log-toggle" onclick="openReschedulePicker('+weekN+',\''+d.tag+'\',\''+d.name.replace(/'/g,"")+'\')">Planning to do it on another day</button>') : '')+
      addExtraBtn+
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
  // Session/acute/chronic/status auto-fill from Strava import the moment it runs (see
  // strava-import.js) - labeled "(Strava-calculated)" so it's clear these came from the
  // app's own computed acute:chronic ratio, not typed off a watch, and the load-note div
  // gets a live explanation from strava-import.js when there isn't yet enough logged
  // history (14+ days) for acute/chronic/status specifically to mean anything.
  h += '<div class="log-field"><label>Session load (Strava-calculated)</label><input type="number" id="'+id+'-sessionload" value="'+(e.sessionLoad||'')+'"></div>';
  h += '<div class="log-field"><label>Acute load - 7-day (Strava-calculated)</label><input type="number" id="'+id+'-acuteload" value="'+(e.acuteLoad||'')+'"></div>';
  h += '<div class="log-field"><label>Chronic load - 28-day (Strava-calculated, changes slowly)</label><input type="number" id="'+id+'-chronicload" value="'+(e.chronicLoad||'')+'"></div>';
  h += '<div class="log-field"><label>Load status (Strava-calculated)</label><select id="'+id+'-loadstatus"><option value="">-</option>';
  ['Low','Optimal','High'].forEach(opt=>{ h += '<option'+(e.loadStatus===opt?' selected':'')+'>'+opt+'</option>'; });
  h += '</select></div>';
  h += '<div class="log-field" style="grid-column:1/-1;"><div class="note" id="'+id+'-loadnote" style="margin-top:0; padding-top:0; border-top:none; font-size:11px;"></div></div>';
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
  const treadInclineEl = document.getElementById(id+'-treadincline');
  const dataSourceEl = document.getElementById(id+'-datasource');
  // teAero now only renders inside the treadmill-calibration card (see logFormHtml in
  // renderDay), so it doesn't exist in the DOM at all for an outdoor session - guarded the
  // same way mainPaceEl/treadSpeedEl already are, rather than assuming it's always present.
  const teAeroEl = document.getElementById(id+'-teaero');
  return {
    actualDist:document.getElementById(id+'-actualdist').value,
    actualDur:parseDurationToMinutes(document.getElementById(id+'-actualdur').value),
    avgHR:document.getElementById(id+'-avghr').value,
    mainSetPace: mainPaceEl ? mainPaceEl.value : '',
    treadmillLTSpeed: treadSpeedEl ? treadSpeedEl.value : '',
    treadmillIncline: treadInclineEl ? treadInclineEl.value : '',
    manualDataSource: dataSourceEl ? dataSourceEl.value : '',
    actualNote:document.getElementById(id+'-actualnote').value,
    conditions:document.getElementById(id+'-conditions').value,
    rpe:document.getElementById(id+'-rpe').value,
    teAero: teAeroEl ? teAeroEl.value : '',
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
    html += segRow(eq.reps+' reps', fmtTime5(eq.repSec)+'/rep (duration) @ '+bz[eq.zone].hr+' (~'+bz[eq.zone].speed+') - '+fmtSecondsLong(eq.recoverySec)+' easy spin recovery');
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
    // Same merge-not-replace fix as saveWorkoutLog - don't silently drop whatever's
    // already stored on this key that the edit form doesn't know about.
    let existing = state.recentSaveCache[id];
    if(!existing){ try{ const r = await window.storage.get(id, false); existing = r ? JSON.parse(r.value) : null; }catch(e){} }
    const obj = Object.assign({}, existing||{}, readLogForm(id));
    obj.completed = true;
    obj.skipped = false;
    obj.swapped = false;
    obj.rescheduled = false;
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
  const weekExtras = await loadExtraWorkoutsForWeek(w);
  // Same computation chat.js's buildPlanSummary now uses for the coach's own plan
  // summary (computeWeekPlannedKm) - one canonical "what does this week prescribe"
  // number instead of two separately-maintained copies that could drift apart.
  const weekPlannedKm = computeWeekPlannedKm(w);
  let weekActualKm = 0, weekHasActual = false;
  dayChecks.forEach(({d, log})=>{
    let plannedKm = 0;
    if(d.type==='easy') plannedKm = d.data.km;
    else if(d.type==='threshold' || d.type==='vo2max' || d.type==='long') plannedKm = parseFloat(d.data.totalKm)||0;
    else if(d.type==='race') plannedKm = d.data.km;
    if(log && log.completed){
      weekHasActual = true;
      weekActualKm += log.actualDist ? parseFloat(log.actualDist) : plannedKm;
    }
  });
  // Extra workouts (lib/extras.js) add to "actual so far" as real bonus volume, same as any
  // other logged distance - they just never had a prescribed km to fall back to if missing.
  weekExtras.forEach(fw=>{
    if(fw.actualDist){ weekHasActual = true; weekActualKm += parseFloat(fw.actualDist)||0; }
  });
  weekActualKm = Math.round(weekActualKm*10)/10;
  let html = '<div class="week-head"><h2>Week '+w.n+' - '+w.dates+'</h2><div class="note" style="border-top:none; padding-top:0;">'+weekPlannedKm+' km planned'+(weekHasActual ? (' &middot; '+weekActualKm+' km actual so far') : '')+'</div></div>';
  html += layoffAdjustmentBannerHTML(state.layoffAdjustment);
  html += missedSessionBannerHTML(state.missedSessionAdjustments);
  html += aheadOfScheduleBannerHTML(state.aheadOfScheduleSignals);
  html += swapSuggestionBannerHTML(state.likelySwapSuggestions);
  html += hardSessionProximityBannerHTML(state.hardSessionProximityFlags);
  try{ const gd = await loadGoalTrackerData(); if(gd.active!==false) html += goalTrackerHTML(gd); }catch(e){ console.error('goal tracker failed', e); }
  try{ const gd10 = await load10KGoalTrackerData(); if(gd10.active!==false) html += goalTrackerHTML(gd10); }catch(e){ console.error('10K goal tracker failed', e); }
  try{ const gdm = await loadMaintenanceTrackerData(); if(gdm.active!==false) html += goalTrackerHTML(gdm, null, ['Declining', 'Steady', 'Improving']); }catch(e){ console.error('maintenance tracker failed', e); }
  html += '<div class="mileage-bar-wrap">';
  state.WEEKS.forEach(x=>{
    const cls = x.n===n ? 'active' : (x.cutback?'cutback':'');
    html += '<div class="mileage-bar '+cls+'" style="height:'+(30+x.n*4)+'px; cursor:pointer;" onclick="goToWeek('+x.n+')" title="Go to Week '+x.n+'"></div>';
  });
  html += '</div><div class="mileage-labels">';
  // goToWeek (window global, defined in nav.js), not a bare renderWeek call - the direct
  // renderWeek call used to leave the nav tabs above stuck on whichever week was last
  // selected THROUGH the nav tabs specifically, since it moves the content (and this bar
  // itself) to the new week but never re-renders the nav highlight - see goToWeek's comment.
  state.WEEKS.forEach(x=>{ html += '<span style="cursor:pointer;" onclick="goToWeek('+x.n+')">'+x.n+'</span>'; });
  html += '</div>';
  const prevWeekEnded = n>1 ? weekHasEnded(n-1) : false;
  let weekPreview = (n>1 && prevWeekEnded) ? await getWeekPreview(n) : null;
  if(weekPreview){
    html += '<div class="callout'+(w.race?' raceday':'')+'"><b style="color:var(--threshold);">Since last week:</b> '+weekPreview.text+'</div>';
    if(weekPreview.rebuildText){
      html += '<div class="paste-block"><div class="paste-label">Suggested plan change</div><div class="paste-body">'+weekPreview.rebuildText+'</div>'+
        '<button class="paste-copy-btn" onclick="copyWeekPreviewRebuild('+n+',this)">Copy</button>'+
        '<button class="ghost-btn" style="margin-left:8px; font-size:11.5px; padding:5px 12px;" onclick="toggleGlobalPlanOverrideModal(true, '+JSON.stringify(weekPreview.rebuildText).replace(/"/g,'&quot;')+')">Draft this rebuild</button></div>';
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
    // A session moved onto this day (performed here, or planned to move here) takes
    // display priority over this day's own originally-scheduled card - render those
    // first so they land at the top of this slot, not buried under what was merely
    // proposed for the day and is no longer the live plan for it.
    const incomingHtmlParts = [];
    for(const other of w.days){
      if(other.tag===d.tag) continue;
      const otherLog = await loadWorkoutLog(w.n, other.tag);
      if(otherLog && otherLog.performedOnTag===d.tag){
        const extraHtml = await renderDay(other, w.n, allNotes, {displayTag:d.tag, originalTag:other.tag});
        if(myToken !== state.renderToken || state.view!=='plan' || state.currentWeek!==n || state.appMode!=='run') return;
        incomingHtmlParts.push(extraHtml);
      } else if(otherLog && otherLog.rescheduled && !otherLog.completed && otherLog.rescheduledToTag===d.tag){
        // Same treatment as performedOnTag above: the full, interactive card (pace, HR,
        // log form, everything) renders at the target day, not just a note-only preview -
        // the original slot collapses to a small pointer instead (see renderDay).
        const extraHtml = await renderDay(other, w.n, allNotes, {displayTag:d.tag, originalTag:other.tag});
        if(myToken !== state.renderToken || state.view!=='plan' || state.currentWeek!==n || state.appMode!=='run') return;
        incomingHtmlParts.push(extraHtml);
      }
    }
    for(const html of incomingHtmlParts) container.insertAdjacentHTML('beforeend', html);
    const dayHtml = await renderDay(d, w.n, allNotes);
    if(myToken !== state.renderToken || state.view!=='plan' || state.currentWeek!==n || state.appMode!=='run') return;
    container.insertAdjacentHTML('beforeend', dayHtml);
    extraWorkoutsForDay(weekExtras, d.tag).forEach(fw=>{
      container.insertAdjacentHTML('beforeend', extraWorkoutCardHTML(fw));
    });
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
window.deleteExtraWorkoutAndRefresh = deleteExtraWorkoutAndRefresh;
window.unskipSession = unskipSession;
window.unswapSession = unswapSession;
window.unrescheduleSession = unrescheduleSession;
window.toggleSkipForm = toggleSkipForm;
window.submitSkip = submitSkip;
window.submitSkipReasonEdit = submitSkipReasonEdit;
window.saveWorkoutLog = saveWorkoutLog;
window.toggleCardExpand = toggleCardExpand;
window.toggleLogForm = toggleLogForm;
window.saveBikeEqLog = saveBikeEqLog;
window.renderWeek = renderWeek;
