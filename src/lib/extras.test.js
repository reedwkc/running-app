// @ts-nocheck - window.storage test mocks intentionally implement only what's used
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteExtraWorkout, extraWorkoutsForDay, loadAllExtraWorkouts, loadExtraWorkoutsForWeek, saveExtraWorkout } from './extras.js';

function mockStorage(initial){
  let saved = initial || null;
  window.storage = {
    get: vi.fn(async ()=> saved ? {value: JSON.stringify(saved)} : null),
    set: vi.fn(async (key, value)=>{ saved = JSON.parse(value); }),
  };
  return () => saved;
}

describe('saveExtraWorkout / loadAllExtraWorkouts', () => {
  beforeEach(() => { mockStorage(); });

  it('starts empty when nothing has ever been saved', async () => {
    expect(await loadAllExtraWorkouts()).toEqual([]);
  });

  it('appends a new extra with a generated id', async () => {
    const r = await saveExtraWorkout({date:'2026-08-29', dayTag:'Sat - Aug 29', weekN:4, activityType:'Run', name:'Easy shakeout'});
    expect(r.ok).toBe(true);
    expect(r.id).toBeTruthy();
    const all = await loadAllExtraWorkouts();
    expect(all.length).toBe(1);
    expect(all[0].id).toBe(r.id);
    expect(all[0].name).toBe('Easy shakeout');
  });

  it('never overwrites a different extra already logged for the same day - real accumulation, not a single slot', async () => {
    await saveExtraWorkout({date:'2026-08-29', dayTag:'Sat - Aug 29', weekN:4, activityType:'Run', name:'Morning run'});
    await saveExtraWorkout({date:'2026-08-29', dayTag:'Sat - Aug 29', weekN:4, activityType:'Strength', name:'Evening lift'});
    const all = await loadAllExtraWorkouts();
    expect(all.length).toBe(2);
    expect(all.map(e=>e.name).sort()).toEqual(['Evening lift', 'Morning run']);
  });

  it('editing in place (passing an existing id) replaces that one entry, not append a duplicate', async () => {
    const r = await saveExtraWorkout({date:'2026-08-29', dayTag:'Sat - Aug 29', weekN:4, activityType:'Run', name:'Draft', rpe:5});
    await saveExtraWorkout({id:r.id, date:'2026-08-29', dayTag:'Sat - Aug 29', weekN:4, activityType:'Run', name:'Draft', rpe:8});
    const all = await loadAllExtraWorkouts();
    expect(all.length).toBe(1);
    expect(all[0].rpe).toBe(8);
  });

  it('carries an optional retryOfTag through untouched', async () => {
    const r = await saveExtraWorkout({date:'2026-08-30', dayTag:'Sun - Aug 30', weekN:4, activityType:'Run', name:'Retry', retryOfTag:'Sat - Aug 29'});
    const all = await loadAllExtraWorkouts();
    expect(all.find(e=>e.id===r.id).retryOfTag).toBe('Sat - Aug 29');
  });

  it('does not save when existing data is unreadable, to avoid losing what was already there', async () => {
    window.storage = {get: vi.fn(async ()=>({value:'not json'})), set: vi.fn()};
    const r = await saveExtraWorkout({date:'2026-08-29', dayTag:'Sat - Aug 29', weekN:4});
    expect(r.ok).toBe(false);
    expect(window.storage.set).not.toHaveBeenCalled();
  });
});

describe('deleteExtraWorkout', () => {
  beforeEach(() => { mockStorage(); });

  it('removes only the targeted entry', async () => {
    const a = await saveExtraWorkout({date:'2026-08-29', dayTag:'Sat - Aug 29', weekN:4, name:'Keep'});
    const b = await saveExtraWorkout({date:'2026-08-29', dayTag:'Sat - Aug 29', weekN:4, name:'Remove'});
    await deleteExtraWorkout(b.id);
    const all = await loadAllExtraWorkouts();
    expect(all.length).toBe(1);
    expect(all[0].id).toBe(a.id);
  });
});

describe('extraWorkoutsForDay', () => {
  it('filters a preloaded list by dayTag only', () => {
    const all = [
      {id:'1', dayTag:'Sat - Aug 29', name:'A'},
      {id:'2', dayTag:'Sun - Aug 30', name:'B'},
      {id:'3', dayTag:'Sat - Aug 29', name:'C'},
    ];
    const forSat = extraWorkoutsForDay(all, 'Sat - Aug 29');
    expect(forSat.map(e=>e.id).sort()).toEqual(['1','3']);
  });

  it('returns an empty array for a null/undefined list', () => {
    expect(extraWorkoutsForDay(null, 'Sat - Aug 29')).toEqual([]);
  });
});

describe('loadExtraWorkoutsForWeek', () => {
  const week = {n:4, dates:'Aug 24-30', days:[{tag:'Mon - Aug 24'}, {tag:'Sat - Aug 29'}]};

  it('includes an extra whose date falls anywhere inside the week, not just on a planned day', async () => {
    const all = [
      {id:'1', date:'2026-08-24', dayTag:'Mon - Aug 24'},
      {id:'2', date:'2026-08-27', dayTag:'Thu - Aug 27'}, // an open day, not in week.days
      {id:'3', date:'2026-09-05', dayTag:'Sat - Sep 5'}, // a different week entirely
    ];
    const result = await loadExtraWorkoutsForWeek(week, all);
    expect(result.map(e=>e.id).sort()).toEqual(['1','2']);
  });

  it('returns an empty array for a week with no days', async () => {
    expect(await loadExtraWorkoutsForWeek({n:1, dates:'', days:[]})).toEqual([]);
  });
});
