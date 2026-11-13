import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ActiveComposerSnapshot } from '../codex-screen/composer/composer.types.ts';
import type { HerdrAgent } from './herdr-inventory.service.ts';
import { forceEnter, ForcedEnterRefusedError, readComposerWithinTimeout } from './forced-enter.ts';
import {
  OWNED_HERDR_CLIENT_RELEASE_TAG,
  THRONE_HERDR_PROTOCOL,
  THRONE_HERDR_SESSION_NAME,
  pressEnterIgnoringLocks,
  type HerdrProcessBoundary,
} from './herdr-client.ts';

const PANE_ID = 'w9:p9';

async function whilePaneHeldInAnotherProcess(run: () => Promise<void>): Promise<void> {
  const throneHome = await mkdtemp(path.join(os.tmpdir(), 'forced-enter-lock-'));
  const holder = await holdPaneInAnotherProcess(throneHome);
  const previousThroneHome = process.env.THRONE_DATA_HOME;
  process.env.THRONE_DATA_HOME = throneHome;
  try {
    await run();
  } finally {
    if (previousThroneHome === undefined) delete process.env.THRONE_DATA_HOME;
    else process.env.THRONE_DATA_HOME = previousThroneHome;
    holder.kill('SIGKILL');
    await rm(throneHome, { recursive: true, force: true });
  }
}

async function holdPaneInAnotherProcess(throneHome: string) {
  const serviceModule = path.join(import.meta.dirname, '../shared-policy/recipient-pane-lock.service.ts');
  const holder = spawn(process.execPath, ['-e', `
    const { RecipientPaneLockService } = await import(${JSON.stringify(serviceModule)});
    await new RecipientPaneLockService().withRecipientPaneLock(${JSON.stringify(PANE_ID)}, async () => {
      console.log('holding');
      await new Promise(() => {});
    }, { throneHome: ${JSON.stringify(throneHome)} });
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve) => holder.stdout?.once('data', () => resolve()));
  return holder;
}

function agent(harness = 'claude'): HerdrAgent {
  return {
    agent: harness,
    name: 'shadow-stuck',
    agentStatus: 'idle',
    cwd: '/tmp',
    focused: false,
    paneId: PANE_ID,
    tabId: 't',
    terminalId: 'term',
  } as HerdrAgent;
}

function fakes(composer: ActiveComposerSnapshot | undefined) {
  const reads: string[] = [];
  const presses: string[] = [];
  return {
    reads,
    presses,
    dependencies: {
      readComposer: async (target: HerdrAgent) => {
        reads.push(target.paneId);
        return composer;
      },
      pressEnter: async (paneId: string) => {
        presses.push(paneId);
      },
    },
  };
}

describe('the forced Enter', () => {
  it('reads the box once and presses Enter once on a draft', async () => {
    const run = fakes({ state: 'draft', text: 'left in the box' });
    await forceEnter(agent(), run.dependencies);
    assert.deepEqual(run.reads, [PANE_ID]);
    assert.deepEqual(run.presses, [PANE_ID]);
  });

  it('refuses a box covered by a dialog and presses nothing', async () => {
    const run = fakes({ state: 'modal' });
    await assert.rejects(forceEnter(agent(), run.dependencies), (error: Error) =>
      error instanceof ForcedEnterRefusedError && /dialog/.test(error.message),
    );
    assert.deepEqual(run.presses, []);
  });

  it('refuses an unreadable box of a supported harness and presses nothing', async () => {
    const run = fakes({ state: 'unavailable' });
    await assert.rejects(forceEnter(agent(), run.dependencies), /could not be read/);
    assert.deepEqual(run.presses, []);
  });

  it('presses for a harness with no supported screen reader', async () => {
    const run = fakes(undefined);
    await forceEnter(agent('bash'), run.dependencies);
    assert.deepEqual(run.presses, [PANE_ID]);
  });

  it('presses for a harness with no supported screen reader without reading its box', async () => {
    const presses: string[] = [];
    const started = Date.now();
    await forceEnter(agent('bash'), {
      readComposer: readComposerWithinTimeout,
      pressEnter: async (paneId) => {
        presses.push(paneId);
      },
    });
    assert.deepEqual(presses, [PANE_ID]);
    assert.ok(Date.now() - started < 1_000);
  });

  it('presses Enter through herdr while another process holds the pane recipient lock', async () => {
    const herdrCalls: string[][] = [];
    const herdrProcess: HerdrProcessBoundary = {
      execute: async (_executable, args) => {
        herdrCalls.push([...args]);
        if (args.includes('--version')) {
          return { stdout: `herdr ${OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1)}`, stderr: '' };
        }
        if (args.includes('status')) {
          const status = {
            status: 'running',
            version: OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1),
            protocol: THRONE_HERDR_PROTOCOL,
            compatible: true,
            socket: `/run/sessions/${THRONE_HERDR_SESSION_NAME}/herdr.sock`,
          };
          return { stdout: JSON.stringify(status), stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    };
    await whilePaneHeldInAnotherProcess(async () => {
      const started = Date.now();
      await forceEnter(agent(), {
        readComposer: async () => ({ state: 'draft', text: 'left in the box' }),
        pressEnter: (paneId) => pressEnterIgnoringLocks(paneId, herdrProcess),
      });
      assert.ok(Date.now() - started < 2_000);
      assert.ok(herdrCalls.some((args) => args.join(' ').endsWith(`pane send-keys ${PANE_ID} Enter`)));
    });
  });

  it('does not wait on a recipient lock held by another process', async () => {
    await whilePaneHeldInAnotherProcess(async () => {
      const run = fakes({ state: 'draft', text: 'left in the box' });
      const started = Date.now();
      await forceEnter(agent(), run.dependencies);
      assert.deepEqual(run.presses, [PANE_ID]);
      assert.ok(Date.now() - started < 1_000);
    });
  });
});
