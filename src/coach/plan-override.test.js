// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../state.js';
import { defaultGoalConfig } from '../data/goal-config.js';
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
