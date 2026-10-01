import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolveLiveThroneRoot } from '../../throne-root-resolution.ts';
import { requireBotCredentials } from '../bot-credentials.ts';
import { createMatrixSyncClient } from './matrix-sync-client.ts';
import { createPaneDeliveryService } from './pane-delivery.service.ts';
import { createFileDeliveredEventStore } from './delivered-event-store.ts';
import { runBridge } from './run-bridge.ts';

export async function main(botName: string): Promise<void> {
  const throneRoot = await resolveLiveThroneRoot();
  const botDir = join(throneRoot, 'bots', botName);
  const credentials = await requireBotCredentials(botDir, botName);
  const stateDir = join(homedir(), '.throne-bot', 'data', botName, 'bridge-state');

  await runBridge(botName, {
    matrixClient: createMatrixSyncClient(credentials, stateDir),
    paneDelivery: createPaneDeliveryService(),
    deliveredEvents: createFileDeliveredEventStore(
      join(stateDir, 'delivered-events.json'),
    ),
  });
}

async function runAsEntryPoint(): Promise<void> {
  const botName = process.argv[2];
  if (botName === undefined || botName === '') {
    process.stderr.write('throne-bot-bridge: missing required bot name argument\n');
    process.exit(1);
  }
  try {
    await main(botName);
  } catch (error) {
    process.stderr.write(
      `throne-bot-bridge: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === `file://${await realpath(process.argv[1])}`
) {
  await runAsEntryPoint();
}
