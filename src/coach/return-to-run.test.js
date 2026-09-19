// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../state.js';
import {
  applyInjuryStatusBlock,
  computeReturnProtocol,
  detectPossibleInjury,
  dismissInjuryPromptFor,
  isInjuryPromptDismissed,
  getActiveReturnToRun,
  getEffectivePaceRestriction,
  loadInjuryStatus,
  markRunSinceInjury,
  openOrUpdateInjury,
  parseInjuryStatusBlock,
  reopenLastInjury,
  resolveInjury,
  stripInjuryStatusBlock,
  RETURN_TIERS,
  INJURY_PROMPT_SILENT_QUIET_DAYS,
} from './return-to-run.js';

function mockStorage(initial){
  const store = Object.assign({}, initial||{});
  window.storage = {
    get: vi.fn(async (key) => store[key]!==undefined ? {value: store[key]} : null),
    set: vi.fn(async (key, value) => { store[key] = value; }),
    delete: vi.fn(async (key) => { delete store[key]; }),
  };
  return store;
}

// A plain 40km week with a 14km long run, matching the shape of a real base week in this
// block - the return ramp is expressed as a percentage of exactly this.
function planWeek(n, dates, opts){
  const o = opts||{};
  return {
    n, dates,
    cutback: !!o.cutback, race: !!o.race,
    days: [
      {tag:'Mon - '+o.mon, name:'Easy run', type:'easy', zone:'S2', data:{km:8}},
      {tag:'Wed - '+o.wed, name:'Easy run', type:'easy', zone:'S2', data:{km:7}},
      {tag:'Thu - '+o.thu, name:'Medium-long run', type:'easy', zone:'S2', data:{km:10}},
      {tag:'Sat - '+o.sat, name:'Long run', type:'long', zone:'S2', data:{segments:[{km:14,zone:'S2'}], totalKm:'14.0'}},
    ],
  };
}

beforeEach(()=>{
  mockStorage();
  state.WEEKS = [
    planWeek(6, 'Sep 7-13', {mon:'Sep 7', wed:'Sep 9', thu:'Sep 10', sat:'Sep 12'}),
    planWeek(7, 'Sep 14-20', {mon:'Sep 14', wed:'Sep 16', thu:'Sep 17', sat:'Sep 19'}),
  ];
  state.returnToRun = null;
  state.injuryPrompt = null;
});

describe('computeReturnProtocol', () => {
  it('scales the ramp with how long running actually stopped, not with fitness decay', () => {
    expect(computeReturnProtocol({daysOut:3, severity:'pain'}).rampWeeks).toBe(1);
    expect(computeReturnProtocol({daysOut:10, severity:'pain'}).rampWeeks).toBe(2);
    expect(computeReturnProtocol({daysOut:20, severity:'pain'}).rampWeeks).toBe(3);
    expect(computeReturnProtocol({daysOut:200, severity:'pain'}).rampWeeks).toBe(6);
  });

  // The whole reason this module exists: the layoff tiers return rampWeeksRecommended 0 for
  // anything under 14 days, so a real injury layoff got no ramp at all.
  it('gives a real ramp at 8 days out, where the layoff tiers give none', () => {
    const p = computeReturnProtocol({daysOut:8, severity:'pain'});
    expect(p.rampWeeks).toBeGreaterThan(0);
    expect(p.qualityHoldWeeks).toBeGreaterThan(0);
    expect(p.firstWeekVolumePct).toBeLessThan(100);
  });

  it('never gives something reported as a full injury the most minimal tier, however few days it cost', () => {
    expect(computeReturnProtocol({daysOut:2, severity:'injury'}).tierIndex).toBe(1);
    expect(computeReturnProtocol({daysOut:2, severity:'ache'}).tierIndex).toBe(0);
  });

  it('lets duration outrank severity rather than capping at the severity floor', () => {
    expect(computeReturnProtocol({daysOut:40, severity:'ache'}).rampWeeks).toBe(4);
  });

  it('falls back to "pain" rather than accepting an unrecognized severity', () => {
    expect(computeReturnProtocol({daysOut:1, severity:'catastrophic'}).severity).toBe('pain');
  });

  it('every tier holds quality work for at least a week - volume always comes back first', () => {
    RETURN_TIERS.forEach(t=>{ expect(t.qualityHoldWeeks).toBeGreaterThanOrEqual(1); });
  });
});

describe('opening and resolving an injury', () => {
  it('snapshots the pre-injury week from the plan, so the ramp has something real to scale against', async () => {
    const inj = await openOrUpdateInjury({bodyPart:'right quad', severity:'pain', startDate:'2026-09-16'});
    expect(inj.preInjuryWeeklyKm).toBe(39);
    expect(inj.preInjuryLongRunKm).toBe(14);
  });

  it('reporting the same injury a second way updates the one episode rather than opening another', async () => {
    await openOrUpdateInjury({bodyPart:'right quad', severity:'pain', startDate:'2026-09-16', source:'skip'});
    const second = await openOrUpdateInjury({bodyPart:'right quad', severity:'injury', startDate:'2026-09-16', source:'chat'});
    expect(second.id).toBeDefined();
    const full = JSON.parse(window.storage.set.mock.calls.at(-1)[1]);
    expect(full.current.id).toBe(second.id);
    expect(full.past).toHaveLength(0);
  });

  it('escalates severity but never silently downgrades it', async () => {
    await openOrUpdateInjury({bodyPart:'right quad', severity:'injury', startDate:'2026-09-16'});
    const after = await openOrUpdateInjury({bodyPart:'right quad', severity:'ache'});
    expect(after.severity).toBe('injury');
  });

  it('accepts an earlier start date as new information, ignores a later one', async () => {
    await openOrUpdateInjury({severity:'pain', startDate:'2026-09-16'});
    expect((await openOrUpdateInjury({severity:'pain', startDate:'2026-09-05'})).startDate).toBe('2026-09-05');
    expect((await openOrUpdateInjury({severity:'pain', startDate:'2026-09-17'})).startDate).toBe('2026-09-05');
  });

  it('archives a resolved episode instead of deleting it, and can undo an accidental clear without resetting the ramp', async () => {
    await openOrUpdateInjury({bodyPart:'right quad', severity:'pain', startDate:'2026-09-05'});
    await markRunSinceInjury('2026-09-21');
    await resolveInjury('2026-09-30');
    expect(await loadInjuryStatus()).toBeNull();
    const reopened = await reopenLastInjury();
    expect(reopened.startDate).toBe('2026-09-05');
    expect(reopened.firstRunBackDate).toBe('2026-09-21'); // not handed back week 1
    expect(reopened.resolvedDate).toBeUndefined();
  });
});

describe('getActiveReturnToRun', () => {
  it('returns null when nothing is active, so everything downstream trains normally', async () => {
    expect(await getActiveReturnToRun('2026-09-18')).toBeNull();
  });

  it('while still resting, prescribes no running and keeps counting the days itself', async () => {
    await openOrUpdateInjury({bodyPart:'right quad', severity:'pain', startDate:'2026-09-10'});
    const rtr = await getActiveReturnToRun('2026-09-18');
    expect(rtr.phase).toBe('resting');
    expect(rtr.daysOut).toBe(8);
    expect(rtr.caps.weeklyKm).toBeNull();
    expect(rtr.caps.qualityAllowed).toBe(false);
  });

  // The runner does not have to come back and re-report a worsening situation for the plan to
  // take it more seriously - silence is itself information here.
  it('escalates the protocol on its own as a layoff drags on', async () => {
    await openOrUpdateInjury({severity:'pain', startDate:'2026-09-10'});
    const early = await getActiveReturnToRun('2026-09-18');
    const later = await getActiveReturnToRun('2026-10-20');
    expect(later.protocol.rampWeeks).toBeGreaterThan(early.protocol.rampWeeks);
  });

  it('once running resumes, caps volume and the long run against the pre-injury snapshot', async () => {
    await openOrUpdateInjury({bodyPart:'right quad', severity:'pain', startDate:'2026-09-10'});
    await markRunSinceInjury('2026-09-21');
    const rtr = await getActiveReturnToRun('2026-09-22');
    expect(rtr.phase).toBe('ramping');
    expect(rtr.rampWeek).toBe(1);
    // 11 days out -> 'short' tier: 55% of 39km, 50% of the 14km long run.
    expect(rtr.caps.weeklyKm).toBeCloseTo(21.45, 2);
    expect(rtr.caps.longRunKm).toBeCloseTo(7, 2);
    expect(rtr.caps.qualityAllowed).toBe(false);
  });

  it('climbs the ceiling week by week from the pre-injury baseline, never from last week\'s reduced number', async () => {
    await openOrUpdateInjury({severity:'pain', startDate:'2026-09-10'});
    await markRunSinceInjury('2026-09-21');
    const w1 = await getActiveReturnToRun('2026-09-22');
    const w2 = await getActiveReturnToRun('2026-09-29');
    expect(w2.caps.volumePct).toBe(w1.caps.volumePct + 20);
    expect(w2.caps.weeklyKm).toBeGreaterThan(w1.caps.weeklyKm);
  });

  // Uses a 3-week layoff ('moderate' tier: 3 ramp weeks, 2 of them quality-free) so the hold
  // genuinely ends while the volume ramp is still running - the shorter tiers are easy-only
  // throughout, which would make this test pass for the wrong reason.
  it('clears the quality hold while the volume ramp is still running, from the moderate tier up', async () => {
    await openOrUpdateInjury({severity:'pain', startDate:'2026-09-01'});
    await markRunSinceInjury('2026-09-21');
    expect((await getActiveReturnToRun('2026-09-29')).caps.qualityAllowed).toBe(false); // ramp week 2
    const w3 = await getActiveReturnToRun('2026-10-06');
    expect(w3.phase).toBe('ramping');
    expect(w3.caps.qualityAllowed).toBe(true);  // ramp week 3, hold served
  });

  it('restarts the ramp when real pain is reported again after running resumed', async () => {
    mockStorage({'injury-history': JSON.stringify([{date:'2026-09-30', severity:'pain', bodyPart:'right quad'}])});
    await openOrUpdateInjury({severity:'pain', startDate:'2026-09-01'});
    await markRunSinceInjury('2026-09-21');
    const rtr = await getActiveReturnToRun('2026-10-06');
    expect(rtr.setback).not.toBeNull();
    expect(rtr.rampWeek).toBe(1);
    expect(rtr.caps.qualityAllowed).toBe(false);
  });

  it('an ache logged mid-return is expected and does not restart the ramp', async () => {
    mockStorage({'injury-history': JSON.stringify([{date:'2026-09-30', severity:'ache', bodyPart:'right quad'}])});
    await openOrUpdateInjury({severity:'pain', startDate:'2026-09-01'});
    await markRunSinceInjury('2026-09-21');
    const rtr = await getActiveReturnToRun('2026-10-06');
    expect(rtr.setback).toBeNull();
    expect(rtr.rampWeek).toBe(3); // not reset to 1
  });

  it('reports the ramp as complete rather than silently vanishing', async () => {
    await openOrUpdateInjury({severity:'pain', startDate:'2026-09-10'});
    await markRunSinceInjury('2026-09-21');
    const rtr = await getActiveReturnToRun('2026-10-20');
    expect(rtr.phase).toBe('complete');
    expect(rtr.caps).toBeNull();
    expect(rtr.ltPacePenaltyPct).toBe(0);
  });

  it('a race or taper week is not used as the pre-injury baseline', async () => {
    state.WEEKS = [
      planWeek(6, 'Sep 7-13', {mon:'Sep 7', wed:'Sep 9', thu:'Sep 10', sat:'Sep 12'}),
      Object.assign(planWeek(7, 'Sep 14-20', {mon:'Sep 14', wed:'Sep 16', thu:'Sep 17', sat:'Sep 19'}), {cutback:true}),
    ];
    const inj = await openOrUpdateInjury({severity:'pain', startDate:'2026-09-16'});
    expect(inj.baselineFromWeekN).toBe(6);
  });
});

describe('getEffectivePaceRestriction', () => {
  it('takes the stronger of an injury return and a plain layoff rather than whichever ran last', async () => {
    mockStorage({
      'last-activity-date': JSON.stringify({date:'2026-08-20'}), // long enough for a real layoff
    });
    await openOrUpdateInjury({bodyPart:'right quad', severity:'pain', startDate:'2026-09-10'});
    await markRunSinceInjury('2026-09-21');
    const r = await getEffectivePaceRestriction();
    expect(r).not.toBeNull();
    expect(['injury','layoff']).toContain(r.kind);
    expect(r.ltPacePenaltyPct).toBeGreaterThan(0);
  });

  it('is null when neither applies, leaving prescribed paces untouched', async () => {
    expect(await getEffectivePaceRestriction()).toBeNull();
  });
});

describe('the INJURY STATUS block', () => {
  it('parses an opened injury out of a normal coach reply', () => {
    const reply = 'That quad has been grumbling for a while now.\n\nFOLLOW UPS: ["right quad"]\n\nINJURY STATUS: {"active":true,"bodyPart":"right quad","severity":"pain","startDate":"2026-09-05","expectedReturnDate":null,"note":"sore since Drammen"}';
    expect(parseInjuryStatusBlock(reply)).toMatchObject({active:true, bodyPart:'right quad', severity:'pain', startDate:'2026-09-05'});
  });

  it('parses a resolution', () => {
    expect(parseInjuryStatusBlock('Good news.\nINJURY STATUS: {"active":false}')).toEqual({active:false});
  });

  it('never reaches the chat bubble', () => {
    const reply = 'Take it easy this week.\nINJURY STATUS: {"active":true,"severity":"pain"}';
    expect(stripInjuryStatusBlock(reply)).toBe('Take it easy this week.');
    expect(stripInjuryStatusBlock('no block here')).toBe('no block here');
  });

  it('ignores an object that states neither active nor resolved rather than guessing', () => {
    expect(parseInjuryStatusBlock('INJURY STATUS: {"bodyPart":"quad"}')).toBeNull();
  });

  it('rejects a malformed date instead of storing it and mis-sizing the whole ramp', () => {
    const p = parseInjuryStatusBlock('INJURY STATUS: {"active":true,"severity":"pain","startDate":"last tuesday"}');
    expect(p.startDate).toBeNull();
  });

  it('survives unparseable JSON without costing the runner the coach\'s actual reply', () => {
    expect(parseInjuryStatusBlock('INJURY STATUS: {not json at all')).toBeNull();
  });

  it('writes real state, which is the whole point - a reported injury stops being just prose', async () => {
    const res = await applyInjuryStatusBlock('INJURY STATUS: {"active":true,"bodyPart":"right quad","severity":"pain","startDate":"2026-09-05"}');
    expect(res.action).toBe('opened');
    const stored = await loadInjuryStatus();
    expect(stored).toMatchObject({bodyPart:'right quad', severity:'pain', startDate:'2026-09-05', source:'chat'});
  });

  it('clears state when the coach reports it resolved', async () => {
    await openOrUpdateInjury({bodyPart:'right quad', severity:'pain', startDate:'2026-09-05'});
    const res = await applyInjuryStatusBlock('INJURY STATUS: {"active":false}');
    expect(res.action).toBe('resolved');
    expect(await loadInjuryStatus()).toBeNull();
  });
});

describe('detectPossibleInjury', () => {
  const painEvents = [{date:'2026-09-10', severity:'pain', bodyPart:'right quad'}];

  it('asks only when sessions are actually going unperformed AND something recently hurt', () => {
    expect(detectPossibleInjury({missedRecent:3, painEvents, todayStr:'2026-09-18'})).toMatchObject({bodyPart:'right quad'});
    expect(detectPossibleInjury({missedRecent:1, painEvents, todayStr:'2026-09-18'})).toBeNull();
    expect(detectPossibleInjury({missedRecent:3, painEvents:[], todayStr:'2026-09-18'})).toBeNull();
  });

  it('ignores an ache - a twinge noted and moved past is not a training restriction', () => {
    expect(detectPossibleInjury({missedRecent:3, painEvents:[{date:'2026-09-10', severity:'ache'}], todayStr:'2026-09-18'})).toBeNull();
  });

  it('ignores pain old enough to be unrelated to why this week is going missing', () => {
    expect(detectPossibleInjury({missedRecent:3, painEvents, todayStr:'2026-11-01'})).toBeNull();
  });
});

describe('free-text body part', () => {
  // Real logged data has a whole sentence in this field ("Right quad still painful.") - it
  // gets inlined into banner headings and coach prompts, where it read as broken grammar.
  it('is normalized once at write time rather than patched at each display site', async () => {
    const inj = await openOrUpdateInjury({bodyPart:'Right quad still painful. ', severity:'pain', startDate:'2026-09-16'});
    expect(inj.bodyPart).toBe('Right quad still painful');
  });

  it('truncates something long enough to be a note, not a location', async () => {
    const long = 'right quad and also the hip flexor on that same side has been complaining';
    const inj = await openOrUpdateInjury({bodyPart:long, severity:'pain', startDate:'2026-09-16'});
    expect(inj.bodyPart.length).toBeLessThanOrEqual(43);
    expect(inj.bodyPart.endsWith('...')).toBe(true);
  });
});

describe('detecting an injury with nothing written down anywhere', () => {
  // The app must not depend on the runner having typed anything - not in the pain field, not
  // in a Strava description, not to the coach. People stop logging when they are hurt.
  it('asks on silence alone: sessions missed and nothing logged for a stretch', () => {
    const p = detectPossibleInjury({missedRecent:5, painEvents:[], daysSinceActivity:12, lastActivityDate:'2026-09-06', todayStr:'2026-09-18'});
    expect(p.basis).toBe('silence');
    expect(p.daysSinceActivity).toBe(12);
  });

  it('holds a higher bar for silence than for a reported pain, because it is a weaker signal', () => {
    // Two missed sessions plus reported pain fires; two missed sessions in silence does not.
    expect(detectPossibleInjury({missedRecent:2, painEvents:[{date:'2026-09-10', severity:'pain'}], daysSinceActivity:12, todayStr:'2026-09-18'})).not.toBeNull();
    expect(detectPossibleInjury({missedRecent:2, painEvents:[], daysSinceActivity:12, todayStr:'2026-09-18'})).toBeNull();
  });

  it('does not fire on missed sessions alone while training is clearly still happening', () => {
    expect(detectPossibleInjury({missedRecent:6, painEvents:[], daysSinceActivity:2, todayStr:'2026-09-18'})).toBeNull();
  });

  it('does not fire on a quiet stretch where nothing was actually scheduled', () => {
    expect(detectPossibleInjury({missedRecent:0, painEvents:[], daysSinceActivity:30, todayStr:'2026-09-18'})).toBeNull();
  });

  // Getting this wrong would hand back a ramp far shorter than the gap deserves.
  it('dates a silent injury from the last logged activity, not from today', () => {
    const p = detectPossibleInjury({missedRecent:5, painEvents:[], daysSinceActivity:12, lastActivityDate:'2026-09-06', todayStr:'2026-09-18'});
    expect(p.startDate).toBe('2026-09-06');
  });

  it('invents no body part or severity when nothing was reported', () => {
    const p = detectPossibleInjury({missedRecent:5, painEvents:[], daysSinceActivity:12, lastActivityDate:'2026-09-06'});
    expect(p.bodyPart).toBe('');
    expect(p.severity).toBeNull();
  });

  it('prefers the pain-backed read when both routes would fire', () => {
    const p = detectPossibleInjury({missedRecent:5, painEvents:[{date:'2026-09-10', severity:'pain', bodyPart:'right quad'}], daysSinceActivity:12, todayStr:'2026-09-18'});
    expect(p.basis).toBe('pain-reported');
    expect(p.bodyPart).toBe('right quad');
  });
});

describe('dismissing the prompt', () => {
  it('a silence dismissal lifts once the runner has actually run again', async () => {
    const prompt = {basis:'silence', lastActivityDate:'2026-09-06', missedRecent:5, painEvent:null, bodyPart:''};
    await dismissInjuryPromptFor(prompt);
    expect(await isInjuryPromptDismissed(prompt)).toBe(true);
    // A new gap, opened after a run that happened since - a different question.
    const later = {basis:'silence', lastActivityDate:'2026-10-20', missedRecent:5, painEvent:null, bodyPart:''};
    expect(await isInjuryPromptDismissed(later)).toBe(false);
  });

  it('a silence dismissal does not silence a later pain-backed prompt', async () => {
    await dismissInjuryPromptFor({basis:'silence', lastActivityDate:'2026-09-06', painEvent:null, bodyPart:''});
    const painPrompt = {basis:'pain-reported', painEvent:{date:'2026-10-01'}, bodyPart:'right quad'};
    expect(await isInjuryPromptDismissed(painPrompt)).toBe(false);
  });

  it('a pain dismissal still only covers that specific reported event', async () => {
    const p1 = {basis:'pain-reported', painEvent:{date:'2026-09-10'}, bodyPart:'right quad'};
    await dismissInjuryPromptFor(p1);
    expect(await isInjuryPromptDismissed(p1)).toBe(true);
    expect(await isInjuryPromptDismissed({basis:'pain-reported', painEvent:{date:'2026-10-02'}, bodyPart:'right quad'})).toBe(false);
  });
});

describe('the silent threshold is the one the app already uses for a real gap', () => {
  it('matches estimateLayoffImpact\'s own 7-day line rather than inventing a second one', async () => {
    const { estimateLayoffImpact } = await import('./tier-estimates.js');
    expect(estimateLayoffImpact(INJURY_PROMPT_SILENT_QUIET_DAYS)).not.toBeNull();
    expect(estimateLayoffImpact(INJURY_PROMPT_SILENT_QUIET_DAYS - 1)).toBeNull();
  });

  it('fires on the real shape of this runner\'s own gap: 6 sessions missed, 9 days quiet', () => {
    const p = detectPossibleInjury({missedRecent:6, painEvents:[], daysSinceActivity:9, lastActivityDate:'2026-09-10', todayStr:'2026-09-19'});
    expect(p).not.toBeNull();
    expect(p.basis).toBe('silence');
  });
});
