import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridge } from './run-bridge.ts';
import { createFileDeliveredEventStore } from './delivered-event-store.ts';
import type {
  InboundMatrixMessage,
  MatrixSyncClient,
  PaneDeliveryService,
} from './bridge.types.ts';

function createFakeMatrixClient(events: InboundMatrixMessage[]): {
  client: MatrixSyncClient;
  downloadCalls: string[];
} {
  const downloadCalls: string[] = [];
  return {
    downloadCalls,
    client: {
      async start(onMessage) {
        for (const event of events) {
          await onMessage(event);
        }
      },
      async downloadAttachment(mxcUri: string) {
        downloadCalls.push(mxcUri);
        return { data: Buffer.from('fake-file-bytes'), contentType: 'image/png' };
      },
    },
  };
}

function createRecordingPaneDelivery(): {
  service: PaneDeliveryService;
  delivered: { botName: string; text: string }[];
} {
  const delivered: { botName: string; text: string }[] = [];
  return {
    delivered,
    service: {
      async deliverToPane(botName, text) {
        delivered.push({ botName, text });
      },
    },
  };
}

test('a Matrix text message reaches the bot pane formatted "<sender> said: <text>"', async () => {
  const { client } = createFakeMatrixClient([
    {
      eventId: '$event1',
      roomId: '!room1',
      senderId: '@rowan:example.org',
      senderDisplayName: 'Rowan',
      text: 'What is the status?',
    },
  ]);
  const { service, delivered } = createRecordingPaneDelivery();
  const stateDir = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  try {
    await runBridge('electronics-expert', {
      matrixClient: client,
      paneDelivery: service,
      deliveredEvents: createFileDeliveredEventStore(
        join(stateDir, 'delivered-events.json'),
      ),
    });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].botName, 'electronics-expert');
    assert.equal(delivered[0].text, 'Rowan said: What is the status?');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('an attachment lands at the documented inbox path and its path is appended to the delivered text', async () => {
  const { client, downloadCalls } = createFakeMatrixClient([
    {
      eventId: '$event2',
      roomId: '!room1',
      senderId: '@rowan:example.org',
      senderDisplayName: 'Rowan',
      text: 'schematic.png',
      attachment: { mxcUri: 'mxc://example.org/abc123', fileName: 'schematic.png' },
    },
  ]);
  const { service, delivered } = createRecordingPaneDelivery();
  const stateDir = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  try {
    await runBridge('electronics-expert', {
      matrixClient: client,
      paneDelivery: service,
      deliveredEvents: createFileDeliveredEventStore(
        join(stateDir, 'delivered-events.json'),
      ),
    });
    assert.deepEqual(downloadCalls, ['mxc://example.org/abc123']);
    assert.equal(delivered.length, 1);
    const expectedPath = join(
      process.env.HOME ?? '',
      '.throne-bot',
      'data',
      'electronics-expert',
      'inbox',
      '$event2.png',
    );
    assert.equal(
      delivered[0].text,
      `Rowan said: schematic.png ${expectedPath}`,
    );
    const savedBytes = await readFile(expectedPath);
    assert.equal(savedBytes.toString(), 'fake-file-bytes');
    await rm(expectedPath, { force: true });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a Matrix message reaches the bot pane exactly once even if the sync replays it', async () => {
  const replayedEvent: InboundMatrixMessage = {
    eventId: '$event3',
    roomId: '!room1',
    senderId: '@rowan:example.org',
    senderDisplayName: 'Rowan',
    text: 'hello',
  };
  const { service, delivered } = createRecordingPaneDelivery();
  const stateDir = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  try {
    const storePath = join(stateDir, 'delivered-events.json');
    const firstSync = createFakeMatrixClient([replayedEvent]);
    await runBridge('electronics-expert', {
      matrixClient: firstSync.client,
      paneDelivery: service,
      deliveredEvents: createFileDeliveredEventStore(storePath),
    });

    const replaySync = createFakeMatrixClient([replayedEvent]);
    await runBridge('electronics-expert', {
      matrixClient: replaySync.client,
      paneDelivery: service,
      deliveredEvents: createFileDeliveredEventStore(storePath),
    });

    assert.equal(delivered.length, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
