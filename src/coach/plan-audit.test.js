// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { auditBlock, auditOutline, dispN, longestFlatRun, outlineRows, qualityMin, summarizeWeeks } from './plan-audit.js';

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

// ---------------------------------------------------------------------------
// Display week numbers, and judging an outline by the same rules
// ---------------------------------------------------------------------------

describe('week numbering in audit messages', () => {
  // Week 1 is always the first week of the current block. w.n is a storage key that keeps
  // climbing across blocks - this runner's block starts at n=7 - and every message here used
  // to quote it, naming a week that appears nowhere on their screen.
  it('numbers weeks from the start of the block, not from the storage key', () => {
    expect(dispN(7, 7)).toBe(1);
    expect(dispN(8, 7)).toBe(2);
    expect(dispN(57, 7)).toBe(51);
  });

  it('falls back to the raw number when no block start is known, rather than inventing one', () => {
    expect(dispN(7, null)).toBe(7);
    expect(dispN(3, 7)).toBe(3); // before the block started
  });

  it('names the display number in a real failure message', () => {
    const weeks = [
      {n:7, dates:'Sep 14-20', days:[
        {tag:'Wed - Sep 16', type:'easy', data:{km:10}},
        {tag:'Thu - Sep 17', type:'long', data:{totalKm:'12'}},
      ]},
    ];
    const audit = auditBlock(weeks, {blockStartN: 7});
    const quality = audit.checks.find(c=>c.id==='quality-every-week');
    expect(quality.level).toBe('fail');
    expect(quality.message).toContain('w1');   // what the runner sees
    expect(quality.message).not.toContain('w7'); // the storage key
  });
});

describe('auditOutline', () => {
  function outlineWeek(n, km, opts){
    const o = opts||{};
    return {
      n, dates:'wk'+n, phase:o.phase||'base', cutback:!!o.cutback, race:!!o.race, targetKm:km,
      days: o.days || [
        {tag:'Mon - Sep 14', type:'easy'},
        {tag:'Wed - Sep 16', type:o.quality===false ? 'easy' : 'threshold'},
        {tag:'Thu - Sep 17', type:'easy'},
        {tag:'Sat - Sep 19', type:'long'},
      ],
    };
  }

  it('passes a sanely shaped outline', () => {
    const weeks = [outlineWeek(7,40), outlineWeek(8,43), outlineWeek(9,46), outlineWeek(10,34,{cutback:true}), outlineWeek(11,47)];
    expect(auditOutline(weeks, {blockStartN:7}).failures).toEqual([]);
  });

  // The whole point of auditing the outline: catching this before paying to expand 50 weeks.
  it('catches a dead week before a single week is written out', () => {
    const weeks = [outlineWeek(7,40), outlineWeek(8,43,{quality:false}), outlineWeek(9,46)];
    const f = auditOutline(weeks, {blockStartN:7}).failures.map(x=>x.id);
    expect(f).toContain('quality-every-week');
  });

  it('catches a hole in the week numbers - a month of training silently missing', () => {
    const weeks = [outlineWeek(7,40), outlineWeek(8,43), outlineWeek(14,46)];
    const f = auditOutline(weeks, {blockStartN:7}).failures.map(x=>x.id);
    expect(f).toContain('outline-contiguous');
  });

  it('catches hard days landing back to back', () => {
    const weeks = [outlineWeek(7,40,{days:[
      {tag:'Wed - Sep 16', type:'threshold'},
      {tag:'Thu - Sep 17', type:'long'},
    ]})];
    const f = auditOutline(weeks, {blockStartN:7}).failures.map(x=>x.id);
    expect(f).toContain('hard-day-spacing');
  });

  it('flags a volume ramp that breaks the 10% rule', () => {
    const weeks = [outlineWeek(7,40), outlineWeek(8,55), outlineWeek(9,58)];
    const ids = auditOutline(weeks, {blockStartN:7}).warnings.map(x=>x.id);
    expect(ids).toContain('volume-ramp');
  });

  it('demands a target volume and days on every outlined week', () => {
    const bare = [{n:7, dates:'wk7'}];
    const f = auditOutline(bare, {blockStartN:7}).failures.map(x=>x.id);
    expect(f).toContain('outline-target-km');
    expect(f).toContain('outline-days');
  });

  it('reports outline problems in display numbers too', () => {
    const weeks = [outlineWeek(7,40), outlineWeek(8,43,{quality:false})];
    const msg = auditOutline(weeks, {blockStartN:7}).failures.map(f=>f.message).join(' ');
    expect(msg).toContain('w2');
    expect(msg).not.toContain('w8');
  });

  it('maps outline entries onto the same row shape the block audit uses', () => {
    const rows = outlineRows([outlineWeek(9,46), outlineWeek(7,40)], 7);
    expect(rows.map(r=>r.n)).toEqual([7,9]); // sorted
    expect(rows[0].km).toBe(40);
    expect(rows[0].quality).toBe(1);
    expect(rows[1].disp).toBe(3);
  });
});

// A generic guard rather than one assertion per message. Two week-number leaks survived a
// first pass of fixing these by hand (the peak week in the taper check, the first goal-pace
// week) precisely because each one had to be spotted individually - this catches any future
// message that quotes the storage key, whichever check adds it.
describe('no audit message ever quotes the internal week number', () => {
  function block(){
    const weeks = [];
    for(let i=0; i<12; i++){
      const n = 7 + i;                      // internal keys 7..18
      const cutback = (i % 4) === 3;
      weeks.push({
        n, dates:'wk'+n, phase: i<6 ? 'base' : 'threshold', days:[
          {tag:'Mon - Sep 14', type:'easy', data:{km: 8}},
          {tag:'Wed - Sep 16', type:'threshold', data:{totalKm: '9'}, recipe:{fn:'threshold', args:{reps:4, repM:1000}}},
          {tag:'Thu - Sep 17', type:'easy', data:{km: 10}},
          {tag:'Sat - Sep 19', type:'long', data:{totalKm: String(cutback ? 10 : 14), segments:[{km:2, zone:'GOAL'}]},
           recipe:{fn:'longRun', args:{segments:[{km:2, zone:'GOAL'}]}}},
        ],
        cutback,
      });
    }
    return weeks;
  }

  it('keeps every w-label inside the display range, in passes and failures alike', () => {
    const weeks = block();
    const audit = auditBlock(weeks, {blockStartN: 7});
    const labels = audit.checks.flatMap(c => (c.message.match(/\bw(\d+)\b/g) || []).map(x => parseInt(x.slice(1), 10)));
    expect(labels.length).toBeGreaterThan(0); // the block really does produce labelled messages
    labels.forEach(l => {
      expect(l).toBeGreaterThanOrEqual(1);
      expect(l).toBeLessThanOrEqual(weeks.length); // 12 display weeks; internal keys run to 18
    });
  });

  it('does the same for an outline', () => {
    const outline = block().map(w => ({n:w.n, dates:w.dates, phase:w.phase, cutback:w.cutback, targetKm:40, days:w.days.map(d=>({tag:d.tag, type:d.type}))}));
    const audit = auditOutline(outline, {blockStartN: 7});
    const labels = audit.checks.flatMap(c => (c.message.match(/\bw(\d+)\b/g) || []).map(x => parseInt(x.slice(1), 10)));
    labels.forEach(l => expect(l).toBeLessThanOrEqual(outline.length));
  });
});
