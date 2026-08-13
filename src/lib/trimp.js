// @ts-nocheck
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
    trimp += 0.64*Math.exp(1.92*frac)*dtMin;
  }
  return Math.round(trimp*10)/10;
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
