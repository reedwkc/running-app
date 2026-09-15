// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { auditBlock, longestFlatRun, qualityMin, summarizeWeeks } from './plan-audit.js';

// A minimal sound block: build weeks with a threshold session and a growing long run, a
// cutback every fourth week, then a tapered race week.
// Shaped like a real materialized threshold day: the recipe carries the rep count, the
// materialized data carries how long a rep actually takes at current zones - qualityMin needs
// both, which is exactly the pairing a fixture built from imagination gets wrong.
const thresholdDay = (tag, reps) => ({tag, type:'threshold', name:'Threshold', zone:'S4', data:{totalKm:10, main:{repTimeSec:260}}, recipe:{fn:'threshold', args:{reps, repM:1000, recoverySec:60, wuKm:2, cdKm:1.6}}});
const longDay = (tag, km, fastKm) => ({
  tag, type:'long', name:'Long run', zone:'S2',
  data:{totalKm:String(km)},
  recipe:{fn:'longRun', args:{segments: fastKm ? [{km:km-fastKm, zone:'S2'},{km:fastKm, zone:'GOAL'}] : [{km, zone:'S2'}]}},
});
const easyDay = (tag, km) => ({tag, type:'easy', name:'Easy run', zone:'S2', data:{km}});

function soundBlock(){
  const weeks = [];
  for(let i = 0; i < 8; i++){
    const n = 7 + i;
    const cutback = (i + 1) % 4 === 0;
    const longKm = cutback ? 12 : 14 + i;      // grows; cutbacks repeat, which is allowed
    weeks.push({
      n, dates:'wk'+n, phase:'base', cutback,
      days:[
        easyDay('Mon - x', cutback ? 6 : 12),
        thresholdDay('Wed - x', cutback ? 4 : 4 + i),
        easyDay('Fri - x', cutback ? 5 : 12),
        longDay('Sun - x', longKm, i >= 4 ? i - 3 : 0),
      ],
    });
  }
  // Race week: clearly tapered, with the race itself.
  weeks.push({n:15, dates:'wk15', phase:'taper', cutback:true, days:[
    easyDay('Mon - x', 5),
    {tag:'Sat - x', type:'race', name:'Race', data:{km:21.1}},
  ]});
  return weeks;
}

describe('summarizeWeeks', () => {
  it('rolls each week up to the numbers a whole-block view needs', () => {
    const rows = summarizeWeeks(soundBlock());
    expect(rows[0].n).toBe(7);
    expect(rows[0].km).toBeGreaterThan(0);
    expect(rows[0].quality).toBe(1);
    expect(rows[0].qMin).toBeGreaterThan(0);
    expect(rows[rows.length-1].race).toBe(true);
  });

  it('ignores weeks before the block start', () => {
    const rows = summarizeWeeks(soundBlock(), 10);
    expect(rows.every(r => r.n >= 10)).toBe(true);
  });

  it('reads the long run\'s fast portion from either the recipe or the materialized data', () => {
    const fromRecipe = summarizeWeeks([{n:1, days:[longDay('Sun - x', 20, 5)]}])[0];
    expect(fromRecipe.longFastKm).toBe(5);
    expect(fromRecipe.goalKm).toBe(5);
    const fromData = summarizeWeeks([{n:1, days:[{tag:'Sun - x', type:'long', data:{totalKm:'20', segments:[{km:15, zone:'S2'},{km:5, zone:'GOAL'}]}}]}])[0];
    expect(fromData.longFastKm).toBe(5);
  });
});

describe('qualityMin', () => {
  it('counts rep work from the recipe', () => {
    expect(qualityMin({type:'threshold', recipe:{args:{reps:4, workSec:180}}, data:{}})).toBe(12);
    expect(qualityMin({type:'vo2max', recipe:{args:{reps:5, repMin:3}}, data:{}})).toBe(15);
  });
  it('counts only the fast part of a long run, and nothing for an easy day', () => {
    expect(qualityMin({type:'long', recipe:{args:{segments:[{km:16, zone:'S2'},{km:4, zone:'GOAL'}]}}, data:{}})).toBe(20);
    expect(qualityMin({type:'easy', data:{km:10}})).toBe(0);
  });
});

describe('longestFlatRun', () => {
  it('finds the longest identical stretch, skipping cutback weeks', () => {
    const rows = [{n:1, v:5},{n:2, v:5},{n:3, cutback:true, v:1},{n:4, v:5},{n:5, v:9}];
    expect(longestFlatRun(rows, r => r.v)).toEqual({len:3, endsAt:4});
  });
});

describe('auditBlock', () => {
  it('passes a sound block outright', () => {
    const res = auditBlock(soundBlock());
    expect(res.failures).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.passes.length).toBeGreaterThan(5);
  });

  it('fails a week with no quality work at all - the 17-week flat stretch this was written for', () => {
    const weeks = soundBlock();
    weeks[1].days = [easyDay('Mon - x', 8), easyDay('Wed - x', 8), longDay('Sun - x', 15, 0)];
    const res = auditBlock(weeks);
    expect(res.failures.map(f => f.id)).toContain('quality-every-week');
    expect(res.failures[0].message).toContain('w8');
  });

  it('fails hard days landing back to back', () => {
    const weeks = soundBlock();
    weeks[0].days = [thresholdDay('Wed - x', 4), longDay('Thu - x', 14, 0)];
    const res = auditBlock(weeks);
    expect(res.failures.map(f => f.id)).toContain('hard-day-spacing');
    expect(res.failures.find(f => f.id==='hard-day-spacing').message).toContain('Wed+Thu');
  });

  it('fails a race week that was never tapered', () => {
    const weeks = soundBlock();
    weeks[weeks.length-1].days = [easyDay('Mon - x', 40), {tag:'Sat - x', type:'race', name:'Race', data:{km:21.1}}];
    const res = auditBlock(weeks);
    expect(res.failures.map(f => f.id)).toContain('taper');
  });

  it('warns on a volume spike over 10%', () => {
    const weeks = soundBlock();
    weeks[2].days.push(easyDay('Tue - x', 25));
    const res = auditBlock(weeks);
    expect(res.warnings.map(w => w.id)).toContain('volume-ramp');
  });

  it('warns when build weeks run on without a cutback', () => {
    const weeks = soundBlock().map(w => Object.assign({}, w, {cutback:false}));
    const res = auditBlock(weeks);
    expect(res.warnings.map(w => w.id)).toContain('cutback-cadence');
  });

  it('warns on a long run that stops progressing on both axes', () => {
    const weeks = soundBlock().map(w => Object.assign({}, w, {cutback:false, days: w.days.map(d => d.type==='long' ? longDay(d.tag, 14, 0) : d)}));
    const res = auditBlock(weeks);
    expect(res.warnings.map(w => w.id)).toContain('long-run-progression');
  });

  it('says so plainly when there is nothing to audit yet', () => {
    const res = auditBlock([]);
    expect(res.failures).toEqual([]);
    expect(res.checks[0].id).toBe('empty');
  });

  it('survives junk days without throwing', () => {
    expect(() => auditBlock([{n:1, days:[{}, {tag:null, type:'threshold'}, null].filter(Boolean)}])).not.toThrow();
  });
});
