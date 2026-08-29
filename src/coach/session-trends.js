// @ts-nocheck
import { appendEfficiencyPoint, appendTrendPoint, computeTreadmillCalibrationPoint, TREADMILL_DEFAULT_INCLINE_PCT } from './tier-estimates.js';
import { parsePaceLabelToSec } from '../lib/format.js';
import { computeSessionTRIMP } from '../lib/trimp.js';

// Shared by saveWorkoutLog (week-view.js, a normal completion of its own planned day) and
// saveFreeWorkout (ui/modals.js, a swap or a true extra) - previously only the former fed
// ANY of this (easy-run efficiency trend, long-run decoupling/cadence-fade, time-to-target,
// HR-recovery, treadmill wearable calibration), so a swapped or extra session contributed to
// none of the app's trend tracking at all beyond trimp-history/ACWR (which every session
// already fed regardless of type). effectiveType is the REAL effort this session represents
// - the planned day's own type for a normal completion (unchanged, already correct), or
// lib/effort.js's classifyActualEffort's data-driven read for anything that didn't
// necessarily happen exactly as planned - so a session only feeds the trend model that
// actually fits what it was, not what a day label said it should be.
export async function feedSessionTrends({effectiveType, obj, completedDateStr, sessionId, profile}){
  if(effectiveType==='easy'){
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
    if(speedKmh && hr>0) await appendEfficiencyPoint(completedDateStr, speedKmh/hr, hr, speedKmh, source, sessionId);
  }
  if(effectiveType==='long'){
    if(obj.stravaImport && obj.stravaImport.decoupling && obj.stravaImport.decoupling.decouplingPct!=null){
      await appendTrendPoint('decoupling-history', completedDateStr, {value: obj.stravaImport.decoupling.decouplingPct, sessionId});
    }
    if(obj.stravaImport && obj.stravaImport.cadenceFade && obj.stravaImport.cadenceFade.fadePct!=null){
      await appendTrendPoint('cadence-fade-history', completedDateStr, {value: obj.stravaImport.cadenceFade.fadePct, sessionId});
    }
  }
  // Training load (see coach/training-load.js's ACWR): every real numeric estimate of THIS
  // session's own load, not the plan's expectation of it - a Strava-derived full-stream
  // TRIMP when available, else the session-average formula from a manually-typed avgHR, else
  // nothing rather than a fabricated number. Any effort type contributes, not just long or
  // interval days - the acute:chronic ratio needs the whole training picture, easy days
  // (and swapped/extra ones) included, to mean anything.
  const sessionTrimp = (obj.stravaImport && obj.stravaImport.estimatedTRIMP!=null)
    ? obj.stravaImport.estimatedTRIMP
    : computeSessionTRIMP(parseFloat(obj.avgHR), parseFloat(obj.actualDur), profile);
  if(sessionTrimp!=null) await appendTrendPoint('trimp-history', completedDateStr, {value: sessionTrimp, sessionId});

  if(obj.stravaImport && Array.isArray(obj.stravaImport.laps)){
    const workLaps = obj.stravaImport.laps.filter(l=>l.role==='work' && l.timeToTargetSec!=null);
    const recoveryLaps = obj.stravaImport.laps.filter(l=>(l.role==='recovery'||l.role==='cooldown') && l.recoveryHRDropBpm!=null);
    if(workLaps.length){
      const avgTTT = workLaps.reduce((s,l)=>s+l.timeToTargetSec,0)/workLaps.length;
      await appendTrendPoint('timetotarget-history', completedDateStr, {value:Math.round(avgTTT), sessionType:effectiveType, sampleSize:workLaps.length, sessionId});
    }
    if(recoveryLaps.length){
      const avgDrop = recoveryLaps.reduce((s,l)=>s+l.recoveryHRDropBpm,0)/recoveryLaps.length;
      await appendTrendPoint('hrrecovery-history', completedDateStr, {value:Math.round(avgDrop*10)/10, sessionType:effectiveType, sampleSize:recoveryLaps.length, sessionId});
    }
    if(obj.performedMode==='treadmill' && obj.treadmillLTSpeed){
      const wearableLap = obj.stravaImport.laps.find(l=>l.role==='work' && l.avgPaceLabel);
      if(wearableLap){
        const wearablePaceSec = wearableLap.avgPaceSec!=null ? wearableLap.avgPaceSec : parsePaceLabelToSec(wearableLap.avgPaceLabel);
        const inclinePct = (obj.treadmillIncline!=null && obj.treadmillIncline!=='') ? parseFloat(obj.treadmillIncline) : TREADMILL_DEFAULT_INCLINE_PCT;
        const point = computeTreadmillCalibrationPoint(wearablePaceSec, parseFloat(obj.treadmillLTSpeed), inclinePct, wearableLap.paceSource);
        // dayType tags which pace band this point was captured at (threshold vs vo2max) -
        // see getIndoorWearableCalibration's same-band-preferred matching in tier-estimates.js.
        if(point) await appendTrendPoint('indoor-wearable-calibration', completedDateStr, Object.assign({sessionId, dayType: effectiveType}, point));
      }
    }
  }
}
