import { calendarWeekKey } from './dates.js';
import { readJsonArray, readJsonObject } from './data-store.js';
import { notifyError } from './notify.js';
import { sleep } from './utils.js';

window.storage = (function(){
  const NS = 'coachapp:';
  const DB_URL = 'https://running-app-d7608-default-rtdb.europe-west1.firebasedatabase.app';
  const DB_PATH = '5696c294141aa133f759b95565fba4f6';
  function encodeKey(key){ return encodeURIComponent(key).replace(/\./g, '%2E'); }
  function remoteUrl(key){ return DB_URL+'/'+DB_PATH+'/'+encodeKey(key)+'.json'; }

  // One bulk pull from the cloud at page load replaces the local cache, then get/set/list/delete
  // read from localStorage (fast) and set/delete write through to the cloud in the background.
  const syncReady = (async function(){
    try{
      const res = await fetch(DB_URL+'/'+DB_PATH+'.json');
      if(!res.ok) throw new Error('sync fetch status '+res.status);
      const data = await res.json();
      for(let i=localStorage.length-1; i>=0; i--){
        const k = localStorage.key(i);
        if(k && k.indexOf(NS)===0) localStorage.removeItem(k);
      }
      if(data){
        Object.keys(data).forEach(function(encKey){
          localStorage.setItem(NS+decodeURIComponent(encKey), data[encKey]);
        });
      }
    }catch(e){ console.error('initial cloud sync failed, using local cache', e); }
  })();

  return {
    async get(key){
      await syncReady;
      const raw = localStorage.getItem(NS+key);
      return raw===null ? null : {value: raw};
    },
    async set(key, value){
      await syncReady;
      localStorage.setItem(NS+key, value);
      try{ await fetch(remoteUrl(key), {method:'PUT', body: JSON.stringify(value)}); }
      catch(e){ console.error('cloud save failed, kept locally only', e); }
    },
    async delete(key){
      await syncReady;
      localStorage.removeItem(NS+key);
      try{ await fetch(remoteUrl(key), {method:'DELETE'}); }
      catch(e){ console.error('cloud delete failed', e); }
    },
    async list(prefix){
      await syncReady;
      const keys = [];
      for(let i=0; i<localStorage.length; i++){
        const k = localStorage.key(i);
        if(k && k.indexOf(NS)===0 && k.slice(NS.length).indexOf(prefix||'')===0) keys.push(k.slice(NS.length));
      }
      return {keys};
    }
  };
})();

export async function saveWithRetry(key, obj, shared){
  const payload = JSON.stringify(obj);
  const isShared = shared||false;
  try{
    await window.storage.set(key, payload, isShared);
  }catch(e){
    await new Promise(r=>setTimeout(r,700));
    await window.storage.set(key, payload, isShared);
  }
}

export async function consolidateOldEntries(opts){
  opts = opts || {};
  const autoReload = opts.autoReload !== false;
  const statusEl = document.getElementById('dataIOStatus');
  const showStatus = (msg)=>{ if(statusEl) statusEl.innerHTML = '<div class="note" style="border-top:none; padding-top:0;">'+msg+'</div>'; };
  try{
    const noteList = await window.storage.list('coach-note-', false);
    const noteKeys = (noteList && noteList.keys) || [];
    const dailyList = await window.storage.list('daily-', false);
    const dailyKeys = ((dailyList && dailyList.keys) || []).filter(k=>/^daily-\d{4}-\d{2}-\d{2}-\d+$/.test(k));
    const totalOld = noteKeys.length + dailyKeys.length;
    if(totalOld===0){ if(!opts.silentIfNone) showStatus('Nothing to consolidate - already on the efficient format.'); return 0; }

    // Source keys we can safely delete: only ones whose bucket actually got merged into
    // a successfully-read+saved target. If the target read looks corrupted, the bucket
    // save is skipped entirely and its source keys stay put - better a re-run finds
    // "nothing new to consolidate" than the merge silently drops what was already there.
    let noteBuckets = {};
    let noteBucketSources = {};
    for(let i=0;i<noteKeys.length;i++){
      showStatus('Consolidating old entries... '+(i+1)+'/'+totalOld);
      try{
        const r = await window.storage.get(noteKeys[i], false);
        if(r){
          const obj = JSON.parse(r.value);
          const wk = calendarWeekKey(obj.date);
          noteBuckets[wk] = noteBuckets[wk] || [];
          noteBuckets[wk].push(obj);
          noteBucketSources[wk] = noteBucketSources[wk] || [];
          noteBucketSources[wk].push(noteKeys[i]);
        }
      }catch(e){}
      await sleep(150);
    }
    let safeToDeleteKeys = [];
    for(const wk of Object.keys(noteBuckets)){
      const key = 'dnotes-'+wk;
      const read = await readJsonArray(key);
      if(read.ok){
        await saveWithRetry(key, read.value.concat(noteBuckets[wk]), false);
        safeToDeleteKeys = safeToDeleteKeys.concat(noteBucketSources[wk]);
      } else {
        notifyError('Skipped consolidating '+wk+' notes - existing data looked corrupted. Nothing was lost; try again later.');
      }
      await sleep(150);
    }

    let dailyBuckets = {};
    let dailyBucketSources = {};
    for(let i=0;i<dailyKeys.length;i++){
      showStatus('Consolidating old entries... '+(noteKeys.length+i+1)+'/'+totalOld);
      const m = dailyKeys[i].match(/^daily-(\d{4}-\d{2}-\d{2})-(\d+)$/);
      if(m){
        try{
          const r = await window.storage.get(dailyKeys[i], false);
          if(r){
            const obj = JSON.parse(r.value);
            const date = m[1], ts = parseInt(m[2]);
            const wk = calendarWeekKey(date);
            dailyBuckets[wk] = dailyBuckets[wk] || {};
            dailyBucketSources[wk] = dailyBucketSources[wk] || [];
            dailyBucketSources[wk].push(dailyKeys[i]);
            if(!dailyBuckets[wk][date] || dailyBuckets[wk][date].ts < ts) dailyBuckets[wk][date] = {ts, obj};
          }
        }catch(e){}
      }
      await sleep(150);
    }
    for(const wk of Object.keys(dailyBuckets)){
      const key = 'dmetrics-'+wk;
      const read = await readJsonObject(key);
      if(read.ok){
        const existing = read.value;
        Object.keys(dailyBuckets[wk]).forEach(date=>{ existing[date] = dailyBuckets[wk][date].obj; });
        await saveWithRetry(key, existing, false);
        safeToDeleteKeys = safeToDeleteKeys.concat(dailyBucketSources[wk]);
      } else {
        notifyError('Skipped consolidating '+wk+' daily metrics - existing data looked corrupted. Nothing was lost; try again later.');
      }
      await sleep(150);
    }

    for(let i=0;i<safeToDeleteKeys.length;i++){
      showStatus('Cleaning up old entries... '+(i+1)+'/'+safeToDeleteKeys.length);
      try{ await window.storage.delete(safeToDeleteKeys[i], false); }catch(e){}
      await sleep(150);
    }
    if(autoReload){
      showStatus('Done - consolidated '+safeToDeleteKeys.length+' of '+totalOld+' old entries. Reloading in 2 seconds...');
      setTimeout(()=>location.reload(), 2000);
    }
    return safeToDeleteKeys.length;
  }catch(e){
    console.error('consolidation failed', e);
    showStatus('Something went wrong: '+(e.message||e)+'. Nothing is deleted until after successful migration, so your original data should still be intact.');
    return 0;
  }
}
