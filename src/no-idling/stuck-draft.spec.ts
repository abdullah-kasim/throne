import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActiveComposerSnapshot } from '../codex-screen/composer/composer.types.ts';
import {
  STUCK_DRAFT_AGE_MS,
  stuckDraftsToSubmit,
  type ComposerObservation,
  type DraftSighting,
} from './stuck-draft.ts';

const START = 1_000_000;
const STUCK_TEXT = 'alpha-scratch-01 said: please continue [message 42]';

function draft(text: string): ActiveComposerSnapshot {
  return { state: 'draft', text };
}

function shadowBox(composer: ActiveComposerSnapshot, paneId = 'w1:p1'): ComposerObservation {
  return { paneId, agentName: 'shadow-scratch-01', role: 'Shadow', isRegent: false, composer };
}

function seenAt(firstSeenAt: number, text = STUCK_TEXT, paneId = 'w1:p1'): Map<string, DraftSighting> {
  return new Map([[paneId, { text, firstSeenAt }]]);
}

test('a draft seen for the first time is remembered and not submitted', () => {
  const result = stuckDraftsToSubmit(new Map(), [shadowBox(draft(STUCK_TEXT))], START);
  assert.deepEqual(result.toSubmit, []);
  assert.deepEqual(result.nextSightings.get('w1:p1'), { text: STUCK_TEXT, firstSeenAt: START });
});

test('the same draft still in the box after 59 seconds is not submitted yet', () => {
  const result = stuckDraftsToSubmit(seenAt(START), [shadowBox(draft(STUCK_TEXT))], START + 59_000);
  assert.deepEqual(result.toSubmit, []);
  assert.deepEqual(result.nextSightings.get('w1:p1'), { text: STUCK_TEXT, firstSeenAt: START });
});

test('the same draft still in the box after a minute is submitted on every pass and keeps its first sighting', () => {
  const first = stuckDraftsToSubmit(seenAt(START), [shadowBox(draft(STUCK_TEXT))], START + STUCK_DRAFT_AGE_MS);
  assert.deepEqual(first.toSubmit, ['w1:p1']);
  assert.deepEqual(first.nextSightings.get('w1:p1'), { text: STUCK_TEXT, firstSeenAt: START });
  const second = stuckDraftsToSubmit(first.nextSightings, [shadowBox(draft(STUCK_TEXT))], START + 2 * STUCK_DRAFT_AGE_MS);
  assert.deepEqual(second.toSubmit, ['w1:p1']);
});

test('a draft whose text changed starts the minute again', () => {
  const later = START + 90_000;
  const result = stuckDraftsToSubmit(seenAt(START), [shadowBox(draft('a different line'))], later);
  assert.deepEqual(result.toSubmit, []);
  assert.deepEqual(result.nextSightings.get('w1:p1'), { text: 'a different line', firstSeenAt: later });
});

test('a box that was emptied forgets the draft', () => {
  const result = stuckDraftsToSubmit(seenAt(START), [shadowBox({ state: 'empty', text: '' })], START + 90_000);
  assert.deepEqual(result.toSubmit, []);
  assert.equal(result.nextSightings.has('w1:p1'), false);
});

test('a box showing a menu or that cannot be read is never submitted and is forgotten', () => {
  for (const composer of [{ state: 'modal' }, { state: 'unavailable' }] as const) {
    const result = stuckDraftsToSubmit(seenAt(START), [shadowBox(composer)], START + 90_000);
    assert.deepEqual(result.toSubmit, [], composer.state);
    assert.equal(result.nextSightings.has('w1:p1'), false, composer.state);
  }
});

test('a Stager draft is never submitted however long it sits', () => {
  const stager: ComposerObservation = {
    paneId: 'w1:p1', agentName: 'stager-01', role: 'Stager', isRegent: false, composer: draft(STUCK_TEXT),
  };
  const result = stuckDraftsToSubmit(seenAt(START), [stager], START + 10 * STUCK_DRAFT_AGE_MS);
  assert.deepEqual(result.toSubmit, []);
  assert.equal(result.nextSightings.has('w1:p1'), false);
});

test('the Regent draft is submitted even when its role is a persona title', () => {
  const regent: ComposerObservation = {
    paneId: 'w1:p1', agentName: 'Regent', role: 'Grand Chancellor', isRegent: true, composer: draft(STUCK_TEXT),
  };
  const result = stuckDraftsToSubmit(seenAt(START), [regent], START + STUCK_DRAFT_AGE_MS);
  assert.deepEqual(result.toSubmit, ['w1:p1']);
});

test('an Alpha draft is submitted after a minute', () => {
  const alpha: ComposerObservation = {
    paneId: 'w1:p1', agentName: 'alpha-scratch-01', role: 'alpha', isRegent: false, composer: draft(STUCK_TEXT),
  };
  const result = stuckDraftsToSubmit(seenAt(START), [alpha], START + STUCK_DRAFT_AGE_MS);
  assert.deepEqual(result.toSubmit, ['w1:p1']);
});

test('a pane that is no longer observed is dropped from memory', () => {
  const result = stuckDraftsToSubmit(seenAt(START), [shadowBox(draft(STUCK_TEXT), 'w1:p2')], START + 90_000);
  assert.deepEqual(result.toSubmit, []);
  assert.equal(result.nextSightings.has('w1:p1'), false);
  assert.equal(result.nextSightings.has('w1:p2'), true);
});
