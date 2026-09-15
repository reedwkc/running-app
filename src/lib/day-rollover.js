// @ts-nocheck
import { dateToYMD } from './dates.js';
import { notifyAction } from './notify.js';

// Every date-dependent thing in this app is computed once, at load (see main.js): which week
// opens, which day counts as today, whether a past session is overdue, how long ago the
// latest coach update was, and the goal card's own "this block hasn't started yet: it starts
// tomorrow, Monday, Sep 14" line. A phone tab is never actually closed, so that snapshot can
// be days old. Reported live: that exact "starts tomorrow" sentence still on screen on
// Tuesday the 15th, for a block that began Monday the 14th - the page had been rendered on
// Sunday and never re-evaluated since.
//
// A reload, not a re-render: window.storage pulls from the cloud once at load too
// (lib/storage.js), so a days-old tab is also reading a days-old cache and would miss
// anything logged on another device. Re-rendering alone would fix the dates and leave that.
//
// The one thing a reload can lose is typing that was never saved, so that case asks first.
// Returning to a backgrounded tab is the common case and just reloads; a tab sitting open
// across midnight while someone reads it only ever asks, since yanking the page out from
// under a reader to correct a date is worse than the stale date.
export function nextRolloverAction(prevDay, nowDay, opts){
  if(!prevDay || !nowDay || prevDay===nowDay) return 'none';
  if(opts && opts.hasUnsavedInput) return 'prompt';
  return (opts && opts.returningToTab) ? 'reload' : 'prompt';
}

// Deliberately cautious - anything that could be half-filled counts, including an open modal
// whose fields were populated by script rather than typed. A needless prompt costs one tap;
// a needless reload costs someone's unsaved log entry.
export function hasUnsavedInput(doc){
  const d = doc || document;
  if(d.querySelector('.modal.open')) return true;
  const fields = d.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea');
  for(const el of fields){
    if(el.offsetParent===null && el.type!=='hidden') continue; // not actually on screen
    if((el.value||'').trim() && el.value!==el.defaultValue) return true;
  }
  return false;
}

export function initDayRolloverRefresh(){
  let day = dateToYMD(new Date());
  let prompted = false;
  const check = (returningToTab)=>{
    if(document.visibilityState!=='visible') return;
    const now = dateToYMD(new Date());
    const action = nextRolloverAction(day, now, {returningToTab, hasUnsavedInput: hasUnsavedInput()});
    if(action==='none') return;
    if(action==='reload'){ location.reload(); return; }
    if(prompted) return;
    prompted = true;
    notifyAction('It\'s a new day - this page still shows '+day+'.', 'Refresh', ()=>location.reload(), 3600000);
  };
  document.addEventListener('visibilitychange', ()=>check(true));
  window.addEventListener('pageshow', ()=>check(true));
  // A tab left open and visible across midnight never fires either event above.
  setInterval(()=>check(false), 5*60*1000);
}
