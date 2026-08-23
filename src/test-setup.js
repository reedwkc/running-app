// @ts-nocheck - loose DOM stubs, not part of M3's typed surface
// Several pure-logic modules under test transitively import UI modules (e.g. dates.js
// and goal-trajectory.js both import loadWorkoutLog from ui/week-view.js) purely for one
// function they don't otherwise depend on. Importing those UI modules still runs their
// top-level `window.fnName = fnName` onclick-attachment lines, which would throw in
// Vitest's plain Node environment with no window/document. These are just enough stubs
// to let that top-level code run without error - tests never rely on real DOM behavior.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({
      classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
      style: {},
      appendChild(){},
      addEventListener(){},
    }),
    body: { appendChild(){}, contains(){ return false; } },
    addEventListener(){},
  };
}
// lib/notify.js's toast (shown on real read/save failures, e.g. data-store.js's
// notifyError) schedules its "show" class via requestAnimationFrame - not part of the
// document stub above, so any test that exercises a failure path through notifyError/
// notifyInfo would otherwise throw ReferenceError here rather than testing the thing it
// meant to test.
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
}
