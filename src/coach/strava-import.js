// @ts-nocheck
import { state } from '../state.js';
import { threshold } from '../data/plan.js';
import { parseDayTagDate } from '../lib/dates.js';
import { formatMinutesToClock, parsePaceLabelToSec } from '../lib/format.js';
import { computeTRIMP } from '../lib/trimp.js';
import { callAnthropic, stravaGetStreams, stravaListActivities } from './api.js';

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
  html += '<b style="color:var(--easy);">From Strava: '+(parsed.activityName||'activity')+'</b><br>';
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
        const lapSec = parsePaceLabelToSec(l.avgPaceLabel);
        if(lapSec){
          const diff = targetSec - lapSec;
          if(diff > 3){ vsTarget = diff+'s/km faster'; vsColor = 'var(--easy)'; }
          else if(diff < -3){ vsTarget = Math.abs(diff)+'s/km slower'; vsColor = 'var(--vo2)'; }
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
    const structureDesc = state.sessionStructureCache[id] || 'no detailed structure available';
    const target = state.sessionTargetCache[id] || {};
    const analysis = await runStravaAnalysis(chosen, streams, structureDesc, target);
    analysis.estimatedTRIMP = computeTRIMP(streams, state.profile);
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

const STRAVA_ANALYSIS_INSTRUCTIONS = "You will be given a runner's Strava activity streams (time, heart rate, pace/velocity, distance, altitude - resolution=medium, meaning roughly 1000 points spread across the whole activity, so a typical 40-60 minute quality session gets a data point every 2-4 seconds) plus the prescribed structure for the session it was meant to be. Your job is to identify the real interval structure directly from the HR and pace curves - not from any device-provided lap markers, since watches often auto-lap by fixed distance regardless of actual effort changes. Look at the actual shape of the pace and HR curves over the course of the run and identify where effort genuinely drops into a hard, sustained push (a real work rep) versus where it eases back off (recovery, warmup, cooldown). Segment the run into the actual reps and non-work portions you identify from the curve, computing average pace and average HR for each segment you define - these do not need to match any device lap count. For each 'work' segment, don't rely on a generic time-based heuristic - instead, read the actual HR stream and find the real second within that segment when HR first reached the target HR zone floor (given below for this session) and stayed there rather than briefly spiking through it - use only the data from that point onward as the segment's reported avgHR and avgPace, since everything before that point is transition, not steady effort. Report how long that transition took as a 'timeToTargetSec' field on that lap - a faster time-to-target across sessions over time is a real fitness indicator. If HR never actually reached target during a work segment, still report the segment's real avgHR/avgPace as observed and note this plainly in fadeNote rather than pretending it reached target. For any segment immediately following a 'work' segment (whether labeled 'recovery' between reps or 'cooldown' after the last rep), also compute how many bpm HR dropped in the first 60 seconds of that segment (or the full segment if shorter than 60s) - report this as 'recoveryHRDropBpm' on that lap. This is a genuine independent fitness signal (heart rate recovery), distinct from LTHR or VO2max. Classify each segment's role: 'warmup' (easy, at the start), 'work' (a real hard rep), 'recovery' (an easy segment between work reps), 'cooldown' (easy, at the end), or 'unclear' if you genuinely cannot tell. If this is a simple continuous easy run with no interval structure at all, treat the brief settling-in period at the start as 'warmup', the entire steady conversational-effort body as a single 'work' segment relative to the easy-zone HR target, and the final minute or two if effort clearly eases as 'cooldown' - compute timeToTargetSec for that single segment the same way. Set lapsReliable to true if you could confidently derive real segments from the stream data, false only if the stream data doesn't show a clear pattern matching what was prescribed, explaining why in lapNote. Pull elevation into account: if a segment's pace looks slow only because of a climb, note that in elevationNote so a hill-slowed segment isn't misread as underperformance - leave elevationNote as an empty string if flat or not applicable. Compare earlier work segments to later ones: if pace notably slowed and/or HR notably rose later at the same nominal effort, that's a real fade/durability signal worth surfacing in fadeNote; if effort held steady or improved late, say that instead - leave fadeNote as an empty string if there's only one work segment to compare. Only tag a lap's paceSource as 'gps' or 'accelerometer' if genuinely inferable from context given (e.g. an indoor/treadmill activity implies accelerometer-based pace, not GPS) - otherwise omit paceSource from that lap entirely rather than guessing. Separately, calculate a directional estimate from the stream data - your own calculation, not device output, so treat it as approximate: vo2maxEstimate - a rough VO2max in ml/kg/min estimated from the pace-HR relationship during the single most sustained steady-effort work segment (never warmup/recovery/cooldown), using standard submaximal exercise-physiology pace-vs-%HRR relationships. Only include this if there's a genuinely steady segment of at least several minutes; omit it entirely rather than guessing from a short or noisy one. Separately, terrainPaceNote - this runner trains by HR primarily because the home route is hilly and pace targets alone are misleading on it. Using ONLY the 'work' segments plus elevation data for those same segments, work out what pace this runner should target on THIS route to reliably hit the prescribed HR zone next time - a route-specific, terrain-adjusted pace equivalent, not the flat-ground pace table number. If there aren't enough reliable work segments to derive this confidently, say so plainly instead of guessing - leave as an empty string in that case. Return JSON in exactly this shape: {\"totalDistanceKm\":0.0,\"totalDurationMin\":0.0,\"avgHR\":0,\"lapsReliable\":true,\"lapNote\":\"one sentence stating confidence and method, always include this\",\"elevationNote\":\"\",\"fadeNote\":\"\",\"terrainPaceNote\":\"\",\"vo2maxEstimate\":0,\"laps\":[{\"lapNum\":1,\"role\":\"warmup\",\"distanceKm\":0.0,\"durationSec\":0,\"avgHR\":0,\"avgPaceLabel\":\"m:ss/km\",\"paceSource\":\"gps\",\"timeToTargetSec\":0,\"recoveryHRDropBpm\":0}]}. Include every segment you identify, in order. Omit avgHR, avgPaceLabel, distanceKm, timeToTargetSec, recoveryHRDropBpm, or paceSource on any lap where they don't apply or aren't available, rather than guessing or reporting 0/null. Return ONLY the JSON, nothing else.";

async function runStravaAnalysis(activity, streams, structureDesc, target){
  const system = [
    {type:'text', text: STRAVA_ANALYSIS_INSTRUCTIONS, cache_control:{type:'ephemeral'}},
  ];
  const userText = "Activity: "+(activity?activity.name:'unknown')+", "+(activity?activity.distance_km:'?')+"km, "+(activity?Math.round(activity.moving_time_min):'?')+"min.\n"+
    "Prescribed structure: "+structureDesc+"\n"+
    "Target HR zone floor for the main effort: "+(target.hr||'not pace-specific')+(target.pace?(', target pace '+target.pace):'')+".\n"+
    "Runner profile: resting HR "+state.profile.restHR+"bpm, max HR "+state.profile.maxHR+"bpm, LTHR "+state.profile.lthr+"bpm.\n"+
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
  parsed.activityName = activity ? activity.name : undefined;
  parsed.activityDate = activity ? new Date(activity.start_date_local).toLocaleDateString('en-US',{weekday:'short', month:'short', day:'numeric'}) : undefined;
  return parsed;
}

window.importFromStrava = importFromStrava;
window.selectStravaCandidate = selectStravaCandidate;
