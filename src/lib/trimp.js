// @ts-nocheck
// The exponential weighting term shared by both TRIMP variants below - factored out so
// the full-stream integral and the single-average-HR session formula use the exact same
// weighting curve instead of two hand-copied constants that could drift apart.
function trimpWeight(hrFraction){
  return 0.64*Math.exp(1.92*hrFraction);
}

// Banister-style Training Impulse: integrate 0.64*e^(1.92*HRR-fraction) over the HR
// stream. This is a fixed formula, not a judgment call - computing it directly is both
// free (no API call) and more accurate than asking an LLM to approximate a numerical
// integral through text generation.
export function computeTRIMP(streams, profile){
  const hr = streams && streams.heartrate && streams.heartrate.data;
  const time = streams && streams.time && streams.time.data;
  if(!hr || !time || hr.length < 2 || hr.length !== time.length) return null;
  const range = profile.maxHR - profile.restHR;
  if(range <= 0) return null;
  let trimp = 0;
  for(let i=1; i<hr.length; i++){
    const dtMin = (time[i]-time[i-1])/60;
    if(dtMin <= 0) continue;
    const avgHR = (hr[i]+hr[i-1])/2;
    const frac = Math.max(0, Math.min(1, (avgHR-profile.restHR)/range));
    trimp += trimpWeight(frac)*dtMin;
  }
  return Math.round(trimp*10)/10;
}

// Session-level TRIMP - Banister's original formulation (duration x weighted avg-HR-
// fraction, using ONE session-average HR rather than integrating a full HR curve). This is
// the textbook form the metric was originally defined in, not an approximation invented
// for this app - it lets any logged session with an avg HR and duration contribute to the
// acute:chronic training-load trend (see coach/training-load.js) even when it wasn't
// imported from Strava and there's no full stream to integrate over.
export function computeSessionTRIMP(avgHR, durationMin, profile){
  if(!avgHR || !durationMin || durationMin<=0 || !profile) return null;
  const range = profile.maxHR - profile.restHR;
  if(range <= 0) return null;
  const frac = Math.max(0, Math.min(1, (avgHR-profile.restHR)/range));
  return Math.round(trimpWeight(frac)*durationMin*10)/10;
}

// Aerobic decoupling (pace:HR decoupling): compares aerobic efficiency (speed per
// heartbeat) between the first and second half of a sustained effort. A well-conditioned
// aerobic engine holds efficiency roughly flat across a long run; efficiency dropping
// meaningfully in the second half is the classic within-run aerobic-fatigue/durability
// signal - distinct from and complementary to the easy-run efficiency trend elsewhere in
// this app, which only ever compares whole-run averages against each other across
// different days, never drift within a single run. Fixed formula computed directly from
// the raw stream, same reasoning as computeTRIMP above: free, deterministic, and more
// reliable than asking an LLM to eyeball a curve shape.
export function computeDecoupling(streams){
  const hr = streams && streams.heartrate && streams.heartrate.data;
  const speed = streams && streams.velocity_smooth && streams.velocity_smooth.data;
  const time = streams && streams.time && streams.time.data;
  if(!hr || !speed || !time || hr.length < 10 || hr.length !== time.length || hr.length !== speed.length) return null;
  const totalSec = time[time.length-1] - time[0];
  if(totalSec < 25*60) return null; // too short for a meaningful within-run drift read
  // Skip the first 3 minutes before splitting - HR lags effort at the start of any run,
  // and including that ramp-in would distort the first-half average independent of any
  // real aerobic-fatigue signal.
  const warmupCutoff = time[0] + 180;
  const midpoint = time[0] + (time[time.length-1]-time[0])/2;
  let firstSpeedSum=0, firstHRSum=0, firstN=0, secondSpeedSum=0, secondHRSum=0, secondN=0;
  for(let i=0; i<time.length; i++){
    if(time[i] < warmupCutoff || !hr[i] || !speed[i]) continue;
    if(time[i] < midpoint){ firstSpeedSum+=speed[i]; firstHRSum+=hr[i]; firstN++; }
    else{ secondSpeedSum+=speed[i]; secondHRSum+=hr[i]; secondN++; }
  }
  if(firstN < 5 || secondN < 5) return null;
  const efFirst = (firstSpeedSum/firstN) / (firstHRSum/firstN);
  const efSecond = (secondSpeedSum/secondN) / (secondHRSum/secondN);
  if(efFirst <= 0) return null;
  const decouplingPct = ((efFirst-efSecond)/efFirst)*100;
  return {decouplingPct: Math.round(decouplingPct*10)/10, efFirst: Math.round(efFirst*1000)/1000, efSecond: Math.round(efSecond*1000)/1000};
}

// Cadence fade: does stride rate hold up across a sustained effort, or does it visibly
// drop as fatigue sets in - a durability signal in the same spirit as decoupling above
// (first-half vs second-half comparison, same warmup-skip/duration-gate reasoning), but
// for stride rate instead of pace:HR efficiency, and previously unused: Strava's cadence
// stream was never even requested (see worker/src/strava.js) despite being free once
// added to the same streams call. Not every activity has a cadence stream (needs a
// footpod or a cadence-capable watch), hence the null guard.
export function computeCadenceFade(streams){
  const cadence = streams && streams.cadence && streams.cadence.data;
  const time = streams && streams.time && streams.time.data;
  if(!cadence || !time || cadence.length < 10 || cadence.length !== time.length) return null;
  const totalSec = time[time.length-1] - time[0];
  if(totalSec < 25*60) return null; // same "too short for a meaningful within-run drift read" as decoupling
  const warmupCutoff = time[0] + 180;
  const midpoint = time[0] + totalSec/2;
  let firstSum=0, firstN=0, secondSum=0, secondN=0;
  for(let i=0; i<time.length; i++){
    if(time[i] < warmupCutoff || !cadence[i]) continue;
    if(time[i] < midpoint){ firstSum+=cadence[i]; firstN++; }
    else{ secondSum+=cadence[i]; secondN++; }
  }
  if(firstN < 5 || secondN < 5) return null;
  const cadenceFirst = firstSum/firstN, cadenceSecond = secondSum/secondN;
  if(cadenceFirst <= 0) return null;
  const fadePct = ((cadenceFirst-cadenceSecond)/cadenceFirst)*100;
  // Doubled from Strava's one-leg steps/min to a real total steps/min reading, same
  // convention as the per-lap avgCadence computed in strava-import.js.
  return {fadePct: Math.round(fadePct*10)/10, cadenceFirst: Math.round(cadenceFirst*2), cadenceSecond: Math.round(cadenceSecond*2)};
}
