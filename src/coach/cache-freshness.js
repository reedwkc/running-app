// @ts-nocheck
import { state } from '../state.js';
import { defaultGoalConfig } from '../data/goal-config.js';
import { parseWeekStartDate } from '../lib/dates.js';
import { timeAgo } from '../lib/format.js';

// One staleness rule for every surface that stores something the coach WROTE and the app
// later shows or feeds back as if it were current.
//
// This exists because of a specific failure, twice over. The goal card spent two days into a
// new block insisting "this training block hasn't started yet: it starts tomorrow, Monday,
// Sep 14" - a sentence saved three days earlier, true when written, never revisited, because
// a block beginning is not an event that writes anything. Before that, a stale "durability
// build is the critical lever now" reading from an unrelated skip kept overriding a neutral
// baseline. Same shape both times: prose with an expiry date it knew nothing about.
//
// Deterministic numbers do not belong here. A tier estimate or an LT pace carries its own
// date and is ranked against rival evidence by freshness (getBestAvailableLTPace) - it is a
// measurement, and an old measurement is still a measurement. A sentence is a claim about a
// moment, and moments pass.
//
// Two rules, applied everywhere:
//   1. A reading written before the current block's first TRAINING week has no training
//      behind it to describe, so it stops speaking once that week arrives.
//   2. A reading older than its surface's own useful life stops speaking too - what counts
//      as "too old" differs by what the surface is for, hence MAX_AGE_DAYS below.

// How long each surface's content stays a fair description of now.
//   trajectory - a synthesis of the gap to the goal, written off one session. Two weeks with
//     nothing new written means two weeks of training it never saw.
//   followups - "check back on the quad" is a note to self about the next session or two.
//   insights - learned patterns ("hard days hit next-day readiness"), true over months. No
//     age limit at all; the block rule alone retires these, since a new block is the point
//     where patterns learned under different training stop being safe to assume.
export const MAX_AGE_DAYS = {
  trajectory: 14,
  followups: 10,
  insights: null,
};

export function blockFirstWeekStartDate(){
  const cfg = state.goalConfig || defaultGoalConfig();
  if(cfg.blockStartWeekN==null) return null;
  const startWeek = (state.WEEKS||[]).find(w=>w.n===cfg.blockStartWeekN);
  return startWeek ? parseWeekStartDate(startWeek) : null;
}

export function isPreBlockReading(updatedAt, blockStartDate){
  if(!updatedAt || !blockStartDate) return false;
  const t = new Date(updatedAt);
  return isFinite(t.getTime()) && t < blockStartDate;
}

export function readingAgeDays(updatedAt, now){
  if(!updatedAt) return null;
  const t = new Date(updatedAt);
  if(!isFinite(t.getTime())) return null;
  return ((now||Date.now()) - t.getTime())/86400000;
}

// The shared verdict. A reading with no date at all is treated as current: every writer
// stamps updatedAt, so a missing one means data written before this rule existed, and
// silently retiring content on a technicality is worse than showing it with no age.
export function isStaleReading(reading, opts){
  if(!reading) return true;
  const o = opts||{};
  const blockStart = o.blockStartDate!==undefined ? o.blockStartDate : blockFirstWeekStartDate();
  if(isPreBlockReading(reading.updatedAt, blockStart)) return true;
  if(o.maxAgeDays!=null){
    const age = readingAgeDays(reading.updatedAt, o.now);
    if(age!=null && age > o.maxAgeDays) return true;
  }
  return false;
}

export function freshReading(reading, surface, opts){
  return isStaleReading(reading, Object.assign({maxAgeDays: MAX_AGE_DAYS[surface]}, opts||{})) ? null : reading;
}

// Provenance, in the words a reader needs: when it was written and what it was looking at.
// A number or a sentence with no visible source is one taken on trust, and trust is exactly
// what a stale reading spends.
export function describeReading(reading){
  if(!reading || !reading.updatedAt) return '';
  return timeAgo(reading.updatedAt) + (reading.basedOn ? (' - after '+reading.basedOn) : '');
}
