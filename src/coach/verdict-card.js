// @ts-nocheck
import { dateToYMD } from '../lib/dates.js';

// Which coach verdicts get to be the "Latest coach update" card, and in what order.
//
// The card used to show whatever the coach said LAST, so any event at all could take it
// over. Reported live: logging today's run and then skipping yesterday's session replaced
// the verdict on the run - the thing that actually happened, and happened most recently -
// with commentary on a session that never took place. A Garmin save or a daily metrics check
// could do the same. The card now tracks performed workouts only, newest by when the workout
// was DONE rather than when it was logged, so backfilling an older session can't push a
// newer one off the card either. Everything else still reaches the chat, where its
// suggested plan change keeps its own Draft button.
export const CARD_VERDICT_KINDS = ['workout', 'freeworkout'];

export function isCardVerdict(v){
  return !!v && CARD_VERDICT_KINDS.includes(v.kind) && !!v.text;
}

// Calendar day, not the exact timestamp: a workout logged without a real start time is
// stamped at noon as a placeholder (saveWorkoutLog, saveFreeWorkout), so a time-of-day
// comparison between two sessions on the same day would be comparing a guess. Within one
// day, the most recently logged wins instead. Verdicts saved before eventDate existed fall
// back to when they were written, which is the ordering they always had.
function eventDay(v){
  const d = new Date(v.eventDate || v.date);
  return isNaN(d.getTime()) ? '' : dateToYMD(d);
}

// Newest first. One entry per session - re-saving a session (a corrected Strava import, an
// edited log) replaces its verdict rather than leaving the stale read behind as the
// "previous update", which is what the old push-everything history did.
export function orderCardVerdicts(verdicts, limit){
  const bySession = new Map();
  const unkeyed = [];
  (verdicts||[]).filter(isCardVerdict).forEach(v=>{
    if(!v.sessionKey){ unkeyed.push(v); return; }
    const prev = bySession.get(v.sessionKey);
    if(!prev || String(v.date||'') > String(prev.date||'')) bySession.set(v.sessionKey, v);
  });
  const ordered = unkeyed.concat([...bySession.values()]).sort((a,b)=>{
    const byDay = eventDay(b).localeCompare(eventDay(a));
    return byDay!==0 ? byDay : String(b.date||'').localeCompare(String(a.date||''));
  });
  return limit ? ordered.slice(0, limit) : ordered;
}
