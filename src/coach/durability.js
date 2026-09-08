// @ts-nocheck
import { getTrendSummary } from './tier-estimates.js';

// Aerobic decoupling (efficiency-factor drift between the first and second half of a
// sustained effort) and cadence fade (stride-rate drift over the same split) are both
// already computed from real Strava stream data (lib/trimp.js) and tracked per long run
// (coach/session-trends.js -> decoupling-history / cadence-fade-history) - this file is
// the first place either signal gets synthesized into an actual "durability" read and used
// to adjust the goal projection, rather than sitting as a secondary footnote to an
// LT-pace-only "current fitness" number that silently assumes flat, unfading pace to the
// finish. Built specifically because a real half marathon showed dramatic late fade (pace
// falling off ~25s/km over the last third while HR barely moved) that the pace-only gauge
// had no way to see coming or explain after the fact.
//
// Decoupling thresholds follow the widely-used convention from endurance coaching
// (Friel/TrainingPeaks' "aerobic threshold test"): <=5% EF decoupling on a sustained
// effort is the accepted marker of a well-developed aerobic engine for that duration;
// 5-10% is a real but modest fade; >10% is a genuine durability limiter. There is no
// equally standard published threshold for cadence fade specifically, so those bands are
// a deliberately conservative, disclosed approximation (stride rate is far more resistant
// to fatigue than pace/HR in a well-conditioned runner, so even a modest drop is worth
// noting) - cadence fade is used only to corroborate/explain a read here, never to
// independently drive the adjusted time projection below (which needs a real pace-shaped
// number to adjust, and cadence fade doesn't have one).
export const DURABILITY_DECOUPLING_HEALTHY_PCT = 5;
export const DURABILITY_DECOUPLING_MODERATE_PCT = 10;
export const DURABILITY_CADENCE_FADE_HEALTHY_PCT = 2;
export const DURABILITY_CADENCE_FADE_MODERATE_PCT = 5;

// getTrendSummary's default minPoints (6) is tuned for signals fed by nearly every
// session (efficiency, TRIMP); decoupling/cadence-fade only come from long runs and races
// with reliable Strava data, a much thinner stream - 4 is enough for a first, honestly-
// low-confidence read rather than staying silent for months waiting for 6.
const DURABILITY_MIN_POINTS = 4;

export async function getDurabilitySignal(){
  const decoupling = await getTrendSummary('decoupling-history', DURABILITY_MIN_POINTS);
  const cadenceFade = await getTrendSummary('cadence-fade-history', DURABILITY_MIN_POINTS);
  if(!decoupling && !cadenceFade){
    return {classification:'insufficient-data', concerning:false, decoupling:null, cadenceFade:null};
  }
  let classification = 'good';
  if(decoupling && decoupling.avgRecent!=null){
    if(decoupling.avgRecent>DURABILITY_DECOUPLING_MODERATE_PCT) classification = 'poor';
    else if(decoupling.avgRecent>DURABILITY_DECOUPLING_HEALTHY_PCT) classification = 'moderate';
  } else {
    classification = 'insufficient-data';
  }
  // Cadence fade can only make the read WORSE than decoupling alone suggests, never
  // better - a runner whose HR:pace ratio looks fine can still be masking real mechanical
  // fatigue (the "stiff legs, loss of power" symptom is a stride/mechanics complaint
  // first, a cardiovascular one second), so a bad cadence-fade reading should never be
  // silently overridden by an otherwise-fine decoupling number.
  if(cadenceFade && cadenceFade.avgRecent!=null){
    if(cadenceFade.avgRecent>DURABILITY_CADENCE_FADE_MODERATE_PCT) classification = 'poor';
    else if(cadenceFade.avgRecent>DURABILITY_CADENCE_FADE_HEALTHY_PCT && classification==='good') classification = 'moderate';
    else if(classification==='insufficient-data') classification = cadenceFade.avgRecent>DURABILITY_CADENCE_FADE_HEALTHY_PCT ? 'moderate' : 'good';
  }
  return {classification, concerning: classification==='poor', decoupling, cadenceFade};
}

// A flat-pace projection (goal-trajectory.js's projectedTimeFromLTPace) assumes zero
// within-run fade - reasonable for a short race, optimistic for anything long enough that
// decoupling has real room to show up. This applies ONLY the excess above the healthy
// threshold (a modest, natural positive split is normal race pacing, already implicitly
// "priced in" by treating <=5% as healthy rather than penalizing from zero) to the second
// half of the goal distance. Deliberately a coarse, disclosed approximation - this app's
// long runs aren't always the same duration as the goal race, and real race-day fade
// depends on far more than one aggregate number - not a precise physiological model, the
// same "working estimate, not a lab measurement" framing already used elsewhere.
export function computeDurabilityAdjustedProjectionSec(pureProjectedSec, durabilitySignal, distanceKm){
  if(!durabilitySignal || !durabilitySignal.decoupling || pureProjectedSec==null || !distanceKm) return null;
  const pct = durabilitySignal.decoupling.avgRecent;
  if(pct==null || pct<=DURABILITY_DECOUPLING_HEALTHY_PCT) return null; // no adjustment warranted - within normal/healthy range
  const excessFraction = (pct-DURABILITY_DECOUPLING_HEALTHY_PCT)/100;
  const evenPaceSecPerKm = pureProjectedSec/distanceKm;
  const halfKm = distanceKm/2;
  const secondHalfPaceSecPerKm = evenPaceSecPerKm*(1+excessFraction);
  return Math.round(halfKm*evenPaceSecPerKm + halfKm*secondHalfPaceSecPerKm);
}

export function formatDurabilityNote(durability){
  if(!durability || durability.classification==='insufficient-data'){
    return 'Not enough long-run/race data yet to read durability (aerobic decoupling and cadence fade over distance) separately from pace.';
  }
  const parts = [];
  if(durability.decoupling && durability.decoupling.avgRecent!=null){
    parts.push(durability.decoupling.avgRecent.toFixed(1)+'% recent long-run aerobic decoupling');
  }
  if(durability.cadenceFade && durability.cadenceFade.avgRecent!=null){
    parts.push(durability.cadenceFade.avgRecent.toFixed(1)+'% recent cadence fade');
  }
  const label = durability.classification==='good' ? 'holding up well over distance'
    : durability.classification==='moderate' ? 'showing a real but moderate fade over distance'
    : 'showing a genuine durability limiter - fading well before pace/fitness alone would predict';
  return 'Durability: '+(parts.length?parts.join(', ')+' - ':'')+label+'.';
}
