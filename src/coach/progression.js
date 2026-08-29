// @ts-nocheck
// Deterministic block-progression facts, computed over the WHOLE current block rather than
// the ~10-day rolling timeline buildRecentTimeline (chat.js) already covers - that window is
// good for "how's the last week and a half gone" but too short to see a real pattern like
// "skipped 3 of 9 easy runs this block" or "hard sessions tend to hit next-day readiness."
// Same split used everywhere else in this codebase: compute the fact here, hand it to the
// coach in chat.js's generateProfileContext, let it judge the fact against context - never
// hardcode the verdict here.
import { state } from '../state.js';
import { dateToYMD, parseDayTagDate } from '../lib/dates.js';
import { workoutKey } from '../lib/keys.js';
import { batchMap } from '../lib/utils.js';
import { loadRunLogs } from '../ui/history-view.js';
import { loadDailyMetricsHistory } from '../ui/kpi-view.js';

const SESSION_TYPE_LABELS = {easy:'easy runs', threshold:'threshold sessions', vo2max:'VO2max sessions', long:'long runs'};

// Tallies completed/skipped/never-logged per session type across every past day in
// state.WEEKS (races excluded - they're their own thing, not a skip-rate pattern). Same
// day-walking approach findUnloggedPastSessions (chat.js) already uses, just keeping the
// completed/skipped breakdown instead of only "has any log at all."
export async function computeSkipPatternTally(){
  const now = new Date(); now.setHours(0,0,0,0);
  const candidates = [];
  (state.WEEKS||[]).forEach(w=>{
    w.days.forEach(d=>{
      if(d.type==='race') return;
      const dDate = parseDayTagDate(d.tag);
      if(!dDate || dDate >= now) return;
      candidates.push({w, d});
    });
  });
  const results = await batchMap(candidates, 6, async c=>{
    const key = workoutKey(c.w.n, c.d.tag);
    let entry = state.recentSaveCache[key];
    if(!entry){ try{ const r = await window.storage.get(key, false); if(r) entry = JSON.parse(r.value); }catch(e){} }
    return {type: c.d.type, entry};
  });
  const tally = {};
  results.forEach(({type, entry})=>{
    tally[type] = tally[type] || {completed:0, skipped:0, unlogged:0};
    if(entry && entry.completed) tally[type].completed++;
    else if(entry && entry.skipped) tally[type].skipped++;
    else tally[type].unlogged++;
  });
  return tally;
}

// Pure formatter - only mentions a session type when something's actually notable (a
// skip or a never-logged day), not every type just because it exists.
export function skipPatternNote(tally){
  if(!tally) return null;
  const parts = [];
  Object.keys(tally).forEach(type=>{
    const t = tally[type];
    const total = t.completed+t.skipped+t.unlogged;
    if(total===0 || (t.skipped===0 && t.unlogged===0)) return;
    parts.push((SESSION_TYPE_LABELS[type]||type)+': '+t.completed+'/'+total+' completed'+(t.skipped?(', '+t.skipped+' skipped'):'')+(t.unlogged?(', '+t.unlogged+' never logged'):''));
  });
  if(!parts.length) return null;
  return 'Session completion over the WHOLE current block so far (not just the recent timeline above): '+parts.join('; ')+'.';
}

function median(nums){
  if(!nums.length) return null;
  const sorted = [...nums].sort((a,b)=>a-b);
  const mid = Math.floor(sorted.length/2);
  return sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
}

const RECOVERY_METRICS = {readiness:'training readiness', hrv:'HRV'};
const RECOVERY_DROP_THRESHOLD_PCT = 0.9; // a next-day reading below 90% of the trailing baseline counts as a real drop
const RECOVERY_BASELINE_WINDOW_DAYS = 14;
const RECOVERY_MIN_SESSIONS_TO_REPORT = 3; // don't report a rate off too few data points

// For each logged hard/quality session (threshold/VO2max/long, or any session with RPE 7+)
// this block, checks whether the FOLLOWING calendar day's readiness/HRV came in meaningfully
// below that metric's own trailing ~14-day median - a real, computed correlation the coach
// can factor in, not an impression from memory of a few recent sessions.
export async function computeHardSessionRecoveryCorrelation(){
  const dailyHist = await loadDailyMetricsHistory();
  if(dailyHist.length < 5) return null;
  const byDate = {};
  dailyHist.forEach(e=>{ byDate[e.date] = e.obj; });
  const sortedDates = dailyHist.map(e=>e.date).sort();

  function baselineFor(metric, beforeDateStr){
    const idx = sortedDates.indexOf(beforeDateStr);
    const start = idx===-1 ? sortedDates.length : Math.max(0, idx-RECOVERY_BASELINE_WINDOW_DAYS);
    const end = idx===-1 ? sortedDates.length : idx;
    const vals = sortedDates.slice(start, end).map(d=>parseFloat(byDate[d][metric])).filter(v=>!isNaN(v));
    return median(vals);
  }

  let runLogs = [];
  try{ runLogs = await loadRunLogs(); }catch(e){}
  const hardSessions = runLogs.filter(l=> l.entry.completed && (['threshold','vo2max','long'].includes(l.day.type) || parseFloat(l.entry.rpe)>=7));

  const tally = {};
  Object.keys(RECOVERY_METRICS).forEach(m=>{ tally[m] = {dropped:0, total:0}; });

  hardSessions.forEach(log=>{
    const performedDate = log.entry.performedOnTag ? parseDayTagDate(log.entry.performedOnTag) : parseDayTagDate(log.day.tag);
    if(!performedDate) return;
    const nextDate = new Date(performedDate); nextDate.setDate(nextDate.getDate()+1);
    const nextDateStr = dateToYMD(nextDate);
    const nextEntry = byDate[nextDateStr];
    if(!nextEntry) return;
    Object.keys(RECOVERY_METRICS).forEach(m=>{
      const val = parseFloat(nextEntry[m]);
      if(isNaN(val)) return;
      const baseline = baselineFor(m, nextDateStr);
      if(baseline==null) return;
      tally[m].total++;
      if(val < baseline*RECOVERY_DROP_THRESHOLD_PCT) tally[m].dropped++;
    });
  });
  return tally;
}

export function hardSessionRecoveryNote(tally){
  if(!tally) return null;
  const parts = [];
  Object.keys(tally).forEach(m=>{
    const t = tally[m];
    if(t.total >= RECOVERY_MIN_SESSIONS_TO_REPORT){
      parts.push(RECOVERY_METRICS[m]+' dropped meaningfully below its trailing baseline the day after a hard session '+t.dropped+' of '+t.total+' times');
    }
  });
  if(!parts.length) return null;
  return 'Hard-session recovery pattern (computed directly from logged daily metrics, not an impression): '+parts.join('; ')+' - a real, countable pattern worth weighing when judging whether more recovery is needed after quality work, not just a single day\'s reading.';
}

// Convenience wrapper for generateProfileContext - computes both facts and joins whatever
// notes actually have something to say into one string (empty string if neither does).
export async function buildBlockProgressionNote(){
  let notes = [];
  try{
    const skipTally = await computeSkipPatternTally();
    const skipNote = skipPatternNote(skipTally);
    if(skipNote) notes.push(skipNote);
  }catch(e){ console.error('computeSkipPatternTally failed', e); }
  try{
    const recoveryTally = await computeHardSessionRecoveryCorrelation();
    const recoveryNote = hardSessionRecoveryNote(recoveryTally);
    if(recoveryNote) notes.push(recoveryNote);
  }catch(e){ console.error('computeHardSessionRecoveryCorrelation failed', e); }
  return notes.length ? ('\n'+notes.join(' ')) : '';
}
