// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { feedSessionTrends } from './session-trends.js';

const PROFILE = {restHR:40, maxHR:191, lthr:174};

function storageSpy(){
  const setCalls = [];
  window.storage = {
    get: vi.fn(async ()=>null), // every trend history starts empty
    set: vi.fn(async (key, value)=>{ setCalls.push({key, value}); }),
  };
  return setCalls;
}

describe('feedSessionTrends - trail runs are excluded from pace-derived trends', () => {
  it('does NOT feed the easy-run efficiency trend for a trail-flagged run, even with real Strava work-lap pace/HR data', async () => {
    const setCalls = storageSpy();
    const obj = {
      trailRun: true, avgHR:150, actualDur:40,
      stravaImport: {laps:[{role:'work', avgPaceLabel:'5:30/km', avgPaceSec:330, avgHR:150, paceSource:'gps'}]},
    };
    await feedSessionTrends({effectiveType:'easy', obj, completedDateStr:'2026-09-01', sessionId:'s1', profile:PROFILE});
    expect(setCalls.some(c=>c.key==='efficiency-history')).toBe(false);
  });

  it('DOES feed the easy-run efficiency trend for the same data when NOT flagged as a trail run', async () => {
    const setCalls = storageSpy();
    const obj = {
      trailRun: false, avgHR:150, actualDur:40,
      stravaImport: {laps:[{role:'work', avgPaceLabel:'5:30/km', avgPaceSec:330, avgHR:150, paceSource:'gps'}]},
    };
    await feedSessionTrends({effectiveType:'easy', obj, completedDateStr:'2026-09-01', sessionId:'s1', profile:PROFILE});
    expect(setCalls.some(c=>c.key==='efficiency-history')).toBe(true);
  });

  it('does NOT feed the long-run decoupling trend for a trail-flagged long run', async () => {
    const setCalls = storageSpy();
    const obj = {trailRun: true, avgHR:150, actualDur:90, stravaImport:{decoupling:{decouplingPct:6.2}}};
    await feedSessionTrends({effectiveType:'long', obj, completedDateStr:'2026-09-01', sessionId:'s2', profile:PROFILE});
    expect(setCalls.some(c=>c.key==='decoupling-history')).toBe(false);
  });

  it('DOES feed the long-run decoupling trend when NOT flagged as trail', async () => {
    const setCalls = storageSpy();
    const obj = {trailRun: false, avgHR:150, actualDur:90, stravaImport:{decoupling:{decouplingPct:6.2}}};
    await feedSessionTrends({effectiveType:'long', obj, completedDateStr:'2026-09-01', sessionId:'s2', profile:PROFILE});
    expect(setCalls.some(c=>c.key==='decoupling-history')).toBe(true);
  });

  it('still feeds cadence-fade (not pace-based) on a trail-flagged long run', async () => {
    const setCalls = storageSpy();
    const obj = {trailRun: true, avgHR:150, actualDur:90, stravaImport:{cadenceFade:{fadePct:3.1}}};
    await feedSessionTrends({effectiveType:'long', obj, completedDateStr:'2026-09-01', sessionId:'s3', profile:PROFILE});
    expect(setCalls.some(c=>c.key==='cadence-fade-history')).toBe(true);
  });

  it('still feeds trimp-history (HR-based, terrain-independent) on a trail-flagged run of any type', async () => {
    const setCalls = storageSpy();
    const obj = {trailRun: true, avgHR:150, actualDur:40};
    await feedSessionTrends({effectiveType:'easy', obj, completedDateStr:'2026-09-01', sessionId:'s4', profile:PROFILE});
    expect(setCalls.some(c=>c.key==='trimp-history')).toBe(true);
  });
});

describe('feedSessionTrends - a completed race feeds durability tracking, same as a long run', () => {
  it('feeds decoupling-history from a race with real Strava decoupling data', async () => {
    const setCalls = storageSpy();
    const obj = {avgHR:170, actualDur:100, stravaImport:{decoupling:{decouplingPct:5.6}}};
    await feedSessionTrends({effectiveType:'race', obj, completedDateStr:'2026-09-05', sessionId:'s5', profile:PROFILE});
    const point = setCalls.find(c=>c.key==='decoupling-history');
    expect(point).toBeTruthy();
    expect(JSON.parse(point.value).at(-1).value).toBe(5.6);
  });

  it('feeds cadence-fade-history from a race when a cadence stream was available', async () => {
    const setCalls = storageSpy();
    const obj = {avgHR:170, actualDur:100, stravaImport:{cadenceFade:{fadePct:3.4}}};
    await feedSessionTrends({effectiveType:'race', obj, completedDateStr:'2026-09-05', sessionId:'s6', profile:PROFILE});
    expect(setCalls.some(c=>c.key==='cadence-fade-history')).toBe(true);
  });

  it('a trail race is still excluded from decoupling (terrain distorts pace-based signals the same way it does for a trail long run)', async () => {
    const setCalls = storageSpy();
    const obj = {trailRun:true, avgHR:170, actualDur:100, stravaImport:{decoupling:{decouplingPct:5.6}}};
    await feedSessionTrends({effectiveType:'race', obj, completedDateStr:'2026-09-05', sessionId:'s7', profile:PROFILE});
    expect(setCalls.some(c=>c.key==='decoupling-history')).toBe(false);
  });
});
