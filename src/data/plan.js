// @ts-nocheck
import { state } from '../state.js';
import { distTime, fmtPace, fmtTime, formatMinutesToClock, parseTime } from '../lib/format.js';
import { goalZonesFromConfig } from './goal-config.js';

export function computeZones(p, goalConfig){
  const lthr = p.lthr, lt = p.ltPaceSec;
  const goalZones = goalZonesFromConfig(goalConfig, p);
  return {
    S1:{hr:Math.round(lthr*0.65)+'-'+Math.round(lthr*0.80), pace:Math.round(lt*1.364)},
    S2:{hr:Math.round(lthr*0.80)+'-'+Math.round(lthr*0.89), pace:Math.round(lt*1.2)},
    S3:{hr:Math.round(lthr*0.89)+'-'+Math.round(lthr*0.95), pace:Math.round(lt*1.091)},
    S4:{hr:Math.round(lthr*0.95)+'-'+Math.round(lthr), pace:lt},
    S5:{hr:Math.round(lthr)+'+', pace:Math.round(lt*0.927)},
    GOAL: goalZones.GOAL,
    RACE10K: goalZones.RACE10K
  };
}

export function threshold(reps, repM, paceRatio, recoverySec, recoveryLabel, wuKm, cdKm){
  const repKm = repM/1000;
  const paceSpk = state.Z.S4.pace; // target LT pace exactly - HR-based (no lactate meter), so don't run faster than measured threshold
  const repTime = repKm*paceSpk;
  const mainTime = reps*repTime + (reps-1)*recoverySec;
  const wuTime = distTime(wuKm, state.Z.S1.pace);
  const cdTime = distTime(cdKm, state.Z.S1.pace);
  return { kind:'threshold', totalKm:(wuKm+reps*repKm+cdKm).toFixed(1), totalSec:wuTime+mainTime+cdTime, totalTime: fmtTime(wuTime+mainTime+cdTime),
    wu:{km:wuKm, time:fmtTime(wuTime)},
    main:{reps, label:reps+' x '+repM+'m', repTime:fmtTime(repTime), repTimeSec:repTime, pace:fmtPace(paceSpk), paceSpk, recoverySec, recoveryLabel, time:fmtTime(mainTime)},
    cd:{km:cdKm, time:fmtTime(cdTime)} };
}

export function vo2max(reps, repMin, recoveryMin, wuKm, cdKm){
  const repTime = repMin*60;
  const mainTime = reps*repTime + (reps-1)*(recoveryMin*60);
  const wuTime = distTime(wuKm, state.Z.S1.pace);
  const cdTime = distTime(cdKm, state.Z.S1.pace);
  const estRepKm = repTime/state.Z.S5.pace;
  return { kind:'vo2max', totalKm:(wuKm+reps*estRepKm+cdKm).toFixed(1), totalSec:wuTime+mainTime+cdTime, totalTime: fmtTime(wuTime+mainTime+cdTime),
    wu:{km:wuKm, time:fmtTime(wuTime)},
    main:{reps, label:reps+' x '+repMin+'min', repTime:fmtTime(repTime), repTimeSec:repTime, pace:'~'+fmtPace(state.Z.S5.pace), paceSpk:state.Z.S5.pace, recoverySec:recoveryMin*60, recoveryLabel:'jog', time:fmtTime(mainTime)},
    cd:{km:cdKm, time:fmtTime(cdTime)} };
}

// Meters-based VO2max-pace reps (e.g. "5 x 200m") - the missing sibling to threshold()
// (meters-based, but pinned to LT/S4 pace) and vo2max() (S5 pace, but time-based only).
// Genuine short, fast structured intervals - "5x200m at roughly 5K pace" - don't fit either
// existing shape: threshold's meters-based reps run too slow (LT pace, not fast enough),
// and vo2max's S5-pace reps are prescribed by TIME, not distance. Without this, a request
// for exactly this kind of session had no valid structured shape to land in at all, which is
// why the coach previously fell back to noting it in an easy day's free-text description
// instead of giving it a proper interval card - see the matching addition to the
// plan-override system prompt (coach/plan-override.js) that documents this shape for the
// LLM to actually use.
export function vo2maxReps(reps, repM, recoverySec, recoveryLabel, wuKm, cdKm){
  const repKm = repM/1000;
  const paceSpk = state.Z.S5.pace;
  const repTime = repKm*paceSpk;
  const mainTime = reps*repTime + (reps-1)*recoverySec;
  const wuTime = distTime(wuKm, state.Z.S1.pace);
  const cdTime = distTime(cdKm, state.Z.S1.pace);
  return { kind:'vo2max', totalKm:(wuKm+reps*repKm+cdKm).toFixed(1), totalSec:wuTime+mainTime+cdTime, totalTime: fmtTime(wuTime+mainTime+cdTime),
    wu:{km:wuKm, time:fmtTime(wuTime)},
    main:{reps, label:reps+' x '+repM+'m', repTime:fmtTime(repTime), repTimeSec:repTime, pace:fmtPace(paceSpk), paceSpk, recoverySec, recoveryLabel, time:fmtTime(mainTime)},
    cd:{km:cdKm, time:fmtTime(cdTime)} };
}

export function raceOpener(reps, repMin, recoveryMin, wuKm, cdKm){
  const repTime = repMin*60;
  const mainTime = reps*repTime + (reps-1)*(recoveryMin*60);
  const wuTime = distTime(wuKm, state.Z.S1.pace);
  const cdTime = distTime(cdKm, state.Z.S1.pace);
  const estRepKm = repTime/state.Z.RACE10K.pace;
  return { kind:'vo2max', totalKm:(wuKm+reps*estRepKm+cdKm).toFixed(1), totalSec:wuTime+mainTime+cdTime, totalTime: fmtTime(wuTime+mainTime+cdTime),
    wu:{km:wuKm, time:fmtTime(wuTime)},
    main:{reps, label:reps+' x '+repMin+'min', repTime:fmtTime(repTime), pace:'~'+fmtPace(state.Z.RACE10K.pace), paceSpk:state.Z.RACE10K.pace, recoverySec:recoveryMin*60, recoveryLabel:'jog', time:fmtTime(mainTime)},
    cd:{km:cdKm, time:fmtTime(cdTime)} };
}

export function easyS(km, strides){ return {km, timeSec: distTime(km, state.Z.S2.pace), strides}; }

export function longRun(segments){
  let totalKm=0,totalTime=0;
  segments.forEach(s=>{ totalKm+=s.km; totalTime+=distTime(s.km, state.Z[s.zone].pace); });
  return {segments, totalKm:totalKm.toFixed(1), totalSec:totalTime, totalTime:fmtTime(totalTime)};
}

// goalTime/goalPaceLabel below are only the FALLBACK - the literal strings baked into a
// template day when it was first written. The live activeGoals entry (matched by goalId,
// the same stable identity Edit Goal writes to - see commitGoalEdit in ui/modals.js) is
// always preferred so editing a goal's target time actually moves this race day's own
// displayed target instead of leaving it silently pointed at whatever the plan said the
// day this week was written. Falls back to the literal strings only if the goal has since
// been archived/deleted (goalId no longer in activeGoals) so a past or hypothetical race
// day doesn't just go blank.
export function raceEv(km, goalTime, goalPaceLabel, goalId){
  const cfg = state.goalConfig;
  const goal = goalId && cfg && (cfg.activeGoals||[]).find(g=>g.goalId===goalId);
  return {
    km,
    goalTime: (goal && goal.goalTimeLabel) || goalTime,
    goalPaceLabel: (goal && goal.goalPaceLabel) || goalPaceLabel,
    goalPaceSec: (goal && goal.goalPaceSec) || null,
  };
}

// Optimal pacing strategy for race day: a slightly conservative opening (HR lags effort at
// the start regardless of fitness - same caution as the race WHY.tip), a steady middle held
// at a cushioned target pace, and a CLOSING segment matched in length to the opener with an
// equal and opposite offset - not just bracketing that target, but engineered so the total
// time lands exactly on it if the closer is actually held (equal-km, equal-and-opposite
// per-km offsets net to zero average-pace impact across the two segments together).
//
// "Sub-X" (every goal in this app is phrased as a ceiling, not a landing spot - see
// goalTimeLabel in ui/modals.js's commitGoalEdit) means finishing UNDER X, and a strategy
// dialed to hit the literal goal pace exactly has zero room for GPS/tangent drift, a
// crowded start corral, or a slightly-off day before it tips over into missing "sub"
// altogether. So the strategy targets a cushioned pace - a fixed margin below the literal
// goal pace, roughly 1% of goal time (min 15s, max 90s, so it stays sensible from a 5K to a
// marathon) - rather than the literal goalPaceSec itself. The headline "Target pace" shown
// elsewhere on the race card stays the literal goal-derived number (still the right thing
// for the achievability/trajectory math elsewhere to reference); only this execution plan
// runs a bit ahead of it.
export function racePacingStrategy(distanceKm, goalPaceSec){
  if(!distanceKm || !goalPaceSec) return null;
  const goalTimeSec = distanceKm*goalPaceSec;
  const cushionSec = Math.min(90, Math.max(15, Math.round(goalTimeSec*0.01)));
  const targetPaceSec = goalPaceSec - cushionSec/distanceKm;
  const edgeKm = Math.min(3, Math.max(1, Math.round(distanceKm*0.15)));
  const midKm = Math.round((distanceKm - edgeKm*2)*10)/10;
  if(midKm <= 0) return null;
  const offsetSec = Math.max(3, Math.round(targetPaceSec*0.02));
  const segs = [
    {label:'Opening '+edgeKm+'km', km:edgeKm, paceSec:targetPaceSec+offsetSec, tip:'Ease in - let HR catch up rather than chasing the pace number early.'},
    {label:'Steady middle '+midKm+'km', km:midKm, paceSec:targetPaceSec, tip:'Lock into pace and hold it.'},
    {label:'Closing '+edgeKm+'km', km:edgeKm, paceSec:targetPaceSec-offsetSec, tip:'If you\'re still there, press here - this is what banks back the time the opener gave away.'}
  ];
  let cumKm=0, cumSec=0;
  segs.forEach(s=>{
    s.timeSec = s.km*s.paceSec;
    cumKm += s.km; cumSec += s.timeSec;
    s.paceLabel = fmtPace(s.paceSec);
    s.timeLabel = fmtTime(s.timeSec);
    s.cumTimeLabel = formatMinutesToClock(cumSec/60);
  });
  return {segments:segs, totalTimeLabel:formatMinutesToClock(cumSec/60), cushionSec, cushionLabel:fmtTime(cushionSec)};
}

// Single source of truth for "how many km does this week actually prescribe" - week
// objects never carry a precomputed total (there is no w.total field), so every caller
// that wants one needs to sum it from the day data the same way. Previously duplicated
// inline in week-view.js's renderWeek and silently absent from chat.js's buildPlanSummary
// (which referenced a nonexistent w.total, always rendering "undefinedkm planned" in
// every coach prompt - the coach has never actually been told an accurate weekly total).
export function computeWeekPlannedKm(week){
  let total = 0;
  (week.days||[]).forEach(d=>{
    if(d.type==='easy') total += d.data.km||0;
    else if(d.type==='threshold' || d.type==='vo2max' || d.type==='long') total += parseFloat(d.data.totalKm)||0;
    else if(d.type==='race') total += d.data.km||0;
  });
  return Math.round(total*10)/10;
}

// A "reduced load" (cutback) week means something different depending on WHERE it sits
// relative to the nearest race day: before an upcoming race it's a TAPER (sharpening for
// that effort), after a just-run race it's RECOVERY (easing back to resume training).
// Both used to render as the same "taper" label/wording everywhere (nav badge, coach plan
// summary) - misleading for the post-race case, and for a rebuild proposal validated as if
// "cutback" only ever meant pre-race taper. Scans outward from weekN for the nearest race
// day in either direction, treating a contiguous run of other cutback weeks between this
// one and that race day as still belonging to the same taper/recovery stretch.
export function classifyReducedWeek(weeks, weekN){
  const idx = (weeks||[]).findIndex(w=>w.n===weekN);
  if(idx===-1) return null;
  const week = weeks[idx];
  const ownRaceDay = (week.days||[]).find(d=>d.type==='race');
  if(ownRaceDay) return {kind:'race', raceDay:ownRaceDay, raceWeekN:week.n};
  for(let i=idx-1;i>=0;i--){
    const w = weeks[i];
    const raceDay = (w.days||[]).find(d=>d.type==='race');
    if(raceDay) return {kind:'recovery', raceDay, raceWeekN:w.n};
    if(!w.cutback) break;
  }
  for(let i=idx+1;i<weeks.length;i++){
    const w = weeks[i];
    const raceDay = (w.days||[]).find(d=>d.type==='race');
    if(raceDay) return {kind:'taper', raceDay, raceWeekN:w.n};
    if(!w.cutback) break;
  }
  return {kind:'cutback'};
}

export const WHY = {
  easy:{why:'Keeps weekly volume high without adding fatigue - builds the aerobic base (capillary density, fat-burning efficiency) everything else is built on.',
        tip:'Run by feel and HR, not pace - your route is uneven enough that a pace target here would be misleading. If you can\'t speak in full sentences, slow down.'},
  threshold:{why:'Trains your body to buffer and clear lactate at faster paces - this directly raises the pace you can sustain for a half marathon. The main fitness driver in this plan.',
        tip:'Being inside the zone matters far more than hitting an exact number - time-in-zone is the actual stimulus. Aim mid-zone rather than pinned at the top for most of each rep; that\'s what keeps this genuinely "sub"-threshold and repeatable across reps, versus grinding at true max threshold. HR takes 60-120 seconds to catch up to effort at the start of each rep - that lag is completely normal, so hold the prescribed pace and let HR drift up naturally rather than starting hard to force it into zone faster. Treat the first rep as a calibration rep: hold the suggested pace, check HR in the last 30-60 seconds. Already at the top of the zone with reps left? Ease off 5-10 sec/km rather than gutting it out - HR is the more honest signal that day.'},
  vo2max:{why:'Raises your aerobic ceiling (VO2max), which gives your threshold pace more room to climb over time.',
        tip:'Pace is the primary target here, not HR - unlike threshold, this intensity never reaches true steady state within a rep, so HR keeps climbing rather than settling in, and chasing an HR number instead of pace either sandbags early reps or drags you faster than intended late in the set. Hold the target pace, hard-but-repeatable, not an all-out sprint. HR lags behind effort for the first 60-90 seconds of each rep - normal, don\'t chase it by starting faster than prescribed. It should also climb across the whole set, not just within one rep - expect a meaningfully lower HR on the opening rep or two, building toward the marked gauge value by your last 1-2 reps; that\'s the normal pattern here, not a sign anything\'s wrong. Check pace after the first two reps - fading by the last two means you started too fast. Aim for even pace across all reps and let HR follow its own natural build.'},
  long:{why:'Builds the durability and fuel efficiency to hold pace deep into a half marathon. On progressive-finish weeks, it also rehearses running under fatigue - exactly what the closing kilometers feel like.',
        tip:'Ease into any faster finish over the first minute rather than jumping straight to target pace.'},
  race:{why:'This is the goal effort itself.',
        tip:'Run the first 2-3km by feel and pace, not HR - it lags at the start and will look artificially low.'}
};

export function buildWeeks(){ return [
{ n:1, dates:'Aug 3-9', cutback:false,
  callout:null,
  days:[
    {tag:'Wed - Aug 5', name:'Threshold', zone:'S4', type:'threshold', data:threshold(6,1000,0.989,90,'jog',2,1.5)},
    {tag:'Thu - Aug 6', name:'Easy + strides', zone:'S2', type:'easy', data:easyS(9,4)},
    {tag:'Sat - Aug 8', name:'Long run', zone:'S2-S3', type:'long', data:longRun([{km:13,zone:'S2'},{km:3,zone:'S3'}])}
  ]},
{ n:2, dates:'Aug 10-16', cutback:false, callout:'Second quality day added on Monday, starting this week - a genuine threshold session in its own right, still shorter than Wednesday\'s but no longer a token effort.',
  days:[
    {tag:'Mon - Aug 10', name:'Threshold (shorter)', zone:'S4', type:'threshold', data:threshold(4,1000,0.989,90,'jog',1.5,1.5)},
    {tag:'Wed - Aug 12', name:'VO2max', zone:'S5', type:'vo2max', data:vo2max(6,3,3,2.5,1.5), note:'First VO2max block of the plan.'},
    {tag:'Thu - Aug 13', name:'Easy + strides', zone:'S2', type:'easy', data:easyS(9.5,5)},
    {tag:'Sat - Aug 15', name:'Long run', zone:'S2-S3', type:'long', data:longRun([{km:13,zone:'S2'},{km:5,zone:'S3'}]), changeNote:'Trimmed from 19km to 18km - peak long run (Week 6) was 25km, longer than the half marathon itself and ~55% of that week\'s volume in one session; capping the whole long-run progression keeps every week under the ~25-30% single-run guideline and never exceeds race distance. Structure/quality portions unchanged, only the easy base trimmed.', changeDate:'Aug 15'}
  ]},
{ n:3, dates:'Aug 17-23', cutback:false, callout:'Pre-race peak week before the 10K taper.',
  days:[
    {tag:'Mon - Aug 17', name:'Threshold (shorter)', zone:'S4', type:'threshold', data:threshold(5,800,0.989,90,'jog',1.5,1.5)},
    {tag:'Wed - Aug 19', name:'Threshold', zone:'S4', type:'threshold', data:threshold(6,1200,0.989,90,'jog',2,1.5)},
    {tag:'Thu - Aug 20', name:'Easy + strides', zone:'S2', type:'easy', data:easyS(9,4)},
    {tag:'Sat - Aug 22', name:'Long run', zone:'S2-S3', type:'long', data:longRun([{km:11,zone:'S2'},{km:8,zone:'S3'}]), changeNote:'Trimmed from 22km to 19km - part of capping the whole long-run progression (see Week 2\'s note for the full rationale). S3 quality portion unchanged, only the easy base trimmed.', changeDate:'Aug 15'}
  ]},
{ n:4, dates:'Aug 24-30', cutback:true,
  callout:'10K race week - Lierlopet, Sun Aug 30, goal sub-43:00 (4:18/km). Taper volume, sharpen legs, race is the hard effort this week.',
  days:[
    {tag:'Mon - Aug 24', name:'Easy run', zone:'S2', type:'easy', data:easyS(9)},
    {tag:'Wed - Aug 26', name:'Race-pace openers', zone:'S5', type:'vo2max', data:raceOpener(4,3,3,1.5,1.5)},
    {tag:'Thu - Aug 27', name:'Easy run', zone:'S2', type:'easy', data:easyS(6)},
    {tag:'Sat - Aug 29', name:'Shakeout', zone:'S1/S2', type:'easy', data:easyS(4)},
    {tag:'Sun - Aug 30', name:'RACE - Lierlopet 10K', zone:'Goal', type:'race', goalId:'10k-lierlopet', data:raceEv(10,'Sub-43:00','4:18/km','10k-lierlopet'), note:'HR will likely sit 175-185bpm at this pace - expected, not a red flag.'}
  ]},
{ n:5, dates:'Aug 31-Sep 6', cutback:false, callout:'Back into the half marathon build, using the 10K as a fitness marker.',
  days:[
    {tag:'Mon - Aug 31', name:'Easy run', zone:'S2', type:'easy', data:easyS(7), note:'Pure recovery from Sunday\'s 10K - no quality work, just easy legs. Wednesday\'s threshold session is the actual return to quality, 3 days post-race.', changeNote:'Was a threshold session (4x1000) - changed to easy recovery since it sat the day right after the 10K race with no buffer. Quality work now resumes Wednesday instead.', changeDate:'Aug 5'},
    {tag:'Wed - Sep 2', name:'Threshold', zone:'S4', type:'threshold', data:threshold(5,1500,0.989,120,'jog',2,1.5), changeNote:'Eased back from 6x1500 to 5x1500 - this is the first quality session after the 10K race (3 days post-race), not a good week to debut the block\'s biggest threshold session. Rest of the build stays at the increased volume.', changeDate:'Aug 5'},
    {tag:'Thu - Sep 3', name:'Easy + strides', zone:'S2', type:'easy', data:easyS(9,5)},
    {tag:'Sat - Sep 5', name:'Long run', zone:'S2-Goal', type:'long', data:longRun([{km:10,zone:'S2'},{km:4,zone:'GOAL'},{km:3,zone:'S2'}]), note:'First taste of goal pace in a long run - 4km at goal half pace mid-run, then ease back to S2 to finish. Dress rehearsal before Week 6\'s bigger goal-pace session.', changeNote:'Trimmed from 19km to 17km, on top of the earlier addition of a 4km goal-pace segment - part of capping the whole long-run progression (see Week 2\'s note for the full rationale). Goal-pace portion unchanged, only the easy base trimmed.', changeDate:'Aug 15'}
  ]},
{ n:6, dates:'Sep 7-13', cutback:false, callout:'Peak week. Saturday\'s long run is the single most important session of the block.',
  days:[
    {tag:'Mon - Sep 7', name:'Threshold (shorter)', zone:'S4', type:'threshold', data:threshold(5,1000,0.989,90,'jog',1.5,1.5)},
    {tag:'Wed - Sep 9', name:'VO2max', zone:'S5', type:'vo2max', data:vo2max(6,4,3,2.5,1.5), note:'Last big engine session before taper.'},
    {tag:'Thu - Sep 10', name:'Easy + strides', zone:'S2', type:'easy', data:easyS(9,5)},
    {tag:'Sat - Sep 12', name:'Long run', zone:'S2-Goal', type:'long', data:longRun([{km:11,zone:'S2'},{km:8,zone:'GOAL'}]), note:'Last 8km at goal half pace - the single most race-specific session in the block.', changeNote:'Trimmed from 25km to 19km - at 25km this was longer than the half marathon itself (21.1km) and ~55% of that week\'s total volume in one session, both well past normal guidelines (most half-marathon plans top out at 16-19km peak long runs, and single-run volume is generally capped around 25-30% of the week). 19km matches the top end of Pfitzinger/Daniels-style plans and no longer exceeds race distance. The 8km goal-pace finish - the actual point of this session - is unchanged, only the easy base beforehand was trimmed.', changeDate:'Aug 15'}
  ]},
{ n:7, dates:'Sep 14-20', cutback:true, callout:'Taper begins.',
  days:[
    {tag:'Mon - Sep 14', name:'Threshold (shorter)', zone:'S4', type:'threshold', data:threshold(3,800,0.989,120,'jog/walk',1.5,1.5), note:'Taper week - kept light.'},
    {tag:'Wed - Sep 16', name:'Threshold', zone:'S4', type:'threshold', data:threshold(4,1000,0.989,150,'jog/walk',2,1.5), note:'Full recovery - sharpen, don\'t grind.'},
    {tag:'Thu - Sep 17', name:'Easy + strides', zone:'S2', type:'easy', data:easyS(7,4)},
    {tag:'Sat - Sep 19', name:'Long run', zone:'S2-Goal', type:'long', data:longRun([{km:5,zone:'S2'},{km:3,zone:'GOAL'},{km:5,zone:'S2'}]), note:'3km at goal pace mid-run.', changeNote:'Trimmed from 14km to 13km, in line with the peak week\'s long run being capped from 25km to 19km - keeps the taper\'s proportions consistent with the now-lower peak. Goal-pace portion unchanged.', changeDate:'Aug 15'}
  ]},
{ n:8, dates:'Sep 21-27', cutback:true, race:true,
  callout:'Race week. Don\'t chase HR in the first 2km. If it\'s hot, run by HR and accept pace may drift.',
  days:[
    {tag:'Mon - Sep 21', name:'Easy run', zone:'S2', type:'easy', data:easyS(7)},
    {tag:'Wed - Sep 23', name:'Easy + strides', zone:'S2', type:'easy', data:easyS(6,4)},
    {tag:'Sat - Sep 26', name:'Shakeout', zone:'S1/S2', type:'easy', data:easyS(4), note:'Very easy, a few strides.'},
    {tag:'Sun - Sep 27', name:'RACE - Half Marathon', zone:'Goal', type:'race', goalId:'hm-sub135', data:raceEv(21.1,'Sub-1:35:00','4:29/km','hm-sub135')}
  ]}
]; }

// Coach-driven plan rebuild: applies a persisted 'plan-override' object on top of the
// static buildWeeks() output. Whole-week replacement, not per-field patching - a proposal
// always supplies COMPLETE week objects for whichever weeks it's changing (the LLM already
// has each week's full current content in its prompt and is instructed to copy unchanged
// days through verbatim), which handles both a one-session tweak (resupply that single
// week) and a full multi-week phase rebuild (supply N weeks, extending past the current
// max n) with one mechanism instead of juggling two partial-patch schemas. Storage key is
// 'plan-override' (singular) - deliberately distinct from the old 'plan-overrides' (plural)
// key this replaces, which was confirmed dead (nothing ever wrote it), so no migration.
export async function applyPlanOverrides(weeks){
  let r = null;
  try{ r = await window.storage.get('plan-override', false); }
  catch(e){ console.error('applyPlanOverrides: failed to load plan-override (falling back to the unmodified plan this session)', e); return weeks; }
  if(!r) return weeks;
  let override;
  try{ override = JSON.parse(r.value); }
  catch(e){ console.error('applyPlanOverrides: plan-override data exists but failed to parse', e); return weeks; }
  try{
    const weeksByN = override.weeksByN || {};
    let result = weeks.slice();
    Object.keys(weeksByN).forEach(nStr=>{
      const n = parseInt(nStr, 10);
      const newWeek = weeksByN[nStr];
      const idx = result.findIndex(w=>w.n===n);
      if(idx!==-1) result[idx] = newWeek;
      else result.push(newWeek);
    });
    if(override.truncateAfter!=null){
      result = result.filter(w=> w.n<=override.truncateAfter || Object.prototype.hasOwnProperty.call(weeksByN, String(w.n)));
    }
    result.sort((a,b)=>a.n-b.n);
    return result;
  }catch(e){ console.error('applyPlanOverrides: plan-override data exists but failed to apply', e); return weeks; }
}

export const WHY_BIKE = {
  easy:{why:'Same purpose as an easy run - aerobic base without adding fatigue - just delivered through a joint-friendly medium. Useful both as planned cross-training and as a like-for-like substitute if running is off the table for a few days.',
        tip:'Cadence 85-95rpm, flat-to-rolling terrain, conversational effort. Duration matters more than distance here - don\'t chase kilometers.'},
  threshold:{why:'Mirrors the running threshold session\'s time-at-effort - same number of reps, same rep duration, same recovery, just at your cycling threshold zone instead of running pace. Keeps the lactate-buffering stimulus intact while running is resting.',
        tip:'Find a flat road, a long steady climb, or a trainer for these - you want to hold HR steady in the zone, which is hard to do on a stop-start route.'},
  vo2max:{why:'Same VO2max stimulus as the running version, same rep/recovery timing - just delivered without impact.',
        tip:'Standing efforts or a slight climb work well for hitting the zone quickly. Keep cadence up rather than grinding a huge gear.'},
  long:{why:'Builds the same aerobic durability as the long run - time in zone matters more than the exact activity.',
        tip:'Cycling is lower-impact than running, so if this is standing in for a running long run during an injury, it\'s fine to run slightly longer in duration than the original session - your legs can absorb more time on the bike than on the road.'}
};

export function bikeEquivalent(d){
  if(d.type==='race') return null;
  if(d.type==='easy'){
    return {kind:'easy', totalSec:d.data.timeSec, zone:'S2', strides:d.data.strides};
  }
  if(d.type==='threshold' || d.type==='vo2max'){
    const dat = d.data;
    const repsMatch = dat.main.label.match(/^(\d+)/);
    const reps = repsMatch ? parseInt(repsMatch[1]) : 1;
    const repSec = parseTime(dat.main.repTime.replace('~',''));
    const wuSec = parseTime(dat.wu.time);
    const cdSec = parseTime(dat.cd.time);
    const recoverySec = dat.main.recoverySec;
    return {kind:d.type, reps, repSec, recoverySec, wuSec, cdSec, zone:d.zone,
      totalSec: wuSec+reps*repSec+(reps-1)*recoverySec+cdSec};
  }
  if(d.type==='long'){
    const segs = d.data.segments.map(s=>({sec: distTime(s.km, state.Z[s.zone].pace), zone: s.zone==='GOAL'?'S4':s.zone}));
    const totalSec = segs.reduce((a,s)=>a+s.sec,0);
    return {kind:'long', segments:segs, totalSec};
  }
  return null;
}

export function bikeSessionName(kind){
  return {easy:'Easy spin', threshold:'Threshold ride', vo2max:'VO2max ride', long:'Long ride'}[kind] || 'Bike session';
}

export function computeBikeZones(){
  const hrr = state.profile.maxHR - state.profile.restHR;
  const CYCLING_GAP = 8; // cycling threshold typically runs 5-10bpm below running threshold for the same athlete (no impact loading, seated venous return) - not from a bike-specific test, a standard cross-sport estimate
  const cyclingLTHREstimate = state.profile.lthr - CYCLING_GAP;
  const genericTop4 = state.profile.restHR + hrr*0.90; // where the top of the threshold band would sit under plain %HRR
  const offset = genericTop4 - cyclingLTHREstimate; // shift so the threshold band actually tops out at the cycling LTHR estimate - recalculates whenever profile.lthr, maxHR, or restHR change
  const z = (lo,hi)=> Math.round(state.profile.restHR+hrr*lo-offset)+'-'+Math.round(state.profile.restHR+hrr*hi-offset)+'bpm';
  return {
    S1:{pct:'50-60%', hr:z(0.50,0.60), label:'Oppvarming', purpose:'Warm-up / recovery spin', speed:'16-20 km/h'},
    S2:{pct:'60-70%', hr:z(0.60,0.70), label:'Lett', purpose:'Easy aerobic - most cross-training volume', speed:'20-24 km/h'},
    S3:{pct:'70-80%', hr:z(0.70,0.80), label:'Aerob', purpose:'Steady aerobic', speed:'24-27 km/h'},
    S4:{pct:'80-90%', hr:z(0.80,0.90), label:'Terskel', purpose:'Threshold', speed:'27-30 km/h'},
    S5:{pct:'90-100%', hr:z(0.90,1.00), label:'Maksimalt', purpose:'Max effort', speed:'30-34+ km/h'}
  };
}
