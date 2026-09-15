// @ts-nocheck
// Finding out what a session had LEFT, which is the one thing a pace-led session cannot tell
// you on its own.
//
// The problem, stated by the runner: "if I run them at the prescribed pace and all good, how
// does the coach know if I could have performed even faster? Or if it was actually too hard?"
// He was right, and the honest answer was that the app could only measure what the pace COST
// (heart rate against the zone ceiling), never what was in reserve. Everything else waited on
// a time trial months away.
//
// The PROBE answers it without asking anything: every fourth threshold session, the final rep
// is run free - the fastest pace that could still have been repeated. A ceiling measurement
// every few weeks instead of every few months, bought for one rep's worth of extra fatigue at
// the end of a session whose stimulus is already banked, and read straight off the last work
// lap of the Strava import.
//
// A subjective version of this shipped alongside it for one day - a four-way "could you have
// done another rep?" question on the log form - and was removed the same day on the only
// argument that mattered: "it all has to be automatic and I don't want to think." It was the
// only thing here that asked the runner to stop and judge something. Note what was NOT done in
// its place: inferring a reserve figure from heart rate. This plan runs threshold at mid-zone
// HR BY DESIGN, so mid-zone HR at the prescribed pace is correct execution and not evidence of
// spare capacity - deriving "you had two reps left" from it would manufacture exactly the
// false signal the rest of this app has been fixed repeatedly to avoid. The measured probe
// says what a session had left; the HR-overshoot engine already says when one cost too much;
// neither needs an opinion.
//
// Every Nth threshold session gets a free final rep. Counted over the threshold sessions the
// block actually contains rather than by week number, so it stays every-fourth regardless of
// how the weeks are shaped, and it survives the plan being rebuilt around it.
export const PROBE_EVERY = 4;

// A probe never lands on a cutback or race week. Those weeks exist to shed load, and a
// maximal rep is the exact opposite of what they are for - the schedule simply carries the
// probe to the next eligible session instead.
function probeEligibleWeek(week){
  if(!week) return false;
  if(week.cutback) return false;
  if((week.days||[]).some(d=>d.type==='race')) return false;
  return true;
}

// "The last rep, run free" needs there to BE reps. A continuous tempo and a time trial both
// come through as a single-rep threshold session, and neither can carry a probe: the tempo
// has no last rep to free, and a time trial is already maximal from the gun - bolting a
// ceiling probe onto a ceiling test would just be asking the same question twice, badly.
export function probeEligibleDay(day){
  if(!day || day.type!=='threshold') return false;
  if(/time trial/i.test(day.name||'')) return false;
  const reps = day.data && day.data.main && day.data.main.reps;
  return typeof reps === 'number' && reps >= 2;
}

// Returns the {weekN, dayTag} of every probe session in the block, in order.
export function probeSessions(weeks, opts){
  const o = opts || {};
  const blockStartN = o.blockStartN;
  const eligible = [];
  (weeks||[])
    .filter(w => w && Array.isArray(w.days) && (!blockStartN || w.n >= blockStartN))
    .sort((a,b)=>a.n-b.n)
    .forEach(w=>{
      if(!probeEligibleWeek(w)) return;
      w.days.filter(probeEligibleDay).forEach(d=>eligible.push({weekN:w.n, dayTag:d.tag, name:d.name}));
    });
  // The Nth, 2Nth, ... session in that sequence. Starting at PROBE_EVERY-1 (the 4th session,
  // zero-indexed) rather than the very first: a block's opening threshold sessions are for
  // establishing the pace, not testing its ceiling.
  return eligible.filter((_, i) => (i+1) % PROBE_EVERY === 0);
}

// The free rep IS the last work lap, so the watch already knows the answer - nobody should
// have to read a pace off a screen and retype it. Grade-adjusted pace wins where the lap has
// one: a ceiling read on a hilly route means nothing against a flat target otherwise, the
// same rule the Tier evidence already follows. avgPaceSec (full precision) over re-parsing a
// display label, for the same reason the efficiency trend uses it.
export function probePaceFromImport(stravaImport){
  if(!stravaImport || !Array.isArray(stravaImport.laps)) return null;
  if(stravaImport.lapsReliable === false) return null; // auto-splits aren't reps
  const workLaps = stravaImport.laps.filter(l=>l && l.role==='work' && l.avgPaceSec);
  const last = workLaps[workLaps.length-1];
  if(!last) return null;
  const graded = last.gapPaceSec!=null;
  return {
    paceSec: Math.round(graded ? last.gapPaceSec : last.avgPaceSec),
    graded,
    avgHR: last.avgHR!=null ? last.avgHR : null,
    paceSource: last.paceSource || null,
    repCount: workLaps.length,
  };
}

// What the app uses, in priority order: a pace typed by hand always wins (it is the runner
// correcting the machine), otherwise whatever the import read.
export function resolveProbePace(obj){
  if(!obj) return null;
  const typed = obj.probePace ? String(obj.probePace).match(/(\d+):(\d+)/) : null;
  if(typed) return {paceSec: parseInt(typed[1])*60+parseInt(typed[2]), source:'typed', graded:false, avgHR:null};
  const fromImport = probePaceFromImport(obj.stravaImport);
  if(fromImport) return Object.assign({source:'import'}, fromImport);
  return null;
}

export function isProbeSession(weeks, weekN, dayTag, opts){
  return probeSessions(weeks, opts).some(p=>p.weekN===weekN && p.dayTag===dayTag);
}

export function nextProbeSession(weeks, opts){
  const o = opts || {};
  const after = o.afterWeekN;
  const all = probeSessions(weeks, o);
  return all.find(p => after==null || p.weekN >= after) || null;
}
