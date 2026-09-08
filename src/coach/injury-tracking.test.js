// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeInjuryPatterns, checkCurrentInjuryRiskPattern, computePreEventSignature, loadInjuryHistory, logInjuryEvent, MIN_EVENTS_FOR_PATTERN } from './injury-tracking.js';

function mockStorage({injuryHistory, trimpHistory} = {}){
  const store = {
    'injury-history': injuryHistory!==undefined ? JSON.stringify(injuryHistory) : undefined,
    'trimp-history': trimpHistory!==undefined ? JSON.stringify(trimpHistory) : undefined,
  };
  window.storage = {
    get: vi.fn(async (key) => store[key]!==undefined ? {value: store[key]} : null),
    set: vi.fn(async (key, value) => { store[key] = value; }),
  };
  return store;
}

// One single continuous daily TRIMP series (no overlapping/conflicting date ranges - real
// trimp-history is one merged timeline, not independently-generated windows per event) from
// startDateStr through endDateStr inclusive. spikeDates marks which dates should read as the
// tail end of an acute load spike (that date and the 6 days before it elevated, everything
// else at a flat baseline) - enough real history either way (computeACWR needs 14+ days).
function buildTrimpSeries(startDateStr, endDateStr, spikeDates){
  const points = [];
  const start = new Date(startDateStr+'T00:00:00');
  const end = new Date(endDateStr+'T00:00:00');
  const spikeSet = new Set(spikeDates||[]);
  for(let d=new Date(start); d<=end; d.setDate(d.getDate()+1)){
    const dateStr = d.toISOString().slice(0,10);
    // Elevated if this date falls within 6 days before (inclusive) any spike date.
    const isElevated = [...spikeSet].some(sd=>{
      const diff = (new Date(sd+'T00:00:00') - d) / 86400000;
      return diff>=0 && diff<7;
    });
    points.push({date: dateStr, value: isElevated ? 80 : 30});
  }
  return points;
}

describe('logInjuryEvent / loadInjuryHistory', () => {
  beforeEach(() => { mockStorage({injuryHistory: []}); });

  it('logs a new event with sane defaults when only a date is given', async () => {
    const entry = await logInjuryEvent({date:'2026-08-01'});
    expect(entry.severity).toBe('ache'); // safe default, not an invented worse severity
    expect(entry.date).toBe('2026-08-01');
    const hist = await loadInjuryHistory();
    expect(hist).toHaveLength(1);
  });

  it('captures severity, bodyPart, and note as given', async () => {
    await logInjuryEvent({date:'2026-08-01', severity:'injury', bodyPart:'right knee', note:'sharp pain going downhill'});
    const hist = await loadInjuryHistory();
    expect(hist[0]).toMatchObject({severity:'injury', bodyPart:'right knee', note:'sharp pain going downhill'});
  });

  it('an unrecognized severity value falls back to "ache" rather than silently accepting garbage', async () => {
    await logInjuryEvent({date:'2026-08-01', severity:'catastrophic'});
    const hist = await loadInjuryHistory();
    expect(hist[0].severity).toBe('ache');
  });

  it('re-saving the same sessionId replaces the existing entry instead of duplicating it', async () => {
    await logInjuryEvent({date:'2026-08-01', severity:'ache', sessionId:'s1'});
    await logInjuryEvent({date:'2026-08-01', severity:'pain', sessionId:'s1', note:'got worse'});
    const hist = await loadInjuryHistory();
    expect(hist).toHaveLength(1);
    expect(hist[0].severity).toBe('pain');
  });

  it('keeps history sorted by date', async () => {
    await logInjuryEvent({date:'2026-08-10'});
    await logInjuryEvent({date:'2026-07-01'});
    const hist = await loadInjuryHistory();
    expect(hist.map(h=>h.date)).toEqual(['2026-07-01','2026-08-10']);
  });
});

describe('computePreEventSignature', () => {
  it('returns a real ACWR read for a date with enough preceding training history', async () => {
    mockStorage({trimpHistory: buildTrimpSeries('2026-07-19', '2026-08-15', ['2026-08-15'])});
    const sig = await computePreEventSignature('2026-08-15');
    expect(sig.acwr).not.toBeNull();
    expect(sig.acwr.status).toBe('High');
  });

  it('returns a null acwr when there is not enough training history yet as of that date', async () => {
    mockStorage({trimpHistory: buildTrimpSeries('2026-08-11', '2026-08-15', ['2026-08-15'])}); // only 5 days - under computeACWR's 14-day minimum
    const sig = await computePreEventSignature('2026-08-15');
    expect(sig.acwr).toBeNull();
  });
});

describe('analyzeInjuryPatterns', () => {
  it('reports insufficient-data with fewer than MIN_EVENTS_FOR_PATTERN logged events', async () => {
    mockStorage({injuryHistory: [{date:'2026-08-01', severity:'ache'}], trimpHistory: []});
    const result = await analyzeInjuryPatterns();
    expect(result.classification).toBe('insufficient-data');
    expect(result.count).toBe(1);
  });

  it('reports insufficient-data when events exist but none have enough training history to compute ACWR', async () => {
    mockStorage({
      injuryHistory: [{date:'2026-08-01', severity:'ache'}, {date:'2026-08-10', severity:'pain'}],
      trimpHistory: [], // no training history at all
    });
    const result = await analyzeInjuryPatterns();
    expect(result.classification).toBe('insufficient-data');
  });

  it('identifies High ACWR as a common precursor when it preceded the majority of logged events', async () => {
    // Widely spaced (not just 14 days apart) so each event's own 7-day acute spike doesn't
    // bleed into and dilute the OTHER event's 28-day chronic window.
    const trimp = buildTrimpSeries('2026-07-13', '2026-09-17', ['2026-08-10', '2026-09-17']);
    mockStorage({
      injuryHistory: [
        {date:'2026-08-10', severity:'ache'},
        {date:'2026-09-17', severity:'pain'},
      ],
      trimpHistory: trimp,
    });
    const result = await analyzeInjuryPatterns();
    expect(result.classification).toBe('pattern-available');
    expect(result.highACWRIsCommonPrecursor).toBe(true);
    expect(result.highACWRCount).toBe(2);
  });

  it('does NOT claim High ACWR as a common precursor when the load was steady/normal before every event', async () => {
    const trimp = buildTrimpSeries('2026-07-13', '2026-08-24', []); // no spikes anywhere - flat load throughout
    mockStorage({
      injuryHistory: [
        {date:'2026-08-10', severity:'ache'},
        {date:'2026-08-24', severity:'pain'},
      ],
      trimpHistory: trimp,
    });
    const result = await analyzeInjuryPatterns();
    expect(result.classification).toBe('pattern-available');
    expect(result.highACWRIsCommonPrecursor).toBe(false);
  });

  it('a single high-ACWR event among several steady-load events does not get called a common precursor (severity-weighted majority, not one outlier)', async () => {
    const trimp = buildTrimpSeries('2026-07-13', '2026-09-07', ['2026-08-10']); // spike only before the first event
    mockStorage({
      injuryHistory: [
        {date:'2026-08-10', severity:'ache'},
        {date:'2026-08-24', severity:'ache'},
        {date:'2026-09-07', severity:'ache'},
      ],
      trimpHistory: trimp,
    });
    const result = await analyzeInjuryPatterns();
    expect(result.highACWRIsCommonPrecursor).toBe(false);
  });
});

describe('checkCurrentInjuryRiskPattern', () => {
  it('returns null when there is no established pattern yet', async () => {
    mockStorage({injuryHistory: [], trimpHistory: []});
    expect(await checkCurrentInjuryRiskPattern()).toBeNull();
  });

  it('returns null when a pattern exists but CURRENT load is not elevated', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-21T12:00:00'));
    try{
      // Spikes only around the two past events - nothing near "today" (Sep 21), so current
      // load reads calm even though the learned pattern says High ACWR is the precursor.
      const trimp = buildTrimpSeries('2026-07-13', '2026-09-21', ['2026-08-10', '2026-08-24']);
      mockStorage({
        injuryHistory: [{date:'2026-08-10', severity:'ache'}, {date:'2026-08-24', severity:'pain'}],
        trimpHistory: trimp,
      });
      expect(await checkCurrentInjuryRiskPattern()).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('flags real current risk when a common precursor pattern exists AND current load matches it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-21T12:00:00'));
    try{
      // Spikes before both past events AND right up to "today" - current load matches the
      // learned precursor pattern.
      const trimp = buildTrimpSeries('2026-07-13', '2026-09-21', ['2026-08-10', '2026-08-24', '2026-09-21']);
      mockStorage({
        injuryHistory: [{date:'2026-08-10', severity:'ache'}, {date:'2026-08-24', severity:'pain'}],
        trimpHistory: trimp,
      });
      const risk = await checkCurrentInjuryRiskPattern();
      expect(risk).not.toBeNull();
      expect(risk.currentACWR.status).toBe('High');
      expect(risk.note).toContain('2 of 2');
    } finally { vi.useRealTimers(); }
  });
});
