import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { parseBlockedByMarkers, parseReapableMarkers, REAPABLE_MARKER_FAIL } from './greppable-marker.ts';
import { classifyReapabilityAwareLastMessageTags } from './idle-pane-tag-classification.ts';
import { resolveBlockedTag, type BlockedMarkerLedger } from './blocked-marker-resolution.ts';
import { runNoIdling } from './no-idling-run.ts';
import { deps, identityFound, rosterEntry } from './no-idling-command-test-fixtures.ts';

function fixture(name: string): Promise<string> {
  return readFile(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
}

const RENDERED_ALPHA_PANE = await fixture('claude-pane-bold-stripped-blocked-marker.txt');
const RENDERED_ALPHA_PANE_WITH_MARKER_ON_TURN_LINE = await fixture(
  'claude-pane-bold-stripped-blocked-marker-on-turn-line.txt',
);
const RENDERED_CHILD_PANE_REAPABLE = [
  '⏺ Photos are committed and merged into the Alpha branch.',
  '',
  '  {"reapable":"completed"}',
  '',
  '✻ Baked for 4s · done 3:31 PM',
  '',
].join('\n');
const RENDERED_CHILD_PANE_WORKING = [
  '⏺ Photographing the rye loaf next.',
  '',
  '✻ Proofing for 12s',
  '',
].join('\n');

function recordingLedger(): BlockedMarkerLedger & {
  readonly stored: Map<string, { blockedAt: string; blockedBy?: readonly string[] }>;
} {
  const stored = new Map<string, { blockedAt: string; blockedBy?: readonly string[] }>();
  return {
    stored,
    readBlockedMarker: async (name) => stored.get(name) ?? null,
    writeBlockedMarker: async (name, blockedBy) => {
      stored.set(name, { blockedAt: '2026-09-28T07:29:03.338Z', blockedBy });
    },
    clearBlockedMarker: async (name) => {
      stored.delete(name);
    },
  };
}

test('the rendered marker form, with the bold underscores stripped, names the child', () => {
  assert.deepEqual(
    parseBlockedByMarkers('{"blocked":true} BLOCKED_BY_shadow-bakery-02-photos'),
    ['shadow-bakery-02-photos'],
  );
});

test('the raw marker form still names the child, alone and next to a rendered one', () => {
  assert.deepEqual(
    parseBlockedByMarkers('{"blocked":true} __BLOCKED_BY_shadow-a-01__ BLOCKED_BY_shadow-a-02'),
    ['shadow-a-01', 'shadow-a-02'],
  );
});

test('trailing punctuation and prose after a rendered marker are not part of the name', () => {
  assert.deepEqual(parseBlockedByMarkers('waiting (BLOCKED_BY_shadow-a-01).'), ['shadow-a-01']);
  assert.deepEqual(parseBlockedByMarkers('BLOCKED_BY_shadow-a-01- then more'), ['shadow-a-01']);
});

test('a marker glued to a longer word or an underscore tail names nothing rather than a guess', () => {
  assert.deepEqual(parseBlockedByMarkers('UNBLOCKED_BY_shadow-a-01'), []);
  assert.deepEqual(parseBlockedByMarkers('BLOCKED_BY_shadow_a'), []);
});

test('a retired reapable marker whose underscores were rendered away is still read as that marker', () => {
  assert.deepEqual(parseReapableMarkers('"reapable_status": "REAPABLE_FAIL"'), [REAPABLE_MARKER_FAIL]);
  assert.deepEqual(parseReapableMarkers('"reapable_status": "__REAPABLE_FAIL__"'), [REAPABLE_MARKER_FAIL]);
});

test('a real rendered Claude pane classifies as blocked by the child its last turn names', () => {
  assert.deepEqual(classifyReapabilityAwareLastMessageTags(RENDERED_ALPHA_PANE), {
    kind: 'blocked',
    blockedBy: ['shadow-bakery-02-photos'],
  });
});

test('a real rendered Claude pane with the marker on the turn line itself classifies as blocked by that child', () => {
  assert.deepEqual(classifyReapabilityAwareLastMessageTags(RENDERED_ALPHA_PANE_WITH_MARKER_ON_TURN_LINE), {
    kind: 'blocked',
    blockedBy: ['shadow-bakery-03-recipes'],
  });
});

test('a reapable claim quoted inside an earlier message of a rendered pane does not make the blocked Alpha reapable', () => {
  assert.match(RENDERED_ALPHA_PANE, /\{"reapable":"completed"\}/);
  assert.equal(classifyReapabilityAwareLastMessageTags(RENDERED_ALPHA_PANE).kind, 'blocked');
});

test('a block persisted with no children by the old parser takes the children the rendered pane now names', async () => {
  const ledger = recordingLedger();
  ledger.stored.set('alpha-bakery-01', { blockedAt: '2026-09-28T07:00:00.000Z', blockedBy: [] });

  const state = await resolveBlockedTag(
    'alpha-bakery-01',
    async () => classifyReapabilityAwareLastMessageTags(RENDERED_ALPHA_PANE),
    ledger,
  );

  assert.deepEqual(state, { kind: 'blocked', blockedBy: ['shadow-bakery-02-photos'] });
  assert.deepEqual(ledger.stored.get('alpha-bakery-01')?.blockedBy, ['shadow-bakery-02-photos']);
});

test('an Alpha whose rendered pane names its child is woken once that child is reapable, and not before', async () => {
  const ledger = recordingLedger();
  let childPane = RENDERED_CHILD_PANE_WORKING;
  let childStatus: 'idle' | 'working' = 'working';
  const { dependencies, submitCalls } = deps({
    getRoster: async () => [
      rosterEntry('alpha-bakery-01', 'Alpha', 'idle'),
      rosterEntry('shadow-bakery-02-photos', 'Shadow', childStatus),
    ],
    readAgentSupervisor: async (name) =>
      name === 'shadow-bakery-02-photos' ? identityFound('alpha-bakery-01') : identityFound('Regent'),
    readAgent: async (name) => (name === 'alpha-bakery-01' ? RENDERED_ALPHA_PANE : childPane),
    isRegisteredAgent: async () => true,
    blockedMarkerLedger: ledger,
    stillBlockedObservations: new Map<string, number>(),
  });

  await runNoIdling(dependencies, { notify: true });
  assert.deepEqual(
    submitCalls.filter((call) => call.target.name === 'alpha-bakery-01'),
    [],
    'no wake while the named child is still working',
  );
  assert.deepEqual(ledger.stored.get('alpha-bakery-01')?.blockedBy, ['shadow-bakery-02-photos']);

  childPane = RENDERED_CHILD_PANE_REAPABLE;
  childStatus = 'idle';
  await runNoIdling(dependencies, { notify: true });

  const wakes = submitCalls.filter((call) => call.target.name === 'alpha-bakery-01');
  assert.equal(wakes.length, 1, `expected one wake, got ${JSON.stringify(wakes.map((call) => call.prompt))}`);
  assert.match(wakes[0]!.prompt, /shadow-bakery-02-photos/);
  assert.equal(ledger.stored.has('alpha-bakery-01'), false, 'the wake clears the durable blocked marker');
});
