import { state } from '../state.js';
import { loadWorkoutLog } from '../ui/week-view.js';

export function calendarWeekKey(dateLike){
  const d = new Date(dateLike);
  const jan1 = new Date(d.getFullYear(),0,1);
  const days = Math.floor((d.getTime()-jan1.getTime())/86400000);
  const week = Math.ceil((days+jan1.getDay()+1)/7);
  return d.getFullYear()+'-W'+String(week).padStart(2,'0');
}

// This app originally ran entirely within a single calendar year, so every tag/week-range
// string just hardcoded ", 2026" - a plan spanning into a second year (e.g. a 12-month block
// reaching from Sep 2026 into Sep 2027) broke that: "Jan 6" always meant Jan 6, 2026, no
// matter which real January it was describing, silently corrupting week-passed detection,
// taper/race countdowns, and chronological ordering for anything actually dated the
// following year. A week object can now carry its own "year" field to disambiguate - weekYear
// defaults to 2026 (this app's original single-year assumption) for any week that predates
// this field, so every existing plan/override keeps behaving exactly as before.
function weekYear(w){
  return (w && w.year) || 2026;
}

// A bare day tag ("Wed - Aug 5") has no year of its own - the year lives on whichever WEEK
// object actually contains it. weeksOverride lets a caller resolve against a specific weeks
// array (e.g. plan-override.js's validation, which must resolve a proposal's own dates
// correctly BEFORE it's ever merged into state.WEEKS) instead of the live plan; omitted, this
// falls back to state.WEEKS (the normal case - the day tag being parsed almost always belongs
// to the actual current plan). A tag found in neither (an orphaned reference, or one from a
// block no longer represented anywhere) falls back to 2026, matching this app's original
// behavior with no regression for anything that already worked before multi-year plans did.
function findWeekForTag(tag, weeksOverride){
  const pools = weeksOverride ? [weeksOverride, state.WEEKS] : [state.WEEKS];
  for(const pool of pools){
    if(!pool) continue;
    for(const w of pool){
      if((w.days||[]).some(d=>d.tag===tag)) return w;
    }
  }
  return null;
}

export function parseDayTagDate(tag, weeksOverride){
  const datePart = tag.split(' - ')[1]; // e.g. "Aug 3"
  if(!datePart) return null;
  const w = findWeekForTag(tag, weeksOverride);
  const year = w ? weekYear(w) : 2026;
  let d = new Date(datePart+', '+year);
  if(isNaN(d.getTime())) return null;
  // A week that genuinely crosses a real Jan 1 (e.g. "Dec 28-Jan 3", year:2026 - matching
  // its own START date, per parseWeekEndDate's identical convention) has its January days
  // parse as if they were the DECEMBER year, landing before the week's own start date - the
  // same impossible-ordering signal parseWeekEndDate already uses to self-correct, applied
  // here per-day instead of once for the week's end. No day within a week should ever
  // resolve earlier than that week's own start.
  const wStart = w && parseWeekStartDate(w);
  if(wStart && d < wStart) d = new Date(datePart+', '+(year+1));
  return d;
}

export function parseWeekStartDate(w){
  if(!w || !w.dates) return null;
  const parts = w.dates.split('-');
  if(!parts.length) return null;
  const d = new Date(parts[0].trim()+', '+weekYear(w));
  if(isNaN(d.getTime())) return null;
  d.setHours(0,0,0,0);
  return d;
}

// The one safe way to turn a LOCALLY-constructed Date (parseDayTagDate's "Aug 28, 2026"
// parsing, `new Date()` for "today", date arithmetic on either) into a YYYY-MM-DD string in
// THIS codebase. `d.toISOString().slice(0,10)` looks equivalent but isn't: it converts to
// UTC first, and for any timezone EAST of UTC (positive offset - including Norway, this
// app's actual user, UTC+1/+2) local midnight lands in the PREVIOUS UTC calendar day, so the
// string comes out one day early - confirmed live (picking "Fri - Aug 28" produced date
// value "2026-08-27"). Read the LOCAL date parts instead - no UTC conversion at all - so the
// string always matches the calendar day the Date object actually represents locally. Do
// NOT use this on a Date built by parsing a bare ISO 'YYYY-MM-DD' string (e.g.
// `new Date(goal.raceDate)`) - those parse as UTC midnight per spec, and toISOString()
// already round-trips them correctly regardless of timezone; running THIS helper on one of
// those would introduce the mirror-image bug for timezones WEST of UTC instead.
export function dateToYMD(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
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
    const pd = parseDayTagDate(d.tag, [w]);
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
  const year = weekYear(w);
  let endStr;
  if(/^\d+$/.test(endPart)){
    const startMonth = w.dates.split(' ')[0];
    endStr = startMonth+' '+endPart+', '+year;
  } else {
    endStr = endPart+', '+year;
  }
  let d = new Date(endStr);
  if(isNaN(d.getTime())) return null;
  // A week that genuinely crosses a real Jan 1 (e.g. "Dec 29-Jan 4") has an end month
  // earlier in the calendar than its start month, at the SAME nominal year - parsed
  // literally that reads as the end landing BEFORE the start, which can't be right for a
  // week range. That's the signal a year boundary was actually crossed, not a data error -
  // reparse the end date one year later rather than require every week to carry its own
  // separate start/end year.
  const start = parseWeekStartDate(w);
  if(start && d < start) d = new Date(endStr.replace(', '+year, ', '+(year+1)));
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
  for(let i=0;i<state.WEEKS.length;i++){
    const w = state.WEEKS[i];
    let weekFullyLogged = true;
    for(const d of w.days){
      // Race days carry their own dedicated logging flow; open days are a default rest day
      // by design (see week-view.js's 'open' card - passing with nothing logged is normal,
      // not a gap, same reasoning as findUnloggedPastSessions in coach/chat.js). Neither
      // should ever count against "fully logged" - without this, a week with an unlogged
      // open day (e.g. a rest day the runner correctly never touched) got stuck as "current"
      // forever, no matter how far real time moved past it, since this function returns
      // immediately on the first not-fully-logged week without ever reaching the date check.
      if(d.type==='race' || d.type==='open') continue;
      const log = await loadWorkoutLog(w.n, d.tag);
      if(!log || !(log.completed || log.skipped || log.swapped || log.moved)){ weekFullyLogged = false; break; }
    }
    if(!weekFullyLogged) return w.n;
    const weekEndDate = parseWeekEndDate(w);
    // A couple of weeks in this plan's real history have their own "dates" label overlap
    // the very next week's (e.g. "Sep 1-7" followed by "Sep 7-13", sharing Sep 7) - once a
    // week like that is fully logged, the shared boundary day belongs to whichever week is
    // actually STARTING there, not the one wrapping up, even though it's still earlier in
    // this array and its own label technically still covers that day. Caught live: a race
    // week stayed "current" through the evening of the day after its own end date purely
    // because the next week's label also claimed that same day.
    const nextWeekStart = state.WEEKS[i+1] && parseWeekStartDate(state.WEEKS[i+1]);
    const nextWeekAlreadyStarted = nextWeekStart && today >= nextWeekStart;
    if(weekEndDate && today <= weekEndDate && !nextWeekAlreadyStarted) return w.n;
  }
  return state.WEEKS[state.WEEKS.length-1].n;
}
