// @ts-nocheck
// Two ways of finding out what a session had LEFT, which is the one thing a pace-led session
// cannot tell you on its own.
//
// The problem, stated by the runner: "if I run them at the prescribed pace and all good, how
// does the coach know if I could have performed even faster? Or if it was actually too hard?"
// He is right, and the honest answer was that the app could only measure what the pace COST
// (heart rate against the zone ceiling), never what was in reserve. Everything else waited on
// a time trial months away.
//
//   1. RESERVE - one question after a quality session: could you have done another rep at
//      that pace? Asked about capacity rather than sensation, which is what separates it from
//      RPE. Tracked at a fixed prescribed pace over weeks, a rising reserve is a fitness gain
//      that needs no test to detect, and a runner repeatedly easing off is a target set too
//      fast - the two directions of the question that could not be answered before.
//
//   2. PROBE - every fourth threshold session, the final rep is run free: the best pace that
//      can still be held under control. A repeatable ceiling measurement every few weeks
//      instead of every few months, bought for one rep's worth of extra fatigue, at the end
//      of a session whose training stimulus is already banked.
//
// Both are deliberately dumb to compute and honest about their limits: they are subjective
// and single-session respectively, so they inform the estimate rather than setting it.

// Ordinal on purpose: the numbers are what make a trend line meaningful, and the order
// (eased off < at the limit < one more < two or more) is the whole signal.
export const RESERVE_OPTIONS = [
  {value:'eased',  n:-1, label:'I had to ease off - couldn\'t hold the pace'},
  {value:'limit',  n:0,  label:'That was exactly my limit - no more reps'},
  {value:'one',    n:1,  label:'I could have done one more'},
  {value:'twoPlus',n:2,  label:'I could have done two or more'},
];

export function reserveNumeric(value){
  const opt = RESERVE_OPTIONS.find(o=>o.value===value);
  return opt ? opt.n : null;
}

export function describeReserve(value){
  const opt = RESERVE_OPTIONS.find(o=>o.value===value);
  return opt ? opt.label : '';
}

// What a series of reserve answers at a prescribed pace actually says. Deliberately
// conservative: it takes at least three sessions to say anything at all, and it reports a
// direction rather than a pace adjustment - the size of any change belongs to the evidence
// that can carry it (HR, probe reps, time trials), not to a four-point subjective scale.
export const RESERVE_MIN_POINTS = 3;

export function interpretReserveTrend(points){
  const vals = (points||[]).map(p=>p && p.value).filter(v=>typeof v==='number');
  if(vals.length < RESERVE_MIN_POINTS) return {status:'insufficient', note:'Not enough sessions yet to read a reserve trend - it takes '+RESERVE_MIN_POINTS+'.'};
  const recent = vals.slice(-3);
  const avg = recent.reduce((a,b)=>a+b,0)/recent.length;
  const earlier = vals.slice(0,-3);
  const earlierAvg = earlier.length ? earlier.reduce((a,b)=>a+b,0)/earlier.length : null;
  if(recent.every(v=>v<0)) return {status:'overreaching', avg, earlierAvg, note:'Every one of the last '+recent.length+' quality sessions ended with pace having to be eased - that is a target set too fast, or arriving under-recovered, not a bad patch.'};
  if(avg >= 1.5) return {status:'undershooting', avg, earlierAvg, note:'The last few quality sessions finished with two or more reps still in reserve - the prescribed pace is leaving real capacity unused.'};
  if(earlierAvg!=null && avg - earlierAvg >= 1) return {status:'improving', avg, earlierAvg, note:'Reserve at the same prescribed paces is rising - the same work is costing less than it did.'};
  if(earlierAvg!=null && earlierAvg - avg >= 1) return {status:'declining', avg, earlierAvg, note:'Reserve at the same prescribed paces is falling - the same work is costing more than it did, worth watching against recovery and load.'};
  return {status:'steady', avg, earlierAvg, note:'Reserve is holding steady at the prescribed paces.'};
}

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

export function isProbeSession(weeks, weekN, dayTag, opts){
  return probeSessions(weeks, opts).some(p=>p.weekN===weekN && p.dayTag===dayTag);
}

export function nextProbeSession(weeks, opts){
  const o = opts || {};
  const after = o.afterWeekN;
  const all = probeSessions(weeks, o);
  return all.find(p => after==null || p.weekN >= after) || null;
}
