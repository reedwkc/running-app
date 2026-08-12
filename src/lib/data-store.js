import { notifyError } from './notify.js';

// Hardened read helpers for the read-collection -> mutate -> save pattern used all over
// this app. A key that genuinely doesn't exist yet is a normal, empty starting state -
// {ok:true, value:[]} / {ok:true, value:{}}. A key that exists but fails to read or parse
// is NOT the same thing and must never be treated as empty: callers get {ok:false} and
// must abort the save, so a corrupt/unreachable read can never overwrite good history
// with a freshly-truncated one.

/**
 * @template T
 * @param {string} key
 * @returns {Promise<{ok:true, value:T[]} | {ok:false, value:null}>}
 */
export async function readJsonArray(key){
  let r;
  try{
    r = await window.storage.get(key, false);
  }catch(e){
    notifyError('Could not reach storage to read existing data for "'+key+'" - nothing was saved, to avoid losing what was already there.');
    return {ok:false, value:null};
  }
  if(!r) return {ok:true, value:[]};
  let parsed;
  try{
    parsed = JSON.parse(r.value);
  }catch(e){
    notifyError('Existing data for "'+key+'" looks corrupted and could not be read - nothing was saved, to avoid losing what was already there.');
    return {ok:false, value:null};
  }
  if(!Array.isArray(parsed)){
    notifyError('Existing data for "'+key+'" was not in the expected format - nothing was saved, to avoid losing what was already there.');
    return {ok:false, value:null};
  }
  return {ok:true, value:parsed};
}

/**
 * @template {Record<string, any>} T
 * @param {string} key
 * @returns {Promise<{ok:true, value:T} | {ok:false, value:null}>}
 */
export async function readJsonObject(key){
  let r;
  try{
    r = await window.storage.get(key, false);
  }catch(e){
    notifyError('Could not reach storage to read existing data for "'+key+'" - nothing was saved, to avoid losing what was already there.');
    return {ok:false, value:null};
  }
  if(!r) return {ok:true, value:/** @type {T} */ ({})};
  let parsed;
  try{
    parsed = JSON.parse(r.value);
  }catch(e){
    notifyError('Existing data for "'+key+'" looks corrupted and could not be read - nothing was saved, to avoid losing what was already there.');
    return {ok:false, value:null};
  }
  if(typeof parsed !== 'object' || parsed===null || Array.isArray(parsed)){
    notifyError('Existing data for "'+key+'" was not in the expected format - nothing was saved, to avoid losing what was already there.');
    return {ok:false, value:null};
  }
  return {ok:true, value:parsed};
}
