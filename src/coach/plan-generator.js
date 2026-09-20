// @ts-nocheck
// Builds training weeks in code, deterministically, so that a plan change is arithmetic
// rather than a negotiation.
//
// WHY THIS EXISTS
//
// Every plan change used to be written by the language model: it was handed the whole plan
// plus a long list of rules, asked to emit week JSON, and then the result was measured
// against plan-audit.js. When the audit found a problem the model was asked to fix it, up to
// three times, and if it still failed, nothing was applied at all. A year-long block cost an
// outline call, seven expansion calls, and up to four whole-block repair rounds - each one
// carrying a system prompt of tens of kilobytes - and could still end with "nothing has been
// changed" after several minutes and a lot of money.
//
// But look at what the audit actually checks: volume never rising more than 10% over the
// previous build week, a cutback at least every four build weeks and at least 12% deep, no
// two hard days in a row, the long run under 40% of its week, quality work present and
// progressing, a real taper. Those are not judgment calls. Every one of them is a constraint
// a generator can satisfy BY CONSTRUCTION, in milliseconds, for free. Asking a model to
// rediscover them by trial and error - and paying per attempt - was solving an arithmetic
// problem with a slot machine.
//
// So the arithmetic is done here. The model's remaining job (coach/plan-intent.js) is to turn
// a sentence into a small spec: how many weeks, how much volume, how hard. That is a job it
// is genuinely good at and which costs a few hundred tokens once.
//
// WHAT THIS GUARANTEES
//
// The weeks this module returns pass plan-audit.js's block audit and validatePlanOverride's
// hard checks, by construction rather than by inspection - see plan-generator.test.js, which
// asserts exactly that over injury returns, rebalances, pushes and long rebuilds.
import { computeWeekPlannedKm, materializeDay } from '../data/plan.js';
import { dateToTag, dateToYMD, parseDayTagDate, parseWeekStartDate } from '../lib/dates.js';
import { CUTBACK_MAX_GAP, MAX_WEEKLY_RAMP } from './plan-audit.js';

// This runner's standing week. Thursday is deliberately never a hard day: Wednesday and
// Thursday are consecutive, and the audit (rightly) fails two hard days in a row - so the
// hard slots are Monday, Wednesday and Saturday, and Thursday carries the week's second
// easy/medium-long run. Encoding it here rather than hoping a model remembers is the
// difference between a rule and a suggestion.
export const TRAINING_DAYS = ['Mon', 'Wed', 'Thu', 'Sat'];
export const LONG_RUN_DAY = 'Sat';
export const EASY_ONLY_DAY = 'Thu';
// One quality session goes on Wednesday; a second one goes on Monday. Matches how this
// block has always been laid out, and keeps Saturday's long run two clear days from Wednesday.
export const PRIMARY_QUALITY_DAY = 'Wed';
export const SECOND_QUALITY_DAY = 'Mon';

// A cutback cuts 18%, not the 12% minimum the audit accepts. Sitting exactly on a limit means
// any rounding in the session arithmetic can push a week just under it; more importantly, a
// 12% cutback is barely a cutback - the point of the week is recovery, not compliance.
export const CUTBACK_FACTOR = 0.82;
// Long run as a share of its week. The audit's hard ceiling is 40% and plan-override's
// four-day-week guideline warns at 40%; 33% leaves real room for both.
export const LONG_RUN_SHARE = 0.33;
export const MIN_EASY_KM = 4;
export const MIN_LONG_KM = 5;
// A low-volume week runs on fewer days, not on four tiny ones.
//
// Four days with a sensible floor under each is around 17km however small the target is, so a
// first week back at 11km came out at 15.5 - the ramp's opening volume silently overridden by
// the shape of the week. Fewer days is also the right answer on its own terms: every-other-day
// running is normal and correct early in a return, and it is what the old injury prompt asked
// for in prose without anything enforcing it.
export const DAYS_BY_VOLUME = [
  {underKm: 12, days: ['Wed', 'Sat']},
  {underKm: 20, days: ['Mon', 'Wed', 'Sat']},
];
// A rebuild never rewrites more than this many weeks, whatever the arithmetic asks for.
//
// Sixteen, because that is what the arithmetic of a real return actually needs. Coming back at
// 21km into a block that expects 50km is a 2.4x climb, and at 10% a week with the cutbacks the
// cadence forces along the way, that is fourteen weeks - there is no shorter legal path, and
// pretending otherwise just moves the spike somewhere the runner will meet it on a Saturday.
// Capped all the same: past this the honest report is that the weeks beyond still step up (see
// seamStepPct, which the caller says out loud), not a silent rewrite of the rest of the year.
export const MAX_SCOPE_WEEKS = 16;
// Volume the ramp aims to hand the first untouched week, as a fraction of that week. Below
// 1/1.10 so the seam clears the 10% rule with margin instead of landing exactly on it.
export const JOIN_TARGET_FACTOR = 1 / 1.06;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = v => Math.round(v * 10) / 10;
// Build-week volumes are rounded DOWN, never to nearest. Two independently rounded numbers can
// sit 10.03% apart when the unrounded pair sat exactly 10% apart - and the audit measures the
// rounded ones, so "round to nearest" quietly manufactures the very spike the curve exists to
// avoid. Caught by the generator test asserting the ratio directly.
const floor1 = v => Math.floor(v * 10) / 10;
const roundHalf = v => Math.round(v * 2) / 2;

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

// The day tag ("Wed - Oct 7") for a weekday inside an existing week. Derived from the week's
// own start date rather than assumed, so a week that starts on something other than Monday,
// or one that crosses a year boundary, still lands on real dates. Returns null when the week
// carries no parseable date range - the caller then skips that day rather than inventing one.
// Which day of the week each name is, so the offset can be arithmetic. Walking the seven days
// and asking each one to format its own weekday name cost fourteen locale conversions per
// call, and this is now called a few hundred times per rebuild (every day of every week is
// checked against today) - enough to turn a 250ms rebuild into a five-second one. Measured,
// not guessed: 0.58ms a call before, 0.003ms after.
const JS_DAY_INDEX = {Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6};
const weekdayTagCache = new Map();
export function weekdayTag(week, weekday){
  if(!week) return null;
  const key = (week.dates || '') + '|' + (week.year || '') + '|' + weekday;
  if(weekdayTagCache.has(key)) return weekdayTagCache.get(key);
  let tag = null;
  const start = parseWeekStartDate(week);
  const target = JS_DAY_INDEX[weekday];
  if(start && target != null){
    const d = new Date(start);
    d.setDate(start.getDate() + ((target - start.getDay() + 7) % 7));
    tag = dateToTag(d);
  }
  weekdayTagCache.set(key, tag);
  return tag;
}

// The calendar date of a day inside a week, as YYYY-MM-DD.
export function dayYMD(week, day){
  try{
    const d = parseDayTagDate(day.tag, [week]);
    return d ? dateToYMD(d) : null;
  }catch(e){ return null; }
}

// The first week a rebuild may start from: the first one with a training day that has not
// already happened.
//
// A rebuild starts at "the current week", and the current week is usually half gone. Nothing
// stopped the generator rewriting Monday's session on Sunday - it had no concept of today at
// all - so a rebuild run at the end of a week produced four sessions dated into the past,
// which is meaningless on its own terms and was then correctly rejected by the validator's
// "not expected to resume running until X" check. Reported live, and it is the same bug
// whether or not an injury is involved: a plan may not reschedule a day that is gone.
export function firstRebuildableWeekN(weeks, fromN, todayYMD, trainingDays){
  const today = todayYMD || dateToYMD(new Date());
  const days = trainingDays || TRAINING_DAYS;
  const sorted = (weeks || []).filter(w => w.n >= fromN).sort((a, b) => a.n - b.n);
  for(const w of sorted){
    const hasFutureSlot = days.some(wd => {
      const tag = weekdayTag(w, wd);
      if(!tag) return false;
      const ymd = dayYMD(w, {tag});
      return ymd && ymd >= today;
    });
    if(hasFutureSlot) return w.n;
  }
  return null;
}

// Leading weeks from `fromN` that carry no day running has resumed by. The generator works
// this out for itself per week; scopeToJoin needs the same count up front so its ramp
// simulation starts where the running actually starts.
export function restWeeksBefore(weeks, fromN, runFromYMD, trainingDays){
  if(!runFromYMD) return 0;
  const days = trainingDays || TRAINING_DAYS;
  let count = 0;
  for(let n = fromN; ; n++){
    const w = (weeks || []).find(x => x.n === n);
    if(!w) break;
    const runnable = days.some(wd => {
      const tag = weekdayTag(w, wd);
      const ymd = tag && dayYMD(w, {tag});
      return ymd && ymd >= runFromYMD;
    });
    if(runnable) break;
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Measuring what was built
// ---------------------------------------------------------------------------

// A day's real prescribed distance, computed the same way the app computes it - through the
// recipe against live zones. This is what makes the volume curve honest: the generator sizes
// easy days from what the quality sessions and long run ACTUALLY come to, not from an
// estimate of what they probably come to. Falls back to a rough figure only if zones aren't
// loaded (which is really only the case in a bare unit test).
const measuredKm = new WeakMap();
export function measureDayKm(day){
  if(!day || day.type === 'open') return 0;
  if(measuredKm.has(day)) return measuredKm.get(day);
  const km = measureDayKmUncached(day);
  measuredKm.set(day, km);
  return km;
}
function measureDayKmUncached(day){
  try{
    const m = materializeDay(day);
    const data = m && m.data;
    if(data){
      const km = data.totalKm != null ? parseFloat(data.totalKm) : parseFloat(data.km);
      if(isFinite(km)) return km;
    }
  }catch(e){ /* fall through to the estimate */ }
  const a = (day.recipe && day.recipe.args) || {};
  if(a.km != null) return parseFloat(a.km) || 0;
  if(Array.isArray(a.segments)) return a.segments.reduce((s, x) => s + (x.km || 0), 0);
  if(a.reps && a.repM) return (a.wuKm || 0) + (a.cdKm || 0) + a.reps * a.repM / 1000;
  return (a.wuKm || 0) + (a.cdKm || 0);
}

const weekKmOf = week => (week.days || []).reduce((s, d) => s + measureDayKm(d), 0);

// Shaves an overshoot off the easy running, largest day first, down to the minimum each may
// carry. The feedback pass above gets a week very close to its cap; this closes the last few
// hundred metres exactly, because "very close" to a limit the audit measures is still over it.
function trimEasyToCap(days, excessKm){
  let left = excessKm;
  const easy = days.filter(d => d.type === 'easy' && d.recipe && d.recipe.args)
    .sort((a, b) => (b.recipe.args.km || 0) - (a.recipe.args.km || 0));
  for(const d of easy){
    if(left <= 0.001) break;
    const km = d.recipe.args.km || 0;
    const take = Math.min(left, Math.max(0, km - MIN_EASY_KM));
    if(take <= 0) continue;
    d.recipe.args.km = round1(km - take);
    measuredKm.delete(d);   // the day just changed - its cached distance is now a lie
    left -= take;
  }
  return left;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

// Warm-up and cool-down scale with the week. A fixed 2km/1.5km pair is right for a 50km week
// and absurd for an 18km first week back from injury, where it would be most of the session.
function warmup(weekKm){
  const wuKm = roundHalf(clamp(weekKm * 0.045, 1.5, 3));
  return {wuKm, cdKm: roundHalf(clamp(wuKm * 0.7, 1, 2))};
}

function thresholdRepsDay(tag, weekKm, repM){
  const {wuKm, cdKm} = warmup(weekKm);
  const meters = clamp(weekKm * 1000 * 0.115, 2400, 10000);
  const reps = clamp(Math.round(meters / repM), 3, 8);
  return {
    tag, name: 'Threshold ' + reps + ' x ' + repM + 'm', zone: 'S4', type: 'threshold',
    recipe: {fn: 'threshold', args: {reps, repM, recoverySec: repM >= 1500 ? 120 : 90, recoveryLabel: 'jog', wuKm, cdKm}},
  };
}

function continuousTempoDay(tag, weekKm, zone){
  const {wuKm, cdKm} = warmup(weekKm);
  const totalMin = clamp(Math.round(weekKm * 0.42), 12, 40);
  const goal = zone === 'GOAL';
  return {
    tag, name: goal ? ('Goal-pace tempo - ' + totalMin + ' min') : ('Continuous tempo - ' + totalMin + ' min'),
    zone: goal ? 'GOAL' : 'S4', type: 'threshold',
    recipe: {fn: 'continuousTempo', args: {totalMin, wuKm, cdKm, zone: goal ? 'GOAL' : 'S4'}},
  };
}

function vo2maxDay(tag, weekKm){
  const {wuKm, cdKm} = warmup(weekKm);
  const reps = clamp(Math.round(weekKm / 9), 4, 7);
  return {
    tag, name: 'VO2max ' + reps + ' x 3min', zone: 'S5', type: 'vo2max',
    recipe: {fn: 'vo2max', args: {reps, repMin: 3, recoveryMin: 2.5, wuKm, cdKm}},
  };
}

function hillRepeatsDay(tag, weekKm){
  const {wuKm, cdKm} = warmup(weekKm);
  const reps = clamp(Math.round(weekKm / 6), 6, 12);
  return {
    tag, name: 'Hill repeats ' + reps + ' x 60s', zone: 'S5', type: 'vo2max',
    recipe: {fn: 'hillRepeats', args: {reps, repSec: 60, recoveryLabel: 'jog/walk back down', wuKm, cdKm}},
  };
}

function fartlekDay(tag, weekKm){
  const {wuKm, cdKm} = warmup(weekKm);
  const totalMin = clamp(Math.round(weekKm * 0.38), 12, 35);
  return {
    tag, name: 'Fartlek - ' + totalMin + ' min', zone: 'S5', type: 'vo2max',
    recipe: {fn: 'fartlek', args: {totalMin, wuKm, cdKm}},
  };
}

function ladderDay(tag, weekKm){
  const {wuKm, cdKm} = warmup(weekKm);
  // One rung count for a small week, one for a big one - the ladder's shape is the point, and
  // scaling every rung independently just produces odd distances.
  const distancesM = weekKm >= 45 ? [400, 800, 1200, 1600, 1200, 800, 400] : [400, 800, 1200, 800, 400];
  return {
    tag, name: 'Ladder ' + distancesM.join('-') + 'm', zone: 'S4', type: 'threshold',
    recipe: {fn: 'ladderReps', args: {distancesM, recoverySec: 90, recoveryLabel: 'jog', wuKm, cdKm, zone: 'S4'}},
  };
}

function surgesDay(tag, weekKm){
  const {wuKm, cdKm} = warmup(weekKm);
  const reps = clamp(Math.round(weekKm / 5), 6, 12);
  return {
    tag, name: 'Alternating surges ' + reps + ' x 60/60', zone: 'S4', type: 'threshold',
    recipe: {fn: 'alternatingSurges', args: {reps, workSec: 60, floatSec: 60, workZone: 'S4', wuKm, cdKm}},
  };
}

function easyDay(tag, km, strides){
  const name = strides ? 'Easy + strides' : (km >= 11 ? 'Medium-long run' : 'Easy run');
  return {
    tag, name, zone: 'S2', type: 'easy',
    recipe: {fn: 'easyS', args: strides ? {km: round1(km), strides} : {km: round1(km)}},
  };
}

function longRunDay(tag, totalKm, fastKm, fastZone){
  const fast = Math.min(roundHalf(fastKm || 0), Math.max(0, roundHalf(totalKm) - 4));
  const base = roundHalf(totalKm) - fast;
  const segments = fast > 0 ? [{km: base, zone: 'S2'}, {km: fast, zone: fastZone}] : [{km: base, zone: 'S2'}];
  return {
    tag, name: fast > 0 ? 'Long run with ' + fast + 'km finish' : 'Long run',
    zone: fast > 0 ? ('S2-' + fastZone) : 'S2', type: 'long',
    recipe: {fn: 'longRun', args: {segments}},
  };
}

function openDay(tag, note){
  return {tag, name: 'Rest', zone: '', type: 'open', data: {}, note: note || undefined};
}

// The rotation of session shapes each phase draws on, in order, one per week.
//
// It exists for two reasons that happen to point the same way. Training-wise, the same
// session every week for three months is how a block goes stale, and this app already
// implements a real catalogue of alternatives (hills, fartlek, ladders, surges, continuous
// tempo) that nothing was systematically using. Audit-wise, rotating the shape guarantees the
// week's quality minutes actually MOVE from week to week, which is precisely what the
// flat-progression check looks for - so variety and compliance are the same act.
const PRIMARY_ROTATION = {
  base:      [w => thresholdRepsDay(w.tag, w.km, 1000), w => continuousTempoDay(w.tag, w.km, 'S4'), w => thresholdRepsDay(w.tag, w.km, 1200)],
  strength:  [w => thresholdRepsDay(w.tag, w.km, 1000), w => ladderDay(w.tag, w.km), w => thresholdRepsDay(w.tag, w.km, 1200), w => continuousTempoDay(w.tag, w.km, 'S4')],
  threshold: [w => thresholdRepsDay(w.tag, w.km, 1200), w => surgesDay(w.tag, w.km), w => thresholdRepsDay(w.tag, w.km, 1500), w => continuousTempoDay(w.tag, w.km, 'S4')],
  specific:  [w => thresholdRepsDay(w.tag, w.km, 1500), w => (w.goalActive ? continuousTempoDay(w.tag, w.km, 'GOAL') : continuousTempoDay(w.tag, w.km, 'S4')), w => thresholdRepsDay(w.tag, w.km, 2000)],
  taper:     [w => thresholdRepsDay(w.tag, w.km, 1000)],
};
const SECOND_ROTATION = {
  base:      [w => vo2maxDay(w.tag, w.km), w => hillRepeatsDay(w.tag, w.km)],
  strength:  [w => vo2maxDay(w.tag, w.km), w => hillRepeatsDay(w.tag, w.km), w => fartlekDay(w.tag, w.km)],
  threshold: [w => vo2maxDay(w.tag, w.km), w => thresholdRepsDay(w.tag, w.km, 1000)],
  specific:  [w => vo2maxDay(w.tag, w.km), w => thresholdRepsDay(w.tag, w.km, 1200)],
  taper:     [w => vo2maxDay(w.tag, w.km)],
};

function rotationFor(table, phase, idx, ctx){
  const list = table[phase] || table.base;
  return list[idx % list.length](ctx);
}

// How much of the long run is run faster than easy, and at which pace. The long run
// progresses on two axes - distance and fast portion - and past a point a half-marathon block
// grows the second rather than the first, which is exactly what the audit's two-axis
// flat-run check is written around.
function longRunFinish(phase, longKm, goalActive){
  if(longKm < 12) return {km: 0, zone: 'S3'};
  if(phase === 'specific' || phase === 'taper') return {km: roundHalf(longKm * 0.3), zone: goalActive ? 'GOAL' : 'S3'};
  if(phase === 'threshold') return {km: roundHalf(longKm * 0.25), zone: 'S3'};
  if(phase === 'strength') return {km: roundHalf(longKm * 0.22), zone: 'S3'};
  return {km: roundHalf(longKm * 0.18), zone: 'S3'};
}

// ---------------------------------------------------------------------------
// The volume curve
// ---------------------------------------------------------------------------

// Where the cutback weeks fall. Counts build weeks from BEFORE the rebuilt stretch too
// (`buildWeeksBefore`), so the cadence keeps running across the seam instead of restarting -
// a rebuild that begins right after three build weeks gets its cutback in week two, not week
// five. Never places one in the final slot: the last rebuilt week is what hands back to
// untouched training, and it should be a real week.
export function placeCutbacks(slots, buildWeeksBefore, maxGap){
  const gap = maxGap || CUTBACK_MAX_GAP;
  let since = buildWeeksBefore || 0;
  return slots.map((slot, i) => {
    if(slot.kind === 'rest' || slot.kind === 'race'){ since = 0; return slot.kind; }
    if(slot.forceCutback){ since = 0; return 'cutback'; }
    if(since >= gap && i < slots.length - 1){ since = 0; return 'cutback'; }
    since++;
    return 'build';
  });
}

// The weekly volume for each slot: an even geometric ramp across the build weeks, cutbacks
// taken off the build week before them, rest weeks at zero, race weeks left as they are.
//
// The ramp is even rather than "climb at the ceiling then sit flat" on purpose. Both reach
// the same place, but a flat stretch is exactly what the long-run and quality progression
// checks read as a stalled block, and an even climb spreads the increase over the whole
// stretch instead of front-loading all of it.
//
// Returns `seamStepPct`: how big a step the first untouched week would be from the last build
// week here. The caller uses it to widen the scope rather than to hope - if it exceeds the
// 10% rule, the honest answer is that the rebuild needs more weeks, not a bigger jump.
export function volumeCurve({kinds, slots, openingKm, joinKm, ceilings, maxStepPct}){
  const step = 1 + ((maxStepPct != null ? maxStepPct : MAX_WEEKLY_RAMP * 100) / 100);
  const buildIdx = kinds.map((k, i) => k === 'build' ? i : -1).filter(i => i !== -1);
  const n = buildIdx.length;
  // A per-week ceiling, not one number for the stretch. An injury cap is genuinely per-week -
  // "45% of pre-injury volume, then 65%, then 85%" - and it stops applying once the ramp is
  // over. Holding the whole rebuild down to the ramp's ceiling would make the join weeks
  // unable to climb back to the plan they exist to rejoin, which reads as a rebuild that
  // "can't be done" when what actually happened is that a cap outstayed its welcome.
  const ceilingAt = i => (ceilings && ceilings[i] != null) ? ceilings[i] : Infinity;
  const lastCeiling = ceilingAt(kinds.length - 1);
  let endTarget = openingKm;
  if(n > 1){
    const natural = openingKm * Math.pow(step, n - 1);
    const wanted = joinKm != null ? joinKm * JOIN_TARGET_FACTOR : natural;
    endTarget = clamp(Math.min(wanted, lastCeiling, natural), openingKm, Infinity);
  }
  const factor = n > 1 ? Math.pow(endTarget / openingKm, 1 / (n - 1)) : 1;
  const km = new Array(kinds.length).fill(0);
  let lastBuild = null;
  let b = 0;
  kinds.forEach((kind, i) => {
    if(kind === 'rest'){ km[i] = 0; return; }
    if(kind === 'race'){ km[i] = slots[i].existingKm || 0; return; }
    if(kind === 'cutback'){ km[i] = round1((lastBuild != null ? lastBuild : openingKm) * CUTBACK_FACTOR); return; }
    // Capped against the PREVIOUS ROUNDED week rather than against the ideal curve - that is
    // what makes the 10% rule hold on the numbers the audit will actually read.
    const ideal = openingKm * Math.pow(factor, b);
    const capped = lastBuild != null ? Math.min(ideal, lastBuild * step) : ideal;
    lastBuild = floor1(Math.min(ceilingAt(i), capped));
    km[i] = lastBuild;
    b++;
  });
  if(lastBuild == null) lastBuild = openingKm;
  const seamStepPct = (joinKm != null && lastBuild > 0) ? ((joinKm / lastBuild) - 1) * 100 : 0;
  return {km, endKm: lastBuild, seamStepPct};
}

// How many calendar weeks a rebuild needs if it is to hand back to `joinKm` without ever
// breaking the 10% rule - rest weeks, the climb itself, and the cutback weeks the cadence
// forces along the way, all counted.
//
// This is the arithmetic that decides how big the scope is, and it belongs next to the curve
// that has to live inside it. Sizing the scope by guesswork and then discovering at audit time
// that it cannot close is precisely the loop that used to cost several model calls to walk.
export function weeksNeededToJoin(openingKm, joinKm, opts){
  const o = opts || {};
  const step = 1 + ((o.maxStepPct != null ? o.maxStepPct : MAX_WEEKLY_RAMP * 100) / 100);
  const rest = Math.max(0, o.restWeeks || 0);
  if(!(openingKm > 0) || !(joinKm > 0)) return rest + 1;
  let km = openingKm, weeks = 1, since = (o.buildWeeksBefore || 0) + 1, guard = 0;
  while(km * step < joinKm && guard++ < 260){
    weeks++;
    if(since >= CUTBACK_MAX_GAP){ since = 0; continue; }   // a cutback week: no progress up
    km = floor1(km * step);
    since++;
  }
  return rest + weeks;
}

/**
 * Where a rebuild should END, given where it starts and what it has to hand back to.
 *
 * Walks forward through the real plan, climbing at the legal rate, and stops at the first week
 * whose SUCCESSOR the ramp can legally reach - so the answer accounts for the actual volumes in
 * the weeks ahead (which are not a smooth curve: there are cutbacks and taper weeks in there),
 * not a projection of them. It is the same arithmetic the curve itself runs, so the scope and
 * its contents can never disagree about whether the join closes.
 *
 * Returns {toN, joinKm, joinN, weeksNeeded, clampedByBlockEnd}.
 */
export function scopeToJoin({weeks, fromN, openingKm, restWeeks, blockEndN, minWeeks, maxWeeks, maxStepPct, buildWeeksBefore, ceilingFor}){
  const step = 1 + ((maxStepPct != null ? maxStepPct : MAX_WEEKLY_RAMP * 100) / 100);
  const endN = blockEndN != null ? blockEndN : Math.max(...weeks.map(w => w.n));
  // Measured through the recipes, exactly as the generator measures its own weeks - a stored
  // week carries no computed data until the app builds it, and reading the raw object would
  // report every week ahead as 0km and declare the seam closed everywhere.
  const kmAt = n => {
    const w = weeks.find(x => x.n === n);
    return w ? round1(weekKmOf(w)) : null;
  };
  const rest = Math.max(0, restWeeks || 0);
  const minSpan = Math.max(rest + 1, minWeeks || 1);
  const maxSpan = Math.max(minSpan, maxWeeks || MAX_SCOPE_WEEKS);
  let km = null, since = (buildWeeksBefore || 0), runningIdx = -1;
  for(let n = fromN; n <= endN; n++){
    const i = n - fromN;
    if(i < rest) continue;                                   // still resting
    runningIdx++;
    if(km == null){ km = openingKm; since++; }
    else if(since >= CUTBACK_MAX_GAP){ since = 0; }          // cutback week: no climb
    else {
      const ceiling = ceilingFor ? ceilingFor(runningIdx) : Infinity;
      km = floor1(Math.min(ceiling != null ? ceiling : Infinity, km * step));
      since++;
    }
    const span = i + 1;
    const nextKm = kmAt(n + 1);
    // Held to the same margin the curve itself aims for (JOIN_TARGET_FACTOR), not to the bare
    // 10% limit. This simulation climbs on ideal numbers; the weeks that actually get built
    // land a little under them once session distances are rounded and easy days are trimmed to
    // their cap. Stopping the moment the IDEAL ramp just reaches the join produced a scope
    // whose real last week fell a fraction short - a seam over the limit by a tenth of a
    // percent, which is still over it.
    const closes = nextKm == null || km >= nextKm * JOIN_TARGET_FACTOR;
    // Stop when the seam closes, or when the rebuild has grown as long as it is allowed to be.
    // A scope that hit its ceiling without closing reports the step it is leaving behind rather
    // than swallowing another three months of the block to hide it.
    if(span >= minSpan && (closes || span >= maxSpan)){
      return {
        toN: n, joinN: n + 1, joinKm: nextKm, weeksNeeded: span,
        clampedByBlockEnd: n >= endN,
        clampedByMaxWeeks: !closes && span >= maxSpan,
        seamStepPct: (nextKm != null && km > 0) ? ((nextKm / km) - 1) * 100 : 0,
      };
    }
  }
  return {toN: endN, joinN: null, joinKm: null, weeksNeeded: endN - fromN + 1, clampedByBlockEnd: true};
}

// ---------------------------------------------------------------------------
// Assembling one week
// ---------------------------------------------------------------------------

// Turns one planned row into real days, then closes the arithmetic: the long run and quality
// sessions are built first, measured through their own recipes, and the easy days are sized
// from whatever volume is left. That ordering is what makes the weekly total actually land on
// its target - sizing easy days from an ESTIMATE of the quality sessions is how a week ends up
// 4km off its own plan and trips the ramp check two weeks later.
function assembleWeek(ctx){
  const {week, targetKm, kind, phase, qualityCount, rotationIdx, goalActive, longCapKm, noQuality, restNote, todayYMD, runFromYMD} = ctx;
  const tagFor = wd => weekdayTag(week, wd);

  // Three kinds of day in a week a rebuild touches, and only the third is the generator's to
  // write:
  //   already happened  - history. Carried through exactly as it stands, whatever it says.
  //   still to come, but before running resumes - an open day.
  //   still to come, and running has resumed by then - generated.
  // Keeping the first category out of the generator's hands is what stops a rebuild run on a
  // Sunday from cheerfully rescheduling that week's Monday.
  const elapsed = (week.days || []).filter(d => {
    const y = dayYMD(week, d);
    return y && todayYMD && y < todayYMD;
  });
  const elapsedTags = new Set(elapsed.map(d => d.tag));
  const slotState = wd => {
    const tag = tagFor(wd);
    if(!tag || elapsedTags.has(tag)) return 'elapsed';
    const ymd = dayYMD(week, {tag});
    if(todayYMD && ymd && ymd < todayYMD) return 'elapsed';
    if(runFromYMD && ymd && ymd < runFromYMD) return 'blocked';
    return 'free';
  };
  const freeDays = TRAINING_DAYS.filter(wd => slotState(wd) === 'free');
  const blockedTags = TRAINING_DAYS.filter(wd => slotState(wd) === 'blocked').map(tagFor).filter(Boolean);

  // Future race days are fixed points tied to a real goal date; past ones are already history
  // above. Either way they are never regenerated.
  const existingRaceDays = (week.days || []).filter(d => d.type === 'race' && !elapsedTags.has(d.tag));

  if(kind === 'rest'){
    const days = elapsed.slice();
    TRAINING_DAYS.filter(wd => slotState(wd) !== 'elapsed').forEach(wd => {
      const t = tagFor(wd);
      if(t) days.push(openDay(t, restNote));
    });
    existingRaceDays.forEach(d => { if(!days.some(x => x.tag === d.tag)) days.push(d); });
    return {days: sortByWeekday(days), noQuality: true};
  }

  const days = elapsed.slice();
  blockedTags.forEach(t => days.push(openDay(t, restNote)));
  existingRaceDays.forEach(d => days.push(d));

  const raceKm = existingRaceDays.reduce((s, d) => s + measureDayKm(d), 0);
  // What history already put in this week counts toward its total, so it comes off the budget
  // the generated days share out - otherwise a half-elapsed week silently lands well over the
  // volume the curve asked for.
  const elapsedKm = elapsed.reduce((s, d) => s + measureDayKm(d), 0);
  const budget = Math.max(0, targetKm - raceKm - elapsedKm);

  // How many days this week actually runs on - see DAYS_BY_VOLUME - intersected with the days
  // still available to write on.
  const shape = (DAYS_BY_VOLUME.find(r => budget < r.underKm) || {days: TRAINING_DAYS}).days;
  const activeDays = freeDays.filter(wd => shape.indexOf(wd) !== -1);

  // Long run
  let longKm = 0;
  const longTag = activeDays.indexOf(LONG_RUN_DAY) !== -1 ? tagFor(LONG_RUN_DAY) : null;
  const raceOnLongDay = existingRaceDays.some(d => d.tag === longTag);
  if(longTag && !raceOnLongDay && budget >= MIN_LONG_KM + MIN_EASY_KM){
    longKm = roundHalf(clamp(budget * LONG_RUN_SHARE, MIN_LONG_KM, longCapKm != null ? longCapKm : Infinity));
    const finish = noQuality ? {km: 0, zone: 'S3'} : longRunFinish(phase, longKm, goalActive);
    days.push(longRunDay(longTag, longKm, finish.km, finish.zone));
  }

  // Quality
  const qualityTags = [];
  const runsOn = wd => activeDays.indexOf(wd) !== -1 && !!tagFor(wd);
  if(!noQuality && qualityCount >= 1 && runsOn(PRIMARY_QUALITY_DAY)) qualityTags.push({wd: PRIMARY_QUALITY_DAY, table: PRIMARY_ROTATION});
  if(!noQuality && qualityCount >= 2 && runsOn(SECOND_QUALITY_DAY)) qualityTags.push({wd: SECOND_QUALITY_DAY, table: SECOND_ROTATION});
  let qualityKm = 0;
  qualityTags.forEach(q => {
    const tag = tagFor(q.wd);
    if(existingRaceDays.some(d => d.tag === tag)) return;
    const day = rotationFor(q.table, phase, rotationIdx, {tag, km: budget, goalActive});
    const km = measureDayKm(day);
    // A quality session that would eat the week has no business in it - better one real
    // session and honest easy volume than two token ones.
    if(qualityKm + km + longKm + MIN_EASY_KM > budget) return;
    qualityKm += km;
    days.push(day);
  });

  // Easy days absorb the remainder
  const used = longKm + qualityKm;
  const easyWeekdays = activeDays
    .filter(wd => !days.some(d => d.tag === tagFor(wd)))
    .map(wd => ({wd, tag: tagFor(wd)}))
    .filter(x => x.tag);
  let remaining = Math.max(0, budget - used);
  if(easyWeekdays.length){
    // Thursday carries the bigger easy run (it is the day with no quality on it, so it is
    // where a medium-long run belongs); anything else splits what is left evenly.
    const thu = easyWeekdays.find(x => x.wd === EASY_ONLY_DAY);
    const others = easyWeekdays.filter(x => x.wd !== EASY_ONLY_DAY);
    const perOther = others.length ? remaining * (thu ? 0.42 : 1) / others.length : 0;
    others.forEach((x, i) => {
      const km = Math.max(MIN_EASY_KM, roundHalf(perOther));
      days.push(easyDay(x.tag, km, (!noQuality && i === 0 && km >= 6) ? 4 : 0));
      remaining -= km;
    });
    if(thu) days.push(easyDay(thu.tag, Math.max(MIN_EASY_KM, roundHalf(remaining)), 0));
  }

  return {days: sortByWeekday(days), noQuality: !!noQuality};
}

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function sortByWeekday(days){
  return days.slice().sort((a, b) =>
    DAY_ORDER.indexOf(String(a.tag).split(' - ')[0]) - DAY_ORDER.indexOf(String(b.tag).split(' - ')[0]));
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/**
 * Builds complete week objects for fromN..toN.
 *
 * Every week in the range must already exist in `weeks` - the generator reuses each week's own
 * `dates`, `year`, `phase` and race days rather than computing a calendar of its own, which is
 * both simpler and the only way a rebuild can be guaranteed to land on the same real dates the
 * runner is already looking at.
 *
 * spec:
 *   weeks              the current plan (state.WEEKS)
 *   fromN, toN         inclusive range to rebuild
 *   openingKm          weekly volume for the first running week
 *   joinKm             volume of the first week AFTER toN, which the ramp must hand back to
 *   peakKm             a ceiling the ramp must not pass (e.g. pre-injury volume)
 *   restWeeks          leading weeks with no running at all
 *   qualityHoldWeeks   weeks after the rest with easy running only
 *   longCapKm          long-run ceiling (a number, or a function of the week index)
 *   qualityPerWeek     1 or 2 (default: 1 in base, 2 elsewhere)
 *   goalActive         whether a GOAL-pace zone means anything right now
 *   callout            a sentence to attach to the first rebuilt week
 *   restNote           the note shown on each rest day
 */
export function generatePlanWeeks(spec){
  const weeks = spec.weeks || [];
  const byN = new Map(weeks.map(w => [w.n, w]));
  const range = [];
  for(let n = spec.fromN; n <= spec.toN; n++){
    const w = byN.get(n);
    if(w) range.push(w);
  }
  if(!range.length) return {weeks: [], rows: [], seamStepPct: 0, notes: ['No existing weeks in that range to rebuild.']};

  const restWeeks = Math.max(0, spec.restWeeks || 0);
  const holdWeeks = Math.max(0, spec.qualityHoldWeeks || 0);
  const todayYMD = spec.todayYMD || dateToYMD(new Date());
  // The first date a NEW session may be placed on. Defaults to today; an injury that has not
  // finished resting pushes it out, and every day before it becomes an open day rather than a
  // session nobody can run.
  const runFromYMD = spec.runFromYMD && spec.runFromYMD > todayYMD ? spec.runFromYMD : todayYMD;

  // A week with nothing left in it is not rebuilt at all. Rewriting a week that has already
  // run is not a plan change, it is rewriting history.
  const live = range.filter(w => TRAINING_DAYS.some(wd => {
    const tag = weekdayTag(w, wd);
    return tag && (dayYMD(w, {tag}) || todayYMD) >= todayYMD;
  }));
  if(!live.length) return {weeks: [], rows: [], seamStepPct: 0, notes: ['Every week in that range has already run.']};

  const slots = live.map((w, i) => {
    const hasRace = (w.days || []).some(d => d.type === 'race');
    // Rest is stated two ways and either is enough: a leading count of weeks the caller asked
    // for, or simply a week with no day in it that running has resumed by.
    const anyRunnableDay = TRAINING_DAYS.some(wd => {
      const tag = weekdayTag(w, wd);
      const ymd = tag && dayYMD(w, {tag});
      return ymd && ymd >= runFromYMD;
    });
    return {
      week: w,
      kind: (i < restWeeks || !anyRunnableDay) ? 'rest' : (hasRace ? 'race' : 'build'),
      existingKm: hasRace ? computeWeekPlannedKmSafe(w) : 0,
      // A taper week already marked in the plan stays a taper week - it is anchored to a race
      // date, not to the cutback cadence.
      forceCutback: !!w.cutback && !hasRace && isTaperish(w, weeks),
    };
  });
  const kindOf = i => slots[i].kind;

  const kinds = placeCutbacks(slots, buildWeeksBefore(weeks, live[0].n), CUTBACK_MAX_GAP);
  // `peakKm` may be a flat number or a function of the running-week index. The function form is
  // what an injury return needs: the cap rises through the ramp and then stops applying, so the
  // join weeks are free to climb back to the plan they are handing off to.
  // Indexed by RUNNING week, counted as they occur, rather than by offset from a rest count -
  // rest can now come from the calendar as well as from a caller's count.
  let ceilIdx = -1;
  const ceilings = live.map((w, i) => {
    if(kindOf(i) !== 'rest') ceilIdx++;
    return ceilingAt(spec.peakKm, Math.max(0, ceilIdx));
  });
  const curve = volumeCurve({
    kinds, slots,
    openingKm: spec.openingKm,
    joinKm: spec.joinKm != null ? spec.joinKm : null,
    ceilings,
    maxStepPct: spec.maxStepPct,
  });

  const built = [];
  const rows = [];
  let rotationIdx = 0;
  const stepCap = 1 + ((spec.maxStepPct != null ? spec.maxStepPct : MAX_WEEKLY_RAMP * 100) / 100);
  // Seeded from the REAL week before the rebuild starts, so the very first rebuilt week is
  // held to the same step rule as every week after it - the seam at the start matters exactly
  // as much as the one at the end.
  let lastBuildActual = (() => {
    const prev = weeks.find(x => x.n === live[0].n - 1);
    if(!prev || prev.cutback || (prev.days||[]).some(d => d.type === 'race')) return null;
    const km = round1(weekKmOf(prev));
    return km > 0 ? km : null;
  })();
  let runningIdx = -1;
  live.forEach((w, i) => {
    const kind = kinds[i];
    const phase = w.phase || inferPhase(w, weeks);
    if(kind !== 'rest') runningIdx++;                       // 0 = first week actually running
    const inHold = kind !== 'rest' && runningIdx >= 0 && runningIdx < holdWeeks;
    const noQuality = kind === 'rest' || inHold;
    const qualityCount = noQuality ? 0
      : (kind === 'cutback' || kind === 'race') ? 1
      : (spec.qualityPerWeek != null ? spec.qualityPerWeek : (phase === 'base' ? 1 : 2));
    const longCapKm = typeof spec.longCapKm === 'function' ? spec.longCapKm(Math.max(0, runningIdx)) : spec.longCapKm;

    // The curve respects the 10% rule on its TARGETS; the audit measures what the sessions
    // actually come to. Those are not the same number - a long run rounded to the nearest half
    // kilometre, a minimum under each easy day, a rep count that had to be a whole number, and
    // two weeks planned exactly 10% apart can land 11.4% apart. Caught on the runner's own
    // block, where it was doing precisely that.
    //
    // So the week is assembled, measured, and if it overshoots what the previous week's REAL
    // volume allows, assembled again against the difference. Two passes is enough: assembly is
    // very nearly linear in its target, the second pass just spends the error.
    // A hair under the limit, and computed off the ROUNDED previous week. Weekly totals are
    // reported to one decimal in several places, and a week that sums to exactly 10.00% over
    // rounds up to 10.1% on the card - sitting precisely on a limit is how a number that is
    // correct becomes a number that reads as broken.
    const cap = (kind === 'build' && lastBuildActual != null) ? (floor1(lastBuildActual * stepCap) - 0.05) : null;
    let assembled = null, target = curve.km[i];
    for(let pass = 0; pass < 3; pass++){
      assembled = assembleWeek({
        week: w,
        targetKm: target,
        kind, phase, qualityCount, rotationIdx,
        goalActive: !!spec.goalActive,
        longCapKm,
        noQuality,
        restNote: spec.restNote,
        todayYMD, runFromYMD,
      });
      if(cap == null) break;
      const actual = weekKmOf({days: assembled.days});
      if(actual <= cap) break;
      const next = target - (actual - cap);
      if(!(next > 0) || Math.abs(next - target) < 0.05){
        // The feedback pass has gone as far as it can. Shave the remainder off the easy
        // running directly - a limit the audit measures has to actually hold, not nearly hold.
        trimEasyToCap(assembled.days, actual - cap);
        break;
      }
      target = next;
    }
    if(cap != null){
      const over = weekKmOf({days: assembled.days}) - cap;
      if(over > 0) trimEasyToCap(assembled.days, over);
    }
    if(!noQuality && kind !== 'race') rotationIdx++;
    if(kind === 'build') lastBuildActual = round1(weekKmOf({days: assembled.days}));

    const out = {
      n: w.n,
      dates: w.dates,
      phase: w.phase || phase,
      cutback: kind === 'cutback' || kind === 'rest' || (kind === 'race' && !!w.cutback),
      days: assembled.days,
      callout: (i === 0 && spec.callout) ? spec.callout : (w.callout || null),
    };
    if(w.year != null) out.year = w.year;
    if(w.race) out.race = w.race;
    // The flag that tells plan-audit.js this week is SUPPOSED to carry no quality work. Stored
    // with the week, so the audit still knows months later - not recomputed from an injury
    // record that will have been resolved by then.
    if(assembled.noQuality) out.noQuality = true;
    built.push(out);
    rows.push({n: w.n, kind, phase, targetKm: curve.km[i], actualKm: round1(weekKmOf(out))});
  });

  // Measured off what was actually BUILT, not off the curve's targets - the seam is the number
  // the runner steps across, so it is reported from the weeks they will actually run.
  const seamStepPct = (spec.joinKm != null && lastBuildActual > 0) ? ((spec.joinKm / lastBuildActual) - 1) * 100 : 0;
  return {weeks: built, rows, seamStepPct, endKm: lastBuildActual, notes: []};
}

// A volume ceiling for one running week: a flat number, a function of the running-week index,
// or nothing at all.
export function ceilingAt(peakKm, runningIdx){
  if(peakKm == null) return null;
  if(typeof peakKm === 'function'){
    const v = peakKm(Math.max(0, runningIdx));
    return (v == null || !isFinite(v)) ? null : v;
  }
  return peakKm;
}

function computeWeekPlannedKmSafe(w){
  try{ return computeWeekPlannedKm(w); }catch(e){ return weekKmOf(w); }
}

// How many build weeks ran immediately before the rebuild starts, so the cutback cadence can
// continue across the seam rather than restarting at zero.
function buildWeeksBefore(weeks, fromN){
  let count = 0;
  for(let n = fromN - 1; n >= 0 && count < CUTBACK_MAX_GAP + 1; n--){
    const w = weeks.find(x => x.n === n);
    if(!w) break;
    if(w.cutback || (w.days || []).some(d => d.type === 'race')) break;
    count++;
  }
  return count;
}

// A cutback week sitting next to a race is a taper, not a cadence cutback - it stays where the
// plan already put it.
function isTaperish(week, weeks){
  const idx = weeks.findIndex(w => w.n === week.n);
  if(idx === -1) return false;
  for(let k = 1; k <= 2; k++){
    const nxt = weeks[idx + k];
    if(nxt && (nxt.days || []).some(d => d.type === 'race')) return true;
    const prv = weeks[idx - k];
    if(prv && (prv.days || []).some(d => d.type === 'race')) return true;
  }
  return false;
}

// Only used when a week carries no phase of its own - reads the phase off the nearest week
// that does, so a generated week never invents a phase label the block doesn't use.
function inferPhase(week, weeks){
  const idx = weeks.findIndex(w => w.n === week.n);
  for(let k = 1; k < weeks.length; k++){
    const before = weeks[idx - k];
    if(before && before.phase) return before.phase;
    const after = weeks[idx + k];
    if(after && after.phase) return after.phase;
  }
  return 'base';
}

// ---------------------------------------------------------------------------
// Describing what was built
// ---------------------------------------------------------------------------

// The runner reads this, so it is written the way a coach would say it: what the weeks do, in
// order, with the actual numbers. Deterministic prose for a deterministic plan - there is
// nothing here a language model would know better than the generator that just built it.
export function describeGeneratedPlan(rows, opts){
  const o = opts || {};
  const disp = o.displayN || (n => n);
  if(!rows.length) return '';
  const parts = [];
  const rest = rows.filter(r => r.kind === 'rest');
  const running = rows.filter(r => r.kind !== 'rest');
  if(rest.length){
    parts.push(rest.length === 1
      ? ('Week ' + disp(rest[0].n) + ' comes off the calendar entirely - no running, nothing to miss.')
      : ('Weeks ' + disp(rest[0].n) + '-' + disp(rest[rest.length - 1].n) + ' come off the calendar entirely - no running, nothing to miss.'));
  }
  if(running.length){
    const first = running[0], last = running[running.length - 1];
    parts.push('Running resumes in week ' + disp(first.n) + ' at ' + Math.round(first.actualKm) + 'km and climbs to ' +
      Math.round(last.actualKm) + 'km by week ' + disp(last.n) + ', never stepping up more than ' + Math.round(MAX_WEEKLY_RAMP * 100) + '% in a week.');
  }
  const cutbacks = rows.filter(r => r.kind === 'cutback');
  if(cutbacks.length) parts.push('Cutback ' + (cutbacks.length === 1 ? 'week' : 'weeks') + ': ' + cutbacks.map(r => disp(r.n)).join(', ') + '.');
  if(o.holdWeeks) parts.push('No threshold or VO2max work for the first ' + o.holdWeeks + ' week' + (o.holdWeeks === 1 ? '' : 's') + ' back - volume returns before intensity does.');
  if(o.joinN) parts.push('Week ' + disp(o.joinN) + ' onward is untouched and is what this hands back to.');
  return parts.join(' ');
}
