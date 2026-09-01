// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyReducedWeek, computeWeekPlannedKm, computeZones, applyPlanOverrides, vo2maxReps, continuousTempo, hillRepeats, hillSprints, flatAlternativeToHill, fartlek, ladderReps, alternatingSurges, bikeEquivalent } from './plan.js';
import { defaultGoalConfig } from './goal-config.js';
import { state } from '../state.js';

describe('computeWeekPlannedKm', () => {
  it('sums km across easy/threshold/vo2max/long/race day types, ignoring open days', () => {
    const week = {
      days: [
        {type:'easy', data:{km:8}},
        {type:'threshold', data:{totalKm:'10.5'}},
        {type:'vo2max', data:{totalKm:'9.0'}},
        {type:'long', data:{totalKm:'19.0'}},
        {type:'open', data:{}},
      ],
    };
    expect(computeWeekPlannedKm(week)).toBe(46.5);
  });

  it('uses race day km directly', () => {
    const week = {days:[{type:'race', data:{km:21.1}}]};
    expect(computeWeekPlannedKm(week)).toBe(21.1);
  });

  it('returns 0 for a week with no days or only open days', () => {
    expect(computeWeekPlannedKm({days:[]})).toBe(0);
    expect(computeWeekPlannedKm({days:[{type:'open', data:{}}]})).toBe(0);
  });

  it('does not throw on a missing days array', () => {
    expect(computeWeekPlannedKm({})).toBe(0);
  });
});

describe('vo2maxReps (meters-based short/fast intervals, e.g. "5x200m")', () => {
  beforeEach(() => {
    state.Z = {S1:{pace:390}, S5:{pace:210}};
  });

  it('computes reps by DISTANCE (not time) at S5 pace, matching threshold()\'s meters-based shape', () => {
    const d = vo2maxReps(5, 200, 90, 'jog', 1.5, 1);
    expect(d.kind).toBe('vo2max');
    expect(d.main.reps).toBe(5);
    expect(d.main.label).toBe('5 x 200m');
    expect(d.main.paceSpk).toBe(210);
    expect(d.main.recoverySec).toBe(90);
    expect(d.main.recoveryLabel).toBe('jog');
    // 200m at 210s/km = 42s/rep
    expect(d.main.repTimeSec).toBeCloseTo(42, 5);
  });

  it('totalKm and totalSec include warm-up, all reps, recoveries between them, and cool-down', () => {
    const d = vo2maxReps(5, 200, 90, 'jog', 1.5, 1);
    // wu 1.5km + 5*0.2km reps + cd 1km = 3.5km
    expect(d.totalKm).toBe('3.5');
    const wuTime = 1.5*390, mainTime = 5*42 + 4*90, cdTime = 1*390;
    expect(d.totalSec).toBeCloseTo(wuTime+mainTime+cdTime, 5);
  });

  it('bikeEquivalent-style consumers can still parse the label/repTime (leading rep count, m:ss repTime)', () => {
    const d = vo2maxReps(5, 200, 90, 'jog', 1.5, 1);
    expect(d.main.label).toMatch(/^\d+/);
    expect(d.main.repTime).toMatch(/^\d+:\d{2}$/);
  });
});

describe('continuousTempo (single sustained effort, no reps/recovery)', () => {
  beforeEach(() => {
    state.Z = {S1:{pace:390}, S4:{pace:260}};
  });

  it('is one continuous rep at S4/threshold pace, not broken into intervals', () => {
    const d = continuousTempo(20, 1.5, 1);
    expect(d.kind).toBe('threshold');
    expect(d.main.reps).toBe(1);
    expect(d.main.paceSpk).toBe(260);
    expect(d.main.recoverySec).toBe(0);
    expect(d.main.repTimeSec).toBe(1200);
  });

  // The exact bug caught while building this: a label starting with the raw minute count
  // (e.g. "20 min continuous") gets misread by bikeEquivalent()'s regex as 20 reps instead
  // of one continuous 20-minute effort, wildly inflating the bike-mode total duration.
  it('does not regress into a mis-parsed multi-rep bike equivalent', () => {
    const day = {type:'threshold', zone:'S4', data:continuousTempo(20, 1.5, 1)};
    const eq = bikeEquivalent(day);
    expect(eq.reps).toBe(1);
    expect(eq.totalSec).toBeCloseTo(day.data.totalSec, 5);
  });
});

describe('hillRepeats (time-based, no fixed pace)', () => {
  beforeEach(() => {
    state.Z = {S1:{pace:390}, S5:{pace:210}};
  });

  it('has no pace target - paceSpk/pace stay null, reps are real (not folded to 1)', () => {
    const d = hillRepeats(8, 45, 'jog/walk down', 1.5, 1);
    expect(d.main.paceSpk).toBeNull();
    expect(d.main.pace).toBeNull();
    expect(d.main.reps).toBe(8);
    expect(d.main.label).toBe('8 x 0:45');
    expect(d.main.recoveryLabel).toBe('jog/walk down');
  });

  it('bikeEquivalent still recovers the real 8x45s structure from the label/repTime', () => {
    const day = {type:'vo2max', zone:'S5', data:hillRepeats(8, 45, 'jog/walk down', 1.5, 1)};
    const eq = bikeEquivalent(day);
    expect(eq.reps).toBe(8);
    expect(eq.repSec).toBe(45);
  });
});

describe('flatAlternativeToHill (the real flat "alt" card offered alongside a hill day)', () => {
  beforeEach(() => {
    state.Z = {S1:{pace:390}, S4:{pace:260}, S5:{pace:210}};
  });

  it('matches the hill session\'s rep count and per-rep TIME exactly, run flat instead of uphill', () => {
    const hill = hillRepeats(8, 45, 'jog/walk down', 1.5, 1);
    const flat = flatAlternativeToHill(hill, 'S5');
    expect(flat.main.reps).toBe(8);
    expect(flat.main.repTimeSec).toBe(45); // same TIME, not the same distance - a hill's stimulus is duration/effort
    expect(flat.main.recoverySec).toBe(hill.main.recoverySec);
    expect(flat.main.paceSpk).toBe(210); // real pace target now, unlike the hill's null
  });

  it('preserves warm-up/cool-down and picks the requested pace zone', () => {
    const hill = hillSprints(8, 10, 1.5, 1);
    const flatS4 = flatAlternativeToHill(hill, 'S4');
    expect(flatS4.wu.km).toBe(1.5);
    expect(flatS4.cd.km).toBe(1);
    expect(flatS4.main.paceSpk).toBe(260);
    const flatS5 = flatAlternativeToHill(hill, 'S5');
    expect(flatS5.main.paceSpk).toBe(210);
  });
});

describe('hillSprints (short, maximal, full recovery - distinct from hillRepeats)', () => {
  beforeEach(() => {
    state.Z = {S1:{pace:390}, S5:{pace:210}};
  });

  it('is flagged sprint:true, still no pace target, and recovery is much longer than hillRepeats\' ratio', () => {
    const d = hillSprints(8, 10, 1.5, 1);
    expect(d.style).toBe('hill');
    expect(d.sprint).toBe(true);
    expect(d.main.paceSpk).toBeNull();
    expect(d.main.reps).toBe(8);
    // hillRepeats() uses ~1.8x the rep time for recovery; sprints use a full, much longer recovery (15x here)
    expect(d.main.recoverySec).toBe(150);
    expect(d.main.recoverySec).toBeGreaterThan(hillRepeats(8, 10, 'jog', 1.5, 1).main.recoverySec);
  });
});

describe('alternatingSurges (fixed-duration hard/easy blocks, BOTH with a real pace target)', () => {
  beforeEach(() => {
    state.Z = {S1:{pace:390}, S2:{pace:330}, S4:{pace:260}, S5:{pace:210}};
  });

  it('gives both the surge and the float a real pace target - unlike every jog/rest recovery elsewhere', () => {
    const d = alternatingSurges(6, 180, 120, 'S4', 1.5, 1);
    expect(d.kind).toBe('threshold');
    expect(d.main.paceSpk).toBe(260); // surge pace
    expect(d.main.floatPaceSpk).toBe(330); // float pace - real, not null like hill/fartlek
  });

  it('builds the correct alternating surge/float sequence - float only BETWEEN reps, not after the last', () => {
    const d = alternatingSurges(3, 180, 120, 'S4', 1.5, 1);
    expect(d.main.steps.map(s=>s.kind)).toEqual(['surge','float','surge','float','surge']);
    expect(d.main.reps).toBe(3);
  });

  it('bikeEquivalent recovers the real structure via the generic path (no special-casing needed)', () => {
    const day = {type:'threshold', zone:'S4', data:alternatingSurges(6, 180, 120, 'S4', 1.5, 1)};
    const eq = bikeEquivalent(day);
    expect(eq.reps).toBe(6);
    expect(eq.repSec).toBe(180);
    expect(eq.recoverySec).toBe(120);
    expect(eq.totalSec).toBeCloseTo(day.data.totalSec, 5);
  });

  it('picks S5 for a vo2max-zone surge session, S4 for threshold', () => {
    expect(alternatingSurges(4, 60, 60, 'S5', 1, 1).kind).toBe('vo2max');
    expect(alternatingSurges(4, 60, 60, 'S4', 1, 1).kind).toBe('threshold');
  });
});

describe('fartlek (unstructured surge/float, no fixed pace or rep count)', () => {
  beforeEach(() => {
    state.Z = {S1:{pace:390}, S3:{pace:300}, S5:{pace:210}};
  });

  it('has no pace target and models as one continuous main block', () => {
    const d = fartlek(20, 1.5, 1);
    expect(d.main.paceSpk).toBeNull();
    expect(d.main.pace).toBeNull();
    expect(d.main.reps).toBe(1);
    expect(d.main.repTimeSec).toBe(1200);
  });

  // Same bug class as continuousTempo above: "Fartlek - 20 min" does not start with a raw
  // digit, so it correctly falls through to bikeEquivalent()'s reps=1 default instead of
  // being misread as some other rep count from wherever a number first appears.
  it('does not regress into a mis-parsed multi-rep bike equivalent', () => {
    const day = {type:'vo2max', zone:'S5', data:fartlek(20, 1.5, 1)};
    const eq = bikeEquivalent(day);
    expect(eq.reps).toBe(1);
    expect(eq.totalSec).toBeCloseTo(day.data.totalSec, 5);
  });
});

describe('ladderReps (variable-length rungs, e.g. 400-800-1200-800-400m)', () => {
  beforeEach(() => {
    state.Z = {S1:{pace:390}, S4:{pace:260}, S5:{pace:210}};
  });

  it('computes each rung individually at the selected zone pace, not one uniform repTime', () => {
    const d = ladderReps([400,800,1200,800,400], 90, 'jog', 1.5, 1, 'S4');
    expect(d.kind).toBe('threshold');
    expect(d.main.steps.map(s=>s.distanceM)).toEqual([400,800,1200,800,400]);
    // 400m@260s/km=104s, 800m=208s, 1200m=312s
    expect(d.main.steps[0].timeSec).toBeCloseTo(104, 5);
    expect(d.main.steps[1].timeSec).toBeCloseTo(208, 5);
    expect(d.main.steps[2].timeSec).toBeCloseTo(312, 5);
    expect(d.main.reps).toBe(5);
  });

  it('picks S5 pace for a vo2max-zone ladder, S4 for a threshold-zone one', () => {
    const vo2 = ladderReps([300,600,300], 60, 'jog', 1, 0.5, 'S5');
    expect(vo2.kind).toBe('vo2max');
    expect(vo2.main.paceSpk).toBe(210);
    const thr = ladderReps([300,600,300], 60, 'jog', 1, 0.5, 'S4');
    expect(thr.kind).toBe('threshold');
    expect(thr.main.paceSpk).toBe(260);
  });

  it('totalSec includes every rung, recoveries between them (not after the last), warm-up and cool-down', () => {
    const d = ladderReps([400,800,400], 90, 'jog', 1.5, 1, 'S4');
    const wuSec = 1.5*390, cdSec = 1*390;
    const rungsSec = (400/1000*260) + (800/1000*260) + (400/1000*260);
    const recoverySec = 2*90; // 2 recoveries between 3 rungs, none after the last
    expect(d.totalSec).toBeCloseTo(wuSec+rungsSec+recoverySec+cdSec, 5);
  });

  it('bikeEquivalent mirrors total quality TIME exactly via its dedicated ladder branch, not the uniform reps*repSec formula', () => {
    const day = {type:'threshold', zone:'S4', data:ladderReps([400,800,1200,800,400], 90, 'jog', 1.5, 1, 'S4')};
    const eq = bikeEquivalent(day);
    expect(eq.style).toBe('ladder');
    expect(eq.totalSec).toBe(day.data.totalSec);
  });
});

describe('bikeEquivalent (threshold/vo2max) reads main.reps directly, not label text', () => {
  beforeEach(() => {
    state.Z = {S1:{pace:390}, S4:{pace:260}};
  });

  it('still recovers the correct structure for an ordinary uniform-rep session', () => {
    const day = {type:'threshold', zone:'S4', data:{
      wu:{km:2, time:'13:00'}, cd:{km:1.5, time:'9:45'},
      main:{reps:6, label:'6 x 1000m', repTime:'4:20', recoverySec:90},
    }};
    const eq = bikeEquivalent(day);
    expect(eq.reps).toBe(6);
    expect(eq.repSec).toBe(260);
    expect(eq.recoverySec).toBe(90);
  });
});

describe('classifyReducedWeek (taper vs. recovery)', () => {
  const raceWeek = {n:8, days:[{type:'race', tag:'Sun - Sep 27', name:'RACE - Half Marathon', data:{km:21.1}}]};

  it('classifies a cutback week BEFORE an upcoming race as taper', () => {
    const weeks = [{n:7, cutback:true, days:[{type:'threshold'}]}, raceWeek];
    expect(classifyReducedWeek(weeks, 7)).toMatchObject({kind:'taper', raceWeekN:8});
  });

  it('classifies a cutback week AFTER a just-run race as recovery', () => {
    const weeks = [raceWeek, {n:9, cutback:true, days:[{type:'easy'}]}];
    expect(classifyReducedWeek(weeks, 9)).toMatchObject({kind:'recovery', raceWeekN:8});
  });

  it('classifies the week containing the race itself as race, not taper/recovery', () => {
    const weeks = [raceWeek];
    expect(classifyReducedWeek(weeks, 8)).toMatchObject({kind:'race'});
  });

  it('treats a contiguous run of cutback weeks between this one and the race as still belonging to it', () => {
    const weeks = [{n:6, cutback:true, days:[{type:'threshold'}]}, {n:7, cutback:true, days:[{type:'easy'}]}, raceWeek];
    expect(classifyReducedWeek(weeks, 6)).toMatchObject({kind:'taper', raceWeekN:8});
  });

  it('falls back to generic "cutback" when a normal (non-cutback) week separates this one from the nearest race in either direction', () => {
    const weeks = [raceWeek, {n:9, cutback:false, days:[{type:'threshold'}]}, {n:10, cutback:true, days:[{type:'easy'}]}];
    expect(classifyReducedWeek(weeks, 10)).toMatchObject({kind:'cutback'});
  });

  it('returns null for a week number not present in the list', () => {
    expect(classifyReducedWeek([raceWeek], 99)).toBeNull();
  });
});

describe('computeZones (goalConfig-driven GOAL/RACE10K)', () => {
  const profile = {lthr:171, ltPaceSec:275, maxHR:191, vo2max:53, restHR:40};

  it('reproduces the exact hardcoded GOAL/RACE10K values via the default goal config', () => {
    const z = computeZones(profile, defaultGoalConfig());
    expect(z.GOAL).toEqual({hr:'168-172', pace:269});
    expect(z.RACE10K).toEqual({hr:'175-185', pace:258});
  });

  it('falls back to the default goal config when none is passed (undefined)', () => {
    const z = computeZones(profile, undefined);
    expect(z.GOAL.pace).toBe(269);
    expect(z.RACE10K.pace).toBe(258);
  });

  it('leaves S1-S5 unaffected by goalConfig - purely profile-derived', () => {
    const withGoals = computeZones(profile, defaultGoalConfig());
    const noGoals = computeZones(profile, {version:1, phase:'maintenance', activeGoals:[]});
    expect(withGoals.S4).toEqual(noGoals.S4);
    expect(withGoals.S1).toEqual(noGoals.S1);
  });

  it('produces a synthetic, non-crashing fallback pace for an empty goal slot (maintenance phase)', () => {
    const z = computeZones(profile, {version:1, phase:'maintenance', activeGoals:[]});
    expect(z.GOAL.synthetic).toBe(true);
    expect(z.RACE10K.synthetic).toBe(true);
    expect(typeof z.GOAL.pace).toBe('number');
    expect(typeof z.RACE10K.pace).toBe('number');
  });
});

describe('applyPlanOverrides (whole-week upsert)', () => {
  const baseWeeks = () => [
    {n:1, dates:'Aug 3-9', days:[{tag:'Wed - Aug 5', type:'threshold'}]},
    {n:2, dates:'Aug 10-16', days:[{tag:'Mon - Aug 10', type:'threshold'}]},
  ];

  beforeEach(() => {
    window.storage = {get: vi.fn().mockResolvedValue(null)};
  });

  it('returns weeks unchanged (no-op) when no plan-override key exists', async () => {
    const weeks = baseWeeks();
    const result = await applyPlanOverrides(weeks);
    expect(result).toBe(weeks);
  });

  it('replaces an existing week by n, leaving other weeks byte-identical', async () => {
    const weeks = baseWeeks();
    const newWeek2 = {n:2, dates:'Aug 10-16', days:[{tag:'Mon - Aug 10', type:'threshold'}, {tag:'Wed - Aug 12', type:'vo2max'}]};
    window.storage = {get: vi.fn().mockResolvedValue({value: JSON.stringify({weeksByN:{'2':newWeek2}})})};
    const result = await applyPlanOverrides(weeks);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(weeks[0]);
    expect(result[1]).toEqual(newWeek2);
  });

  it('appends a new week beyond the current max n', async () => {
    const weeks = baseWeeks();
    const week9 = {n:9, dates:'Oct 1-7', days:[{tag:'Mon - Oct 1', type:'easy'}]};
    window.storage = {get: vi.fn().mockResolvedValue({value: JSON.stringify({weeksByN:{'9':week9}})})};
    const result = await applyPlanOverrides(weeks);
    expect(result.map(w=>w.n)).toEqual([1,2,9]);
  });

  it('truncateAfter drops stale weeks beyond the cutoff not present in the override', async () => {
    const weeks = [...baseWeeks(), {n:3, dates:'Aug 17-23', days:[]}, {n:4, dates:'Aug 24-30', days:[]}];
    const week9 = {n:9, dates:'Oct 1-7', days:[]};
    window.storage = {get: vi.fn().mockResolvedValue({value: JSON.stringify({weeksByN:{'9':week9}, truncateAfter:2})})};
    const result = await applyPlanOverrides(weeks);
    expect(result.map(w=>w.n)).toEqual([1,2,9]);
  });

  it('falls back to the unmodified weeks if the stored override JSON is corrupted', async () => {
    const weeks = baseWeeks();
    window.storage = {get: vi.fn().mockResolvedValue({value: 'not json'})};
    const result = await applyPlanOverrides(weeks);
    expect(result).toBe(weeks);
  });
});
