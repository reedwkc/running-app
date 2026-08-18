// @ts-nocheck
import { state } from '../state.js';
import { threshold } from '../data/plan.js';
import { parseDayTagDate } from '../lib/dates.js';
import { fmtTime, formatMinutesToClock, parsePaceLabelToSec } from '../lib/format.js';
import { computeDecoupling, computeTRIMP } from '../lib/trimp.js';
import { callAnthropic, stravaGetLaps, stravaGetStreams, stravaListActivities } from './api.js';

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
  if(target && (target.pace || target.hr)){
    html += '<div style="margin-top:8px; padding:6px 8px; background:rgba(232,163,61,0.12); border:1px solid rgba(232,163,61,0.35); border-radius:6px;"><b style="color:var(--threshold);">Prescribed:</b> '+(target.pace||'-')+(target.hr?(' @ '+target.hr+'bpm'):'')+' - compare against each work rep below.</div>';
  }
  if(parsed.lapsReliable===false){
    html += '<div style="margin-top:8px; padding:6px 8px; background:rgba(232,163,61,0.15); border:1px solid rgba(232,163,61,0.4); border-radius:6px; color:var(--threshold);"><b>Laps may not match your reps:</b> '+(parsed.lapNote||'the lap pattern doesn\'t clearly match the prescribed structure.')+' Numbers below are still real Strava data, just review them against how the session actually felt.</div>';
  } else if(parsed.lapNote){
    html += '<div style="margin-top:6px; color:var(--dim); font-size:10.5px;">'+parsed.lapNote+'</div>';
  }
  const targetSec = target ? parsePaceLabelToSec(target.pace) : null;
  if(parsed.laps && parsed.laps.length){
    html += '<table style="width:100%; margin-top:8px; font-size:11.5px; border-collapse:collapse;">';
    html += '<tr style="color:var(--dim); text-align:left;"><th style="padding:2px 6px 2px 0;">Lap</th><th style="padding:2px 6px;">Role</th><th style="padding:2px 6px;">Dist</th><th style="padding:2px 6px;">Pace</th><th style="padding:2px 6px;">HR</th><th style="padding:2px 6px;">vs Target</th></tr>';
    parsed.laps.forEach(l=>{
      const roleColor = l.role==='work' ? 'var(--threshold)' : l.role==='unclear' ? 'var(--dim)' : 'var(--text)';
      let vsTarget = '-';
      let vsColor = 'var(--dim)';
      if(l.role==='work' && targetSec){
        // Prefer the precise numeric pace over re-parsing the whole-second-rounded
        // display label - falls back to the label only for laps saved before avgPaceSec
        // existed.
        const lapSec = l.avgPaceSec!=null ? l.avgPaceSec : parsePaceLabelToSec(l.avgPaceLabel);
        if(lapSec){
          const diff = targetSec - lapSec;
          if(diff > 3){ vsTarget = Math.round(diff)+'s/km faster'; vsColor = 'var(--easy)'; }
          else if(diff < -3){ vsTarget = Math.round(Math.abs(diff))+'s/km slower'; vsColor = 'var(--vo2)'; }
          else{ vsTarget = 'on target'; vsColor = 'var(--text)'; }
        }
      }
      html += '<tr><td style="padding:2px 6px 2px 0;">'+l.lapNum+'</td><td style="padding:2px 6px; color:'+roleColor+';">'+(l.role||'-')+'</td><td style="padding:2px 6px;">'+(l.distanceKm||'-')+'km</td><td style="padding:2px 6px;">'+(l.avgPaceLabel||'-')+'</td><td style="padding:2px 6px;">'+(l.avgHR||'-')+'</td><td style="padding:2px 6px; color:'+vsColor+';">'+vsTarget+'</td></tr>';
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
export function computeAnalysisMetrics(streams, laps, targetHRFloor, isTreadmill, isVo2maxSession){
  const time = streams && streams.time && streams.time.data;
  const hr = streams && streams.heartrate && streams.heartrate.data;
  const speed = streams && streams.velocity_smooth && streams.velocity_smooth.data;
  const dist = streams && streams.distance && streams.distance.data;
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
    const result = {
      lapNum: lap.lapNum, role: lap.role,
      distanceKm: Math.round(((dist[i1]-dist[i0])/1000)*100)/100,
      durationSec: Math.round(lap.endSec-lap.startSec),
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
      // avgHR/avgPaceLabel below fall back to the segment's real observed average -
      // same "report it as observed, don't pretend it reached target" behavior as before.
    }
    const avgHRVal = avgOverRange(hr, effI0, i1);
    const avgSpeedVal = avgOverRange(speed, effI0, i1);
    if(avgHRVal!=null) result.avgHR = Math.round(avgHRVal);
    if(avgSpeedVal!=null && avgSpeedVal>0){
      // avgPaceSec carries the real precision through to any downstream calculation
      // (VO2max estimate here, the "vs Target" diff, the easy-run efficiency trend and
      // indoor/treadmill calibration in week-view.js) - avgPaceLabel is whole-second-
      // rounded purely for display and must never be re-parsed as if it were the source
      // number, which is exactly what re-parsing it used to do: round to the nearest
      // second, THEN do math on that rounded value, compounding error into things like
      // the persisted efficiency-history trend for no reason.
      result.avgPaceSec = Math.round((1000/avgSpeedVal)*1000)/1000;
      result.avgPaceLabel = fmtTime(result.avgPaceSec)+'/km';
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
  // aerobic effort. Applying it to a threshold/sub-threshold session's work laps (by
  // design well below LTHR, sustainable for the whole set - see WHY.threshold's own "aim
  // mid-zone, not pinned at the top" tip) computes the oxygen cost of THRESHOLD pace, not
  // VO2max, and will always undershoot a real measured VO2max - caught via a real session
  // where this produced 48.4 from a threshold session's slowest rep (4:27/km) against a
  // Garmin-measured VO2max of 53-54. Gated to actual VO2max-type sessions only.
  let vo2maxEstimate = null;
  if(isVo2maxSession){
    const workLaps = enrichedLaps.filter(l=>l.role==='work' && l.avgPaceSec && l.durationSec);
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
export function buildBoundariesFromStravaLaps(rawLaps){
  let cursor = 0;
  return rawLaps.map(l=>{
    const startSec = cursor;
    const endSec = cursor + (l.elapsedTimeSec||0);
    cursor = endSec;
    return {lapNum: l.lapNum, startSec, endSec};
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
  if(statusEl) statusEl.innerHTML = '<div class="note">Checking Strava...</div>';
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
  if(statusEl) statusEl.innerHTML = '<div class="note">Pulling activity data and analyzing...</div>';
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
    const isVo2maxSession = state.sessionTypeCache[id]==='vo2max';
    const analysis = await runStravaAnalysis(chosen, streams, structureDesc, target, isTreadmill, realLaps, isVo2maxSession);
    analysis.estimatedTRIMP = computeTRIMP(streams, state.profile);
    analysis.decoupling = computeDecoupling(streams);
    state.stravaImportCache[id] = analysis;
    if(statusEl) statusEl.innerHTML = renderStravaLapTable(analysis, target);
    const distEl = document.getElementById(id+'-actualdist');
    const durEl = document.getElementById(id+'-actualdur');
    if(distEl && analysis.totalDistanceKm) distEl.value = analysis.totalDistanceKm;
    if(durEl && analysis.totalDurationMin) durEl.value = formatMinutesToClock(analysis.totalDurationMin);
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
// timeToTarget, recoveryHRDrop, paceSource, VO2max estimate) is computed deterministically
// afterward from the raw stream by computeAnalysisMetrics, using whichever boundaries apply.
const STRAVA_ANALYSIS_INSTRUCTIONS = "You will be given a runner's Strava activity streams (time, heart rate, pace/velocity, distance, altitude - resolution=medium, meaning roughly 1000 points spread across the whole activity, so a typical 40-60 minute quality session gets a data point every 2-4 seconds) plus the prescribed structure for the session it was meant to be. You may ALSO be given this activity's real, device-recorded laps - exact elapsed-time boundaries already measured by the watch itself, either from a structured workout auto-advancing through each planned step or the runner manually pressing lap (both equally real and equally trustworthy, and you cannot and don't need to tell which one produced them). If real laps are given: they are the authoritative segment boundaries - use them exactly as given, do not redraw, merge, split, shift, or second-guess them in any way. Your only job for each one is to classify its role, using the real pace/HR numbers given for each lap plus the streams for extra context (elevation, fade). If real laps are NOT given, you need to find the boundaries yourself: identify the real interval structure directly from the HR and pace curves - not from any device-provided lap markers, since watches often auto-lap by fixed distance regardless of actual effort changes. Look at the actual shape of the pace and HR curves over the course of the run and identify where effort genuinely drops into a hard, sustained push (a real work rep) versus where it eases back off (recovery, warmup, cooldown). For each segment, report startSec and endSec - the elapsed-time offsets (matching the 'time' stream's own values) where it begins and ends. These do not need to match any device lap count. Boundary placement, especially recovery-to-work transitions: heart rate lags actual effort by roughly 60-120 seconds at the start of any hard rep - normal physiology, not a sign the runner started slow. If you draw a boundary purely from when HR starts climbing, the runner may already be running at full work pace for a while before HR shows it - so the tail end of what you call 'recovery' can end up including real work-pace running with still-low HR, which will make that recovery segment's real computed numbers look implausibly fast once averaged (sometimes faster than the actual work reps) despite low HR. To avoid this: watch the PACE/velocity curve too, not just HR, and draw the recovery-to-work boundary at the point pace visibly begins its sustained rise toward work effort, even if HR hasn't caught up yet. The same lag applies in reverse at the end of a work rep (effort eases before HR drops) - use pace there too, not HR alone, for the work-to-recovery boundary. Either way, you do NOT compute any numeric average yourself (no avgHR, avgPace, distance, duration) - those are always computed deterministically afterward from the real stream data using whichever boundaries apply, so don't report them. Classify each segment's role: 'warmup' (easy, at the start), 'work' (a real hard rep), 'recovery' (an easy segment between work reps), 'cooldown' (easy, at the end), or 'unclear' if you genuinely cannot tell. If this is a simple continuous easy run with no interval structure at all (and no real laps were given), treat the brief settling-in period at the start as 'warmup', the entire steady conversational-effort body as a single 'work' segment relative to the easy-zone HR target, and the final minute or two if effort clearly eases as 'cooldown'. Set lapsReliable to true if you're confident in the role classification (whether from real laps or your own curve-reading), false only if the pattern genuinely doesn't match what was prescribed, explaining why in lapNote (always include lapNote - one sentence stating confidence and method - and say plainly whether it's based on real device laps or curve-reading). Pull elevation into account: if a segment's pace looks slow only because of a climb, note that in elevationNote so a hill-slowed segment isn't misread as underperformance later - leave elevationNote as an empty string if flat or not applicable. Compare earlier work segments to later ones by eye (pace holding vs fading, HR rising at the same effort, or a work segment that never actually reached the target HR zone): if there's a real fade/durability signal, surface it in fadeNote; if effort held steady or improved late, say that instead - leave fadeNote as an empty string if there's only one work segment to compare. Separately, terrainPaceNote - this runner trains by HR primarily because the home route is hilly and pace targets alone are misleading on it. Looking at the work segments plus elevation data for those same segments, work out what pace this runner should target on THIS route to reliably hit the prescribed HR zone next time - a route-specific, terrain-adjusted pace equivalent, not the flat-ground pace table number. If there aren't enough reliable work segments to judge this confidently, say so plainly instead of guessing - leave as an empty string in that case. Return JSON in exactly this shape: {\"lapsReliable\":true,\"lapNote\":\"one sentence stating confidence and method, always include this\",\"elevationNote\":\"\",\"fadeNote\":\"\",\"terrainPaceNote\":\"\",\"laps\":[{\"lapNum\":1,\"role\":\"warmup\"}]} - if real laps were given, use their exact lapNum values, one entry per lap, role only, nothing else per lap. If you had to find boundaries yourself, also include startSec and endSec on each lap: {\"lapNum\":1,\"role\":\"warmup\",\"startSec\":0,\"endSec\":0}. Return ONLY the JSON, nothing else.";

async function runStravaAnalysis(activity, streams, structureDesc, target, isTreadmill, realLaps, isVo2maxSession){
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
  const targetHRFloor = target && target.hr ? parseFloat(target.hr) : null;
  const metrics = computeAnalysisMetrics(streams, boundaries, targetHRFloor, isTreadmill, isVo2maxSession);
  parsed.totalDistanceKm = metrics.totalDistanceKm;
  parsed.totalDurationMin = metrics.totalDurationMin;
  parsed.avgHR = metrics.avgHR;
  if(metrics.vo2maxEstimate!=null) parsed.vo2maxEstimate = metrics.vo2maxEstimate;
  parsed.laps = metrics.laps;
  parsed.lapsSource = realLaps && realLaps.length ? 'device' : 'curve-reading';
  parsed.activityName = activity ? activity.name : undefined;
  parsed.activityDate = activity ? new Date(activity.start_date_local).toLocaleDateString('en-US',{weekday:'short', month:'short', day:'numeric'}) : undefined;
  // week-view.js's saveWorkoutLog reads this (activityDateISO) to set completedAt to the
  // real workout date instead of whenever Save was clicked - it was referenced there all
  // along but never actually produced here, so completedAt (and everything downstream of
  // it: trend-history dates, days-since-last-activity) has always silently used save time,
  // most visible when re-importing/re-saving a session days after it was actually run.
  parsed.activityDateISO = activity ? new Date(activity.start_date_local).toISOString().slice(0,10) : undefined;
  return parsed;
}

window.importFromStrava = importFromStrava;
window.selectStravaCandidate = selectStravaCandidate;
