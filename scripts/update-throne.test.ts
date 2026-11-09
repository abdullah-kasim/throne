import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  AGENT_RESTART_CALL,
  CHANGED_NTFY_UNIT,
  THE_WORD,
  backendRuns,
  callsTo,
  courtFor,
  failOnce,
  git,
  herdrPinMovingTo,
  land,
  pinsMoving,
  readLog,
  restartCalls,
  runUpdate,
  snapshotCheckout,
} from './update-throne-fixture.ts';

function printedLine(output: string, opening: string): string | undefined {
  return output.split('\n').find((line) => line.startsWith(`update-throne: ${opening}`));
}

test('a checkout whose origin is named as private is detected as the private repo', async (t) => {
  const court = courtFor(t, { originName: 'court-private' });
  const { code, output } = await runUpdate(court, ['--check'], {
    askHost: async () => assert.fail('a private checkout never asks the host'),
  });
  assert.equal(code, 0);
  assert.match(output, /^update-throne: checkout: private \(origin's name ends -private\)$/m);
});

test('a checkout with an upstream remote is detected as a fork', async (t) => {
  const court = courtFor(t, { withUpstream: true });
  const { output } = await runUpdate(court, ['--check']);
  assert.match(output, /^update-throne: checkout: fork \(it has a remote named upstream\)$/m);
});

test('a checkout the host reports as a fork is detected as a fork', async (t) => {
  const court = courtFor(t);
  court.originUrlSeen = 'https://github.com/someone/court.git';
  const askedAbout: string[] = [];
  const { output } = await runUpdate(court, ['--check'], {
    askHost: async (repository) => {
      askedAbout.push(repository);
      return { fork: true, parentUrl: court.upstream };
    },
  });
  assert.deepEqual(askedAbout, ['someone/court']);
  assert.match(output, /^update-throne: checkout: fork \(github reports origin as a fork of /m);
});

test('any other checkout is detected as the public repo', async (t) => {
  const onGithub = courtFor(t);
  onGithub.originUrlSeen = 'git@github.com:someone/court.git';
  assert.match((await runUpdate(onGithub, ['--check'])).output, /^update-throne: checkout: public \(github reports origin is not a fork\)$/m);
  const elsewhere = courtFor(t);
  assert.match(
    (await runUpdate(elsewhere, ['--check'])).output,
    /^update-throne: checkout: public \(origin is not on github\.com and there is no upstream remote\)$/m,
  );
});

test('a host that cannot be asked is read as public and the run says so', async (t) => {
  const court = courtFor(t);
  court.originUrlSeen = 'https://github.com/someone/court';
  const { code, output } = await runUpdate(court, ['--check'], {
    askHost: async () => {
      throw new Error('no route to host');
    },
  });
  assert.equal(code, 0);
  assert.match(output, /^update-throne: checkout: public \(github could not be asked whether origin is a fork \(no route to host\), so this reads as public\)$/m);
});

test('a public checkout fast-forwards to the latest default branch', async (t) => {
  const court = courtFor(t);
  const latest = land(court, 'origin', { 'src/new.ts': 'export const added = 1;\n' });
  const { code } = await runUpdate(court);
  assert.equal(code, 0);
  assert.equal(git(court.checkout, 'rev-parse', 'HEAD'), latest);
  assert.equal(git(court.checkout, 'rev-list', '--merges', '--count', 'HEAD'), '0');
});

test('a default branch with another name is read from the remote', async (t) => {
  const court = courtFor(t);
  git(court.seed, 'branch', '-m', 'main', 'trunk');
  git(court.seed, 'push', 'origin', 'trunk');
  git(court.origin, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
  git(court.checkout, 'fetch', 'origin');
  git(court.checkout, 'checkout', '-b', 'trunk', 'origin/trunk');
  writeFileSync(path.join(court.seed, 'added.txt'), 'added\n');
  git(court.seed, 'add', '-A');
  git(court.seed, 'commit', '-m', 'Land on trunk');
  git(court.seed, 'push', 'origin', 'trunk');
  const { code } = await runUpdate(court);
  assert.equal(code, 0);
  assert.equal(git(court.checkout, 'rev-parse', 'HEAD'), git(court.seed, 'rev-parse', 'HEAD'));
});

test('a dirty tree stops the update and nothing changes', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'src/new.ts': 'export const added = 1;\n' });
  writeFileSync(path.join(court.checkout, 'package.json'), '{ "name": "court", "edited": true }\n');
  const before = snapshotCheckout(court);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 1);
  assert.match(output, /^update-throne: REFUSING — the working tree has uncommitted changes; commit or stash them and run again$/m);
  assert.deepEqual(snapshotCheckout(court), before);
  assert.deepEqual(callsTo(court, 'npm'), []);
});

test('a diverged branch stops the update and nothing changes', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'src/new.ts': 'export const added = 1;\n' });
  writeFileSync(path.join(court.checkout, 'local.txt'), 'local\n');
  git(court.checkout, 'add', '-A');
  git(court.checkout, 'commit', '-m', 'A local commit');
  const before = snapshotCheckout(court);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 1);
  assert.match(output, /^update-throne: REFUSING — main has diverged from origin; reconcile it by hand and run again$/m);
  assert.deepEqual(snapshotCheckout(court), before);
});

test('another branch stops the update and nothing changes', async (t) => {
  const court = courtFor(t);
  git(court.checkout, 'checkout', '-b', 'side-work');
  const before = snapshotCheckout(court);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 1);
  assert.match(output, /^update-throne: REFUSING — the checkout is on side-work, not main; switch to main and run again$/m);
  assert.deepEqual(snapshotCheckout(court), before);
});

test('a linked worktree stops the update and nothing changes', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'src/new.ts': 'export const added = 1;\n' });
  const linked = path.join(court.directory, 'linked');
  git(court.checkout, 'worktree', 'add', '--detach', linked);
  const main = court.checkout;
  court.checkout = linked;
  const before = snapshotCheckout({ ...court, checkout: main });
  const { code, output } = await runUpdate(court);
  court.checkout = main;
  assert.equal(code, 1);
  assert.match(output, /^update-throne: REFUSING — this is a linked worktree; run the update from the main checkout$/m);
  assert.equal(git(linked, 'rev-parse', 'HEAD'), before.head);
  assert.deepEqual(snapshotCheckout(court), before);
});

test('a fork with a no changes nothing', async (t) => {
  const court = courtFor(t, { withUpstream: true });
  land(court, 'upstream', { 'src/new.ts': 'export const added = 1;\n' });
  const before = snapshotCheckout(court);
  const check = await runUpdate(court, ['--check']);
  assert.match(check.output, /^update-throne: question: bring 1 new commit\(s\) from upstream main into this fork\? /m);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0);
  assert.match(output, /^update-throne: fork left alone: 1 new commit\(s\) from upstream were not brought in, and nothing changed$/m);
  assert.deepEqual(snapshotCheckout(court), before);
  assert.deepEqual(restartCalls(court), []);
});

test('a fork with no answer changes nothing', async (t) => {
  const court = courtFor(t, { withUpstream: true });
  land(court, 'upstream', { 'src/new.ts': 'export const added = 1;\n' });
  const before = snapshotCheckout(court);
  const { code } = await runUpdate(court);
  assert.equal(code, 0);
  assert.deepEqual(snapshotCheckout(court), before);
  assert.deepEqual(callsTo(court, 'npm'), []);
  assert.deepEqual(callsTo(court, 'update-harness.mjs'), []);
  assert.deepEqual(callsTo(court, 'herdr-upgrade.mjs'), []);
});

test("a fork with a yes merges upstream's default branch and pushes nothing", async (t) => {
  const court = courtFor(t, { withUpstream: true });
  const latest = land(court, 'upstream', { 'src/new.ts': 'export const added = 1;\n' });
  writeFileSync(path.join(court.checkout, 'fork-only.txt'), 'ours\n');
  git(court.checkout, 'add', '-A');
  git(court.checkout, 'commit', '-m', 'A commit only the fork has');
  git(court.checkout, 'config', 'core.hooksPath', path.resolve(import.meta.dirname, 'git-hooks'));
  const originBefore = git(court.origin, 'rev-parse', 'main');
  const { code, output } = await runUpdate(court, ['--bring-in-upstream']);
  assert.equal(code, 0);
  assert.equal(git(court.checkout, 'merge-base', '--is-ancestor', latest, 'HEAD'), '');
  assert.equal(git(court.checkout, 'rev-list', '--merges', '--count', 'HEAD'), '1');
  assert.equal(git(court.origin, 'rev-parse', 'main'), originBefore);
  assert.match(output, /^update-throne: report: merged upstream locally, nothing was pushed$/m);
});

test('dependencies install only when the lockfile changed', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'src/new.ts': 'export const added = 1;\n' });
  await runUpdate(court);
  assert.deepEqual(callsTo(court, 'npm ci'), []);
  assert.deepEqual(callsTo(court, 'npm run build'), ['npm run build']);
  land(court, 'origin', { 'package-lock.json': '{ "lockfileVersion": 3, "moved": true }\n' });
  await runUpdate(court);
  assert.deepEqual(callsTo(court, 'npm ci'), ['npm ci --no-audit --no-fund']);
  await runUpdate(court);
  assert.equal(callsTo(court, 'npm ci').length, 1);
});

test('the pinned node installs before the dependencies when its pin moved', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'mise.toml': '[tools]\nnode = "24.1.0"\n', 'package-lock.json': '{ "lockfileVersion": 4 }\n' });
  await runUpdate(court);
  assert.deepEqual(callsTo(court, 'mise'), ['mise install node']);
  assert.ok(court.calls.indexOf('mise install node') < court.calls.indexOf('npm ci --no-audit --no-fund'));
});

test('a moved node pin runs the install, the build and both updaters on the new node', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'mise.toml': '[tools]\nnode = "24.1.0"\n', 'package-lock.json': '{ "lockfileVersion": 4 }\n', 'src/changed.ts': 'export {};\n' });
  await runUpdate(court);
  const newNode = path.join(court.home, '.local', 'share', 'mise', 'installs', 'node', '24.1.0', 'bin');
  for (const step of ['npm ci', 'npm run build', 'update-harness.mjs pinned --harness claude', 'herdr-upgrade.mjs --pinned']) {
    const firstOnPath = court.pathOfCall.get(callsTo(court, step)[0]!)?.split(path.delimiter)[0];
    assert.equal(firstOnPath, newNode, step);
  }
});

test('no version change means no restart', async (t) => {
  const court = courtFor(t);
  const before = snapshotCheckout(court);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0);
  assert.deepEqual(restartCalls(court), []);
  assert.deepEqual(callsTo(court, 'npm'), []);
  assert.deepEqual(callsTo(court, 'herdr-upgrade.mjs'), ['herdr-upgrade.mjs --pinned']);
  assert.equal(printedLine(output, 'report: restarted'), undefined);
  assert.deepEqual(snapshotCheckout(court), before);
});

test('a harness that moved without the word leaves the agents running and says so', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', pinsMoving({ claude: '2.1.0' }));
  const check = await runUpdate(court, ['--check']);
  assert.match(check.output, /^update-throne: question: restart every agent onto the pinned harness/m);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0);
  assert.deepEqual(callsTo(court, 'throne '), []);
  assert.match(output, /^update-throne: report: not restarted agents — a harness moved and no restart word was given, so they still run the old binary$/m);
});

test('a harness that moved with the word restarts the agents', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', pinsMoving({ codex: '0.51.0' }));
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 0);
  assert.deepEqual(callsTo(court, AGENT_RESTART_CALL), [AGENT_RESTART_CALL]);
  assert.match(output, /^update-throne: report: restarting every agent, by throne restart-harnesses --force, which runs next$/m);
  assert.match(output, /^update-throne: report: restarted every agent$/m);
  assert.deepEqual(callsTo(court, 'herdr-upgrade.mjs'), ['herdr-upgrade.mjs --pinned --yes --restart-ordered-by-lord restart them all']);
});

test("the agents restarted are this checkout's own, whichever throne is first on PATH", async (t) => {
  const court = courtFor(t);
  land(court, 'origin', pinsMoving({ codex: '0.51.0' }));
  await runUpdate(court, THE_WORD);
  const ownCommand = path.join(court.checkout, 'bin', 'throne-cli');
  assert.deepEqual(court.restartCommands, [ownCommand]);
});

test('agents a harness move left running restart on a later run that has the word', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', pinsMoving({ claude: '2.1.0' }));
  await runUpdate(court);
  const { output } = await runUpdate(court, ['--check']);
  assert.match(output, /^update-throne: question: restart every agent onto the pinned harness/m);
  await runUpdate(court, THE_WORD);
  assert.deepEqual(callsTo(court, AGENT_RESTART_CALL), [AGENT_RESTART_CALL]);
  await runUpdate(court, THE_WORD);
  assert.equal(callsTo(court, AGENT_RESTART_CALL).length, 1);
});

test('herdr moving without the word stops before the pull', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', herdrPinMovingTo('0.9.6'));
  const before = snapshotCheckout(court);
  const check = await runUpdate(court, ['--check']);
  assert.equal(check.code, 0);
  assert.match(check.output, /^update-throne: question: restart herdr to 0\.9\.6, which ends every agent and relaunches them\? /m);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 1);
  assert.match(output, /^update-throne: REFUSING — the update moves herdr from 0\.9\.5 to 0\.9\.6, /m);
  assert.deepEqual(snapshotCheckout(court), before);
  assert.deepEqual(callsTo(court, 'herdr-upgrade.mjs'), []);
  assert.deepEqual(callsTo(court, 'npm'), []);
});

test('herdr moving with the word hands herdr and the services that follow it to the herdr upgrade', async (t) => {
  const court = courtFor(t);
  const latest = land(court, 'origin', { ...herdrPinMovingTo('0.9.6'), ...pinsMoving({ claude: '2.1.0' }) });
  court.installServicesOutput = CHANGED_NTFY_UNIT;
  backendRuns(court, 'dist.build.0-0');
  const { code, output } = await runUpdate(court, THE_WORD);
  assert.equal(code, 0);
  assert.equal(git(court.checkout, 'rev-parse', 'HEAD'), latest);
  assert.deepEqual(restartCalls(court), ["bash -c 'systemctl' '--user' 'restart' 'ntfy.service'"]);
  assert.deepEqual(callsTo(court, 'herdr-upgrade.mjs'), ['herdr-upgrade.mjs --pinned --yes --restart-ordered-by-lord restart them all']);
  assert.match(output, /^update-throne: report: herdr 0\.9\.5 -> 0\.9\.6$/m);
  assert.match(output, /^update-throne: report: restarted ntfy\.service$/m);
});

test('the report names both commits, every version and what restarted', async (t) => {
  const court = courtFor(t);
  const oldCommit = git(court.checkout, 'rev-parse', 'HEAD');
  const latest = land(court, 'origin', pinsMoving({ claude: '2.1.0' }));
  backendRuns(court, 'dist.build.0-0');
  const { output } = await runUpdate(court, THE_WORD);
  const report = output.split('\n').filter((line) => line.startsWith('update-throne: report: '));
  assert.deepEqual(report, [
    `update-throne: report: throne ${oldCommit.slice(0, 12)} -> ${latest.slice(0, 12)}`,
    'update-throne: report: claude 2.0.0 -> 2.1.0',
    'update-throne: report: codex 0.50.0 unchanged',
    'update-throne: report: herdr 0.9.5 unchanged',
    'update-throne: report: restarted throne-backend',
    'update-throne: report: restarting every agent, by throne restart-harnesses --force, which runs next',
    'update-throne: report: restarted every agent',
  ]);
  assert.match(readLog(court), /^===== update-throne run \d{4}-\d{2}-\d{2}T.* =====$/m);
});

test("the report is written before the step that can end the run's own pane", async (t) => {
  const court = courtFor(t);
  land(court, 'origin', pinsMoving({ claude: '2.1.0' }));
  const logsAtEachStep: string[] = [];
  const recordLog = () => logsAtEachStep.push(readLog(court));
  court.onCall.set(AGENT_RESTART_CALL, recordLog);
  court.onCall.set('herdr-upgrade.mjs', recordLog);
  await runUpdate(court, THE_WORD);
  assert.equal(logsAtEachStep.length, 2);
  for (const log of logsAtEachStep) assert.match(log, /^update-throne: report: claude 2\.0\.0 -> 2\.1\.0$/m);
});

test('a second run after a failed build finishes the update', async (t) => {
  const court = courtFor(t);
  const latest = land(court, 'origin', { ...pinsMoving({ claude: '2.1.0' }), 'src/new.ts': 'export const added = 1;\n' });
  failOnce(court, 'npm run build');
  const first = await runUpdate(court);
  assert.equal(first.code, 1);
  assert.match(first.output, /^update-throne: FAILED: npm run build exited 1/m);
  assert.deepEqual(callsTo(court, 'update-harness.mjs'), []);
  const second = await runUpdate(court);
  assert.equal(second.code, 0);
  assert.equal(git(court.checkout, 'rev-parse', 'HEAD'), latest);
  assert.equal(callsTo(court, 'npm run build').length, 2);
  assert.equal(court.running.claude, '2.1.0');
  assert.match(second.output, /^update-throne: report: claude 2\.0\.0 -> 2\.1\.0$/m);
});

test('two runs at once: one refuses and dependencies install once', async (t) => {
  const court = courtFor(t);
  land(court, 'origin', { 'package-lock.json': '{ "lockfileVersion": 3, "changed": true }\n' });
  const [first, second] = await Promise.all([runUpdate(court), runUpdate(court)]);
  assert.deepEqual([first.code, second.code].sort(), [0, 1], first.output + second.output);
  assert.match(first.output + second.output, /^update-throne: REFUSING — another update-throne run is already running \(process \d+\)$/m);
  assert.equal(callsTo(court, 'npm ci').length, 1);
});

test('a run that ended leaves nothing that stops the next one', async (t) => {
  const court = courtFor(t);
  assert.equal((await runUpdate(court)).code, 0);
  assert.equal((await runUpdate(court)).code, 0);
});

test('a check runs beside a run', async (t) => {
  const court = courtFor(t);
  const [run, check] = await Promise.all([runUpdate(court), runUpdate(court, ['--check'])]);
  assert.equal(run.code, 0, run.output);
  assert.equal(check.code, 0, check.output);
});

test('a bad argument exits 2 and touches nothing', async (t) => {
  const court = courtFor(t);
  assert.equal((await runUpdate(court, ['--force'])).code, 2);
  assert.equal((await runUpdate(court, ['--restart-ordered-by-lord'])).code, 2);
  assert.deepEqual(court.calls, []);
});

