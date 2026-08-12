import { state } from '../state.js';
import { threshold } from '../data/plan.js';
import { parseDayTagDate } from '../lib/dates.js';
import { formatMinutesToClock, parsePaceLabelToSec } from '../lib/format.js';

export function renderStravaConfirmation(parsed){
  if(!parsed || !parsed.found) return '';
  const distText = parsed.totalDistanceKm ? parsed.totalDistanceKm+'km' : '';
  const durText = parsed.totalDurationMin ? formatMinutesToClock(parsed.totalDurationMin) : '';
  const mismatchNote = parsed.dateDiffersFromPlanned ? '<div style="margin-top:4px; font-size:11px; color:var(--threshold);">&#9888; Found on a different day than planned - noted for the coach, no plan change needed.</div>' : '';
  const multiCandidateNote = parsed.multipleCandidatesFound ? '<div style="margin-top:4px; font-size:11px; color:var(--vo2);">&#9888; Multiple possible activities found nearby - double-check this is the right one before saving.</div>' : '';
  return '<div style="margin-top:10px; padding:10px 12px; background:rgba(95,168,160,0.12); border:1.5px solid rgba(95,168,160,0.45); border-radius:8px;">'+
    '<div style="color:var(--easy); font-weight:600; font-size:12.5px;">&#10003; Imported from Strava</div>'+
    '<div style="margin-top:3px; font-size:12px;">'+(parsed.activityName||'Activity')+(parsed.activityDate?(' - '+parsed.activityDate):'')+'</div>'+
    ((distText||durText) ? ('<div style="margin-top:2px; font-size:12px; color:var(--dim);">'+[distText,durText].filter(Boolean).join(' in ')+'</div>') : '')+
    mismatchNote+multiCandidateNote+
    '<div style="margin-top:6px; font-size:10.5px; color:var(--dim);">Save the card and the coach will walk you through what it means.</div>'+
    '</div>';
}

export function renderStravaLapTable(parsed, target){
  let html = '<div class="note" style="border-top:none; padding-top:0; margin-top:0; background:rgba(95,168,160,0.09); border:1px solid rgba(95,168,160,0.3); border-radius:8px; padding:10px 12px;">';
  html += '<b style="color:var(--easy);">From Strava: '+(parsed.activityName||'activity')+'</b><br>';
  html += (parsed.totalDistanceKm?parsed.totalDistanceKm+'km':'')+(parsed.totalDurationMin?(' - '+formatMinutesToClock(parsed.totalDurationMin)):'')+(parsed.avgHR?(' - avg '+parsed.avgHR+'bpm'):'');
  if(parsed.estimatedTRIMP || parsed.vo2maxEstimate){
    html += '<div style="margin-top:4px; font-size:10.5px; color:var(--dim);"><b style="color:var(--long);">Claude\'s estimate (not device-measured):</b> '+[parsed.estimatedTRIMP?('TRIMP ~'+parsed.estimatedTRIMP):'', parsed.vo2maxEstimate?('VO2max ~'+parsed.vo2maxEstimate):''].filter(Boolean).join(' &middot; ')+'</div>';
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

export async function importFromStrava(btnEl, id, dayTag, sessionName){
  if(state.stravaImportInFlight[id]) return;
  state.stravaImportInFlight[id] = true;
  state.stravaSessionNameCache[id] = sessionName;
  state.stravaDayTagCache[id] = dayTag;
  const origBtnText = btnEl ? btnEl.innerText : '';
  if(btnEl){ btnEl.disabled = true; btnEl.innerText = 'Importing...'; btnEl.style.opacity = '0.6'; }
  const statusEl = document.getElementById(id+'-stravastatus');
  if(statusEl) statusEl.innerHTML = '<div class="note">Contacting Strava...</div>';
  const dDate = parseDayTagDate(dayTag);
  const dateStr = dDate ? dDate.toDateString() : dayTag;
  let rangeStartStr = dateStr, rangeEndStr = dateStr;
  if(dDate){
    const rs = new Date(dDate); rs.setDate(rs.getDate()-3);
    const re = new Date(dDate); re.setDate(re.getDate()+3);
    rangeStartStr = rs.toDateString(); rangeEndStr = re.toDateString();
  }
  const structureDesc = state.sessionStructureCache[id] || 'no detailed structure available';
  try{
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: "You have access to the user's Strava account via MCP tools. Work silently: do not narrate what you are about to do, do not describe which tools you are calling or why, and do not add any commentary before or after your answer. Call whatever tools you need first, then produce your final answer. Your entire final text output must be a single valid JSON object and absolutely nothing else - no markdown code fences, no preamble like 'I'll check...' or 'Found an activity...', no summary or explanation after the JSON either. If you catch yourself about to write a sentence that isn't part of the JSON object, stop and don't write it.",
        messages: [{role:"user", content: "Find my Strava running activity for this session (planned for "+dateStr+", session: '"+sessionName+"')."+((state.stravaRejectedCache[id]&&state.stravaRejectedCache[id].length) ? (" I already reviewed and rejected these as NOT the right match, do not suggest any of them again: "+state.stravaRejectedCache[id].map(r=>r.name+" on "+r.date).join("; ")+".") : "")+" Search the range from "+rangeStartStr+" to "+rangeEndStr+" - the runner sometimes shifts a session to a different day within the same week, so don't restrict the search to the exact planned date alone. If there are MULTIPLE candidate running activities in that range (e.g. the runner has a backlog of several unlogged days), don't just pick the closest date - use the session's prescribed structure (described below) to identify which candidate actually matches that effort pattern (interval structure, duration, HR pattern), since date proximity alone is not a reliable match when several real activities exist in the window. Set a \"multipleCandidatesFound\" boolean field to true if more than one plausible candidate existed in the range, false otherwise, so this can be flagged for a manual double-check even if you made your best-guess match. Only return found:true if you find a genuine matching running activity somewhere in that range - if nothing plausible exists anywhere in the range, return exactly {\"found\":false}. Do not guess or substitute an activity from clearly outside this range as a fallback, even if it seems like a plausible match. The session was actually prescribed as: "+structureDesc+" If you find a genuine match, report its actual recorded name and date in activityName and activityDate so I can visually confirm it is the right one - if the actual date differs from the planned "+dateStr+", that is fine and expected - just report the real date honestly rather than the planned one, and set dateDiffersFromPlanned to true in that case (false if it matches the planned date), so this can be flagged clearly rather than silently assumed, then pull the activity's time-series streams (heart rate, pace/velocity, and distance over time), not just the lap summary - this is the primary source. This may be an indoor/treadmill activity - check what streams actually exist rather than assuming: some indoor activities have only an HR stream (no pace data at all), but others have a pace/velocity stream too, estimated by a chest strap's accelerometer rather than GPS (common with Garmin HRM-Pro/HRM-Run straps) - this accelerometer-based pace is real data but meaningfully less accurate than GPS, prone to drift on a treadmill. If only HR exists, identify the interval structure from the HR curve alone (a hard rep still produces a distinctive HR rise-and-hold pattern even without pace data), compute timeToTargetSec and recoveryHRDropBpm from HR alone exactly as described below since neither needs pace, and simply omit avgPaceLabel/distanceKm and terrainPaceNote/vo2maxEstimate (which do need pace) rather than guessing at pace-dependent values that don't exist. If a pace stream does exist, don't rely on power-stream presence to guess whether Stryd was used - the runner's watch also computes its own power estimate and their Stryd doesn't always broadcast power, so power-stream presence is not a reliable signal either way, don't use it to tag paceSource. Instead, only tag a lap's paceSource as \"stryd\" or \"gps\" or \"accelerometer\" if the activity's own recorded device/sensor name genuinely and explicitly indicates it - otherwise leave paceSource off that lap entirely rather than guessing, since the app has its own manual source selection that the runner sets directly and that always takes priority over anything guessed here. Report distanceKm, avgPaceLabel etc. as observed regardless of source certainty - the source tag is a bonus when genuinely clear, not something to force. For indoor/treadmill activities with a pace stream, if the runner's own manually-logged treadmillLTSpeed value is present for this session too, that's real ground truth (the treadmill's actual mechanical belt speed) worth mentioning as a cross-check against whatever the stream shows, regardless of what tagged the pace stream's source. Report what you genuinely have in every case, don't fabricate what you don't. Look at the actual shape of the pace and HR curves (or HR curve alone if that's all that's available) over the course of the run and identify the real interval structure directly from that signal: where effort genuinely drops into a hard, sustained push (a real work rep) versus where it eases back off (recovery, warmup, cooldown). Do not rely on the watch's own lap markers as your primary method - many watches auto-lap by fixed distance regardless of the actual interval structure, which would misrepresent the real efforts; use device laps only as a secondary cross-check against what the raw curve shows, and note in lapNote if they disagree. Segment the run into the actual reps and non-work portions you identify from the curve, computing average pace and average HR for each segment you define - these do not need to match the device's lap count. For each 'work' segment, don't rely on a generic time-based heuristic (like 'use the back half') - instead, read the actual HR stream and find the real second within that segment when HR first reaches the target HR zone floor ("+(state.sessionTargetCache[id]&&state.sessionTargetCache[id].hr?state.sessionTargetCache[id].hr:'the prescribed target')+" for this session) and stayed there rather than briefly spiking through it - use only the data from that point onward as the segment's reported avgHR and avgPace, since everything before that point is transition, not steady effort. Report how long that transition took as a 'timeToTargetSec' field on that lap - this is itself a genuine, useful signal (a faster time-to-target across sessions over time is a real fitness indicator, a slowing one is worth noting). If HR never actually reached target during a work segment, still report the segment's real avgHR/avgPace as observed and note this plainly in fadeNote rather than pretending it reached target - don't force this method to produce a number that isn't there. For any segment immediately following a 'work' segment - whether it's labeled 'recovery' (between reps) or 'cooldown' (the final easing-off after the last rep) - also compute how many bpm HR dropped in the first 60 seconds of that segment (or the full segment if it's shorter than 60s) - report this as 'recoveryHRDropBpm' on that lap, using this same field name regardless of whether the lap's role is 'recovery' or 'cooldown'. This is a genuine independent fitness signal (heart rate recovery / parasympathetic reactivation) distinct from LTHR or VO2max - a larger drop generally reflects better recovery capacity, and tracking this trend over multiple sessions is valuable even though a single session's number isn't hugely meaningful on its own. Classify each segment's role: 'warmup' (easy, at the start), 'work' (a real hard rep, notably faster/higher-effort than surrounding segments), 'recovery' (an easy segment between work reps), 'cooldown' (easy, at the end), or 'unclear' if you genuinely cannot tell even from the raw curve. If this is a simple continuous easy run with no interval structure at all (check the session description above), there won't be a real work/recovery alternation to find - instead, treat the brief settling-in period at the very start as 'warmup', the entire steady conversational-effort body of the run as a single 'work' segment relative to the easy-zone HR target given above, and the final minute or two if effort clearly eases as 'cooldown' - compute timeToTargetSec for this single 'work' segment the same way as for an interval session's work reps (how long from the start of this segment until HR first settled into the easy zone), since a faster settle into aerobic zone at low effort is exactly as genuine a fitness signal as it is at high effort, just at a different intensity. Set lapsReliable to true if you were able to confidently derive real segments from the stream data (regardless of whether device laps agreed) - set it false only if the stream data itself doesn't show a clear alternating pattern matching what was prescribed, and explain why in lapNote, including whether you used streams or had to fall back to device laps only. Also pull elevation data if available: this route is hilly, so check whether any segment's pace looks slow only because of a climb, and note that in elevationNote so a hill-slowed segment is not misread as a fitness problem. Separately, compare the earlier work segments to the later ones: if pace notably slowed and/or HR notably rose in the later segments compared to the earlier ones at the same nominal effort, that is a real fade/durability signal worth surfacing in fadeNote - if the effort held steady or even improved late, say that instead, it is an equally real and useful signal. Separately, calculate two directional estimates from the same stream data - these are your own calculations, not device output, so treat them as approximate: (1) estimatedTRIMP - a Banister-style Training Impulse score. Using this runner's profile (resting HR "+state.profile.restHR+"bpm, max HR "+state.profile.maxHR+"bpm, LTHR "+state.profile.lthr+"bpm), compute a heart-rate-reserve fraction (HR-rest)/(max-rest) for the HR stream, apply the standard male exponential TRIMP weighting (0.64*e^(1.92*fraction)) to each moment and integrate over session duration, producing a single number representing total training impulse for this session - just return the final number, 2-3 significant figures is enough. (2) vo2maxEstimate - a rough VO2max in ml/kg/min, estimated from the pace-HR relationship during the single most sustained steady-effort segment of the run (a work interval or a long steady stretch, not warmup/cooldown/recovery), using standard submaximal exercise-physiology pace-vs-%HRR relationships. Only include this key if there's a genuinely steady segment of at least several minutes to estimate from; omit it entirely rather than guessing from a short or noisy segment. (3) terrainPaceNote - this runner trains threshold/VO2max sessions by HR primarily because the home route is hilly and pace targets alone are misleading on it. The prescribed target for this session was "+(state.sessionTargetCache[id]&&state.sessionTargetCache[id].pace?state.sessionTargetCache[id].pace:'not pace-specific')+(state.sessionTargetCache[id]&&state.sessionTargetCache[id].hr?(' @ '+state.sessionTargetCache[id].hr):'')+". Using ONLY the segments you classified as 'work' above (never warmup, recovery, or cooldown - those run at a completely different effort and would distort this) plus the elevation data for those same segments, work out what pace this runner should actually target ON THIS ROUTE to reliably hit the prescribed HR zone next time - i.e. a route-specific, terrain-adjusted pace equivalent for the actual work reps, not the flat-ground pace table number and not a whole-run average. If there aren't enough reliable work segments (lapsReliable false, or too few/short work segments) to derive this confidently, say so plainly in terrainPaceNote instead of guessing, and explain briefly why. Return JSON in exactly this shape: {\"found\":true,\"activityName\":\"...\",\"activityDate\":\"e.g. Mon Aug 3\",\"activityDateISO\":\"YYYY-MM-DD, the real recorded date\",\"dateDiffersFromPlanned\":false,\"multipleCandidatesFound\":false,\"totalDistanceKm\":0.0,\"totalDurationMin\":0.0,\"avgHR\":0,\"lapsReliable\":true,\"lapNote\":\"one sentence stating whether streams or laps were used and your confidence, always include this\",\"elevationNote\":\"one sentence, or empty string if flat, about whether elevation gain/loss affected pace on any segment - the route is hilly, so a slower segment on a climb should not be read as underperformance\",\"fadeNote\":\"one sentence, or empty string if not applicable, stating whether later work segments held pace and HR as well as earlier ones or showed real degradation (slower pace and/or higher HR later in the session) - this is a durability signal distinct from the overall average\",\"terrainPaceNote\":\"one sentence, or empty string if not enough clean data - the route-specific pace-equivalent recommendation described above\",\"estimatedTRIMP\":0,\"vo2maxEstimate\":0,\"laps\":[{\"lapNum\":1,\"role\":\"warmup\",\"distanceKm\":0.0,\"durationSec\":0,\"avgHR\":0,\"avgPaceLabel\":\"m:ss/km\",\"paceSource\":\"gps\",\"timeToTargetSec\":0,\"recoveryHRDropBpm\":0}]}. Include every segment you identify, in order. If avgHR, avgPaceLabel, or distanceKm isn't available for a segment (e.g. an indoor activity with no GPS pace data), omit those specific keys for that segment only rather than guessing - totalDistanceKm and totalDurationMin at the top level should likewise be omitted if genuinely unavailable rather than estimated. Only include timeToTargetSec on 'work' laps and only if HR genuinely reached target; only include recoveryHRDropBpm on 'recovery' laps immediately following a work lap; only include paceSource on laps that actually have pace data - omit these entirely on laps where they don't apply, don't include them as 0 or a guessed value. Return ONLY the JSON, nothing else, no matter what."}],
        mcp_servers: [{type:"url", url:"https://mcp.strava.com/mcp", name:"strava-mcp"}]
      })
    });
    if(!response.ok) throw new Error('HTTP '+response.status);
    const data = await response.json();
    const textParts = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text);
    let raw = textParts.join('\n').trim().replace(/```json|```/g,'').trim();
    if(!raw){
      delete state.stravaImportCache[id];
      if(statusEl) statusEl.innerHTML = '<div class="note">Got an empty response - this can happen if Strava isn\'t connected for this session. Check your connectors and try again, or fill in manually below.</div>';
      return;
    }
    let parsed;
    try{
      parsed = JSON.parse(raw);
    }catch(parseErr){
      // Model may have narrated before/after the actual JSON despite instructions not to - try extracting just the JSON object substring before giving up
      const firstBrace = raw.indexOf('{');
      const lastBrace = raw.lastIndexOf('}');
      if(firstBrace!==-1 && lastBrace>firstBrace){
        try{ parsed = JSON.parse(raw.slice(firstBrace, lastBrace+1)); }catch(e2){ parsed = null; }
      }
    }
    if(!parsed){
      delete state.stravaImportCache[id];
      const looksLikeRefusal = /don't have access|not connected|cannot access|unable to access/i.test(raw);
      const looksTruncated = raw.length>50 && raw.indexOf('{')===-1;
      let msg;
      if(looksLikeRefusal) msg = 'Could not reach your Strava connection - check that Strava is connected and try again.';
      else if(looksTruncated) msg = 'The response never reached a JSON answer (likely got too caught up narrating) - try again, it usually succeeds on retry.';
      else msg = 'Got an unexpected response from Strava - try again, or fill in manually below.';
      const snippet = raw.length>300 ? (raw.slice(0,150)+' ... '+raw.slice(-150)) : raw;
      if(statusEl) statusEl.innerHTML = '<div class="note">'+msg+'<details style="margin-top:8px; font-size:10.5px; color:var(--dim);"><summary style="cursor:pointer;">Show raw response (for debugging)</summary><pre style="white-space:pre-wrap; margin-top:6px; font-size:10px;">'+snippet.replace(/</g,'&lt;')+'</pre></details></div>';
      return;
    }
    if(!parsed.found){
      delete state.stravaImportCache[id];
      if(statusEl) statusEl.innerHTML = '<div class="note">No matching Strava activity found for '+dateStr+' - fill in manually below.</div>';
      return;
    }
    state.stravaPendingCache[id] = parsed;
    if(statusEl) statusEl.innerHTML = renderStravaPendingConfirm(id, parsed);
  }catch(e){
    console.error('strava import failed', e);
    delete state.stravaImportCache[id];
    delete state.stravaPendingCache[id];
    if(statusEl) statusEl.innerHTML = '<div class="note">Strava import failed (' + (e.message||'unknown error') + ') - fill in manually below.</div>';
  }finally{
    delete state.stravaImportInFlight[id];
    if(btnEl){ btnEl.disabled = false; btnEl.innerText = state.stravaImportCache[id] ? 'Re-import from Strava' : origBtnText; btnEl.style.opacity = ''; }
  }
}

export function renderStravaPendingConfirm(id, parsed){
  const distText = parsed.totalDistanceKm ? parsed.totalDistanceKm+'km' : 'distance not available';
  const durText = parsed.totalDurationMin ? formatMinutesToClock(parsed.totalDurationMin) : 'duration not available';
  const hrText = parsed.avgHR ? parsed.avgHR+'bpm avg' : '';
  const mismatchNote = parsed.dateDiffersFromPlanned ? '<div style="margin-top:4px; font-size:11px; color:var(--threshold);">&#9888; This is on a different day than planned.</div>' : '';
  const multiNote = parsed.multipleCandidatesFound ? '<div style="margin-top:4px; font-size:11px; color:var(--vo2);">&#9888; Other possible matches also existed nearby - worth a close look.</div>' : '';
  return '<div style="margin-top:10px; padding:10px 12px; background:rgba(232,163,61,0.1); border:1.5px solid rgba(232,163,61,0.4); border-radius:8px;">'+
    '<div style="color:var(--threshold); font-weight:600; font-size:12.5px;">Is this the right one?</div>'+
    '<div style="margin-top:5px; font-size:13px; font-weight:600;">'+(parsed.activityName||'Activity')+'</div>'+
    '<div style="margin-top:2px; font-size:12px; color:var(--dim);">'+(parsed.activityDate||'')+' &middot; '+distText+' &middot; '+durText+(hrText?(' &middot; '+hrText):'')+'</div>'+
    mismatchNote+multiNote+
    '<div style="margin-top:8px; display:flex; gap:8px;">'+
      '<button class="save-btn" style="padding:6px 14px; font-size:12px;" onclick="confirmStravaMatch(\''+id+'\')">Yes, this is it</button>'+
      '<button class="ghost-btn" style="padding:6px 14px; font-size:12px;" onclick="rejectStravaMatch(\''+id+'\')">Not this one</button>'+
    '</div></div>';
}

export function confirmStravaMatch(id){
  const parsed = state.stravaPendingCache[id];
  if(!parsed) return;
  state.stravaImportCache[id] = parsed;
  delete state.stravaPendingCache[id];
  delete state.stravaRejectedCache[id];
  const distEl = document.getElementById(id+'-actualdist');
  const durEl = document.getElementById(id+'-actualdur');
  if(distEl && parsed.totalDistanceKm) distEl.value = parsed.totalDistanceKm;
  if(durEl && parsed.totalDurationMin) durEl.value = formatMinutesToClock(parsed.totalDurationMin);
  if(parsed.dateDiffersFromPlanned){
    const noteEl = document.getElementById(id+'-actualnote');
    if(noteEl && !noteEl.value){
      noteEl.value = 'Actually performed on '+(parsed.activityDate||'a different day')+' instead of the planned day';
    }
  }
  const statusEl = document.getElementById(id+'-stravastatus');
  if(statusEl) statusEl.innerHTML = renderStravaConfirmation(parsed);
}

export async function rejectStravaMatch(id){
  const rejected = state.stravaPendingCache[id];
  if(rejected){
    if(!state.stravaRejectedCache[id]) state.stravaRejectedCache[id] = [];
    state.stravaRejectedCache[id].push({name: rejected.activityName||'unknown', date: rejected.activityDate||'unknown date'});
  }
  delete state.stravaPendingCache[id];
  const statusEl = document.getElementById(id+'-stravastatus');
  if(statusEl) statusEl.innerHTML = '<div class="note">Searching again, excluding that one...</div>';
  await importFromStrava(null, id, state.stravaDayTagCache[id]||'', state.stravaSessionNameCache[id]||'');
}

window.importFromStrava = importFromStrava;
window.confirmStravaMatch = confirmStravaMatch;
window.rejectStravaMatch = rejectStravaMatch;
