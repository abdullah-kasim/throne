import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProcessSnapshot } from '../process-inspection/proc-scan.ts';
import { resolveNeverTouchPids } from './never-touch.ts';

const THRONE_ROOT = '/home/someone/repos/throne';
const BACKEND_ARGUMENTS = `${THRONE_ROOT}/node_modules/@nestjs/cli/bin/nest.js start --watch --exec ${THRONE_ROOT}/bin/throne-runtime --path tsconfig.build.json`;
const BACKEND_EXEC_START = `${THRONE_ROOT}/bin/throne-runtime ${BACKEND_ARGUMENTS}`;
const SWEEP_PID = 900;
const PINNED_BUN = '/home/someone/.local/share/mise/installs/bun/1.4.4/bin/bun';

function snapshot(pid: number, ppid: number, cmdline: string): ProcessSnapshot {
  return { pid, ppid, state: 'S', cpuTicks: 0, startTicks: 0, comm: 'bun', cmdline };
}

function protectedPids(snapshots: ProcessSnapshot[], protectedCommands: string[]): ReadonlySet<number> {
  const resolution = resolveNeverTouchPids({
    snapshots,
    protectedCommands,
    protectedPids: [],
    liveAgentCwds: [],
    selfPid: SWEEP_PID,
  });
  assert.equal(resolution.state, 'resolved');
  return new Set([...resolution.pids].filter((pid) => pid !== SWEEP_PID));
}

test('the backend started through the runtime launcher is still recognised by its ExecStart once the launcher has become bun', () => {
  const pids = protectedPids(
    [
      snapshot(500, 2, `${PINNED_BUN} ${BACKEND_ARGUMENTS}`),
      snapshot(501, 500, `${PINNED_BUN} --enable-source-maps dist/src/throne-backend-main`),
      snapshot(600, 2, `${PINNED_BUN} ${THRONE_ROOT}/dist/src/tools.js agent-statuses`),
    ],
    [BACKEND_EXEC_START],
  );

  assert.deepEqual([...pids].sort(), [500, 501]);
});

test('a protected command that does not start through the runtime launcher is matched whole', () => {
  const herdrExecStart = '/usr/bin/bash -lc exec /home/someone/.local/bin/herdr server';
  const pids = protectedPids(
    [
      snapshot(700, 2, herdrExecStart),
      snapshot(701, 2, '/usr/bin/zsh -lc exec /home/someone/.local/bin/herdr server'),
    ],
    [herdrExecStart],
  );

  assert.deepEqual([...pids], [700]);
});
