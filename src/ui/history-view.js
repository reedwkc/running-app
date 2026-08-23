// @ts-nocheck
import { state } from '../state.js';
import { loadCoachNotes } from '../coach/chat.js';
import { bikeEquivalent, threshold } from '../data/plan.js';
import { loadGoalHistory } from '../data/goal-history.js';
import { timeAgo } from '../lib/format.js';
import { decodeBikeLogKey, decodeRunLogKey } from '../lib/keys.js';
import { batchMap } from '../lib/utils.js';
import { renderNav } from './nav.js';
import { renderBikeProgress } from './progress-view.js';
import { renderDay, segRow } from './week-view.js';

// Goals a plan-override apply dropped or materially changed (e.g. a race swapped for a
// different one, or a target time revised) - archived automatically at apply time, see
// applyPlanOverride/archiveGoal in coach/plan-override.js and data/goal-history.js. Lives
// on the History page (its own section) rather than Key Metrics - past goals are a record
// of what happened, same spirit as the rest of this page, not a current fitness indicator.
async function pastGoalsSectionHTML(){
  const goalHistory = await loadGoalHistory();
  let html = '<div class="week-head" style="margin-top:20px;"><h2>Past goals</h2><div class="callout">Goals that were superseded, dropped, or completed along the way - kept here for reference, not deleted once the plan moves on.</div></div>';
  html += '<div class="card">';
  if(!goalHistory.length){
    html += '<div class="note">No archived goals yet.</div>';
  } else {
    [...goalHistory].sort((a,b)=> (b.archivedAt||'').localeCompare(a.archivedAt||'')).forEach(g=>{
      const targetDesc = (g.goalTimeLabel||'')+(g.goalPaceLabel?(' ('+g.goalPaceLabel+')'):'');
      const outcome = g.reason==='completed'
        ? (g.result && g.result.actualTimeLabel ? ('Finished in '+g.result.actualTimeLabel) : 'Race completed')
        : g.reason==='superseded' ? 'Superseded by a new target' : 'Dropped (no replacement)';
      const detail = [g.raceName, g.raceDate, targetDesc, outcome, timeAgo(g.archivedAt)].filter(Boolean).join(' · ');
      html += segRow(g.label||g.type||'Goal', detail);
    });
  }
  html += '</div>';
  return html;
}

export async function loadRunLogs(){
  let logs = [];
  let seen = new Set();
  try{
    const list = await window.storage.list('workout-w', false);
    if(list && list.keys){
      const decodedList = list.keys.map(k=>({k, decoded:decodeRunLogKey(k)})).filter(x=>x.decoded);
      const results = await batchMap(decodedList, 6, async x=>{
        seen.add(x.k);
        let entry = state.recentSaveCache[x.k];
        if(!entry){
          try{ const r = await window.storage.get(x.k, false); if(r) entry = JSON.parse(r.value); }catch(e){}
        }
        return entry ? {weekN:x.decoded.weekN, day:x.decoded.day, entry} : null;
      });
      results.forEach(r=>{ if(r) logs.push(r); });
    }
  }catch(e){}
  Object.keys(state.recentSaveCache).forEach(k=>{
    if(seen.has(k) || !k.startsWith('workout-w')) return;
    const decoded = decodeRunLogKey(k);
    if(decoded) logs.push({weekN:decoded.weekN, day:decoded.day, entry:state.recentSaveCache[k]});
  });
  logs.sort((a,b)=> a.weekN-b.weekN || state.WEEKS.find(w=>w.n===a.weekN).days.findIndex(d=>d.tag===a.day.tag) - state.WEEKS.find(w=>w.n===b.weekN).days.findIndex(d=>d.tag===b.day.tag));
  return logs;
}

export async function renderRunHistory(){
  const myToken = ++state.renderToken;
  let logs = [];
  try{ logs = await loadRunLogs(); }catch(e){ console.error('loadRunLogs failed', e); }
  const completed = logs.filter(l=>l.entry.completed||l.entry.skipped);
  let allNotes = [];
  try{ allNotes = await loadCoachNotes(); }catch(e){}
  let html = '<div class="week-head"><h2>Training History</h2><div class="callout">Every session you\'ve marked completed or skipped. Tap any card to edit what you logged - changes save the same way as on the Plan page.</div></div>';
  try{ html += await pastGoalsSectionHTML(); }catch(e){ console.error('past goals section failed', e); }

  if(!completed.length) html += '<div class="card"><div class="note">Nothing marked completed yet.</div></div>';
  if(myToken !== state.renderToken || state.view!=='history' || state.appMode!=='run') return;
  document.getElementById('weekContent').innerHTML = html;
  const container = document.getElementById('weekContent');
  for(const l of [...completed].reverse()){
    const dayHtml = await renderDay(l.day, l.weekN, allNotes);
    if(myToken !== state.renderToken || state.view!=='history' || state.appMode!=='run') return;
    container.insertAdjacentHTML('beforeend', dayHtml);
  }
}

export async function loadBikeLogs(){
  let logs = [];
  let seen = new Set();
  try{
    const list = await window.storage.list('bikeeq-', false);
    if(list && list.keys){
      const decodedList = list.keys.map(k=>({k, decoded:decodeBikeLogKey(k)})).filter(x=>x.decoded);
      const results = await batchMap(decodedList, 6, async x=>{
        seen.add(x.k);
        let entry = state.recentSaveCache[x.k];
        if(!entry){
          try{ const r = await window.storage.get(x.k, false); if(r) entry = JSON.parse(r.value); }catch(e){}
        }
        return entry ? {weekN:x.decoded.weekN, day:x.decoded.day, eq:bikeEquivalent(x.decoded.day), entry} : null;
      });
      results.forEach(r=>{ if(r) logs.push(r); });
    }
  }catch(e){}
  Object.keys(state.recentSaveCache).forEach(k=>{
    if(seen.has(k) || !k.startsWith('bikeeq-')) return;
    const decoded = decodeBikeLogKey(k);
    if(decoded) logs.push({weekN:decoded.weekN, day:decoded.day, eq:bikeEquivalent(decoded.day), entry:state.recentSaveCache[k]});
  });
  logs.sort((a,b)=> a.weekN-b.weekN || state.WEEKS.find(w=>w.n===a.weekN).days.findIndex(d=>d.tag===a.day.tag) - state.WEEKS.find(w=>w.n===b.weekN).days.findIndex(d=>d.tag===b.day.tag));
  return logs;
}

export function expandableNoteHTML(text, maxLen){
  maxLen = maxLen || 110;
  if(!text) return '';
  if(text.length <= maxLen) return text;
  const uid = 'note-'+(state.noteUidCounter++);
  const short = text.slice(0, maxLen).trim();
  return '<span id="'+uid+'-short">'+short+'... <button class="log-toggle" style="margin:0;" onclick="toggleNoteExpand(\''+uid+'\')">more</button></span>'+
    '<span id="'+uid+'-full" style="display:none;">'+text+' <button class="log-toggle" style="margin:0;" onclick="toggleNoteExpand(\''+uid+'\')">less</button></span>';
}

export function toggleNoteExpand(uid){
  const short = document.getElementById(uid+'-short');
  const full = document.getElementById(uid+'-full');
  if(!short || !full) return;
  const showingShort = short.style.display !== 'none';
  short.style.display = showingShort ? 'none' : '';
  full.style.display = showingShort ? '' : 'none';
}

export function coachSessionNoteHTML(note){
  if(!note) return '';
  let html = '<div class="note" style="background:rgba(232,163,61,0.09); border:1px solid rgba(232,163,61,0.3); border-radius:8px; padding:10px 12px; margin-top:10px; border-top:1px solid rgba(232,163,61,0.3);"><b style="color:var(--threshold);">Coach ('+timeAgo(note.date)+'):</b> '+expandableNoteHTML(note.text)+'</div>';
  if(note.goalImpact){
    html += '<div class="goal-impact-box"><span class="goal-impact-icon">&#127942;</span><div><div class="goal-impact-label">Goal impact</div><div class="goal-impact-text">'+note.goalImpact.replace(/</g,'&lt;')+'</div></div></div>';
  }
  return html;
}

export async function showHistory(){
  if(!state.WEEKS) return;
  state.view='history';
  renderNav();
  if(state.appMode==='bike'){ renderBikeProgress(); return; }
  renderRunHistory();
}

window.toggleNoteExpand = toggleNoteExpand;
window.showHistory = showHistory;
