// @ts-nocheck
// Grade-adjusted pace via Minetti et al.'s energy cost of running model (Minetti AE et al.,
// "Energy cost of walking and running at extreme uphill and downhill slopes", J Appl
// Physiol 2002) - a published, validated polynomial fit for the metabolic cost of running
// (J/kg per meter of ground covered) as a function of gradient, not a formula invented for
// this app. Computed independently from the raw altitude+distance stream (same reasoning
// as computeTRIMP in trimp.js: a fixed, auditable formula applied the same way every time,
// not dependent on whatever device recorded the run or whether/when Garmin ships live GAP
// to a given watch) rather than trusting any device's own on-board GAP number.

// Validated across roughly -45% to +45% grade; the clamp exists purely as a sensor-noise
// guard (a real running grade should never legitimately reach that range), not because
// steeper grades are expected from real data.
const MINETTI_MAX_GRADE = 0.45;

// Cost of running, in J/(kg*m), at gradient i (a fraction: 0.1 = 10% grade, -0.1 = -10%).
// At i=0 this evaluates to exactly 3.6 J/kg/m, the model's flat-running baseline. The curve
// is asymmetric and non-monotonic on the downhill side by design: cost first drops below
// the flat baseline on a gentle downhill (running downhill is metabolically "free" up to a
// point), then rises again past roughly -20% as real eccentric/braking cost takes over -
// exactly the mechanism a naive linear grade correction misses, and the reason downhill GAP
// numbers should still be read with the mechanical-cost caveat in mind, not taken as a pure
// effort readout the way uphill GAP more safely can be.
function costOfRunning(gradeFraction){
  const i = Math.max(-MINETTI_MAX_GRADE, Math.min(MINETTI_MAX_GRADE, gradeFraction));
  return 155.4*Math.pow(i,5) - 30.4*Math.pow(i,4) - 43.3*Math.pow(i,3) + 46.3*Math.pow(i,2) + 19.5*i + 3.6;
}

const FLAT_COST = costOfRunning(0); // 3.6 - named for clarity at the call site below

// Converts an actual pace run at a given grade into its flat-ground metabolic equivalent -
// the pace that would demand the same energy cost per meter on flat ground. Cost of
// transport (J/kg/m) is treated as pace-independent (Minetti's own simplifying assumption,
// solid within normal training paces), so the conversion is a straight ratio: gapPaceSec =
// actualPaceSec * (flat cost / cost at this grade). Climbing (cost > flat) speeds the
// equivalent pace up; a gentle descent (cost < flat) slows it down; a steep descent (cost
// rising back toward/above flat) pulls the equivalent pace back toward the actual pace
// rather than toward "free speed", reflecting the real braking cost involved.
export function gradeAdjustedPaceSec(actualPaceSec, gradeFraction){
  if(!actualPaceSec || actualPaceSec<=0 || gradeFraction==null || !isFinite(gradeFraction)) return null;
  const cost = costOfRunning(gradeFraction);
  if(cost<=0) return null;
  return actualPaceSec * (FLAT_COST/cost);
}

// The exact inverse of gradeAdjustedPaceSec above, for the opposite real question: not
// "what did my hilly pace mean in flat terms" (after a run), but "what clock pace should I
// actually target on this grade to demand the same effort as my flat-ground target pace"
// (before/during one) - e.g. converting a plan's flat LT/VO2max pace into the real pace to
// chase on a specific hill or route. gradedPaceSec = flatPaceSec * (cost at this grade /
// flat cost) - the reciprocal ratio of gradeAdjustedPaceSec, same underlying cost model.
export function flatTargetToGradedPaceSec(flatTargetPaceSec, gradeFraction){
  if(!flatTargetPaceSec || flatTargetPaceSec<=0 || gradeFraction==null || !isFinite(gradeFraction)) return null;
  const cost = costOfRunning(gradeFraction);
  if(FLAT_COST<=0) return null;
  return flatTargetPaceSec * (cost/FLAT_COST);
}
