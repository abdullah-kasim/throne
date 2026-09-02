// Requirement: `resolveBlockedTag` returns the persisted `blockedBy` list on
// a still-blocked turn even when the fresh pane read would not itself carry
// it -- the durable ledger record is authoritative over observer inference.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveBlockedTag, type BlockedMarkerLedger } from './blocked-marker-resolution.ts';

function fakeLedger(
  stored: { blockedAt: string; blockedBy?: readonly string[] } | null,
): BlockedMarkerLedger & { readonly writes: (readonly string[] | undefined)[]; cleared: boolean } {
  const writes: (readonly string[] | undefined)[] = [];
  let marker = stored;
  return {
    writes,
    cleared: false,
    readBlockedMarker: async () => marker,
    writeBlockedMarker: async (_name, blockedBy) => {
      writes.push(blockedBy);
      marker = { blockedAt: '2026-08-21T00:00:00.000Z', blockedBy };
    },
    clearBlockedMarker: async () => {
      marker = null;
    },
  };
}

test('a still-blocked agent returns its durably persisted blockedBy list even when the fresh pane read carries none', async () => {
  const ledger = fakeLedger({ blockedAt: '2026-08-21T00:00:00.000Z', blockedBy: ['shadow-1'] });

  const state = await resolveBlockedTag(
    'alpha-abc',
    async () => ({ kind: 'blocked', blockedBy: [] }),
    ledger,
  );

  assert.deepEqual(state, { kind: 'blocked', blockedBy: ['shadow-1'] });
});

test('the first observation of a block persists the pane-declared blockedBy list to the ledger', async () => {
  const ledger = fakeLedger(null);

  await resolveBlockedTag(
    'alpha-abc',
    async () => ({ kind: 'blocked', blockedBy: ['shadow-1', 'shadow-2'] }),
    ledger,
  );

  assert.deepEqual(ledger.writes, [['shadow-1', 'shadow-2']]);
});
