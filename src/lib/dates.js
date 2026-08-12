import { state } from '../state.js';
import { loadWorkoutLog } from '../ui/week-view.js';

export function calendarWeekKey(dateLike){
  const d = new Date(dateLike);
  const jan1 = new Date(d.getFullYear(),0,1);
  const days = Math.floor((d-jan1)/86400000);
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
