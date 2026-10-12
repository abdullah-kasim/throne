import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { REPO_ROOT, run, type Outcome } from './push-check-sandbox.fixture.ts';
import { findOnPath, linkRealCommands, writeFakeExecutable } from './support/fake-command-host.support.ts';

const HELPER = path.join(REPO_ROOT, 'systemd', 'container-runtime-ensure');
const REAL_COMMANDS = ['date', 'dirname', 'mkdir', 'perl', 'sleep'];
const RECORD_OWN_PROCESS_GROUP = "perl -e 'print getpgrp()'";
const LEFT_RUNNING_PROCESSES = 'left-running-processes';
const RUNTIME_PROCESSES_OUTLIVE_THE_START_BY_SECONDS = 60;
const BOTH_SERVICES_MUST_HAVE_THE_RUNTIME_WITHIN_MILLISECONDS = 5000;
const A_SERVICE_WAS_STILL_WAITING = Symbol('a service was still waiting');

const hostRoots: string[] = [];
after(async () => {
  for (const root of hostRoots) await rm(root, { recursive: true, force: true });
});

type Platform = 'Linux' | 'Darwin';
type Runtime = 'docker' | 'podman';

interface Host {
  root: string;
  fakeBin: string;
  home: string;
  callerDirectory: string;
}

interface RuntimeBehaviour {
  reachable: boolean;
  startMakesItReachable: boolean;
  startSeconds?: number;
  startLeavesProcessRunningSeconds?: number;
}

function recordFile(host: Host, name: string): string {
  return path.join(host.root, name);
}

function reachableMarker(host: Host, runtime: Runtime): string {
  return recordFile(host, `${runtime}-reachable`);
}

async function buildHost(platform: Platform): Promise<Host> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'container-runtime-ensure-')));
  hostRoots.push(root);
  const host = {
    root,
    fakeBin: path.join(root, 'fake-bin'),
    home: path.join(root, 'home'),
    callerDirectory: path.join(root, 'caller'),
  };
  for (const directory of [host.fakeBin, host.home, host.callerDirectory]) await mkdir(directory);
  await linkRealCommands(host.fakeBin, REAL_COMMANDS);
  await writeFakeExecutable(
    path.join(host.fakeBin, 'uname'),
    `${RECORD_OWN_PROCESS_GROUP} > "${recordFile(host, 'helper-process-group')}"\necho ${platform}`,
  );
  await writeFakeExecutable(
    path.join(host.fakeBin, 'flock'),
    `echo locked >> "${recordFile(host, 'lock-requests')}"\nexec "${await findOnPath('flock')}" "$@"`,
  );
  return host;
}

async function markReachable(host: Host, runtime: Runtime): Promise<void> {
  await writeFile(reachableMarker(host, runtime), '');
}

async function installRuntime(host: Host, runtime: Runtime, behaviour: RuntimeBehaviour): Promise<void> {
  if (behaviour.reachable) await markReachable(host, runtime);
  await writeFakeExecutable(
    path.join(host.fakeBin, runtime),
    [
      `if [ "$1" = info ]; then [ -e "${reachableMarker(host, runtime)}" ]; exit; fi`,
      'if [ "$*" != "machine start" ]; then exit 64; fi',
      `echo started >> "${recordFile(host, `${runtime}-starts`)}"`,
      `pwd -P > "${recordFile(host, 'start-directory')}"`,
      `${RECORD_OWN_PROCESS_GROUP} > "${recordFile(host, 'start-process-group')}"`,
      `sleep ${behaviour.startSeconds ?? 0}`,
      leaveProcessRunning(host, behaviour.startLeavesProcessRunningSeconds),
      behaviour.startMakesItReachable ? `: > "${reachableMarker(host, runtime)}"` : ':',
    ].join('\n'),
  );
}

function leaveProcessRunning(host: Host, seconds?: number): string {
  if (seconds === undefined) return ':';
  return `sleep ${seconds} &\necho $! >> "${recordFile(host, LEFT_RUNNING_PROCESSES)}"`;
}

async function stopProcessesLeftRunning(host: Host): Promise<void> {
  for (const processId of await recorded(host, LEFT_RUNNING_PROCESSES)) {
    try {
      process.kill(Number(processId));
    } catch {
      continue;
    }
  }
}

async function askForRuntime(host: Host, extraEnv: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  return run(await findOnPath('sh'), [HELPER], host.callerDirectory, {
    PATH: host.fakeBin,
    HOME: host.home,
    XDG_STATE_HOME: path.join(host.root, 'state'),
    THRONE_CONTAINER_RUNTIME_WAIT_SECONDS: '3',
    THRONE_DOCKER_DESKTOP_APP: path.join(host.root, 'no-docker-desktop'),
    ...extraEnv,
  });
}

async function recorded(host: Host, name: string): Promise<string[]> {
  const content = await readFile(recordFile(host, name), 'utf8').catch(() => '');
  return content.split('\n').filter((line) => line !== '');
}

function assertGot(outcome: Outcome, runtime: Runtime): void {
  assert.deepEqual(outcome, { code: 0, stdout: `${runtime}\n`, stderr: '' });
}

function assertRefusedWithOneLine(outcome: Outcome, line: RegExp): void {
  assert.notEqual(outcome.code, 0);
  assert.equal(outcome.stdout, '');
  assert.equal(outcome.stderr.trimEnd().split('\n').length, 1, outcome.stderr);
  assert.match(outcome.stderr, line);
}

async function macWithStoppedPodman(startSeconds = 0): Promise<Host> {
  const host = await buildHost('Darwin');
  await installRuntime(host, 'podman', { reachable: false, startMakesItReachable: true, startSeconds });
  return host;
}

test('a host whose docker is installed but unreachable and whose podman can be started gets podman, started exactly once', async () => {
  const host = await macWithStoppedPodman();
  await installRuntime(host, 'docker', { reachable: false, startMakesItReachable: false });

  assertGot(await askForRuntime(host), 'podman');

  assert.equal((await recorded(host, 'podman-starts')).length, 1);
  assert.deepEqual(await recorded(host, 'docker-starts'), []);
});

test('two services asking for the runtime at the same moment start it exactly once and both get it', async () => {
  const host = await macWithStoppedPodman(1);

  const outcomes = await Promise.all([askForRuntime(host), askForRuntime(host)]);

  for (const outcome of outcomes) assertGot(outcome, 'podman');
  assert.equal((await recorded(host, 'podman-starts')).length, 1);
});

test("a service that did not start the runtime gets it as soon as it is reachable, even while the runtime's own processes keep running", async (t) => {
  const host = await buildHost('Darwin');
  await installRuntime(host, 'podman', {
    reachable: false,
    startMakesItReachable: true,
    startLeavesProcessRunningSeconds: RUNTIME_PROCESSES_OUTLIVE_THE_START_BY_SECONDS,
  });
  t.after(() => stopProcessesLeftRunning(host));

  const outcomes = await Promise.race([
    Promise.all([askForRuntime(host), askForRuntime(host)]),
    delay(BOTH_SERVICES_MUST_HAVE_THE_RUNTIME_WITHIN_MILLISECONDS, A_SERVICE_WAS_STILL_WAITING, { ref: false }),
  ]);

  assert.ok(outcomes !== A_SERVICE_WAS_STILL_WAITING, 'a service was still waiting for the start lock');
  for (const outcome of outcomes) assertGot(outcome, 'podman');
  assert.equal((await recorded(host, 'podman-starts')).length, 1);
});

test('a host with no container runtime installed is refused with one line saying so', async () => {
  const host = await buildHost('Darwin');

  assertRefusedWithOneLine(await askForRuntime(host), /no container runtime is installed/);
});

test('a forced container runtime is the one that is used', async () => {
  const host = await macWithStoppedPodman();
  await installRuntime(host, 'docker', { reachable: true, startMakesItReachable: false });

  assertGot(await askForRuntime(host, { THRONE_CONTAINER_RUNTIME: 'podman' }), 'podman');

  assert.equal((await recorded(host, 'podman-starts')).length, 1);
});

test('a runtime that never becomes reachable is refused once the wait ends', async () => {
  const host = await buildHost('Darwin');
  await installRuntime(host, 'podman', { reachable: false, startMakesItReachable: false });

  const outcome = await askForRuntime(host, { THRONE_CONTAINER_RUNTIME_WAIT_SECONDS: '2' });

  assertRefusedWithOneLine(outcome, /podman did not become reachable within 2 seconds/);
});

test('a Linux host is never asked to start its runtime, only waited for', async () => {
  const host = await buildHost('Linux');
  await installRuntime(host, 'podman', { reachable: false, startMakesItReachable: true });

  const waiting = askForRuntime(host);
  await delay(1000);
  await markReachable(host, 'podman');

  assertGot(await waiting, 'podman');
  assert.deepEqual(await recorded(host, 'podman-starts'), []);
  assert.deepEqual(await recorded(host, 'lock-requests'), []);
});

test('the runtime is started from the home directory in a process group of its own', async () => {
  const host = await macWithStoppedPodman();

  assertGot(await askForRuntime(host), 'podman');

  assert.deepEqual(await recorded(host, 'start-directory'), [host.home]);
  const [helperProcessGroup] = await recorded(host, 'helper-process-group');
  const [startProcessGroup] = await recorded(host, 'start-process-group');
  assert.match(helperProcessGroup, /^\d+$/);
  assert.match(startProcessGroup, /^\d+$/);
  assert.notEqual(startProcessGroup, helperProcessGroup);
});
