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
  // Trail terrain (technical/uneven footing) slows genuine pace at a given HR independent of
  // fitness or effort - the same corrupting effect treadmill/GPS-source mismatches already
  // get corrected for elsewhere, but nothing to correct FOR here, so the honest move is to
  // just not feed these two specific pace-derived trends from a trail session at all, not
  // feed them a wrong number. Decoupling is pace/HR drift within one run - equally pace-
  // dependent, equally corrupted by terrain. Cadence fade (stride rate, not pace) and the
  // HR-only trends below (trimp/time-to-target/HR-recovery) aren't pace-based and still feed
  // normally regardless of terrain.
  const trailPaceUnreliable = !!obj.trailRun;
  if(effectiveType==='easy' && !trailPaceUnreliable){
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
  // A race is functionally a maximal, real-effort "long run" for durability purposes -
  // arguably BETTER within-run fade evidence than an ordinary training long run, not worse,
  // since it's run at genuine race intensity over the full goal-relevant duration. Excluding
  // it here (as the code previously did, matching only 'long') meant a real race's decoupling/
  // cadence-fade data - exactly the signal that would have explained a "stiff legs, loss of
  // power" late-race fade - never reached durability tracking at all. See coach/durability.js.
  if(effectiveType==='long' || effectiveType==='race'){
    if(!trailPaceUnreliable && obj.stravaImport && obj.stravaImport.decoupling && obj.stravaImport.decoupling.decouplingPct!=null){
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
    // Time-to-target and HR-recovery are properties of a hard REP - how fast HR climbed into
    // the target zone, and how far it fell in the minute after. On a continuous easy or long
    // run there are no reps: the analysis marks the whole body of the run as one 'work'
    // segment and any trailing ease-off as 'cooldown', so both numbers come out meaningless
    // (real logged examples: a 1-lap 'recovery' reading of -4bpm, i.e. HR rising). Recording
    // them anyway put non-comparable points into the same series as real interval data and
    // corrupted both trends - see getTrendSummary's sessionTypes filter for the read side.
    const isIntervalSession = (effectiveType==='threshold' || effectiveType==='vo2max')
      && !(obj.stravaImport && obj.stravaImport.continuousEffort);
    if(workLaps.length && isIntervalSession){
      const avgTTT = workLaps.reduce((s,l)=>s+l.timeToTargetSec,0)/workLaps.length;
      await appendTrendPoint('timetotarget-history', completedDateStr, {value:Math.round(avgTTT), sessionType:effectiveType, sampleSize:workLaps.length, sessionId});
    }
    if(recoveryLaps.length && isIntervalSession){
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
