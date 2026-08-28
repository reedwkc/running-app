// @ts-nocheck
// A new, standing "is this runner overreaching or detraining" signal - deliberately kept
// independent of plan-adherence.js (which asks "is the SCHEDULE being followed") and of
// plan-override.js (which asks "what should the PLAN say"). This file only reads existing
// fatigue-adjacent trend data that's already computed and tracked elsewhere in the app
// (HR-recovery trend, aerobic decoupling trend, aerobic efficiency trend, and the
// acute:chronic training-load ratio) and combines them into one flag - no new data
// collection, just a new read of data that already exists. Named-tier classification (not
// an invented continuous formula), same house style as estimateLayoffImpact/
// importanceForGoalDistance in tier-estimates.js and plan-adherence.js.
import { computeACWR, loadTrimpHistory } from './training-load.js';
import { getEfficiencyTrend, getTrendSummary } from './tier-estimates.js';

// A single-run swing in any of these trends is normal noise (see the "supplementary
// signal, don't over-read a single session" caveat already attached to each of them
// elsewhere in the app) - this is the bar at which a trend reads as a real, meaningful
// move rather than noise. Deliberately one shared number across all three trend signals,
// not three separately-tuned ones - there's no evidence basis for treating them
// differently here.
const MEANINGFUL_TREND_PCT = 12;

// hrRecovery: pctChange>=0 is IMPROVING (more bpm drop). decoupling: pctChange<=0 is
// IMPROVING (less late-run fade). efficiency: pctChange>=0 is IMPROVING (more speed per
// heartbeat). Each returns true only when the trend has moved the WRONG way by more than
// MEANINGFUL_TREND_PCT - exactly mirroring the polarity conventions chat.js's
// generateProfileContext already uses for the same three trends (see hrRecoveryNote/
// decouplingNote/efficiencyNote there).
function isDeclining(trend, kind){
  if(!trend || trend.pctChange==null) return false;
  const magnitude = Math.abs(trend.pctChange);
  if(magnitude < MEANINGFUL_TREND_PCT) return false;
  if(kind==='decoupling') return trend.pctChange > 0; // worsening = more late-run fade
  return trend.pctChange < 0; // hrRecovery/efficiency: worsening = declining
}

function trendEvidence(label, trend, kind, unit){
  if(!trend || trend.pctChange==null) return null;
  const declining = isDeclining(trend, kind);
  const direction = kind==='decoupling'
    ? (trend.pctChange<=0 ? 'improving' : 'worsening')
    : (trend.pctChange>=0 ? 'improving' : 'declining');
  return {
    declining,
    text: label+' trend: '+direction+' by '+Math.abs(trend.pctChange).toFixed(0)+'%'+(unit?(' ('+trend.avgRecent.toFixed(1)+unit+' recent avg)'):''),
  };
}

// Returns {status: 'overreaching'|'detraining'|'normal'|'insufficient-data', evidence:[string,...], acwr, hrRecoveryTrend, decouplingTrend, efficiencyTrend}.
// 'overreaching': ACWR alone reading High is sufficient (it's the most direct, already-
// validated measure elsewhere in this app - see plan-adherence.js's hard-session-proximity
// escalation) - OR at least 2 of the 3 independent trend signals show a meaningful decline,
// requiring corroboration from multiple signals when ACWR itself isn't High so one noisy
// metric can't single-handedly license lightening a whole week.
// 'detraining': ACWR reading Low with nothing else corroborating - informational only,
// not currently wired into any gate; a rebalance shouldn't need to know "detraining" to
// act, only "overreaching" changes what's safe to prescribe.
// 'insufficient-data': every signal came back null (new runner, sparse logged history) -
// callers should skip readiness-based reasoning entirely rather than guess.
export async function computeReadinessSignal(){
  let hrRecoveryTrend = null, decouplingTrend = null, efficiencyTrend = null, acwr = null;
  try{ hrRecoveryTrend = await getTrendSummary('hrrecovery-history'); }catch(e){}
  try{ decouplingTrend = await getTrendSummary('decoupling-history'); }catch(e){}
  try{ efficiencyTrend = await getEfficiencyTrend(); }catch(e){}
  try{ acwr = computeACWR(await loadTrimpHistory()); }catch(e){}

  const hrEv = trendEvidence('HR-recovery', hrRecoveryTrend, 'hrRecovery', 'bpm');
  const decEv = trendEvidence('Aerobic decoupling', decouplingTrend, 'decoupling', '%');
  const effEv = trendEvidence('Aerobic efficiency', efficiencyTrend, 'efficiency');

  if(!hrEv && !decEv && !effEv && !acwr){
    return {status:'insufficient-data', evidence:[], acwr, hrRecoveryTrend, decouplingTrend, efficiencyTrend};
  }

  const decliningCount = [hrEv, decEv, effEv].filter(e=>e && e.declining).length;
  const evidence = [hrEv, decEv, effEv].filter(Boolean).map(e=>e.text);
  if(acwr) evidence.unshift('Acute:chronic training-load ratio: '+acwr.ratio.toFixed(2)+' ('+acwr.status+')');

  let status = 'normal';
  if((acwr && acwr.status==='High') || decliningCount>=2) status = 'overreaching';
  else if(acwr && acwr.status==='Low') status = 'detraining';

  return {status, evidence, acwr, hrRecoveryTrend, decouplingTrend, efficiencyTrend};
}
