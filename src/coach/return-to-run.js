// @ts-nocheck
// An ACTIVE injury is a state, not an event - and until this module existed, this app had
// no way to hold that state at all.
//
// injury-tracking.js already logs dated ache/pain/injury EVENTS, but only ever reads them
// backwards, mining for a precursor pattern ("your flare-ups tend to follow a load spike").
// It needs two events plus 14+ days of TRIMP history before it says anything, and what it
// says is a risk forecast. Nothing anywhere asked the far simpler question the runner
// actually cares about while limping: am I hurt RIGHT NOW, and what should this week look
// like because of it?
//
// The only return-to-training machinery that existed (estimateLayoffImpact, tier-estimates.js)
// is keyed entirely on SILENCE - days since the last logged activity - and its tiers are
// calibrated for DETRAINING, i.e. aerobic fitness decaying while you do nothing. That is the
// wrong axis for an injury twice over:
//   1. It cannot fire until a week of silence has already accumulated, so the days that
//      matter most (deciding whether to run at all) are unprotected.
//   2. Under 14 days it returns the 'negligible' tier - 0% pace penalty, rampWeeksRecommended
//      0, note "normal week-to-week variation, not a real fitness loss yet" - which is TRUE
//      about fitness and dangerously irrelevant about tissue. Ten days off because work got
//      busy and ten days off nursing a quad strain produced byte-identical guidance, and
//      because rampWeeksRecommended was 0, the return-ramp guard in plan-override.js stayed
//      silent too.
// Detraining asks "how much fitness did I lose". Returning from injury asks "how much load
// can this tissue take". Those are different questions with different answers, so this is a
// separate tier table rather than another column bolted onto LAYOFF_TIERS.
//
// Deliberately NOT symptom-interrogating. Real return-to-running protocols progress on pain
// response, but this app has a standing rule that nothing may ask the runner to judge or
// type anything after a session (see the log form's pain field - optional, offered, never
// demanded). So the ramp here is driven by time and volume, which are known without asking,
// and voluntarily-reported pain only ever acts as a brake (a fresh pain event during the
// ramp restarts it), never as a question the runner has to answer to make progress.
import { state } from '../state.js';
import { computeWeekPlannedKm } from '../data/plan.js';
import { dateToYMD, parseDayTagDate, parseWeekEndDate, parseWeekStartDate } from '../lib/dates.js';
import { readJsonObject } from '../lib/data-store.js';
import { saveWithRetry } from '../lib/storage.js';
import { loadInjuryHistory, SEVERITY_ORDER } from './injury-tracking.js';
import { getDaysSinceLastActivity, getLayoffAdjustment } from './tier-estimates.js';

export const INJURY_STATUS_KEY = 'injury-status';

// Graded return-to-running tiers, indexed by how long running actually stopped. Grounded in
// mainstream return-to-sport practice for soft-tissue/overuse running injuries rather than
// in a detraining curve: restore VOLUME first at easy intensity, reintroduce speed only once
// easy volume is tolerated, and hold total load meaningfully below the pre-injury level for
// the first weeks back (the same acute:chronic logic ACWR already encodes elsewhere in this
// app - the tissue's tolerance is set by what it has recently done, and an injury layoff
// resets "recently done" to near zero).
//
// Named coarse tiers, not an invented smooth formula, for the same reason LAYOFF_TIERS is
// written that way: the underlying evidence is coarse, and pretending otherwise with a
// continuous function would dress up a guess as a measurement.
//
// The pace penalties are small on purpose. They exist to stop a prescribed threshold pace
// computed from pre-injury fitness being handed back on day one; they are NOT a fitness
// downgrade, and the volume/quality caps below are what actually does the protective work.
export const RETURN_TIERS = [
  {maxDaysOut: 6, key: 'niggle', rampWeeks: 1, firstWeekVolumePct: 70, weeklyStepPct: 20,
   firstLongRunPct: 60, qualityHoldWeeks: 1, ltPacePenaltyPct: 0, vo2maxPenaltyPct: 0,
   note: 'Under a week off - one easy week back at reduced volume before normal training resumes, and no quality work in that first week.'},
  {maxDaysOut: 13, key: 'short', rampWeeks: 2, firstWeekVolumePct: 55, weeklyStepPct: 20,
   firstLongRunPct: 50, qualityHoldWeeks: 2, ltPacePenaltyPct: 2, vo2maxPenaltyPct: 4,
   note: '1-2 weeks off - roughly 2 weeks of easy-only running, rebuilding volume from about half of pre-injury before any threshold or VO2max work returns.'},
  {maxDaysOut: 27, key: 'moderate', rampWeeks: 3, firstWeekVolumePct: 45, weeklyStepPct: 20,
   firstLongRunPct: 45, qualityHoldWeeks: 2, ltPacePenaltyPct: 4, vo2maxPenaltyPct: 7,
   note: '2-4 weeks off - roughly 3 weeks rebuilding volume from well under half of pre-injury, with quality work returning in the last of them; the long run rebuilds separately and more slowly than weekly total.'},
  {maxDaysOut: 55, key: 'long', rampWeeks: 4, firstWeekVolumePct: 35, weeklyStepPct: 15,
   firstLongRunPct: 35, qualityHoldWeeks: 3, ltPacePenaltyPct: 6, vo2maxPenaltyPct: 11,
   note: '4-8 weeks off - about a month of rebuilding, the first three weeks easy-only; treat these as genuinely new training, not a resumption.'},
  {maxDaysOut: Infinity, key: 'extended', rampWeeks: 6, firstWeekVolumePct: 25, weeklyStepPct: 15,
   firstLongRunPct: 30, qualityHoldWeeks: 4, ltPacePenaltyPct: 9, vo2maxPenaltyPct: 15,
   note: '8+ weeks off - a genuine base rebuild, roughly 6 weeks with run/walk at the start if needed, before any race-specific structure.'},
];
// The quality hold is never longer than the volume ramp, and from the 'moderate' tier up it
// deliberately ends BEFORE it: past a couple of weeks off, volume takes longer to rebuild
// than intensity needs to stay away, and holding all quality until weekly km is fully
// restored would waste weeks of the block for no protective benefit. In the two shortest
// tiers they coincide, which is the same statement said differently - those ramps are short
// enough to simply be easy-only throughout.

// Severity raises the floor but never the ceiling: something the runner actually called an
// injury (rather than an ache or a pain) never gets the most minimal tier, however few days
// it happened to cost, because naming it an injury is itself a statement about tissue. It is
// deliberately only one step - duration remains the primary axis, since a strain that kept
// you off for a month is a bigger problem than the word used to describe it on day one.
const SEVERITY_MIN_TIER_INDEX = {ache: 0, pain: 0, injury: 1};

// The body part is free text from a one-line form field, and real entries look like "Right
// quad still painful." - a whole sentence, sometimes with trailing punctuation. It gets
// inlined into banner headings, coach prompts and plan-rebuild requests, so it is normalized
// once here at write time rather than defensively patched at each of those sites.
function normalizeBodyPart(s){
  const t = String(s==null ? '' : s).trim().replace(/[.,;:\s]+$/, '');
  if(!t) return '';
  // Long enough to be a note rather than a location: keep the leading phrase for headings and
  // let the runner's full wording live on in the injury's `note` field instead.
  return t.length<=40 ? t : t.slice(0,40).replace(/\s+\S*$/, '')+'...';
}

export function computeReturnProtocol({daysOut, severity} = {}){
  const d = (daysOut!=null && isFinite(daysOut)) ? Math.max(0, Math.round(daysOut)) : 0;
  const durationIndex = RETURN_TIERS.findIndex(t=>d<=t.maxDaysOut);
  const sev = SEVERITY_ORDER[severity]!=null ? severity : 'pain';
  const index = Math.max(durationIndex, SEVERITY_MIN_TIER_INDEX[sev] || 0);
  const tier = RETURN_TIERS[index];
  return Object.assign({daysOut: d, severity: sev, tierIndex: index}, tier);
}

// ---------------------------------------------------------------------------
// The stored state itself
// ---------------------------------------------------------------------------

async function readStatus(){
  const read = await readJsonObject(INJURY_STATUS_KEY);
  if(!read.ok) return null; // unreadable - never treat as "no injury", see data-store.js
  const v = read.value || {};
  return {current: v.current || null, past: Array.isArray(v.past) ? v.past : []};
}

export async function loadInjuryStatus(){
  const s = await readStatus();
  return s ? s.current : null;
}

export async function loadInjuryStatusFull(){
  return (await readStatus()) || {current: null, past: []};
}

// Snapshots what the plan was actually asking for at the moment the injury started - the
// return ramp is expressed as a percentage of that, and reading it live later would be
// wrong twice over (the plan may since have been rebuilt, and once the ramp is applied the
// reduced weeks would become their own baseline, ratcheting the runner down each refresh).
function preInjuryBaselineFromPlan(startDateStr){
  const weeks = state.WEEKS || [];
  const start = startDateStr ? new Date(startDateStr+'T00:00:00') : null;
  let chosen = null;
  if(start){
    chosen = weeks.find(w=>{
      const ws = parseWeekStartDate(w), we = parseWeekEndDate(w);
      return ws && we && start >= ws && start <= we;
    }) || null;
  }
  // No week actually contains the start date - an injury dated back to before the plan's
  // current weeks, or a plan that has since been truncated. Falling through to a null
  // baseline would silently disable every volume cap for the whole return, so instead take
  // the nearest week that does exist: the last one ending before the injury, or failing
  // that the first one after it. A ramp measured against an approximately-right week beats
  // no ramp at all, which is exactly the failure this module was built to end.
  if(!chosen && weeks.length && start){
    const before = weeks.filter(w=>{ const we = parseWeekEndDate(w); return we && we < start; });
    chosen = before.length ? before[before.length-1] : weeks[0];
  }
  // A week that is itself a taper, cutback or race week is not a fair picture of normal
  // training load, so look for the nearest week that is - otherwise an injury picked up
  // during race week would set the whole return ramp against an artificially tiny baseline.
  //
  // Bounded by the current block, and that bound matters. Caught live: this runner got hurt in
  // a post-race recovery week, and the three weeks before it were all cutback or race weeks
  // too - so walking backwards sailed straight out of the block into the PREVIOUS one and
  // came back with 45.7km/19km, a level this block does not reach until months in. The return
  // would have been ramped against training that belongs to a finished goal.
  //
  // So it searches backwards only as far as the block start, then forwards instead. Forwards
  // is the better answer anyway when the injury lands early in a block: the first normal week
  // ahead is precisely what the plan intends this runner to be doing now.
  if(chosen && (chosen.cutback || chosen.race)){
    const blockStartN = (state.goalConfig||{}).blockStartWeekN;
    const inBlock = w => blockStartN==null || w.n >= blockStartN;
    const idx = weeks.indexOf(chosen);
    let found = null;
    for(let i=idx-1; i>=0 && inBlock(weeks[i]); i--){
      if(!weeks[i].cutback && !weeks[i].race){ found = weeks[i]; break; }
    }
    if(!found){
      for(let i=idx+1; i<weeks.length; i++){
        if(!weeks[i].cutback && !weeks[i].race){ found = weeks[i]; break; }
      }
    }
    if(found) chosen = found;
  }
  if(!chosen) return {weeklyKm: null, longRunKm: null, fromWeekN: null};
  let longRunKm = 0;
  (chosen.days||[]).forEach(d=>{
    if(d.type!=='long' || !d.data) return;
    const k = d.data.totalKm!=null ? parseFloat(d.data.totalKm) : (d.data.km!=null ? parseFloat(d.data.km) : 0);
    if(isFinite(k) && k>longRunKm) longRunKm = k;
  });
  return {weeklyKm: computeWeekPlannedKm(chosen), longRunKm: longRunKm || null, fromWeekN: chosen.n};
}

/**
 * Opens a new active injury, or updates the one already open. Called from every route that
 * can learn about an injury - a skip or a completed session with a pain report (week-view),
 * the coach's own structured INJURY STATUS block (chat.js), or the runner tapping the
 * banner. Idempotent by design: the same injury reported three ways stays one episode.
 *
 * An existing episode is only ever escalated, never quietly downgraded - a later "ache"
 * report about the same body part while an "injury" is open is more likely a good day than
 * a recovery, and the runner clears it explicitly (resolveInjury) when it is actually over.
 */
export async function openOrUpdateInjury({bodyPart, severity, startDate, expectedReturnDate, note, source} = {}){
  const full = await loadInjuryStatusFull();
  const today = dateToYMD(new Date());
  const sev = SEVERITY_ORDER[severity]!=null ? severity : 'pain';
  const existing = full.current;
  let current;
  if(existing){
    const keepSeverity = SEVERITY_ORDER[sev] > SEVERITY_ORDER[existing.severity] ? sev : existing.severity;
    current = Object.assign({}, existing, {
      severity: keepSeverity,
      bodyPart: bodyPart ? normalizeBodyPart(bodyPart) : existing.bodyPart,
      // An earlier start date is real new information (the runner remembering it began
      // before the session that finally got it logged); a later one is not.
      startDate: (startDate && startDate < existing.startDate) ? startDate : existing.startDate,
      expectedReturnDate: expectedReturnDate!==undefined ? expectedReturnDate : existing.expectedReturnDate,
      note: note ? String(note).trim() : existing.note,
      updatedAt: new Date().toISOString(),
    });
  } else {
    const start = startDate || today;
    const baseline = preInjuryBaselineFromPlan(start);
    current = {
      id: 'inj-'+Date.now(),
      bodyPart: normalizeBodyPart(bodyPart),
      severity: sev,
      startDate: start,
      expectedReturnDate: expectedReturnDate || null,
      // Set by markRunSinceInjury the first time a session is actually logged after the
      // injury opened - that is what turns "resting" into "ramping", and it is observed
      // rather than asked for.
      firstRunBackDate: null,
      preInjuryWeeklyKm: baseline.weeklyKm,
      preInjuryLongRunKm: baseline.longRunKm,
      baselineFromWeekN: baseline.fromWeekN,
      note: (note||'').trim(),
      source: source || 'unknown',
      openedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  await saveWithRetry(INJURY_STATUS_KEY, {current, past: full.past}, false);
  return current;
}

// The runner is through it. Archived rather than deleted - the closed episode is exactly the
// evidence injury-tracking.js's pattern analysis wants, and "how long did the last one take"
// is the most useful thing to know when the next one starts.
export async function resolveInjury(dateStr){
  const full = await loadInjuryStatusFull();
  if(!full.current) return null;
  const resolved = Object.assign({}, full.current, {
    resolvedDate: dateStr || dateToYMD(new Date()),
    resolvedAt: new Date().toISOString(),
  });
  await saveWithRetry(INJURY_STATUS_KEY, {current: null, past: full.past.concat([resolved]).slice(-20)}, false);
  return resolved;
}

// Records that running has actually resumed. The first such date anchors the whole ramp, so
// it is written once and never moved by later sessions.
export async function markRunSinceInjury(dateStr){
  const full = await loadInjuryStatusFull();
  if(!full.current || full.current.firstRunBackDate) return full.current;
  const current = Object.assign({}, full.current, {
    firstRunBackDate: dateStr || dateToYMD(new Date()),
    updatedAt: new Date().toISOString(),
  });
  await saveWithRetry(INJURY_STATUS_KEY, {current, past: full.past}, false);
  return current;
}

export async function setExpectedReturn(dateStr){
  const full = await loadInjuryStatusFull();
  if(!full.current) return null;
  const current = Object.assign({}, full.current, {expectedReturnDate: dateStr || null, updatedAt: new Date().toISOString()});
  await saveWithRetry(INJURY_STATUS_KEY, {current, past: full.past}, false);
  return current;
}

// ---------------------------------------------------------------------------
// Reading the state as something the plan can act on
// ---------------------------------------------------------------------------

function daysBetween(fromYMD, toYMD){
  const a = new Date(fromYMD+'T00:00:00'), b = new Date(toYMD+'T00:00:00');
  if(isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((b.getTime()-a.getTime())/86400000);
}

/**
 * The whole active picture, computed fresh: phase, protocol tier, and the concrete caps the
 * next weeks have to respect. Returns null when nothing is active - every consumer treats
 * null as "train normally", so a resolved or never-opened injury changes nothing anywhere.
 *
 * `todayStr` is injectable purely so tests aren't clock-dependent; production never passes it.
 */
export async function getActiveReturnToRun(todayStr){
  try{
    let injury = await loadInjuryStatus();
    if(!injury) return null;
    injury = await healBaselineOutsideBlock(injury);
    const today = todayStr || dateToYMD(new Date());

    // Days the injury has actually cost so far. While still resting that keeps growing, so
    // the protocol tier can escalate on its own as a layoff drags on - the runner does not
    // have to come back and re-report a worsening situation for the plan to take it
    // seriously, which is exactly the failure this whole module exists to prevent.
    const daysOut = injury.firstRunBackDate
      ? (daysBetween(injury.startDate, injury.firstRunBackDate) || 0)
      : (daysBetween(injury.startDate, today) || 0);
    const protocol = computeReturnProtocol({daysOut, severity: injury.severity});

    const resting = !injury.firstRunBackDate;
    // Week 1 of the ramp is the week containing the first run back; day 0-6 is week 1.
    const rampDay = resting ? 0 : (daysBetween(injury.firstRunBackDate, today) || 0);
    const rampWeek = resting ? 0 : Math.floor(rampDay/7)+1;

    // A fresh pain report after running resumed means the ramp was too fast - it restarts
    // rather than continuing, since the tissue has just said no. Only pain/injury counts;
    // an 'ache' logged during a return is expected and would otherwise reset the ramp
    // forever. This is the one place voluntarily-reported symptoms steer the protocol, and
    // it can only ever slow it down.
    let setback = null;
    if(!resting){
      const hist = await loadInjuryHistory();
      const since = hist.filter(h=>h.date > injury.firstRunBackDate && SEVERITY_ORDER[h.severity] >= SEVERITY_ORDER.pain);
      if(since.length) setback = since[since.length-1];
    }

    const beyondRamp = !resting && !setback && rampWeek > protocol.rampWeeks;
    if(beyondRamp){
      // The ramp is served. Stay non-null but unrestricted, so the banner can offer to close
      // the episode rather than the state silently evaporating with no record of why the
      // restriction disappeared.
      return {
        injury, protocol, phase: 'complete', rampWeek, daysOut,
        ltPacePenaltyPct: 0, vo2maxPenaltyPct: 0, rampWeeksRecommended: 0,
        caps: null, setback: null,
        note: 'The '+protocol.rampWeeks+'-week return ramp for the '+(injury.bodyPart||'injury')+' is complete - normal training limits apply again.',
      };
    }

    const effectiveRampWeek = setback ? 1 : rampWeek;
    const weeksLeft = Math.max(0, protocol.rampWeeks - Math.max(0, effectiveRampWeek-1));

    // Volume climbs from firstWeekVolumePct by weeklyStepPct per ramp week, capped at 100%.
    // Expressed against the pre-injury snapshot, never against last week's already-reduced
    // number, so the ramp cannot ratchet itself down on repeated reads.
    const weekIdx = Math.max(0, effectiveRampWeek-1);
    const volumePct = resting ? 0 : Math.min(100, protocol.firstWeekVolumePct + protocol.weeklyStepPct*weekIdx);
    const longRunPct = resting ? 0 : Math.min(100, protocol.firstLongRunPct + protocol.weeklyStepPct*weekIdx);
    const qualityAllowed = !resting && effectiveRampWeek > protocol.qualityHoldWeeks;

    const caps = {
      volumePct,
      longRunPct,
      weeklyKm: (injury.preInjuryWeeklyKm!=null && !resting) ? Math.round(injury.preInjuryWeeklyKm*volumePct)/100 : null,
      longRunKm: (injury.preInjuryLongRunKm!=null && !resting) ? Math.round(injury.preInjuryLongRunKm*longRunPct)/100 : null,
      qualityAllowed,
      qualityHoldWeeksRemaining: Math.max(0, protocol.qualityHoldWeeks - Math.max(0, effectiveRampWeek-1)),
    };

    return {
      injury, protocol, caps, setback,
      restOffer: await buildRestOffer(injury, resting ? {phase:'resting', injury} : null, today),
      phase: resting ? 'resting' : 'ramping',
      rampWeek: effectiveRampWeek,
      daysOut,
      weeksLeft,
      ltPacePenaltyPct: protocol.ltPacePenaltyPct,
      vo2maxPenaltyPct: protocol.vo2maxPenaltyPct,
      rampWeeksRecommended: protocol.rampWeeks,
      note: buildRestrictionNote({injury, protocol, resting, rampWeek: effectiveRampWeek, caps, setback, daysOut}),
    };
  }catch(e){ console.error('getActiveReturnToRun failed', e); return null; }
}

// This banner is the first thing read on a bad week. "2 week(s)" is a small thing that makes
// it read as generated rather than written.
function plural(n, word){ return n + ' ' + word + (n === 1 ? '' : 's'); }

export function buildRestrictionNote({injury, protocol, resting, rampWeek, caps, setback, daysOut}){
  const where = injury.bodyPart ? (injury.bodyPart) : 'an injury';
  if(resting){
    const expected = injury.expectedReturnDate ? (' Expected back running around '+injury.expectedReturnDate+'.') : '';
    // protocol.note is deliberately NOT appended here - it restates the ramp length, opening
    // volume and quality hold this sentence has just given in concrete terms, and reading the
    // same thing twice in a row makes the banner look automated rather than informative.
    return 'Not running: '+where+' ('+injury.severity+'), '+plural(daysOut, 'day')+' since '+injury.startDate+'.'+expected+
      ' On the current duration this calls for a ~'+protocol.rampWeeks+'-week return ramp starting from the first run back, opening at about '+
      protocol.firstWeekVolumePct+'% of pre-injury weekly volume with no threshold or VO2max work for the first '+plural(protocol.qualityHoldWeeks, 'week')+'.';
  }
  const setbackNote = setback ? (' The ramp restarted on '+setback.date+' after '+setback.severity+' was reported again - week 1 conditions apply.') : '';
  const qual = caps.qualityAllowed
    ? 'Quality work is cleared again.'
    : ('No threshold or VO2max work for another '+plural(caps.qualityHoldWeeksRemaining, 'week')+'.');
  const volTxt = caps.weeklyKm!=null ? (' Weekly volume ceiling this week: about '+caps.weeklyKm+'km ('+caps.volumePct+'% of the '+injury.preInjuryWeeklyKm+'km pre-injury week)') : (' Weekly volume ceiling this week: about '+caps.volumePct+'% of pre-injury');
  const longTxt = caps.longRunKm!=null ? (', long run about '+caps.longRunKm+'km.') : '.';
  return 'Returning from '+where+' ('+injury.severity+', '+daysOut+' days out): week '+rampWeek+' of a ~'+protocol.rampWeeks+'-week ramp. '+qual+volTxt+longTxt+setbackNote;
}

/**
 * The pace restriction that actually reaches prescribed session paces. An injury return and
 * a plain layoff can both be live at once (they usually are - an injury produces silence),
 * so this takes the STRONGER of the two rather than letting whichever was checked last win.
 * Shaped exactly like getLayoffAdjustment's return value, plus a `kind`, so every existing
 * consumer (recomputeZones, the coach prompt, the softened-paces banner) keeps working
 * unchanged and only has to care about `kind` if it wants to word things differently.
 */
export async function getEffectivePaceRestriction(){
  let layoff = null, rtr = null;
  try{ layoff = await getLayoffAdjustment(); }catch(e){}
  try{ rtr = await getActiveReturnToRun(); }catch(e){}
  const injuryAdj = (rtr && rtr.ltPacePenaltyPct>0) ? {
    kind: 'injury',
    days: rtr.daysOut,
    severity: rtr.injury.severity,
    ltPacePenaltyPct: rtr.ltPacePenaltyPct,
    vo2maxPenaltyPct: rtr.vo2maxPenaltyPct,
    rampWeeksRecommended: rtr.rampWeeksRecommended,
    bodyPart: rtr.injury.bodyPart,
    note: rtr.note,
  } : null;
  if(!injuryAdj) return layoff ? Object.assign({kind:'layoff'}, layoff) : null;
  if(!layoff) return injuryAdj;
  return layoff.ltPacePenaltyPct > injuryAdj.ltPacePenaltyPct ? Object.assign({kind:'layoff'}, layoff) : injuryAdj;
}

// ---------------------------------------------------------------------------
// "Are you injured?" - the deterministic fallback
// ---------------------------------------------------------------------------

// The gap this closes: the runner reports pain once, in a session note or to the coach, and
// then simply stops running. No further pain is ever logged (nothing is being logged at
// all), so no state exists and no watchdog fires - the exact silence this app sat through
// for over a week. This asks the question deterministically from evidence already on file,
// as a one-tap prompt rather than a form, and only when both halves are true: sessions are
// genuinely going unperformed AND something actually hurt recently.
export const INJURY_PROMPT_MIN_MISSED = 2;
export const INJURY_PROMPT_PAIN_WINDOW_DAYS = 21;
// Sessions going unperformed with nothing written down anywhere. Set higher than the
// pain-backed bar because it is a weaker signal on its own - two skipped sessions in a busy
// fortnight is ordinary life, four in a row with no running at all is not.
export const INJURY_PROMPT_SILENT_MISSED = 4;
// Seven days, because that is already this app's own line for "a gap worth noticing" - it is
// where estimateLayoffImpact starts returning anything at all (tier-estimates.js). Reusing it
// rather than inventing a second threshold means the two cannot disagree about when silence
// has gone on long enough to mean something. Four missed sessions on top of it is what
// separates a week off from a week where training was supposed to happen and didn't.
export const INJURY_PROMPT_SILENT_QUIET_DAYS = 7;

/**
 * Two independent routes to the same one-tap question, because the app must not depend on the
 * runner having written anything - not in the pain field, not in a Strava description, not to
 * the coach. People stop logging when they are hurt; that is the whole difficulty.
 *
 * 1. A real pain report plus sessions going unperformed. High confidence, fires early.
 * 2. Silence alone: several sessions missed AND no logged activity at all for a stretch. No
 *    text required anywhere. Lower confidence, so it waits for a clearer picture - but it
 *    does eventually ask, which is the part that was missing.
 */
export function detectPossibleInjury({missedRecent, painEvents, daysSinceActivity, lastActivityDate, todayStr}){
  const today = todayStr || dateToYMD(new Date());
  if(missedRecent >= INJURY_PROMPT_MIN_MISSED){
    const recentPain = (painEvents||[])
      .filter(e=>SEVERITY_ORDER[e.severity] >= SEVERITY_ORDER.pain)
      .filter(e=>{
        const d = daysBetween(e.date, today);
        return d!=null && d>=0 && d<=INJURY_PROMPT_PAIN_WINDOW_DAYS;
      });
    if(recentPain.length){
      const latest = recentPain[recentPain.length-1];
      return {
        basis: 'pain-reported',
        missedRecent,
        painEvent: latest,
        bodyPart: latest.bodyPart || '',
        severity: latest.severity,
        startDate: recentPain[0].date,
      };
    }
  }
  if(missedRecent >= INJURY_PROMPT_SILENT_MISSED && daysSinceActivity!=null && daysSinceActivity >= INJURY_PROMPT_SILENT_QUIET_DAYS){
    return {
      basis: 'silence',
      missedRecent,
      daysSinceActivity,
      lastActivityDate: lastActivityDate || null,
      painEvent: null,
      bodyPart: '',
      // Nothing was reported, so nothing is invented about WHAT hurts. The one thing the
      // calendar does know is WHEN running stopped, and that is what sizes the ramp - so the
      // last logged activity becomes the start date rather than today, which would read the
      // injury as brand new and hand back a ramp far shorter than the gap deserves.
      severity: null,
      startDate: lastActivityDate || null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

export function returnToRunBannerHTML(rtr){
  if(!rtr) return '';
  const where = rtr.injury.bodyPart ? esc(rtr.injury.bodyPart) : 'injury';
  if(rtr.phase==='complete'){
    return '<div class="card"><div class="sess-name" style="margin-bottom:4px;">&#10003; Return ramp complete</div>'+
      '<div class="note" style="border-top:none; padding-top:0; font-size:13px;">'+esc(rtr.note)+'</div>'+
      '<div class="tier-update-actions"><button class="save-btn" onclick="clearInjuryStatus()">Close this off</button></div></div>';
  }
  const head = rtr.phase==='resting'
    ? '&#9888; Injured - not running ('+where+')'
    : '&#9888; Returning from '+where+' - week '+rtr.rampWeek+' of '+rtr.protocol.rampWeeks;
  // Every action this situation calls for, on the one card that already describes it - so the
  // runner is not navigating into each session card to do by hand what the app already knows.
  // Ordered by what they most likely want first: take the sessions off the calendar, then
  // reshape the weeks, then correct the state itself.
  const rest = rtr.restOffer;
  const restBtn = (rest && rest.pending && rest.pending.length)
    ? '<button class="save-btn" onclick="restUpcomingSessionsForInjury()">Skip the '+rest.pending.length+' session'+(rest.pending.length===1?'':'s')+' before you are back</button>'
    : '';
  const unlockBtn = (rest && rest.rested && rest.rested.length)
    ? '<button class="ghost-btn" onclick="unlockInjuryRestSessions()">Feeling better - put '+rest.rested.length+' session'+(rest.rested.length===1?'':'s')+' back</button>'
    : '';
  const restList = (rest && rest.pending && rest.pending.length)
    ? '<div class="note" style="border-top:none; padding-top:0; font-size:12px; color:var(--dim);">'+
      rest.pending.map(x=>esc(x.dayTag)+' - '+esc(x.name)).join('<br>')+'</div>'
    : '';
  const action = restList+'<div class="tier-update-actions">'+
    restBtn+
    '<button class="'+(restBtn ? 'ghost-btn' : 'save-btn')+'" onclick="proposeReturnToRunPlan()">Adjust the plan for this</button>'+
    unlockBtn+
    '<button class="ghost-btn" onclick="clearInjuryStatus()">No longer injured</button>'+
    '</div><div id="rtr-proposal-combined"></div>';
  return '<div class="card"><div class="sess-name" style="margin-bottom:4px;">'+head+'</div>'+
    '<div class="note" style="border-top:none; padding-top:0; font-size:13px;">'+esc(rtr.note)+'</div>'+
    action+'</div>';
}

export function injuryPromptBannerHTML(prompt){
  if(!prompt) return '';
  if(prompt.basis === 'silence'){
    return '<div class="card"><div class="sess-name" style="margin-bottom:4px;">&#9888; Are you injured?</div>'+
      '<div class="note" style="border-top:none; padding-top:0; font-size:13px;">'+
      prompt.missedRecent+' sessions have gone unperformed and nothing has been logged for '+prompt.daysSinceActivity+' days'+
      (prompt.lastActivityDate ? (' (last activity '+esc(prompt.lastActivityDate)+')') : '')+
      '. If something is hurting, say so once here and the plan will ease you back in properly instead of expecting you to pick up where it left off.</div>'+
      '<div class="tier-update-actions">'+
      '<button class="save-btn" onclick="confirmInjuryFromPrompt()">Yes - I am injured</button>'+
      '<button class="ghost-btn" onclick="dismissInjuryPrompt()">No, just a break</button>'+
      '</div></div>';
  }
  // The "where" field is free text the runner typed, and in practice it is often a whole
  // sentence rather than a body part ("Right quad still painful.") - so it gets quoted and
  // placed at the end of the clause rather than dropped mid-sentence as a noun, which read
  // as broken grammar the moment it was anything longer than two words.
  const where = prompt.bodyPart ? ('"'+esc(prompt.bodyPart.replace(/[.\s]+$/, ''))+'"') : null;
  const reported = where
    ? ('pain was reported on '+esc(prompt.painEvent.date)+' &ndash; '+where)
    : ('pain was reported on '+esc(prompt.painEvent.date));
  const sessions = prompt.missedRecent===1 ? '1 session has' : (prompt.missedRecent+' sessions have');
  return '<div class="card"><div class="sess-name" style="margin-bottom:4px;">&#9888; Are you injured?</div>'+
    '<div class="note" style="border-top:none; padding-top:0; font-size:13px;">'+
    sessions+' gone unperformed recently, and '+reported+
    '. If that is still the reason, say so once here and the plan will treat this as a real return-to-running situation instead of ordinary missed training.</div>'+
    '<div class="tier-update-actions">'+
    '<button class="save-btn" onclick="confirmInjuryFromPrompt()">Yes - I am injured</button>'+
    '<button class="ghost-btn" onclick="dismissInjuryPrompt()">No, unrelated</button>'+
    '</div></div>';
}

// A dismissal has to persist, or the banner returns on the next render and becomes the kind
// of nagging this app deliberately avoids. Keyed by the specific pain event it was raised
// from, so a genuinely new pain report asks again rather than staying silenced forever.
const INJURY_PROMPT_DISMISSED_KEY = 'injury-prompt-dismissed';

export async function isInjuryPromptDismissed(prompt){
  if(!prompt) return true;
  try{
    const r = await window.storage.get(INJURY_PROMPT_DISMISSED_KEY, false);
    if(!r) return false;
    const v = JSON.parse(r.value);
    if(!v) return false;
    if(prompt.basis === 'silence'){
      // A silence dismissal cannot be permanent, or answering "no, just a break" once would
      // mean the question is never asked again - including years later, for a real injury,
      // which is exactly the situation nobody is logging through. It lifts as soon as the
      // runner has actually run again since, because any gap after that is a NEW gap.
      if(v.basis !== 'silence') return false;
      if(v.lastActivityDate && prompt.lastActivityDate && prompt.lastActivityDate > v.lastActivityDate) return false;
      return true;
    }
    return v.basis !== 'silence' && v.eventDate === (prompt.painEvent && prompt.painEvent.date) && v.bodyPart === (prompt.bodyPart||'');
  }catch(e){ return false; }
}

export async function dismissInjuryPromptFor(prompt){
  if(!prompt) return;
  const record = prompt.basis === 'silence'
    ? {basis: 'silence', lastActivityDate: prompt.lastActivityDate || null, dismissedAt: new Date().toISOString()}
    : {basis: 'pain-reported', eventDate: prompt.painEvent && prompt.painEvent.date, bodyPart: prompt.bodyPart||'', dismissedAt: new Date().toISOString()};
  try{ await saveWithRetry(INJURY_PROMPT_DISMISSED_KEY, record, false); }catch(e){}
}

// Planned run days in the recent past that never got performed. Deliberately counts a
// SKIPPED session as unperformed too - the question being asked is "is the body stopping
// you", and a session you consciously skipped counts every bit as much as one you silently
// dropped. Unlike plan-adherence.js's engine, this reads the CURRENT, still-running week as
// well: adherence only counts a week once it has ended, which is a full week too late to ask
// whether someone is hurt.
//
// Imports loadWorkoutLog from the UI layer, which is a cycle on paper (week-view imports
// this module back) - the same shape goal-trajectory.js already has with week-view, and safe
// for the same reason: the binding is only ever read inside a function, never at module eval.
export async function countRecentUnperformedSessions(windowDays, todayStr){
  const days = windowDays || 21;
  const today = new Date((todayStr || dateToYMD(new Date()))+'T00:00:00');
  const from = new Date(today.getTime() - days*86400000);
  const { loadWorkoutLog } = await import('../ui/week-view.js');
  const { parseDayTagDate } = await import('../lib/dates.js');
  let count = 0;
  for(const w of (state.WEEKS||[])){
    for(const d of (w.days||[])){
      if(d.type==='open' || d.type==='race') continue;
      const dt = parseDayTagDate(d.tag, state.WEEKS);
      if(!dt || dt < from || dt >= today) continue;
      let log = null;
      try{ log = await loadWorkoutLog(w.n, d.tag); }catch(e){}
      if(!log || !log.completed) count++;
    }
  }
  return count;
}

// One place that recomputes everything injury-related for the UI, so the three call sites
// that refresh banners (app load, post-apply, post-save) cannot drift apart - the exact
// class of bug that made the week-nav desync and the stale-AI-reading fixes necessary.
export async function refreshInjuryState(){
  try{
    state.returnToRun = await getActiveReturnToRun();
    state.injuryPrompt = null;
    // The prompt is strictly a fallback for when no state exists. Once an injury is actually
    // open, the return banner says everything the prompt would, and showing both would be
    // asking a question already answered.
    if(!state.returnToRun){
      const [missedRecent, painEvents, inactivity] = await Promise.all([
        countRecentUnperformedSessions(), loadInjuryHistory(), getDaysSinceLastActivity(),
      ]);
      const prompt = detectPossibleInjury({
        missedRecent, painEvents,
        daysSinceActivity: inactivity ? inactivity.days : null,
        lastActivityDate: inactivity ? inactivity.lastDate : null,
      });
      if(prompt && !(await isInjuryPromptDismissed(prompt))) state.injuryPrompt = prompt;
    }
  }catch(e){ console.error('refreshInjuryState failed', e); }
}

// Undo for an accidental "no longer injured" tap. Restores the archived episode exactly as
// it was rather than opening a fresh one - a new episode would reset startDate and
// firstRunBackDate, quietly handing back week 1 of a ramp already half served.
export async function reopenLastInjury(){
  const full = await loadInjuryStatusFull();
  if(full.current || !full.past.length) return full.current;
  const past = full.past.slice();
  const last = past.pop();
  delete last.resolvedDate;
  delete last.resolvedAt;
  last.updatedAt = new Date().toISOString();
  await saveWithRetry(INJURY_STATUS_KEY, {current: last, past}, false);
  return last;
}

// ---------------------------------------------------------------------------
// The INJURY STATUS: block (see chat.js's system prompt)
// ---------------------------------------------------------------------------

export const INJURY_STATUS_MARKER = 'INJURY STATUS:';

export function stripInjuryStatusBlock(textResp){
  if(!textResp) return textResp;
  const idx = textResp.indexOf(INJURY_STATUS_MARKER);
  return idx===-1 ? textResp : textResp.slice(0, idx).trim();
}

export function parseInjuryStatusBlock(textResp){
  if(!textResp) return null;
  const idx = textResp.indexOf(INJURY_STATUS_MARKER);
  if(idx===-1) return null;
  const raw = textResp.slice(idx+INJURY_STATUS_MARKER.length);
  const fb = raw.indexOf('{'), lb = raw.indexOf('}', fb);
  if(fb===-1 || lb<=fb) return null;
  let parsed;
  try{ parsed = JSON.parse(raw.slice(fb, lb+1)); }catch(e){ console.error('INJURY STATUS parse failed', e); return null; }
  if(!parsed || typeof parsed!=='object') return null;
  if(parsed.active===false) return {active:false};
  if(parsed.active!==true) return null; // an object that says neither is not an instruction
  const ymd = v => (typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;
  return {
    active: true,
    // A severity the model invented falls back to 'pain' rather than being taken at face
    // value - same bound-don't-block treatment logInjuryEvent gives its own severity field.
    severity: SEVERITY_ORDER[parsed.severity]!=null ? parsed.severity : 'pain',
    bodyPart: typeof parsed.bodyPart==='string' ? parsed.bodyPart.trim() : '',
    startDate: ymd(parsed.startDate),
    expectedReturnDate: ymd(parsed.expectedReturnDate),
    note: typeof parsed.note==='string' ? parsed.note.trim() : '',
  };
}

/**
 * Applies a parsed block to real state. Returns what changed (or null), so a caller can
 * re-render; never throws into the reply-handling path, since a malformed block must not
 * cost the runner the coach's actual answer.
 */
export async function applyInjuryStatusBlock(textResp){
  try{
    const parsed = parseInjuryStatusBlock(textResp);
    if(!parsed) return null;
    if(!parsed.active){
      const existing = await loadInjuryStatus();
      if(!existing) return null;
      const resolved = await resolveInjury();
      await refreshInjuryState();
      return {action: 'resolved', injury: resolved};
    }
    const current = await openOrUpdateInjury({
      bodyPart: parsed.bodyPart,
      severity: parsed.severity,
      startDate: parsed.startDate,
      expectedReturnDate: parsed.expectedReturnDate,
      note: parsed.note,
      source: 'chat',
    });
    await refreshInjuryState();
    return {action: 'opened', injury: current};
  }catch(e){ console.error('applyInjuryStatusBlock failed', e); return null; }
}

// ---------------------------------------------------------------------------
// Taking the affected sessions off the calendar, as one action
// ---------------------------------------------------------------------------

// While an injury is active, the sessions between now and running again are not sessions the
// runner is going to do. Leaving them sitting there means opening each card, typing a reason,
// skipping it, and doing that four or six times for something the app already knows - and then
// watching them land in the missed-session count as if training had quietly slipped.
//
// So the app offers the whole set in one action. Deliberately conservative about what it will
// take off the calendar on the runner's behalf:
//   - only days that are still ahead (a past day is history, and may already be logged),
//   - only while running genuinely has not resumed,
//   - never a race day, which is a decision no button should make for someone,
//   - never a day that already carries a real log of any kind.
// And every one of them is reversible as a group, because "I feel much better already" is a
// completely normal thing to happen two days later.
export function sessionsToRestDuringInjury(rtr, weeks, todayStr){
  if(!rtr || rtr.phase !== 'resting') return [];
  const today = todayStr || dateToYMD(new Date());
  const until = rtr.injury && rtr.injury.expectedReturnDate;
  const out = [];
  (weeks||[]).forEach(w=>{
    (w.days||[]).forEach(d=>{
      if(!d || !d.tag) return;
      if(d.type === 'race' || d.type === 'open') return;
      const km = d.data ? (parseFloat(d.data.totalKm) || parseFloat(d.data.km) || 0) : 0;
      if(!km) return;
      const ymd = dayTagToYMD(d.tag, weeks);
      if(!ymd || ymd < today) return;
      // With a stated return date, rest up to the day before it. Without one, the runner has
      // said only that they are not running now - so this offers the rest of the current week
      // rather than blanking out a month on an assumption they never made.
      if(until ? (ymd >= until) : (daysBetween(today, ymd) > 6)) return;
      out.push({weekN: w.n, dayTag: d.tag, name: d.name || d.type, type: d.type, date: ymd});
    });
  });
  return out.sort((a,b)=> a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

function dayTagToYMD(tag, weeks){
  try{
    const d = parseDayTagDate(tag, weeks);
    return d ? dateToYMD(d) : null;
  }catch(e){ return null; }
}

// What the "take these off my calendar" action would actually touch, and what it has already
// taken off. Read at state-refresh time so the banner, the chat callout and the action itself
// all work from one answer instead of each deciding for itself which sessions are affected.
export async function buildRestOffer(injury, restingRtr, todayStr){
  const today = todayStr || dateToYMD(new Date());
  const { loadWorkoutLog } = await import('../ui/week-view.js');
  const candidates = restingRtr ? sessionsToRestDuringInjury(restingRtr, state.WEEKS, today) : [];
  const pending = [], rested = [];
  for(const c of candidates){
    let log = null;
    try{ log = await loadWorkoutLog(c.weekN, c.dayTag); }catch(e){}
    // Already logged in any way - completed, swapped, or skipped for the runner's own reason -
    // is not something a bulk action gets to touch.
    if(log && (log.completed || log.swapped)) continue;
    if(log && log.skipped) continue;
    pending.push(c);
  }
  // Anything this injury already put to rest, still in the future, so it can be handed back.
  for(const w of (state.WEEKS||[])){
    for(const d of (w.days||[])){
      if(!d || !d.tag) continue;
      let log = null;
      try{ log = await loadWorkoutLog(w.n, d.tag); }catch(e){}
      if(!log || !log.injuryRest) continue;
      if(injury && log.injuryRestId && injury.id && log.injuryRestId !== injury.id) continue;
      const ymd = dayTagToYMD(d.tag, state.WEEKS);
      if(!ymd || ymd < today) continue;
      rested.push({weekN: w.n, dayTag: d.tag, name: d.name || d.type, date: ymd});
    }
  }
  return {pending, rested};
}

// The pre-injury baseline is snapshotted once, when the injury opens, and every volume cap in
// the return is a percentage of it - so a wrong one quietly mis-sizes the whole ramp and keeps
// doing so for weeks. An injury opened before the baseline search learned to stay inside the
// current block can be holding a figure from a PREVIOUS block: this runner's record was
// carrying 45.7km/19km taken from week n=3, training that belonged to a finished goal, while
// the live block does not reach that volume until months in.
//
// Re-derived once, in place, rather than left for the runner to notice. Only ever when the
// stored baseline genuinely points outside the current block and a better week exists - a
// baseline that is merely different is not wrong, and silently rewriting it would be worse
// than the bug.
async function healBaselineOutsideBlock(injury){
  try{
    const blockStartN = (state.goalConfig||{}).blockStartWeekN;
    if(blockStartN==null || injury.baselineFromWeekN==null) return injury;
    if(injury.baselineFromWeekN >= blockStartN) return injury;
    const fresh = preInjuryBaselineFromPlan(injury.startDate);
    if(fresh.fromWeekN==null || fresh.fromWeekN < blockStartN || !fresh.weeklyKm) return injury;
    const full = await loadInjuryStatusFull();
    if(!full.current || full.current.id !== injury.id) return injury;
    const healed = Object.assign({}, full.current, {
      preInjuryWeeklyKm: fresh.weeklyKm,
      preInjuryLongRunKm: fresh.longRunKm,
      baselineFromWeekN: fresh.fromWeekN,
      baselineHealedAt: new Date().toISOString(),
    });
    await saveWithRetry(INJURY_STATUS_KEY, {current: healed, past: full.past}, false);
    return healed;
  }catch(e){ console.error('healBaselineOutsideBlock failed', e); return injury; }
}
