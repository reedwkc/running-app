// Whole-block audit for the live training plan.
//
// Every check here exists because reviewing the plan a week at a time cannot find these
// problems - a flat spot or a missing progression is only visible looking DOWN a column
// across the whole block. Run it any time:
//
//   node scripts/audit-block.mjs
//
// Reads the live plan-override read-only. Writes nothing, anywhere.

const DB = 'https://running-app-d7608-default-rtdb.europe-west1.firebasedatabase.app/5696c294141aa133f759b95565fba4f6';

const FLAT_RUN_LIMIT = 6;        // identical value this many weeks running = a flat spot
const MAX_WEEKLY_RAMP = 0.10;    // build-week volume increase over the previous build week
const CUTBACK_MAX_GAP = 4;       // never more than this many build weeks without a cutback
const CUTBACK_MIN_DROP = 0.12;   // a cutback week must actually be this much lighter
const LONG_RUN_MAX_SHARE = 0.40; // long run as a fraction of its week
const TAPER_MIN_DROP = 0.20;     // race week vs peak week

const fails = [], warns = [], passes = [];
const fail = m => fails.push(m), warn = m => warns.push(m), pass = m => passes.push(m);

async function readKey(key){
  const res = await fetch(DB + '/' + key + '.json');
  let v = await res.json();
  if(typeof v === 'string') v = JSON.parse(v);
  return v;
}

const dayKm = d => { const x = d.data || {}; return parseFloat(x.totalKm || x.km || 0) || 0; };

// Minutes actually spent at S3 or harder - the number that should progress across a block,
// and the one no per-week view ever shows you.
function qualityMin(d){
  const x = d.data || {}, a = (d.recipe && d.recipe.args) || {};
  if(d.type === 'long'){
    const fast = (a.segments || []).filter(s => s.zone !== 'S2' && s.zone !== 'S1');
    return fast.reduce((s, seg) => s + seg.km * 5, 0); // ~5 min/km at these paces - rough, but applied consistently
  }
  if(d.type !== 'threshold' && d.type !== 'vo2max') return 0;
  if(a.reps && a.workSec) return a.reps * a.workSec / 60;
  if(a.reps && a.repMin) return a.reps * a.repMin;
  if(a.reps && a.repM && x.main && x.main.repTimeSec) return a.reps * x.main.repTimeSec / 60;
  if(a.totalMin) return a.totalMin;
  if(a.distancesM && x.main && x.main.repTimeSec) return a.distancesM.length * x.main.repTimeSec / 60;
  if(a.reps && a.repSec) return a.reps * a.repSec / 60;
  if(x.main && x.main.time){ const parts = x.main.time.split(':').map(Number); return parts[0] + (parts[1] || 0) / 60; }
  return 0;
}

// Longest run of identical consecutive values in a series, ignoring cutback weeks (which are
// SUPPOSED to repeat).
function longestFlatRun(rows, get){
  let best = 0, bestAt = null, run = 0, prev = null;
  for(const r of rows){
    if(r.cutback) continue;
    const v = get(r);
    if(v == null){ run = 0; prev = null; continue; }
    if(prev !== null && v === prev){ run++; if(run > best){ best = run; bestAt = r.n; } }
    else run = 1;
    prev = v;
  }
  return {len: best, endsAt: bestAt};
}

const plan = await readKey('plan-override');
const goalCfg = await readKey('goal-config');
const startN = goalCfg && goalCfg.blockStartWeekN;
const W = plan.weeksByN;

const rows = Object.keys(W).map(Number).sort((a, b) => a - b)
  .filter(n => !startN || n >= startN)
  .map(n => {
    const w = W[n], days = w.days || [];
    const lr = days.find(d => d.type === 'long');
    const segs = (lr && lr.recipe && lr.recipe.args && lr.recipe.args.segments) || [];
    const km = days.reduce((s, d) => s + dayKm(d), 0);
    return {
      n, phase: w.phase || '', cutback: !!w.cutback, race: days.some(d => d.type === 'race'),
      km, longKm: lr ? dayKm(lr) : 0,
      longFastKm: segs.filter(s => s.zone !== 'S2' && s.zone !== 'S1').reduce((s, x) => s + x.km, 0),
      goalKm: segs.filter(s => s.zone === 'GOAL').reduce((s, x) => s + x.km, 0),
      quality: days.filter(d => d.type === 'threshold' || d.type === 'vo2max').length,
      qMin: Math.round(days.reduce((s, d) => s + qualityMin(d), 0)),
      days
    };
  });

// ---- 1. every week carries some quality ----------------------------------------------
const noQuality = rows.filter(r => !r.race && r.quality === 0 && r.qMin === 0);
if(noQuality.length) fail('weeks with NO quality work at all: ' + noQuality.map(r => 'w' + r.n).join(', '));
else pass('every non-race week carries quality work');

// ---- 2. volume ramp ------------------------------------------------------------------
let prevBuild = null; const spikes = [];
for(const r of rows){
  if(r.cutback || r.race) continue;
  if(prevBuild && r.km > prevBuild.km * (1 + MAX_WEEKLY_RAMP))
    spikes.push('w' + r.n + ' ' + prevBuild.km.toFixed(0) + '->' + r.km.toFixed(0) + 'km (+' + Math.round((r.km / prevBuild.km - 1) * 100) + '%)');
  prevBuild = r;
}
if(spikes.length) warn('build-week volume jumps over ' + (MAX_WEEKLY_RAMP * 100) + '%: ' + spikes.join(', '));
else pass('no build-week volume jump over ' + (MAX_WEEKLY_RAMP * 100) + '%');

// ---- 3. cutback cadence and depth ----------------------------------------------------
let sinceCut = 0; const cadence = [], shallow = [];
for(let i = 0; i < rows.length; i++){
  const r = rows[i];
  if(r.cutback){
    const prior = rows.slice(Math.max(0, i - 3), i).filter(x => !x.cutback);
    const ref = prior.length ? Math.max.apply(null, prior.map(x => x.km)) : null;
    if(ref && r.km > ref * (1 - CUTBACK_MIN_DROP))
      shallow.push('w' + r.n + ' only -' + Math.round((1 - r.km / ref) * 100) + '%');
    sinceCut = 0;
  } else if(!r.race && ++sinceCut > CUTBACK_MAX_GAP){
    cadence.push('w' + r.n); sinceCut = 0;
  }
}
if(cadence.length) warn('more than ' + CUTBACK_MAX_GAP + ' build weeks without a cutback, by: ' + cadence.join(', '));
else pass('a cutback at least every ' + CUTBACK_MAX_GAP + ' build weeks');
if(shallow.length) warn('cutback weeks that barely cut back: ' + shallow.join(', '));
else pass('every cutback week is a real reduction');

// ---- 4. long run share ---------------------------------------------------------------
const heavy = rows.filter(r => r.km && r.longKm / r.km > LONG_RUN_MAX_SHARE);
if(heavy.length) warn('long run over ' + (LONG_RUN_MAX_SHARE * 100) + '% of the week: ' + heavy.map(r => 'w' + r.n + ' ' + Math.round(r.longKm / r.km * 100) + '%').join(', '));
else pass('long run stays under ' + (LONG_RUN_MAX_SHARE * 100) + '% of weekly volume everywhere');

// ---- 5. hard days never back to back -------------------------------------------------
const ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HARD = ['threshold', 'vo2max', 'long', 'race'];
const backToBack = [];
for(const r of rows){
  const idx = r.days.filter(d => HARD.indexOf(d.type) !== -1)
    .map(d => ORDER.indexOf(d.tag.split(' ')[0])).sort((a, b) => a - b);
  for(let i = 1; i < idx.length; i++)
    if(idx[i] - idx[i - 1] === 1) backToBack.push('w' + r.n + ' ' + ORDER[idx[i - 1]] + '+' + ORDER[idx[i]]);
}
if(backToBack.length) fail('hard days back to back: ' + backToBack.join(', '));
else pass('no two hard days ever fall on consecutive days');

// ---- 6. flat spots -------------------------------------------------------------------
// The long run progresses on TWO axes - distance, and how much of it is run fast - and past
// ~22km a half-marathon block deliberately stops growing the distance and grows the fast
// portion instead. So flat distance is only a real flat spot when the fast portion is flat
// too; checking either axis alone raises a false alarm on a perfectly good stretch.
const flatLong = longestFlatRun(rows, r => r.longKm + '/' + r.longFastKm);
if(flatLong.len >= FLAT_RUN_LIMIT) warn('long run not progressing on EITHER axis for ' + flatLong.len + ' build weeks running (through w' + flatLong.endsAt + ')');
else pass('long run progresses on distance or fast-portion at least every ' + FLAT_RUN_LIMIT + ' build weeks (longest flat run ' + flatLong.len + ')');

const flatFast = longestFlatRun(rows, r => r.longFastKm);
if(flatFast.len >= FLAT_RUN_LIMIT) warn('long-run fast portion identical for ' + flatFast.len + ' build weeks running (through w' + flatFast.endsAt + ')');
else pass('long-run fast portion never flat for ' + FLAT_RUN_LIMIT + '+ build weeks (longest run ' + flatFast.len + ')');

const flatQ = longestFlatRun(rows, r => r.qMin);
if(flatQ.len >= FLAT_RUN_LIMIT) warn('weekly quality minutes identical for ' + flatQ.len + ' build weeks running (through w' + flatQ.endsAt + ')');
else pass('weekly quality minutes never flat for ' + FLAT_RUN_LIMIT + '+ build weeks (longest run ' + flatQ.len + ')');

// ---- 7. quality actually progresses across the block ---------------------------------
const byPhase = {};
// Taper is excluded on purpose - shedding quality is what a taper IS, not a regression.
for(const r of rows){ if(!r.cutback && !r.race && r.phase !== 'taper'){ if(!byPhase[r.phase]) byPhase[r.phase] = []; byPhase[r.phase].push(r.qMin); } }
const phaseAvg = Object.keys(byPhase).map(p => [p, byPhase[p].reduce((a, b) => a + b, 0) / byPhase[p].length]);
const regress = [];
for(let i = 1; i < phaseAvg.length; i++)
  if(phaseAvg[i][1] < phaseAvg[i - 1][1]) regress.push(phaseAvg[i - 1][0] + '->' + phaseAvg[i][0]);
if(regress.length) warn('quality minutes DROP between phases: ' + regress.join(', '));
else pass('quality minutes rise every phase: ' + phaseAvg.map(p => p[0] + ' ' + Math.round(p[1])).join(' -> '));

// ---- 8. race-specific work in the final phase ----------------------------------------
const goalWeeks = rows.filter(r => r.goalKm > 0);
if(!goalWeeks.length) fail('no goal-pace work anywhere in the block');
else {
  const first = goalWeeks[0];
  const maxGoal = Math.max.apply(null, goalWeeks.map(r => r.goalKm));
  if(maxGoal > first.goalKm) pass('goal-pace volume grows ' + first.goalKm + 'km (w' + first.n + ') -> ' + maxGoal + 'km, over ' + goalWeeks.length + ' weeks');
  else warn('goal-pace volume does not grow across the specific phase');
}

// ---- 9. taper ------------------------------------------------------------------------
const raceWeek = rows.filter(r => r.race)[0];
const peak = rows.reduce((a, b) => b.km > a.km ? b : a, rows[0]);
if(!raceWeek) warn('no race week found in the block');
else if(raceWeek.km < peak.km * (1 - TAPER_MIN_DROP))
  pass('race week ' + raceWeek.km.toFixed(0) + 'km is ' + Math.round((1 - raceWeek.km / peak.km) * 100) + '% below the ' + peak.km.toFixed(0) + 'km peak (w' + peak.n + ')');
else fail('race week is not tapered: ' + raceWeek.km.toFixed(0) + 'km vs ' + peak.km.toFixed(0) + 'km peak');

// ---- report --------------------------------------------------------------------------
console.log('\n  n  phase      km  long  fast  goal  q  qMin');
for(const r of rows)
  console.log(
    String(r.n).padStart(3), (r.phase || '-').padEnd(9), r.km.toFixed(0).padStart(3),
    r.longKm.toFixed(0).padStart(5), String(r.longFastKm || '-').padStart(5),
    String(r.goalKm || '-').padStart(5), String(r.quality).padStart(2),
    String(r.qMin).padStart(5), r.cutback ? ' cutback' : '', r.race ? ' RACE' : '');

console.log('\n' + '='.repeat(70));
for(const m of passes) console.log('  PASS  ' + m);
for(const m of warns)  console.log('  WARN  ' + m);
for(const m of fails)  console.log('  FAIL  ' + m);
console.log('='.repeat(70));
console.log('  ' + passes.length + ' passed, ' + warns.length + ' warnings, ' + fails.length + ' failures\n');
process.exitCode = fails.length ? 1 : 0;
