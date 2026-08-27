import { state } from '../state.js';
import { loadWorkoutLog } from '../ui/week-view.js';

export function calendarWeekKey(dateLike){
  const d = new Date(dateLike);
  const jan1 = new Date(d.getFullYear(),0,1);
  const days = Math.floor((d.getTime()-jan1.getTime())/86400000);
  const week = Math.ceil((days+jan1.getDay()+1)/7);
  return d.getFullYear()+'-W'+String(week).padStart(2,'0');
}

export function parseDayTagDate(tag){
  const datePart = tag.split(' - ')[1]; // e.g. "Aug 3"
  if(!datePart) return null;
  const d = new Date(datePart+', 2026');
  return isNaN(d.getTime()) ? null : d;
}

export function parseWeekStartDate(w){
  if(!w || !w.dates) return null;
  const parts = w.dates.split('-');
  if(!parts.length) return null;
  const d = new Date(parts[0].trim()+', 2026');
  if(isNaN(d.getTime())) return null;
  d.setHours(0,0,0,0);
  return d;
}

export function dateToTag(d){
  const wd = d.toLocaleDateString('en-US',{weekday:'short'});
  const md = d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  return wd+' - '+md;
}

export function getFullWeekDayList(w){
  const start = parseWeekStartDate(w);
  const end = parseWeekEndDate(w);
  if(!start || !end) return w.days;
  const plannedByDate = {};
  w.days.forEach(d=>{
    const pd = parseDayTagDate(d.tag);
    if(pd) plannedByDate[pd.toDateString()] = d;
  });
  const fullList = [];
  const cursor = new Date(start);
  while(cursor <= end){
    const key = cursor.toDateString();
    if(plannedByDate[key]){
      fullList.push(plannedByDate[key]);
    } else {
      const tag = dateToTag(cursor);
      fullList.push({tag, name:'Open day', zone:'', type:'open', data:{}});
    }
    cursor.setDate(cursor.getDate()+1);
  }
  return fullList;
}

export function parseWeekEndDate(w){
  if(!w || !w.dates) return null;
  const parts = w.dates.split('-');
  if(parts.length<2) return null;
  const endPart = parts[parts.length-1].trim();
  let endStr;
  if(/^\d+$/.test(endPart)){
    const startMonth = w.dates.split(' ')[0];
    endStr = startMonth+' '+endPart+', 2026';
  } else {
    endStr = endPart+', 2026';
  }
  const d = new Date(endStr);
  if(isNaN(d.getTime())) return null;
  d.setHours(23,59,59,999);
  return d;
}

export function weekHasEnded(weekN){
  const w = state.WEEKS.find(x=>x.n===weekN);
  if(!w) return true;
  const end = parseWeekEndDate(w);
  if(!end) return true;
  return new Date() > end;
}

// Deterministic day-gap fact for the coach's schedule-shift commentary - found via a real
// coach reply that correctly knew a session had moved (Wed -> Thu) but then did its own
// freehand day-gap arithmetic against the nearest other quality session and got it
// backwards (said the move shortened the gap when it actually lengthened it by a day).
// Not a data bug - the schedule tracking itself was already correct - just an LLM
// arithmetic-reliability issue, same "compute the fact, let the LLM judge it" split used
// for tier estimate clamping, decoupling, training-status streaks, etc. Scans this session's
// own week plus the immediately adjacent weeks for the nearest OTHER quality-type
// (threshold/vo2max/long) day on each side, using that day's own actual performed date if
// it was itself moved/logged, not just its originally scheduled tag.
const QUALITY_DAY_TYPES = ['threshold', 'vo2max', 'long'];

export async function computeNearbyQualityGapDays(weekN, currentDayTag, performedDate){
  if(!performedDate) return null;
  const weekIdx = state.WEEKS.findIndex(w=>w.n===weekN);
  if(weekIdx===-1) return null;
  const candidateWeeks = [state.WEEKS[weekIdx-1], state.WEEKS[weekIdx], state.WEEKS[weekIdx+1]].filter(Boolean);
  const candidates = [];
  for(const w of candidateWeeks){
    for(const d of w.days){
      if(w.n===weekN && d.tag===currentDayTag) continue;
      if(!QUALITY_DAY_TYPES.includes(d.type)) continue;
      let actualTag = d.tag;
      try{
        const log = await loadWorkoutLog(w.n, d.tag);
        if(log && log.performedOnTag) actualTag = log.performedOnTag;
      }catch(e){}
      const actualDate = parseDayTagDate(actualTag);
      if(actualDate) candidates.push({tag:d.tag, name:d.name, actualDate});
    }
  }
  let before = null, after = null;
  candidates.forEach(c=>{
    const diffDays = Math.round((performedDate.getTime()-c.actualDate.getTime())/86400000);
    if(diffDays>0 && (!before || diffDays<before.gapDays)) before = {tag:c.tag, name:c.name, gapDays:diffDays};
    else if(diffDays<0 && (!after || -diffDays<after.gapDays)) after = {tag:c.tag, name:c.name, gapDays:-diffDays};
  });
  return {before, after};
}

export async function findNextUpcomingWeek(){
  const today = new Date(); today.setHours(0,0,0,0);
  for(const w of state.WEEKS){
    let weekFullyLogged = true;
    for(const d of w.days){
      if(d.type==='race') continue;
      const log = await loadWorkoutLog(w.n, d.tag);
      if(!log || !(log.completed || log.skipped || log.swapped || log.moved)){ weekFullyLogged = false; break; }
    }
    if(!weekFullyLogged) return w.n;
    const weekEndDate = parseWeekEndDate(w);
    if(weekEndDate && today <= weekEndDate) return w.n;
  }
  return state.WEEKS[state.WEEKS.length-1].n;
}
