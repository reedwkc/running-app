// Whole-block audit for the live training plan.
//
// Every check here exists because reviewing the plan a week at a time cannot find these
// problems - a flat spot or a missing progression is only visible looking DOWN a column
// across the whole block. Run it any time:
//
//   node scripts/audit-block.mjs
//
// Reads the live plan-override read-only. Writes nothing, anywhere.
//
// The checks themselves live in src/coach/plan-audit.js, shared with the app's own Plan
// health panel (Key Metrics page) - so the command line and the app can never drift into
// disagreeing about what a sound block looks like. This file is the thin shell: fetch, run,
// print the table.

import { auditBlock } from '../src/coach/plan-audit.js';

const DB = 'https://running-app-d7608-default-rtdb.europe-west1.firebasedatabase.app/5696c294141aa133f759b95565fba4f6';

async function readKey(key){
  const res = await fetch(DB + '/' + key + '.json');
  let v = await res.json();
  if(typeof v === 'string') v = JSON.parse(v);
  return v;
}

const plan = await readKey('plan-override');
const goalCfg = await readKey('goal-config');
const W = (plan && plan.weeksByN) || {};
const weeks = Object.keys(W).map(n => Object.assign({n: Number(n)}, W[n]));

const {rows, checks, failures, warnings, passes} = auditBlock(weeks, {blockStartN: goalCfg && goalCfg.blockStartWeekN});

console.log('\n  n  phase      km  long  fast  goal  q  qMin');
for(const r of rows)
  console.log(
    String(r.n).padStart(3), (r.phase || '-').padEnd(9), r.km.toFixed(0).padStart(3),
    r.longKm.toFixed(0).padStart(5), String(r.longFastKm || '-').padStart(5),
    String(r.goalKm || '-').padStart(5), String(r.quality).padStart(2),
    String(r.qMin).padStart(5), r.cutback ? ' cutback' : '', r.race ? ' RACE' : '');

console.log('\n' + '='.repeat(70));
for(const c of checks) console.log('  ' + c.level.toUpperCase().padEnd(4) + '  ' + c.message);
console.log('='.repeat(70));
console.log('  ' + passes.length + ' passed, ' + warnings.length + ' warnings, ' + failures.length + ' failures\n');
process.exitCode = failures.length ? 1 : 0;
