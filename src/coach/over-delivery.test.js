import { describe, expect, it } from 'vitest';
import { detectConsistentOverDelivery } from './plan-adherence.js';

// sessionLog entries carry credits as a plain type->credit map with the uncapped ratios
// hung off a non-enumerable `raw` - the same shape effectiveSessionTypes produces.
function logEntry(type, cappedCredit, rawRatio){
  const credits = {[type]: cappedCredit};
  Object.defineProperty(credits, 'raw', {value: {[type]: rawRatio}, enumerable: false});
  return {weekN:1, dayTag:'Mon - Sep 1', name:'s', scheduledType:type, credits};
}

describe('detectConsistentOverDelivery', () => {
  it('sees over-delivery that the capped adherence credit hides completely', () => {
    // Every session credits a flat 1.0 for adherence - by that number alone these look
    // perfectly on-plan, which is exactly why this was invisible before.
    const log = [logEntry('easy',1,1.28), logEntry('easy',1,1.31), logEntry('easy',1,1.22), logEntry('easy',1,1.26)];
    expect(log.every(e => e.credits.easy === 1)).toBe(true);
    const [f] = detectConsistentOverDelivery(log);
    expect(f.kind).toBe('consistentOverDelivery');
    expect(f.severity).toBe('significant');
    expect(f.avgPct).toBe(127);
    expect(f.overCount).toBe(4);
  });

  it('grades a milder pattern as moderate rather than significant', () => {
    const log = [logEntry('long',1,1.12), logEntry('long',1,1.15), logEntry('long',1,1.13)];
    expect(detectConsistentOverDelivery(log)[0].severity).toBe('moderate');
  });

  it('ignores a single long session among normal ones', () => {
    const log = [logEntry('easy',1,1.02), logEntry('easy',1,1.35), logEntry('easy',1,0.98), logEntry('easy',1,1.01)];
    expect(detectConsistentOverDelivery(log)).toHaveLength(0);
  });

  it('needs enough sessions before calling anything a pattern', () => {
    expect(detectConsistentOverDelivery([logEntry('easy',1,1.4), logEntry('easy',1,1.4)])).toHaveLength(0);
  });

  it('says nothing about sessions run at or under the prescription', () => {
    expect(detectConsistentOverDelivery([logEntry('threshold',0.9,0.9), logEntry('threshold',1,1.0), logEntry('threshold',1,1.03)])).toHaveLength(0);
  });

  // Doing more than asked is many things, but it is not evidence against the goal - and it
  // must not trigger the re-ramp that a genuine training gap does.
  it('never reduces goal confidence and never asks for a re-ramp', () => {
    const [f] = detectConsistentOverDelivery([logEntry('easy',1,1.3), logEntry('easy',1,1.3), logEntry('easy',1,1.3)]);
    expect(f.flagGoalConfidence).toBe(false);
    expect(f.reramp).toBe(false);
  });

  it('reports each session type separately', () => {
    const log = [
      logEntry('easy',1,1.25), logEntry('easy',1,1.3), logEntry('easy',1,1.28),
      logEntry('threshold',1,1.0), logEntry('threshold',1,0.99), logEntry('threshold',1,1.02)
    ];
    const found = detectConsistentOverDelivery(log);
    expect(found.map(f=>f.type)).toEqual(['easy']);
  });
});
