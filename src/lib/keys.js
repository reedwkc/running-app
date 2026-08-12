// @ts-nocheck
import { state } from '../state.js';

export function workoutKey(weekN, dayTag){ return 'workout-w'+weekN+'-'+dayTag.replace(/[^a-zA-Z0-9]/g,''); }

export function decodeBikeLogKey(key){
  const m = key.match(/^bikeeq-w(\d+)-(.+)$/);
  if(!m) return null;
  const weekN = parseInt(m[1]);
  const week = state.WEEKS.find(w=>w.n===weekN);
  if(!week) return null;
  const day = week.days.find(d=> d.tag.replace(/[^a-zA-Z0-9]/g,'') === m[2]);
  if(!day) return null;
  return {weekN, day};
}

export function decodeRunLogKey(key){
  const m = key.match(/^workout-w(\d+)-(.+)$/);
  if(!m) return null;
  const weekN = parseInt(m[1]);
  const week = state.WEEKS.find(w=>w.n===weekN);
  if(!week) return null;
  const day = week.days.find(d=> d.tag.replace(/[^a-zA-Z0-9]/g,'') === m[2]);
  if(!day) return null;
  return {weekN, day};
}

export function bikeWorkoutKey(weekN, dayTag){ return 'bikeeq-w'+weekN+'-'+dayTag.replace(/[^a-zA-Z0-9]/g,''); }
