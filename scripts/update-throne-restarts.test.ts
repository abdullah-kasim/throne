import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { writeInstallServicesLine } from '../src/install-services/output.ts';
import { readPendingRestarts, servicesChangedWhileRunning, writePendingRestarts } from './update-throne-restarts.mjs';
import {
  AGENT_RESTART_CALL,
  CHANGED_NTFY_UNIT,
  type Court,
  HERDR_HAND_OFF,
  THE_WORD,
  USER_ID,
  backendRuns,
  callsTo,
  courtFor,
  currentDistGeneration,
  dieHere,
  failOnce,
  git,
  herdrPinMovingTo,
  land,
  pinsMoving,
  publishFreshDist,
  restartCalls,
  runUpdate,
} from './update-throne-fixture.ts';

const CHANGED_NTFY_AGENT = 'install-services: com.throne.ntfy.plist: installed content changed while the agent was loaded. Nothing was booted out, kickstarted or killed; applying the new content is an operator decision.\n';
const CHANGED_BOT_SERVER_UNIT = 'install-services: throne-bot-herdr.service: installed content changed while the unit was running. Nothing was restarted, stopped or killed; applying the new content is an operator decision.\n';
const SERVED_TOOLS = ['ntfy.service', 'conduwuit.service', 'forgejo.service'];
const BRIDGES = ['throne-bot-bridge@first.service', 'throne-bot-bridge@second.service'];
const RELOAD_UNITS_CALL = "bash -c 'systemctl' '--user' 'daemon-reload'";
const INSTALL_SERVICES_CALL = 'throne-cli install-services';
const MOVED_HERDR = '0.9.6';
const CHANGED_BACKEND_UNIT = 'install-services: throne-backend.service: installed content changed while the unit was running. Nothing was restarted, stopped or killed; applying the new content is an operator decision.\n';
const CHANGED_BACKEND_AGENT = 'install-services: com.throne.throne-backend.plist: installed content changed while the agent was loaded. Nothing was booted out, kickstarted or killed; applying the new content is an operator decision.\n';
const CHANGED_HERDR_UNIT = 'install-services: throne-herdr.service: installed content changed while the unit was running. Nothing was restarted, stopped or killed (a restart drops every live agent pane); applying the new content is an operator decision.\n';

function restartStep(service: string): string {
  return `bash -c 'systemctl' '--user' 'restart' '${service}'`;
}

function harnessStep(court: Court, harness: string): string {
  return `update-harness.mjs pinned --harness ${harness} --throne-root ${court.checkout}`;
}

function servedToolsRestarted(court: Court): string[] {
  return SERVED_TOOLS.filter((service) => court.calls.includes(restartStep(service)));
}

test('a service whose code changed restarts and an unchanged one does not', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'src/new.ts': 'export const added = 1;\n' });
  court.installServicesOutput = CHANGED_NTFY_UNIT;
  const { output } = await runUpdate(court);
  const steps = callsTo(court, 'bash');
  assert.equal(steps.length, 2);
  assert.ok(steps[0].includes("'systemctl' '--user' 'restart' 'ntfy.service'"));
  assert.ok(steps[1].includes("'systemctl' '--user' 'restart' 'throne-backend.service'"));
  assert.match(output, /^update-throne: report: restarted ntfy\.service$/m);
  assert.match(output, /^update-throne: report: restarted throne-backend$/m);
  court.calls.length = 0;
  court.installServicesOutput = '';
  backendRuns(court, currentDistGeneration(court));
  await runUpdate(court);
  assert.deepEqual(restartCalls(court), []);
});

test('a service whose pinned image moved restarts when it is running', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', pinsMoving({ ntfyImage: 'example.test/ntfy:v2' }));
  backendRuns(court, 'dist.build.0-0');
  await runUpdate(court);
  assert.deepEqual(callsTo(court, 'systemctl --user is-active'), ['systemctl --user is-active --quiet ntfy.service']);
  assert.equal(callsTo(court, 'bash').filter((step) => step.includes("'ntfy.service'")).length, 1);
});

test('a changed terminal server unit with no herdr move is reported and not restarted', async (t) => {
  const court = courtFor(t);
  court.installServicesOutput = CHANGED_HERDR_UNIT;
  const { output } = await runUpdate(court);
  assert.deepEqual(restartCalls(court), []);
  assert.match(output, /^update-throne: report: not restarted throne-herdr\.service — its file changed with no herdr version move, and restarting it ends every agent$/m);
});

test('a changed bot server unit is reported and not restarted, because that restart ends its agents', async (t) => {
  const court = courtFor(t);
  court.installServicesOutput = CHANGED_BOT_SERVER_UNIT;
  const { output } = await runUpdate(court);
  assert.deepEqual(restartCalls(court), []);
  assert.match(output, /^update-throne: report: not restarted throne-bot-herdr\.service — /m);
});

test('a terminal server unit is never left owed to a later run', async (t) => {
  const court = courtFor(t);
  court.installServicesOutput = `${CHANGED_HERDR_UNIT}${CHANGED_BOT_SERVER_UNIT}`;
  await runUpdate(court);
  assert.equal(existsSync(path.join(court.checkout, 'vendor', '.stamps', 'update-throne-pending-restarts')), false);
});

test('herdr moving with the word owes no terminal server restart, because that upgrade does them', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', herdrPinMovingTo('0.9.6'));
  court.installServicesOutput = `${CHANGED_HERDR_UNIT}${CHANGED_BOT_SERVER_UNIT}`;
  const { output } = await runUpdate(court, THE_WORD);
  assert.doesNotMatch(output, /report: not restarted throne-(bot-)?herdr\.service/);
  court.running.herdr = '0.9.6';
  backendRuns(court, currentDistGeneration(court));
  court.installServicesOutput = '';
  court.calls.length = 0;
  await runUpdate(court);
  assert.deepEqual(restartCalls(court), []);
});

test('restarts use launchd on macOS and systemd on Linux', async (t) => {
  const onLinux = courtFor(t);
  backendRuns(onLinux, 'dist.build.0-0');
  onLinux.installServicesOutput = CHANGED_NTFY_UNIT;
  await runUpdate(onLinux, [], { platform: 'linux' });
  assert.ok(callsTo(onLinux, 'bash').every((step) => step.includes("'systemctl' '--user' 'restart'")));
  const onMacos = courtFor(t);
  backendRuns(onMacos, 'dist.build.0-0');
  onMacos.installServicesOutput = CHANGED_NTFY_AGENT;
  await runUpdate(onMacos, [], { platform: 'darwin' });
  assert.deepEqual(callsTo(onMacos, 'launchctl'), [`launchctl print gui/${USER_ID}/com.throne.ntfy`]);
  const steps = callsTo(onMacos, 'bash');
  assert.ok(steps[0].includes(`'launchctl' 'bootout' 'gui/${USER_ID}/com.throne.ntfy'`));
  assert.ok(steps.some((step) => step.includes(`'launchctl' 'bootstrap' 'gui/${USER_ID}'`) && step.includes('com.throne.ntfy.plist')));
  assert.ok(steps.at(-1)?.includes(`'launchctl' 'kickstart' '-k' 'gui/${USER_ID}/com.throne.throne-backend'`));
  assert.ok(steps.every((step) => !step.includes('systemctl')));
});

test('a second run after a failed service restart finishes the restart', async (t) => {
  const court = courtFor(t);
  court.installServicesOutput = CHANGED_NTFY_UNIT;
  const failingRestart = `bash -c 'systemctl' '--user' 'restart' 'ntfy.service'`;
  failOnce(court, failingRestart);
  const first = await runUpdate(court);
  assert.equal(first.code, 1);
  court.installServicesOutput = '';
  const second = await runUpdate(court);
  assert.equal(second.code, 0);
  assert.match(second.output, /^update-throne: report: restarted ntfy\.service$/m);
});

test('a line install-services really writes for a changed running service is a line the update reads', (t) => {
  const written: string[] = [];
  t.mock.method(process.stdout, 'write', (text: string) => written.push(text));
  writeInstallServicesLine('ntfy.service: installed content changed while the unit was running. Nothing was restarted.');
  t.mock.restoreAll();
  assert.deepEqual(servicesChangedWhileRunning(written.join('')), ['ntfy.service']);
});

test('the lines install-services prints for a changed running service are the lines the update reads', () => {
  const repository = path.resolve(import.meta.dirname, '..');
  const linux = readFileSync(path.join(repository, 'src/install-services/linux.ts'), 'utf8');
  const darwin = readFileSync(path.join(repository, 'src/install-services/darwin.ts'), 'utf8');
  assert.ok(linux.includes('${basename}: installed content changed while the unit was running. '));
  assert.ok(darwin.includes('${basename}: installed content changed while the agent was loaded. '));
});

test("a pull that changes a service's own script restarts that service", async (t) => {
  for (const [file, service] of [
    ['systemd/ntfy-serve', 'ntfy.service'],
    ['systemd/conduwuit-serve', 'conduwuit.service'],
    ['systemd/forgejo-serve', 'forgejo.service'],
  ]) {
    const court = courtFor(t);
    land(court, 'origin', { [file]: '#!/bin/sh\n' });
    const { code, output } = await runUpdate(court);
    assert.equal(code, 0);
    assert.deepEqual(servedToolsRestarted(court), [service]);
    assert.ok(output.includes(`update-throne: report: restarted ${service}\n`));
  }
});

test("a pull that changes a service's own config restarts that service", async (t) => {
  for (const [file, service] of [
    ['systemd/ntfy-server.yml', 'ntfy.service'],
    ['systemd/conduwuit.toml', 'conduwuit.service'],
  ]) {
    const court = courtFor(t);
    land(court, 'origin', { [file]: 'changed: true\n' });
    await runUpdate(court);
    assert.deepEqual(servedToolsRestarted(court), [service]);
  }
});

test("a pull that changes a service's file on macOS restarts its launchd agent", async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'systemd/ntfy-serve': '#!/bin/sh\n' });
  const { output } = await runUpdate(court, [], { platform: 'darwin' });
  assert.match(output, /^update-throne: report: restarted com\.throne\.ntfy\.plist$/m);
});

test("a pull that changes none of a service's files restarts none of them", async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'src/new.ts': 'export const added = 1;\n', 'systemd/ntfy-serve.notes': 'not the script\n' });
  await runUpdate(court);
  assert.deepEqual(servedToolsRestarted(court), []);
});

test("a fork's own edit to a service's file owes nothing when upstream left that file alone", async (t) => {
  const court = courtFor(t, { withUpstream: true });
  writeFileSync(path.join(court.checkout, 'local.txt'), 'local\n');
  mkdirSync(path.join(court.checkout, 'systemd'));
  writeFileSync(path.join(court.checkout, 'systemd', 'ntfy-serve'), '#!/bin/sh\n');
  git(court.checkout, 'add', '-A');
  git(court.checkout, 'commit', '-m', 'Edit the fork');
  land(court, 'upstream', { 'src/new.ts': 'export const added = 1;\n' });
  await runUpdate(court, ['--bring-in-upstream']);
  assert.deepEqual(servedToolsRestarted(court), []);
});

test('a new build restarts each running bot bridge', async (t) => {
  const court = courtFor(t);
  court.runningBotBridges = BRIDGES;
  land(court, 'origin', { 'src/new.ts': 'export const added = 1;\n' });
  const { output } = await runUpdate(court);
  for (const bridge of BRIDGES) {
    assert.ok(court.calls.includes(restartStep(bridge)));
    assert.ok(output.includes(`update-throne: report: restarted ${bridge}\n`));
  }
  court.calls.length = 0;
  backendRuns(court, currentDistGeneration(court));
  await runUpdate(court);
  assert.deepEqual(restartCalls(court), []);
});

test('a build on macOS owes no bot bridge, because bridges are systemd units only', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'src/new.ts': 'export const added = 1;\n' });
  await runUpdate(court, [], { platform: 'darwin' });
  assert.deepEqual(callsTo(court, 'systemctl'), []);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a service owed a restart that is not running is reported and not started', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'systemd/ntfy-serve': '#!/bin/sh\n' });
  failOnce(court, 'systemctl --user is-active --quiet ntfy.service');
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0);
  assert.deepEqual(servedToolsRestarted(court), []);
  assert.match(output, /^update-throne: report: not restarted ntfy\.service — it is not running$/m);
});

test('a restart owed before a failed run is finished by the next run', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'systemd/ntfy-serve': '#!/bin/sh\n' });
  failOnce(court, 'bun run build');
  assert.equal((await runUpdate(court)).code, 1);
  assert.deepEqual(servedToolsRestarted(court), []);
  assert.equal((await runUpdate(court)).code, 0);
  assert.deepEqual(servedToolsRestarted(court), ['ntfy.service']);
});

test('a herdr move restarts a changed served tool in the same run', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { ...herdrPinMovingTo(MOVED_HERDR), 'systemd/ntfy-serve': '#!/bin/sh\n' });
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 0);
  assert.deepEqual(servedToolsRestarted(court), ['ntfy.service']);
  assert.ok(court.calls.indexOf(restartStep('ntfy.service')) < court.calls.indexOf(HERDR_HAND_OFF));
  assert.ok(output.indexOf('report: restarted ntfy.service') < output.indexOf('running herdr-upgrade --pinned'));
  assert.doesNotMatch(output, /run the update again/);
});

test('a herdr move reports a stopped served tool and does not start it', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { ...herdrPinMovingTo(MOVED_HERDR), 'systemd/ntfy-serve': '#!/bin/sh\n' });
  failOnce(court, 'systemctl --user is-active --quiet ntfy.service');
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 0);
  assert.deepEqual(servedToolsRestarted(court), []);
  assert.match(output, /^update-throne: report: not restarted ntfy\.service — it is not running$/m);
  assert.equal(readPendingRestarts(court.checkout).includes('ntfy.service'), false);
});

test('a herdr move leaves nothing owed to the next run', async (t) => {
  const court = courtFor(t);
  court.runningBotBridges = BRIDGES;
  land(court, 'origin', { ...herdrPinMovingTo(MOVED_HERDR), ...pinsMoving({ claude: '2.1.0' }), 'systemd/ntfy-serve': '#!/bin/sh\n' });
  court.installServicesOutput = CHANGED_BACKEND_UNIT;
  backendRuns(court, 'dist.build.0-0');
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 0);
  assert.deepEqual(restartCalls(court), [restartStep('ntfy.service')]);
  assert.deepEqual(callsTo(court, 'systemctl --user list-units'), []);
  assert.match(output, /^update-throne: report: restarted herdr, any bot server and bot bridges, the backend and every agent, by herdr-upgrade\.mjs --pinned, which runs next$/m);
  assert.doesNotMatch(output, /report: not restarted/);
  court.installServicesOutput = '';
  backendRuns(court, currentDistGeneration(court));
  court.calls.length = 0;
  await runUpdate(court);
  assert.deepEqual(restartCalls(court), []);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a herdr move covers a bridge an earlier failed run left owed by name', async (t) => {
  const court = courtFor(t);
  court.runningBotBridges = BRIDGES;
  land(court, 'origin', { 'src/new.ts': 'export const added = 1;\n' });
  failOnce(court, restartStep(BRIDGES[0]));
  assert.equal((await runUpdate(court)).code, 1);
  assert.ok(readPendingRestarts(court.checkout).includes(BRIDGES[1]));
  land(court, 'origin', herdrPinMovingTo(MOVED_HERDR));
  court.calls.length = 0;
  const { code } = await runUpdate(court, THE_WORD);
  assert.equal(code, 0);
  assert.ok(BRIDGES.every((bridge) => !court.calls.includes(restartStep(bridge))));
  await runUpdate(court);
  assert.ok(BRIDGES.every((bridge) => !court.calls.includes(restartStep(bridge))));
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a run that fails before the herdr hand-off still owes its restarts', async (t) => {
  const court = courtFor(t);
  court.runningBotBridges = BRIDGES;
  land(court, 'origin', { ...herdrPinMovingTo(MOVED_HERDR), ...pinsMoving({ claude: '2.1.0' }) });
  court.installServicesOutput = CHANGED_BACKEND_UNIT;
  failOnce(court, HERDR_HAND_OFF);
  assert.equal((await runUpdate(court, THE_WORD)).code, 1);
  assert.deepEqual(readPendingRestarts(court.checkout).sort(), ['agents', 'bot-bridges', 'throne-backend.service']);
  court.installServicesOutput = '';
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a served tool that fails to restart stops the run before the herdr hand-off', async (t) => {
  const court = courtFor(t);
  court.runningBotBridges = BRIDGES;
  land(court, 'origin', { ...herdrPinMovingTo(MOVED_HERDR), 'systemd/ntfy-serve': '#!/bin/sh\n' });
  failOnce(court, restartStep('ntfy.service'));
  assert.equal((await runUpdate(court, THE_WORD)).code, 1);
  assert.deepEqual(callsTo(court, 'herdr-upgrade.mjs'), []);
  assert.deepEqual(readPendingRestarts(court.checkout).sort(), ['bot-bridges', 'ntfy.service']);
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  assert.equal(callsTo(court, 'herdr-upgrade.mjs').length, 1);
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a herdr move on macOS reloads a changed backend agent, because the kickstart keeps the old definition', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', herdrPinMovingTo(MOVED_HERDR));
  court.installServicesOutput = CHANGED_BACKEND_AGENT;
  const { code, output } = await runUpdate(court, THE_WORD, { platform: 'darwin' });
  assert.equal(code, 0);
  const steps = callsTo(court, 'bash');
  assert.ok(steps.some((step) => step.includes(`'launchctl' 'bootout' 'gui/${USER_ID}/com.throne.throne-backend'`)));
  assert.ok(court.calls.indexOf(steps[0]) < court.calls.indexOf(HERDR_HAND_OFF));
  assert.match(output, /^update-throne: report: restarted com\.throne\.throne-backend\.plist$/m);
  assert.match(output, /^update-throne: report: restarted herdr, the backend and every agent, by herdr-upgrade\.mjs --pinned, which runs next$/m);
  assert.equal((await runUpdate(court, THE_WORD, { platform: 'darwin' })).code, 0);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('install-services failing after it rewrote a unit still leaves the restart owed', async (t) => {
  const court = courtFor(t);
  failOnce(court, INSTALL_SERVICES_CALL, CHANGED_NTFY_UNIT);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 1);
  assert.match(output, /^update-throne: FAILED: install-services exited 1/m);
  assert.ok(readPendingRestarts(court.checkout).includes('ntfy.service'));
});

test('the next run after install-services failed reloads the units before it restarts', async (t) => {
  const court = courtFor(t);
  failOnce(court, INSTALL_SERVICES_CALL, CHANGED_NTFY_UNIT);
  await runUpdate(court);
  assert.equal(court.calls.includes(RELOAD_UNITS_CALL), false);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0);
  assert.doesNotMatch(output, /units-reload/);
  const reloadAt = court.calls.indexOf(RELOAD_UNITS_CALL);
  assert.ok(reloadAt > court.calls.lastIndexOf(INSTALL_SERVICES_CALL));
  assert.ok(reloadAt < court.calls.indexOf(restartStep('ntfy.service')));
  court.calls.length = 0;
  await runUpdate(court);
  assert.deepEqual(restartCalls(court), []);
});

test('the next run after install-services failed on macOS reloads nothing, because reloading an agent is its restart', async (t) => {
  const court = courtFor(t);
  failOnce(court, INSTALL_SERVICES_CALL, CHANGED_NTFY_AGENT);
  await runUpdate(court, [], { platform: 'darwin' });
  const { output } = await runUpdate(court, [], { platform: 'darwin' });
  assert.deepEqual(callsTo(court, 'systemctl'), []);
  assert.match(output, /^update-throne: report: restarted com\.throne\.ntfy\.plist$/m);
});

test('a run killed right after the pull still restarts the service the pull changed', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'systemd/ntfy-serve': '#!/bin/sh\nexec ntfy serve\n' });
  let owedWhenKilled: string[] = [];
  court.onCall.set('git merge', () => {
    owedWhenKilled = readPendingRestarts(court.checkout);
    dieHere();
  });
  await runUpdate(court);
  court.onCall.delete('git merge');
  writePendingRestarts(court.checkout, owedWhenKilled);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0, output);
  assert.match(output, /^update-throne: report: restarted ntfy\.service$/m);
});

test('a run killed after its build published still restarts the bot bridges', async (t) => {
  const court = courtFor(t);
  court.runningBotBridges = ['throne-bot-bridge@one.service'];
  land(court, 'origin', { 'src/new.ts': 'export const added = 1;\n' });
  court.onCall.set('bun run build', () => {
    publishFreshDist(court);
    dieHere();
  });
  await runUpdate(court);
  court.onCall.delete('bun run build');
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0, output);
  assert.match(output, /^update-throne: report: restarted throne-bot-bridge@one\.service$/m);
});

test('a run killed after a harness moved still owes the agents', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', pinsMoving({ claude: '2.1.0' }));
  court.onCall.set('update-harness.mjs', () => {
    court.running.claude = '2.1.0';
    dieHere();
  });
  await runUpdate(court);
  court.onCall.delete('update-harness.mjs');
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 0, output);
  assert.match(output, /^update-throne: report: restarted every agent$/m);
});

test('a harness step that fails and moves nothing owes the agents nothing', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', pinsMoving({ codex: '0.51.0' }));
  failOnce(court, harnessStep(court, 'codex'));
  const { code, output } = await runUpdate(court);
  assert.equal(code, 1);
  assert.match(output, /^update-throne: FAILED: update-harness pinned codex exited 1/m);
  assert.equal(readPendingRestarts(court.checkout).includes('agents'), false);
});

test('a harness step that fails after moving the binary still owes the agents', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', pinsMoving({ codex: '0.51.0' }));
  failOnce(court, harnessStep(court, 'codex'));
  court.onCall.set(harnessStep(court, 'codex'), () => {
    court.running.codex = '0.51.0';
  });
  assert.equal((await runUpdate(court)).code, 1);
  assert.ok(readPendingRestarts(court.checkout).includes('agents'));
});

test('a harness that moved stays owed when the next harness fails having moved nothing', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', pinsMoving({ claude: '2.1.0', codex: '0.51.0' }));
  failOnce(court, harnessStep(court, 'codex'));
  assert.equal((await runUpdate(court)).code, 1);
  assert.ok(readPendingRestarts(court.checkout).includes('agents'));
});

test('a pin that returns to the installed version restarts nobody', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', pinsMoving({ codex: '0.51.0' }));
  failOnce(court, harnessStep(court, 'codex'));
  assert.equal((await runUpdate(court)).code, 1);
  land(court, 'origin', pinsMoving({ codex: '0.50.0' }));
  const check = await runUpdate(court, ['--check']);
  assert.doesNotMatch(check.output, /question: restart every agent/);
  const noWord = await runUpdate(court);
  assert.equal(noWord.code, 0);
  assert.doesNotMatch(noWord.output, /report: not restarted agents/);
  assert.equal((await runUpdate(court, THE_WORD)).code, 0);
  assert.deepEqual(callsTo(court, AGENT_RESTART_CALL), []);
});

test('a backend with no generation marker is reported and not restarted', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'src/new.ts': 'export const added = 1;\n' });
  rmSync(path.join(court.markerDirectory, 'throne-backend.service.json'));
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0, output);
  assert.deepEqual(restartCalls(court), []);
  assert.match(output, /^update-throne: report: not restarted throne-backend — it left no generation marker, so what it runs cannot be read$/m);
});
