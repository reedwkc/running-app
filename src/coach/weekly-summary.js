// @ts-nocheck
import { state } from '../state.js';
import { fetchCoachReply, generateProfileContext } from './chat.js';
import { threshold } from '../data/plan.js';
import { defaultGoalConfig } from '../data/goal-config.js';
import { impliedLTPaceForGoal } from './goal-trajectory.js';
import { parseDayTagDate, parseWeekEndDate } from '../lib/dates.js';
import { fmtPace, fmtPaceExact } from '../lib/format.js';
import { saveWithRetry } from '../lib/storage.js';
import { sleep } from '../lib/utils.js';
import { loadRunLogs } from '../ui/history-view.js';
import { loadDailyMetricsHistory } from '../ui/kpi-view.js';

export async function getWeekPreview(weekN){
  if(weekN <= 1) return null;
  if(state.weekPreviewCache[weekN]) return state.weekPreviewCache[weekN];
  try{
    const r = await window.storage.get('week-preview-w'+weekN, false);
    if(r){ const obj = JSON.parse(r.value); state.weekPreviewCache[weekN] = obj; return obj; }
  }catch(e){}
  return null;
}

// Lets a stale cached preview (e.g. one generated before a bug in what data fed it was
// fixed, or before a completed session's log entry was corrected) be thrown away and
// regenerated - getWeekPreview otherwise returns whatever's cached forever, since nothing
// else ever invalidates it once a week's preview has been generated once. Deliberately
// just clears state; the caller (regenerateWeekPreview in ui/week-view.js) re-renders the
// week afterward, which is what actually triggers a fresh generateWeekPreview call - same
// auto-generation path a never-yet-generated week already goes through.
export async function clearWeekPreview(weekN){
  try{ await window.storage.delete('week-preview-w'+weekN, false); }catch(e){}
  delete state.weekPreviewCache[weekN];
}

export function copyWeekPreviewRebuild(weekN, btnEl){
  const obj = state.weekPreviewCache[weekN];
  if(!obj || !obj.rebuildText) return;
  navigator.clipboard.writeText(obj.rebuildText).then(()=>{
    if(btnEl){ const orig=btnEl.innerText; btnEl.innerText='Copied!'; setTimeout(()=>{btnEl.innerText=orig;},1500); }
  });
}

export async function generateWeekPreview(weekN){
  if(weekN <= 1) return null;
  // Guards against two concurrent generations for the same week - renderWeek's own
  // auto-trigger (whenever it renders with no cached preview) can otherwise overlap with a
  // manual Regenerate click (or a double-click on that button, which has no disabled state
  // of its own), firing two real coach API calls for the same week. Each independently
  // saves and re-renders when it resolves, so whichever call happens to land LAST silently
  // clobbers the other's result - since these are freeform generations, not deterministic,
  // that reads as "a message flashed up, then got replaced by a different one" even though
  // both were genuine, valid responses. Only ONE caller should actually run the generation;
  // return null to any other concurrent caller rather than have it wait and double-render.
  if(state.weekPreviewInFlight[weekN]) return null;
  state.weekPreviewInFlight[weekN] = true;
  try{
    return await generateWeekPreviewInner(weekN);
  } finally {
    delete state.weekPreviewInFlight[weekN];
  }
}

async function generateWeekPreviewInner(weekN){
  let prevLogs = [];
  try{ prevLogs = await loadRunLogs(); }catch(e){}
  const prevWeekLogs = prevLogs.filter(l=>l.weekN===weekN-1);
  const completedPrev = prevWeekLogs.filter(l=>l.entry.completed);
  const prevWeekObj = state.WEEKS.find(w=>w.n===weekN-1);
  const totalPrevDays = prevWeekObj ? prevWeekObj.days.filter(d=>d.type!=='race').length : 0;
  const missedCount = Math.max(0, totalPrevDays - completedPrev.length);
  const summaryLines = completedPrev.map(l=>{
    let stravaNote = '';
    if(l.entry.stravaImport && l.entry.stravaImport.lapsReliable){
      const workLaps = (l.entry.stravaImport.laps||[]).filter(x=>x.role==='work');
      if(workLaps.length) stravaNote = ' [Strava-verified reps: '+workLaps.map(x=>x.avgPaceLabel+(x.avgHR?('@'+x.avgHR+'bpm'):'')).join(', ')+']';
    }
    // l.day is always the PLANNED day (decodeRunLogKey looks it up from state.WEEKS by tag,
    // see lib/keys.js) - fine for a normal "Mark as completed", but a swap means what
    // actually happened differs from that. l.entry.name is only ever set by the free-
    // workout/swap save path (saveFreeWorkout in ui/modals.js) - a normal completion's form
    // has no name field at all - so its presence reliably flags "this wasn't the planned
    // session as-is" for both a same-day swap (which also carries swappedForName, a ready-
    // made "name (Xkm)" label) and a cross-day swap's target record (which doesn't, so the
    // same shape gets built from the raw name/actualDist here). Previously this described
    // every completed entry as l.day.tag+' '+l.day.name regardless, so a swapped-in all-out
    // effort got reported to the coach as if the ORIGINAL planned session (e.g. "Moderate
    // long run") had happened at that RPE - materially misleading the weekly outlook.
    // Same misattribution risk as the swap case above, different mechanism: a hill day's
    // flat alternative (day.alt, chosen via the toggle in week-view.js and locked in as
    // entry.performedAlt at completion) is a genuinely different session from the primary
    // one, not a swap - reading l.day.name here would describe a flat session as a hill one.
    const effectiveDayName = (l.entry.performedAlt==='alt' && l.day.alt) ? l.day.alt.name : l.day.name;
    const actualLabel = l.entry.swappedForName || (l.entry.name ? (l.entry.name+(l.entry.actualDist?(' ('+l.entry.actualDist+'km)'):'')) : null);
    const sessionDesc = actualLabel ? (actualLabel+' - swapped in for the planned "'+effectiveDayName+'"') : effectiveDayName;
    // actualNote is the regular-completion "what actually happened" field (week-view.js);
    // notes is the free-workout form's equivalent (fw-notes, ui/modals.js) - a swap only
    // ever populates the latter, so reading actualNote alone silently dropped every note
    // written on a swapped-in session.
    const noteText = l.entry.actualNote || l.entry.notes || '';
    return l.day.tag+' '+sessionDesc+': RPE '+(l.entry.rpe||'-')+(l.entry.avgHR?(' avgHR '+l.entry.avgHR+'bpm'):'')+(l.entry.loadStatus?(' load:'+l.entry.loadStatus):'')+(l.entry.conditions?(' conditions: '+l.entry.conditions):'')+(noteText?(' note: '+noteText):'')+stravaNote;
  });
  let metricsNote = '';
  try{
    const dailyHist = await loadDailyMetricsHistory();
    const weekStart = prevWeekObj && prevWeekObj.days.length ? parseDayTagDate(prevWeekObj.days[0].tag) : null;
    const weekEndD = prevWeekObj ? parseWeekEndDate(prevWeekObj) : null;
    const prevWeekMetrics = (weekStart && weekEndD) ? dailyHist.filter(e=>{ const d=new Date(e.date); return d>=weekStart && d<=weekEndD; }) : [];
    if(prevWeekMetrics.length){
      const sleeps = prevWeekMetrics.map(e=>parseFloat(e.obj.sleep)).filter(v=>!isNaN(v));
      const readiness = prevWeekMetrics.map(e=>parseFloat(e.obj.readiness)).filter(v=>!isNaN(v));
      const avgSleep = sleeps.length ? Math.round(sleeps.reduce((a,b)=>a+b,0)/sleeps.length) : null;
      const avgReadiness = readiness.length ? Math.round(readiness.reduce((a,b)=>a+b,0)/readiness.length) : null;
      const hrvStatuses = [...new Set(prevWeekMetrics.map(e=>e.obj.hrvStatus).filter(s=>s))];
      const trainingStatuses = [...new Set(prevWeekMetrics.map(e=>e.obj.trainingStatus).filter(s=>s))];
      metricsNote = ' Daily metrics that week ('+prevWeekMetrics.length+' check-ins): '+(avgSleep?('avg sleep score '+avgSleep+', '):'')+(avgReadiness?('avg readiness '+avgReadiness+', '):'')+(hrvStatuses.length?('HRV status: '+hrvStatuses.join('/')+', '):'')+(trainingStatuses.length?('training status: '+trainingStatuses.join('/')):'');
    } else {
      metricsNote = ' No daily metrics (sleep/readiness/HRV) were logged that week.';
    }
  }catch(e){}
  const thisWeekObj = state.WEEKS.find(w=>w.n===weekN);
  const structuralNote = thisWeekObj && thisWeekObj.callout ? (' This week is structurally noted as: "'+thisWeekObj.callout+'"') : '';
  const hmGoal = (state.goalConfig||defaultGoalConfig()).activeGoals.find(g=>g.zoneKey==='GOAL');
  let goalNote = '';
  if(hmGoal){
    const impliedLTGoalSec = hmGoal.goalPaceSec!=null ? hmGoal.goalPaceSec : Math.round(impliedLTPaceForGoal(hmGoal.goalTimeSec||95*60, hmGoal.distanceKm||21.0975));
    const goalGapSec = impliedLTGoalSec - state.profile.ltPaceSec;
    goalNote = ' '+(hmGoal.label||'Goal')+' goal pace is '+(hmGoal.goalPaceLabel||fmtPace(impliedLTGoalSec))+', which implies an LT pace of roughly '+fmtPace(impliedLTGoalSec)+' (race pace runs a few percent slower than LT pace); current LT pace is '+fmtPaceExact(state.profile.ltPaceSec)+' ('+(goalGapSec>0?(Math.abs(goalGapSec)+'s/km of LT pace still to close'):'already at or faster than the implied LT pace target')+').';
  }
  let currentInsights = '';
  try{ const ir = await window.storage.get('runner-insights', false); if(ir){ const iobj = JSON.parse(ir.value); currentInsights = (iobj && iobj.text) || ''; } }catch(e){}
  const insightsPrompt = ' Separately, review this runner\'s patterns more broadly (not just last week - use the full history context available to you above) and maintain a short, living "what I\'ve learned about this specific runner" summary. This is distinct from static facts already given elsewhere (injury history, method, goal) - only include genuinely learned behavioral or physiological patterns backed by repeated evidence: things like consistently undershooting or overshooting RPE on a particular session type, a specific readiness/sleep threshold that reliably predicts how a session goes, unusually strong or weak response to a particular training stimulus, recurring pacing habits on this specific route, etc. Current summary (empty if none exists yet): "'+currentInsights.replace(/"/g,'\\"')+'". Revise it based on what the data actually supports now - add genuinely new patterns, drop anything that hasn\'t held up or was based on too little data, keep existing ones that still hold. Keep the whole thing under 150 words, written as plain prose, not a list. If there is truly nothing new or different to say, you may return the same text unchanged. End your reply with a block starting on its own line with exactly "RUNNER INSIGHTS:" followed by the updated summary - always include this block, even if unchanged.';
  const prompt = 'I\'m about to start Week '+weekN+'. Here\'s how Week '+(weekN-1)+' actually went: '+(summaryLines.length ? summaryLines.join('; ') : 'nothing logged')+(missedCount>0 ? ('. '+missedCount+' session(s) that week were never logged.') : '')+'.'+metricsNote+structuralNote+goalNote+' If any session that week has a [Strava-verified reps] tag, that\'s real per-rep pace and HR data, not a self-report - weigh it as strong evidence, especially for the goal-pace question: reps consistently faster than prescribed at appropriate HR is genuine grounds for revisiting the goal upward, and reps consistently slower or with HR drifting high is genuine grounds for backing off, more so than RPE alone would justify. Write exactly 1 complete sentence, no more: give a short, practical outlook for Week '+weekN+' - what to keep in mind or watch for, genuinely tied to how last week went (including recovery signals, not just session RPE) and whether the goal-pace gap is closing at a reasonable rate for the time remaining, not generic advice. Finish that one sentence fully before stopping - do not start a second sentence. If fitness is dropping enough that the plan should be rebuilt, or improving enough that the goal or plan should be revisited upward, end with a block starting on its own line with exactly "PASTE TO REBUILD:" followed by 1 complete sentence stating what should change and why, written so I can copy it into the main Claude conversation - only include this block when a real, week-over-week trend actually warrants it, not from one session.'+insightsPrompt;
  try{
    const sys = await generateProfileContext();
    const dataResp = await fetchCoachReply(sys, prompt);
    const rawText = (dataResp.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
    if(rawText){
      const mainText = rawText.split('PASTE TO REBUILD:')[0].split('RUNNER INSIGHTS:')[0].trim();
      const rebuildMatch = rawText.split('PASTE TO REBUILD:');
      const rebuildText = rebuildMatch.length>1 ? rebuildMatch[1].split('RUNNER INSIGHTS:')[0].trim() : null;
      const insightsMatch = rawText.split('RUNNER INSIGHTS:');
      if(insightsMatch.length>1){
        const newInsights = insightsMatch[1].trim();
        if(newInsights) await saveWithRetry('runner-insights', {text:newInsights, updatedAt:new Date().toISOString()}, false);
      }
      const obj = {text:mainText, rebuildText, date:new Date().toISOString()};
      await saveWithRetry('week-preview-w'+weekN, obj, false);
      state.weekPreviewCache[weekN] = obj;
      return obj;
    }
  }catch(e){ console.error('week preview generation failed', e); }
  return null;
}

window.copyWeekPreviewRebuild = copyWeekPreviewRebuild;
