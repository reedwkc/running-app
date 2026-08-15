// @ts-nocheck
// Coach-driven plan rebuild - the propose/validate/apply/revert pipeline, deliberately
// modeled on tier-estimates.js's TIER2/3 ESTIMATE pattern (clamp -> snapshot -> save ->
// inline Apply/revert card) but adapted for a much bigger, higher-stakes payload: a plan
// change is never auto-applied (tier estimates save optimistically, this doesn't), and
// revert is a bounded history STACK rather than a single -previous slot, since plan edits
// are rarer and bigger than tier nudges and a single slot would make a two-steps-back
// correction impossible.
import { state } from '../state.js';
import { fetchCoachReply } from './chat.js';
import { computeGoalProgress, computeVO2maxPaceSec } from './goal-trajectory.js';
import { buildMethodologyReferenceText } from './methodology-reference.js';
import { getBestFitnessLTPace, getDaysSinceLastActivity, getEfficiencyTrend, getTrendSummary, loadTierEstimate } from './tier-estimates.js';
import { applyPlanOverrides, buildWeeks, computeWeekPlannedKm, computeZones } from '../data/plan.js';
import { defaultGoalConfig, saveGoalConfig } from '../data/goal-config.js';
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
  if(!proposed.weeks.length){
    errors.push('The proposal did not include any weeks to change.');
    return {errors, warnings};
  }
  if(proposed.truncateAfter!=null && typeof proposed.truncateAfter!=='number'){
    errors.push('"truncateAfter" must be a week number.');
  }
  if(proposed.goalConfigPatch!=null && typeof proposed.goalConfigPatch!=='object'){
    errors.push('"goalConfigPatch" must be an object.');
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

  // Week-over-week overload (~10%/week ramp-rate guideline), skipped around cutback/race weeks.
  for(let i=1;i<merged.length;i++){
    const prev = merged[i-1], cur = merged[i];
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

  return [{type:'text', text:
    'You are a running coach drafting a structured update to a runner\'s training plan, grounded in real, named training methodologies rather than improvising.\n'+
    'Reference methodologies (pick and commit to exactly ONE as the primary organizing method for whatever you propose - don\'t blend all four, name which one and why in methodologyRationale):\n'+methodologyRef+'\n'+
    'The plan currently follows: '+currentMethodology+'. Only propose switching methodology if the request or a genuine phase change (e.g. moving from race-build to a raceless maintenance phase) actually warrants it - stay consistent with the current one otherwise, since methodology-hopping mid-block defeats the point of any of them. Some flexibility within the chosen methodology is normal (see its "normal flexibility" note above); inventing structure outside any named methodology is not.\n'+
    'Current goal(s): '+goalsDesc+'\n'+
    'What\'s known about this runner specifically right now: '+(personalization||'no additional fitness/trend data available yet.')+'\n'+
    'Current full plan as a JSON array of week objects (reuse this exact shape for any day/field you don\'t intend to change): '+planJSON+'\n'+
    'Self-check before answering (the app also verifies these deterministically, but get them right the first time): don\'t increase a week\'s total km by more than ~10% over the prior week outside a deliberate cutback/taper; a long run should generally stay under ~25-30% of that week\'s own total and never exceed the runner\'s active race distance; don\'t schedule two threshold/VO2max days back-to-back with no easy/rest day between them.\n'+
    'Respond with ONLY a block starting on its own line with exactly "PLAN OVERRIDE:" followed by one valid JSON object: {"weeks":[<complete week object(s) that are changing, in the exact shape shown above>],"methodology":"<one of the reference methodology ids>","methodologyRationale":"one or two sentences citing the chosen methodology and why it fits this request and situation","truncateAfter":null,"goalConfigPatch":null}. '+
    'Only include weeks that actually need to change, each supplied as a COMPLETE week object - copy every unchanged field/day through verbatim from what was given above, don\'t invent new structure or silently drop existing notes/callouts you weren\'t asked to change. Only set "truncateAfter" (a week number) for a genuine full phase transition that should end the current block after that week and not carry forward any of its later untouched weeks - omit/null it otherwise. Only set "goalConfigPatch" (a partial goal-config object) when the request genuinely changes the active goal(s) or phase (e.g. a race is done and the next phase has no race goal - phase becomes "maintenance", activeGoals becomes []) - omit/null it for ordinary in-block tweaks. Nothing else in your reply - no preamble, no commentary, no markdown fencing.'
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
    const system = await buildPlanOverrideSystemPrompt();
    const userText = opts.priorProposal
      ? ('About the plan change you just proposed (weeks '+opts.priorProposal.weeks.map(w=>w.n).join(', ')+', methodology '+(opts.priorProposal.methodology||'unspecified')+'): '+userRequest)
      : userRequest;
    const data = await fetchCoachReply(system, userText);
    const textResp = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    const marker = 'PLAN OVERRIDE:';
    const idx = textResp.indexOf(marker);
    if(idx===-1){
      document.getElementById(loadingId).innerText = 'The coach didn\'t return a usable plan change - try rephrasing the request.';
      return;
    }
    const raw = textResp.slice(idx+marker.length).trim();
    const fb = raw.indexOf('{'), lb = raw.lastIndexOf('}');
    if(fb===-1 || lb<=fb){
      document.getElementById(loadingId).innerText = 'The coach\'s reply wasn\'t valid JSON - try again.';
      return;
    }
    let proposal;
    try{ proposal = JSON.parse(raw.slice(fb, lb+1)); }
    catch(e){
      document.getElementById(loadingId).innerText = 'Could not parse the coach\'s proposed change - try again.';
      return;
    }
    document.getElementById(loadingId).innerText = 'Here\'s the proposed change:';
    const validation = await validatePlanOverride(state.WEEKS, proposal);
    renderPlanOverrideNotice(loadingId, proposal, validation);
  }catch(e){
    const msg = e.status===529 ? 'Claude\'s API is briefly overloaded - try again in a moment' : (e.message||'unknown error');
    const el = document.getElementById(loadingId);
    if(el) el.innerText = 'Could not draft a plan change (' + msg + ').';
    console.error(e);
  }
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
  const goalPatchNote = proposal.goalConfigPatch ? ('<div class="tier-diff-reason">Also updates the active goal/phase: '+JSON.stringify(proposal.goalConfigPatch)+'</div>') : '';
  const box = document.createElement('div');
  box.className = 'plan-override-box';
  box.id = uid;
  box.innerHTML = '<div class="tier-update-head">&#128221; Plan change proposed'+(proposal.methodology?(' - '+proposal.methodology):'')+'</div>'+
    (proposal.methodologyRationale ? ('<div class="tier-diff-reason">'+proposal.methodologyRationale+'</div>') : '')+
    weekDiffHTML+
    truncateNote+goalPatchNote+
    validation.warnings.map(w=>'<div class="tier-diff-reason" style="color:var(--threshold);">'+w+'</div>').join('')+
    '<div class="tier-update-actions"><button class="save-btn" onclick="applyPlanOverride(\''+uid+'\')">Apply</button><button class="ghost-btn" onclick="editPlanOverride(\''+uid+'\')">Edit</button><button class="ghost-btn" onclick="dismissPlanOverrideNotice(\''+uid+'\')">Dismiss</button></div>';
  el.appendChild(box);
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
    }

    state.WEEKS = await applyPlanOverrides(buildWeeks());
    state.Z = computeZones(state.profile, state.goalConfig);
    try{ const v = await computeVO2maxPaceSec(); if(v!=null) state.Z.S5.pace = v; }catch(e){}
    renderNav();
    renderCurrentWeek();

    if(box) box.innerHTML = '<div class="tier-diff-reason" style="color:var(--easy);">&#10003; Applied - the plan above now reflects this change.</div>';
    delete state.pendingPlanOverride[uid];
  }catch(e){
    console.error('applyPlanOverride failed', e);
    notifyError('Could not apply this plan change - try again.');
  }
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
