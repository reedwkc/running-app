// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../state.js';
import { defaultGoalConfig } from '../data/goal-config.js';
import { validatePlanOverride } from './plan-override.js';

function baseWeek(n, overrides){
  return Object.assign({
    n, dates:'Aug 3-9', cutback:false, race:false, callout:null,
    days:[{tag:'Wed - Aug 5', name:'Threshold', zone:'S4', type:'threshold', data:{totalKm:'8.5'}}],
  }, overrides);
}

describe('validatePlanOverride', () => {
  beforeEach(() => {
    state.goalConfig = defaultGoalConfig();
    state.recentSaveCache = {};
    window.storage = {get: vi.fn().mockResolvedValue(null)};
  });

  it('errors on a missing weeks array', async () => {
    const {errors} = await validatePlanOverride([], {});
    expect(errors.length).toBeGreaterThan(0);
  });

  it('errors on an empty weeks array', async () => {
    const {errors} = await validatePlanOverride([], {weeks:[]});
    expect(errors.length).toBeGreaterThan(0);
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
