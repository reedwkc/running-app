// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../state.js';
import { defaultGoalConfig } from '../data/goal-config.js';
import { buildWeeks, computeZones } from '../data/plan.js';
import { goalConfigPatchDiffHTML, validatePlanOverride } from './plan-override.js';

function baseWeek(n, overrides){
  return Object.assign({
    n, dates:'Aug 3-9', cutback:false, race:false, callout:null,
    days:[{tag:'Wed - Aug 5', name:'Threshold', zone:'S4', type:'threshold', data:{totalKm:'8.5'}}],
  }, overrides);
}

describe('goalConfigPatchDiffHTML', () => {
  it('produces no diff rows when the patch exactly matches state.goalConfig - the function itself is correct; a live report of "(new)"/"removed" for an unchanged goal traced to state.goalConfig going stale during the ~10-20s LLM call, not this function (fixed by re-fetching goalConfig right before render, not just at request start)', () => {
    state.goalConfig = JSON.parse("{\"version\":1,\"phase\":\"race-build\",\"activeGoals\":[{\"goalId\":\"hm-sub135\",\"type\":\"HM\",\"zoneKey\":\"GOAL\",\"label\":\"Half Marathon\",\"raceName\":\"Lierlopet Halvmaraton\",\"distanceKm\":21.0975,\"raceDate\":\"2026-09-27\",\"goalTimeSec\":5400,\"goalTimeLabel\":\"Sub-1:30:00\",\"goalPaceSec\":256,\"goalPaceLabel\":\"4:16/km\",\"goalHR\":\"168-172\"},{\"goalId\":\"10k-lierlopet\",\"type\":\"10K\",\"zoneKey\":\"RACE10K\",\"label\":\"10K\",\"raceName\":\"Lierlopet\",\"distanceKm\":10,\"raceDate\":\"2026-08-30\",\"goalTimeSec\":2460,\"goalTimeLabel\":\"Sub-41:00\",\"goalPaceSec\":246,\"goalPaceLabel\":\"4:06/km\",\"goalHR\":\"175-185\"}]}");
    const patch = JSON.parse("{\"phase\":\"race-build\",\"activeGoals\":[{\"goalId\":\"hm-sub135\",\"type\":\"HM\",\"zoneKey\":\"GOAL\",\"label\":\"Half Marathon\",\"raceName\":\"Lierlopet Halvmaraton\",\"distanceKm\":21.0975,\"raceDate\":\"2026-09-27\",\"goalTimeSec\":5400,\"goalTimeLabel\":\"Sub-1:30:00\",\"goalPaceSec\":256,\"goalPaceLabel\":\"4:16/km\",\"goalHR\":\"168-172\"},{\"goalId\":\"10k-lierlopet\",\"type\":\"10K\",\"zoneKey\":\"RACE10K\",\"label\":\"10K\",\"raceName\":\"Lierlopet\",\"distanceKm\":10,\"raceDate\":\"2026-08-30\",\"goalTimeSec\":2460,\"goalTimeLabel\":\"Sub-41:00\",\"goalPaceSec\":246,\"goalPaceLabel\":\"4:06/km\",\"goalHR\":\"175-185\"}]}");
    expect(goalConfigPatchDiffHTML(patch)).toBe('');
  });

  it('shows a real before/after row when a goal actually changes', () => {
    state.goalConfig = defaultGoalConfig();
    const patch = {activeGoals:[{goalId:'hm-sub135', type:'HM', label:'Half Marathon', goalTimeLabel:'Sub-1:30:00', goalPaceLabel:'4:16/km'}]};
    const html = goalConfigPatchDiffHTML(patch);
    expect(html).toContain('Sub-1:35:00');
    expect(html).toContain('Sub-1:30:00');
  });

  it('shows a phase change row', () => {
    state.goalConfig = defaultGoalConfig();
    const html = goalConfigPatchDiffHTML({phase:'maintenance', activeGoals:[]});
    expect(html).toContain('race-build');
    expect(html).toContain('maintenance');
  });
});

describe('validatePlanOverride', () => {
  beforeEach(() => {
    state.goalConfig = defaultGoalConfig();
    state.recentSaveCache = {};
    window.storage = {get: vi.fn().mockResolvedValue(null)};
  });

  it('errors when goalConfigPatch renames an existing goal\'s goalId instead of keeping it stable (the exact regression this caught: "hm-sub135" -> "hm-sub132" just because the target time changed)', async () => {
    const proposed = {weeks:[], goalConfigPatch:{activeGoals:[
      {goalId:'hm-sub132', zoneKey:'GOAL', type:'HM', goalTimeLabel:'Sub-1:32:00'},
      {goalId:'10k-lierlopet', zoneKey:'RACE10K', type:'10K', goalTimeLabel:'Sub-41:00'},
    ]}};
    const {errors} = await validatePlanOverride([], proposed);
    expect(errors.some(e=>e.includes('renames') && e.includes('hm-sub135') && e.includes('hm-sub132'))).toBe(true);
  });

  it('does not error when goalConfigPatch keeps the existing goalId stable while changing the target', async () => {
    const proposed = {weeks:[], goalConfigPatch:{activeGoals:[
      {goalId:'hm-sub135', zoneKey:'GOAL', type:'HM', goalTimeLabel:'Sub-1:32:00'},
      {goalId:'10k-lierlopet', zoneKey:'RACE10K', type:'10K', goalTimeLabel:'Sub-41:00'},
    ]}};
    const {errors} = await validatePlanOverride([], proposed);
    expect(errors).toEqual([]);
  });

  it('errors on a missing weeks array', async () => {
    const {errors} = await validatePlanOverride([], {});
    expect(errors.length).toBeGreaterThan(0);
  });

  it('errors on an empty weeks array with no goalConfigPatch', async () => {
    const {errors} = await validatePlanOverride([], {weeks:[]});
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts an empty weeks array when a goalConfigPatch is present - pace/goal-target-only changes don\'t need week structure touched', async () => {
    const proposed = {weeks:[], goalConfigPatch:{activeGoals:[{goalId:'hm-sub135', zoneKey:'GOAL', goalPaceSec:260}]}};
    const {errors} = await validatePlanOverride([], proposed);
    expect(errors).toEqual([]);
  });

  it('errors when goalConfigPatch.activeGoals entries use invented field names instead of the real schema (the exact regression this caught: "id"/"targetTime" instead of "goalId"/"zoneKey")', async () => {
    const malformed = {weeks:[], goalConfigPatch:{activeGoals:[{id:'hm-sub135', targetTime:'1:31:30'}]}};
    const {errors} = await validatePlanOverride([], malformed);
    expect(errors.some(e=>e.includes('goalId'))).toBe(true);
  });

  it('errors on a day with an unrecognized type', async () => {
    const proposed = {weeks:[baseWeek(1, {days:[{tag:'Wed - Aug 5', name:'X', zone:'S4', type:'sprint', data:{}}]})]};
    const {errors} = await validatePlanOverride([], proposed);
    expect(errors.some(e=>e.includes('unrecognized type'))).toBe(true);
  });

  it('passes clean structural input with no warnings when nothing is anomalous', async () => {
    const current = [baseWeek(1, {days:[{tag:'Wed - Aug 5', name:'Threshold', zone:'S4', type:'threshold', data:{totalKm:'8.5'}}]})];
    const proposed = {weeks:[baseWeek(1, {days:[{tag:'Wed - Aug 5', name:'Threshold', zone:'S4', type:'threshold', data:{totalKm:'8.6'}}]})]};
    const {errors, warnings} = await validatePlanOverride(current, proposed);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('warns on a >10% week-over-week jump outside cutback/race weeks', async () => {
    const current = [
      baseWeek(1, {days:[{tag:'Wed - Aug 5', name:'Easy', zone:'S2', type:'easy', data:{km:20}}]}),
      baseWeek(2, {dates:'Aug 10-16', days:[{tag:'Wed - Aug 12', name:'Easy', zone:'S2', type:'easy', data:{km:22}}]}),
    ];
    const proposed = {weeks:[baseWeek(2, {dates:'Aug 10-16', days:[{tag:'Wed - Aug 12', name:'Easy', zone:'S2', type:'easy', data:{km:30}}]})]};
    const {warnings} = await validatePlanOverride(current, proposed);
    expect(warnings.some(w=>w.includes('jumps'))).toBe(true);
  });

  it('does not surface a pre-existing week-over-week jump for weeks the proposal never touches (goalConfigPatch-only case)', async () => {
    // Week 1 -> Week 2 already jumps >10% in the CURRENT plan, unrelated to this proposal -
    // a pure goal-pace change (empty weeks) shouldn't dredge up that pre-existing, unrelated
    // characteristic as if this change caused it.
    const current = [
      baseWeek(1, {days:[{tag:'Wed - Aug 5', name:'Easy', zone:'S2', type:'easy', data:{km:20}}]}),
      baseWeek(2, {dates:'Aug 10-16', days:[{tag:'Wed - Aug 12', name:'Easy', zone:'S2', type:'easy', data:{km:30}}]}),
    ];
    const proposed = {weeks:[], goalConfigPatch:{activeGoals:[{goalId:'hm-sub135', zoneKey:'GOAL', goalPaceSec:256}]}};
    const {warnings} = await validatePlanOverride(current, proposed);
    expect(warnings.some(w=>w.includes('jumps'))).toBe(false);
  });

  it('still surfaces overload for a pair where one of the two weeks IS actually touched by the proposal', async () => {
    const current = [
      baseWeek(1, {days:[{tag:'Wed - Aug 5', name:'Easy', zone:'S2', type:'easy', data:{km:20}}]}),
      baseWeek(2, {dates:'Aug 10-16', days:[{tag:'Wed - Aug 12', name:'Easy', zone:'S2', type:'easy', data:{km:22}}]}),
    ];
    const proposed = {weeks:[baseWeek(2, {dates:'Aug 10-16', days:[{tag:'Wed - Aug 12', name:'Easy', zone:'S2', type:'easy', data:{km:30}}]})]};
    const {warnings} = await validatePlanOverride(current, proposed);
    expect(warnings.some(w=>w.includes('jumps'))).toBe(true);
  });

  it('does not warn on overload when the jump is into/out of a cutback or race week', async () => {
    const current = [baseWeek(1, {days:[{tag:'Wed - Aug 5', name:'Easy', zone:'S2', type:'easy', data:{km:20}}]})];
    const proposed = {weeks:[baseWeek(1, {cutback:true, days:[{tag:'Wed - Aug 5', name:'Easy', zone:'S2', type:'easy', data:{km:40}}]})]};
    const {warnings} = await validatePlanOverride(current, proposed);
    expect(warnings.some(w=>w.includes('jumps'))).toBe(false);
  });

  it('warns when a proposal resumes full volume right after a real logged layoff instead of ramping back in', async () => {
    const oldDate = new Date(Date.now() - 90*86400000).toISOString().slice(0,10); // 90 days off -> 'significant' severity, rampWeeksRecommended:3
    window.storage = {get: vi.fn(async (key)=> key==='last-activity-date' ? {value: JSON.stringify({date: oldDate})} : null)};
    const current = [baseWeek(1, {days:[{tag:'Wed - Aug 5', name:'Easy', zone:'S2', type:'easy', data:{km:20}}]})];
    const proposed = {weeks:[baseWeek(2, {dates:'Aug 10-16', days:[{tag:'Wed - Aug 12', name:'Easy', zone:'S2', type:'easy', data:{km:20}}]})]};
    const {warnings} = await validatePlanOverride(current, proposed);
    expect(warnings.some(w=>w.includes('layoff') && w.includes('ramp'))).toBe(true);
  });

  it('does not warn about a layoff ramp when the proposal itself already reduces volume from the prior week', async () => {
    const oldDate = new Date(Date.now() - 90*86400000).toISOString().slice(0,10);
    window.storage = {get: vi.fn(async (key)=> key==='last-activity-date' ? {value: JSON.stringify({date: oldDate})} : null)};
    const current = [baseWeek(1, {days:[{tag:'Wed - Aug 5', name:'Easy', zone:'S2', type:'easy', data:{km:20}}]})];
    const proposed = {weeks:[baseWeek(2, {dates:'Aug 10-16', days:[{tag:'Wed - Aug 12', name:'Easy', zone:'S2', type:'easy', data:{km:10}}]})]};
    const {warnings} = await validatePlanOverride(current, proposed);
    expect(warnings.some(w=>w.includes('layoff'))).toBe(false);
  });

  it('does not warn about a layoff ramp with no logged layoff at all', async () => {
    const current = [baseWeek(1, {days:[{tag:'Wed - Aug 5', name:'Easy', zone:'S2', type:'easy', data:{km:20}}]})];
    const proposed = {weeks:[baseWeek(2, {dates:'Aug 10-16', days:[{tag:'Wed - Aug 12', name:'Easy', zone:'S2', type:'easy', data:{km:20}}]})]};
    const {warnings} = await validatePlanOverride(current, proposed);
    expect(warnings.some(w=>w.includes('layoff'))).toBe(false);
  });

  it('warns when a week right after a race has no real recovery week (reproduces the current live Week 4->5 shape as a regression check)', async () => {
    state.profile = {lthr:171, ltPaceSec:275, maxHR:191, vo2max:53, restHR:40};
    state.Z = computeZones(state.profile, defaultGoalConfig());
    const allWeeks = buildWeeks();
    const week4 = allWeeks.find(w=>w.n===4), week5 = allWeeks.find(w=>w.n===5);
    const {warnings} = await validatePlanOverride([week4, week5], {weeks:[], goalConfigPatch:{activeGoals:[{goalId:'hm-sub135', zoneKey:'GOAL', goalPaceSec:256}]}});
    expect(warnings.some(w=>w.includes('recovery week') && w.includes('Week 4'))).toBe(true);
  });

  it('does not warn about post-race recovery when the following week is genuinely reduced with no quality work', async () => {
    const current = [
      baseWeek(4, {dates:'Aug 24-30', cutback:true, race:true, days:[{tag:'Sun - Aug 30', name:'10K Race', zone:'RACE10K', type:'race', data:{km:10}}]}),
      baseWeek(5, {dates:'Aug 31-Sep 6', days:[{tag:'Wed - Sep 2', name:'Easy', zone:'S2', type:'easy', data:{km:5}}]}),
    ];
    const {warnings} = await validatePlanOverride(current, {weeks:[], goalConfigPatch:{activeGoals:[{goalId:'hm-sub135', zoneKey:'GOAL', goalPaceSec:256}]}});
    expect(warnings.some(w=>w.includes('recovery week'))).toBe(false);
  });

  it('warns when a half-marathon\'s second recovery week resumes quality work too soon, even though the first week after the race was properly eased back', async () => {
    const current = [
      baseWeek(8, {dates:'Sep 21-27', cutback:true, race:true, days:[{tag:'Sun - Sep 27', name:'RACE - Half Marathon', zone:'Goal', type:'race', data:{km:21.1}}]}),
      baseWeek(9, {dates:'Sep 28-Oct 4', days:[{tag:'Wed - Sep 30', name:'Easy', zone:'S2', type:'easy', data:{km:5}}]}),
      baseWeek(10, {dates:'Oct 5-11', days:[{tag:'Wed - Oct 7', name:'Threshold', zone:'S4', type:'threshold', data:{totalKm:'6'}}]}),
    ];
    const {warnings} = await validatePlanOverride(current, {weeks:[], goalConfigPatch:{activeGoals:[{goalId:'hm-sub135', zoneKey:'GOAL', goalPaceSec:256}]}});
    expect(warnings.some(w=>w.includes('needs') && w.includes('2 weeks') && w.includes('week 10'))).toBe(true);
  });

  it('does not warn about a half-marathon\'s recovery when both weeks after the race are genuinely reduced with no quality work', async () => {
    const current = [
      baseWeek(8, {dates:'Sep 21-27', cutback:true, race:true, days:[{tag:'Sun - Sep 27', name:'RACE - Half Marathon', zone:'Goal', type:'race', data:{km:21.1}}]}),
      baseWeek(9, {dates:'Sep 28-Oct 4', days:[{tag:'Wed - Sep 30', name:'Easy', zone:'S2', type:'easy', data:{km:5}}]}),
      baseWeek(10, {dates:'Oct 5-11', days:[{tag:'Wed - Oct 7', name:'Easy', zone:'S2', type:'easy', data:{km:6}}]}),
    ];
    const {warnings} = await validatePlanOverride(current, {weeks:[], goalConfigPatch:{activeGoals:[{goalId:'hm-sub135', zoneKey:'GOAL', goalPaceSec:256}]}});
    expect(warnings.some(w=>w.includes('needs'))).toBe(false);
  });

  it('errors when a proposed race day is tagged with a different date than the goal\'s actual raceDate - caught live: a proposal correcting a weekday-label bug shifted the real race date by a day in the process', async () => {
    state.goalConfig = {version:1, phase:'race-build', activeGoals:[{goalId:'hm-sub135', zoneKey:'GOAL', type:'HM', raceDate:'2026-09-05', goalTimeLabel:'Sub-1:35:00'}]};
    const proposed = {weeks:[baseWeek(5, {dates:'Sep 1-7', race:true, days:[
      {tag:'Sun - Sep 6', name:'RACE - Drammen Halvmaraton', zone:'Goal', type:'race', goalId:'hm-sub135', data:{km:21.1}},
    ]})]};
    const {errors} = await validatePlanOverride([], proposed);
    expect(errors.some(e=>e.includes('race day') && e.includes('2026-09-06') && e.includes('2026-09-05'))).toBe(true);
  });

  it('does not error when the proposed race day tag matches the goal\'s actual raceDate exactly', async () => {
    state.goalConfig = {version:1, phase:'race-build', activeGoals:[{goalId:'hm-sub135', zoneKey:'GOAL', type:'HM', raceDate:'2026-09-05', goalTimeLabel:'Sub-1:35:00'}]};
    const proposed = {weeks:[baseWeek(5, {dates:'Sep 1-7', race:true, days:[
      {tag:'Sat - Sep 5', name:'RACE - Drammen Halvmaraton', zone:'Goal', type:'race', goalId:'hm-sub135', data:{km:21.1}},
    ]})]};
    const {errors} = await validatePlanOverride([], proposed);
    expect(errors).toEqual([]);
  });

  it('warns when a long run exceeds ~30% of its own week total', async () => {
    const proposed = {weeks:[baseWeek(1, {days:[
      {tag:'Wed - Aug 5', name:'Easy', zone:'S2', type:'easy', data:{km:10}},
      {tag:'Sat - Aug 8', name:'Long run', zone:'S2', type:'long', data:{totalKm:'15'}},
    ]})]};
    const {warnings} = await validatePlanOverride([], proposed);
    expect(warnings.some(w=>w.includes('% of that week'))).toBe(true);
  });

  it('warns when a long run exceeds the active race distance itself', async () => {
    const proposed = {weeks:[baseWeek(1, {days:[
      {tag:'Sat - Aug 8', name:'Long run', zone:'S2', type:'long', data:{totalKm:'25'}},
    ]})]};
    const {warnings} = await validatePlanOverride([], proposed);
    expect(warnings.some(w=>w.includes('longer than the'))).toBe(true);
  });

  it('warns on back-to-back threshold/vo2max days with no rest day between', async () => {
    const proposed = {weeks:[baseWeek(1, {days:[
      {tag:'Wed - Aug 5', name:'Threshold', zone:'S4', type:'threshold', data:{totalKm:'8'}},
      {tag:'Thu - Aug 6', name:'VO2max', zone:'S5', type:'vo2max', data:{totalKm:'8'}},
    ]})]};
    const {warnings} = await validatePlanOverride([], proposed);
    expect(warnings.some(w=>w.includes('back-to-back'))).toBe(true);
  });

  it('does not warn on quality days that already have a rest/easy day between them', async () => {
    const proposed = {weeks:[baseWeek(1, {days:[
      {tag:'Mon - Aug 3', name:'Threshold', zone:'S4', type:'threshold', data:{totalKm:'8'}},
      {tag:'Wed - Aug 5', name:'VO2max', zone:'S5', type:'vo2max', data:{totalKm:'8'}},
    ]})]};
    const {warnings} = await validatePlanOverride([], proposed);
    expect(warnings.some(w=>w.includes('back-to-back'))).toBe(false);
  });

  it('warns when a proposed day references the GOAL zone but no HM-equivalent goal is active', async () => {
    state.goalConfig = {version:1, phase:'maintenance', activeGoals:[]};
    const proposed = {weeks:[baseWeek(1, {days:[
      {tag:'Sat - Aug 8', name:'Long run', zone:'S2-Goal', type:'long', data:{totalKm:'10'}},
    ]})]};
    const {warnings} = await validatePlanOverride([], proposed);
    expect(warnings.some(w=>w.includes('GOAL pace zone'))).toBe(true);
  });

  it('warns when a goalConfigPatch sets a meaningfully faster target with no week restructuring at all - the exact live complaint: sub-1:35 -> sub-1:30 accepted with zero change to training structure', async () => {
    const proposed = {weeks:[], goalConfigPatch:{activeGoals:[
      {goalId:'hm-sub135', zoneKey:'GOAL', type:'HM', goalTimeSec:5400, goalTimeLabel:'Sub-1:30:00'}, // 5700 -> 5400, ~5.3% faster
    ]}};
    const {errors, warnings} = await validatePlanOverride([], proposed);
    expect(errors).toEqual([]);
    expect(warnings.some(w=>w.includes('faster') && w.includes('NO change'))).toBe(true);
  });

  it('does not warn on a small goal-target nudge that just reflects fitness already gained', async () => {
    const proposed = {weeks:[], goalConfigPatch:{activeGoals:[
      {goalId:'hm-sub135', zoneKey:'GOAL', type:'HM', goalTimeSec:5670, goalTimeLabel:'Sub-1:34:30'}, // 5700 -> 5670, <1% faster
    ]}};
    const {warnings} = await validatePlanOverride([], proposed);
    expect(warnings.some(w=>w.includes('NO change'))).toBe(false);
  });

  it('does not warn on a meaningfully faster goal when the proposal actually restructures weeks alongside it', async () => {
    const proposed = {weeks:[baseWeek(3, {days:[{tag:'Wed - Aug 19', name:'Threshold', zone:'S4', type:'threshold', data:{totalKm:'10'}}]})], goalConfigPatch:{activeGoals:[
      {goalId:'hm-sub135', zoneKey:'GOAL', type:'HM', goalTimeSec:5400, goalTimeLabel:'Sub-1:30:00'},
    ]}};
    const {warnings} = await validatePlanOverride([], proposed);
    expect(warnings.some(w=>w.includes('NO change'))).toBe(false);
  });

  it('warns when a proposed non-race day falls outside the runner\'s preferred training days (Mon/Wed/Thu/Sat)', async () => {
    const proposed = {weeks:[baseWeek(1, {days:[{tag:'Tue - Aug 4', name:'Threshold', zone:'S4', type:'threshold', data:{totalKm:'8.5'}}]})]};
    const {warnings} = await validatePlanOverride([], proposed);
    expect(warnings.some(w=>w.includes('Tue') && w.includes('preferred training days'))).toBe(true);
  });

  it('does not warn about preferred training days when every non-race day lands on Mon/Wed/Thu/Sat', async () => {
    const proposed = {weeks:[baseWeek(1, {days:[
      {tag:'Mon - Aug 3', name:'Threshold', zone:'S4', type:'threshold', data:{totalKm:'8'}},
      {tag:'Thu - Aug 6', name:'Easy', zone:'S2', type:'easy', data:{km:9}},
      {tag:'Sat - Aug 8', name:'Long run', zone:'S2', type:'long', data:{totalKm:'16'}},
    ]})]};
    const {warnings} = await validatePlanOverride([], proposed);
    expect(warnings.some(w=>w.includes('preferred training days'))).toBe(false);
  });

  it('does not warn about preferred training days for a race day, since it must land on the real calendar date regardless of weekday', async () => {
    state.goalConfig = {version:1, phase:'race-build', activeGoals:[{goalId:'hm-sub135', zoneKey:'GOAL', type:'HM', raceDate:'2026-09-06', goalTimeLabel:'Sub-1:35:00'}]};
    const proposed = {weeks:[baseWeek(5, {dates:'Sep 1-7', race:true, days:[
      {tag:'Sun - Sep 6', name:'RACE - Half Marathon', zone:'Goal', type:'race', goalId:'hm-sub135', data:{km:21.1}},
    ]})]};
    const {warnings} = await validatePlanOverride([], proposed);
    expect(warnings.some(w=>w.includes('preferred training days'))).toBe(false);
  });

  it('warns when a cutback/taper week starts more than a week before the race with no active layoff on record (the "taper is too long" regression)', async () => {
    state.goalConfig = {version:1, phase:'race-build', activeGoals:[{goalId:'hm-sub135', zoneKey:'GOAL', type:'HM', raceDate:'2026-09-27', goalTimeLabel:'Sub-1:35:00'}]};
    // Week starting Sep 14 is 13 days before the Sep 27 race - a second taper week, not race week itself.
    // The race week itself comes from the existing/current plan (classifyReducedWeek needs
    // to find the actual race day to know this cutback week is a pre-race taper, not recovery).
    const current = [baseWeek(8, {dates:'Sep 21-27', race:true, days:[
      {tag:'Sun - Sep 27', name:'RACE - Half Marathon', zone:'Goal', type:'race', goalId:'hm-sub135', data:{km:21.1}},
    ]})];
    const proposed = {weeks:[baseWeek(7, {dates:'Sep 14-20', cutback:true, days:[{tag:'Mon - Sep 14', name:'Threshold (shorter)', zone:'S4', type:'threshold', data:{totalKm:'6'}}]})]};
    const {warnings} = await validatePlanOverride(current, proposed);
    expect(warnings.some(w=>w.includes('cutback/taper') && w.includes('13 days'))).toBe(true);
  });

  it('does not warn about taper length for a cutback week that\'s actually POST-race recovery, not pre-race taper', async () => {
    state.goalConfig = {version:1, phase:'race-build', activeGoals:[{goalId:'10k-lierlopet', zoneKey:'RACE10K', type:'10K', raceDate:'2026-08-30', goalTimeLabel:'Sub-43:00'}]};
    const current = [baseWeek(4, {dates:'Aug 24-30', cutback:true, race:true, days:[
      {tag:'Sun - Aug 30', name:'RACE - 10K', zone:'RACE10K', type:'race', goalId:'10k-lierlopet', data:{km:10}},
    ]})];
    // Week 5 starts the day after the race and is still eased back (cutback) - this is
    // RECOVERY, not a taper running long, even though it's also >7 "days before" some other
    // distant goal race.
    const proposed = {weeks:[baseWeek(5, {dates:'Aug 31-Sep 6', cutback:true, days:[{tag:'Wed - Sep 2', name:'Easy', zone:'S2', type:'easy', data:{km:6}}]})]};
    const {warnings} = await validatePlanOverride(current, proposed);
    expect(warnings.some(w=>w.includes('cutback/taper'))).toBe(false);
  });

  it('does not warn about taper length for the week actually containing the race', async () => {
    state.goalConfig = {version:1, phase:'race-build', activeGoals:[{goalId:'hm-sub135', zoneKey:'GOAL', type:'HM', raceDate:'2026-09-27', goalTimeLabel:'Sub-1:35:00'}]};
    const proposed = {weeks:[baseWeek(8, {dates:'Sep 21-27', cutback:true, race:true, days:[
      {tag:'Mon - Sep 21', name:'Easy run', zone:'S2', type:'easy', data:{km:7}},
      {tag:'Sun - Sep 27', name:'RACE - Half Marathon', zone:'Goal', type:'race', goalId:'hm-sub135', data:{km:21.1}},
    ]})]};
    const {warnings} = await validatePlanOverride([], proposed);
    expect(warnings.some(w=>w.includes('cutback/taper'))).toBe(false);
  });

  it('does not warn about taper length when a real, currently-active layoff justifies the longer reduced-volume period', async () => {
    const oldDate = new Date(Date.now() - 90*86400000).toISOString().slice(0,10);
    window.storage = {get: vi.fn(async (key)=> key==='last-activity-date' ? {value: JSON.stringify({date: oldDate})} : null)};
    state.goalConfig = {version:1, phase:'race-build', activeGoals:[{goalId:'hm-sub135', zoneKey:'GOAL', type:'HM', raceDate:'2026-09-27', goalTimeLabel:'Sub-1:35:00'}]};
    const proposed = {weeks:[baseWeek(7, {dates:'Sep 14-20', cutback:true, days:[{tag:'Mon - Sep 14', name:'Threshold (shorter)', zone:'S4', type:'threshold', data:{totalKm:'6'}}]})]};
    const {warnings} = await validatePlanOverride([], proposed);
    expect(warnings.some(w=>w.includes('cutback/taper'))).toBe(false);
  });

  it('flags a dropped day-tag that has real logged history, without blocking', async () => {
    const current = [baseWeek(1, {days:[
      {tag:'Wed - Aug 5', name:'Threshold', zone:'S4', type:'threshold', data:{totalKm:'8.5'}},
      {tag:'Sat - Aug 8', name:'Long run', zone:'S2', type:'long', data:{totalKm:'16'}},
    ]})];
    window.storage = {get: vi.fn(async (key)=>{
      if(key==='workout-w1-SatAug8') return {value: JSON.stringify({completed:true, actualDist:'16'})};
      return null;
    })};
    const proposed = {weeks:[baseWeek(1, {days:[
      {tag:'Wed - Aug 5', name:'Threshold', zone:'S4', type:'threshold', data:{totalKm:'8.5'}},
    ]})]};
    const {errors, warnings} = await validatePlanOverride(current, proposed);
    expect(errors).toEqual([]);
    expect(warnings.some(w=>w.includes('logged history'))).toBe(true);
  });
});
