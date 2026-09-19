// @ts-nocheck
// Structural checks on a whole training block, in one place, run by both the command-line
// audit (scripts/audit-block.mjs) and the app itself.
//
// These exist because reviewing a plan a week at a time cannot find these problems. A flat
// spot, a missing cutback, a long run that quietly stops growing - each is only visible
// looking DOWN a column across the whole block, which is exactly the view nobody has while
// scrolling week cards. This was written after a real one: a 17-week stretch with no long-run
// progression at all, invisible week by week, obvious in a table.
//
// Deliberately free of state, storage and DOM so it can run anywhere, and so the app and the
// script can never drift into disagreeing about what a sound block looks like.

export const FLAT_RUN_LIMIT = 6;        // identical value this many build weeks running = a flat spot
export const MAX_WEEKLY_RAMP = 0.10;    // build-week volume increase over the previous build week
export const CUTBACK_MAX_GAP = 4;       // never more than this many build weeks without a cutback
export const CUTBACK_MIN_DROP = 0.12;   // a cutback week must actually be this much lighter
export const LONG_RUN_MAX_SHARE = 0.40; // long run as a fraction of its week
export const TAPER_MIN_DROP = 0.20;     // race week vs peak week

const HARD_TYPES = ['threshold', 'vo2max', 'long', 'race'];
const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const dayKm = d => { const x = (d && d.data) || {}; return parseFloat(x.totalKm || x.km || 0) || 0; };

// Week 1 is always the first week of the current block, and every later week counts from
// there. `w.n` is a storage key that keeps climbing across blocks - this runner's block starts
// at n=7, so their Week 1 is internally 7 - and every message in this file used to quote the
// internal one. That number appears nowhere on the runner's screen, and these messages are
// read by the runner (the Plan health panel) and fed back to the coach during a rebuild, so
// naming the wrong one is wrong in both directions. Computed here rather than imported from
// goal-config so this file stays free of state, exactly as its header promises.
export function dispN(n, blockStartN){
  return (blockStartN != null && n >= blockStartN) ? (n - blockStartN + 1) : n;
}
const wLabel = r => 'w' + (r && r.disp != null ? r.disp : (r && r.n));

// Minutes actually spent at S3 or harder - the number that should progress across a block,
// and the one no per-week view ever shows you. Reads the day's recipe args where it can, and
// falls back to the materialized data, so it works on both stored and live weeks.
export function qualityMin(d){
  const x = (d && d.data) || {}, a = (d && d.recipe && d.recipe.args) || {};
  if(d.type === 'long'){
    const segs = (a.segments || (x.segments || []));
    const fast = segs.filter(s => s.zone !== 'S2' && s.zone !== 'S1');
    return fast.reduce((s, seg) => s + (seg.km||0) * 5, 0); // ~5 min/km at these paces - rough, applied consistently
  }
  if(d.type !== 'threshold' && d.type !== 'vo2max') return 0;
  if(a.reps && a.workSec) return a.reps * a.workSec / 60;
  if(a.reps && a.repMin) return a.reps * a.repMin;
  if(a.reps && a.repM && x.main && x.main.repTimeSec) return a.reps * x.main.repTimeSec / 60;
  if(a.totalMin) return a.totalMin;
  if(a.distancesM && x.main && x.main.repTimeSec) return a.distancesM.length * x.main.repTimeSec / 60;
  if(a.reps && a.repSec) return a.reps * a.repSec / 60;
  if(x.main && x.main.time){ const parts = String(x.main.time).split(':').map(Number); return parts[0] + (parts[1] || 0) / 60; }
  return 0;
}

// Longest run of identical consecutive values, ignoring cutback weeks (which are SUPPOSED to
// repeat).
export function longestFlatRun(rows, get){
  let best = 0, bestAt = null, run = 0, prev = null;
  for(const r of rows){
    if(r.cutback) continue;
    const v = get(r);
    if(v == null){ run = 0; prev = null; continue; }
    if(prev !== null && v === prev){ run++; if(run > best){ best = run; bestAt = r.disp != null ? r.disp : r.n; } }
    else run = 1;
    prev = v;
  }
  return {len: best, endsAt: bestAt};
}

export function summarizeWeeks(weeks, blockStartN){
  return (weeks||[])
    .filter(w => w && Array.isArray(w.days))
    .filter(w => !blockStartN || w.n >= blockStartN)
    .sort((a, b) => a.n - b.n)
    .map(w => {
      const days = w.days || [];
      const lr = days.find(d => d.type === 'long');
      const segs = (lr && ((lr.recipe && lr.recipe.args && lr.recipe.args.segments) || (lr.data && lr.data.segments))) || [];
      return {
        n: w.n, disp: dispN(w.n, blockStartN), phase: w.phase || '', cutback: !!w.cutback, race: days.some(d => d.type === 'race'),
        km: days.reduce((s, d) => s + dayKm(d), 0),
        longKm: lr ? dayKm(lr) : 0,
        longFastKm: segs.filter(s => s.zone !== 'S2' && s.zone !== 'S1').reduce((s, x) => s + (x.km||0), 0),
        goalKm: segs.filter(s => s.zone === 'GOAL').reduce((s, x) => s + (x.km||0), 0),
        quality: days.filter(d => d.type === 'threshold' || d.type === 'vo2max').length,
        qMin: Math.round(days.reduce((s, d) => s + qualityMin(d), 0)),
        days,
      };
    });
}

// The checks that need nothing more than {n, phase, cutback, race, km, quality, days} - which
// is also everything a PLAN OUTLINE entry carries. Shared so the outline can be judged by the
// same rules as a finished block, before paying to expand fifty weeks of it (see auditOutline),
// and so the two can never drift into disagreeing about what a sound block looks like.
function shapeChecks(rows, add){
  // every week carries some quality
  const noQuality = rows.filter(r => !r.race && r.quality === 0 && !r.qMin);
  if(noQuality.length) add('quality-every-week', 'fail', 'weeks with NO quality work at all: ' + noQuality.map(wLabel).join(', '));
  else add('quality-every-week', 'pass', 'every non-race week carries quality work');

  // volume ramp
  let prevBuild = null; const spikes = [];
  for(const r of rows){
    if(r.cutback || r.race) continue;
    if(prevBuild && r.km > prevBuild.km * (1 + MAX_WEEKLY_RAMP))
      spikes.push(wLabel(r) + ' ' + prevBuild.km.toFixed(0) + '->' + r.km.toFixed(0) + 'km (+' + Math.round((r.km / prevBuild.km - 1) * 100) + '%)');
    prevBuild = r;
  }
  if(spikes.length) add('volume-ramp', 'warn', 'build-week volume jumps over ' + (MAX_WEEKLY_RAMP * 100) + '%: ' + spikes.join(', '));
  else add('volume-ramp', 'pass', 'no build-week volume jump over ' + (MAX_WEEKLY_RAMP * 100) + '%');

  // cutback cadence and depth
  let sinceCut = 0; const cadence = [], shallow = [];
  for(let i = 0; i < rows.length; i++){
    const r = rows[i];
    if(r.cutback){
      const prior = rows.slice(Math.max(0, i - 3), i).filter(x => !x.cutback);
      const ref = prior.length ? Math.max.apply(null, prior.map(x => x.km)) : null;
      if(ref && r.km > ref * (1 - CUTBACK_MIN_DROP)) shallow.push(wLabel(r) + ' only -' + Math.round((1 - r.km / ref) * 100) + '%');
      sinceCut = 0;
    } else if(!r.race && ++sinceCut > CUTBACK_MAX_GAP){
      cadence.push(wLabel(r)); sinceCut = 0;
    }
  }
  if(cadence.length) add('cutback-cadence', 'warn', 'more than ' + CUTBACK_MAX_GAP + ' build weeks without a cutback, by: ' + cadence.join(', '));
  else add('cutback-cadence', 'pass', 'a cutback at least every ' + CUTBACK_MAX_GAP + ' build weeks');
  if(shallow.length) add('cutback-depth', 'warn', 'cutback weeks that barely cut back: ' + shallow.join(', '));
  else add('cutback-depth', 'pass', 'every cutback week is a real reduction');
}

// Hard days never back to back - needs only each day's tag and type, so the outline has it too.
function hardDaySpacingCheck(rows, add){
  const backToBack = [];
  for(const r of rows){
    const idx = (r.days||[]).filter(d => HARD_TYPES.indexOf(d.type) !== -1)
      .map(d => DAY_ORDER.indexOf(String(d.tag||'').split(' ')[0])).filter(i => i !== -1).sort((a, b) => a - b);
    for(let i = 1; i < idx.length; i++)
      if(idx[i] - idx[i - 1] === 1) backToBack.push(wLabel(r) + ' ' + DAY_ORDER[idx[i - 1]] + '+' + DAY_ORDER[idx[i]]);
  }
  if(backToBack.length) add('hard-day-spacing', 'fail', 'hard days back to back: ' + backToBack.join(', '));
  else add('hard-day-spacing', 'pass', 'no two hard days ever fall on consecutive days');
}

// A PLAN OUTLINE entry ({n, dates, phase, cutback, race, targetKm, days:[{tag,type}]}) mapped
// onto the same row shape the block audit uses.
export function outlineRows(outlineWeeks, blockStartN){
  return (outlineWeeks||[])
    .filter(w => w && w.n != null)
    .slice()
    .sort((a, b) => a.n - b.n)
    .map(w => {
      const days = w.days || [];
      return {
        n: w.n, disp: dispN(w.n, blockStartN), phase: w.phase || '', cutback: !!w.cutback,
        race: !!w.race || days.some(d => d.type === 'race'),
        km: parseFloat(w.targetKm) || 0,
        quality: days.filter(d => d.type === 'threshold' || d.type === 'vo2max').length,
        qMin: 0,
        days,
      };
    });
}

// Judges a plan OUTLINE by the rules that can be judged before the weeks are written out.
// Everything it cannot see (quality minutes, long-run progression, goal-pace volume) is left
// to the full audit once the block is expanded - this is a cheap early gate, not a substitute.
export function auditOutline(outlineWeeks, opts){
  const rows = outlineRows(outlineWeeks, (opts||{}).blockStartN);
  const checks = [];
  const add = (id, level, message) => checks.push({id, level, message});
  if(!rows.length){
    add('empty', 'fail', 'the outline contains no weeks');
    return {rows, checks, failures: checks.slice(), warnings: [], passes: []};
  }
  const missingKm = rows.filter(r => !r.km);
  if(missingKm.length) add('outline-target-km', 'fail', 'weeks with no targetKm: ' + missingKm.map(wLabel).join(', '));
  else add('outline-target-km', 'pass', 'every outlined week states a target volume');

  const noDays = rows.filter(r => !r.days.length);
  if(noDays.length) add('outline-days', 'fail', 'weeks with no days listed: ' + noDays.map(wLabel).join(', '));
  else add('outline-days', 'pass', 'every outlined week lists its days');

  // Contiguity: a gap in the week numbers is a month of training silently missing, and it is
  // far cheaper to catch here than after expanding everything around the hole.
  const gaps = [];
  for(let i = 1; i < rows.length; i++) if(rows[i].n !== rows[i-1].n + 1) gaps.push(wLabel(rows[i-1]) + '->' + wLabel(rows[i]));
  if(gaps.length) add('outline-contiguous', 'fail', 'gaps in the outlined week numbers: ' + gaps.join(', '));
  else add('outline-contiguous', 'pass', 'outlined weeks are contiguous');

  shapeChecks(rows, add);
  hardDaySpacingCheck(rows, add);
  return {
    rows, checks,
    failures: checks.filter(c => c.level === 'fail'),
    warnings: checks.filter(c => c.level === 'warn'),
    passes: checks.filter(c => c.level === 'pass'),
  };
}

// Returns {rows, checks:[{id, level:'pass'|'warn'|'fail', message}], failures, warnings, passes}.
// Every check reports either way - a passing check that states the actual number it checked
// ("longest flat run 4") is what makes the result worth reading rather than just reassuring.
export function auditBlock(weeks, opts){
  const o = opts || {};
  const rows = summarizeWeeks(weeks, o.blockStartN);
  const checks = [];
  const add = (id, level, message) => checks.push({id, level, message});
  if(!rows.length){
    add('empty', 'warn', 'No weeks to audit yet.');
    return {rows, checks, failures: [], warnings: checks.slice(), passes: []};
  }

  shapeChecks(rows, add);

  // 4. long run share
  const heavy = rows.filter(r => r.km && r.longKm / r.km > LONG_RUN_MAX_SHARE);
  if(heavy.length) add('long-run-share', 'warn', 'long run over ' + (LONG_RUN_MAX_SHARE * 100) + '% of the week: ' + heavy.map(r => wLabel(r) + ' ' + Math.round(r.longKm / r.km * 100) + '%').join(', '));
  else add('long-run-share', 'pass', 'long run stays under ' + (LONG_RUN_MAX_SHARE * 100) + '% of weekly volume everywhere');

  // 5. hard days never back to back
  const backToBack = [];
  for(const r of rows){
    const idx = r.days.filter(d => HARD_TYPES.indexOf(d.type) !== -1)
      .map(d => DAY_ORDER.indexOf(String(d.tag||'').split(' ')[0])).filter(i => i !== -1).sort((a, b) => a - b);
    for(let i = 1; i < idx.length; i++)
      if(idx[i] - idx[i - 1] === 1) backToBack.push(wLabel(r) + ' ' + DAY_ORDER[idx[i - 1]] + '+' + DAY_ORDER[idx[i]]);
  }
  if(backToBack.length) add('hard-day-spacing', 'fail', 'hard days back to back: ' + backToBack.join(', '));
  else add('hard-day-spacing', 'pass', 'no two hard days ever fall on consecutive days');

  // 6. flat spots. The long run progresses on TWO axes - distance, and how much of it is run
  // fast - and past ~22km a half-marathon block deliberately stops growing the distance and
  // grows the fast portion instead. Flat distance is only a real flat spot when the fast
  // portion is flat too; checking either axis alone raises a false alarm on a good stretch.
  const flatLong = longestFlatRun(rows, r => r.longKm + '/' + r.longFastKm);
  if(flatLong.len >= FLAT_RUN_LIMIT) add('long-run-progression', 'warn', 'long run not progressing on EITHER axis for ' + flatLong.len + ' build weeks running (through w' + flatLong.endsAt + ')');
  else add('long-run-progression', 'pass', 'long run progresses on distance or fast-portion at least every ' + FLAT_RUN_LIMIT + ' build weeks (longest flat run ' + flatLong.len + ')');

  const flatFast = longestFlatRun(rows, r => r.longFastKm);
  if(flatFast.len >= FLAT_RUN_LIMIT) add('long-run-fast-portion', 'warn', 'long-run fast portion identical for ' + flatFast.len + ' build weeks running (through w' + flatFast.endsAt + ')');
  else add('long-run-fast-portion', 'pass', 'long-run fast portion never flat for ' + FLAT_RUN_LIMIT + '+ build weeks (longest run ' + flatFast.len + ')');

  const flatQ = longestFlatRun(rows, r => r.qMin);
  if(flatQ.len >= FLAT_RUN_LIMIT) add('quality-progression', 'warn', 'weekly quality minutes identical for ' + flatQ.len + ' build weeks running (through w' + flatQ.endsAt + ')');
  else add('quality-progression', 'pass', 'weekly quality minutes never flat for ' + FLAT_RUN_LIMIT + '+ build weeks (longest run ' + flatQ.len + ')');

  // 7. quality actually progresses across the block. Taper is excluded on purpose - shedding
  // quality is what a taper IS, not a regression.
  const byPhase = {};
  for(const r of rows){ if(!r.cutback && !r.race && r.phase !== 'taper'){ if(!byPhase[r.phase]) byPhase[r.phase] = []; byPhase[r.phase].push(r.qMin); } }
  const phaseAvg = Object.keys(byPhase).map(p => [p, byPhase[p].reduce((a, b) => a + b, 0) / byPhase[p].length]);
  const regress = [];
  for(let i = 1; i < phaseAvg.length; i++) if(phaseAvg[i][1] < phaseAvg[i - 1][1]) regress.push(phaseAvg[i - 1][0] + '->' + phaseAvg[i][0]);
  if(regress.length) add('phase-progression', 'warn', 'quality minutes DROP between phases: ' + regress.join(', '));
  else if(phaseAvg.length) add('phase-progression', 'pass', 'quality minutes rise every phase: ' + phaseAvg.map(p => p[0] + ' ' + Math.round(p[1])).join(' -> '));

  // 8. race-specific work in the final phase
  const goalWeeks = rows.filter(r => r.goalKm > 0);
  if(!goalWeeks.length) add('goal-pace-work', 'fail', 'no goal-pace work anywhere in the block');
  else {
    const first = goalWeeks[0];
    const maxGoal = Math.max.apply(null, goalWeeks.map(r => r.goalKm));
    if(maxGoal > first.goalKm) add('goal-pace-work', 'pass', 'goal-pace volume grows ' + first.goalKm + 'km (' + wLabel(first) + ') -> ' + maxGoal + 'km, over ' + goalWeeks.length + ' weeks');
    else add('goal-pace-work', 'warn', 'goal-pace volume does not grow across the specific phase');
  }

  // 9. taper
  const raceWeek = rows.filter(r => r.race)[0];
  const peak = rows.reduce((a, b) => b.km > a.km ? b : a, rows[0]);
  if(!raceWeek) add('taper', 'warn', 'no race week found in the block');
  else if(raceWeek.km < peak.km * (1 - TAPER_MIN_DROP))
    add('taper', 'pass', 'race week ' + raceWeek.km.toFixed(0) + 'km is ' + Math.round((1 - raceWeek.km / peak.km) * 100) + '% below the ' + peak.km.toFixed(0) + 'km peak (' + wLabel(peak) + ')');
  else add('taper', 'fail', 'race week is not tapered: ' + raceWeek.km.toFixed(0) + 'km vs ' + peak.km.toFixed(0) + 'km peak');

  return {
    rows, checks,
    failures: checks.filter(c => c.level === 'fail'),
    warnings: checks.filter(c => c.level === 'warn'),
    passes: checks.filter(c => c.level === 'pass'),
  };
}
