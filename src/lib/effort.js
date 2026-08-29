// @ts-nocheck
// Classifies the ACTUAL physiological effort a session represents, from its own logged/
// Strava data - deliberately independent of what the plan expected that day to be, so a
// free or swapped workout can feed the same downstream trend/tier models a normally-planned
// session of that real effort would, instead of being judged (or not judged at all) by a
// label that no longer describes what actually happened. "The plan is a guideline, what I do
// is my own decision, and everything should get the same amount of high-quality analysis
// after reading the type of workout from the Strava import" (2026-08-29) - this is the one
// shared classifier both the trend-feeding pipeline (coach/session-trends.js) and Tier 2/3
// qualification (coach/chat.js) use for anything that didn't necessarily happen exactly as
// planned. A plain, unmodified completion of its own planned day still uses the plan's own
// type directly (unchanged, already correct) - this only applies where "what was scheduled"
// and "what actually happened" can diverge.
//
// Bands are relative to LTHR (profile.lthr), the same anchor every zone pace in this app is
// already built around - approximate by nature (a single HR reading is a rough proxy for a
// real physiological zone, not a lab test), same epistemic honesty this app already applies
// to its VO2max/efficiency estimates elsewhere. 'long' only applies within the easy-or-below
// HR range - a genuinely hard, long effort (e.g. a marathon-pace simulation) is threshold/
// vo2max evidence first, not a decoupling-trend candidate, since decoupling is specifically
// about aerobic drift at low-to-moderate steady effort, not a hard sustained push.
const LONG_DURATION_MIN = 75;
const LONG_DISTANCE_KM = 14;

// Returns 'vo2max' | 'threshold' | 'long' | 'subthreshold' | 'easy' | null (null = genuinely
// not enough data to say anything - no HR evidence at all AND not long enough to call 'long'
// on duration alone; callers should fall back to the planned day's type, if any, in that case).
export function classifyActualEffort(obj, profile){
  if(!obj || !profile || profile.lthr==null) return null;
  const lthr = profile.lthr;
  const laps = (obj.stravaImport && obj.stravaImport.lapsReliable && Array.isArray(obj.stravaImport.laps)) ? obj.stravaImport.laps : [];
  const workLaps = laps.filter(l=>l.role==='work' && l.avgHR!=null);
  // The single hardest work lap, not an average across laps - one genuinely hard interval
  // in an otherwise easy session is real threshold/vo2max evidence for THAT effort, and
  // averaging it away with easier laps would wrongly wash it out.
  const hardestWorkHR = workLaps.length ? Math.max(...workLaps.map(l=>l.avgHR)) : (Number.isFinite(parseFloat(obj.avgHR)) ? parseFloat(obj.avgHR) : null);
  const durMin = parseFloat(obj.actualDur)||0;
  const distKm = parseFloat(obj.actualDist)||0;
  const isLongDuration = durMin>=LONG_DURATION_MIN || distKm>=LONG_DISTANCE_KM;
  if(hardestWorkHR==null) return isLongDuration ? 'long' : null;
  if(hardestWorkHR >= lthr+6) return 'vo2max';
  if(hardestWorkHR >= lthr-8) return 'threshold';
  if(isLongDuration) return 'long';
  if(hardestWorkHR >= lthr-18) return 'subthreshold';
  return 'easy';
}
