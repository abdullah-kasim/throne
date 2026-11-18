import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { startInTab } from './herdr-launch.ts';
import { DELIVERY_HELPER_PATH, DELIVERY_RUNTIME_PATH, DeliverySocketPathTooLongError } from './delivery-socket-path.ts';
import type { StartInTabDeps } from './herdr-create.contracts.ts';

const temporaryFolder = (prefix: string) => mkdtemp(path.join(os.tmpdir(), prefix));

async function launchDeps(harness: string, recorded: string | undefined, home?: string) {
  const throneHome = home ?? (await temporaryFolder('throne-home-'));
  const directory = await temporaryFolder('throne-vendored-bin-');
  for (const executable of ['claude', 'piy', 'codex']) {
    await writeFile(path.join(directory, executable), '#!/usr/bin/env bash\nexit 0\n');
    await chmod(path.join(directory, executable), 0o755);
  }
  const typed: string[] = [];
  const recordedSockets: string[] = [];
  const runHerdr = (async (args: string[]) => {
    if (args[0] === 'pane' && args[1] === 'send-text') typed.push(args[3]!);
    if (args[0] === 'agent' && args[1] === 'list') {
      return { stdout: JSON.stringify({ result: { agents: [{ agent: harness, terminal_id: 't', pane_id: 'pane-1', name: 'agent-name' }] } }), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }) as StartInTabDeps['runHerdr'];
  const deps: StartInTabDeps = {
    runHerdr,
    now: () => 0,
    sleep: async () => undefined,
    vendoredHarnessBinaryDirectory: directory,
    claudeMod: { decide: () => ({ load: true }), record: async () => undefined, warn: () => undefined },
    deliverySocket: {
      throneHome,
      recorded: async () => recorded,
      record: async (_agentName, socketPath) => {
        recordedSockets.push(socketPath);
      },
    },
  };
  const script = () => readFile(typed[0]!.match(/^ bash '([^']+)'$/)![1]!, 'utf8');
  const exported = async (name: string) => (await script()).match(new RegExp(`^export ${name}='([^']*)'$`, 'm'))?.[1];
  return { deps, typed, recordedSockets, exported };
}

test('a Claude agent launched with the mod records in spawn.json the same socket path its environment carries, with the runtime and helper paths', async () => {
  const launch = await launchDeps('claude', undefined);
  await startInTab('agent-name', 'pane-1', { argv: ['claude'] }, launch.deps);
  const socketPath = await launch.exported('THRONE_DELIVERY_SOCKET');
  assert.ok(socketPath !== undefined && socketPath.endsWith('.sock'));
  assert.deepEqual(launch.recordedSockets, [socketPath]);
  assert.equal(await launch.exported('THRONE_DELIVERY_RUNTIME'), DELIVERY_RUNTIME_PATH);
  assert.equal(await launch.exported('THRONE_DELIVERY_HELPER'), DELIVERY_HELPER_PATH);
});

test('a pi agent records in spawn.json the same socket path its environment carries and gets no helper', async () => {
  const launch = await launchDeps('pi', undefined);
  await startInTab('agent-name', 'pane-1', { argv: ['piy'] }, launch.deps);
  const socketPath = await launch.exported('THRONE_DELIVERY_SOCKET');
  assert.ok(socketPath !== undefined);
  assert.deepEqual(launch.recordedSockets, [socketPath]);
  assert.equal(await launch.exported('THRONE_DELIVERY_HELPER'), undefined);
});

test('a relaunch passes the recorded delivery socket again', async () => {
  const launch = await launchDeps('claude', '/var/home/theuser/.throne/s/recorded.sock');
  await startInTab('agent-name', 'pane-1', { argv: ['claude', '--resume', 'x'] }, launch.deps);
  assert.equal(await launch.exported('THRONE_DELIVERY_SOCKET'), '/var/home/theuser/.throne/s/recorded.sock');
  assert.deepEqual(launch.recordedSockets, ['/var/home/theuser/.throne/s/recorded.sock']);
});

test('the chosen socket lies under the real path of the throne home', async () => {
  const realHome = await temporaryFolder('throne-real-home-');
  const linkedHome = path.join(await temporaryFolder('throne-link-'), 'h');
  await symlink(realHome, linkedHome);
  const launch = await launchDeps('pi', undefined, linkedHome);
  await startInTab('agent-name', 'pane-1', { argv: ['piy'] }, launch.deps);
  assert.equal(path.dirname((await launch.exported('THRONE_DELIVERY_SOCKET'))!), path.join(await realpath(realHome), 's'));
});

test('a socket path over the byte limit refuses the launch loudly before anything is typed', async () => {
  const longHome = path.join(await temporaryFolder('throne-home-'), 'x'.repeat(100));
  const launch = await launchDeps('claude', undefined, longHome);
  await assert.rejects(startInTab('agent-name', 'pane-1', { argv: ['claude'] }, launch.deps), DeliverySocketPathTooLongError);
  assert.deepEqual(launch.typed, []);
});

test('a codex agent gets no delivery socket', async () => {
  const launch = await launchDeps('codex', undefined);
  await startInTab('agent-name', 'pane-1', { argv: ['codex'] }, launch.deps);
  assert.equal(await launch.exported('THRONE_DELIVERY_SOCKET'), undefined);
  assert.deepEqual(launch.recordedSockets, []);
});
