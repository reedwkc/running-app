// @ts-nocheck
// Curated, William-reviewed training-methodology reference (signed off 2026-08-15).
// Used two ways: `promptSummary` is the compact, LLM-facing version folded into both the
// routine coach context (generateProfileContext, so everyday replies correctly describe
// whichever methodology is currently active) and the plan-rebuild generation prompt
// (requestPlanOverride, where the full set is offered so the model can pick and cite one).
// `fullText` is the longer version this file's content was reviewed against - kept here
// verbatim as the source of truth, not just prompt-engineering scratch.
export const METHODOLOGIES = {
  'norwegian-subthreshold': {
    id: 'norwegian-subthreshold',
    name: 'Norwegian sub-threshold / double-threshold',
    tagline: 'This app\'s current, implicit method - deliberately below true LT, not at it.',
    bestFor: 'HM/10K race-build with high weekly frequency of quality work.',
    corePrinciples: 'Organizes the week around two (sometimes more) sessions per week held at "sub-threshold" intensity - deliberately just below the second lactate turnpoint (roughly the pace/HR a well-trained runner could sustain for ~60-70 minutes) rather than at true maximal lactate steady state. Running sub- rather than at-threshold allows much higher weekly volume of quality work with lower cumulative fatigue and injury risk, since the sessions don\'t require the same recovery cost as true threshold or VO2max work.',
    sessionStructure: '2 threshold-type sessions/week (one shorter, one longer), 1 VO2max or race-opener session in some weeks, 1 long run (sometimes with a goal-pace finish segment), remainder easy.',
    normalFlexibility: 'Rep count/distance and recovery interval length flex week to week (progression, taper, post-race deload) without changing the underlying method; VO2max sessions can substitute for the second threshold day in build/peak weeks.',
    notNormalDeviation: 'Running threshold reps meaningfully faster than measured LT pace (defeats the "sub" in sub-threshold - without a lactate meter there\'s no way to confirm it\'s still sustainable); dropping below one genuine quality session per week (loses the method\'s core stimulus).',
    promptSummary: 'Norwegian sub-threshold: two weekly quality sessions held deliberately below true LT pace (not at it), high sub-threshold volume at low fatigue cost per session. This app\'s implementation: pace pinned exactly to measured LT (HR-based, no lactate meter), HR held mid-zone rather than pinned at the ceiling. Best for HM/10K race-build.',
    fullText: 'Popularized by Norwegian middle/long-distance training (Ingebrigtsen brothers, Sondre Nordstad Moen, and formalized in academic work by Marius Tjelta and colleagues), it typically pairs deliberately sub-threshold quality work with low overall intensity elsewhere in the week (easy running stays genuinely easy) and relies on lactate measurement in its "pure" form to keep sessions honestly sub-threshold. This app\'s implementation is a deliberate adaptation: with no lactate meter, pace is pinned to measured LT pace exactly and HR (held mid-zone, not pinned to the ceiling) governs actual effort.',
  },
  'pfitzinger-lt': {
    id: 'pfitzinger-lt',
    name: 'Pfitzinger lactate-threshold + medium-long-run',
    tagline: 'True LT-pace tempo work plus frequent medium-long runs, trading frequency for intensity.',
    bestFor: 'HM/marathon race-build, especially where longer sustained tempo efforts suit the runner better than short reps.',
    corePrinciples: 'Built around Pete Pfitzinger\'s marathon/half-marathon plans, which emphasize (a) lactate-threshold running as continuous or long-interval tempo efforts (e.g. 20-40 minute continuous tempo, or fewer/longer reps than the Norwegian approach\'s short reps) at genuine LT pace, and (b) "medium-long runs" - runs longer than a typical easy day (commonly 14-18km) run at moderate/steady effort, used more frequently than in many other plans to build durability without the full recovery cost of a true long run. Threshold pace here is typically run closer to true LT (not deliberately sub-threshold), trading session frequency for effort intensity per session.',
    sessionStructure: '1 genuine threshold session/week (continuous tempo or long reps), 1-2 medium-long runs, 1 traditional long run (sometimes with race-pace segments), VO2max/speed work concentrated in specific mesocycles rather than every week.',
    normalFlexibility: 'Tempo-run duration and medium-long-run distance progress through the training block; VO2max blocks can be added/removed by phase.',
    notNormalDeviation: 'Running tempo efforts meaningfully above true LT pace (this method has less HR/pace safety margin than sub-threshold work, so overshooting carries more real risk of overreaching); replacing medium-long runs with easy runs removes a load-bearing part of the method\'s durability stimulus.',
    promptSummary: 'Pfitzinger LT + medium-long-run: one genuine threshold session/week at true LT pace (continuous tempo or long reps, not deliberately sub-threshold) plus frequent medium-long runs (14-18km steady) for durability. Trades quality-session frequency for per-session intensity vs. the Norwegian method. Best for HM/marathon build.',
    fullText: 'Threshold pace here is typically run closer to true LT (not deliberately sub-threshold), since the volume of quality work is lower than the Norwegian approach.',
  },
  'polarized-8020': {
    id: 'polarized-8020',
    name: 'Polarized 80/20',
    tagline: '~80% genuinely easy, ~20% hard, minimal time in the grey zone between.',
    bestFor: 'Maintenance/off-season, or an alternative race-build philosophy; well-suited to lower weekly volume or when consistency matters more than peak-specificity.',
    corePrinciples: 'Grounded in Stephen Seiler\'s research on elite endurance athletes\' actual training-intensity distributions, which found roughly 80% of training time at low intensity (well below the first ventilatory/lactate threshold - genuinely easy, not "moderate") and roughly 20% at high intensity (at or above the second threshold), with deliberately little time spent in the "moderate" zone in between (the "grey zone" that produces high fatigue for comparatively little adaptive benefit). This is a distribution principle rather than a fixed weekly session template - it constrains how much hard running happens, not exactly what shape it takes.',
    sessionStructure: 'The large majority of weekly volume is truly easy running (genuinely conversational, not just "not all-out"); 1-2 sessions/week concentrated at high intensity (threshold, VO2max intervals, or hill repeats depending on goal); minimal deliberate moderate-intensity running.',
    normalFlexibility: 'The specific hard-session format (long threshold reps vs. VO2max intervals vs. hills) can vary by week/goal as long as the 80/20 time-in-zone split roughly holds; total volume can scale up or down for maintenance vs. build without changing the method.',
    notNormalDeviation: 'Easy days creeping into moderate effort (the single most common way this method quietly fails in practice - "easy" has to stay genuinely easy for the 80% to do its job); accumulating several hard sessions in a row without the low-intensity majority to support them.',
    promptSummary: 'Polarized 80/20 (Seiler): ~80% of volume genuinely easy, ~20% hard, minimal time in the moderate "grey zone" between. A distribution principle, not a fixed session template - the hard-session format can vary as long as the split holds. Best for maintenance/off-season or lower weekly volume.',
    fullText: 'The most common practical failure mode is easy days creeping into moderate effort - "easy" has to stay genuinely easy for the 80% to do its job.',
  },
  'lydiard-base': {
    id: 'lydiard-base',
    name: 'Lydiard base-building',
    tagline: 'Aerobic-base-first phasing - the natural fit for "hold fitness, no near-term race."',
    bestFor: 'Off-season/maintenance, or the aerobic-base phase preceding a future race build.',
    corePrinciples: 'Arthur Lydiard\'s foundational approach (built for the Snell/Halberg era, still the conceptual root of most modern periodized distance training), organized as sequential phases rather than a fixed weekly template - a substantial aerobic base phase of predominantly easy-to-steady mileage (building maximal sustainable aerobic capacity and mitochondrial/capillary adaptation before any sharpening work), followed only later by hill/strength phases and finally anaerobic/race-sharpening work close to competition. Aerobic fitness is the foundation everything else is built on, and it degrades relatively slowly if genuinely maintained (steady volume, mostly easy) even without race-specific sharpening.',
    sessionStructure: 'Maintenance adaptation (not the full classical macrocycle): consistent moderate-to-high weekly easy/steady mileage as the backbone, occasional strides or a modest tempo/hill session to keep some leg speed and mechanical sharpness rather than losing it entirely, no dedicated race-specific interval work since there\'s no near-term race to sharpen for.',
    normalFlexibility: 'Total weekly volume can flex with life/treadmill constraints without breaking the method, since the method\'s core claim is about consistency of easy aerobic volume rather than a specific number; occasional strides/light hill work can be added or dropped week to week.',
    notNormalDeviation: 'Letting "maintenance" drift into either genuine detraining (volume dropping enough that aerobic fitness actually erodes, generally understood to begin within roughly 1-2 weeks of a real training gap and progressing from there) or into ad-hoc hard efforts with no aerobic base underneath them (reintroducing race-intensity work without the base that makes it safe).',
    promptSummary: 'Lydiard base-building: a long aerobic-base phase of predominantly easy/steady mileage, on the premise that aerobic fitness is the foundation and degrades slowly if genuinely maintained. Maintenance adaptation: consistent easy/steady volume as the backbone, occasional strides/light hill work for sharpness, no race-specific interval work absent a near-term race. Best for winter/treadmill maintenance with no upcoming race.',
    fullText: 'The core idea directly relevant to a maintenance phase: aerobic fitness is the foundation everything else is built on, and it degrades relatively slowly if genuinely maintained even without race-specific sharpening - making it a natural fit for "hold fitness, don\'t chase a race clock" periods.',
  },
};

export function getMethodology(id){
  return METHODOLOGIES[id] || METHODOLOGIES['norwegian-subthreshold'];
}

// Compact reference block for the plan-rebuild generation prompt - all four, so the model
// can weigh and commit to one (citing methodology + methodologyRationale in its output)
// rather than being told which one to use.
export function buildMethodologyReferenceText(){
  return Object.values(METHODOLOGIES).map(m=>
    m.id+' ("'+m.name+'"): '+m.promptSummary+' Best for: '+m.bestFor+' Normal flexibility: '+m.normalFlexibility+' NOT normal (flag, don\'t propose): '+m.notNormalDeviation
  ).join('\n');
}
