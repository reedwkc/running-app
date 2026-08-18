// @ts-nocheck
// Coach-driven plan rebuild - the propose/validate/apply/revert pipeline, deliberately
// modeled on tier-estimates.js's TIER2/3 ESTIMATE pattern (clamp -> snapshot -> save ->
// inline Apply/revert card) but adapted for a much bigger, higher-stakes payload: a plan
// change is never auto-applied (tier estimates save optimistically, this doesn't), and
// revert is a bounded history STACK rather than a single -previous slot, since plan edits
// are rarer and bigger than tier nudges and a single slot would make a two-steps-back
// correction impossible.
import { state } from '../state.js';
import { fetchCoachReply, renderVerdictCard } from './chat.js';
import { computeGoalProgress, computeVO2maxPaceSec } from './goal-trajectory.js';
import { buildMethodologyReferenceText } from './methodology-reference.js';
import { getBestFitnessLTPace, getDaysSinceLastActivity, getEfficiencyTrend, getTrendSummary, loadTierEstimate } from './tier-estimates.js';
import { applyPlanOverrides, buildWeeks, computeWeekPlannedKm, computeZones } from '../data/plan.js';
import { defaultGoalConfig, loadGoalConfig, saveGoalConfig } from '../data/goal-config.js';
import { parseDayTagDate } from '../lib/dates.js';
import { fmtPace, timeAgo } from '../lib/format.js';
import { notifyError } from '../lib/notify.js';
import { saveWithRetry } from '../lib/storage.js';
import { sleep } from '../lib/utils.js';
import { toggleChat } from '../ui/chat-panel.js';
import { renderCurrentWeek, renderNav } from '../ui/nav.js';
import { loadWorkoutLog } from '../ui/week-view.js';

const KNOWN_DAY_TYPES = ['easy', 'threshold', 'vo2max', 'long', 'race'];
const LONG_RUN_SHARE_WARN_PCT = 0.30;
const WEEKLY_OVERLOAD_WARN_PCT = 10.5;

// Deterministic, "bound don't block" checks - mirrors clampTierEstimate's philosophy.
// Only structurally-invalid input is a hard error (blocks Apply); everything else is a
// judgment call the runner should make themselves, surfaced as a warning on the card.
export async function validatePlanOverride(currentWeeks, proposed){
  const errors = [];
  const warnings = [];
  if(!proposed || typeof proposed!=='object' || !Array.isArray(proposed.weeks)){
    errors.push('The proposal is missing a valid "weeks" array.');
    return {errors, warnings};
  }
  if(proposed.truncateAfter!=null && typeof proposed.truncateAfter!=='number'){
    errors.push('"truncateAfter" must be a week number.');
  }
  if(proposed.goalConfigPatch!=null && typeof proposed.goalConfigPatch!=='object'){
    errors.push('"goalConfigPatch" must be an object.');
  }
  if(proposed.goalConfigPatch && proposed.goalConfigPatch.activeGoals!=null){
    if(!Array.isArray(proposed.goalConfigPatch.activeGoals)){
      errors.push('"goalConfigPatch.activeGoals" must be an array.');
    } else {
      // goalId must stay stable for an existing goal, even when its target changes - the
      // plan's own race day carries the SAME goalId (see plan.js's goalId fields) to link
      // it back to this goal-config entry; renaming the id here (e.g. because the model
      // baked the new target time into the id, "hm-sub135" -> "hm-sub132") orphans that
      // link and silently breaks goal-trajectory tracking for it. Caught via a real
      // proposal that did exactly this.
      const currentGoalConfigForCheck = state.goalConfig || defaultGoalConfig();
      const currentByZoneKey = {};
      (currentGoalConfigForCheck.activeGoals||[]).forEach(g=>{ currentByZoneKey[g.zoneKey] = g; });
      proposed.goalConfigPatch.activeGoals.forEach((g,i)=>{
        if(!g.goalId || !g.zoneKey){
          errors.push('goalConfigPatch.activeGoals['+i+'] is missing "goalId"/"zoneKey" - it must match the real goal-config field names shown in the prompt (goalId, zoneKey, label, raceName, distanceKm, raceDate, goalTimeSec, goalTimeLabel, goalPaceSec, goalPaceLabel), not invented ones - otherwise it silently fails to apply.');
          return;
        }
        const existing = currentByZoneKey[g.zoneKey];
        if(existing && existing.goalId!==g.goalId){
          errors.push('goalConfigPatch renames the existing "'+g.zoneKey+'" goal\'s id from "'+existing.goalId+'" to "'+g.goalId+'" - goalId must stay the same when updating an existing goal\'s target, or the plan\'s own race day loses its link to it.');
        }
      });
    }
  }
  // A change can be pace/goal-target-only (goalConfigPatch, no week structure touched -
  // session paces are computed live from profile/goal-config, not baked into week JSON) or
  // week-structure-only (rep counts, session types, day placement) - only reject when
  // NEITHER is present, since that's a proposal with nothing to actually apply.
  if(!proposed.weeks.length && !proposed.goalConfigPatch){
    errors.push('The proposal did not include any weeks or a goal-config change to apply.');
    return {errors, warnings};
  }

  // A goal target getting genuinely HARDER (a meaningfully faster time) is a much bigger ask
  // of the training itself than of the label on a chart - closing a real gap needs more/
  // harder volume or frequency, not just a relabeled target. Caught live: a goal change
  // (sub-1:35 -> sub-1:30, a 5-minute/~5% ask) was accepted with the exact same plan
  // underneath it - nothing about weekly structure, volume, or intensity addressed how that
  // gap would actually close. Only fires when weeks is empty; a proposal that DOES restructure
  // alongside the goal change has nothing to flag here.
  const GOAL_TIGHTEN_WARN_PCT = 3;
  if(proposed.goalConfigPatch && Array.isArray(proposed.goalConfigPatch.activeGoals) && !proposed.weeks.length){
    const currentGoalConfigForTighten = state.goalConfig || defaultGoalConfig();
    const currentByGoalId = {};
    (currentGoalConfigForTighten.activeGoals||[]).forEach(g=>{ currentByGoalId[g.goalId] = g; });
    proposed.goalConfigPatch.activeGoals.forEach(g=>{
      const before = currentByGoalId[g.goalId];
      if(!before || before.goalTimeSec==null || g.goalTimeSec==null) return;
      if(g.goalTimeSec >= before.goalTimeSec) return;
      const pctFaster = (before.goalTimeSec - g.goalTimeSec)/before.goalTimeSec*100;
      if(pctFaster > GOAL_TIGHTEN_WARN_PCT){
        warnings.push('This sets '+(g.label||g.type||'the goal')+' to a target '+pctFaster.toFixed(1)+'% faster ('+(before.goalTimeLabel||'')+' → '+(g.goalTimeLabel||'')+') with NO change to weekly structure, volume, or session types - closing a gap that size essentially never happens on the exact same plan. If this is a real goal change, ask for an actual restructure, not just a relabeled target.');
      }
    });
  }

  proposed.weeks.forEach(w=>{
    if(typeof w.n!=='number'){ errors.push('A proposed week is missing a valid week number.'); return; }
    if(!w.dates || typeof w.dates!=='string'){ errors.push('Week '+w.n+' is missing a "dates" range.'); }
    if(!Array.isArray(w.days)){ errors.push('Week '+w.n+' is missing a "days" array.'); return; }
    w.days.forEach(d=>{
      if(!d.tag) errors.push('Week '+w.n+' has a day with no tag.');
      if(!KNOWN_DAY_TYPES.includes(d.type)) errors.push('Week '+w.n+', day "'+(d.tag||'?')+'" has an unrecognized type "'+d.type+'".');
    });
  });
  if(errors.length) return {errors, warnings};

  // Merge onto a copy of the current plan (without touching storage) purely to preview
  // week-over-week totals and structure - same upsert logic applyPlanOverrides itself uses.
  const merged = currentWeeks.slice();
  proposed.weeks.forEach(pw=>{
    const idx = merged.findIndex(w=>w.n===pw.n);
    if(idx!==-1) merged[idx] = pw; else merged.push(pw);
  });
  merged.sort((a,b)=>a.n-b.n);

  // Week-over-week overload (~10%/week ramp-rate guideline), skipped around cutback/race
  // weeks. Only surfaced for a pair where at least one week is actually part of THIS
  // proposal - the plan's own existing weeks can already have this characteristic
  // (e.g. week 1's post-taper-week ramp), which is real but not something this specific
  // change caused, and showing it anyway just reads as unexplained noise about weeks the
  // runner didn't ask about.
  const touchedWeekNums = new Set(proposed.weeks.map(w=>w.n));
  for(let i=1;i<merged.length;i++){
    const prev = merged[i-1], cur = merged[i];
    if(!touchedWeekNums.has(prev.n) && !touchedWeekNums.has(cur.n)) continue;
    if(cur.cutback || cur.race || prev.cutback || prev.race) continue;
    const prevKm = computeWeekPlannedKm(prev), curKm = computeWeekPlannedKm(cur);
    if(prevKm>0){
      const pctChange = (curKm-prevKm)/prevKm*100;
      if(pctChange>WEEKLY_OVERLOAD_WARN_PCT){
        warnings.push('Week '+cur.n+' jumps '+pctChange.toFixed(0)+'% over week '+prev.n+' ('+prevKm+'km → '+curKm+'km) - above the usual ~10%/week ramp-rate guideline.');
      }
    }
  }

  // Long-run share of week + exceeds the runner's own active race distance.
  const goalConfig = state.goalConfig || defaultGoalConfig();
  const maxGoalDistanceKm = Math.max(0, ...(goalConfig.activeGoals||[]).map(g=>g.distanceKm||0));
  const goalActive = (goalConfig.activeGoals||[]).some(g=>g.zoneKey==='GOAL');
  const race10kActive = (goalConfig.activeGoals||[]).some(g=>g.zoneKey==='RACE10K');
  proposed.weeks.forEach(w=>{
    const weekKm = computeWeekPlannedKm(w);
    w.days.forEach(d=>{
      const zoneStr = (d.zone||'').toLowerCase();
      if(!goalActive && zoneStr.includes('goal')){
        warnings.push('Week '+w.n+', "'+d.name+'" references the GOAL pace zone, but no half-marathon-equivalent goal is currently active - this zone has no real meaning right now.');
      }
      if(!race10kActive && zoneStr.includes('race10k')){
        warnings.push('Week '+w.n+', "'+d.name+'" references the RACE10K pace zone, but no 10K-equivalent goal is currently active - this zone has no real meaning right now.');
      }
      if(d.type!=='long') return;
      const longKm = parseFloat(d.data && d.data.totalKm) || 0;
      if(weekKm>0 && longKm/weekKm > LONG_RUN_SHARE_WARN_PCT){
        warnings.push('Week '+w.n+'\'s long run ('+longKm+'km) is '+Math.round(longKm/weekKm*100)+'% of that week\'s '+weekKm+'km total - above the usual ~25-30% single-run guideline.');
      }
      if(maxGoalDistanceKm>0 && longKm>maxGoalDistanceKm){
        warnings.push('Week '+w.n+'\'s long run ('+longKm+'km) is longer than the '+maxGoalDistanceKm.toFixed(1)+'km race distance itself.');
      }
    });
  });

  // Back-to-back quality (threshold/vo2max) days with no easy/rest day between.
  proposed.weeks.forEach(w=>{
    const qualityDays = w.days
      .filter(d=>d.type==='threshold'||d.type==='vo2max')
      .map(d=>({d, date:parseDayTagDate(d.tag)}))
      .filter(x=>x.date)
      .sort((a,b)=>a.date-b.date);
    for(let i=1;i<qualityDays.length;i++){
      const gapDays = Math.round((qualityDays[i].date - qualityDays[i-1].date)/86400000);
      if(gapDays<=1){
        warnings.push('Week '+w.n+': "'+qualityDays[i-1].d.name+'" and "'+qualityDays[i].d.name+'" sit on back-to-back days with no easy/rest day between them.');
      }
    }
  });

  // Orphaned log history: a day-tag with real logged history that a replaced week no
  // longer includes. Scoped to touched weeks only, not a full-plan scan.
  for(const pw of proposed.weeks){
    const before = currentWeeks.find(w=>w.n===pw.n);
    if(!before) continue;
    const newTags = new Set(pw.days.map(d=>d.tag));
    for(const oldDay of before.days){
      if(newTags.has(oldDay.tag)) continue;
      try{
        const log = await loadWorkoutLog(pw.n, oldDay.tag);
        if(log && (log.completed || log.skipped)){
          warnings.push('Week '+pw.n+' drops "'+oldDay.tag+'" ('+oldDay.name+'), which has logged history under it - that history won\'t be orphaned, but it also won\'t show up connected to the new plan unless a day reuses the same tag.');
        }
      }catch(e){}
    }
  }

  return {errors, warnings};
}

async function buildPersonalizationContext(){
  const parts = [];
  try{
    const best = await getBestFitnessLTPace();
    if(best.value!=null) parts.push('Current best-known LT pace: '+fmtPace(best.value)+' (source: '+best.source+(best.updatedAt?(', '+timeAgo(best.updatedAt)):'')+').');
  }catch(e){}
  try{
    const t2 = await loadTierEstimate(2);
    const t3 = await loadTierEstimate(3);
    if(t2) parts.push('Tier 2 (outdoor) estimate: '+JSON.stringify(t2)+'.');
    if(t3) parts.push('Tier 3 (treadmill) estimate: '+JSON.stringify(t3)+'.');
  }catch(e){}
  try{
    const progress = await computeGoalProgress();
    if(progress){
      if(progress.tenK) parts.push(progress.tenK.label+' gap: '+progress.tenK.gap10KSec+'s/km vs. where the plan expects today.');
      if(progress.hm) parts.push(progress.hm.label+' gap: '+progress.hm.gapHMSec+'s/km vs. where the plan expects today.');
    }
  }catch(e){}
  try{
    const eff = await getEfficiencyTrend();
    if(eff) parts.push('Aerobic efficiency trend: '+(eff.pctChange>=0?'+':'')+eff.pctChange.toFixed(1)+'% recent vs prior.');
  }catch(e){}
  try{
    const ttt = await getTrendSummary('timetotarget-history');
    if(ttt && ttt.pctChange!=null) parts.push('Time-to-target-HR trend: '+(ttt.pctChange<=0?'improving':'slower')+' by '+Math.abs(ttt.pctChange).toFixed(0)+'%.');
  }catch(e){}
  try{
    const hrr = await getTrendSummary('hrrecovery-history');
    if(hrr && hrr.pctChange!=null) parts.push('HR recovery trend: '+(hrr.pctChange>=0?'improving':'declining')+' by '+Math.abs(hrr.pctChange).toFixed(0)+'%.');
  }catch(e){}
  try{
    const decoup = await getTrendSummary('decoupling-history');
    if(decoup && decoup.pctChange!=null) parts.push('Long-run decoupling trend: '+(decoup.pctChange<=0?'improving':'worsening')+' by '+Math.abs(decoup.pctChange).toFixed(0)+'%.');
  }catch(e){}
  try{
    const inactivity = await getDaysSinceLastActivity();
    if(inactivity && inactivity.days>=7) parts.push('Days since last logged activity: '+inactivity.days+' - if proposing a return-to-training structure, ramp back in rather than resuming at prior intensity.');
  }catch(e){}
  try{
    const ir = await window.storage.get('runner-insights', false);
    if(ir){ const iobj = JSON.parse(ir.value); if(iobj && iobj.text) parts.push('What\'s been learned about this runner over time: '+iobj.text); }
  }catch(e){}
  return parts.join(' ');
}

async function buildPlanOverrideSystemPrompt(){
  const goalConfig = state.goalConfig || defaultGoalConfig();
  const planJSON = JSON.stringify(state.WEEKS.map(w=>({n:w.n, dates:w.dates, cutback:!!w.cutback, race:!!w.race, callout:w.callout||null, days:w.days})));
  const methodologyRef = buildMethodologyReferenceText();
  let currentMethodology = 'norwegian-subthreshold';
  try{
    const r = await window.storage.get('plan-override', false);
    if(r){ const o = JSON.parse(r.value); if(o.activeMethodology) currentMethodology = o.activeMethodology; }
  }catch(e){}
  const personalization = await buildPersonalizationContext();
  const goalsDesc = (goalConfig.activeGoals||[]).length
    ? goalConfig.activeGoals.map(g=>(g.label||g.type)+': '+(g.raceName||'')+', '+g.raceDate+', goal '+(g.goalTimeLabel||'')).join('; ')
    : 'No active race goal right now (phase: '+(goalConfig.phase||'maintenance')+').';
  const goalConfigJSON = JSON.stringify(goalConfig);

  return [{type:'text', text:
    'You are a running coach drafting a structured update to a runner\'s training plan, grounded in real, named training methodologies rather than improvising.\n'+
    'Reference methodologies (pick and commit to exactly ONE as the primary organizing method for whatever you propose - don\'t blend all four, name which one and why in methodologyRationale):\n'+methodologyRef+'\n'+
    'The plan currently follows: '+currentMethodology+'. Only propose switching methodology if the request or a genuine phase change (e.g. moving from race-build to a raceless maintenance phase) actually warrants it - stay consistent with the current one otherwise, since methodology-hopping mid-block defeats the point of any of them. Some flexibility within the chosen methodology is normal (see its "normal flexibility" note above); inventing structure outside any named methodology is not.\n'+
    'Current goal(s): '+goalsDesc+'\n'+
    'What\'s known about this runner specifically right now: '+(personalization||'no additional fitness/trend data available yet.')+'\n'+
    'Current goal-config, verbatim - if you set "goalConfigPatch", it MUST use this exact shape/field names ({"phase":"...", "activeGoals":[{"goalId":"...","type":"...","zoneKey":"GOAL"|"RACE10K","label":"...","raceName":"...","distanceKm":0,"raceDate":"YYYY-MM-DD","goalTimeSec":0,"goalTimeLabel":"...","goalPaceSec":0,"goalPaceLabel":"...","goalHR":"..."}]}) - do NOT invent different field names (e.g. "goals"/"id"/"targetTime" are wrong and will silently fail to apply). A patch is shallow-merged onto this object, so include the FULL "activeGoals" array (not just the entries changing) whenever you touch it, or an untouched goal will vanish. CRITICAL: "goalId" is a STABLE identifier for the goal/race itself (also referenced by that race\'s day in the plan JSON below, via its own "goalId" field) - it does NOT encode the current target time, so it must NEVER change when you update an existing goal\'s target, even if the target time changes completely (e.g. updating the "hm-sub135" goal to a sub-1:32:00 target still uses goalId "hm-sub135" - do not rename it to something like "hm-sub132"). Only invent a new goalId when adding a genuinely new goal that has no existing entry above. Verbatim current goal-config: '+goalConfigJSON+'\n'+
    'Current full plan as a JSON array of week objects (reuse this exact shape for any day/field you don\'t intend to change): '+planJSON+'\n'+
    'CRITICAL - read before deciding what to include in "weeks": every session\'s actual pace (threshold/VO2max/long-run zone paces, GOAL/RACE10K pace) is computed LIVE from the runner\'s current profile and goal-config every time the plan renders - it is NOT hardcoded into the week/day JSON above. This means a request that\'s really about updating LT pace or the goal race-pace targets themselves (not the session STRUCTURE - rep counts, session types, which days, distances) needs ONLY a "goalConfigPatch" (or, if it\'s really a Garmin/Tier-1 LT pace update rather than a goal target, say so in your reply text and note that\'s a separate "Update Garmin numbers" action, not something this block can do) - leave "weeks" EMPTY in that case, BUT ONLY when the new target is realistically within reach of the plan\'s current training load (see the very next paragraph for when it is not). Do not re-emit unchanged weeks just to reflect a pace number; that produces a huge, mostly-redundant response and risks getting cut off. Only include a week in "weeks" when its actual structure is changing.\n'+
    'CRITICAL: if a goalConfigPatch you\'re proposing makes an existing goal meaningfully FASTER/harder - not a small few-second/km nudge that reflects fitness already gained, but a genuinely bigger ask (roughly 3%+ faster goal time, e.g. several minutes off a half marathon) - you MUST also propose real structural changes to the plan (more threshold/quality frequency or volume, longer or more specific sessions, an extended build, etc.) that would actually be needed to close that gap. NEVER emit a goalConfigPatch alone that just relabels the target time on the exact same training - a goal isn\'t achieved by renaming it, and doing this reads as a lazy, non-responsive coach, not a real plan for closing the gap. If you genuinely believe the current structure is already sufficient to reach the new target (e.g. the runner is already ahead of schedule and this is just formalizing where their fitness already has them), say so explicitly and specifically in your plain-language reply, with the reasoning - don\'t leave it unaddressed.\n'+
    'Self-check before answering (the app also verifies these deterministically, but get them right the first time): don\'t increase a week\'s total km by more than ~10% over the prior week outside a deliberate cutback/taper; a long run should generally stay under ~25-30% of that week\'s own total and never exceed the runner\'s active race distance; don\'t schedule two threshold/VO2max days back-to-back with no easy/rest day between them; keep your JSON as compact as possible - never include a week unless something about its actual structure is changing.\n'+
    'Start your reply with 1-3 short sentences in plain language explaining what you\'re proposing and why (which methodology, what\'s actually changing) - the runner sees this text directly, it\'s not hidden. If part or all of the request genuinely can\'t be done through this mechanism (most commonly: it\'s actually about the runner\'s OWN current LT pace / Tier-1 Garmin numbers, not a goal-race target or the plan\'s session structure - this block can update goal-config and session structure, but NOT the runner\'s own profile numbers), say that plainly here too, and name the separate action needed ("update your Garmin numbers" / "Update Garmin numbers" button) - don\'t silently ignore that part of the request.\n'+
    'Then, ONLY if there is an actual plan/goal-config change to propose, follow with a block starting on its own line with exactly "PLAN OVERRIDE:" followed by one valid JSON object: {"weeks":[<complete week object(s) that are changing, in the exact shape shown above>],"methodology":"<one of the reference methodology ids>","methodologyRationale":"one or two sentences citing the chosen methodology and why it fits this request and situation","truncateAfter":null,"goalConfigPatch":null}. Nothing after this JSON object - it\'s the last thing in your reply. If NOTHING about the plan or goal-config actually needs to change (e.g. the request is entirely a Tier-1 LT pace matter), omit the PLAN OVERRIDE block entirely and end your reply after the explanation above.\n'+
    '"weeks" may be an EMPTY array when the change is entirely a goalConfigPatch (see above) - don\'t force a week into it just to have something there. When weeks are included, only the ones actually changing, each supplied as a COMPLETE week object - copy every unchanged field/day through verbatim from what was given above, don\'t invent new structure or silently drop existing notes/callouts you weren\'t asked to change. Only set "truncateAfter" (a week number) for a genuine full phase transition that should end the current block after that week and not carry forward any of its later untouched weeks - omit/null it otherwise. Only set "goalConfigPatch" (a partial goal-config object) when the request genuinely changes an active goal\'s target pace/time, the active goal(s) themselves, or the phase (e.g. a race is done and the next phase has no race goal - phase becomes "maintenance", activeGoals becomes []) - omit/null it for ordinary in-block tweaks.'
  }];
}

export async function requestPlanOverride(userRequest, opts){
  opts = opts || {};
  toggleChat(true);
  const box = document.getElementById('chatMessages');
  box.insertAdjacentHTML('beforeend', '<div class="msg user">'+userRequest+'</div>');
  const loadingId = 'plan-override-'+Date.now();
  box.insertAdjacentHTML('beforeend', '<div class="msg assistant" id="'+loadingId+'">Drafting a plan update...</div>');
  box.scrollTop = box.scrollHeight;

  try{
    // Refresh from storage rather than trusting whatever state.goalConfig already holds
    // in memory - it's only ever set once at page load (main.js) or by a prior apply in
    // this same tab, so if the goal-config changed by any other path since this page was
    // opened, an in-memory read here would silently diff/prompt against a stale "current"
    // value. Same class of staleness already found and fixed for storage.js elsewhere.
    state.goalConfig = await loadGoalConfig();
    const system = await buildPlanOverrideSystemPrompt();
    const userText = opts.priorProposal
      ? ('About the plan change you just proposed (weeks '+opts.priorProposal.weeks.map(w=>w.n).join(', ')+', methodology '+(opts.priorProposal.methodology||'unspecified')+'): '+userRequest)
      : userRequest;
    const data = await fetchCoachReply(system, userText, 'plan-override');
    const textResp = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    // A response cut off by the token ceiling (stop_reason 'max_tokens') is the most likely
    // cause of an unparseable block below - most often because the request implied touching
    // many weeks at once. Surface that specifically rather than a generic "try again", since
    // "try again" alone won't fix it - the request itself needs to be narrower.
    const truncated = data.stop_reason==='max_tokens';
    const truncatedHint = truncated ? ' The reply looks like it got cut off before finishing (too large a request) - try asking for fewer weeks at once, or if this is really about a pace/goal-time target rather than session structure, say that specifically.' : '';
    const marker = 'PLAN OVERRIDE:';
    const idx = textResp.indexOf(marker);
    // The coach's own explanation (which methodology, what's changing, and critically -
    // when part of the request can't be done through this mechanism at all, e.g. it's
    // really the runner's own Tier-1 LT pace, not a goal target - that gets said here)
    // always gets shown, whether or not an actual PLAN OVERRIDE block follows it. This
    // used to be silently discarded in favor of a generic "Here's the proposed change"
    // label, which is exactly what made a Tier-1-only reply look like nothing happened.
    const prose = (idx===-1 ? textResp : textResp.slice(0, idx)).trim();
    const loadingEl = document.getElementById(loadingId);
    if(idx===-1){
      loadingEl.innerText = prose || ('The coach didn\'t return a usable reply - try rephrasing the request.'+truncatedHint);
      return;
    }
    loadingEl.innerText = prose;
    const raw = textResp.slice(idx+marker.length).trim();
    const fb = raw.indexOf('{'), lb = raw.lastIndexOf('}');
    if(fb===-1 || lb<=fb){
      loadingEl.innerText = (prose ? prose+'\n\n' : '')+'The coach\'s proposed-change block wasn\'t valid JSON - try again.'+truncatedHint;
      return;
    }
    let proposal;
    try{ proposal = JSON.parse(raw.slice(fb, lb+1)); }
    catch(e){
      loadingEl.innerText = (prose ? prose+'\n\n' : '')+'Could not parse the coach\'s proposed change - try again.'+truncatedHint;
      return;
    }
    // Refresh again right before validating/rendering, not just at the top of this
    // function - the LLM call above can take 10-20s, long enough for state.goalConfig to
    // have changed again in the meantime (this exact staleness was caught live: an
    // identical goal-config patch rendered as "(new)"/"removed" instead of no diff,
    // because state.goalConfig at render time didn't match what was actually persisted).
    state.goalConfig = await loadGoalConfig();
    const validation = await validatePlanOverride(state.WEEKS, proposal);
    renderPlanOverrideNotice(loadingId, proposal, validation);
  }catch(e){
    const msg = e.status===529 ? 'Claude\'s API is briefly overloaded - try again in a moment' : (e.message||'unknown error');
    const el = document.getElementById(loadingId);
    if(el) el.innerText = 'Could not draft a plan change (' + msg + ').';
    console.error(e);
  }
}

// Human-readable diff for goalConfigPatch, same spirit as the week-km diff rows - the raw
// JSON shape the prompt requires the model to emit (see buildPlanOverrideSystemPrompt) is
// meant for the model to produce reliably, not for a runner to read directly.
export function goalConfigPatchDiffHTML(patch){
  if(!patch) return '';
  const rows = [];
  const current = state.goalConfig || defaultGoalConfig();
  if(patch.phase!=null && patch.phase!==current.phase){
    rows.push('<div class="tier-diff-row"><span class="tier-diff-label">Phase</span><span class="tier-diff-vals">'+(current.phase||'-')+' → <b>'+patch.phase+'</b></span></div>');
  }
  if(Array.isArray(patch.activeGoals)){
    const beforeById = {};
    (current.activeGoals||[]).forEach(g=>{ beforeById[g.goalId] = g; });
    const afterIds = new Set(patch.activeGoals.map(g=>g.goalId));
    const fmtGoal = g => (g.goalTimeLabel||'')+(g.goalPaceLabel?(' ('+g.goalPaceLabel+')'):'');
    patch.activeGoals.forEach(g=>{
      const before = beforeById[g.goalId];
      const afterLabel = fmtGoal(g);
      if(!before){
        rows.push('<div class="tier-diff-row"><span class="tier-diff-label">'+(g.label||g.type||'Goal')+'</span><span class="tier-diff-vals">(new) <b>'+afterLabel+'</b></span></div>');
      } else {
        const beforeLabel = fmtGoal(before);
        if(beforeLabel!==afterLabel){
          rows.push('<div class="tier-diff-row"><span class="tier-diff-label">'+(g.label||g.type||'Goal')+'</span><span class="tier-diff-vals">'+beforeLabel+' → <b>'+afterLabel+'</b></span></div>');
        }
      }
    });
    (current.activeGoals||[]).forEach(g=>{
      if(!afterIds.has(g.goalId)){
        rows.push('<div class="tier-diff-row"><span class="tier-diff-label">'+(g.label||g.type||'Goal')+'</span><span class="tier-diff-vals">removed</span></div>');
      }
    });
  }
  return rows.join('');
}

export function renderPlanOverrideNotice(elId, proposal, validation){
  const el = document.getElementById(elId);
  if(!el) return;
  if(validation.errors.length){
    const box = document.createElement('div');
    box.className = 'plan-override-box';
    box.innerHTML = '<div class="tier-update-head">Plan change could not be applied</div>'+
      validation.errors.map(e=>'<div class="tier-diff-reason" style="color:#ff6b6b;">'+e+'</div>').join('');
    el.appendChild(box);
    return;
  }
  const uid = 'po'+Date.now()+Math.floor(Math.random()*1000);
  state.pendingPlanOverride[uid] = proposal;
  const weekDiffHTML = proposal.weeks.map(w=>{
    const before = state.WEEKS.find(x=>x.n===w.n);
    const beforeKm = before ? computeWeekPlannedKm(before) : null;
    const afterKm = computeWeekPlannedKm(w);
    return '<div class="tier-diff-row"><span class="tier-diff-label">Week '+w.n+'</span><span class="tier-diff-vals">'+(beforeKm!=null?(beforeKm+'km → '):'(new week) ')+'<b>'+afterKm+'km</b></span></div>';
  }).join('');
  const truncateNote = proposal.truncateAfter!=null ? ('<div class="tier-diff-reason">Ends the current block after week '+proposal.truncateAfter+' - later untouched weeks won\'t carry forward.</div>') : '';
  const goalPatchHTML = goalConfigPatchDiffHTML(proposal.goalConfigPatch);
  const box = document.createElement('div');
  box.className = 'plan-override-box';
  box.id = uid;
  // A goal-config change (your actual race target, or the phase itself) is a much bigger
  // decision than a routine session tweak and deserves to be unmistakable, not just
  // another line in a card with the same "Apply" button as a rep-count change - caught
  // live: a goal change was accepted without the runner realizing that's what "Apply" did.
  // Flagged prominently up top AND gated behind a second, explicit confirmation step.
  const touchesGoal = !!proposal.goalConfigPatch;
  const goalChangeBanner = touchesGoal
    ? '<div class="tier-diff-reason" style="color:#ff6b6b; font-weight:700; margin-top:0;">&#9888; This also changes your actual race goal, not just the plan structure:</div>'+goalPatchHTML
    : '';
  const applyButtonHTML = touchesGoal
    ? '<button class="save-btn" style="background:#ff6b6b;" onclick="promptGoalChangeConfirmation(\''+uid+'\')">Review goal change</button>'
    : '<button class="save-btn" onclick="applyPlanOverride(\''+uid+'\')">Apply</button>';
  box.innerHTML = '<div class="tier-update-head">&#128221; Plan change proposed'+(proposal.methodology?(' - '+proposal.methodology):'')+'</div>'+
    (proposal.methodologyRationale ? ('<div class="tier-diff-reason">'+proposal.methodologyRationale+'</div>') : '')+
    goalChangeBanner+
    weekDiffHTML+
    truncateNote+
    validation.warnings.map(w=>'<div class="tier-diff-reason" style="color:var(--threshold);">'+w+'</div>').join('')+
    '<div class="tier-update-actions">'+applyButtonHTML+'<button class="ghost-btn" onclick="editPlanOverride(\''+uid+'\')">Edit</button><button class="ghost-btn" onclick="dismissPlanOverrideNotice(\''+uid+'\')">Dismiss</button></div>';
  el.appendChild(box);
}

// Second, explicit confirmation step specifically for a goal-changing proposal - the
// runner must see the goal diff again and actively choose to accept it, not just click
// the same button they'd use for an ordinary rep-count tweak.
export function promptGoalChangeConfirmation(uid){
  const box = document.getElementById(uid);
  const proposal = state.pendingPlanOverride[uid];
  if(!box || !proposal) return;
  const goalPatchHTML = goalConfigPatchDiffHTML(proposal.goalConfigPatch);
  const actionsEl = box.querySelector('.tier-update-actions');
  if(!actionsEl) return;
  actionsEl.outerHTML = '<div class="tier-diff-reason" style="color:#ff6b6b; font-weight:700;">Confirm: this changes your race goal to -</div>'+
    goalPatchHTML+
    '<div class="tier-update-actions"><button class="save-btn" style="background:#ff6b6b;" onclick="applyPlanOverride(\''+uid+'\')">Yes, change my goal</button><button class="ghost-btn" onclick="dismissPlanOverrideNotice(\''+uid+'\')">Cancel - keep current goal</button></div>';
}

export function dismissPlanOverrideNotice(uid){
  const box = document.getElementById(uid);
  if(box) box.innerHTML = '<div class="tier-diff-reason" style="color:var(--dim);">Dismissed - nothing changed.</div>';
  delete state.pendingPlanOverride[uid];
}

export function editPlanOverride(uid){
  const proposal = state.pendingPlanOverride[uid];
  if(!proposal) return;
  toggleGlobalPlanOverrideModal(true);
  const input = document.getElementById('planOverrideInput');
  if(input){
    input.placeholder = 'Tell the coach what to change about this proposal...';
    input.dataset.priorPlanOverrideUid = uid;
  }
}

export async function applyPlanOverride(uid){
  const box = document.getElementById(uid);
  const proposal = state.pendingPlanOverride[uid];
  if(!proposal){
    if(box) box.innerHTML = '<div class="tier-diff-reason" style="color:#ff6b6b;">This proposal is no longer available - ask the coach again.</div>';
    return;
  }
  try{
    let existing = {version:1, weeksByN:{}, truncateAfter:null, activeMethodology:null};
    try{ const r = await window.storage.get('plan-override', false); if(r) existing = JSON.parse(r.value); }catch(e){}
    const existingGoalConfig = state.goalConfig || defaultGoalConfig();

    // Snapshot both the plan-override AND the goal-config together, since a single Apply
    // can change either or both (goalConfigPatch) - reverting one without the other would
    // leave a phase/goal change permanent even after "undoing" the plan change it came with.
    let history = [];
    try{ const hr = await window.storage.get('plan-override-history', false); if(hr) history = JSON.parse(hr.value); }catch(e){}
    history.unshift({planOverride: existing, goalConfig: existingGoalConfig});
    if(history.length>15) history = history.slice(0,15);
    await saveWithRetry('plan-override-history', history, false);
    await sleep(150);

    const weeksByN = Object.assign({}, existing.weeksByN);
    proposal.weeks.forEach(w=>{ weeksByN[String(w.n)] = w; });
    const merged = {
      version: 1, weeksByN,
      truncateAfter: proposal.truncateAfter!=null ? proposal.truncateAfter : (existing.truncateAfter!=null ? existing.truncateAfter : null),
      activeMethodology: proposal.methodology || existing.activeMethodology || null,
      updatedAt: new Date().toISOString(),
    };
    await saveWithRetry('plan-override', merged, false);
    await sleep(150);

    if(proposal.goalConfigPatch){
      const currentGoalConfig = state.goalConfig || defaultGoalConfig();
      const newGoalConfig = Object.assign({}, currentGoalConfig, proposal.goalConfigPatch);
      await saveGoalConfig(newGoalConfig);
      await sleep(150);
      state.goalConfig = newGoalConfig;
      // The AI-synthesized trajectory readings (position/confidence/headline) were
      // computed against whatever goal was active at the time - once the goal itself
      // changes, that reading no longer means anything relative to the new target but
      // stays displayed as if it still does. Caught live: a goal made meaningfully harder
      // left a stale "83/100, clearly ahead of schedule" reading on screen, flatly
      // contradicting the runner's own actual current-fitness projection. Clearing these
      // forces a fresh deterministic-baseline read until the next real coach interaction
      // recomputes a new AI synthesis against the goal that's actually active now.
      try{
        await window.storage.delete('goal-trajectory-latest', false);
        await sleep(150);
        await window.storage.delete('goal-trajectory-10k-latest', false);
        await sleep(150);
        await window.storage.delete('goal-trajectory-prevpos', false);
        await sleep(150);
        await window.storage.delete('goal-trajectory-10k-prevpos', false);
        await sleep(150);
      }catch(e){ console.error('clearing stale goal-trajectory readings failed', e); }
    }

    state.WEEKS = await applyPlanOverrides(buildWeeks());
    state.Z = computeZones(state.profile, state.goalConfig);
    try{ const v = await computeVO2maxPaceSec(); if(v!=null) state.Z.S5.pace = v; }catch(e){}
    await clearStaleRebuildSuggestions();
    renderNav();
    renderCurrentWeek();

    if(box) box.innerHTML = '<div class="tier-diff-reason" style="color:var(--easy);">&#10003; Applied - the plan above now reflects this change.</div>';
    delete state.pendingPlanOverride[uid];
  }catch(e){
    console.error('applyPlanOverride failed', e);
    notifyError('Could not apply this plan change - try again.');
  }
}

// Whatever "Suggested plan change" text originally prompted this Apply (the verdict card
// and/or a week's "Since last week" preview) is now stale - it already got acted on, so
// leaving its "Draft this rebuild"/Copy affordance up just invites requesting the same
// change again. Doesn't try to trace which specific suggestion led here (the request text
// is free-form, not tied back to a card id) - simplest correct behavior is clearing every
// currently-cached rebuild suggestion, since all of them describe a pre-apply plan state.
async function clearStaleRebuildSuggestions(){
  try{
    const vr = await window.storage.get('latest-verdict', false);
    if(vr){
      const verdict = JSON.parse(vr.value);
      if(verdict.rebuildText){
        verdict.rebuildText = null;
        await saveWithRetry('latest-verdict', verdict, false);
        renderVerdictCard(verdict);
        await sleep(150);
      }
    }
  }catch(e){ console.error('clearStaleRebuildSuggestions: verdict clear failed', e); }
  try{
    const list = await window.storage.list('week-preview-w', false);
    if(list && list.keys){
      for(const key of list.keys){
        try{
          const r = await window.storage.get(key, false);
          if(!r) continue;
          const preview = JSON.parse(r.value);
          if(!preview.rebuildText) continue;
          preview.rebuildText = null;
          await saveWithRetry(key, preview, false);
          const weekN = parseInt(key.replace('week-preview-w', ''), 10);
          if(!isNaN(weekN)) state.weekPreviewCache[weekN] = preview;
          await sleep(150);
        }catch(e){}
      }
    }
  }catch(e){ console.error('clearStaleRebuildSuggestions: week-preview clear failed', e); }
}

export async function revertPlanOverride(){
  try{
    let history = [];
    try{ const hr = await window.storage.get('plan-override-history', false); if(hr) history = JSON.parse(hr.value); }catch(e){}
    if(!history.length){
      await window.storage.delete('plan-override', false);
    } else {
      const entry = history.shift();
      // Defensive: an older history entry saved before goalConfig snapshotting was added
      // is just the bare plan-override object, not {planOverride, goalConfig}.
      const restoredPlanOverride = entry.planOverride!==undefined ? entry.planOverride : entry;
      const restoredGoalConfig = entry.goalConfig!==undefined ? entry.goalConfig : null;
      await saveWithRetry('plan-override', restoredPlanOverride, false);
      await sleep(150);
      await saveWithRetry('plan-override-history', history, false);
      if(restoredGoalConfig){
        await sleep(150);
        await saveGoalConfig(restoredGoalConfig);
        state.goalConfig = restoredGoalConfig;
      }
    }
    state.WEEKS = await applyPlanOverrides(buildWeeks());
    state.Z = computeZones(state.profile, state.goalConfig);
    try{ const v = await computeVO2maxPaceSec(); if(v!=null) state.Z.S5.pace = v; }catch(e){}
    renderNav();
    renderCurrentWeek();
  }catch(e){
    console.error('revertPlanOverride failed', e);
    notifyError('Could not undo the most recent plan change - try again.');
  }
}

window.applyPlanOverride = applyPlanOverride;
window.dismissPlanOverrideNotice = dismissPlanOverrideNotice;
window.editPlanOverride = editPlanOverride;
window.revertPlanOverride = revertPlanOverride;
window.promptGoalChangeConfirmation = promptGoalChangeConfirmation;

export async function submitPlanOverrideRequest(){
  const input = document.getElementById('planOverrideInput');
  const text = input.value.trim();
  if(!text) return;
  const priorUid = input.dataset.priorPlanOverrideUid;
  const opts = priorUid && state.pendingPlanOverride[priorUid] ? {priorProposal: state.pendingPlanOverride[priorUid]} : {};
  delete input.dataset.priorPlanOverrideUid;
  input.value = '';
  input.placeholder = 'e.g. Add a second threshold day starting week 3, or draft a winter maintenance block once racing is done';
  toggleGlobalPlanOverrideModal(false);
  await requestPlanOverride(text, opts);
}

export function toggleGlobalPlanOverrideModal(open, prefillText){
  document.getElementById('planOverrideModal').classList.toggle('open', open);
  document.getElementById('overlay').classList.toggle('open', open);
  if(open){
    const input = document.getElementById('planOverrideInput');
    input.value = prefillText || '';
    input.focus();
  }
}

window.toggleGlobalPlanOverrideModal = toggleGlobalPlanOverrideModal;
window.submitPlanOverrideRequest = submitPlanOverrideRequest;
