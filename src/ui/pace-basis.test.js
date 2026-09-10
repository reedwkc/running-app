import { beforeEach, describe, expect, it } from 'vitest';
import { state } from '../state.js';
import { paceBasisHTML } from './week-view.js';

const daysAgo = n => new Date(Date.now() - n*86400000).toISOString();

beforeEach(() => { state.paceSource = null; });

describe('paceBasisHTML', () => {
  it('names a race result as race-verified, whichever tier carried it', () => {
    state.paceSource = {source:'tier2', ltPaceSec:278, updatedAt: daysAgo(4), raceVerified:true};
    const html = paceBasisHTML();
    expect(html).toContain('4:38/km');
    expect(html).toContain('race-verified');
    expect(html).toContain('4 days ago');
  });

  it('distinguishes where the number came from', () => {
    state.paceSource = {source:'tier1', ltPaceSec:273, updatedAt: daysAgo(12)};
    expect(paceBasisHTML()).toContain('from your watch');
    state.paceSource = {source:'tier3', ltPaceSec:273, updatedAt: daysAgo(3)};
    expect(paceBasisHTML()).toContain('from treadmill data');
    state.paceSource = {source:'tier2', ltPaceSec:273, updatedAt: daysAgo(3)};
    expect(paceBasisHTML()).toContain('from a logged session');
  });

  // The exact pace, not the 5-second-rounded display value: this states measured evidence,
  // and evidence should not be rounded for tidiness the way a target you run to is.
  it('reports the measured pace exactly rather than rounded to the display grid', () => {
    state.paceSource = {source:'tier2', ltPaceSec:277, updatedAt: daysAgo(1)};
    expect(paceBasisHTML()).toContain('4:37/km');
  });

  // Past the age where the app itself stops treating a Tier 2/3 read as the ruling view of
  // current fitness, the runner should be told at the point they read the pace - not left to
  // infer it from a date, and not only inside the tier machinery.
  it('warns when the evidence is old enough that the app no longer fully trusts it', () => {
    state.paceSource = {source:'tier2', ltPaceSec:278, updatedAt: daysAgo(60)};
    const html = paceBasisHTML();
    expect(html).toContain('stale');
    expect(html).toContain('may no longer reflect your current fitness');
  });

  it('does not warn while the evidence is still current', () => {
    state.paceSource = {source:'tier2', ltPaceSec:278, updatedAt: daysAgo(44)};
    expect(paceBasisHTML()).not.toContain('stale');
  });

  it('says nothing at all rather than half a sentence when there is no source', () => {
    expect(paceBasisHTML()).toBe('');
    state.paceSource = {source:'tier2', ltPaceSec:null};
    expect(paceBasisHTML()).toBe('');
  });

  it('still names the pace when the source carries no date', () => {
    state.paceSource = {source:'tier1', ltPaceSec:273};
    const html = paceBasisHTML();
    expect(html).toContain('4:33/km');
    expect(html).not.toContain('ago');
  });
});
