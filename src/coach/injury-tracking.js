// @ts-nocheck
// Structured ache/pain/injury logging and evidence-based pattern recognition - previously
// "injury history" existed only as one hardcoded, static sentence in the coach's background
// context (chat.js's generateProfileContext), never a real, dated, evolving record. This is
// the first place that actually captures WHEN something started hurting and looks backward
// at what training preceded it, so the coach can eventually say something grounded ("your
// last two flare-ups both followed a training-load spike like the one you're in right now")
// instead of a static bio note that never updates.
//
// Deliberately includes aches/pains that resolve on their own, not just events that forced a
// real training change - an ache that quietly went away is still real evidence about what
// precedes a flare-up, and waiting only for confirmed injuries (which are rarer, and a
// runner obviously wants to keep rare) would starve this of the data it needs to ever say
// anything useful. severity distinguishes them (ache < pain < injury) so an aggregate
// pattern read can still weigh a forced-stop injury more heavily than a twinge that passed.
import { dateToYMD } from '../lib/dates.js';
import { readJsonArray } from '../lib/data-store.js';
import { saveWithRetry } from '../lib/storage.js';
import { computeACWR, loadTrimpHistory } from './training-load.js';
import { evaluateWatchdogZone } from './goal-trajectory.js';

const INJURY_HISTORY_KEY = 'injury-history';

// Same "one occurrence isn't a pattern" bar every other detector in this app already holds
// to (achievability/durability watchdogs, detectConsistentShortfalls' 3-session minimum) -
// a single ache proves nothing about what causes them.
export const MIN_EVENTS_FOR_PATTERN = 2;
export const SEVERITY_ORDER = {ache:0, pain:1, injury:2};

export async function loadInjuryHistory(){
  const read = await readJsonArray(INJURY_HISTORY_KEY);
  return read.ok ? read.value : [];
}

// sessionId, when given, dedupes the same logged workout re-saving its pain field (e.g. an
// edited log) instead of appending a second entry for the same real event - same convention
// appendTrendPoint already uses elsewhere in this app.
export async function logInjuryEvent({date, severity, bodyPart, note, weekN, dayTag, sessionId}){
  let hist = await loadInjuryHistory();
  const entry = {
    date: date || dateToYMD(new Date()),
    severity: SEVERITY_ORDER[severity]!=null ? severity : 'ache',
    bodyPart: (bodyPart||'').trim(),
    note: (note||'').trim(),
    weekN: weekN!=null ? weekN : null,
    dayTag: dayTag || null,
    sessionId: sessionId || null,
    loggedAt: new Date().toISOString(),
  };
  if(sessionId) hist = hist.filter(h=>h.sessionId!==sessionId);
  hist.push(entry);
  hist.sort((a,b)=> a.date<b.date ? -1 : a.date>b.date ? 1 : 0);
  await saveWithRetry(INJURY_HISTORY_KEY, hist, false);
  return entry;
}

// Reconstructs the one piece of this signature with genuine sports-science backing for
// injury risk specifically (Gabbett, "The training-injury prevention paradox", Br J Sports
// Med 2016) - Acute:Chronic Workload Ratio AS OF the date something first started hurting,
// not today. computeACWR already accepts a historical asOfDateStr for exactly this kind of
// backward read (see training-load.js) - reused as-is, not reimplemented.
export async function computePreEventSignature(eventDateStr){
  const trimp = await loadTrimpHistory();
  const acwr = computeACWR(trimp, eventDateStr);
  return {eventDateStr, acwr};
}

// Aggregates precursor signatures across every logged event to find what's actually COMMON -
// requires MIN_EVENTS_FOR_PATTERN with real, sufficient training history (computeACWR itself
// returns null under ~14 days of logged history) before claiming anything. Weights by
// severity (an injury counts more than a passing ache) rather than a flat headcount, so one
// real forced-stop injury isn't diluted to the same weight as three minor twinges.
export async function analyzeInjuryPatterns(){
  const history = await loadInjuryHistory();
  if(history.length < MIN_EVENTS_FOR_PATTERN){
    return {classification:'insufficient-data', count:history.length, needed:MIN_EVENTS_FOR_PATTERN};
  }
  const signatures = await Promise.all(history.map(async e => Object.assign({severity:e.severity}, await computePreEventSignature(e.date))));
  const withACWR = signatures.filter(s=>s.acwr && s.acwr.ratio!=null);
  if(withACWR.length < MIN_EVENTS_FOR_PATTERN){
    return {classification:'insufficient-data', count:history.length, withACWRCount:withACWR.length, needed:MIN_EVENTS_FOR_PATTERN};
  }
  const weight = s => 1 + SEVERITY_ORDER[s.severity]; // ache=1, pain=2, injury=3
  const totalWeight = withACWR.reduce((s,x)=>s+weight(x),0);
  const highACWRWeight = withACWR.filter(s=>s.acwr.status==='High').reduce((s,x)=>s+weight(x),0);
  const avgRatio = withACWR.reduce((s,x)=>s+x.acwr.ratio,0)/withACWR.length;
  return {
    classification: 'pattern-available',
    count: history.length,
    withACWRCount: withACWR.length,
    highACWRCount: withACWR.filter(s=>s.acwr.status==='High').length,
    avgRatioAtEvent: Math.round(avgRatio*100)/100,
    // A real, learned finding worth surfacing only when the (severity-weighted) MAJORITY of
    // events share it - not from a single outlier event among several.
    highACWRIsCommonPrecursor: highACWRWeight >= totalWeight*0.5,
  };
}

// Compares CURRENT training load against the learned pattern - only meaningful once
// analyzeInjuryPatterns has found a real, majority-shared precursor to compare against.
export async function checkCurrentInjuryRiskPattern(){
  const pattern = await analyzeInjuryPatterns();
  if(pattern.classification!=='pattern-available' || !pattern.highACWRIsCommonPrecursor) return null;
  const trimp = await loadTrimpHistory();
  const currentACWR = computeACWR(trimp);
  if(!currentACWR || currentACWR.status!=='High') return null;
  return {
    pattern, currentACWR,
    note: pattern.highACWRCount+' of '+pattern.withACWRCount+' logged aches/pains/injuries with enough training history to check happened while your acute:chronic training-load ratio was elevated (High) - your current ratio ('+currentACWR.ratio+') is High right now too, the same pattern.',
  };
}

const INJURY_RISK_EPISODES_KEY = 'injury-risk-warning-episodes';

// The post-workout watchdog for a real, evidence-based injury-risk match - same
// deterministic, confirm-gated treatment as the achievability/durability watchdogs
// (evaluateWatchdogZone, goal-trajectory.js), so this doesn't cry wolf on the first
// coincidental High-ACWR reading, only once it's confirmed a second time. Not per-goal-zone
// (injury risk isn't tied to a specific race goal) - reuses the same confirm/reshow
// mechanism with a single fixed episode key instead.
export async function computeInjuryRiskWarnings(){
  try{
    let episodes = {};
    try{ const r = await window.storage.get(INJURY_RISK_EPISODES_KEY, false); if(r) episodes = JSON.parse(r.value); }catch(e){}
    const now = Date.now();
    const risk = await checkCurrentInjuryRiskPattern();
    const result = evaluateWatchdogZone(episodes, 'injury-risk', !!risk, risk ? risk.currentACWR.status : null, now);
    if(result.changed){
      try{ await saveWithRetry(INJURY_RISK_EPISODES_KEY, episodes, false); }catch(e){}
    }
    return result.show && risk ? [risk] : [];
  }catch(e){ console.error('computeInjuryRiskWarnings failed', e); return []; }
}
