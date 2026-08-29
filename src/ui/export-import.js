// @ts-nocheck
import { state } from '../state.js';
import { dateToYMD } from '../lib/dates.js';
import { consolidateOldEntries } from '../lib/storage.js';
import { sleep } from '../lib/utils.js';

export async function exportAllData(evt){
  const btn = evt ? evt.target : null;
  const origText = btn ? btn.innerText : null;
  const statusEl = document.getElementById('dataIOStatus');
  if(btn) btn.innerText = 'Exporting...';
  try{
    const listResult = await window.storage.list('', false);
    const keys = (listResult && listResult.keys) ? listResult.keys : [];
    const bundle = {};
    for(let i=0; i<keys.length; i++){
      if(btn) btn.innerText = 'Exporting... '+(i+1)+'/'+keys.length;
      try{
        const r = await window.storage.get(keys[i], false);
        if(r) bundle[keys[i]] = r.value;
      }catch(e){ console.error('export: failed to read key', keys[i], e); }
      await sleep(150);
    }
    const payload = {exportedAt: new Date().toISOString(), keyCount: Object.keys(bundle).length, data: bundle};
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'coach-app-backup-'+dateToYMD(new Date())+'.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if(btn){ btn.innerText = 'Exported '+payload.keyCount+' items!'; setTimeout(()=>{btn.innerText=origText;}, 2500); }
    if(statusEl) statusEl.innerHTML = '';
  }catch(e){
    console.error('export failed', e);
    if(btn) btn.innerText = origText;
    if(statusEl) statusEl.innerHTML = '<div class="note" style="border-top:none; padding-top:0; color:#ff6b6b;">Export failed: '+(e.message||e)+' - if this mentions a rate limit, wait about a minute and try again.</div>';
  }
}

export async function importAllData(event){
  const file = event.target.files[0];
  if(!file) return;
  const statusEl = document.getElementById('dataIOStatus');
  try{
    const text = await file.text();
    const payload = JSON.parse(text);
    const data = payload.data || payload; // tolerate a raw {key:value} file too
    const keys = Object.keys(data);
    if(!keys.length){
      if(statusEl) statusEl.innerHTML = '<div class="note" style="border-top:none; padding-top:0; color:#ff6b6b;">No data found in that file.</div>';
      return;
    }
    state.pendingImportData = data;
    if(statusEl){
      statusEl.innerHTML = '<div class="note" style="border-top:none; padding-top:0;">This will restore <b>'+keys.length+' items</b> from "'+file.name+'", overwriting any matching data currently stored.<br><button class="ghost-btn" style="margin-top:8px; margin-right:8px;" onclick="confirmImport()">Confirm import</button><button class="ghost-btn" style="margin-top:8px;" onclick="cancelImport()">Cancel</button></div>';
    }
  }catch(e){
    console.error('import parse failed', e);
    if(statusEl) statusEl.innerHTML = '<div class="note" style="border-top:none; padding-top:0; color:#ff6b6b;">Import failed - is this a valid backup file? '+(e.message||e)+'</div>';
  }finally{
    event.target.value = '';
  }
}

export function cancelImport(){
  state.pendingImportData = null;
  const statusEl = document.getElementById('dataIOStatus');
  if(statusEl) statusEl.innerHTML = '';
}

export async function confirmImport(){
  const statusEl = document.getElementById('dataIOStatus');
  if(!state.pendingImportData){ if(statusEl) statusEl.innerHTML = ''; return; }
  const keys = Object.keys(state.pendingImportData);
  let restored = 0;
  for(let i=0; i<keys.length; i++){
    if(statusEl) statusEl.innerHTML = '<div class="note" style="border-top:none; padding-top:0;">Importing... '+(i+1)+'/'+keys.length+'</div>';
    try{ await window.storage.set(keys[i], state.pendingImportData[keys[i]], false); restored++; }
    catch(e){
      console.error('import: failed to restore key', keys[i], e);
      if(String(e.message||e).toLowerCase().includes('rate limit')){
        if(statusEl) statusEl.innerHTML = '<div class="note" style="border-top:none; padding-top:0; color:#ff6b6b;">Hit a rate limit after restoring '+restored+' of '+keys.length+' items - wait about a minute, then choose the same file again to finish the rest (already-restored items won\'t be duplicated).</div>';
        return;
      }
    }
    await sleep(150);
  }
  state.pendingImportData = null;
  if(statusEl) statusEl.innerHTML = '<div class="note" style="border-top:none; padding-top:0; color:var(--easy);">Restored '+restored+' of '+keys.length+' items. Checking for old-format entries to consolidate...</div>';
  const consolidatedCount = await consolidateOldEntries({autoReload:false, silentIfNone:true});
  if(statusEl){
    const extra = consolidatedCount>0 ? (' and consolidated '+consolidatedCount+' old-format entries into the newer format') : '';
    statusEl.innerHTML = '<div class="note" style="border-top:none; padding-top:0; color:var(--easy);">Restored '+restored+' of '+keys.length+' items'+extra+'. Reloading in 2 seconds...</div>';
  }
  setTimeout(()=>{ location.reload(); }, 2000);
}

window.exportAllData = exportAllData;
window.importAllData = importAllData;
window.cancelImport = cancelImport;
window.confirmImport = confirmImport;
