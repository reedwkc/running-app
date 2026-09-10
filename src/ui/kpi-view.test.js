// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { singleSeriesTrendHTML, tierTrendChartHTML } from './kpi-view.js';
import { raceCorrectionNoteHTML } from './kpi-view.js';

describe('singleSeriesTrendHTML', () => {
  it('renders a valid SVG chart for a multi-point single series, matching tierTrendChartHTML directly', () => {
    const points = [
      {date:'2026-08-01', v:10},
      {date:'2026-08-05', v:12},
      {date:'2026-08-09', v:11},
    ];
    const direct = tierTrendChartHTML('Test', [{label:'Test', color:'#5FA85F', points}], v=>v+'x');
    const wrapped = singleSeriesTrendHTML('Test', points, '#5FA85F', v=>v+'x');
    expect(wrapped).toBe(direct);
    expect(wrapped).toContain('<svg');
    expect(wrapped).toContain('polyline');
    expect(wrapped).toContain('11x'); // last point's legend value, formatted
  });

  it('falls back to the "not enough history" message with zero points', () => {
    const html = singleSeriesTrendHTML('Test', [], '#5FA85F', v=>v);
    expect(html).toContain('Not enough history yet.');
  });

  it('draws a single dot (no polyline) for exactly one point', () => {
    const html = singleSeriesTrendHTML('Test', [{date:'2026-08-01', v:5}], '#5FA85F', v=>v);
    expect(html).toContain('<circle');
    expect(html).not.toContain('polyline');
  });
});

describe('raceCorrectionNoteHTML - a race corrects earlier estimates, it does not average with them', () => {
  const est = (date, ltPaceSec) => ({date, ltPaceSec});
  const race = (date, ltPaceSec) => ({date, ltPaceSec, raceVerified:true});

  it('explains the step when a race lands well off the estimates before it', () => {
    // The real shape: Tier 2 estimated 4:20-4:22/km all August from sessions misread by
    // since-fixed bugs, then a half marathon measured 4:38/km.
    const h = [est('2026-08-12',260), est('2026-08-17',262), est('2026-09-02',262), race('2026-09-05T15:00:00Z',278)];
    const out = raceCorrectionNoteHTML(h, []);
    expect(out).toContain('measurement correction, not a change in fitness');
    expect(out).toContain('16 sec/km');
    expect(out).toContain('slower');
  });

  it('says nothing when there is no race-verified point at all', () => {
    expect(raceCorrectionNoteHTML([est('2026-08-12',260), est('2026-08-17',262)], [])).toBe('');
  });

  it('says nothing when the race is the very first reading - there is nothing before it to correct', () => {
    expect(raceCorrectionNoteHTML([race('2026-09-05',278)], [])).toBe('');
  });

  it('says nothing when the race broadly agrees with the estimate before it', () => {
    const h = [est('2026-08-12',276), race('2026-09-05',278)];
    expect(raceCorrectionNoteHTML(h, [])).toBe('');
  });

  it('reads the other way round when the race comes out faster than the estimates', () => {
    const h = [est('2026-08-12',290), race('2026-09-05',272)];
    const out = raceCorrectionNoteHTML(h, []);
    expect(out).toContain('18 sec/km');
    expect(out).toContain('faster');
  });

  it('uses the most recent race when several exist, and merges Tier 2 and Tier 3 by date', () => {
    const h2 = [est('2026-05-01',300), race('2026-06-01',292), est('2026-08-12',260), race('2026-09-05',278)];
    const h3 = [est('2026-07-01',270)];
    const out = raceCorrectionNoteHTML(h2, h3);
    expect(out).toContain('18 sec/km'); // 278 vs the Aug 12 estimate of 260, not the June race
    expect(out).toContain('Sep 5');
  });
});
