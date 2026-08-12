export function fmtTime(s){ const m=Math.floor(s/60), sec=Math.round(s%60); return m+':'+String(sec).padStart(2,'0'); }

export function fmtDuration5(totalSec){ const rounded = Math.round(totalSec/300)*300; return fmtTime(rounded); }

export function fmtTime5(sec){ return fmtTime(Math.round(sec/5)*5); }

export function fmtDuration(totalSec){
  const t = Math.round(totalSec);
  const h = Math.floor(t/3600);
  const m = Math.floor((t%3600)/60);
  const s = t%60;
  if(h>0) return h+'h '+String(m).padStart(2,'0')+'m '+String(s).padStart(2,'0')+'s';
  return m+'m '+String(s).padStart(2,'0')+'s';
}

export function fmtPace(spk){ const r = Math.round(spk/5)*5; return fmtTime(r)+'/km'; }

export function paceToKmh(spk){ return (3600/spk).toFixed(1); }

export function distTime(km, spk){ return km*spk; }

export function parsePaceLabelToSec(label){
  if(!label) return null;
  const m = String(label).match(/(\d+):(\d+)/);
  if(!m) return null;
  return parseInt(m[1])*60+parseInt(m[2]);
}

export function parseDurationToMinutes(str){
  if(!str) return '';
  str = str.trim();
  if(str.includes(':')){
    const parts = str.split(':').map(Number);
    if(parts.some(isNaN)) return '';
    let sec;
    if(parts.length===3) sec = parts[0]*3600+parts[1]*60+parts[2];
    else if(parts.length===2) sec = parts[0]*60+parts[1];
    else return '';
    return (sec/60).toFixed(2);
  }
  const n = parseFloat(str);
  return isNaN(n) ? '' : String(n);
}

export function formatMinutesToClock(mins){
  if(mins===undefined || mins===null || mins==='') return '';
  const totalSec = Math.round(parseFloat(mins)*60);
  if(isNaN(totalSec)) return '';
  const h = Math.floor(totalSec/3600);
  const m = Math.floor((totalSec%3600)/60);
  const s = totalSec%60;
  if(h>0) return h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
  return m+':'+String(s).padStart(2,'0');
}

export function parseTime(str){ const p=str.split(':').map(Number); return p[0]*60+p[1]; }

export function timeAgo(isoDate){
  const then = new Date(isoDate);
  const now = new Date();
  const thenMidnight = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((nowMidnight - thenMidnight) / 86400000);
  const timeStr = then.toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'});
  if(days<=0) return 'today at '+timeStr;
  if(days===1) return 'yesterday at '+timeStr;
  if(days<7) return days+'d ago';
  return then.toLocaleDateString('en-US',{month:'short',day:'numeric'});
}
