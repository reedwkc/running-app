// @ts-nocheck
// Turns a sentence into a plan spec, in one small call.
//
// A free-text request ("give me a winter maintenance block", "ease the next month back, I have
// been travelling") does contain a real judgment: how many weeks this should touch, how much
// volume it should carry, whether it is even a plan change at all. That is a genuine job for a
// language model. Writing out fifty week objects afterwards is not - plan-generator.js does
// that deterministically and for free.
//
// So this module asks for the SPEC and nothing else. The difference in what that costs is the
// whole point of the rebuild:
//
//   before: the entire plan as JSON (every day of every week, thousands of tokens), the full
//           methodology reference, the personalization context, the audit rules, the recipe
//           catalogue - then an outline call, seven expansion calls, and up to four repair
//           rounds, each one carrying all of it again.
//   now:    a compact table of the block (one line per week), the goals, and a short schema -
//           one call, a few hundred tokens of output, no repair rounds possible because there
//           is nothing left for the model to get structurally wrong.
//
// The model can also answer "custom", which sends the request down the original week-writing
// path. Nothing has been taken away: an ask the spec genuinely cannot express - reorder these
// two specific days, change just this one session's rep count - still works exactly as it did.
import { state } from '../state.js';
import { blockRelativeWeekN, defaultGoalConfig } from '../data/goal-config.js';
import { computeWeekPlannedKm, materializeWeek } from '../data/plan.js';
import { fetchCoachReply } from './chat.js';
import { CUTBACK_MAX_GAP, MAX_WEEKLY_RAMP } from './plan-audit.js';
import { TRAINING_DAYS } from './plan-generator.js';

export const PLAN_INTENT_MARKER = 'PLAN INTENT:';

// One line per week: everything a spec decision actually depends on, and nothing else. This
// replaces sending the full plan JSON, which for a year-long block ran to tens of thousands of
// tokens of session detail the model was never going to reason about - it only ever needed to
// know the SHAPE it was changing.
export function buildPlanTable(weeks, goalConfig){
  const cfg = goalConfig || state.goalConfig || defaultGoalConfig();
  return (weeks||[]).map(w => {
    let km = 0;
    try{ km = computeWeekPlannedKm(materializeWeek(w)); }catch(e){}
    const days = w.days || [];
    const q = days.filter(d => d.type === 'threshold' || d.type === 'vo2max').length;
    const long = days.find(d => d.type === 'long');
    let longKm = 0;
    if(long){ try{ longKm = parseFloat((materializeWeek(w).days.find(d => d.type === 'long')||{}).data.totalKm) || 0; }catch(e){} }
    const race = days.find(d => d.type === 'race');
    return 'w' + blockRelativeWeekN(w.n, cfg) + ' (n' + w.n + ') ' + w.dates + (w.year ? (' ' + w.year) : '') +
      ' ' + (w.phase || '-') + (w.cutback ? ' CUTBACK' : '') + (race ? (' RACE:' + race.name) : '') +
      ' ' + Math.round(km) + 'km, ' + q + ' quality, long ' + Math.round(longKm) + 'km';
  }).join('\n');
}

export function buildPlanIntentSystemPrompt(weeks, goalConfig, extraContext){
  const cfg = goalConfig || state.goalConfig || defaultGoalConfig();
  const goals = (cfg.activeGoals||[]).map(g =>
    '- ' + (g.label||g.zoneKey) + ': ' + (g.goalTimeLabel||'no target') + ' on ' + (g.raceDate||'no date') +
    ' (' + (g.distanceKm||'?') + 'km, goalId "' + g.goalId + '", zoneKey "' + g.zoneKey + '")').join('\n') || '- none';

  return [{type: 'text', text:
'You are this runner\'s coach, deciding WHAT SHOULD CHANGE about their training plan. You do not write the plan itself - the app builds the weeks from your decision, deterministically, and it already knows how to place sessions, ramp volume, space hard days and schedule cutbacks. Your job is the judgment: how much, how long, how hard, or whether anything should change at all.\n\n' +
'THE RUNNER\'S WEEK\n' +
'Four training days: ' + TRAINING_DAYS.join('/') + '. Long run Saturday, quality Wednesday and (when there are two) Monday, Thursday always easy. The app will not change this and you should not ask it to.\n\n' +
'GOALS\n' + goals + '\n\n' +
'THE BLOCK AS IT STANDS (w = the week number the runner sees, n = the internal key)\n' + blockTable(weeks, cfg) + '\n\n' +
(extraContext ? (extraContext + '\n\n') : '') +
'WHAT THE APP GUARANTEES WITHOUT YOU\n' +
'- Volume never climbs more than ' + Math.round(MAX_WEEKLY_RAMP*100) + '% over the previous build week. This is why a big change needs WEEKS: going from 30km to 50km takes six of them, and asking for it in two is not something the app will do.\n' +
'- A cutback week at least every ' + CUTBACK_MAX_GAP + ' build weeks, and a real one.\n' +
'- Every week carries quality work unless it is a rest week, an injury quality-hold week, or post-race recovery.\n' +
'- No two hard days back to back; the long run stays under 40% of its week.\n' +
'- Session variety: the app rotates threshold reps, tempo, ladders, surges, hills, VO2max and fartlek through the block on its own.\n' +
'- The last weeks of any range you give are used to hand back cleanly to the untouched weeks after them. You do not need to plan that join - say where the change should START and roughly how long it should last, and the app computes the rest.\n\n' +
'YOUR REPLY\n' +
'First, 1-3 plain sentences for the runner explaining what you are changing and why. Then, on its own line, exactly "' + PLAN_INTENT_MARKER + '" followed by one JSON object:\n' +
'{"action":"rebuild","fromWeek":<display week number to start at>,"weeks":<how many weeks this should cover, or null to let the app decide>,"openingKm":<weekly km the first changed week should carry>,"peakKm":<a ceiling the volume should not pass, or null>,"qualityPerWeek":1 or 2 or null,"restWeeks":<weeks with no running at all, usually 0>,"qualityHoldWeeks":<weeks of easy running only, usually 0>,"longCapKm":<long-run ceiling in km, or null>,"callout":"<one short sentence shown on the first changed week>","goalConfigPatch":null}\n\n' +
'"action" is one of:\n' +
'- "rebuild" - the weeks should change. Fill in the fields above.\n' +
'- "goal" - only the race target changes, not the training. Supply "goalConfigPatch" with {"activeGoals":[{...}]} using the EXACT field names shown in GOALS above (goalId, zoneKey, label, raceName, distanceKm, raceDate, goalTimeSec, goalTimeLabel, goalPaceSec, goalPaceLabel). Keep goalId identical to the existing one - the plan\'s own race day links to it.\n' +
'- "none" - nothing should change. Say why in your reply; this is a real answer, not a failure.\n' +
'- "custom" - the request is about specific individual sessions or day placement (swap these two days, change this one session\'s reps, remove that session), which a volume-and-shape spec cannot express. The app will then take a different, slower route - so only choose it when the request genuinely is about named individual days.\n\n' +
'Choose openingKm honestly against the table: the week before the change already has a volume, and the first changed week is one ordinary step from it, not a leap. If the runner is asking for something much bigger or much smaller than where they are, that is what "weeks" is for.\n' +
'Nothing after the JSON object.'
  }];
}

function blockTable(weeks, cfg){
  return buildPlanTable(weeks, cfg);
}

// Pulls the JSON object out of the reply, keeping whatever prose came before it - the coach's
// own explanation is what the runner reads on the proposal card.
export function parsePlanIntent(text){
  if(!text) return {ok: false, reason: 'no-text', prose: ''};
  const idx = text.indexOf(PLAN_INTENT_MARKER);
  const prose = (idx === -1 ? text : text.slice(0, idx)).trim();
  if(idx === -1) return {ok: false, reason: 'no-marker', prose};
  const raw = text.slice(idx + PLAN_INTENT_MARKER.length);
  const fb = raw.indexOf('{'), lb = raw.lastIndexOf('}');
  if(fb === -1 || lb <= fb) return {ok: false, reason: 'no-json', prose};
  try{ return {ok: true, intent: JSON.parse(raw.slice(fb, lb + 1)), prose}; }
  catch(e){ return {ok: false, reason: 'bad-json', prose}; }
}

// Maps the model's display-numbered, loosely-typed answer onto the generator's spec. Every
// field is clamped to something sane here rather than trusted: this is the one place a bad
// number could still reach the plan, and a spec is small enough to check completely.
export function intentToSpec(intent, ctx){
  const {weeks, currentWeekN, blockEndN, toN, joinKm, goalActive} = ctx;
  const num = (v, lo, hi, dflt) => {
    const x = parseFloat(v);
    if(!isFinite(x)) return dflt;
    return Math.min(hi, Math.max(lo, x));
  };
  return {
    weeks,
    fromN: ctx.fromN,
    toN,
    openingKm: num(intent.openingKm, 5, 200, ctx.fallbackOpeningKm),
    joinKm,
    peakKm: intent.peakKm != null ? num(intent.peakKm, 10, 250, null) : null,
    longCapKm: intent.longCapKm != null ? num(intent.longCapKm, 5, 60, null) : null,
    restWeeks: Math.round(num(intent.restWeeks, 0, Math.max(0, toN - ctx.fromN), 0)),
    qualityHoldWeeks: Math.round(num(intent.qualityHoldWeeks, 0, 6, 0)),
    qualityPerWeek: (intent.qualityPerWeek === 1 || intent.qualityPerWeek === 2) ? intent.qualityPerWeek : null,
    goalActive,
    callout: typeof intent.callout === 'string' && intent.callout.length < 220 ? intent.callout : null,
    goalConfigPatch: intent.goalConfigPatch || null,
  };
}

// The one model call this whole path costs.
export async function requestPlanIntent(userRequest, weeks, goalConfig, extraContext){
  const system = buildPlanIntentSystemPrompt(weeks, goalConfig, extraContext);
  const data = await fetchCoachReply(system, userRequest, 'plan-override');
  const text = (data.content||[]).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return Object.assign({raw: text, truncated: data.stop_reason === 'max_tokens'}, parsePlanIntent(text));
}
