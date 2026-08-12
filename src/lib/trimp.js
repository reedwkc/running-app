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
