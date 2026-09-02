// @ts-nocheck
import { state } from '../state.js';
import { threshold } from '../data/plan.js';
import { dateToYMD, parseDayTagDate } from '../lib/dates.js';
import { fmtTime, formatMinutesToClock, parsePaceLabelToSec } from '../lib/format.js';
import { flatTargetToGradedPaceSec, gradeAdjustedPaceSec } from '../lib/gap.js';
import { computeCadenceFade, computeDecoupling, computeTRIMP } from '../lib/trimp.js';
import { callAnthropic, stravaGetLaps, stravaGetStreams, stravaListActivities } from './api.js';
import { ACWR_MIN_HISTORY_DAYS, computeACWR, loadTrimpHistory, trimpHistorySpanDays } from './training-load.js';

// The transient "still working" states (as opposed to a real result or a real error) are
// easy to miss against the rest of the muted .note text on the page - same orange-tinted
// callout language already used elsewhere for something worth the eye landing on (see
// .change-note, the overdue-workout note in week-view.js), reused here rather than a new
// color invented just for this.
function importingNoteHTML(text){
  return '<div class="note" style="border-top:none; padding-top:0; color:var(--threshold);">'+text+'</div>';
}

export function renderStravaConfirmation(parsed){
  if(!parsed) return '';
  const distText = parsed.totalDistanceKm ? parsed.totalDistanceKm+'km' : '';
  const durText = parsed.totalDurationMin ? formatMinutesToClock(parsed.totalDurationMin) : '';
  return '<div style="margin-top:10px; padding:10px 12px; background:rgba(95,168,160,0.12); border:1.5px solid rgba(95,168,160,0.45); border-radius:8px;">'+
    '<div style="color:var(--easy); font-weight:600; font-size:12.5px;">&#10003; Imported from Strava</div>'+
    '<div style="margin-top:3px; font-size:12px;">'+(parsed.activityName||'Activity')+(parsed.activityDate?(' - '+parsed.activityDate):'')+'</div>'+
    ((distText||durText) ? ('<div style="margin-top:2px; font-size:12px; color:var(--dim);">'+[distText,durText].filter(Boolean).join(' in ')+'</div>') : '')+
    '<div style="margin-top:6px; font-size:10.5px; color:var(--dim);">Save the card and the coach will walk you through what it means.</div>'+
    '</div>';
}

export function renderStravaLapTable(parsed, target){
  let html = '<div class="note" style="border-top:none; padding-top:0; margin-top:0; background:rgba(95,168,160,0.09); border:1px solid rgba(95,168,160,0.3); border-radius:8px; padding:10px 12px;">';
  html += '<b style="color:var(--easy);">From Strava: '+(parsed.activityName||'activity')+'</b>'+
    (parsed.lapsSource ? (' <span style="font-size:9.5px; text-transform:uppercase; letter-spacing:0.03em; padding:1px 6px; border-radius:4px; '+(parsed.lapsSource==='device' ? 'background:rgba(95,168,160,0.2); color:var(--easy);' : 'background:rgba(232,163,61,0.18); color:var(--threshold);')+'">'+(parsed.lapsSource==='device' ? 'Real device laps' : 'Curve-read estimate')+'</span>') : '')+
    '<br>';
  html += (parsed.totalDistanceKm?parsed.totalDistanceKm+'km':'')+(parsed.totalDurationMin?(' - '+formatMinutesToClock(parsed.totalDurationMin)):'')+(parsed.avgHR?(' - avg '+parsed.avgHR+'bpm'):'');
  if(parsed.estimatedTRIMP || parsed.vo2maxEstimate){
    html += '<div style="margin-top:4px; font-size:10.5px; color:var(--dim);"><b style="color:var(--long);">Estimate (not device-measured):</b> '+[parsed.estimatedTRIMP?('TRIMP ~'+parsed.estimatedTRIMP):'', parsed.vo2maxEstimate?('VO2max ~'+parsed.vo2maxEstimate):''].filter(Boolean).join(' &middot; ')+'</div>';
  }
  // A session judges itself on its own numbers first - the plan's target is only relevant
  // context when the runner actually ran roughly the planned session (planMatched). A
  // surprise workout, a cut-short day, or anything else that diverges from what was
  // scheduled still gets full, accurate real-number treatment below; it just doesn't get
  // measured against a target that was never really the point of that run.
  const planMatched = parsed.lapsReliable !== false;
  if(planMatched && target && (target.pace || target.hr)){
    // target.pace is deliberately '' (not missing) for easy/hill/fartlek days - pace isn't
    // the real target there, HR is - so this reads as bare "138-154bpm" for those instead
    // of the malformed "- @ 138-154bpm" a naive pace-first join would produce.
    const prescribedText = target.pace ? (target.pace+(target.hr?(' @ '+target.hr+'bpm'):'')) : (target.hr+'bpm');
    html += '<div style="margin-top:8px; padding:6px 8px; background:rgba(232,163,61,0.12); border:1px solid rgba(232,163,61,0.35); border-radius:6px;"><b style="color:var(--threshold);">Prescribed:</b> '+prescribedText+' - compare against each work rep below.</div>';
  }
  if(!planMatched){
    html += '<div style="margin-top:8px; padding:6px 8px; background:rgba(232,163,61,0.15); border:1px solid rgba(232,163,61,0.4); border-radius:6px; color:var(--threshold);"><b>Different from what was planned:</b> '+(parsed.lapNote||'the lap pattern doesn\'t clearly match the prescribed structure.')+' That\'s fine - the numbers below are real and judged on their own terms, not measured against a target that wasn\'t really this run\'s target.</div>';
  } else if(parsed.lapNote){
    html += '<div style="margin-top:6px; color:var(--dim); font-size:10.5px;">'+parsed.lapNote+'</div>';
  }
  const targetSec = planMatched && target ? parsePaceLabelToSec(target.pace) : null;
  if(parsed.laps && parsed.laps.length){
    // Only surface the grade-adjustment explanation when it actually applies to something
    // in this table - most sessions have no meaningfully graded segment, and the note
    // would just be noise on those.
    const hasGradedLap = parsed.laps.some(l=>l.avgGradePct!=null && Math.abs(l.avgGradePct)>=1 && l.gapPaceLabel);
    if(hasGradedLap){
      html += '<div style="margin-top:6px; color:var(--dim); font-size:10.5px;">GAP = grade-adjusted pace (Minetti model) - the flat-ground-equivalent effort for a graded segment\'s real pace. Shown alongside actual pace where the grade is meaningful, and used (not raw pace) for vs Target on those segments, since a flat-ground target isn\'t a fair comparison on a hill.</div>';
    }
    html += '<table style="width:100%; margin-top:8px; font-size:11.5px; border-collapse:collapse;">';
    html += '<tr style="color:var(--dim); text-align:left;"><th style="padding:2px 6px 2px 0;">Lap</th><th style="padding:2px 6px;">Role</th><th style="padding:2px 6px;">Dist</th><th style="padding:2px 6px;">Pace</th><th style="padding:2px 6px;">HR</th><th style="padding:2px 6px;">vs Target</th></tr>';
    parsed.laps.forEach(l=>{
      // continuousEffort marks a steady easy/long run that got chunked into warmup/work/
      // cooldown purely because the curve-reading fallback always looks for that shape
      // (see STRAVA_ANALYSIS_INSTRUCTIONS) - role stays 'work' since chat.js/week-view.js/
      // weekly-summary.js key off that value to find this segment's pace+HR, but showing
      // the word "work" next to an easy run reads like a hard interval that never happened,
      // so the table label (only the label) is softened here instead.
      const roleLabel = (l.role==='work' && parsed.continuousEffort) ? 'main effort' : (l.role||'-');
      const roleColor = l.role==='work' ? (parsed.continuousEffort ? 'var(--easy)' : 'var(--threshold)') : l.role==='unclear' ? 'var(--dim)' : 'var(--text)';
      // Below a 1% grade, Minetti's own curve is within noise of the flat baseline anyway -
      // not worth a second pace line for a segment that was never meaningfully graded.
      const showGAP = l.avgGradePct!=null && Math.abs(l.avgGradePct)>=1 && l.gapPaceLabel;
      const paceCell = (l.avgPaceLabel||'-') + (showGAP ? ('<br><span style="font-size:9.5px; color:var(--dim);">GAP '+l.gapPaceLabel+' ('+(l.avgGradePct>0?'+':'')+l.avgGradePct+'%)</span>') : '');
      let vsTarget = '-';
      let vsColor = 'var(--dim)';
      if(l.role==='work' && targetSec){
        // Grade-adjusted pace over the raw display label when available - a flat-ground
        // target pace isn't a fair comparison against a hilly segment's raw pace, this is
        // exactly what GAP exists to correct for. Falls back to the precise numeric pace,
        // then the label only for laps saved before avgPaceSec existed.
        const lapSec = l.gapPaceSec!=null ? l.gapPaceSec : (l.avgPaceSec!=null ? l.avgPaceSec : parsePaceLabelToSec(l.avgPaceLabel));
        if(lapSec){
          const diff = targetSec - lapSec;
          if(diff > 3){ vsTarget = Math.round(diff)+'s/km faster'; vsColor = 'var(--easy)'; }
          else if(diff < -3){ vsTarget = Math.round(Math.abs(diff))+'s/km slower'; vsColor = 'var(--vo2)'; }
          else{ vsTarget = 'on target'; vsColor = 'var(--text)'; }
        }
      } else if(l.role==='work' && !targetSec && target && target.hr && l.avgHR){
        // Easy runs (and hill/fartlek/sprint days) deliberately have no pace target -
        // target.pace stays '' on purpose (week-view.js: "route is uneven enough that a
        // pace target would be misleading" for easy, "gradient varies" for hill/fartlek) -
        // so targetSec is always null and this column previously stayed blank for every
        // single lap of exactly the sessions where HR (not pace) IS the real target.
        // Reported live: a real easy-run import showed "-" on all three laps despite a real
        // HR zone (target.hr, e.g. "138-154") and real lap HR both being right there.
        const hrMatch = String(target.hr).match(/(\d+)\D+(\d+)/);
        if(hrMatch){
          const lo = parseInt(hrMatch[1]), hi = parseInt(hrMatch[2]), hr = l.avgHR;
          if(hr < lo){ vsTarget = (lo-hr)+'bpm below zone'; vsColor = 'var(--long)'; }
          else if(hr > hi){ vsTarget = (hr-hi)+'bpm above zone'; vsColor = 'var(--vo2)'; }
          else { vsTarget = 'in zone'; vsColor = 'var(--easy)'; }
        }
      }
      html += '<tr><td style="padding:2px 6px 2px 0;">'+l.lapNum+'</td><td style="padding:2px 6px; color:'+roleColor+';">'+roleLabel+'</td><td style="padding:2px 6px;">'+(l.distanceKm||'-')+'km</td><td style="padding:2px 6px;">'+paceCell+'</td><td style="padding:2px 6px;">'+(l.avgHR||'-')+'</td><td style="padding:2px 6px; color:'+vsColor+';">'+vsTarget+'</td></tr>';
    });
    html += '</table>';
  }
  html += '<div style="margin-top:8px; color:var(--dim); font-size:10.5px;">Distance and duration filled in below. Everything else here - HR, pace, laps - is shown for reference only and saved for the coach to analyze, but the boxes below stay yours to fill in with your own numbers (RPE, avg HR if you want it, Training Effect, load).</div>';
  html += '</div>';
  return html;
}

// Deterministic, computed directly from the raw stream once the analysis has identified
// WHERE each segment's boundaries are (still genuinely a pattern-recognition task, not
// sensibly reduced to a fixed formula for arbitrary session structures) - but not what the
// numbers within those boundaries actually are, which is a plain, verifiable average with
// no reason to trust an LLM's mental arithmetic over the real numbers. This is also what
// actually fixes the "recovery lap reporting a faster pace than the work laps" failure
// mode: even if a boundary is drawn slightly late (bleeding into the start of the next
// work rep), the averaging itself is always the real number for whatever window was given,
// not a second layer of approximation stacked on top of an already-uncertain boundary.
export function computeAnalysisMetrics(streams, laps, targetHRFloor, isTreadmill, profile){
  const time = streams && streams.time && streams.time.data;
  const hr = streams && streams.heartrate && streams.heartrate.data;
  const speed = streams && streams.velocity_smooth && streams.velocity_smooth.data;
  const dist = streams && streams.distance && streams.distance.data;
  // Optional: only some activities have a cadence stream (footpod or cadence-capable
  // watch) - guarded separately from the required streams above so its absence never
  // blocks the rest of the analysis, it just means no avgCadence per lap.
  const cadence = streams && streams.cadence && streams.cadence.data && streams.cadence.data.length===(time&&time.length) ? streams.cadence.data : null;
  // Optional: altitude is requested for every activity (see worker/src/strava.js) but a
  // laps-fetch failure or an activity genuinely recorded without a barometer/GPS-elevation
  // fix would leave it missing - guarded the same way as cadence above so its absence just
  // means no avgGradePct/gapPaceLabel per lap, nothing else in the analysis is affected.
  const altitude = streams && streams.altitude && streams.altitude.data && streams.altitude.data.length===(time&&time.length) ? streams.altitude.data : null;
  if(!time || !hr || !speed || !dist || !time.length) return {laps: laps||[]};

  // idxAtOrAfter(sec) returns time.length (one past the last index) when nothing matches,
  // so idxAtOrAfter(endSec)-1 always resolves to a real index - the LAST sample strictly
  // before endSec. This matters: endSec is shared as the boundary between two adjacent
  // laps, and the very first sample of the NEXT lap typically has time===endSec - using
  // idxAtOrAfter(endSec) directly as an inclusive upper bound would pull that neighbor's
  // sample into this lap's average, exactly the boundary-contamination bug this function
  // exists to eliminate (caught by this file's own tests before it ever shipped).
  const idxAtOrAfter = sec => { for(let i=0;i<time.length;i++){ if(time[i]>=sec) return i; } return time.length; };
  const clampIdx = i => Math.max(0, Math.min(time.length-1, i));
  const avgOverRange = (arr, i0, i1) => {
    if(i1<i0) return null;
    let sum=0, n=0;
    for(let i=i0;i<=i1;i++){ if(arr[i]!=null){ sum+=arr[i]; n++; } }
    return n ? sum/n : null;
  };

  const enrichedLaps = (laps||[]).map(lap=>{
    if(lap.startSec==null || lap.endSec==null || lap.endSec<=lap.startSec) return lap;
    const i0 = clampIdx(idxAtOrAfter(lap.startSec)), i1 = Math.max(i0, clampIdx(idxAtOrAfter(lap.endSec)-1));
    // A real device lap (rawAvgSpeedMps present - see buildBoundariesFromStravaLaps) has its
    // own distance/pace already computed by the watch itself over the exact lap window, at
    // full sensor resolution - genuinely more precise than resampling the medium-resolution
    // "velocity_smooth" stream this function re-fetches, which is a LOW-PASS-FILTERED signal
    // by Strava's own definition. That smoothing lag is proportionally huge on a short, sharp
    // interval (e.g. a ~200m/~45s rep: the filter can't react fast enough to a near-instant
    // accelerate-from-a-jog transition), which is exactly the failure mode reported live -
    // short VO2max-pace reps read meaningfully SLOWER here than the same reps' real pace on
    // Strava/Garmin/a third-party app, because those all use the lap's own native average,
    // not a resampled smoothed stream. Distance gets the same treatment for the same reason.
    // HR deliberately stays stream-based below (the effI0 "reached target and held" trim is
    // a genuine physiological correction Strava's own flat lap average can't provide, and
    // there was no reported HR accuracy problem) - this fix is pace/distance-specific.
    const hasRawLap = lap.rawAvgSpeedMps!=null && lap.rawAvgSpeedMps>0;
    const result = {
      lapNum: lap.lapNum, role: lap.role,
      distanceKm: hasRawLap && lap.rawDistanceM!=null ? Math.round((lap.rawDistanceM/1000)*100)/100 : Math.round(((dist[i1]-dist[i0])/1000)*100)/100,
      durationSec: Math.round(lap.endSec-lap.startSec),
      // Still 'gps' regardless of whether the number came from a real device lap or the
      // resampled stream below - paceSource here means WHICH SENSOR (gps vs accelerometer
      // vs, elsewhere, Stryd), a real outdoor device lap is still GPS-derived, chat.js/
      // session-trends.js key off this exact string for Stryd-vs-GPS calibration logic that
      // has nothing to do with which of this file's two computation paths produced the number.
      paceSource: isTreadmill ? 'accelerometer' : 'gps',
    };
    let effI0 = i0;
    if(lap.role==='work' && targetHRFloor!=null){
      // Same "reached the floor and held, not a brief spike" logic previously asked of
      // the LLM to eyeball - now a plain threshold-crossing scan over the real HR values.
      for(let i=i0;i<=i1;i++){
        if(hr[i]>=targetHRFloor){
          const holdUntilSec = time[i]+15;
          let held = true;
          for(let j=i;j<=i1 && time[j]<=holdUntilSec;j++){ if(hr[j]<targetHRFloor){ held=false; break; } }
          if(held){ result.timeToTargetSec = Math.round(time[i]-lap.startSec); effI0 = i; break; }
        }
      }
      // If target was never reached-and-held, effI0 stays at the segment start, so
      // avgHR below falls back to the segment's real observed average - same "report it
      // as observed, don't pretend it reached target" behavior as before.
    }
    const avgHRVal = avgOverRange(hr, effI0, i1);
    if(avgHRVal!=null) result.avgHR = Math.round(avgHRVal);
    if(cadence){
      const avgCadenceVal = avgOverRange(cadence, effI0, i1);
      // Strava reports cadence as one-leg steps/min for runs - doubled here so it reads
      // as the total steps/min a runner actually thinks in (matches what a watch displays).
      if(avgCadenceVal!=null) result.avgCadence = Math.round(avgCadenceVal*2);
    }
    if(hasRawLap){
      // avgPaceSec carries the real precision through to any downstream calculation
      // (VO2max estimate here, the "vs Target" diff, the easy-run efficiency trend and
      // indoor/treadmill calibration in week-view.js) - avgPaceLabel is whole-second-
      // rounded purely for display and must never be re-parsed as if it were the source
      // number, same reasoning as the stream-derived branch below.
      result.avgPaceSec = Math.round((1000/lap.rawAvgSpeedMps)*1000)/1000;
      result.avgPaceLabel = fmtTime(result.avgPaceSec)+'/km';
    } else {
      const avgSpeedVal = avgOverRange(speed, effI0, i1);
      if(avgSpeedVal!=null && avgSpeedVal>0){
        result.avgPaceSec = Math.round((1000/avgSpeedVal)*1000)/1000;
        result.avgPaceLabel = fmtTime(result.avgPaceSec)+'/km';
      }
    }
    if(altitude && result.avgPaceSec!=null){
      // Grade computed over the SAME window the pace above actually came from - the full
      // raw lap (i0..i1) when using the device lap's own pace, effI0..i1 when falling back
      // to the stream-resampled pace - so the grade and the pace it's adjusting always
      // correspond to the same physical stretch, never a mismatched pairing of the two.
      const gradeI0 = hasRawLap ? i0 : effI0;
      const distM = dist[i1]-dist[gradeI0];
      if(distM > 0){
        const gradeFraction = (altitude[i1]-altitude[gradeI0])/distM;
        result.avgGradePct = Math.round(gradeFraction*1000)/10;
        const gapSec = gradeAdjustedPaceSec(result.avgPaceSec, gradeFraction);
        if(gapSec!=null){
          result.gapPaceSec = Math.round(gapSec*1000)/1000;
          result.gapPaceLabel = fmtTime(result.gapPaceSec)+'/km';
        }
      }
    }
    if(lap.role==='recovery' || lap.role==='cooldown'){
      const dropSec = Math.min(60, lap.endSec-lap.startSec);
      const startHR = hr[i0];
      const hrAtDrop = hr[clampIdx(idxAtOrAfter(lap.startSec+dropSec))];
      if(startHR!=null && hrAtDrop!=null) result.recoveryHRDropBpm = Math.round(startHR-hrAtDrop);
    }
    return result;
  });

  const totalDistanceKm = Math.round(((dist[dist.length-1]-dist[0])/1000)*100)/100;
  const totalDurationMin = Math.round(((time[time.length-1]-time[0])/60)*10)/10;
  const avgHRTotal = avgOverRange(hr, 0, hr.length-1);

  // VO2max estimate: the ACSM running metabolic equation (VO2 ml/kg/min ≈ 3.33×speed_kmh
  // + 3.5, see chat.js) gives the oxygen COST of running at a given pace - it only
  // approximates VO2max when that pace is genuinely at-or-near the runner's maximal
  // aerobic effort. Applying it to a threshold/sub-threshold effort (by design well below
  // LTHR, sustainable for the whole set - see WHY.threshold's own "aim mid-zone, not pinned
  // at the top" tip) computes the oxygen cost of THRESHOLD pace, not VO2max, and will always
  // undershoot a real measured VO2max - caught via a real session where this produced 48.4
  // from a threshold session's slowest rep (4:27/km) against a Garmin-measured VO2max of
  // 53-54. Gated on the SESSION'S OWN observed intensity (a work lap's real avgHR against
  // this runner's real maxHR), not on whatever was scheduled that day - a planned easy day
  // that turns into genuine near-max effort (a surprise workout, a race-pace pickup) earns
  // the same estimate a scheduled VO2max day would, and a scheduled VO2max day that was run
  // easy correctly gets none. Genuine VO2max-intensity work reliably pushes HR into the
  // low-to-mid 90s% of max by the end of a multi-minute rep, even accounting for the same
  // HR-lag described throughout this file; sustained threshold effort tops out lower than
  // that, which is the real distinction being detected here, not the plan.
  const NEAR_MAX_HR_FRACTION = 0.90;
  let vo2maxEstimate = null;
  if(profile && profile.maxHR){
    const workLaps = enrichedLaps.filter(l=>l.role==='work' && l.avgPaceSec && l.durationSec && l.avgHR!=null && l.avgHR>=profile.maxHR*NEAR_MAX_HR_FRACTION);
    if(workLaps.length){
      const longest = workLaps.reduce((a,b)=> b.durationSec>a.durationSec ? b : a);
      if(longest.durationSec >= 120){
        const paceSec = longest.avgPaceSec;
        if(paceSec){
          const speedKmh = 3600/paceSec;
          vo2maxEstimate = Math.round((3.33*speedKmh+3.5)*10)/10;
        }
      }
    }
  }

  return {
    totalDistanceKm, totalDurationMin,
    avgHR: avgHRTotal!=null ? Math.round(avgHRTotal) : null,
    vo2maxEstimate,
    laps: enrichedLaps
  };
}

// Distinguishes real, effort-based laps (a structured workout auto-advancing through each
// planned step, or the runner manually pressing lap - indistinguishable at the API level,
// and equally trustworthy either way) from a meaningless default fixed-distance autolap
// (e.g. "every 1km, always on"), which most watches apply automatically regardless of
// effort and would otherwise look like "real laps" too. Real effort laps vary a lot in
// distance rep to rep (a 1000m work rep next to a 400m recovery jog); a fixed-distance
// autolap produces laps that are all close to the same distance by definition. Deliberately
// a deterministic, testable check rather than an LLM judgment call - this decides whether
// the foundation for everything downstream is real device data or a guess, so it can't
// itself be a guess.
export function isPlausibleLapStructure(rawLaps){
  if(!rawLaps || rawLaps.length < 3) return false;
  const distances = rawLaps.map(l=>l.distanceM).filter(d=>d!=null && d>0);
  if(distances.length < rawLaps.length) return false;
  const mean = distances.reduce((a,b)=>a+b,0)/distances.length;
  if(mean<=0) return false;
  const variance = distances.reduce((s,d)=>s+Math.pow(d-mean,2),0)/distances.length;
  const coefficientOfVariation = Math.sqrt(variance)/mean;
  return coefficientOfVariation > 0.15;
}

// Real Strava laps tile the activity back-to-back by elapsed time with no gaps, so their
// boundaries in the stream's own time axis are just a running total of each lap's duration.
// Also carries the lap's own raw device-measured distance/speed/HR through (rawDistanceM/
// rawAvgSpeedMps/rawAvgHR) - computeAnalysisMetrics prefers these over resampling the
// medium-resolution stream for a real device lap (see its own comment on why).
export function buildBoundariesFromStravaLaps(rawLaps){
  let cursor = 0;
  return rawLaps.map(l=>{
    const startSec = cursor;
    const endSec = cursor + (l.elapsedTimeSec||0);
    cursor = endSec;
    return {lapNum: l.lapNum, startSec, endSec, rawDistanceM: l.distanceM, rawAvgSpeedMps: l.avgSpeedMps, rawAvgHR: l.avgHR};
  });
}

// Phase 1 (cheap, no Claude): list nearby Strava activities and let the runner pick
// which one this session actually was, instead of having Claude guess-then-retry -
// each retry of the old flow re-ran the full expensive analysis from scratch.
export async function importFromStrava(btnEl, id, dayTag, sessionName){
  if(state.stravaImportInFlight[id]) return;
  state.stravaImportInFlight[id] = true;
  state.stravaSessionNameCache[id] = sessionName;
  state.stravaDayTagCache[id] = dayTag;
  const origBtnText = btnEl ? btnEl.innerText : '';
  if(btnEl){ btnEl.disabled = true; btnEl.innerText = 'Looking...'; btnEl.style.opacity = '0.6'; }
  const statusEl = document.getElementById(id+'-stravastatus');
  if(statusEl) statusEl.innerHTML = importingNoteHTML('Checking Strava...');
  try{
    const dDate = parseDayTagDate(dayTag);
    const centerSec = dDate ? Math.floor(dDate.getTime()/1000) : Math.floor(Date.now()/1000);
    const afterSec = centerSec - 3*86400;
    const beforeSec = centerSec + 4*86400; // +4 to make the end-of-day inclusive of day+3
    const activities = (await stravaListActivities(afterSec, beforeSec)).filter(a => a.type==='Run' || a.type==='TrailRun' || a.type==='VirtualRun');
    state.stravaCandidatesCache[id] = activities;
    if(!activities.length){
      if(statusEl) statusEl.innerHTML = '<div class="note">No running activities found within a few days of '+dayTag+' - fill in manually below.</div>';
      return;
    }
    if(activities.length===1){
      // Nothing to disambiguate - the "which one was this?" picker only exists to resolve
      // real ambiguity between multiple candidates, so a single match should go straight
      // to analysis instead of making the runner confirm a choice that was never a choice.
      if(statusEl) statusEl.innerHTML = importingNoteHTML('Found one matching activity - analyzing...');
      await selectStravaCandidate(id, activities[0].id);
      return;
    }
    if(statusEl) statusEl.innerHTML = renderStravaCandidatePicker(id, activities);
  }catch(e){
    console.error('strava activity list failed', e);
    if(statusEl) statusEl.innerHTML = '<div class="note">Could not reach Strava (' + (e.message||'unknown error') + ') - fill in manually below.</div>';
  }finally{
    delete state.stravaImportInFlight[id];
    if(btnEl){ btnEl.disabled = false; btnEl.innerText = origBtnText; btnEl.style.opacity = ''; }
  }
}

export function renderStravaCandidatePicker(id, activities){
  const rows = activities.map(a=>{
    const dateLabel = new Date(a.start_date_local).toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'});
    const detail = [a.distance_km?(a.distance_km+'km'):'', a.moving_time_min?(Math.round(a.moving_time_min)+'min'):'', a.average_heartrate?(Math.round(a.average_heartrate)+'bpm avg'):''].filter(Boolean).join(' &middot; ');
    return '<button class="ghost-btn" style="display:block; width:100%; text-align:left; margin-top:6px; padding:8px 10px;" onclick="selectStravaCandidate(\''+id+'\','+a.id+')">'+
      '<b>'+(a.name||'Activity')+'</b><br><span style="color:var(--dim); font-size:11px;">'+dateLabel+' &middot; '+detail+'</span></button>';
  }).join('');
  return '<div class="note" style="border-top:none; padding-top:0;">Which one was this session?</div>'+rows;
}

// Phase 2 (the expensive step, now only paid once a real activity is confirmed):
// fetch its streams (still cheap, direct Strava REST) and run the actual interval
// analysis through Claude.
export async function selectStravaCandidate(id, activityId){
  const statusEl = document.getElementById(id+'-stravastatus');
  if(statusEl) statusEl.innerHTML = importingNoteHTML('Pulling activity data and analyzing...');
  const activities = state.stravaCandidatesCache[id] || [];
  const chosen = activities.find(a=>a.id===activityId);
  try{
    const streams = await stravaGetStreams(activityId);
    // Real device laps take priority when they look like genuine effort boundaries (see
    // isPlausibleLapStructure) - a laps-fetch failure is non-fatal, just falls back to the
    // curve-reading path below exactly as if no real laps existed for this activity.
    let rawLaps = null;
    try{ rawLaps = await stravaGetLaps(activityId); }
    catch(e){ console.error('strava laps fetch failed, falling back to curve-reading', e); }
    const realLaps = (rawLaps && isPlausibleLapStructure(rawLaps)) ? rawLaps : null;
    const structureDesc = state.sessionStructureCache[id] || 'no detailed structure available';
    const target = state.sessionTargetCache[id] || {};
    const isTreadmill = (state.cardModeOverride[id] || state.mode) === 'treadmill';
    const analysis = await runStravaAnalysis(chosen, streams, structureDesc, target, isTreadmill, realLaps);
    analysis.estimatedTRIMP = computeTRIMP(streams, state.profile);
    analysis.decoupling = computeDecoupling(streams);
    analysis.cadenceFade = computeCadenceFade(streams);
    state.stravaImportCache[id] = analysis;
    if(statusEl) statusEl.innerHTML = renderStravaLapTable(analysis, target);
    const distEl = document.getElementById(id+'-actualdist');
    const durEl = document.getElementById(id+'-actualdur');
    if(distEl && analysis.totalDistanceKm) distEl.value = analysis.totalDistanceKm;
    if(durEl && analysis.totalDurationMin) durEl.value = formatMinutesToClock(analysis.totalDurationMin);
    // Only for non-interval sessions: the avgHR field's own placeholder already says
    // "whole-session average is fine here" for easy/long runs (one steady effort, nothing
    // to average around), so analysis.avgHR (the real whole-stream average, not an LLM
    // guess) is exactly what the field wants. Skipped for threshold/vo2max, where the field
    // itself says to skip it - a whole-session average there blends work, recovery, warmup
    // and cooldown into one number that doesn't mean anything.
    const sessionType = state.sessionTypeCache[id];
    const isIntervalSession = sessionType==='threshold' || sessionType==='vo2max';
    const hrEl = document.getElementById(id+'-avghr');
    if(hrEl && !isIntervalSession && analysis.avgHR) hrEl.value = analysis.avgHR;
    // Acute:chronic training load (see coach/training-load.js) - autofilled the same way
    // Garmin's own session/acute/chronic load numbers would read right after finishing
    // this session, but computed from the app's own TRIMP history instead of hand-
    // transcribed. Included here (not yet persisted - that only happens on Save) so the
    // preview reflects "load including this session", matching how a watch reports it
    // post-run. Not gated on session type - unlike avgHR, load is a whole-training-history
    // concept, not specific to a single "main set".
    const sessionLoadEl = document.getElementById(id+'-sessionload');
    const loadNoteEl = document.getElementById(id+'-loadnote');
    if(analysis.estimatedTRIMP!=null){
      if(sessionLoadEl) sessionLoadEl.value = analysis.estimatedTRIMP;
      const history = await loadTrimpHistory();
      const asOf = analysis.activityDateISO || dateToYMD(new Date());
      const historyPoints = history.concat([{date: asOf, value: analysis.estimatedTRIMP}]);
      const acwr = computeACWR(historyPoints, asOf);
      if(acwr){
        const acuteLoadEl = document.getElementById(id+'-acuteload');
        const chronicLoadEl = document.getElementById(id+'-chronicload');
        const loadStatusEl = document.getElementById(id+'-loadstatus');
        if(acuteLoadEl) acuteLoadEl.value = acwr.acute;
        if(chronicLoadEl) chronicLoadEl.value = acwr.chronic;
        if(loadStatusEl && acwr.status) loadStatusEl.value = acwr.status;
        if(loadNoteEl) loadNoteEl.innerHTML = '';
      } else if(loadNoteEl){
        // Fewer than ACWR_MIN_HISTORY_DAYS days of trimp-history: computeACWR returns null
        // rather than a misleadingly precise-looking ratio this early - session load above
        // still stands on its own regardless, acute/chronic/status just can't mean anything
        // yet. Surfaced explicitly (not left silently blank) so this doesn't read as broken -
        // the exact confusion this note exists to head off.
        const spanDays = trimpHistorySpanDays(historyPoints, asOf);
        loadNoteEl.innerHTML = 'Acute/chronic load and status need '+ACWR_MIN_HISTORY_DAYS+'+ days of logged training history to mean anything - '+spanDays+' of '+ACWR_MIN_HISTORY_DAYS+' so far. Session load above is real regardless.';
      }
    }
  }catch(e){
    console.error('strava analysis failed', e);
    delete state.stravaImportCache[id];
    if(statusEl) statusEl.innerHTML = '<div class="note">Analysis failed (' + (e.message||'unknown error') + ') - fill in manually below.</div>';
  }
}

// The model's job depends on whether real device laps are supplied in the user message
// (see runStravaAnalysis below): when they are, they're the authoritative boundaries and
// the model only classifies role + writes the qualitative notes; when they aren't, it has
// to find boundaries itself from the curve shape, same as before. Kept as one static
// instructions block (not two separate prompts) so cache_control's caching stays effective
// across calls - the branch is described here once, the actual real-laps-or-not decision
// and data live in the (uncached) user message instead. Either way, it never computes any
// numeric average itself; every real number (distance, duration, avgHR, avgPace,
// timeToTarget, recoveryHRDrop, paceSource, VO2max estimate, grade-adjusted pace, and the
// terrain-adjusted target pace this route implies) is computed deterministically afterward
// from the raw stream by computeAnalysisMetrics and runStravaAnalysis, using whichever
// boundaries apply - the model was previously asked to guess that last one too
// (terrainPaceNote), which became redundant and occasionally quietly wrong once the real
// Minetti-model computation existed to answer the same question exactly (see gap.js).
const STRAVA_ANALYSIS_INSTRUCTIONS = "You will be given a runner's Strava activity streams (time, heart rate, pace/velocity, distance, altitude - resolution=medium, meaning roughly 1000 points spread across the whole activity, so a typical 40-60 minute quality session gets a data point every 2-4 seconds) plus the prescribed structure for the session it was meant to be. You may ALSO be given this activity's real, device-recorded laps - exact elapsed-time boundaries already measured by the watch itself, either from a structured workout auto-advancing through each planned step or the runner manually pressing lap (both equally real and equally trustworthy, and you cannot and don't need to tell which one produced them). If real laps are given: they are the authoritative segment boundaries - use them exactly as given, do not redraw, merge, split, shift, or second-guess them in any way. Your only job for each one is to classify its role, using the real pace/HR numbers given for each lap plus the streams for extra context (elevation, fade). If real laps are NOT given, you need to find the boundaries yourself: identify the real interval structure directly from the HR and pace curves - not from any device-provided lap markers, since watches often auto-lap by fixed distance regardless of actual effort changes. Look at the actual shape of the pace and HR curves over the course of the run and identify where effort genuinely drops into a hard, sustained push (a real work rep) versus where it eases back off (recovery, warmup, cooldown). For each segment, report startSec and endSec - the elapsed-time offsets (matching the 'time' stream's own values) where it begins and ends. These do not need to match any device lap count. Boundary placement, especially recovery-to-work transitions: heart rate lags actual effort by roughly 60-120 seconds at the start of any hard rep - normal physiology, not a sign the runner started slow. If you draw a boundary purely from when HR starts climbing, the runner may already be running at full work pace for a while before HR shows it - so the tail end of what you call 'recovery' can end up including real work-pace running with still-low HR, which will make that recovery segment's real computed numbers look implausibly fast once averaged (sometimes faster than the actual work reps) despite low HR. To avoid this: watch the PACE/velocity curve too, not just HR, and draw the recovery-to-work boundary at the point pace visibly begins its sustained rise toward work effort, even if HR hasn't caught up yet. The same lag applies in reverse at the end of a work rep (effort eases before HR drops) - use pace there too, not HR alone, for the work-to-recovery boundary. Either way, you do NOT compute any numeric average yourself (no avgHR, avgPace, distance, duration) - those are always computed deterministically afterward from the real stream data using whichever boundaries apply, so don't report them. Classify each segment's role: 'warmup' (easy, at the start), 'work' (a real hard rep), 'recovery' (an easy segment between work reps), 'cooldown' (easy, at the end), or 'unclear' if you genuinely cannot tell. If this is a simple continuous easy run with no interval structure at all (and no real laps were given), treat the brief settling-in period at the start as 'warmup', the entire steady conversational-effort body as a single 'work' segment relative to the easy-zone HR target, and the final minute or two if effort clearly eases as 'cooldown' - and set the top-level continuousEffort field to true. The role must still say 'work' in this case (other parts of the app key off that value to find this segment's pace/HR), continuousEffort is purely a signal for how the UI labels it to the runner (so a steady easy run doesn't get displayed as if it had a hard interval in it). Leave continuousEffort false for any session with real interval structure (recovery segments between work reps, or real device laps). A separate case: the prescribed structure may describe a long run built from multiple back-to-back effort zones with no rep/recovery alternation at all (e.g. an easier zone for the first stretch, then a genuine sustained step up to a harder zone for the remainder, with no recovery jog in between and no return to the easier zone). This is real structure, not a flat single effort - do NOT set continuousEffort for it. Instead find the real point where pace/HR genuinely and durably shifts from one zone to the next (the same 'sustained push, not a blip' logic as any other boundary) and report one 'work' segment per zone in that order (only using 'warmup' for a brief settling-in period before the first zone if there genuinely is one) - each zone's own real pace/HR is worth reporting even though there's no recovery segment separating them. None of this should be bent to fit the prescribed shape, though: your job is to describe what the data actually shows, not to reproduce the plan. If the runner's actual effort clearly diverges from what was planned entirely (an unplanned/surprise session with its own real structure, a session cut short, anything else) - classify the REAL segments, roles, and boundaries you observe in the actual data on their own terms (including genuine work/recovery reps if that's what the data shows, even though the plan said something else, like a continuous easy or long run), don't force it to resemble the prescribed structure just because that's what was expected. Set lapsReliable to true if you're confident in the role classification (whether from real laps or your own curve-reading), false only if the actual pattern genuinely doesn't match what was prescribed - this isn't a failure to flag apologetically, just a factual mismatch worth noting, explaining what actually happened instead in lapNote (always include lapNote - one sentence stating confidence and method - and say plainly whether it's based on real device laps or curve-reading). Pull elevation into account: if a segment's pace looks slow only because of a climb, note that in elevationNote so a hill-slowed segment isn't misread as underperformance later - leave elevationNote as an empty string if flat or not applicable. Compare earlier work segments to later ones by eye (pace holding vs fading, HR rising at the same effort, or a work segment that never actually reached the target HR zone): if there's a real fade/durability signal, surface it in fadeNote; if effort held steady or improved late, say that instead - leave fadeNote as an empty string if there's only one work segment to compare. Do NOT attempt to estimate a route-specific or terrain-adjusted target pace yourself - that number is computed deterministically afterward from the real grade/pace data (see terrainPaceNote in computeAnalysisMetrics's caller), the same real-math-not-LLM-guess reasoning as every other number in this file; nothing here asks you for it. Return JSON in exactly this shape: {\"lapsReliable\":true,\"lapNote\":\"one sentence stating confidence and method, always include this\",\"continuousEffort\":false,\"elevationNote\":\"\",\"fadeNote\":\"\",\"laps\":[{\"lapNum\":1,\"role\":\"warmup\"}]} - if real laps were given, use their exact lapNum values, one entry per lap, role only, nothing else per lap. If you had to find boundaries yourself, also include startSec and endSec on each lap: {\"lapNum\":1,\"role\":\"warmup\",\"startSec\":0,\"endSec\":0}. Return ONLY the JSON, nothing else.";

async function runStravaAnalysis(activity, streams, structureDesc, target, isTreadmill, realLaps){
  const system = [
    {type:'text', text: STRAVA_ANALYSIS_INSTRUCTIONS, cache_control:{type:'ephemeral'}},
  ];
  let realLapsText = '';
  if(realLaps && realLaps.length){
    const lapSummaries = realLaps.map(l=>{
      const paceLabel = l.avgSpeedMps>0 ? fmtTime(1000/l.avgSpeedMps)+'/km' : 'unknown';
      const distKm = l.distanceM!=null ? Math.round(l.distanceM/10)/100 : null;
      return 'Lap '+l.lapNum+': '+(distKm!=null?distKm+'km':'?km')+', '+Math.round(l.elapsedTimeSec||0)+'s, avg pace '+paceLabel+', avg HR '+(l.avgHR||'?')+'bpm';
    }).join('\n');
    realLapsText = "\nThis activity has real, device-recorded laps (already measured, not something to find yourself) - use these exact boundaries, only classify each lap's role:\n"+lapSummaries+"\n";
  }
  const userText = "Activity: "+(activity?activity.name:'unknown')+", "+(activity?activity.distance_km:'?')+"km, "+(activity?Math.round(activity.moving_time_min):'?')+"min.\n"+
    "Prescribed structure: "+structureDesc+"\n"+
    "Target HR zone floor for the main effort: "+(target.hr||'not pace-specific')+(target.pace?(', target pace '+target.pace):'')+".\n"+
    "Runner profile: resting HR "+state.profile.restHR+"bpm, max HR "+state.profile.maxHR+"bpm, LTHR "+state.profile.lthr+"bpm."+
    realLapsText+"\n"+
    "Streams (resolution=medium): "+JSON.stringify(streams);
  const data = await callAnthropic('strava-analysis', system, [{role:'user', content: userText}]);
  const textParts = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text);
  let raw = textParts.join('\n').trim().replace(/```json|```/g,'').trim();
  let parsed;
  try{ parsed = JSON.parse(raw); }
  catch(e){
    const fb = raw.indexOf('{'), lb = raw.lastIndexOf('}');
    if(fb!==-1 && lb>fb){ parsed = JSON.parse(raw.slice(fb, lb+1)); }
    else throw new Error('unparseable analysis response');
  }
  let boundaries;
  if(realLaps && realLaps.length){
    // The model only supplies role per lapNum here - the boundaries themselves are fixed,
    // real, device-recorded data, never taken from the model's response even if it
    // included its own startSec/endSec anyway.
    const realBoundaries = buildBoundariesFromStravaLaps(realLaps);
    const roleByLapNum = {};
    (parsed.laps||[]).forEach(l=>{ if(l.lapNum!=null) roleByLapNum[l.lapNum] = l.role; });
    boundaries = realBoundaries.map(b=>Object.assign({}, b, {role: roleByLapNum[b.lapNum] || 'unclear'}));
  } else {
    boundaries = parsed.laps;
  }
  // The HR-floor "reached target and held" trim (see computeAnalysisMetrics) only makes
  // sense against a target this run was actually trying to hit - once the model itself
  // says the real structure diverged from what was planned (lapsReliable false), fall back
  // to reporting each segment's plain observed average instead of trimming to a floor that
  // was never this run's floor.
  const planMatched = parsed.lapsReliable !== false;
  const targetHRFloor = planMatched && target && target.hr ? parseFloat(target.hr) : null;
  const metrics = computeAnalysisMetrics(streams, boundaries, targetHRFloor, isTreadmill, state.profile);
  parsed.totalDistanceKm = metrics.totalDistanceKm;
  parsed.totalDurationMin = metrics.totalDurationMin;
  parsed.avgHR = metrics.avgHR;
  if(metrics.vo2maxEstimate!=null) parsed.vo2maxEstimate = metrics.vo2maxEstimate;
  parsed.laps = metrics.laps;
  // Deterministic replacement for what used to be an LLM guess at a route-specific,
  // terrain-adjusted target pace (see STRAVA_ANALYSIS_INSTRUCTIONS above - the model is no
  // longer asked for this at all): duration-weighted average grade across today's real work
  // laps, applied to the session's flat-ground target pace via flatTargetToGradedPaceSec
  // (gap.js). Only produced when there's an actual flat pace target to adjust and at least
  // one work lap with a meaningful (>=1%) grade to derive a real adjustment from - chat.js's
  // coach-prompt already treats a present, non-empty terrainPaceNote as "a route-specific
  // pace-equivalent... derived from today's real data" (see its terrainAwarenessInstruction/
  // tier-estimate handling), which was already an accurate description of the INTENT, just
  // not previously an accurate description of how the number was actually produced - so
  // nothing downstream of this field needed to change, only where its value comes from.
  parsed.terrainPaceNote = '';
  const targetPaceSec = target && target.pace ? parsePaceLabelToSec(target.pace) : null;
  if(targetPaceSec){
    const gradedWorkLaps = metrics.laps.filter(l=>l.role==='work' && l.avgGradePct!=null && Math.abs(l.avgGradePct)>=1 && l.durationSec);
    if(gradedWorkLaps.length){
      const totalDur = gradedWorkLaps.reduce((s,l)=>s+l.durationSec,0);
      const avgGradeFraction = gradedWorkLaps.reduce((s,l)=>s+(l.avgGradePct/100)*l.durationSec,0)/totalDur;
      const routePaceSec = flatTargetToGradedPaceSec(targetPaceSec, avgGradeFraction);
      if(routePaceSec){
        const avgGradePctRounded = Math.round(avgGradeFraction*1000)/10;
        parsed.terrainPaceNote = "This route's work segments averaged "+(avgGradePctRounded>0?'+':'')+avgGradePctRounded+"% grade - target roughly "+fmtTime(routePaceSec)+"/km here (not the flat "+target.pace+" table pace) to reliably demand the same effort. Computed from today's real grade/pace data (Minetti model), not a guess.";
      }
    }
  }
  parsed.lapsSource = realLaps && realLaps.length ? 'device' : 'curve-reading';
  parsed.activityName = activity ? activity.name : undefined;
  parsed.activityDate = activity ? new Date(activity.start_date_local).toLocaleDateString('en-US',{weekday:'short', month:'short', day:'numeric'}) : undefined;
  // week-view.js's saveWorkoutLog reads this (activityDateISO) to set completedAt to the
  // real workout date instead of whenever Save was clicked - it was referenced there all
  // along but never actually produced here, so completedAt (and everything downstream of
  // it: trend-history dates, days-since-last-activity) has always silently used save time,
  // most visible when re-importing/re-saving a session days after it was actually run.
  parsed.activityDateISO = activity ? new Date(activity.start_date_local).toISOString().slice(0,10) : undefined;
  // The real clock time the activity started, not just its date - week-view.js's
  // saveWorkoutLog previously had no real time to use here and fell back to a fixed
  // noon placeholder, which then leaked into the coach's own "workout (12:00 PM)"
  // narration regardless of whether the session was actually run at 6am or 9pm.
  parsed.activityStartISO = activity ? new Date(activity.start_date_local).toISOString() : undefined;
  return parsed;
}

window.importFromStrava = importFromStrava;
window.selectStravaCandidate = selectStravaCandidate;
