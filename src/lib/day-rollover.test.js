import { describe, expect, it } from 'vitest';
import { hasUnsavedInput, nextRolloverAction } from './day-rollover.js';

describe('nextRolloverAction', () => {
  it('does nothing while the date is unchanged', () => {
    expect(nextRolloverAction('2026-09-15', '2026-09-15', {returningToTab: true})).toBe('none');
    expect(nextRolloverAction(null, '2026-09-15', {returningToTab: true})).toBe('none');
  });

  it('reloads a backgrounded tab returned to on a later day', () => {
    expect(nextRolloverAction('2026-09-13', '2026-09-15', {returningToTab: true})).toBe('reload');
  });

  it('only asks when a tab sits open across midnight', () => {
    expect(nextRolloverAction('2026-09-14', '2026-09-15', {returningToTab: false})).toBe('prompt');
  });

  it('never reloads over unsaved typing', () => {
    expect(nextRolloverAction('2026-09-13', '2026-09-15', {returningToTab: true, hasUnsavedInput: true})).toBe('prompt');
  });
});

// There is no real DOM in this test environment, and hasUnsavedInput only ever asks a
// document two things - so it is given exactly those two. `offsetParent` stands in for "is
// this actually on screen": a real rendered field has one, a field inside a collapsed card
// does not.
describe('hasUnsavedInput', () => {
  const docOf = (openModal, fields) => ({
    querySelector: () => (openModal ? {} : null),
    querySelectorAll: () => fields.map(f => Object.assign({type: 'text', offsetParent: {}, value: '', defaultValue: ''}, f)),
  });

  it('treats an open modal as unsaved, whatever else is on the page', () => {
    expect(hasUnsavedInput(docOf(true, []))).toBe(true);
    expect(hasUnsavedInput(docOf(false, []))).toBe(false);
  });

  it('ignores a field still holding the value it was rendered with', () => {
    expect(hasUnsavedInput(docOf(false, [{value: '8.5', defaultValue: '8.5'}]))).toBe(false);
  });

  it('ignores whitespace-only typing', () => {
    expect(hasUnsavedInput(docOf(false, [{value: '   ', defaultValue: ''}]))).toBe(false);
  });

  it('flags a visible field whose value was typed into', () => {
    expect(hasUnsavedInput(docOf(false, [{value: 'half a log entry', defaultValue: ''}]))).toBe(true);
  });

  it('ignores a field that is not on screen (a collapsed card\'s form)', () => {
    expect(hasUnsavedInput(docOf(false, [{value: 'stale', defaultValue: '', offsetParent: null}]))).toBe(false);
  });
});
