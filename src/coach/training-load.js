// @ts-nocheck
// Acute:Chronic Workload Ratio (ACWR) - a well-established sports-science framework for
// tracking training-load trend and injury risk (see Gabbett, "The training-injury
// prevention paradox", Br J Sports Med 2016; Hulin et al. 2016), computed here from the
// app's own TRIMP history instead of transcribed from Garmin. Uses the classic "coupled"
// rolling-average form: acute = sum of the last 7 days' load, chronic = the last 28 days'
// load averaged down to a weekly rate (sum/4). There's a newer uncoupled/EWMA variant
// (Williams et al. 2016) that addresses some real statistical critiques of the coupled
// form, but the simple rolling-average version is the one most commonly cited in practice
// and is the more transparent, auditable choice for a runner reading their own numbers.
import { dateToYMD } from '../lib/dates.js';
import { readJsonArray } from '../lib/data-store.js';

const ACUTE_DAYS = 7;
const CHRONIC_DAYS = 28;
// Below this many days of history, the chronic window is mostly padded with "no data"
// rather than real training - the ratio would technically compute but wouldn't mean what
// ACWR is supposed to mean, so treat it as not-yet-available rather than report a
// misleadingly precise-looking number this early.
const MIN_HISTORY_DAYS = 14;

function daysBetween(aStr, bStr){
  return Math.round((new Date(bStr+'T00:00:00') - new Date(aStr+'T00:00:00')) / 86400000);
}

export const ACWR_MIN_HISTORY_DAYS = MIN_HISTORY_DAYS;

// How many days of real logged history exist as of asOfDateStr - the same span
// computeACWR itself checks against MIN_HISTORY_DAYS before returning a ratio, exposed here
// so a caller (the Strava-import UI) can explain WHY acute/chronic/status came back empty
// today ("9 of 14 days logged so far") instead of leaving a runner to wonder if something's
// broken when it's actually just a new-enough feature that history hasn't accumulated yet.
export function trimpHistorySpanDays(trimpPoints, asOfDateStr){
  const asOf = asOfDateStr || dateToYMD(new Date());
  const points = (trimpPoints||[]).filter(p=>p && p.date && p.value!=null && daysBetween(p.date, asOf) >= 0);
  if(!points.length) return 0;
  const oldestDate = points.reduce((min,p)=> p.date<min ? p.date : min, points[0].date);
  return daysBetween(oldestDate, asOf);
}

// trimpPoints: [{date:'YYYY-MM-DD', value:number}, ...], not necessarily sorted or deduped
// by date. asOfDateStr defaults to today; passing it explicitly lets a caller preview "what
// would this look like including a session I haven't saved yet" without writing anything.
export function computeACWR(trimpPoints, asOfDateStr){
  const asOf = asOfDateStr || dateToYMD(new Date());
  const points = (trimpPoints||[]).filter(p=>p && p.date && p.value!=null && daysBetween(p.date, asOf) >= 0);
  if(!points.length) return null;
  const oldestDate = points.reduce((min,p)=> p.date<min ? p.date : min, points[0].date);
  if(daysBetween(oldestDate, asOf) < MIN_HISTORY_DAYS) return null;
  let acute = 0, chronicSum = 0;
  points.forEach(p=>{
    const age = daysBetween(p.date, asOf);
    if(age < ACUTE_DAYS) acute += p.value;
    if(age < CHRONIC_DAYS) chronicSum += p.value;
  });
  const chronic = chronicSum / (CHRONIC_DAYS/7);
  const ratio = chronic > 0 ? acute/chronic : null;
  // The field this feeds (loadStatus) only offers Low/Optimal/High, so the commonly-cited
  // "moderate risk" 1.3-1.5 band (see Gabbett 2016) is folded into High here rather than
  // silently dropped - erring toward flagging early over flagging late.
  let status = null;
  if(ratio!=null){
    status = ratio < 0.8 ? 'Low' : ratio <= 1.3 ? 'Optimal' : 'High';
  }
  return {
    acute: Math.round(acute*10)/10,
    chronic: Math.round(chronic*10)/10,
    ratio: ratio!=null ? Math.round(ratio*100)/100 : null,
    status
  };
}

export async function loadTrimpHistory(){
  const read = await readJsonArray('trimp-history');
  return read.ok ? read.value : [];
}
