import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import { HARNESS_PROVENANCE_STATES } from '../herdr/harness-provenance.ts';
import type { HerdrAgent } from '../herdr/herdr-identity-contracts.ts';
import {
  RESURRECT_LOCK_BASENAME,
  acquireResurrectLock,
  isResurrectLockHeld,
  refreshResurrectLock,
  releaseResurrectLock,
} from '../regent-state/regent-resurrect-lock.ts';
import {
  RESURRECT_LOCK_REFRESH_MS,
  agentsTheRestartEnded,
  namesWithoutLiveHarness,
  restartServerThenRepairCourt,
  resumeAgentsAfterServerRestart,
  whileHoldingResurrectLock,
  type ResumeAfterRestartDeps,
} from './herdr-upgrade-resume.ts';

const VENDORED_BINARY = '/throne/vendor/node_modules/.bin/claude';
const FOUR_MINUTES_MS = 4 * 60 * 1000;

function snapshotted(name: string, overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    agent: 'claude',
    name,
    agentStatus: 'idle',
    sessionId: `session-${name}`,
    cwd: '/tmp/cwd',
    focused: false,
    paneId: `pane-${name}`,
    tabId: `tab-${name}`,
    terminalId: `terminal-${name}`,
    ...overrides,
  };
}

function spawnRecord(): SpawnSpec {
  return { harness: 'claude', model: 'opus', effort: 1, cwd: '/tmp/cwd' };
}

type ResumeRun = {
  deps: ResumeAfterRestartDeps;
  relaunched: string[];
  renamed: { paneId: string; name: string }[];
  logged: string[];
  warned: string[];
};

function restartedCourt(
  lockDirectory: string,
  options: {
    cannotRelaunch?: readonly string[];
    tabIsGone?: readonly string[];
    whileRelaunching?: (name: string) => Promise<void>;
  } = {},
): ResumeRun {
  const relaunched: string[] = [];
  const renamed: ResumeRun['renamed'] = [];
  const logged: string[] = [];
  const warned: string[] = [];
  const relaunchedPanes: HerdrAgent[] = [];
  const deps = {
    listAgents: async () => relaunchedPanes,
    getPaneProcessInfo: async (paneId: string) => ({
      paneId,
      foregroundProcesses: [{ name: 'claude', argv: ['claude', '--resume', 'x'], pid: 4242 }],
    }),
    readSpawnSpec: async () => spawnRecord(),
    writeSpawnSpec: async () => undefined,
    readLiveModel: async () => undefined,
    readHarnessRecord: async () => undefined,
    configuredEffort: async () => undefined,
    now: () => 0,
    resume: async (name: string) => {
      await options.whileRelaunching?.(name);
      if (options.cannotRelaunch?.includes(name)) throw new Error(`no tab holds ${name}`);
      relaunched.push(name);
      relaunchedPanes.push(
        options.tabIsGone?.includes(name)
          ? snapshotted(name, { paneId: `relaunched-${name}`, tabId: `new-tab-${name}`, sessionId: `new-${name}` })
          : snapshotted(name, { name: undefined, paneId: `relaunched-${name}`, sessionId: `new-${name}` }),
      );
    },
    renameAgent: async (paneId: string, name: string) => {
      renamed.push({ paneId, name });
      relaunchedPanes.find((pane) => pane.paneId === paneId)!.name = name;
    },
    harnessProvenance: async () => ({ state: HARNESS_PROVENANCE_STATES.PINNED, executablePath: VENDORED_BINARY }),
    acquireRegentRestartLock: () => acquireResurrectLock(lockDirectory),
    releaseRegentRestartLock: (token: string) => releaseResurrectLock(lockDirectory, token),
    refreshRegentRestartLock: (token: string) => refreshResurrectLock(lockDirectory, token),
    log: (message: string) => logged.push(message),
    warn: (message: string) => warned.push(message),
  } as unknown as ResumeAfterRestartDeps;
  return { deps, relaunched, renamed, logged, warned };
}

async function withLockDirectory(run: (lockDirectory: string) => Promise<void>): Promise<void> {
  const lockDirectory = await mkdtemp(path.join(os.tmpdir(), 'herdr-upgrade-resume-'));
  try {
    await run(lockDirectory);
  } finally {
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

function resumeUnderTheLock(agents: readonly HerdrAgent[], deps: ResumeAfterRestartDeps) {
  return whileHoldingResurrectLock(deps, (lockIsHeld) => resumeAgentsAfterServerRestart(agents, lockIsHeld, deps));
}

test('every agent the restart ended is relaunched in its own tab under its own name', async () => {
  await withLockDirectory(async (lockDirectory) => {
    const court = restartedCourt(lockDirectory);
    const outcomes = await resumeUnderTheLock(
      [snapshotted('stager-one'), snapshotted('alpha-two')],
      court.deps,
    );
    assert.deepEqual(court.relaunched, ['stager-one', 'alpha-two']);
    assert.deepEqual(court.renamed, [
      { paneId: 'relaunched-stager-one', name: 'stager-one' },
      { paneId: 'relaunched-alpha-two', name: 'alpha-two' },
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.verdict), ['restarted', 'restarted']);
    assert.equal(court.logged.length, 2);
    assert.match(court.logged[0]!, /^repair: restarted "stager-one" — resumed native session session-stager-one/);
  });
});

test('an agent whose tab is gone comes back in a new tab and is not reported as failed', async () => {
  await withLockDirectory(async (lockDirectory) => {
    const court = restartedCourt(lockDirectory, { tabIsGone: ['stager-one'] });
    const outcomes = await resumeUnderTheLock([snapshotted('stager-one')], court.deps);
    assert.deepEqual(outcomes.map((outcome) => outcome.verdict), ['restarted']);
    assert.match(outcomes[0]!.detail, new RegExp(`running ${VENDORED_BINARY}$`));
    assert.deepEqual(court.renamed, []);
    assert.deepEqual(court.warned, []);
  });
});

test('the Regent is relaunched last with the resurrect lock held throughout', async () => {
  await withLockDirectory(async (lockDirectory) => {
    const lockHeldDuring: boolean[] = [];
    const court = restartedCourt(lockDirectory, {
      whileRelaunching: async () => {
        lockHeldDuring.push((await acquireResurrectLock(lockDirectory)) === null);
      },
    });
    await resumeUnderTheLock(
      [snapshotted('Regent'), snapshotted('stager-one'), snapshotted('alpha-two')],
      court.deps,
    );
    assert.deepEqual(court.relaunched, ['stager-one', 'alpha-two', 'Regent']);
    assert.deepEqual(lockHeldDuring, [true, true, true]);
    assert.notEqual(await acquireResurrectLock(lockDirectory), null);
  });
});

test('the resurrect lock is taken before the service restarts and held until the Regent is relaunched', async () => {
  await withLockDirectory(async (lockDirectory) => {
    const lockPath = path.join(lockDirectory, RESURRECT_LOCK_BASENAME);
    const lockHeldDuring: boolean[] = [];
    const court = restartedCourt(lockDirectory, {
      whileRelaunching: async () => {
        lockHeldDuring.push(await isResurrectLockHeld(lockDirectory));
      },
    });
    const lockHeldDuringRestart = `test -e '${lockPath}'`;
    const exitCode = await restartServerThenRepairCourt(
      lockHeldDuringRestart,
      async (lockIsHeld) => {
        await resumeAgentsAfterServerRestart([snapshotted('Regent'), snapshotted('stager-one')], lockIsHeld, court.deps);
        return 0;
      },
      court.deps,
    );
    assert.equal(exitCode, 0);
    assert.deepEqual(court.relaunched, ['stager-one', 'Regent']);
    assert.deepEqual(lockHeldDuring, [true, true]);
    assert.equal(await isResurrectLockHeld(lockDirectory), false);
  });
});

test('a restart that stops at a FAILED: line resumes nobody and releases the lock at once', async () => {
  await withLockDirectory(async (lockDirectory) => {
    const court = restartedCourt(lockDirectory);
    let repairs = 0;
    const exitCode = await restartServerThenRepairCourt(
      'exit 1',
      async () => {
        repairs += 1;
        return 0;
      },
      court.deps,
    );
    assert.equal(exitCode, 1);
    assert.equal(repairs, 0);
    assert.equal(await isResurrectLockHeld(lockDirectory), false);
  });
});

test('a repair that throws still releases the lock', async () => {
  await withLockDirectory(async (lockDirectory) => {
    const court = restartedCourt(lockDirectory);
    await assert.rejects(
      restartServerThenRepairCourt('true', async () => Promise.reject(new Error('the roster could not be read')), court.deps),
      /the roster could not be read/,
    );
    assert.equal(await isResurrectLockHeld(lockDirectory), false);
  });
});

test('a lock past its stale age no longer counts as held', async () => {
  await withLockDirectory(async (lockDirectory) => {
    assert.equal(await isResurrectLockHeld(lockDirectory), false);
    await acquireResurrectLock(lockDirectory);
    assert.equal(await isResurrectLockHeld(lockDirectory), true);
    const abandoned = new Date(Date.now() - 2 * FOUR_MINUTES_MS);
    await utimes(path.join(lockDirectory, RESURRECT_LOCK_BASENAME), abandoned, abandoned);
    assert.equal(await isResurrectLockHeld(lockDirectory), false);
  });
});

test('the resurrect lock cannot go stale during a resume longer than its stale age', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  await withLockDirectory(async (lockDirectory) => {
    const lockPath = path.join(lockDirectory, RESURRECT_LOCK_BASENAME);
    const lockHeldDuring: boolean[] = [];
    const court = restartedCourt(lockDirectory, {
      whileRelaunching: async () => {
        const ageing = new Date((await stat(lockPath)).mtimeMs - FOUR_MINUTES_MS);
        await utimes(lockPath, ageing, ageing);
        context.mock.timers.tick(RESURRECT_LOCK_REFRESH_MS);
        await new Promise((resolve) => setTimeout(resolve, 20));
        lockHeldDuring.push((await acquireResurrectLock(lockDirectory)) === null);
      },
    });
    await resumeUnderTheLock(
      [snapshotted('stager-one'), snapshotted('alpha-two'), snapshotted('alpha-three')],
      court.deps,
    );
    assert.deepEqual(lockHeldDuring, [true, true, true]);
  });
});

test('a refresh leaves a lock another caller now holds alone', async () => {
  await withLockDirectory(async (lockDirectory) => {
    await acquireResurrectLock(lockDirectory);
    const lockPath = path.join(lockDirectory, RESURRECT_LOCK_BASENAME);
    const earlier = new Date(Date.now() - FOUR_MINUTES_MS);
    await utimes(lockPath, earlier, earlier);
    await refreshResurrectLock(lockDirectory, 'a token nobody claimed');
    assert.equal((await stat(lockPath)).mtimeMs, earlier.getTime());
  });
});

test('an agent that cannot be relaunched is reported and the others still come back', async () => {
  await withLockDirectory(async (lockDirectory) => {
    const court = restartedCourt(lockDirectory, { cannotRelaunch: ['alpha-two'] });
    const outcomes = await resumeUnderTheLock(
      [snapshotted('alpha-two'), snapshotted('no-session', { sessionId: undefined }), snapshotted('stager-one'), snapshotted('Regent')],
      court.deps,
    );
    assert.deepEqual(court.relaunched, ['stager-one', 'Regent']);
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.name, outcome.verdict]),
      [['alpha-two', 'failed'], ['no-session', 'failed'], ['stager-one', 'restarted'], ['Regent', 'restarted']],
    );
    assert.match(court.warned[0]!, /^repair: failed "alpha-two" — no tab holds alpha-two/);
    assert.match(court.warned[1]!, /^repair: failed "no-session" — herdr reports no native session id/);
  });
});

test('a Regent resurrection already in flight is left to finish while the others come back', async () => {
  await withLockDirectory(async (lockDirectory) => {
    await acquireResurrectLock(lockDirectory);
    const court = restartedCourt(lockDirectory);
    const outcomes = await resumeUnderTheLock([snapshotted('Regent'), snapshotted('stager-one')], court.deps);
    assert.deepEqual(court.relaunched, ['stager-one']);
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.name, outcome.verdict]),
      [['stager-one', 'restarted'], ['Regent', 'skipped']],
    );
  });
});

test('a snapshotted session still live is not relaunched, and one with no session is', () => {
  const survivor = snapshotted('stager-one');
  const ended = snapshotted('alpha-two');
  const noSession = snapshotted('no-session', { sessionId: undefined });
  const liveWithNoSession = snapshotted('someone-else', { sessionId: undefined });
  assert.deepEqual(agentsTheRestartEnded([survivor, ended, noSession], [survivor, liveWithNoSession]), [ended, noSession]);
});

test('a relaunched name on a live harness passes the closing check even with a new session id', async () => {
  await withLockDirectory(async (lockDirectory) => {
    const court = restartedCourt(lockDirectory);
    const snapshot = [snapshotted('stager-one')];
    await resumeUnderTheLock(snapshot, court.deps);
    assert.deepEqual(await namesWithoutLiveHarness(snapshot, court.deps), []);
  });
});

test('a name with no pane or a pane without a live harness fails the closing check', async () => {
  const live = [snapshotted('stager-one')];
  const missing = await namesWithoutLiveHarness([snapshotted('stager-one'), snapshotted('alpha-two')], {
    listAgents: async () => live,
    getPaneProcessInfo: async (paneId) => ({
      paneId,
      foregroundProcesses: [{ name: 'bash', argv: ['/bin/bash'], pid: 7 }],
    }),
  });
  assert.deepEqual(missing, ['stager-one', 'alpha-two']);
});
