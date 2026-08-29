// @ts-nocheck
import { state } from '../state.js';
import { callAnthropic } from './api.js';
import { buildTrajectoryPrompts, computeAchievabilityWarnings, computeAheadOfScheduleWarnings, computeVO2maxPaceSec, impliedLTPaceForGoal } from './goal-trajectory.js';
import { clampTierEstimate, estimateLayoffImpact, estimateVO2FromTreadmillSpeed, getDaysSinceLastActivity, getEfficiencyTrend, getIndoorWearableCalibration, getLayoffAdjustment, getSourceCalibrationOffset, getThresholdHybridReadiness, getTrendSummary, loadTierEstimate, maybeUpdateTreadmillCalibration, recordThresholdHybridProgress, renderTierUpdateNotice, saveTierEstimate, TREADMILL_DEFAULT_INCLINE_PCT, treadmillFlatEquivalentPaceSec } from './tier-estimates.js';
import { WHY, WHY_BIKE, bikeSessionName, classifyReducedWeek, computeBikeZones, computeWeekPlannedKm, threshold, vo2max } from '../data/plan.js';
import { defaultGoalConfig } from '../data/goal-config.js';
import { buildBlockProgressionNote } from './progression.js';
import { calendarWeekKey, computeNearbyQualityGapDays, dateToYMD, getFullWeekDayList, parseDayTagDate, parseWeekEndDate, parseWeekStartDate } from '../lib/dates.js';
import { extraWorkoutsForDay, loadExtraWorkoutsForWeek } from '../lib/extras.js';
import { fmtDuration, fmtPace, fmtPaceExact, fmtTime, formatMinutesToClock, timeAgo } from '../lib/format.js';
import { workoutKey } from '../lib/keys.js';
import { readJsonArray } from '../lib/data-store.js';
import { notifyError, notifyInfo } from '../lib/notify.js';
import { saveWithRetry } from '../lib/storage.js';
import { batchMap, sleep } from '../lib/utils.js';
import { appendMissingSessionButtons, renderAssistantMessage, toggleChat } from '../ui/chat-panel.js';
import { loadBikeLogs, loadRunLogs } from '../ui/history-view.js';
import { loadDailyMetricsHistory, loadTrainingStatusHistory } from '../ui/kpi-view.js';
import { loadFreeWorkouts } from '../ui/modals.js';
import { computeOptimalHR, computeVO2maxBuildStartHR, loadWorkoutLog } from '../ui/week-view.js';

export async function saveCoachNote(text, weekN, dayTag, kind, goalImpact){
  if(!text) return;
  const dateIso = new Date().toISOString();
  const obj = {date:dateIso, weekN:weekN||null, dayTag:dayTag||null, kind:kind||'chat', text:text.trim(), goalImpact:goalImpact||null};
  const key = 'dnotes-'+calendarWeekKey(dateIso);
  const read = await readJsonArray(key);
  if(!read.ok) return;
  let arr = read.value;
  // Re-saving the same day's session (e.g. after correcting a Strava import) replaces its
  // note here instead of accumulating a second one for what's really the same real
  // workout - only for workout/skip, the kinds actually tied to one specific day/session;
  // other kinds (profile updates, weekly summaries, free chat) aren't re-save candidates.
  if(weekN!=null && dayTag && (kind==='workout'||kind==='skip')){
    arr = arr.filter(n=>!(n.weekN===weekN && n.dayTag===dayTag && n.kind===kind));
  }
  arr.push(obj);
  try{ await saveWithRetry(key, arr, false); }
  catch(e){ notifyError('Could not save this coach note - try again.'); }
}

export const VERDICT_KIND_LABEL = {profile:'Garmin numbers update', workout:'Post-workout check', metrics:'Daily metrics check', skip:'Session skipped', rebuild:'Plan updated', freeworkout:'Extra workout logged', goalset:'Goal set updated'};

export async function saveLatestVerdict(kind, text, rebuildText){
  if(!text) return;
  const obj = {kind, text:text.trim(), rebuildText: rebuildText||null, date:new Date().toISOString()};
  try{
    let prevVerdict = null;
    try{ const pr = await window.storage.get('latest-verdict', false); if(pr) prevVerdict = JSON.parse(pr.value); }catch(e){}
    if(prevVerdict){
      let history = [];
      try{ const hr = await window.storage.get('verdict-history', false); if(hr) history = JSON.parse(hr.value); }catch(e){}
      history.unshift(prevVerdict);
      if(history.length>10) history = history.slice(0,10);
      await saveWithRetry('verdict-history', history, false);
    }
    await saveWithRetry('latest-verdict', obj, false);
    renderVerdictCard(obj);
  }catch(e){ console.error('verdict save failed', e); }
}

export function copyVerdictRebuild(btnEl){
  if(!state.latestVerdictCache || !state.latestVerdictCache.rebuildText) return;
  navigator.clipboard.writeText(state.latestVerdictCache.rebuildText).then(()=>{
    if(btnEl){ const orig=btnEl.innerText; btnEl.innerText='Copied!'; setTimeout(()=>{btnEl.innerText=orig;},1500); }
  });
}

export function renderVerdictCard(obj){
  state.latestVerdictCache = obj;
  const el = document.getElementById('verdictCard');
  if(!el) return;
  if(!obj){ el.innerHTML=''; return; }
  const isChange = !!obj.rebuildText;
  const isSkipNoChange = !isChange && obj.kind==='skip';
  const label = VERDICT_KIND_LABEL[obj.kind] || 'Coach check-in';
  const titleText = isChange ? 'Plan change proposed' : (isSkipNoChange ? 'Skipped - no rebuild needed' : 'No plan change');
  let html = '<div class="verdict-wrap"><div class="verdict-card'+(isChange?'':(isSkipNoChange?' skip-noted':' no-change'))+'">';
  html += '<div class="verdict-top"><span class="verdict-title">'+titleText+'</span><span class="verdict-meta">'+label+' &middot; '+timeAgo(obj.date)+'</span></div>';
  html += '<div class="verdict-body">'+obj.text+'</div>';
  if(isChange){
    html += '<div class="paste-block" style="margin-top:10px;"><div class="paste-label">Suggested plan change</div><div class="paste-body">'+obj.rebuildText+'</div>'+
      '<button class="paste-copy-btn" onclick="copyVerdictRebuild(this)">Copy</button>'+
      '<button class="ghost-btn" style="margin-left:8px; font-size:11.5px; padding:5px 12px;" onclick="toggleGlobalPlanOverrideModal(true, '+JSON.stringify(obj.rebuildText).replace(/"/g,'&quot;')+')">Draft this rebuild</button></div>';
  }
  html += '<div id="verdictHistorySlot"></div>';
  html += '</div></div>';
  el.innerHTML = html;
  loadVerdictHistorySnippet();
}

export async function loadVerdictHistorySnippet(){
  const slot = document.getElementById('verdictHistorySlot');
  if(!slot) return;
  try{
    const r = await window.storage.get('verdict-history', false);
    if(!r) return;
    const history = JSON.parse(r.value);
    if(!history || !history.length) return;
    const prev = history[0];
    const prevLabel = VERDICT_KIND_LABEL[prev.kind] || 'Coach check-in';
    slot.innerHTML = '<button class="ghost-btn" style="margin-top:10px; padding:4px 10px; font-size:11px;" onclick="toggleVerdictHistory(this)">Show previous update &#9660;</button>'+
      '<div class="verdict-prev" style="display:none; margin-top:8px; padding:10px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--line); border-radius:8px;">'+
      '<div class="verdict-meta" style="margin-bottom:4px;">'+prevLabel+' &middot; '+timeAgo(prev.date)+'</div>'+
      '<div style="font-size:13px;">'+prev.text+'</div></div>';
  }catch(e){}
}

export function toggleVerdictHistory(btn){
  const prevEl = btn.nextElementSibling;
  if(!prevEl) return;
  const open = prevEl.style.display!=='none';
  prevEl.style.display = open ? 'none' : 'block';
  btn.innerHTML = open ? 'Show previous update &#9660;' : 'Hide previous update &#9650;';
}

export async function loadLatestVerdict(){
  const el = document.getElementById('verdictCard');
  try{
    const r = await window.storage.get('latest-verdict', false);
    if(r){ renderVerdictCard(JSON.parse(r.value)); return; }
  }catch(e){}
  if(el) el.innerHTML = '<div class="card"><div class="note" style="border-top:none; padding-top:0;">No coach update yet - log a workout, daily metrics, or ask a question, and the latest read will show up here.</div></div>';
}

export async function loadCoachNotes(limit){
  let notes = [];
  try{
    const list = await window.storage.list('dnotes-', false);
    if(list && list.keys){
      const results = await batchMap(list.keys, 6, async k=>{
        try{ const r = await window.storage.get(k, false); return r ? JSON.parse(r.value) : []; }catch(e){ return []; }
      });
      results.forEach(arr=>{ if(Array.isArray(arr)) notes = notes.concat(arr); });
    }
  }catch(e){}
  notes.sort((a,b)=> b.date.localeCompare(a.date));
  return limit ? notes.slice(0, limit) : notes;
}

// systemBlocks: the array generateProfileContext() returns - a cacheable stable
// block (plan, history, trends, static instructions) followed by a tiny always-fresh
// block (today's date, current week/mode). Chat history gets its own cache_control
// breakpoint on the last existing turn, so a growing conversation only pays full
// price for each new message, not the whole thread over again.
export async function fetchCoachReply(systemBlocks, userText, type){
  const attempt = async ()=>{
    const history = state.chatHistory.map((m, i) => {
      if(i !== state.chatHistory.length-1) return m;
      return {role: m.role, content: [{type:'text', text: m.content, cache_control:{type:'ephemeral'}}]};
    });
    const data = await callAnthropic(type||'coach-chat', systemBlocks, history.concat([{role:"user", content:userText}]));
    return data;
  };
  const delays = [1500, 3000];
  for(let i=0; i<=delays.length; i++){
    try{
      const data = await attempt();
      state.chatHistory.push({role:"user", content:userText});
      const replyText = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
      if(replyText) state.chatHistory.push({role:"assistant", content:replyText});
      if(state.chatHistory.length>24) state.chatHistory = state.chatHistory.slice(state.chatHistory.length-24);
      return data;
    }catch(e){
      const retryable = e.status===529 || (e.status>=500 && e.status<600);
      if(!retryable || i===delays.length) throw e;
      await new Promise(r=>setTimeout(r, delays[i]));
    }
  }
}

// A short, dynamic description of the active GOAL-slot goal ("sub-1:37:00 half marathon
// goal") for the handful of GOAL IMPACT prompt fragments below that need to name it inline -
// those used to hardcode the phrase "the sub-1:35 half marathon goal" literally, which silently went
// wrong the moment the goal's own time or distance changed (Edit Goal), and would have been
// flatly WRONG for a genuinely different goal (New Goal, any distance). Falls back to a
// generic phrase when no GOAL-slot goal is active (a raceless maintenance phase) rather than
// asserting a distance/time that doesn't exist.
function activeGoalPhrase(){
  const cfg = state.goalConfig;
  const g = cfg && (cfg.activeGoals||[]).find(x=>x.zoneKey==='GOAL');
  if(g && g.goalTimeLabel && g.label) return (g.goalTimeLabel+' '+g.label).toLowerCase()+' goal';
  return 'current goal';
}

export async function autoCoachMessage(kind, data){
  document.getElementById('profileModal').classList.remove('open');
  document.getElementById('metricsModal').classList.remove('open');
  toggleChat(true);
  const box = document.getElementById('chatMessages');
  const label = kind==='profile' ? 'Garmin numbers updated' : kind==='workout' ? 'Workout logged' : kind==='skip' ? 'Session skipped' : kind==='freeworkout' ? 'Extra workout logged' : kind==='goalset' ? 'Goal set updated' : 'Daily metrics logged';
  box.insertAdjacentHTML('beforeend', '<div class="msg system-note">'+label+' - analyzing...</div>');
  const loadingId = 'auto-'+Date.now();
  box.insertAdjacentHTML('beforeend', '<div class="msg assistant" id="'+loadingId+'">...</div>');
  box.scrollTop = box.scrollHeight;

  let prompt;
  let missingForButtons = [];
  let qualifiesTier2 = false;
  let qualifiesTier3 = false;
  function conversationAwareNote(topicDesc){
    if(state.chatHistory.length===0) return '';
    return ' Important: check the conversation above first - if it already covers '+topicDesc+', don\'t re-run a fresh independent analysis as if this is new information. Instead, write a short, natural reply that picks up from that conversation - reference what was actually discussed, don\'t repeat the same reasoning back in different words, and don\'t sound like you\'re encountering this for the first time. If the conversation above doesn\'t actually cover this, then do the full analysis as normal.';
  }
  if(kind==='profile'){
    const conversationNote = conversationAwareNote('this Garmin numbers update or a discussion of these specific changes');
    prompt = 'I just updated my Garmin numbers: LTHR '+state.profile.lthr+'bpm, LT pace '+fmtPaceExact(state.profile.ltPaceSec)+', Max HR '+state.profile.maxHR+', VO2max '+state.profile.vo2max+', resting HR '+state.profile.restHR+'.'+conversationNote+' Write 2-4 sentences: state plainly whether this is a notable positive sign, a concerning sign, or a small/expected change; explain briefly why, referencing the actual numbers and what changed; and what it implies for training going forward. If a rebuild seems warranted, end with a block starting on its own line with exactly "PASTE TO REBUILD:" followed by 1 complete sentence stating what should change, written so I can copy it into the main Claude conversation - only include this block when a real change is warranted. Finally, always end with a block on its own line starting with exactly "VERDICT SUMMARY:" followed by exactly 1 short sentence stating just the core essentials - the verdict and the single most important reason, condensed - for a compact summary card separate from your fuller reply above.';
  } else if(kind==='goalset'){
    // Fires after New Goal or Delete Goal (never Edit Goal - that only changes a target
    // time, never which goals exist or their race dates). The set of active goals just
    // changed, which is exactly the input real periodization judgment - how to sequence
    // build/taper/peak across however many races are now active - actually needs, and that
    // judgment is deliberately NOT made deterministically anywhere in this codebase (see
    // reassignGoalZoneKeys in data/goal-config.js, which only decides PACE-target slot
    // assignment by nearest race date, never restructures a single day). This asks the same
    // AI-driven "Rebuild plan" flow every other plan-affecting event in this file already
    // uses for a reviewable proposal - never applied automatically.
    const cfg = state.goalConfig || defaultGoalConfig();
    const goals = cfg.activeGoals || [];
    const todayStr = dateToYMD(new Date());
    const goalLines = goals
      .filter(g=>!g.raceDate || g.raceDate>=todayStr)
      .sort((a,b)=> (a.raceDate||'9999').localeCompare(b.raceDate||'9999'))
      .map(g=>{
        const role = g.zoneKey==='GOAL' ? 'primary/nearest, actively driving GOAL-pace sessions'
          : g.zoneKey==='RACE10K' ? 'checkpoint, actively driving RACE10K-pace sessions'
          : 'tracked but further out - not yet driving any prescribed session pace';
        return '- '+(g.label||g.type)+' "'+(g.raceName||'')+'" on '+g.raceDate+', '+g.distanceKm+'km, goal '+(g.goalTimeLabel||'')+' ('+(g.goalPaceLabel||'')+') - '+role;
      });
    const conversationNote = conversationAwareNote('this same goal-set change or a discussion of how to sequence these goals');
    const {trajectoryContext:gsTrajCtx, trajectoryPrompt:gsTrajPrompt, trajectory10KPrompt:gsTraj10K} = await buildTrajectoryPrompts();
    prompt = 'My active race goals just changed (I added or deleted one). Here is the FULL current list of active goals, nearest race first:\n'+(goalLines.length ? goalLines.join('\n') : '(no active goals right now)')+'.'+conversationNote+' Right now only the nearest two goals by race date actively drive a prescribed session\'s pace (labeled above) - everything else is tracked but not yet shaping any specific day. Judge, as a real coach planning a multi-race block would: given this full set of goals and race dates, does the plan need to be restructured to build toward all of them well - proper build/peak/taper timing around EACH race in sequence, not just the nearest one, treating an earlier race as a tune-up/checkpoint for a later one where that makes sense given the gap between them, or flagging it plainly if two races sit too close together to both be trained for at full intensity. Write 2-4 sentences: state plainly whether the current goal set is well-sequenced as-is, or whether it needs real restructuring, and why - referencing the actual race dates and distances above, not generic advice. If restructuring is warranted, end with a block starting on its own line with exactly "PASTE TO REBUILD:" followed by 1-2 complete sentences stating specifically what should change (e.g. how to sequence build/taper across which races), written so I can copy it into the main Claude conversation - this is very likely warranted whenever a goal was just added or removed, since the periodization math genuinely changed, but skip it if the current plan already sequences these goals sensibly with no real change needed (e.g. deleting a goal that was never close enough to be shaping anything).'+gsTrajCtx+gsTrajPrompt+gsTraj10K+' Finally, always end with a block on its own line starting with exactly "VERDICT SUMMARY:" followed by exactly 1 short sentence stating just the core essentials - condensed, for a compact summary card separate from your fuller reply above.';
  } else if(kind==='freeworkout'){
    const conversationNote = conversationAwareNote('this specific unplanned activity');
    const swapNote = data.obj.replacesPlannedDay ? (' This specifically REPLACED a planned session: '+data.obj.replacesPlannedDay.sessionName+' ('+data.obj.replacesPlannedDay.dayTag+') - judge it as a substitution, not extra load on top of the plan. Compare what this activity actually delivered against what the replaced session was meant to achieve - did it serve a similar training purpose, a genuinely different one, or fall short of what was needed this week.') : ' This is extra/unplanned, not automatically a substitute for any specific scheduled session unless the notes say otherwise.';
    const {trajectoryContext:fwTrajCtx, trajectoryPrompt:fwTrajPrompt, trajectory10KPrompt:fwTraj10K} = await buildTrajectoryPrompts();
    prompt = 'I did an activity that wasn\'t part of the prescribed plan: '+JSON.stringify(data.obj)+'.'+conversationNote+swapNote+fwTrajCtx+' Write 2-4 sentences: judge how this fits alongside the actual plan - does it meaningfully add to this week\'s cumulative load (worth factoring into recovery expectations for the next prescribed session), is it low-stakes enough to just note and move on, or does it raise a genuine flag (pain mentioned, RPE surprisingly high for what was described, conflicts with what\'s coming up)? Don\'t manufacture a concern if there isn\'t one - plenty of extra easy activity is perfectly fine to just acknowledge. If this genuinely changes what the next few days of the actual plan should look like - adding recovery, adjusting an upcoming session\'s intensity because of accumulated load - end with a block starting on its own line with exactly "PASTE TO REBUILD:" followed by 1 complete sentence stating what should change, written so I can copy it into the main Claude conversation - only include this when a real change is warranted.'+fwTrajPrompt+fwTraj10K+' Also, before the VERDICT SUMMARY block, add a block on its own line starting with exactly "GOAL IMPACT:" followed by exactly 1 short, concrete sentence connecting this specific activity to progress toward '+activeGoalPhrase()+' - what it contributed, confirmed, or cost, grounded in the actual numbers rather than generic encouragement. Finally, always end with a block on its own line starting with exactly "VERDICT SUMMARY:" followed by exactly 1 short sentence stating just the core essentials, condensed, for a compact summary card separate from your fuller reply above.';
  } else if(kind==='skip'){
    const purposeText = WHY[data.day.type] ? WHY[data.day.type].why : '';
    const conversationNote = conversationAwareNote('this exact decision - whether to skip this same session today');
    const {trajectoryContext:skipTrajCtx, trajectoryPrompt:skipTrajPrompt, trajectory10KPrompt:skipTraj10K} = await buildTrajectoryPrompts();
    // A correction (editing an already-logged skip's reason, e.g. a typo) is NOT a new
    // event - re-judges the same skip fresh off the corrected reason, and explicitly tells
    // the coach to revise/retract anything it concluded from the wrong one (a prior
    // "reason: injury" typo shouldn't get to keep quietly informing insights/follow-ups
    // after being corrected to "reason: travel"). Everything else about this prompt stays
    // identical to a fresh skip - same analysis, same blocks - since saveCoachNote/
    // saveLatestVerdict already overwrite rather than duplicate per day, so a fresh
    // analysis is all a correction actually needs.
    const openingSentence = data.isCorrection
      ? 'I need to correct the reason I gave for skipping '+data.day.tag+', "'+data.day.name+'" - the reason I originally logged ("'+(data.previousReason||'')+'") was wrong or mistyped. The actual, corrected reason is: '+data.reason+'.'
      : 'I\'m skipping today\'s session - '+data.day.tag+', "'+data.day.name+'". Reason: '+data.reason+'.';
    const correctionNote = data.isCorrection
      ? ' This is a correction to an existing skip, not a new event - if your understanding of this skip (in the conversation above, or already reflected in your persisted insights/follow-ups) relied on the earlier incorrect reason, explicitly revise or retract that now based on the real reason, and re-judge the skip fresh exactly as you would have the first time.'
      : '';
    prompt = openingSentence+' This session exists in the plan specifically to: '+(purposeText||'contribute to the overall training load')+'.'+conversationNote+correctionNote+' Write 2-4 sentences: judge how much this specific skip actually matters, given what the session was for and where it sits in the week and block - a skipped easy run rarely matters much, a skipped key threshold/VO2max/long run close to a goal week matters more; weigh what else is already scheduled this week when judging whether the missed stimulus is meaningfully lost or easily absorbed. Don\'t catastrophize a single skip, but don\'t wave off something that looks like part of a pattern either - if recent history above shows other skips, red flags, or a concerning trend, factor that in explicitly rather than judging this skip in isolation. If this genuinely warrants adjusting the rest of the week or plan - moving or replacing the missed session, adjusting an upcoming session because of the gap, or anything else concrete - end with a block starting on its own line with exactly "PASTE TO REBUILD:" followed by 1 complete sentence stating what should change, written so I can copy it into the main Claude conversation - only include this when a real change is warranted; most single skips need no plan change at all, just acknowledgment and moving on.'+skipTrajCtx+skipTrajPrompt+skipTraj10K+' Also, before the VERDICT SUMMARY block, add a block on its own line starting with exactly "GOAL IMPACT:" followed by exactly 1 short, concrete sentence connecting this skip to progress toward '+activeGoalPhrase()+' - whether this genuinely costs anything toward that goal or is easily absorbed, grounded in the actual reasoning above rather than generic reassurance. Finally, always end with a block on its own line starting with exactly "VERDICT SUMMARY:" followed by exactly 1 short sentence stating just the core essentials - condensed, for a compact summary card separate from your fuller reply above.';
  } else if(kind==='workout' && data.day.type==='race'){
    const actualDist = parseFloat(data.obj.actualDist) || data.day.data.km;
    const actualDurMin = parseFloat(data.obj.actualDur);
    let paceInfo = 'No actual distance/duration logged, so pace can\'t be computed - ask for that if it\'s missing.';
    let projectionNote = '';
    if(actualDurMin && actualDist){
      const actualPaceSec = Math.round((actualDurMin*60)/actualDist);
      paceInfo = 'Actual average pace: '+fmtPace(actualPaceSec)+' over '+actualDist+'km in '+formatMinutesToClock(actualDurMin)+'. Goal was '+data.day.data.goalTime+' ('+data.day.data.goalPaceLabel+').';
      if(Math.abs(actualDist-10)<1){
        const actualTimeSec = actualDurMin*60;
        const projectedHalfSec = actualTimeSec * Math.pow(21.1/10, 1.06);
        const projectedHalfPaceSec = Math.round(projectedHalfSec/21.1);
        projectionNote = ' This is the 10K - it doubles as a live fitness test for the half marathon goal. Using the same Riegel cross-distance formula used elsewhere in this plan, this 10K performance projects to roughly '+fmtDuration(projectedHalfSec)+' for the half marathon ('+fmtPace(projectedHalfPaceSec)+' pace) vs the sub-1:35:00 (4:29/km) goal. Explicitly state whether this suggests the half marathon goal is on track, conservative (could be pushed faster), or genuinely ambitious given today\'s result - this is one of the most important data points in the whole block, don\'t undersell it.';
      }
    }
    const conversationNote = conversationAwareNote('this race and how it went');
    prompt = 'I just raced '+data.day.name+' ('+data.day.tag+'). '+paceInfo+projectionNote+conversationNote+' Write 3-5 sentences: state plainly how this result compares to the goal (crushed it / hit it / fell short, with the actual numbers); give the concrete implication - for the 10K, what it means for the half marathon goal specifically; for the half marathon, how the block went overall; and add relevant context on what this means going forward. If this result means the half marathon goal or plan should be revised (up or down), end your reply with a block starting on its own line with exactly "PASTE TO REBUILD:" followed by 1 complete sentence stating what should change and why, written so I can copy it directly into the main Claude conversation - a race result is exactly the kind of evidence that warrants this, don\'t hold back if it\'s genuinely warranted. Finally, always end with a block on its own line starting with exactly "VERDICT SUMMARY:" followed by exactly 1 short sentence stating just the core essentials - the result vs goal and the single most important implication, condensed - for a compact summary card separate from your fuller reply above.';
  } else if(kind==='workout'){
    let targetHR = '';
    if(data.eq){
      const bz = computeBikeZones();
      const zoneKey = data.eq.kind==='long' ? data.eq.segments[data.eq.segments.length-1].zone : data.eq.zone;
      targetHR = bz[zoneKey] ? bz[zoneKey].hr : '';
    } else if(data.day.type!=='easy'){
      const zoneKey = data.day.type==='long' ? data.day.data.segments[data.day.data.segments.length-1].zone : data.day.zone;
      targetHR = (zoneKey && state.Z[zoneKey]) ? state.Z[zoneKey].hr : '';
    } else {
      targetHR = state.Z.S2.hr;
    }
    const purposeText = data.eq ? (WHY_BIKE[data.eq.kind] ? WHY_BIKE[data.eq.kind].why : '') : (WHY[data.day.type] ? WHY[data.day.type].why : '');
    let scheduleShiftNote = '';
    if(data.obj.performedOnTag && data.obj.performedOnTag!==data.day.tag){
      let gapFact = '';
      try{
        const performedDate = parseDayTagDate(data.obj.performedOnTag);
        const gaps = await computeNearbyQualityGapDays(data.weekN, data.day.tag, performedDate);
        const parts = [];
        if(gaps && gaps.before) parts.push(gaps.before.gapDays+' day'+(gaps.before.gapDays===1?'':'s')+' after '+gaps.before.tag+'\'s '+gaps.before.name);
        if(gaps && gaps.after) parts.push(gaps.after.gapDays+' day'+(gaps.after.gapDays===1?'':'s')+' before '+gaps.after.tag+'\'s '+gaps.after.name);
        if(parts.length) gapFact = ' Verified day-gap (computed, not estimated - trust this over your own arithmetic): this session now actually sits '+parts.join(' and ')+'.';
      }catch(e){}
      scheduleShiftNote = ' Worth noting: this session was originally scheduled for '+data.day.tag+', but the runner actually did it on '+data.obj.performedOnTag+' instead.'+gapFact+' A real coach would notice this naturally, not just silently analyze the numbers - if it looks like the shift affected the session (extra fatigue from the delay, a compressed week, back-to-back hard days as a result), say so plainly, using the verified day-gap above rather than computing your own; if it looks like it made no real difference, don\'t manufacture a concern out of it either. Either way, a brief, human acknowledgment that the day moved is more natural than pretending it landed exactly on schedule.';
    }
    const plannedDesc = (data.eq
      ? (data.eq.kind+' bike session, planned duration '+fmtTime(data.eq.totalSec)+' at zone '+data.eq.zone)
      : (data.day.type+' running session, planned as: '+JSON.stringify(data.day.data)))
      + (targetHR ? ('. Target HR zone for the main/peak effort: '+targetHR.replace('bpm','')+'bpm') : '')
      + (purposeText ? ('. This session type exists in the plan specifically to: '+purposeText) : '')
      + scheduleShiftNote;
    const loggedRpe = parseFloat(data.obj.rpe)||0;
    const isQuality = ['threshold','vo2max','long'].includes(data.day.type) || loggedRpe >= 7;
    const {trajectoryContext, trajectoryPrompt, trajectory10KPrompt} = await buildTrajectoryPrompts();
    const missing = await findUnloggedPastSessions();
    missingForButtons = missing;
    const missingNote = missing.length ? (' Separately, these scheduled past sessions have no log at all - mention this briefly and plainly (not as the main point of your reply) so I don\'t lose track of gaps: '+missing.map(m=>m.label).join('; ')+'. I\'ve already given the user clickable buttons to jump to each one, so don\'t repeat the list in detail - just note that there are gaps and point them at the buttons below your reply.') : '';
    // Deterministic hard-session-spacing check (see plan-adherence.js's
    // detectHardSessionProximity - grounded in standard hard-easy recovery spacing, scaled
    // by how substantial each session actually was and current acute:chronic load when
    // available) - computed once at app load, not re-derived here. Only worth a real
    // judgment call from the coach if it's actually relevant to what's being discussed;
    // pass the real facts and let it decide how to weigh "sometimes two close hard
    // sessions are fine" against genuinely proposing a rebalance.
    const proximityFlags = state.hardSessionProximityFlags || [];
    const proximityNote = proximityFlags.length
      ? (' Separately, a real hard-session-spacing signal is on record this window: '+proximityFlags.map(f=>f.note).join(' ')+' Use your own judgment on whether this is actually a concern given everything else you know about how training is going (sometimes two close hard efforts are genuinely fine) - but if it is relevant to today\'s session or the days just ahead, say so plainly and propose specifically how to rebalance the rest of THIS week (which upcoming session(s) to ease, shorten, or move), not just a general caution.')
      : '';
    const conversationNote = conversationAwareNote('how this exact session went or a decision related to it');
    let tierPrompt = '';
    let tierFinalReminder = '';
    const isThresholdOrVo2 = ['threshold','vo2max'].includes(data.day.type);
    const isGoalPaceLong = data.day.type==='long' && data.day.data && data.day.data.segments && data.day.data.segments.some(s=>s.zone==='GOAL');
    // A session whose actual DATA shows genuine at-or-above-threshold effort qualifies as
    // Tier evidence on its own terms, regardless of what the plan called for that day - the
    // plan is a guideline, not a gate on how much a real hard effort gets analyzed. This is
    // exactly what let a swapped-in time trial slip past Tier-estimate analysis entirely
    // when it replaced an easy/moderate session with no GOAL-pace segment (caught 2026-08-29
    // - a 10K time trial substituted for a plain long run never qualified, since neither
    // isThresholdOrVo2 nor isGoalPaceLong could ever be true for it, no matter how hard it
    // actually was). Deliberately still requires the SAME real, Strava-verified evidence bar
    // Tier 2 already holds everything else to (a real 'work'-role lap with genuine at-or-
    // above-threshold HR, not a self-reported average) - this widens WHICH sessions can
    // qualify, not what counts as qualifying evidence once one does.
    const hardWorkLap = (data.obj.stravaImport && data.obj.stravaImport.lapsReliable && Array.isArray(data.obj.stravaImport.laps))
      ? data.obj.stravaImport.laps.find(l=>l.role==='work' && l.avgHR!=null && l.avgHR >= (state.profile.lthr-8))
      : null;
    const isDataDrivenHardEffort = !isThresholdOrVo2 && !isGoalPaceLong && !!hardWorkLap;
    // Treadmill mirror of the same principle, gated by RPE instead of work-lap HR since a
    // treadmill session's Strava import (if any) never carries GPS/HR-verified 'work' laps
    // the way outdoor Tier 2 evidence does - teAero is still required below, same as every
    // other Tier 3 path, so this can't fire off RPE alone with no real physiological signal.
    const isDataDrivenHardTreadmillEffort = data.obj.performedMode==='treadmill' && parseFloat(data.obj.rpe)>=8;
    // performedMode==='treadmill' must exclude Tier 2, not just require a Strava import -
    // a treadmill session can sync to Strava with a real HR stream and get lapsReliable:true
    // (accelerometer-estimated pace, not GPS) and previously satisfied this check anyway,
    // silently letting indoor data outrank Tier 3 and be treated as "outdoor, GPS-verified"
    // - which also corrupts maybeUpdateTreadmillCalibration's whole premise that Tier 2 and
    // Tier 3 are genuinely different modalities being compared against each other.
    qualifiesTier2 = (isThresholdOrVo2 || isGoalPaceLong || isDataDrivenHardEffort) && data.obj.stravaImport && data.obj.stravaImport.lapsReliable && !data.eq && data.obj.performedMode!=='treadmill';
    qualifiesTier3 = (isThresholdOrVo2 || isGoalPaceLong || isDataDrivenHardTreadmillEffort) && data.obj.performedMode==='treadmill' && (data.day.type==='vo2max' || data.day.type==='long' || data.obj.treadmillLTSpeed || isDataDrivenHardTreadmillEffort) && data.obj.teAero;
    if(qualifiesTier2 || qualifiesTier3){
      const tier1 = {lthr:state.profile.lthr, ltPaceSec:state.profile.ltPaceSec, maxHR:state.profile.maxHR, vo2max:state.profile.vo2max, restHR:state.profile.restHR};
      const tierNum = qualifiesTier2 ? 2 : 3;
      const currentTier = await loadTierEstimate(tierNum);
      const anchor = currentTier || tier1;
      const isContinuousEffort = (data.day.type==='threshold' && data.day.data && data.day.data.main && data.day.data.main.reps <= 1) || isDataDrivenHardEffort || isDataDrivenHardTreadmillEffort;
      const isVo2Session = data.day.type==='vo2max';
      // A single, fixed reading moment - "the instant X ended" - not a window or an average.
      // The runner reads whatever the display shows right then, no judgment call involved.
      let windowLabel = 'the instant work rep 2 ended';
      if(isContinuousEffort){
        windowLabel = 'the instant this effort ended';
      } else if(isGoalPaceLong){
        windowLabel = 'the goal-pace finish segment';
      }
      const goalLongNote = isGoalPaceLong
        ? (' This is a long run with a goal-pace finish segment, run under real fatigue rather than fresh - that\'s actually valuable evidence, arguably more representative of race-day capacity than a fresh threshold session. '+(tierNum===2
            ? 'Use the imported Strava data\'s goal-pace segment specifically (the last labeled work segment, not the easier base miles) - check its actual pace and HR relative to the goal-pace target.'
            : 'No treadmill speed field applies here - rely on TE Aerobic/Anaerobic and HR-zone-time for the goal-pace portion specifically, not the whole run blended together.'))
        : (isDataDrivenHardEffort || isDataDrivenHardTreadmillEffort)
        ? (' Today\'s session wasn\'t planned as threshold/VO2max, but the logged data itself shows a genuine at-or-above-threshold effort ('+(hardWorkLap ? ('a real work-lap HR of '+hardWorkLap.avgHR+'bpm, at or above LTHR-adjacent territory') : ('RPE '+data.obj.rpe+' on a treadmill'))+') - treat it as real Tier '+tierNum+' evidence on its own terms, the same as if it had been planned that way. Don\'t discount it just because it doesn\'t match what was scheduled - what matters is what the effort actually was, not what the plan called it.')
        : '';
      // 'threshold' - only calibration points captured at the SAME pace band get preferred
      // (falls back to the full blended history once enough same-band points exist to matter
      // less which - see getIndoorWearableCalibration's own reasoning for why blending
      // threshold- and VO2max-pace offsets is a real approximation, not free).
      const indoorCalib = (tierNum===3 && data.day.type==='threshold' && !data.obj.treadmillLTSpeed) ? await getIndoorWearableCalibration('threshold') : null;
      const noCalibYet = (tierNum===3 && data.day.type==='threshold' && !data.obj.treadmillLTSpeed && data.obj.stravaImport && !indoorCalib);
      const calibNote = indoorCalib
        ? (' The runner didn\'t manually log treadmillLTSpeed today, but a personal calibration exists from '+indoorCalib.count+(indoorCalib.sameBandOnly?' prior threshold sessions specifically':' prior sessions (not enough threshold-specific history yet, so this blends in some VO2max-pace calibration points too - treat it as slightly less precise)')+' where both were logged: wearable pace typically reads '+Math.abs(indoorCalib.avgOffsetSec)+'s/km '+(indoorCalib.avgOffsetSec>0?'slower':'faster')+' than the treadmill\'s true mechanical speed. If today\'s Strava import has a work-lap pace, apply this offset to get a corrected, more trustworthy pace-equivalent rather than trusting the raw wearable number as-is.')
        : (noCalibYet ? ' No personal wearable-pace calibration exists yet - if today\'s Strava import has a work-lap pace, treat it as genuinely uncorrected and say so plainly rather than quietly trusting it, and explicitly suggest logging treadmillLTSpeed manually on the next couple of treadmill threshold sessions specifically to establish a real calibration - this matters more than usual since the runner is heading into a treadmill-heavy winter block where this will be relied on repeatedly.' : '');
      let tier2CalibNote = '';
      if(tierNum===2 && data.obj.stravaImport && Array.isArray(data.obj.stravaImport.laps)){
        const workLap = data.obj.stravaImport.laps.find(l=>l.role==='work' && l.paceSource);
        if(workLap && workLap.paceSource==='gps'){
          const srcCalib = await getSourceCalibrationOffset();
          tier2CalibNote = srcCalib
            ? (' Today\'s pace data is GPS-sourced, not the runner\'s usual Stryd. A personal Stryd-vs-GPS offset already exists from easy-run comparisons (ratio '+srcCalib.ratio.toFixed(3)+', from '+srcCalib.strydCount+' Stryd and '+srcCalib.gpsCount+' GPS runs) - apply this same ratio to today\'s GPS pace before treating it as comparable to prior Stryd-based Tier 2 evidence, since Stryd reports shorter/faster than GPS for the runner and this session would otherwise look like a fitness dip purely from the source switch, not a real one. This ratio was derived from easy-effort comparisons, so treat the correction as approximate at threshold effort, but still meaningfully better than no correction at all.')
            : ' Today\'s pace data is GPS-sourced, not the runner\'s usual Stryd - no personal Stryd-vs-GPS offset exists yet to correct it (needs at least 3 runs logged with each source), so treat this session\'s pace as a real but less certain data point, and don\'t read a difference from recent Stryd-based sessions as a fitness change without other supporting evidence.';
        }
      }
      // Grade correction: a treadmill's DISPLAYED speed at 0% incline is mechanically easier
      // than the same speed outdoors (no air resistance, belt does some of the work) - the
      // app's own session cards tell every treadmill runner to set ~1% incline for exactly
      // this reason, but until now nothing in the actual math accounted for it, silently
      // treating raw 3600/speed as if it were a flat-ground-equivalent outdoor pace. When
      // incline wasn't logged this session, TREADMILL_DEFAULT_INCLINE_PCT assumes the
      // standing ~1% advice was followed rather than assuming a flat belt (the less likely
      // real setup, given that advice is shown on every treadmill session card).
      const treadSpeedNum = parseFloat(data.obj.treadmillLTSpeed);
      const treadInclineLogged = data.obj.treadmillIncline!=null && data.obj.treadmillIncline!=='';
      const treadInclinePct = treadInclineLogged ? parseFloat(data.obj.treadmillIncline) : TREADMILL_DEFAULT_INCLINE_PCT;
      const flatEquivPaceSec = Number.isFinite(treadSpeedNum) ? treadmillFlatEquivalentPaceSec(treadSpeedNum, treadInclinePct) : null;
      const flatEquivNote = flatEquivPaceSec!=null
        ? (' Grade-corrected to a flat-ground-equivalent pace (incline '+treadInclinePct+'%'+(treadInclineLogged?' as logged':', assumed - not logged this session, see the default above')+', via the standard ACSM metabolic-cost formula): '+fmtPace(Math.round(flatEquivPaceSec))+'. Use THIS grade-corrected figure as the pace-equivalent for ltPaceSec/vo2maxPaceSec, not a naive 3600/speed conversion, which ignores incline entirely and reads unrealistically fast.')
        : '';
      const vo2FromSpeed = Number.isFinite(treadSpeedNum) ? Math.round(estimateVO2FromTreadmillSpeed(treadSpeedNum, treadInclinePct)*10)/10 : null;
      const speedContext = (tierNum===3 && (data.day.type==='threshold' || isVo2Session))
        ? (' Today\'s treadmillLTSpeed field, if present, is '+(data.obj.treadmillLTSpeed||'not logged')+' km/h - this is the runner\'s own logged speed at '+windowLabel+', in kilometers per hour.'
          + flatEquivNote
          + calibNote
          + (data.obj.stravaImport ? ' This indoor session also has a stravaImport with real per-lap HR data (some treadmill activities sync to Strava with a genuine HR stream even without GPS pace) - that\'s richer, more complete evidence than the single manually-logged speed number, so prefer its per-lap avgHR/timeToTargetSec/recoveryHRDropBpm when reasoning about today\'s evidence, using treadmillLTSpeed mainly as the pace-equivalent cross-check it uniquely provides.' : '')
          + (isVo2Session
            ? (' For a VO2max session, this speed+incline implies an estimated VO2 of ~'+(vo2FromSpeed!=null?vo2FromSpeed:'n/a')+' ml/kg/min via the standard ACSM running metabolic equation (VO2 = 3.5 + 0.2*speed(m/min) + 0.9*speed(m/min)*grade - this now includes the grade term, not just flat-ground speed). This only approximates true VO2max if the effort was genuinely at or above the speed that actually elicits VO2max - check today\'s avgHR against Max HR ('+tier1.maxHR+'bpm) and RPE before trusting it: if HR wasn\'t close to max and/or RPE wasn\'t genuinely 8-9+, treat the formula result as a weak signal only and lean on the TE-based reasoning instead.'+(anchor.suggestedNextVO2Speed ? (' Last time you suggested '+anchor.suggestedNextVO2Speed+' km/h for this window - compare against what happened today and refine.') : ''))
            : (anchor.suggestedNextSpeed ? (' Last time you suggested '+anchor.suggestedNextSpeed+' km/h for this same window - compare that suggestion against what actually happened to today\'s HR relative to target and refine, don\'t just repeat it blindly.') : '')))
        : (goalLongNote + tier2CalibNote);
      const suggestedSpeedInstruction = (tierNum===3 && data.day.type==='threshold')
        ? ' Also include a "suggestedNextSpeed" field in the JSON: a small, directional-only refinement (never more than about 0.2-0.3 km/h from today\'s logged speed or the previous suggestion) for what treadmill speed to aim for at '+windowLabel+' next time - if today\'s HR ran meaningfully below the target zone at this speed, nudge the suggestion up slightly; if meaningfully above target, nudge down; if it landed close to target, keep it essentially the same. This is meant to get more accurate session over session as real data accumulates - treat it as calibration, not a fresh guess each time. Omit this field if treadmillLTSpeed wasn\'t logged today.'
        : (tierNum===3 && isVo2Session)
        ? ' Also include a "suggestedNextVO2Speed" field in the JSON: a small, directional-only refinement (never more than about 0.2-0.3 km/h from today\'s logged speed or the previous suggestion) for what treadmill speed to hold on work rep 2 of the next VO2max session - same directional-nudge logic as threshold, calibrating toward whatever speed reliably produces a genuinely near-max HR/RPE response. Omit this field if treadmillLTSpeed wasn\'t logged today or today\'s effort wasn\'t genuinely near-max.'
        : '';
      // ltPaceSec and vo2maxPaceSec are different physiological zones (threshold vs
      // supra-threshold) and must not cross-contaminate - a VO2max rep's pace/HR doesn't
      // tell you anything valid about threshold pace, and vice versa. Whichever this
      // session wasn't evidence for gets carried forward unchanged from the anchor, not
      // dropped - the app displays vo2maxPaceSec as the actual prescribed VO2max pace on
      // future session cards, so silently omitting it resets that back to a generic
      // formula-derived guess instead of staying evidence-based.
      const vo2maxPaceAnchorVal = (anchor.vo2maxPaceSec!=null) ? anchor.vo2maxPaceSec : await computeVO2maxPaceSec();
      // Specific to the ltPaceSec number itself, not just the conversational commentary
      // (which already reasons about this reasonably well) - this plan runs threshold at
      // mid-zone HR by deliberate design (genuine Norwegian sub-threshold, not pinned at
      // the ceiling), so HR landing mid-zone is the CORRECT, expected result of a
      // well-executed session and must not by itself be read as new evidence - that would
      // nudge the estimate faster on every single well-run session even when nothing
      // about this runner's fitness has actually changed. The real test is whether the
      // runner had to ease pace to stay in zone (expected, not evidence) versus held
      // today's pace at or faster than prescribed while HR still sat mid-zone-or-lower
      // (that's the actual signal - it means the current target undershoots them).
      const subThresholdAwarenessInstruction = (data.day.type==='threshold')
        ? ' One more thing specific to this number: this plan runs threshold reps at mid-zone HR by design, not pinned at the ceiling - so HR sitting mid-zone at exactly the prescribed pace is a well-executed session working as intended, not new evidence anything has changed, and shouldn\'t nudge ltPaceSec just for that. The real test is whether today\'s pace was AT OR FASTER than prescribed while HR still sat mid-zone-or-lower - that combination is the actual signal the current pace target is undershooting this runner, not "HR was below the ceiling" alone (mid-zone is supposed to be below the ceiling).'
        : '';
      const fieldTargetInstruction = isVo2Session
        ? ' Critically: today\'s evidence is from a VO2max session, so it should nudge "vo2maxPaceSec" (seconds per km, current anchor '+(vo2maxPaceAnchorVal!=null?vo2maxPaceAnchorVal:'none yet')+') using this session\'s work-lap pace/HR at VO2max effort'+(tierNum===3?' (or the grade-corrected flat-equivalent pace given above, not a naive 3600/speed conversion)':'')+' - NOT "ltPaceSec", which this session provides no valid evidence for. Carry ltPaceSec forward unchanged from the anchor above.'
        : ' Today\'s evidence should nudge "ltPaceSec" as usual. Also carry "vo2maxPaceSec" forward unchanged from the anchor ('+(vo2maxPaceAnchorVal!=null?vo2maxPaceAnchorVal:'omit it if the anchor has none yet')+') - this session provides no valid VO2max-pace evidence, don\'t adjust it.';
      // This is about the NUMBER you output, not just your conversational commentary -
      // the earlier general instruction to mention hill-slowed segments in your reply
      // doesn't by itself guarantee the numeric adjustment accounts for terrain too, and
      // this runner's home route is genuinely hilly/uneven, not flat.
      // FIXED - was pointing the model at terrainPaceNote for this, which is the WRONG
      // conversion direction: terrainPaceNote is built by flatTargetToGradedPaceSec
      // (strava-import.js) - a PRESCRIPTIVE "what pace to chase on this hill to match a
      // flat target's effort" number, meant for future pacing guidance. Reading THAT as if
      // it were "the flat-equivalent of what was actually run" (what a fitness estimate
      // needs) applies the correction backwards - on an uphill work lap it under-corrects
      // (or corrects the wrong quantity entirely), which is exactly the kind of error that
      // can compound across sessions into an unrealistically fast ltPaceSec. The number that
      // actually answers "what did my hilly pace mean in flat terms" is each work lap's own
      // gapPaceSec (gradeAdjustedPaceSec in lib/gap.js - the genuine inverse), already
      // computed per-lap in stravaImport.laps and present in the JSON dump below; it just was
      // never pointed to here.
      const terrainAwarenessInstruction = (tierNum===2 && data.obj.stravaImport)
        ? ' Also apply this to the number itself, not just your written commentary: each work lap in stravaImport.laps carries its own gapPaceSec/gapPaceLabel field when that segment was graded - that IS the real Minetti-model flat-ground equivalent of the pace actually run on that lap, and it\'s what "flat-ground evidence" for ltPaceSec/vo2maxPaceSec means here - use it, not the raw avgPaceSec, for any graded work lap. Do NOT use terrainPaceNote for this: that field is a prescriptive target (the pace to chase ON this route to match a flat target\'s effort - the opposite conversion), not a reading of what today\'s effort implies about flat-ground fitness - treating it as the flat-equivalent evidence gets the correction backwards. A hard uphill work segment running slower than a flat-ground target is not evidence of reduced fitness and should not pull the number down; a downhill segment running fast is not evidence of improved fitness either. Both ltPaceSec and vo2maxPaceSec assume flat ground, exactly like every other zone pace in this plan - only genuinely elevation-adjusted evidence (gapPaceSec, not raw pace) should move either number.'
        : '';
      tierFinalReminder = ' Before you write the closing VERDICT SUMMARY block, confirm your reply already contains a "TIER'+tierNum+' ESTIMATE:" block as required above - if you have not written it yet, add it now rather than proceeding to VERDICT SUMMARY without it.';
      tierPrompt = ' Separately: this session qualifies as evidence for a Tier '+tierNum+' fitness estimate ('+(tierNum===2?'outdoor, GPS/Strava-verified':'treadmill/indoor, no GPS')+'). Tier 1 (Garmin\'s own numbers, manually entered, ground truth but updated rarely) is currently: LTHR '+tier1.lthr+'bpm, LT pace '+fmtPace(tier1.ltPaceSec)+', Max HR '+tier1.maxHR+'bpm, VO2max '+tier1.vo2max+', resting HR '+tier1.restHR+'bpm. The current Tier '+tierNum+' estimate (anchor to adjust from, not replace wholesale) is: '+JSON.stringify(anchor)+'.'+speedContext+' Using today\'s evidence - '+(tierNum===2 ? 'the real Strava HR/pace data, especially work-lap HR relative to target' : 'TE Aerobic/Anaerobic (Garmin\'s own HR-response-shape calculation, valid indoors), HR-zone-time, and treadmillLTSpeed in km/h if present (the runner\'s speed at '+windowLabel+' - a legitimate indoor LT pace signal per standard treadmill threshold-test protocol, though note explicitly that treadmill-derived pace tends to run faster than true outdoor LT pace since HR is typically lower on a treadmill at the same perceived effort - flag this as treadmill-equivalent, not directly interchangeable with outdoor pace)')+' - produce a small, directional adjustment to the anchor, not a fresh independent calculation. Max HR should be the higher of the anchor\'s value or any new peak HR observed today. Resting HR should just match Tier 1\'s current value unless you have a specific reason not to. If Tier 1\'s current values differ meaningfully from what this Tier\'s anchor assumes (e.g. the runner manually updated Garmin numbers since this anchor was last set, and they\'re now clearly different), weight today\'s evidence toward closing that gap rather than treating the old anchor as untouchable - a manual Garmin update is real, verified evidence and should pull this estimate toward it over the next session or two, not be ignored in favor of a stale anchor. Otherwise, only adjust what today\'s evidence actually supports - most sessions warrant a small nudge or no change at all, not a big swing.'+fieldTargetInstruction+subThresholdAwarenessInstruction+terrainAwarenessInstruction+suggestedSpeedInstruction+' This block is mandatory whenever this note says the session qualifies, regardless of anything else this message asks for - it is not optional, and it does not have to be the last thing you write (anywhere in your reply is fine, as long as it appears before the closing VERDICT SUMMARY block). Include a block on its own line starting with exactly "TIER'+tierNum+' ESTIMATE:" followed by a single valid JSON object in exactly this shape: {"lthr":0,"ltPaceSec":0,"vo2maxPaceSec":0,"maxHR":0,"vo2max":0,"restHR":0,"suggestedNextSpeed":0,"suggestedNextVO2Speed":0,"basedOn":"one short phrase describing today\'s session"} - vo2maxPaceSec is seconds per km, analogous to ltPaceSec but for VO2max/interval effort specifically; omit suggestedNextSpeed and suggestedNextVO2Speed entirely when they don\'t apply, but only omit vo2maxPaceSec if truly no anchor value exists yet to carry forward. If your honest judgment is that nothing should change from the anchor, still include this block and simply restate the anchor\'s values unchanged - never skip the block itself just because the numbers aren\'t moving. Before you finish writing, double-check you actually included this exact "TIER'+tierNum+' ESTIMATE:" block somewhere above - it is easy to let it get crowded out by everything else this note asks for, and silently skipping it breaks this runner\'s fitness tracking.';
    }
    prompt = 'I just completed and logged this session - '+data.day.tag+', "'+data.day.name+'". Planned: '+plannedDesc+'.'+conversationNote+' Judge how well the session actually delivered on that stated purpose - not just whether the raw numbers look fine in isolation, but whether what was logged (RPE, TE, HR-vs-target, Strava data if present) suggests the intended physiological effect actually happened. What I actually did and logged: '+JSON.stringify(data.obj)+' (actualDist/actualDur/actualNote show what I really did if it differed from the plan - treat those as the ground truth over the planned numbers when judging how the session went. actualDist is real and accurate if present, but for interval/threshold/VO2max sessions or anything done on treadmill or bike, treat it as a secondary volume note, not a quality signal - RPE, TE, and HR-vs-target tell you how the session actually went far better than total distance does, since distance blends warmup/main-set/recovery/cooldown together and treadmill/bike were never distance-governed to begin with. "rec" is Garmin\'s accumulated recovery time remaining - it reflects cumulative recent training stress, not just this one session, so don\'t attribute a high value solely to today\'s effort. If both acuteLoad and chronicLoad are logged, actively check their ratio - roughly above ~1.5 is a widely-used heuristic for real injury-risk (load rising faster than the body has adapted to), below ~0.8 suggests detraining, and ~0.8-1.3 is the usual sustainable range; treat this as a rough heuristic, not a precise threshold, but do check it rather than only looking at loadStatus). If stravaImport is present in the logged data, check its lapsReliable field first: if true, this is real per-lap pace and HR that the import already classified by role (warmup/work/recovery/cooldown) - treat it as the most trustworthy data available and use the individual work-labeled laps to judge things a single average never could, like whether pace held, built, or faded across reps, and whether HR tracked appropriately throughout; there is no need to suggest ASK STRAVA when reliable data is already present. For threshold sessions specifically, this is also a direct chance to sanity-check the stored LTHR/LT pace itself, not just judge today\'s execution: if work-lap HR sat meaningfully below the target zone while holding or exceeding the prescribed pace, that is real evidence the true LT pace may now be faster than what is currently entered in the profile - call this out explicitly, do not just note it as background context, since it is a genuine candidate for a PASTE TO REBUILD suggestion to update the Garmin numbers. If HR instead ran meaningfully above the target zone at the prescribed pace, that suggests the opposite and is worth flagging just as directly. If elevationNote is present and non-empty, factor it in before judging any segment as slow - a hill-slowed segment is not a fitness problem, do not flag it as one. If fadeNote is present and non-empty, this is a genuine durability signal distinct from the session average - surfacing whether effort held, faded, or improved through the later work segments is exactly the kind of specific, evidence-based observation worth leading with, more useful than a generic summary. If estimatedTRIMP or vo2maxEstimate are present, they are Claude\'s own calculations from the HR/pace stream, not Garmin or Strava device output - use estimatedTRIMP as a supplementary read on how hard this session actually was (useful alongside RPE/TE, not a replacement for the user\'s own sessionLoad/acuteLoad/chronicLoad entries), and use vo2maxEstimate only as a directional trend check against the stored profile VO2max ("+profile.vo2max+") - a single session estimate meaningfully above or below that stored value is worth a passing mention as something to watch for confirmation on Garmin, not something to act on by itself or that should trigger a PASTE TO REBUILD on its own. If terrainPaceNote is present and non-empty, this is a route-specific pace-equivalent for hitting the target HR zone on this exact hilly route, derived from today\'s real data - worth surfacing directly since it\'s more actionable than the flat pace table for day-to-day pacing on future sessions here; only suggest making it a standing reference (not a one-off aside) if it\'s consistent with what similar sessions on this route have shown before, not from a single run alone. If lapsReliable is false, the laps likely do not correspond to real reps (e.g. simple auto-distance splits) - fall back to the total distance/duration/avgHR and RPE/TE as usual, and do not present lap-by-lap claims as fact. If avgHR is logged (it should be the main set/interval effort average, not the whole session - warmup, cooldown and recovery jogs would dilute it meaninglessly if included) and this session\'s target HR zone is '+(targetHR||'not applicable')+', explicitly check whether avgHR fell inside, above, or below that specific bpm range and say so plainly, naming the actual numbers rather than a vague in/out judgment - but before reading a below-target average as light effort, factor in that HR takes roughly 60-120 seconds to catch up to effort at the start of any rep, which drags a rep\'s own average down regardless of how hard it actually was; this matters most for short reps (a 3-4min VO2max interval can have a third or more of its duration still in that catch-up window), less for longer threshold reps. If Strava work-laps are present, their avgHR is already computed from the point HR actually reached target onward (not a whole-segment blend), so trust it directly rather than further discounting for ramp-up. If timeToTargetSec is present on a work lap, that\'s how long HR took to reach target this rep - a faster time across sessions over weeks is a genuine fitness signal worth noting if the pattern is real, not from one session. If recoveryHRDropBpm is present on a recovery lap, that\'s a real heart-rate-recovery signal (bpm dropped in the first 60s after a work rep) - independent of LTHR/VO2max, worth mentioning if notably strong or weak, but treat a single session\'s number as a data point, not a trend, unless prior sessions back it up. If a lap\'s paceSource is \"accelerometer\" rather than \"gps\", that pace came from a chest strap\'s stride estimate on a treadmill, not GPS - treat it as real but meaningfully less certain than GPS pace, especially for any specific pace-target comparison; \"gps\" pace or laps with no paceSource field (meaning genuine outdoor GPS) can be trusted at full confidence as before. If conditions is logged and describes heat, humidity, wind, or cold, factor that in before reading HR as a fitness signal - heat and humidity in particular can meaningfully elevate HR at a given effort (cardiac drift), and a headwind can slow pace independent of fitness; an otherwise-concerning HR or pace number fully explained by reported conditions is not the same signal as one with no such explanation, so say so plainly rather than flagging it as a red flag. For interval-type sessions, avgHR often won\'t be logged since it\'s genuinely tedious to compute by hand - that\'s fine and expected, RPE and Training Effect (Aerobic/Anaerobic) are the primary signals for how the effort actually went, since Garmin\'s Training Effect already accounts for HR-zone time more precisely than a manual average would anyway. If avgHR is missing on a session where the RPE/TE picture is genuinely ambiguous or concerning and real HR data would resolve it, that\'s exactly when to reach for an ASK STRAVA suggestion rather than expecting the number to have been hand-entered. Judge RPE relative to what the session called for, never as an absolute scale - a high RPE on a VO2max or threshold session is expected and fine, that\'s the point of the session; a red flag is RPE meaningfully higher or lower than what that specific session type should produce (e.g. an easy run at RPE 8, or a VO2max session at RPE 3), not a high number by itself. If mainSetPace is logged, treat it only as a rough, unverified gut-check, not paired HR-at-pace data - a typed-in "felt faster" note cannot show whether that pace held across all reps or was matched by an appropriately low HR. If it suggests something notable (either faster or slower than prescribed), that\'s exactly the moment to reach for an ASK STRAVA suggestion to get the real per-rep pace and HR pairing, rather than drawing a firm conclusion from the rough number alone. Write 2-4 sentences in clear, plain language - cut to the chase, lead with the main point about this specific session rather than burying it, and avoid jargon-heavy phrasing: plainly state whether this is a red flag (concerning RPE/load/recovery/pain, underperformed badly, HR notably outside target), a green flag (notably strong, recovering well, room to push, HR comfortably on target), or that nothing stands out; explain briefly what in the actual logged data supports that read; and what it means for the next few days. Don\'t manufacture a flag if there isn\'t one. If something meaningful should change in the plan itself - including tightening up because of a red flag, or adding load because of a clear green flag - end your reply with a block starting on its own line with exactly "PASTE TO REBUILD:" followed by 1 complete sentence stating what should change, written so I can copy it directly into the main Claude conversation - only include this block when a real plan change is warranted. '+(isQuality ? 'This was either planned as quality work (threshold/VO2max/long) or the logged RPE suggests it turned out harder than planned regardless of what the day was labeled - either way, if the logged numbers alone leave something genuinely ambiguous that real HR/pace splits from Strava would clarify, end your reply with a block starting on its own line with exactly "ASK STRAVA:" followed by a short message I can paste into the main conversation asking for that specific analysis - use this instead of PASTE TO REBUILD when what\'s actually needed is more data, not a plan change, and skip it entirely if nothing is ambiguous.' : '')+missingNote+proximityNote+tierPrompt+trajectoryContext+trajectoryPrompt+trajectory10KPrompt+tierFinalReminder+' Also, before the VERDICT SUMMARY block, add a block on its own line starting with exactly "GOAL IMPACT:" followed by exactly 1 short, concrete sentence connecting this specific session to progress toward '+activeGoalPhrase()+' - what it contributed, confirmed, or cost toward that goal, grounded in the actual logged numbers rather than generic encouragement. Finally, always end with a block on its own line starting with exactly "VERDICT SUMMARY:" followed by exactly 1 short sentence stating just the core essentials - the flag/verdict and the single most important reason, condensed - for a compact summary card separate from your fuller reply above.';
  } else {
    const conversationNote = conversationAwareNote('today\'s metrics or how the runner is feeling right now');
    prompt = 'I just logged today\'s metrics: '+JSON.stringify(data)+'.'+conversationNote+' First, identify what session is actually scheduled today (or next, if today is a rest day) from the plan above by matching today\'s date. Write 2-4 sentences in clear, plain language - cut to the chase, lead with the main point about this specific session rather than burying it, and avoid jargon-heavy phrasing: plainly state whether this is a red flag (poor sleep/readiness/HRV, concerning training status like Overreaching) or a green flag (notably good readiness, Peaking status, room to push harder), or that nothing stands out; briefly explain what in the actual numbers supports that read; and if it is a flag, give a concrete, specific recommendation for that exact upcoming session - not generic "watch your fatigue" advice, but something like "consider dropping to threshold effort instead of VO2max today" or "fine to push the long run\'s progressive finish a bit harder." Don\'t manufacture a flag if there isn\'t one. If something meaningful enough should change that it needs a real plan edit (not just today\'s execution), end your reply with a block starting on its own line with exactly "PASTE TO REBUILD:" followed by 1 complete sentence stating what should change, written so I can copy it directly into the main Claude conversation - only include this block when a real plan change is warranted, not for a single day\'s adjustment. Finally, always end with a block on its own line starting with exactly "VERDICT SUMMARY:" followed by exactly 1 short sentence stating just the core essentials - the flag/verdict and the single most important reason, condensed - for a compact summary card separate from your fuller reply above.';
  }

  try{
    const dataResp = await fetchCoachReply(await generateProfileContext(), prompt);
    const textResp = (dataResp.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n') || 'Sorry, I could not generate a response.';
    renderAssistantMessage(loadingId, textResp);
    // The achievability "watchdog" - deliberately deterministic (computeAchievabilityWarnings
    // is pure code, not LLM output), so an unreachable goal can never be missed just because
    // the coach's own free-text reply didn't happen to mention it. Scoped to real training-
    // session events only (workout/skip/freeworkout), same as buildTrajectoryPrompts below -
    // never fires for general Q&A, profile/metrics updates, or the weekly summary, and never
    // depends on whether textResp parsed cleanly.
    if(kind==='workout' || kind==='skip' || kind==='freeworkout'){
      try{
        const achievabilityWarnings = await computeAchievabilityWarnings();
        achievabilityWarnings.forEach(w=>{
          box.insertAdjacentHTML('beforeend',
            '<div class="msg system-note" style="border-left:3px solid #ff6b6b; padding-left:10px;">'+
            '&#9888; <b>'+w.goalLabel+' ('+w.currentGoalTimeLabel+') may not be reachable</b><br>'+w.reasonText+
            (w.realisticTimeLabel ? (' A realistic target based on current fitness is roughly <b>'+w.realisticTimeLabel+'</b>.') : '')+
            '<div style="margin-top:6px;"><button class="ghost-btn" onclick="proposeAchievabilityFix(\''+w.zoneKey+'\')">Review a realistic goal update</button></div></div>');
        });
        if(achievabilityWarnings.length) box.scrollTop = box.scrollHeight;
      }catch(e){ console.error('achievability watchdog failed', e); }
      // The symmetric watchdog for the ahead-of-schedule direction - same deterministic,
      // confirm-gated treatment as the achievability watchdog above (computeAheadOfScheduleWarnings
      // wraps the existing computeAheadOfScheduleSignals with the same across-session
      // confirmation layer). Reuses the existing proposePushFromAheadSignal() button action
      // (plan-override.js) unchanged - it already reads state.aheadOfScheduleSignals, which
      // refreshes independently of this confirm-gate.
      try{
        const pushWarnings = await computeAheadOfScheduleWarnings();
        pushWarnings.forEach(w=>{
          box.insertAdjacentHTML('beforeend',
            '<div class="msg system-note" style="border-left:3px solid var(--easy); padding-left:10px;">'+
            '&#9650; <b>'+w.goalLabel+' ('+w.goalTimeLabel+') is running ahead of schedule</b><br>'+w.label+
            (w.trend ? (' Trend: '+Math.abs(w.trend.rateSecPerWeek).toFixed(1)+'s/km/week improving.') : '')+
            '<div style="margin-top:6px;"><button class="ghost-btn" onclick="proposePushFromAheadSignal()">Push the plan harder</button></div></div>');
        });
        if(pushWarnings.length) box.scrollTop = box.scrollHeight;
      }catch(e){ console.error('push watchdog failed', e); }
    }
    if(missingForButtons.length) appendMissingSessionButtons(box, missingForButtons);
    if(textResp && textResp!=='Sorry, I could not generate a response.'){
      const tierKeys = ['TIER2 ESTIMATE:', 'TIER3 ESTIMATE:'];
      const noteFirstLine = textResp.split('PASTE TO REBUILD:')[0].split('ASK STRAVA:')[0].split('GOAL TRAJECTORY:')[0].split('GOAL TRAJECTORY 10K:')[0].split('MAINTENANCE TRAJECTORY:')[0].split('GOAL IMPACT:')[0].split('VERDICT SUMMARY:')[0].split('RUNNER INSIGHTS:')[0].split('UPDATE INSIGHTS:')[0].split('FOLLOW UPS:')[0].split('TIER2 ESTIMATE:')[0].split('TIER3 ESTIMATE:')[0].trim();
      const giSplit = textResp.split('GOAL IMPACT:');
      const goalImpact = giSplit.length>1 ? giSplit[1].split('VERDICT SUMMARY:')[0].split('RUNNER INSIGHTS:')[0].split('UPDATE INSIGHTS:')[0].split('FOLLOW UPS:')[0].split('TIER2 ESTIMATE:')[0].split('TIER3 ESTIMATE:')[0].trim() : null;
      await saveCoachNote(noteFirstLine, (kind==='workout'||kind==='skip') ? data.weekN : null, (kind==='workout'||kind==='skip') ? data.day.tag : null, kind, goalImpact);
      await sleep(150);
      const rebuildSplit = textResp.split('PASTE TO REBUILD:');
      const rebuildText = rebuildSplit.length>1 ? rebuildSplit[1].split('ASK STRAVA:')[0].split('GOAL TRAJECTORY:')[0].split('GOAL TRAJECTORY 10K:')[0].split('MAINTENANCE TRAJECTORY:')[0].split('GOAL IMPACT:')[0].split('VERDICT SUMMARY:')[0].split('RUNNER INSIGHTS:')[0].split('UPDATE INSIGHTS:')[0].split('FOLLOW UPS:')[0].split('TIER2 ESTIMATE:')[0].split('TIER3 ESTIMATE:')[0].trim() : null;
      const summarySplit = textResp.split('VERDICT SUMMARY:');
      const verdictSummary = summarySplit.length>1 ? summarySplit[1].split('RUNNER INSIGHTS:')[0].split('UPDATE INSIGHTS:')[0].split('FOLLOW UPS:')[0].split('TIER2 ESTIMATE:')[0].split('TIER3 ESTIMATE:')[0].trim() : noteFirstLine;
      await saveLatestVerdict(kind, verdictSummary, rebuildText);
      await sleep(150);
      const insightsSplit = textResp.split('RUNNER INSIGHTS:');
      if(insightsSplit.length>1){
        const newInsights = insightsSplit[1].split('GOAL TRAJECTORY:')[0].split('GOAL TRAJECTORY 10K:')[0].split('MAINTENANCE TRAJECTORY:')[0].split('TIER2 ESTIMATE:')[0].split('TIER3 ESTIMATE:')[0].trim();
        if(newInsights){ await saveWithRetry('runner-insights', {text:newInsights, updatedAt:new Date().toISOString()}, false); await sleep(150); }
      }
      const updateInsightsSplit = textResp.split('UPDATE INSIGHTS:');
      if(updateInsightsSplit.length>1){
        const newInsights2 = updateInsightsSplit[1].split('FOLLOW UPS:')[0].split('GOAL TRAJECTORY:')[0].split('GOAL TRAJECTORY 10K:')[0].split('MAINTENANCE TRAJECTORY:')[0].split('TIER2 ESTIMATE:')[0].split('TIER3 ESTIMATE:')[0].split('VERDICT SUMMARY:')[0].trim();
        if(newInsights2){ await saveWithRetry('runner-insights', {text:newInsights2, updatedAt:new Date().toISOString()}, false); await sleep(150); }
      }
      const followupSplit = textResp.split('FOLLOW UPS:');
      if(followupSplit.length>1){
        let followupRaw = followupSplit[1].split('GOAL TRAJECTORY:')[0].split('GOAL TRAJECTORY 10K:')[0].split('MAINTENANCE TRAJECTORY:')[0].split('TIER2 ESTIMATE:')[0].split('TIER3 ESTIMATE:')[0].split('VERDICT SUMMARY:')[0].trim();
        const fb = followupRaw.indexOf('['), lb = followupRaw.lastIndexOf(']');
        if(fb!==-1 && lb>fb){
          try{
            const items = JSON.parse(followupRaw.slice(fb, lb+1));
            if(Array.isArray(items)){
              await saveWithRetry('pending-followups', {items: items.slice(0,3).map(t=>({text:String(t)})), updatedAt:new Date().toISOString()}, false);
              await sleep(150);
            }
          }catch(e){ console.error('follow-up parse failed', e); }
        }
      }
      const trajSplit = textResp.split('GOAL TRAJECTORY:');
      if(trajSplit.length>1){
        let trajRaw = trajSplit[1].split('GOAL TRAJECTORY 10K:')[0].split('GOAL IMPACT:')[0].split('VERDICT SUMMARY:')[0].trim();
        const tfb = trajRaw.indexOf('{'), tlb = trajRaw.lastIndexOf('}');
        if(tfb!==-1 && tlb>tfb){
          try{
            const trajParsed = JSON.parse(trajRaw.slice(tfb, tlb+1));
            trajParsed.updatedAt = new Date().toISOString();
            trajParsed.basedOn = data.day ? (data.day.tag+' '+data.day.name) : kind;
            await saveWithRetry('goal-trajectory-latest', trajParsed, false);
            await sleep(150);
          }catch(e){ console.error('goal trajectory parse failed', e); }
        }
      }
      const traj10KSplit = textResp.split('GOAL TRAJECTORY 10K:');
      if(traj10KSplit.length>1){
        let traj10KRaw = traj10KSplit[1].split('GOAL IMPACT:')[0].split('VERDICT SUMMARY:')[0].trim();
        const tfb10 = traj10KRaw.indexOf('{'), tlb10 = traj10KRaw.lastIndexOf('}');
        if(tfb10!==-1 && tlb10>tfb10){
          try{
            const traj10KParsed = JSON.parse(traj10KRaw.slice(tfb10, tlb10+1));
            traj10KParsed.updatedAt = new Date().toISOString();
            traj10KParsed.basedOn = data.day ? (data.day.tag+' '+data.day.name) : kind;
            await saveWithRetry('goal-trajectory-10k-latest', traj10KParsed, false);
            await sleep(150);
          }catch(e){ console.error('10K goal trajectory parse failed', e); }
        }
      }
      const maintTrajSplit = textResp.split('MAINTENANCE TRAJECTORY:');
      if(maintTrajSplit.length>1){
        let maintTrajRaw = maintTrajSplit[1].split('GOAL IMPACT:')[0].split('VERDICT SUMMARY:')[0].trim();
        const mfb = maintTrajRaw.indexOf('{'), mlb = maintTrajRaw.lastIndexOf('}');
        if(mfb!==-1 && mlb>mfb){
          try{
            const maintTrajParsed = JSON.parse(maintTrajRaw.slice(mfb, mlb+1));
            maintTrajParsed.updatedAt = new Date().toISOString();
            maintTrajParsed.basedOn = data.day ? (data.day.tag+' '+data.day.name) : kind;
            await saveWithRetry('goal-trajectory-maintenance-latest', maintTrajParsed, false);
            await sleep(150);
          }catch(e){ console.error('maintenance trajectory parse failed', e); }
        }
      }
      let tierNotifications = [];
      for(const tk of tierKeys){
        const tSplit = textResp.split(tk);
        if(tSplit.length>1){
          let raw = tSplit[1].trim();
          const fb = raw.indexOf('{'), lb = raw.lastIndexOf('}');
          if(fb!==-1 && lb>fb){
            try{
              const parsedRaw = JSON.parse(raw.slice(fb, lb+1));
              const tierNum = tk.startsWith('TIER2') ? 2 : 3;
              const before = await loadTierEstimate(tierNum);
              const anchorForClamp = before || {lthr:state.profile.lthr, ltPaceSec:state.profile.ltPaceSec, maxHR:state.profile.maxHR, vo2max:state.profile.vo2max, restHR:state.profile.restHR};
              const parsed = clampTierEstimate(anchorForClamp, parsedRaw);
              // The real workout date (from completedAt, Strava-derived when available),
              // not "now" - otherwise every tier trend point lands on the day the coach
              // reply happened to be generated instead of the day the session was run,
              // same bug already fixed for the trend-history points in week-view.js.
              parsed.updatedAt = data.obj.completedAt || new Date().toISOString();
              // Re-saving the same session (e.g. after a Strava re-import correcting
              // earlier data) should replace its point in tier{N}-history, not add a
              // second one for the same real workout - see appendTrendPoint's dedupe.
              parsed.sessionId = workoutKey(data.weekN, data.day.tag);
              // Recompute the personalized VO2max gap in code (not asked of the model -
              // it's a subtraction, more reliable done deterministically) whenever this
              // session actually was VO2max evidence; otherwise carry the existing gap
              // forward unchanged, same as vo2maxPaceSec itself - a threshold session
              // must never move this, it has no valid evidence for VO2max-effort pace.
              if(data.day && data.day.type==='vo2max' && parsed.ltPaceSec!=null && parsed.vo2maxPaceSec!=null){
                parsed.vo2maxGapSec = parsed.ltPaceSec - parsed.vo2maxPaceSec;
              } else if(before && before.vo2maxGapSec!=null && parsed.vo2maxGapSec==null){
                parsed.vo2maxGapSec = before.vo2maxGapSec;
              }
              if(before){ await saveWithRetry('tier'+tierNum+'-estimate-previous', before, false); await sleep(150); }
              await saveTierEstimate(tierNum, parsed);
              await sleep(150);
              tierNotifications.push({tierNum, before, after:parsed});
            }catch(e){ console.error('tier estimate parse failed', e); }
          }
        }
      }
      // Belt-and-suspenders: the main reply is asked for a LOT of things at once (PASTE
      // TO REBUILD, ASK STRAVA, GOAL IMPACT, GOAL TRAJECTORY x2, VERDICT SUMMARY, and this
      // TIER block), and in practice the model sometimes drops the tier block even on a
      // qualifying session despite being told it's mandatory. If that happened, make one
      // small, focused follow-up request that asks for nothing else - much harder to drop.
      const pendingTierNum = qualifiesTier2 ? 2 : (qualifiesTier3 ? 3 : null);
      if(pendingTierNum && !tierNotifications.some(n=>n.tierNum===pendingTierNum)){
        try{
          const fallback = await requestTierEstimateFallback(pendingTierNum, data.day, data.obj, data.weekN);
          if(fallback) tierNotifications.push(fallback);
        }catch(e){ console.error('tier estimate fallback failed', e); }
      }
      // If a session qualified but STILL has no tier estimate after both the main reply
      // and the dedicated fallback request failed to produce one, that's real lost
      // evidence for this runner's fitness tracking - worth more than a silent console.error.
      if(pendingTierNum && !tierNotifications.some(n=>n.tierNum===pendingTierNum)){
        notifyError('Could not record a Tier '+pendingTierNum+' fitness estimate for this session - the coach reply didn\'t include a usable one, even after a retry. Today\'s evidence for this signal was not saved.');
      }
      if(pendingTierNum && data.day && data.day.type==='threshold' && tierNotifications.some(n=>n.tierNum===pendingTierNum)){
        await recordThresholdHybridProgress(data.day.tag);
      }
      if(tierNotifications.length){
        renderTierUpdateNotice(loadingId, tierNotifications);
        const divergence = await maybeUpdateTreadmillCalibration();
        if(divergence){
          notifyInfo('Heads up: your treadmill-vs-outdoor pace calibration just shifted by '+divergence.paceDelta+'s/km from what it was before - worth a look on the Key Metrics page if that seems off.');
        }
      }
    }
  }catch(e){
    const msg = e.status===529 ? 'Claude\'s API is briefly overloaded (already retried twice) - not a problem with your data, just try again in a moment' : (e.message||'unknown error');
    document.getElementById(loadingId).innerText = 'Could not check implications right now (' + msg + ').';
    console.error(e);
  }
  const replyEl = document.getElementById(loadingId);
  if(replyEl) replyEl.scrollIntoView({block:'start', behavior:'smooth'});
}

// Small, single-purpose follow-up call used when a qualifying session's main coach
// reply didn't include the required TIER{N} ESTIMATE block (see the comment at its call
// site in autoCoachMessage). Deliberately kept tiny and separate from generateProfileContext's
// huge system prompt - the whole point is to ask for exactly one thing so there's nothing else
// for the model to prioritize over it.
export async function requestTierEstimateFallback(tierNum, day, obj, weekN){
  const tier1 = {lthr:state.profile.lthr, ltPaceSec:state.profile.ltPaceSec, maxHR:state.profile.maxHR, vo2max:state.profile.vo2max, restHR:state.profile.restHR};
  const currentTier = await loadTierEstimate(tierNum);
  const anchor = currentTier || tier1;
  const marker = 'TIER'+tierNum+' ESTIMATE:';
  const isVo2 = day.type==='vo2max';
  const vo2maxPaceAnchorVal = (anchor.vo2maxPaceSec!=null) ? anchor.vo2maxPaceSec : await computeVO2maxPaceSec();
  const system = [{type:'text', text:
    'You compute a small, directional update to a runner\'s Tier '+tierNum+' ('+(tierNum===2?'outdoor, Strava-verified':'treadmill/indoor')+') running fitness estimate from one qualifying session\'s data. '+
    'Nudge the anchor toward what today\'s evidence actually supports - most sessions warrant only a small nudge or no change, not a big swing. Max HR should be the higher of the anchor\'s value or any new peak HR observed today. Resting HR should just match Tier 1 unless there is a specific reason not to. '+
    'ltPaceSec (threshold pace) and vo2maxPaceSec (VO2max/interval pace) are different physiological zones - only adjust the one this session is actually evidence for, and carry the other forward unchanged from the anchor. '+(isVo2
      ? 'This session was VO2max, so adjust vo2maxPaceSec (seconds/km, current anchor '+(vo2maxPaceAnchorVal!=null?vo2maxPaceAnchorVal:'none yet')+') from today\'s evidence, and carry ltPaceSec forward unchanged.'
      : 'This session was not VO2max, so adjust ltPaceSec as usual, and carry vo2maxPaceSec forward unchanged ('+(vo2maxPaceAnchorVal!=null?vo2maxPaceAnchorVal:'omit if none yet')+').')+' '+
    (!isVo2 ? 'This plan runs threshold at mid-zone HR by design, not pinned at the ceiling - HR sitting mid-zone at exactly the prescribed pace is correct execution, not new evidence, and shouldn\'t move ltPaceSec by itself. The real signal is today\'s pace at or faster than prescribed while HR still sat mid-zone-or-lower - that means the current target undershoots this runner. ' : '')+
    // Same terrainPaceNote-direction fix as the main tier prompt above (chat.js's other
    // TIER2/3 instruction block) - gapPaceSec per work lap is the real flat-equivalent of
    // what was actually run; terrainPaceNote is a prescriptive route target, the opposite
    // conversion, and must not be used to read fitness evidence.
    (tierNum===2 && obj.stravaImport ? 'This runner\'s home route is hilly, not flat, and both ltPaceSec and vo2maxPaceSec assume flat ground like every zone pace in this plan - if a work lap in stravaImport.laps has its own gapPaceSec (the Minetti-model flat-ground equivalent of that lap\'s actual pace, already grade-corrected), use that number for the graded lap, not its raw avgPaceSec and not terrainPaceNote (that field is a prescriptive route target for future pacing, the opposite conversion, not a reading of today\'s achieved fitness). A hill-slowed segment is not evidence of reduced fitness. ' : '')+
    (tierNum===3 ? 'If today\'s data includes treadmillLTSpeed, also include a "'+(isVo2?'suggestedNextVO2Speed':'suggestedNextSpeed')+'" field: a small, directional-only refinement (never more than ~0.2-0.3 km/h from today\'s logged speed or the prior anchor value'+(anchor.suggestedNextSpeed||anchor.suggestedNextVO2Speed ? (', current anchor '+(isVo2?anchor.suggestedNextVO2Speed:anchor.suggestedNextSpeed)+' km/h') : '')+') for what speed to hold next time. Omit it if treadmillLTSpeed wasn\'t logged today. ' : '')+
    'Respond with ONLY a single block starting with exactly "'+marker+'" followed by one valid JSON object in exactly this shape: {"lthr":0,"ltPaceSec":0,"vo2maxPaceSec":0,"maxHR":0,"vo2max":0,"restHR":0'+(tierNum===3?',"suggestedNextSpeed":0,"suggestedNextVO2Speed":0':'')+',"basedOn":"one short phrase describing this session"}. Nothing else - no preamble, no other commentary. This block is mandatory - if your judgment is that nothing should change, still return it with the anchor\'s values restated unchanged.'
  }];
  const userText = 'Session: '+day.tag+' "'+day.name+'" ('+day.type+').\nTier 1 (Garmin, ground truth): '+JSON.stringify(tier1)+'.\nCurrent Tier '+tierNum+' anchor (adjust from, not replace wholesale): '+JSON.stringify(anchor)+'.\nToday\'s logged data: '+JSON.stringify(obj)+'.';
  const respData = await callAnthropic('coach-chat', system, [{role:'user', content:userText}]);
  const text = (respData.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  const idx = text.indexOf(marker);
  if(idx===-1) return null;
  const raw = text.slice(idx+marker.length).trim();
  const fb = raw.indexOf('{'), lb = raw.lastIndexOf('}');
  if(fb===-1 || lb<=fb) return null;
  const parsedRaw = JSON.parse(raw.slice(fb, lb+1));
  const parsed = clampTierEstimate(currentTier || tier1, parsedRaw);
  // Same fix as the main path above: date this point by when the workout actually
  // happened (obj.completedAt), not by when this fallback request ran.
  parsed.updatedAt = obj.completedAt || new Date().toISOString();
  if(weekN!=null) parsed.sessionId = workoutKey(weekN, day.tag);
  if(isVo2 && parsed.ltPaceSec!=null && parsed.vo2maxPaceSec!=null){
    parsed.vo2maxGapSec = parsed.ltPaceSec - parsed.vo2maxPaceSec;
  } else if(currentTier && currentTier.vo2maxGapSec!=null && parsed.vo2maxGapSec==null){
    parsed.vo2maxGapSec = currentTier.vo2maxGapSec;
  }
  // Defensive carry-forward, same reasoning as vo2maxGapSec above - if this fallback fires
  // (the primary reply's TIER block failed to parse) and the model's response here omits
  // suggestedNextSpeed/suggestedNextVO2Speed despite the anchor having one, don't let the
  // suggestion silently vanish just because this specific request cycle didn't restate it.
  if(currentTier){
    if(parsed.suggestedNextSpeed==null && currentTier.suggestedNextSpeed!=null) parsed.suggestedNextSpeed = currentTier.suggestedNextSpeed;
    if(parsed.suggestedNextVO2Speed==null && currentTier.suggestedNextVO2Speed!=null) parsed.suggestedNextVO2Speed = currentTier.suggestedNextVO2Speed;
  }
  if(currentTier){ await saveWithRetry('tier'+tierNum+'-estimate-previous', currentTier, false); await sleep(150); }
  await saveTierEstimate(tierNum, parsed);
  await sleep(150);
  return {tierNum, before:currentTier, after:parsed};
}

export async function findUnloggedPastSessions(){
  const now = new Date();
  now.setHours(0,0,0,0);
  const candidates = [];
  state.WEEKS.forEach(w=>{
    w.days.forEach(d=>{
      if(d.type==='race') return;
      const dDate = parseDayTagDate(d.tag);
      if(!dDate || dDate >= now) return;
      candidates.push({w, d});
    });
  });
  const results = await batchMap(candidates, 6, async c=>{
    const runKey = workoutKey(c.w.n, c.d.tag);
    let hasRun = !!state.recentSaveCache[runKey];
    if(!hasRun){ try{ const r = await window.storage.get(runKey, false); hasRun = !!r; }catch(e){} }
    return hasRun ? null : {weekN:c.w.n, dayTag:c.d.tag, name:c.d.name, label:'Wk'+c.w.n+' '+c.d.tag+' - '+c.d.name};
  });
  return results.filter(r=>r);
}

export async function buildRecentTimeline(days){
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate()-days);
  cutoff.setHours(0,0,0,0);
  let byDate = {};

  const dailyHist = await loadDailyMetricsHistory();
  dailyHist.forEach(e=>{
    const d = new Date(e.date);
    if(d < cutoff) return;
    byDate[e.date] = byDate[e.date] || {};
    byDate[e.date].metrics = e.obj;
  });

  function attachWorkout(entry, day, type, eq){
    if(!entry.completed && !entry.skipped) return;
    let dateStr = null;
    if(entry.performedOnTag){
      const pd = parseDayTagDate(entry.performedOnTag);
      if(pd) dateStr = dateToYMD(pd);
    }
    if(!dateStr) dateStr = (entry.completedAt||entry.skippedAt) ? (entry.completedAt||entry.skippedAt).slice(0,10) : (parseDayTagDate(day.tag) ? dateToYMD(parseDayTagDate(day.tag)) : null);
    if(!dateStr) return;
    const d = new Date(dateStr);
    if(d < cutoff) return;
    byDate[dateStr] = byDate[dateStr] || {};
    byDate[dateStr].workouts = byDate[dateStr].workouts || [];
    const scheduledFor = (entry.performedOnTag && entry.performedOnTag!==day.tag) ? day.tag : null;
    if(entry.skipped){
      byDate[dateStr].workouts.push({
        name: type==='bike' ? bikeSessionName(eq?eq.kind:null) : day.name,
        skipped: true, skipReason: entry.skipReason, completedAt: entry.skippedAt||entry.completedAt, scheduledFor
      });
    } else {
      byDate[dateStr].workouts.push({
        name: type==='bike' ? bikeSessionName(eq?eq.kind:null) : day.name,
        rpe: entry.rpe, avgHR: entry.avgHR, loadStatus: entry.loadStatus,
        sessionLoad: entry.sessionLoad, acuteLoad: entry.acuteLoad, chronicLoad: entry.chronicLoad,
        teAero: entry.teAero, teAnaero: entry.teAnaero, rec: entry.rec, conditions: entry.conditions, completedAt: entry.completedAt, scheduledFor,
        // A real, computed load number (see computeTRIMP) for sessions where the runner
        // skipped manually transcribing Garmin's own session/acute/chronic load fields -
        // gives the coach an actual intensity signal for that day instead of nothing, even
        // though it's a different (Banister TRIMP) scale than Garmin's proprietary one.
        estimatedTRIMP: entry.stravaImport ? entry.stravaImport.estimatedTRIMP : null
      });
    }
  }

  const runLogs = await loadRunLogs();
  runLogs.forEach(l=> attachWorkout(l.entry, l.day, 'run'));
  const bikeLogs = await loadBikeLogs();
  bikeLogs.forEach(l=> attachWorkout(l.entry, l.day, 'bike', l.eq));
  // a free workout logged against a day that's also in runLogs/bikeLogs already appears
  // above via attachWorkout - only add the ones that don't, so the coach doesn't see the
  // same session described twice.
  const loggedDayKeys = new Set(runLogs.concat(bikeLogs).map(l=> l.weekN+'|'+l.day.tag));
  const freeWorkouts = (await loadFreeWorkouts()).filter(fw=> !loggedDayKeys.has(fw.weekN+'|'+fw.dayTag));
  freeWorkouts.forEach(fw=>{
    const d = new Date(fw.date);
    if(d < cutoff) return;
    byDate[fw.date] = byDate[fw.date] || {};
    byDate[fw.date].extraActivity = {
      type: fw.activityType, name: fw.name, distance: fw.distance, duration: fw.duration,
      avgHR: fw.avgHR, rpe: fw.rpe, teAero: fw.teAero, teAnaero: fw.teAnaero, conditions: fw.conditions, notes: fw.notes
    };
  });

  const dates = Object.keys(byDate).sort();
  if(!dates.length) return '';
  const lines = dates.map(date=>{
    const e = byDate[date];
    let parts = [];
    if(e.workouts && e.workouts.length){
      e.workouts.forEach(wk=>{
        parts.push('workout'+(wk.completedAt?(' ('+new Date(wk.completedAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})+')'):'')+': '+wk.name+(wk.scheduledFor?(' [originally scheduled '+wk.scheduledFor+']'):'')+(wk.skipped ? (' - SKIPPED'+(wk.skipReason?(' (reason: '+wk.skipReason+')'):'')) : ((wk.rpe?(' RPE '+wk.rpe):'')+(wk.avgHR?(' avgHR '+wk.avgHR+'bpm'):'')+(wk.estimatedTRIMP?(' TRIMP~'+wk.estimatedTRIMP+' (computed, not Garmin)'):'')+(wk.teAero?(' TE-aero '+wk.teAero):'')+(wk.teAnaero?(' TE-anaero '+wk.teAnaero):'')+(wk.sessionLoad?(' sessionLoad '+wk.sessionLoad):'')+(wk.acuteLoad?(' acuteLoad(7d) '+wk.acuteLoad):'')+(wk.chronicLoad?(' chronicLoad(28d) '+wk.chronicLoad):'')+(wk.loadStatus?(' loadStatus:'+wk.loadStatus):'')+(wk.rec?(' recoveryRemaining '+wk.rec+'h'):'')+(wk.conditions?(' conditions: '+wk.conditions):''))));
      });
    }
    if(e.extraActivity) parts.push('unplanned extra activity: '+e.extraActivity.type+(e.extraActivity.name?(' ('+e.extraActivity.name+')'):'')+(e.extraActivity.distance?(' '+e.extraActivity.distance+'km'):'')+(e.extraActivity.duration?(' '+Math.round(e.extraActivity.duration)+'min'):'')+(e.extraActivity.rpe?(' RPE '+e.extraActivity.rpe):'')+(e.extraActivity.avgHR?(' avgHR '+e.extraActivity.avgHR+'bpm'):'')+(e.extraActivity.teAero?(' TE-aero '+e.extraActivity.teAero):'')+(e.extraActivity.teAnaero?(' TE-anaero '+e.extraActivity.teAnaero):'')+(e.extraActivity.conditions?(' conditions: '+e.extraActivity.conditions):'')+(e.extraActivity.notes?(' notes: '+e.extraActivity.notes):''));
    if(e.metrics) parts.push('metrics'+(e.metrics.time?(' ('+e.metrics.time+')'):'')+': sleep '+(e.metrics.sleep||'-')+' readiness '+(e.metrics.readiness||'-')+' hrv '+(e.metrics.hrv||'-')+(e.metrics.hrvStatus?(' ('+e.metrics.hrvStatus+')'):'')+(e.metrics.trainingStatus?(' status:'+e.metrics.trainingStatus):''));
    return date+' - '+parts.join(' | ');
  });
  return lines.join('\n');
}

export async function buildPlanSummary(){
  if(!state.WEEKS) return '(Plan still loading - if you see this, wait a moment and try again.)';
  const today = new Date(); today.setHours(0,0,0,0);
  const currentIndex = state.WEEKS.findIndex(w=>{
    const wStart = parseWeekStartDate(w), wEnd = parseWeekEndDate(w);
    return wStart && wEnd && today >= wStart && today <= wEnd;
  });
  let lines = [];
  for(let wi=0; wi<state.WEEKS.length; wi++){
    const w = state.WEEKS[wi];
    const reducedTag = w.cutback ? (classifyReducedWeek(state.WEEKS, w.n)?.kind==='recovery' ? ', post-race recovery week' : ', cutback/taper week') : '';
    lines.push('Week '+w.n+' ('+w.dates+', '+computeWeekPlannedKm(w)+'km planned'+reducedTag+(w.race?', RACE WEEK':'')+'):');
    const wStart = parseWeekStartDate(w), wEnd = parseWeekEndDate(w);
    const isCurrentWeek = wStart && wEnd && today >= wStart && today <= wEnd;
    // Full day-by-day detail for last/current/next week, where it actually gets used
    // (what's coming up, what just happened) - a compact one-liner for weeks further
    // out, which the coach rarely needs at session-by-session granularity anyway.
    // Falls back to full detail everywhere if "current week" can't be determined at
    // all (e.g. viewing outside the plan's date range), matching prior behavior.
    const isNearWeek = currentIndex===-1 || Math.abs(wi-currentIndex)<=1;
    if(!isNearWeek){
      if(w.callout) lines.push('  Week callout: '+w.callout);
      continue;
    }
    const dayList = isCurrentWeek ? getFullWeekDayList(w) : w.days;
    // Extra workouts (lib/extras.js) - anything logged WITHOUT replacing a day's own
    // planned-session outcome (a genuine second/retry/unplanned session). Only fetched for
    // weeks that actually get day-by-day STATUS lines below, same scoping already used there.
    const weekExtras = isCurrentWeek ? await loadExtraWorkoutsForWeek(w) : [];
    const extraFragment = (dayTag) => {
      const list = extraWorkoutsForDay(weekExtras, dayTag);
      if(!list.length) return '';
      return ' | EXTRA: '+list.map(fw=> fw.activityType+(fw.name?(' - '+fw.name):'')+(fw.rpe?(' RPE '+fw.rpe):'')+(fw.retryOfTag?(' [retry of '+fw.retryOfTag+']'):'')).join('; ');
    };
    for(const d of dayList){
      if(d.type==='open'){
        if(!isCurrentWeek) continue;
        let openDesc = d.tag+' - open (nothing planned)';
        const log = await loadWorkoutLog(w.n, d.tag);
        if(log && log.completed) openDesc += ' | STATUS: logged - '+(log.name||log.activityType||'activity')+(log.performedOnTag ? '' : '');
        openDesc += extraFragment(d.tag);
        lines.push('  '+openDesc);
        continue;
      }
      let desc = d.tag+' - '+d.name+' ['+d.type+']';
      if(d.type==='easy'){
        desc += ': '+d.data.km+'km easy at '+state.Z.S2.hr+'bpm'+(d.data.strides?(', + '+d.data.strides+'x20s strides at the end'):'');
      } else if(d.type==='threshold' || d.type==='vo2max'){
        desc += ': '+d.data.totalKm+'km total ('+d.data.totalTime+'), main set '+d.data.main.label+' at '+d.data.main.pace+' / '+state.Z[d.zone].hr+'bpm, '+d.data.main.recoverySec+'s recovery between reps';
      } else if(d.type==='long'){
        desc += ': '+d.data.totalKm+'km total, structure: '+d.data.segments.map(s=>s.km+'km@'+(s.zone==='GOAL'?'goal pace':s.zone)).join(' then ');
      } else if(d.type==='race'){
        desc += ': '+d.data.km+'km, goal '+d.data.goalTime+' ('+d.data.goalPaceLabel+')';
      }
      if(d.note) desc += ' | Note: '+d.note;
      if(d.changeNote) desc += ' | RECENTLY CHANGED ('+(d.changeDate||'')+'): '+d.changeNote;
      if(isCurrentWeek && d.type!=='race'){
        const log = await loadWorkoutLog(w.n, d.tag);
        if(log && log.completed && log.performedOnTag && log.performedOnTag!==d.tag) desc += ' | STATUS: performed on '+log.performedOnTag+' instead, not here';
        // completed && swapped together = a same-day substitution (a different activity
        // logged in place of the plan, on the same day it was planned for) - must be
        // checked before the plain completed/swapped branches below, or this real,
        // actually-done activity either reads as "completed" with no mention it wasn't the
        // planned session, or (worse, the actual pre-fix bug) never shows completed:true at
        // all since a same-day swap always used to get overwritten to completed:false - see
        // saveFreeWorkout in ui/modals.js.
        else if(log && log.completed && log.swapped) desc += ' | STATUS: completed - swapped for something else ('+(log.swappedForName||'unspecified')+')';
        else if(log && log.completed) desc += ' | STATUS: completed';
        else if(log && log.skipped) desc += ' | STATUS: skipped ('+(log.skipReason||'no reason given')+')';
        else if(log && log.swapped) desc += ' | STATUS: swapped for something else ('+(log.swappedForName||'unspecified')+'), not yet performed';
        else if(log && log.rescheduled && log.rescheduledToTag) desc += ' | STATUS: not yet done, runner said they plan to do this on '+log.rescheduledToTag+' instead';
        else desc += ' | STATUS: not yet logged';
        desc += extraFragment(d.tag);
      }
      lines.push('  '+desc);
    }
    if(w.callout) lines.push('  Week callout: '+w.callout);
  }
  return lines.join('\n');
}

export async function generateProfileContext(){
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-US', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  let insightsNote = '';
  try{
    const ir = await window.storage.get('runner-insights', false);
    if(ir){ const iobj = JSON.parse(ir.value); if(iobj && iobj.text) insightsNote = "\nWhat's been learned about this specific runner from actual patterns over time (distinct from the static facts above - these are things repeated data has actually shown, updated weekly, treat as genuinely useful context but revise your own read if today's specific data contradicts it): "+iobj.text; }
  }catch(e){}
  let followupNote = '';
  try{
    const fr = await window.storage.get('pending-followups', false);
    if(fr){ const fobj = JSON.parse(fr.value); if(fobj && fobj.items && fobj.items.length) followupNote = "\nThings flagged to check back on with this runner (pain, injury concerns, life stress, anything worth a genuine human-coach follow-up, not just logged and forgotten): "+fobj.items.map(i=>i.text).join('; ')+". If today's context makes one of these genuinely relevant, ask about it naturally where it fits - don't force it into every single reply, and don't interrogate, just check in the way an attentive coach would. If the runner's own words already answer one of these, don't ask it again."; }
  }catch(e){}
  let inactivityNote = '';
  try{
    const inactivity = await getDaysSinceLastActivity();
    const layoff = inactivity ? estimateLayoffImpact(inactivity.days) : null;
    if(layoff){
      const scaledNote = layoff.rampWeeksRecommended>0
        ? (" Estimated impact (literature-based, an estimate from elapsed time - not a measurement, and never a substitute for a real Tier 1/2/3 reading once one exists): roughly "+layoff.ltPacePenaltyPct+"% slower LT pace and "+layoff.vo2maxPenaltyPct+"% lower VO2max/aerobic capacity than last measured, until confirmed otherwise by new evidence. "+layoff.note)
        : (" "+layoff.note);
      inactivityNote = "\nDays since last logged activity of any kind: "+inactivity.days+" (last one: "+inactivity.lastDate+"), severity: "+layoff.severity+"."+scaledNote+" More importantly for safety: resuming at pre-layoff intensity after a real gap is genuinely riskier than the fitness loss itself, since recent training-load adaptation has partly reset, so the same absolute effort now represents a much bigger relative jump than it would have before the gap - the same acute:chronic load principle already used elsewhere, just triggered by silence instead of a logged spike. If this gap is relevant to what's being discussed, say so plainly, using the specific figures above rather than vague reassurance. If a rebuild is warranted because of this gap specifically, the aim should be a genuine re-entry ramp scaled to the "+(layoff.rampWeeksRecommended||'0')+"-week figure above - easing back in first before resuming full prior intensity - not immediately resuming where training left off. This isn't in tension with the goal, it's how you protect the ability to keep pursuing it; if the mandatory ramp-back meaningfully eats into the time left before the goal date, say that honestly too rather than quietly assuming the timeline still works.";
    }
  }catch(e){}
  // Training status (Garmin's Peaking/Productive/Maintaining/Recovery/etc. label) was
  // previously only ever passed to the coach as a single day's or single week's snapshot -
  // nothing tracked whether it had been reading the same thing for a long stretch, and
  // there was no periodization-aware expectation for it anywhere in this prompt. This
  // computes the real streak deterministically (same "compute the fact, let the LLM judge
  // it against context it already has" split used everywhere else in this file) and hands
  // it over only once it's actually persistent enough to be worth a judgment call.
  let trainingStatusNote = '';
  try{
    const statusHistory = await loadTrainingStatusHistory();
    if(statusHistory.length){
      const latest = statusHistory[statusHistory.length-1];
      let streakCount = 1;
      for(let i=statusHistory.length-2; i>=0; i--){
        if(statusHistory[i].status===latest.status) streakCount++;
        else break;
      }
      if(streakCount>=5){
        trainingStatusNote = "\nGarmin training status trend: the last "+streakCount+" logged entries (since "+statusHistory[statusHistory.length-streakCount].date+") have all read '"+latest.status+"', out of "+statusHistory.length+" ever logged. This field has no hardcoded periodization target anywhere else in this app - it's on you to judge whether a status this persistent makes sense for wherever the plan currently is: 'Maintaining' during an early build week is unremarkable, but the same reading persisting into a peak or taper week - when it should be trending toward Productive/Peaking as race day approaches - is a real mismatch worth naming directly, not just mentioning in passing. If it looks like a genuine mismatch between what training status shows and what this phase of the plan should be producing, treat that as real enough evidence to factor into a PASTE TO REBUILD suggestion, not just a passing comment.";
      }
    }
  }catch(e){}
  let tierNote = '';
  try{
    const t2 = await loadTierEstimate(2);
    const t3 = await loadTierEstimate(3);
    if(t2 || t3){
      let calibNote = '';
      try{
        const calib = await window.storage.get('treadmill-calibration', false);
        if(calib){
          const c = JSON.parse(calib.value);
          calibNote = " A personal treadmill calibration exists, computed "+timeAgo(c.computedAt)+" from comparing Tier 2 and Tier 3 when both were fresh: treadmill LT pace ran "+Math.abs(c.ltPaceOffsetSec)+"s/km "+(c.ltPaceOffsetSec>0?'faster':'slower')+" than outdoor at the same effort"+(c.lthrOffset!=null?(", and treadmill LTHR ran "+Math.abs(c.lthrOffset)+"bpm "+(c.lthrOffset>0?'lower':'higher')+" than outdoor"):'')+". When Tier 2 (outdoor) has gone stale and you're relying on Tier 3 (treadmill) for a fitness-trend read, apply this offset to give a translated, outdoor-equivalent estimate alongside the raw treadmill number - e.g. 'your treadmill LT pace suggests roughly X outdoor-equivalent, based on your own calibration' - genuinely more useful than the raw treadmill number with just a generic caveat. This is this runner's own measured discrepancy, not a textbook average, so trust it over generic literature figures. Recompute your own mental model of this if a much newer calibration exists in future context - this one will get refreshed automatically whenever both tiers are fresh again.";
        }
      }catch(e){}
      let hybridNote = '';
      try{
        const readiness = await getThresholdHybridReadiness();
        if(readiness.count>0){
          hybridNote = readiness.ready
            ? " Progress note for the runner's own tracking, not a rule change: "+readiness.count+"/"+readiness.target+" qualifying threshold sessions have now produced a Tier 2/3 estimate since this was last discussed - the runner previously said they wanted to wait for roughly this many before considering extending the live Tier 2/3 pace treatment to threshold's own prescribed targets, the same way VO2max pace already works. If asked about this, say the threshold has been reached and it's worth their explicit decision - don't switch the behavior yourself."
            : " Progress note: "+readiness.count+"/"+readiness.target+" qualifying threshold sessions logged toward the runner's own bar for reconsidering whether threshold pace should get the same live-tracking treatment VO2max pace already has.";
        }
      }catch(e){}
      tierNote = "\nFitness has three tiers of evidence: Tier 1 is the manually-entered Garmin numbers above (LTHR "+state.profile.lthr+"bpm, LT pace "+fmtPaceExact(state.profile.ltPaceSec)+", Max HR "+state.profile.maxHR+", VO2max "+state.profile.vo2max+", resting HR "+state.profile.restHR+") - ground truth but only updates when the runner manually refreshes it, so it can go stale. Tier 2 is a live estimate from Strava-verified outdoor sessions"+(t2?(", last updated "+timeAgo(t2.updatedAt)+": "+JSON.stringify(t2)):" - no data yet")+". Tier 3 is a live estimate from treadmill/indoor sessions (useful when outdoor training goes quiet, e.g. winter)"+(t3?(", last updated "+timeAgo(t3.updatedAt)+": "+JSON.stringify(t3)):" - no data yet")+". Rules for using these: for PACE targets specifically (threshold/VO2max/long-run zone paces), the app already automatically uses whichever of Tier 1/2/3 is currently best-available (a non-stale Tier 2/3 read generally rules over Garmin unless Garmin is genuinely faster) - this happens live inside the app itself (recomputeZones), it is NOT something you need to propose, flag, or write a plan-change suggestion for; mentioning which tier currently governs pace is purely informational, already-true-automatically context, never an action item. LTHR and every other HR-zone range DOES stay Tier-1-only (manual Garmin entry) - that is the one thing that only updates via a real Garmin numbers update, never silently substituted. Critically: never emit a \"PASTE TO REBUILD:\" block just to say something like \"keep following Tier 2/3 pace guidance instead of the new Garmin number\" - that guidance is already true automatically and needs no plan change at all; only use \"PASTE TO REBUILD:\" for an actual change to session structure, volume, or goal targets, never merely to restate which tier is already governing a number. For discussing current fitness trend specifically (weekly summaries, 'am I getting fitter' type questions), use whichever tier is most recently updated and say explicitly which one you're drawing from - 'based on your last Garmin sync' and 'based on recent indoor sessions' are different claims and should read differently, don't blur them together. If Tier 1 looks stale and recent qualifying sessions are outdoor, lean on Tier 2 and mention Tier 1 could use a real refresh. If Tier 1 looks stale and recent sessions are predominantly treadmill, lean on Tier 3 - but Tier 3's LT Pace specifically is treadmill-equivalent, not directly interchangeable with outdoor pace (treadmill HR tends to run lower than outdoor at the same effort), so flag that explicitly and suggest an outdoor confirmation effort when conditions allow rather than treating it as final."+calibNote+hybridNote;
    }
  }catch(e){}
  // Deterministic pattern detection (see plan-adherence.js) already computes exactly which
  // session type has been under-delivered, how much, and how specifically that type serves
  // the CURRENTLY ACTIVE goal - this was previously only ever shown as a passive banner on
  // the week view, never actually told to the coach, so a runner asking "will running only
  // easy hurt my fitness?" got a generic answer instead of this runner's own real numbers.
  // Computed once at load and refreshed after any plan Apply/revert (see
  // refreshAdherenceState in plan-override.js) - may be a request or two stale mid-session,
  // same caveat as everything else here that isn't re-fetched on every single message.
  let missedSessionNote = '';
  try{
    const adjustments = state.missedSessionAdjustments || [];
    if(adjustments.length){
      const lines = adjustments.map(adj=>
        (adj.severity==='significant' ? 'SIGNIFICANT' : 'moderate')+' - '
        +(adj.kind==='consistentShortfall'
          ? adj.type+' sessions have consistently landed around '+adj.avgPct+'% of their own prescribed work ('+adj.shortCount+' of the last '+adj.sessionsChecked+' checked) over the last '+adj.windowWeeks+' weeks'
          : Math.round(adj.missed)+' of '+adj.scheduled+' '+adj.type+' sessions missed in the last '+adj.windowWeeks+' weeks')
        +' ('+adj.importance+' for the current goal). '+adj.note
        +(adj.severity==='significant' ? ' A concrete "Adjust plan" button already exists on this banner in the app (reduces or recalibrates the next upcoming session for every significantly-flagged type at once, same volume-first re-ramp principle as a post-layoff return) - point the runner at it rather than inventing your own numbers or trying to describe a manual edit in prose.' : '')
        +(adj.flagGoalConfidence ? ' Treat current goal-pace confidence as reduced until fresh evidence accumulates - this is exactly the kind of pattern (not a single missed session) that\'s worth genuinely factoring into how confident you sound about the goal timeline.' : '')
      );
      missedSessionNote = "\nMissed-session pattern check (deterministic, computed from the actual logged schedule, not a single day's snapshot): "+lines.join(' ')+" If any of this is relevant to what's being discussed, say so plainly and specifically (name the type and the real numbers) rather than a vague 'stay consistent' reminder - but don't force it into a reply about something unrelated.";
    }
  }catch(e){}
  let layoffAdjNote = '';
  try{
    const layoffAdj = await getLayoffAdjustment();
    if(layoffAdj){
      layoffAdjNote = "\nSeparate from the tier ranking above: a layoff adjustment is CURRENTLY ACTIVE and already baked into every prescribed pace shown on session cards ("+layoffAdj.days+" days since last logged activity, "+layoffAdj.severity+") - threshold pace is running "+layoffAdj.ltPacePenaltyPct+"% slower and VO2max pace "+layoffAdj.vo2maxPenaltyPct+"% slower than the raw Tier 1/2/3 number above, as a temporary injury-prevention measure, not a change to the underlying fitness reading itself. This clears itself automatically the moment a real Tier 1/2/3 update lands (no action needed from you) - until then, if asked why a prescribed pace looks slower than the LT pace given above, this is why, and it's working as intended, not a bug or a discrepancy to resolve.";
    }
  }catch(e){}
  let trajectoryNote = '';
  try{
    const traj = await window.storage.get('goal-trajectory-latest', false);
    if(traj){
      const t = JSON.parse(traj.value);
      trajectoryNote = "\nThe front-page goal trajectory bar currently reads: position "+t.position+"/100 ("+t.confidence+" confidence), headline: \""+t.headline+"\", last updated "+timeAgo(t.updatedAt)+(t.basedOn?(' after '+t.basedOn):'')+". This was itself synthesized from the same signals available to you now (LT pace gap, efficiency/time-to-target/HR-recovery trends). Stay consistent with this existing read rather than independently arriving at a different overall verdict from the same evidence - if today's specific analysis genuinely points somewhere new, it's fine to say so and explain why, but don't casually contradict this displayed number without cause, since the runner sees both this text and that bar and will notice a mismatch.";
    }
  }catch(e){}
  let efficiencyNote = '';
  try{
    const trend = await getEfficiencyTrend();
    if(trend){
      efficiencyNote = "\nAerobic efficiency trend (speed-per-heartbeat on easy runs, a well-established fitness proxy independent of the LTHR/VO2max tiers above - rising = more speed for the same HR = improving aerobic base): recent 5-run average is "+(trend.pctChange>=0?'+':'')+trend.pctChange.toFixed(1)+"% vs the prior 5 runs, based on "+trend.count+" logged easy runs total."+(trend.calibrated?" This number is already corrected for a known personal Stryd-vs-GPS measurement offset (Stryd reports slightly shorter/faster than GPS for the runner) - the correction has already been applied, so don't separately discount this trend for source-switching, that's already handled.":" No Stryd-vs-GPS calibration exists yet - if this runner mixes GPS-only and Stryd easy runs, be cautious reading a swing here as fitness change until more of both source types are logged.")+" Treat this as a supplementary signal for aerobic base trend specifically, not a substitute for LTHR/VO2max - genuinely useful if asked about overall fitness trend or if easy-day pace/effort comes up, but don't over-read a single week's swing.";
    }
  }catch(e){}
  let ttTargetNote = '';
  try{
    const trend = await getTrendSummary('timetotarget-history');
    if(trend && trend.pctChange!=null){
      ttTargetNote = "\nTime-to-target-HR trend (from Strava-verified speed work - how long HR takes to catch up to effort at the start of a hard rep, a genuine fitness signal, faster/lower is better): recent average is "+trend.avgRecent.toFixed(0)+"s, "+(trend.pctChange<=0?'faster (improving) ':'slower ')+"by "+Math.abs(trend.pctChange).toFixed(0)+"% vs the prior comparison period, based on "+trend.count+" qualifying sessions. Supplementary signal, don't over-read a single session.";
    }
  }catch(e){}
  let hrRecoveryNote = '';
  try{
    const trend = await getTrendSummary('hrrecovery-history');
    if(trend && trend.pctChange!=null){
      hrRecoveryNote = "\nHeart rate recovery trend (bpm HR drops in the first 60s of recovery between hard reps, from Strava-verified speed work - independent of LTHR/VO2max, more drop is generally better): recent average is "+trend.avgRecent.toFixed(0)+"bpm, "+(trend.pctChange>=0?'improving ':'declining ')+"by "+Math.abs(trend.pctChange).toFixed(0)+"% vs the prior comparison period, based on "+trend.count+" qualifying sessions. Supplementary signal, don't over-read a single session.";
    }
  }catch(e){}
  let decouplingNote = '';
  try{
    const trend = await getTrendSummary('decoupling-history');
    if(trend && trend.pctChange!=null){
      decouplingNote = "\nAerobic decoupling trend (from long runs specifically - within-run pace-per-heartbeat efficiency comparing the first half to the second half of the same run, a genuine durability signal distinct from the day-to-day easy-run efficiency trend above; lower % is better, meaning efficiency held up rather than fading late): recent average is "+trend.avgRecent.toFixed(1)+"%, "+(trend.pctChange<=0?'improving (less late-run fade) ':'worsening (more late-run fade) ')+"by "+Math.abs(trend.pctChange).toFixed(0)+"% vs the prior comparison period, based on "+trend.count+" qualifying long runs. This is computed directly from the raw HR/pace stream, not an LLM estimate - trust the number itself, but still treat a single run's reading as one data point, not a trend, same as the others here.";
    }
  }catch(e){}
  const missing = await findUnloggedPastSessions();
  const missingSummary = missing.length ? ("\nScheduled past sessions with no log at all (bring this up if relevant, e.g. if asked what's outstanding - the user has clickable buttons for these already, so just note there are gaps rather than listing them in detail): "+missing.map(m=>m.label).join('; ')+".") : "";
  const timeline = await buildRecentTimeline(10);
  const timelineSummary = timeline ? ("\nLast ~10 days, daily metrics and completed workouts merged chronologically by real date - use this to watch for genuine correlations over time (e.g. HRV or readiness dropping in the days after a hard session, a pattern of poor sleep before sessions that go badly, recovery trending the wrong direction across a week even if each single day looks fine). This timeline includes acuteLoad(7d) and chronicLoad(28d) when logged - the ratio between them (acute:chronic) is a widely-used training-load heuristic worth actively checking: roughly above ~1.5 is generally considered a real injury-risk signal (load rising much faster than the body has adapted to), below ~0.8 generally suggests detraining/undertraining, and roughly 0.8-1.3 is the usual sustainable range - treat these as rough, widely-cited heuristics rather than precise medical thresholds, and only surface it as a flag when the actual logged numbers clearly support it, not from a single day's entry. Only point out a correlation when the data actually shows a repeatable pattern, not from one data point, and say so plainly when you spot one rather than waiting to be asked:\n"+timeline) : "";
  // The 10-day timeline above is too short to see a real block-wide pattern (a skip rate,
  // a hard-session-to-next-day-metrics correlation) - this computes those deterministically
  // over the WHOLE current block instead, see progression.js. Wrapped so a failure here
  // never blocks the rest of the context from building.
  let blockProgressionNote = '';
  try{ blockProgressionNote = await buildBlockProgressionNote(); }catch(e){ console.error('buildBlockProgressionNote failed', e); }
  // Split into a large, mostly-stable block (cached - plan/instructions/trends barely
  // change between calls in the same sitting) and a tiny block that's genuinely fresh
  // every single call (today's date, which week/mode is on screen right now) - see
  // the M4 planning conversation for why this split and not one flat string.
  const stableBlock = "You are a running and cycling coach assistant embedded in an 8-week half marathon training app. "+
  "Important: any VERDICT SUMMARY, GOAL IMPACT, or similar short block you write gets saved and may be displayed again days or weeks later, including after the runner restores an old data backup - so in those specific blocks, never use relative-day words like 'today', 'yesterday', or 'this morning' to refer to a specific session or event, since that wording becomes misleading once time has passed. Reference the actual day name or date instead (e.g., 'skipping Wednesday's easy run' not 'skipping today's run'). This only applies to those persisted summary blocks - your fuller conversational reply above them can still say 'today' naturally, since that part isn't re-displayed later the same way. Also: the plan structure below uses 'Week 1', 'Week 2' etc. as capitalized section headers, but when you refer to a week number inside your own normal sentences, write it lowercase like any other English noun ('week 1', 'week 3') unless it genuinely starts the sentence - don't just copy the header capitalization into your own prose. "+
  "Runner: 35M, hilly asphalt home route. LTHR "+state.profile.lthr+"bpm at "+fmtPaceExact(state.profile.ltPaceSec)+" (Garmin, authoritative - never override with your own estimate). Max HR "+state.profile.maxHR+", resting HR "+state.profile.restHR+", VO2max "+state.profile.vo2max+". "+
  "Each session card in the app UI shows an HR zone gauge with a single-point 'optimal HR' marker (a dot on the bar) for that session's zone - this is separate from and more specific than the broader zone range/floor text (e.g. 'S5' or '171+bpm'). If the runner asks about a specific bpm number they see marked as optimal on a card, or about that marker in general, these are the current computed values so you can answer accurately instead of falling back to just the zone name: S1 "+computeOptimalHR({},'S1')+"bpm, S2 "+computeOptimalHR({},'S2')+"bpm, S3 "+computeOptimalHR({},'S3')+"bpm, S4 "+computeOptimalHR({},'S4')+"bpm. "+
  "VO2max (S5) sessions: the gauge marker itself ("+computeOptimalHR({},'S5')+"bpm, ~95% Max HR) is a final-reps ceiling, not a flat number to hold from rep one - HR realistically climbs across a whole set of reps (not just within one rep) from combined HR-kinetics lag and real cardiac drift rep-to-rep, and this runner's own logged sessions already show that exact pattern. The session's written detail text (not the gauge) also gives a realistic opening-rep figure ("+computeVO2maxBuildStartHR()+"bpm, ~88% Max HR) for context. If asked about 'the optimal HR' on a VO2max card, or why the marked number felt too high to sustain, be explicit that it's a final-reps ceiling, not a flat target to hold from rep one - treating it that way is exactly how a session blows up early. "+
  "Also unlike every other zone in this plan, VO2max PACE (not HR) is the primary target the runner should actually hold - VO2max effort never reaches steady state within a single rep the way threshold does, so HR is a secondary readout here, not something to chase or adjust pace for. This pace target is deliberately NOT pinned to the Tier 1 Garmin LT pace the way every other zone's pace is - it's computed as best-available threshold pace minus a gap (vo2maxGapSec in Tier 2/3's JSON above if present): that gap is a real, personalized figure once a VO2max session has actually been logged and analyzed, or a generic ~18s/km literature assumption until then. This plan only has 3 VO2max-type sessions across all 8 weeks (vs 8 threshold sessions), so this deliberately keeps tracking threshold improvements between those rare sessions rather than freezing on a stale raw number - the GAP is what gets refined from real evidence, then continuously reapplied to whatever threshold pace is currently best-known. Note vo2maxGapSec and ltPaceSec are tracked completely separately - a threshold session's evidence only ever moves ltPaceSec, a VO2max session's only ever moves vo2maxGapSec (via its own vo2maxPaceSec observation), they don't cross-inform each other. If Tier 1/2/3 numbers come up in conversation, know that VO2max pace is the one exception to 'Tier 1 always stays authoritative for actual training targets' - LTHR and every other zone's pace still follow that rule unchanged, only VO2max pace does not. "+
  "Method: Norwegian sub-threshold training as the main organizing method - two weekly quality days (a shorter but genuine threshold session on Monday, a larger threshold-or-VO2max session on Wednesday), built to be ambitious and push fitness meaningfully within physiologically sound limits rather than conservative by default. Threshold rep pace targets sit at LT pace exactly (not faster) since this is HR-based, not lactate-meter-based - no direct feedback if a rep drifts truly above threshold, so the pace number is deliberately conservative and HR (mid-zone, not pinned at the top) is the primary governing signal, with time-in-zone mattering more than hitting an exact pace or HR number. HR lags effort by roughly 60-120 seconds at the start of any hard rep - that's normal physiology, not a sign of under-effort, and reps shouldn't be started artificially harder just to force HR up faster. "+
  (()=>{
    const goalConfig = state.goalConfig || defaultGoalConfig();
    const goals = goalConfig.activeGoals||[];
    const tenKGoal = goals.find(g=>g.zoneKey==='RACE10K');
    const capExceptionNote = tenKGoal ? (' except around the '+tenKGoal.raceDate+' '+(tenKGoal.label||'race')+' ('+(tenKGoal.raceName||'')+', goal '+(tenKGoal.goalTimeLabel||'').toLowerCase()+') which is a deliberate taper/peak exception') : '';
    const background = "Background: history of ankle/thigh/quad issues, but nothing currently active - if pain comes up, the runner will report it directly and the plan adjusts in real time from that; don't proactively caution about injury history that isn't currently active. Forest trails are paused for now by preference, not medical necessity. Mileage increases capped at 10%/week (standard ramp-rate guidance)"+capExceptionNote+". ";
    const goalLines = goals.map(g=>{
      const impliedLT = g.goalPaceSec!=null ? g.goalPaceSec : Math.round(impliedLTPaceForGoal(g.goalTimeSec||0, g.distanceKm||1));
      const gapSec = impliedLT - state.profile.ltPaceSec;
      return (g.label||g.type||'Goal')+": "+(g.raceName||'')+", "+(g.raceDate||'date TBD')+", goal "+(g.goalTimeLabel||'').toLowerCase()+" ("+(g.goalPaceLabel||fmtPace(impliedLT))+" race pace, which implies an LT pace target of roughly "+fmtPace(impliedLT)+" since race pace typically runs a few percent slower than LT pace). Current LT pace is "+fmtPaceExact(state.profile.ltPaceSec)+" - "+(gapSec>0 ? (gapSec+"s/km of LT pace still to close before race day") : "already at or faster than the implied LT pace target")+". Keep this gap in mind across the whole block, not just when directly asked - if the trajectory over several weeks looks like it won't close in time, or is closing faster than expected, that's worth surfacing proactively. ";
    });
    const goalSection = goalLines.length ? goalLines.join('') : "Current phase: "+(goalConfig.phase||'maintenance')+" - no active race goal right now, so judge sessions against maintaining or gradually building fitness rather than a race-pace gap. ";
    return background+goalSection;
  })()+
  "Here is the FULL 8-week running plan, week by week, so you can reference exactly what's scheduled, what came before, and what's coming next:\n"+await buildPlanSummary()+"\n\n"+
  "Bike mode mirrors this same weekly structure at equivalent duration and bike HRR zones (%HRR based on Max HR/resting HR), used as planned cross-training or as a substitute on days running isn't possible. "+
  "Give concise, practical, coach-toned answers, using the actual schedule above to sequence advice (e.g. what's tomorrow, how a hard session fits before/after another). Be direct about standout signals - both red flags (concerning numbers, pain, overreaching) and green flags (strong recovery, room to push harder) - rather than defaulting to cautious neutral commentary; don't manufacture a flag where there isn't one, but don't soften a real one either. Always judge RPE and effort relative to what the specific session called for, never as an absolute scale - high RPE on a VO2max or threshold session is the point of the session, not a concern; the signal is a mismatch between RPE and session intent, not a high number by itself. You can discuss pacing, interpret HR/RPE/training-effect/load numbers, and suggest specific adjustments to a session - but you cannot edit the plan data or pull Strava in this app. "+
  "Give concise, practical, coach-toned answers in normal conversational length - a few sentences to a short paragraph as the question warrants, not artificially clipped. When you conclude the plan itself should genuinely change (not just today's execution or general advice), end your reply with a block starting on its own line with exactly \"PASTE TO REBUILD:\" followed by 1-2 sentences stating what should change, written so the user can copy it directly into the main Claude conversation to have it actually rebuilt there. Only include that block when a real, specific change is warranted - not as a sign-off on every message. "+
  "Separately, when a genuine Strava-based check-in would add real value for a session the user has actually completed - a key quality session (threshold, VO2max, a goal-pace long run segment, or a race) where seeing the actual HR/pace splits would clarify something logged numbers alone can't (e.g. whether HR drift, terrain, or pacing caused a concerning number; confirming a strong session was genuinely well-executed; verifying goal-pace segments were actually hit) - end your reply with a block starting on its own line with exactly \"ASK STRAVA:\" followed by a short, direct message the user can paste into the main Claude conversation to request that specific analysis (e.g. naming the session/date and what to look at). Only suggest this for sessions marked completed in the plan/logs above - never for a session that's still upcoming, even if the conversation is discussing what that future session will involve. Don't suggest this for easy runs or routine sessions with nothing ambiguous to clarify, and don't stack it with a PASTE TO REBUILD block in the same reply - pick whichever one actually applies."+missingSummary+timelineSummary+blockProgressionNote+insightsNote+followupNote+inactivityNote+trainingStatusNote+tierNote+layoffAdjNote+missedSessionNote+trajectoryNote+efficiencyNote+ttTargetNote+hrRecoveryNote+decouplingNote+
  " Separately and importantly: if this specific message contains something durably important that should be remembered going forward - a new or changed injury or pain, a genuine change in circumstances (schedule, life events affecting training), or a strong explicit preference the runner just stated - end your reply with a block starting on its own line with exactly \"UPDATE INSIGHTS:\" followed by the full updated insights summary with this new information naturally integrated (not just appended - rewrite the paragraph to include it coherently, keep under 150 words total, starting from the current summary given above if one exists). Only include this block when something genuinely durable was just shared - not for routine session chat, questions, or one-off comments. This is separate from and takes priority over the weekly-only update - don't wait for the weekly cycle for something like a reported injury. Also, separately, maintain a short list of things worth genuinely following up on with this runner later - the kind of thing an attentive human coach would remember and check back in on, not administrative tracking: a pain or niggle mentioned, a stressful life event, anything left open. Revise the current list given above: drop anything that seems resolved or already addressed by what the runner has said in this conversation, keep anything still genuinely open, add anything new from this message worth checking on later. Keep it to at most 3 items, short phrases only (e.g. \"left quad tightness since Aug 5\" not a full sentence). End your reply with a block starting on its own line with exactly \"FOLLOW UPS:\" followed by a valid JSON array of short strings, or [] if nothing is worth tracking - only include this block when the list actually needs to change from what's given above, not on every message.";

  const volatileBlock = "Today's date is "+todayStr+". You're currently viewing Week "+state.currentWeek+" in "+state.appMode+" mode.";
  return [
    {type:'text', text: stableBlock, cache_control:{type:'ephemeral'}},
    {type:'text', text: volatileBlock},
  ];
}

window.copyVerdictRebuild = copyVerdictRebuild;
window.toggleVerdictHistory = toggleVerdictHistory;
