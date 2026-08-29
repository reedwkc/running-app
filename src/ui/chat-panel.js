// @ts-nocheck
import { state } from '../state.js';
import { fetchCoachReply, findUnloggedPastSessions, generateProfileContext, saveCoachNote } from '../coach/chat.js';
import { dateToYMD } from '../lib/dates.js';
import { workoutKey } from '../lib/keys.js';
import { saveWithRetry } from '../lib/storage.js';
import { closeAll, getLatestDailyEntry } from './modals.js';
import { renderNav } from './nav.js';
import { renderWeek } from './week-view.js';

export function toggleChat(open){
  document.getElementById('chatPanel').classList.toggle('open', open);
  document.getElementById('overlay').classList.toggle('open', open);
}

export function goToMissingSession(weekN, dayTag){
  closeAll();
  state.appMode = 'run';
  document.getElementById('btn-app-run').classList.toggle('on', true);
  document.getElementById('btn-app-bike').classList.toggle('on', false);
  document.getElementById('runOnlyToggle').style.display = 'none';
  state.view = 'plan';
  state.currentWeek = weekN;
  renderNav();
  renderWeek(weekN).then(()=>{
    const id = workoutKey(weekN, dayTag);
    const form = document.getElementById(id+'-form');
    if(form){
      form.classList.add('open');
      form.scrollIntoView({behavior:'smooth', block:'center'});
    }
  });
}

export function appendMissingSessionButtons(box, missing){
  if(!missing || !missing.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'paste-block strava-block';
  const label = document.createElement('div');
  label.className = 'paste-label';
  label.innerText = 'Missing logs - tap to fill in';
  wrap.appendChild(label);
  missing.forEach(m=>{
    const btn = document.createElement('button');
    btn.className = 'save-btn';
    btn.style.display = 'block';
    btn.style.marginTop = '6px';
    btn.style.width = '100%';
    btn.style.textAlign = 'left';
    btn.innerText = m.label;
    btn.onclick = ()=> goToMissingSession(m.weekN, m.dayTag);
    wrap.appendChild(btn);
  });
  box.appendChild(wrap);
}

export function renderAssistantMessage(elId, textResp){
  const el = document.getElementById(elId);
  const allMarkerKeys = ['PASTE TO REBUILD:', 'ASK STRAVA:', 'VERDICT SUMMARY:', 'UPDATE INSIGHTS:', 'GOAL IMPACT:', 'RUNNER INSIGHTS:', 'TIER2 ESTIMATE:', 'TIER3 ESTIMATE:', 'GOAL TRAJECTORY:', 'GOAL TRAJECTORY 10K:', 'MAINTENANCE TRAJECTORY:', 'FOLLOW UPS:'];

  let goalImpactText = null;
  const giIdx = textResp.indexOf('GOAL IMPACT:');
  if(giIdx !== -1){
    let giContent = textResp.slice(giIdx + 'GOAL IMPACT:'.length).trim();
    allMarkerKeys.forEach(k=>{ giContent = giContent.split(k)[0]; });
    goalImpactText = giContent.trim();
    textResp = textResp.slice(0, giIdx).trim();
  }

  const displayMarkers = [
    {key:'PASTE TO REBUILD:', label:'Suggested plan change', cls:'paste-block'},
    {key:'ASK STRAVA:', label:'Ask for a Strava check-in', cls:'paste-block strava-block'}
  ];
  let found = null;
  displayMarkers.forEach(m=>{
    const idx = textResp.indexOf(m.key);
    if(idx !== -1 && (!found || idx < found.idx)) found = {idx, marker:m};
  });

  el.innerHTML = '';
  if(!found){
    let plain = textResp;
    allMarkerKeys.forEach(k=>{ plain = plain.split(k)[0]; });
    plain = plain.trim();
    if(plain){
      const p = document.createElement('div');
      p.style.whiteSpace = 'pre-wrap';
      p.innerText = plain;
      el.appendChild(p);
    }
  } else {
    const before = textResp.slice(0, found.idx).trim();
    let after = textResp.slice(found.idx+found.marker.key.length).trim();
    allMarkerKeys.forEach(k=>{ after = after.split(k)[0]; });
    after = after.trim();
    if(before){
      const p = document.createElement('div');
      p.style.whiteSpace = 'pre-wrap';
      p.innerText = before;
      el.appendChild(p);
    }
    const box = document.createElement('div');
    box.className = found.marker.cls;
    const label = document.createElement('div');
    label.className = 'paste-label';
    label.innerText = found.marker.label;
    const body = document.createElement('div');
    body.className = 'paste-body';
    body.innerText = after;
    const btn = document.createElement('button');
    btn.className = 'paste-copy-btn';
    btn.innerText = 'Copy';
    btn.onclick = ()=>{ navigator.clipboard.writeText(after).then(()=>{ btn.innerText='Copied!'; setTimeout(()=>{btn.innerText='Copy';},1500); }); };
    box.appendChild(label); box.appendChild(body); box.appendChild(btn);
    // A plan-change suggestion should lead somewhere direct, not just to a clipboard - same
    // "Draft this rebuild" affordance the top-of-page verdict card already has (chat.js's
    // renderVerdictCard). Only makes sense for an actual plan-change suggestion, not the
    // "ASK STRAVA" check-in block, which isn't a plan change to draft.
    if(found.marker.key==='PASTE TO REBUILD:'){
      const draftBtn = document.createElement('button');
      draftBtn.className = 'ghost-btn';
      draftBtn.style.marginLeft = '8px';
      draftBtn.style.fontSize = '11.5px';
      draftBtn.style.padding = '5px 12px';
      draftBtn.innerText = 'Draft this rebuild';
      draftBtn.onclick = ()=> window.toggleGlobalPlanOverrideModal(true, after);
      box.appendChild(draftBtn);
    }
    el.appendChild(box);
  }

  if(goalImpactText){
    const giBox = document.createElement('div');
    giBox.className = 'goal-impact-box';
    giBox.innerHTML = '<span class="goal-impact-icon">&#127942;</span><div><div class="goal-impact-label">Goal impact</div><div class="goal-impact-text"></div></div>';
    giBox.querySelector('.goal-impact-text').innerText = goalImpactText;
    el.appendChild(giBox);
  }
}

export async function sendChat(){
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if(!text) return;
  input.value='';
  const box = document.getElementById('chatMessages');
  box.insertAdjacentHTML('beforeend', '<div class="msg user">'+text+'</div>');
  box.scrollTop = box.scrollHeight;
  const loadingId = 'loading-'+Date.now();
  box.insertAdjacentHTML('beforeend', '<div class="msg assistant" id="'+loadingId+'">...</div>');
  box.scrollTop = box.scrollHeight;

  let metricsNote = '';
  try{
    const today = dateToYMD(new Date());
    const latest = await getLatestDailyEntry(today);
    if(latest) metricsNote = ' Today\'s most recent logged check-in (there may have been an earlier one this morning - this is the latest): '+JSON.stringify(latest);
  }catch(e){}
  const missingForButtons = await findUnloggedPastSessions();

  try{
    const systemBlocks = await generateProfileContext();
    if(metricsNote) systemBlocks[1] = {type:'text', text: systemBlocks[1].text + metricsNote};
    const data = await fetchCoachReply(systemBlocks, text);
    const textResp = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n') || 'Sorry, I could not generate a response.';
    renderAssistantMessage(loadingId, textResp);
    if(missingForButtons.length && !state.missingButtonsShownThisSession){ appendMissingSessionButtons(box, missingForButtons); state.missingButtonsShownThisSession = true; }
    if(textResp && textResp!=='Sorry, I could not generate a response.'){
      const noteFirstLine = textResp.split('PASTE TO REBUILD:')[0].split('ASK STRAVA:')[0].split('UPDATE INSIGHTS:')[0].split('FOLLOW UPS:')[0].trim();
      saveCoachNote(noteFirstLine, null, null, 'chat');
      const insightsSplit = textResp.split('UPDATE INSIGHTS:');
      if(insightsSplit.length>1){
        const newInsights = insightsSplit[1].split('GOAL TRAJECTORY:')[0].split('GOAL TRAJECTORY 10K:')[0].split('MAINTENANCE TRAJECTORY:')[0].split('VERDICT SUMMARY:')[0].trim();
        if(newInsights) await saveWithRetry('runner-insights', {text:newInsights, updatedAt:new Date().toISOString()}, false);
      }
    }
  }catch(e){
    const msg = e.status===529 ? 'Claude\'s API is briefly overloaded (already retried twice) - not a problem on your end, just try again in a moment' : (e.message||'unknown error');
    document.getElementById(loadingId).innerText = 'Something went wrong reaching the coach (' + msg + ').';
    console.error(e);
  }
  const replyEl = document.getElementById(loadingId);
  if(replyEl) replyEl.scrollIntoView({block:'start', behavior:'smooth'});
}

window.toggleChat = toggleChat;
window.sendChat = sendChat;
