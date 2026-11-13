import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  AGENT_RESTART_CALL,
  THE_WORD,
  type Court,
  callsTo,
  commitInCheckout,
  courtFor,
  git,
  herdrPinMovingTo,
  land,
  pinsMoving,
  restartCalls,
  runGitBehindShimWithNoIdentity,
  runUpdate,
  snapshotCheckout,
} from './update-throne-fixture.ts';
import { readPendingRestarts } from './update-throne-restarts.mjs';

const BRING_IN_UPSTREAM = '--bring-in-upstream';
const UPSTREAM_SOURCE_CHANGE = { 'src/new.ts': 'export const added = 1;\n' };
const SERVED_FILE_CHANGE = { 'systemd/ntfy-serve': '#!/bin/sh\nexec ntfy serve\n' };
const FORK_NAME = { 'package.json': '{ "name": "fork court" }\n' };
const UPSTREAM_NAME = { 'package.json': '{ "name": "upstream court" }\n' };
const ABANDONED_WORDS = "merging upstream's changes stopped, the merge was abandoned and the tree is as it was";

function forkWithItsOwnCommit(t: TestContext, files: Record<string, string>): Court {
  const court = courtFor(t, { withUpstream: true });
  commitInCheckout(court, files);
  return court;
}

function forkThatWillConflict(t: TestContext): Court {
  const court = forkWithItsOwnCommit(t, FORK_NAME);
  land(court, 'upstream', { ...UPSTREAM_NAME, ...SERVED_FILE_CHANGE, ...pinsMoving({ claude: '2.1.0', ntfyImage: 'example.test/ntfy:v2' }) });
  return court;
}

function refuseEveryMergeCommit(court: Court): void {
  const hooks = path.join(court.directory, 'hooks');
  mkdirSync(hooks);
  writeFileSync(path.join(hooks, 'pre-merge-commit'), '#!/bin/sh\necho the hook said no >&2\nexit 1\n', { mode: 0o755 });
  git(court.checkout, 'config', 'core.hooksPath', hooks);
}

function reportOf(output: string): string[] {
  return output.split('\n').filter((line) => line.startsWith('update-throne: report: '));
}

test("a fork's plan reads its pins from the tree the merge will make", async (t) => {
  const court = forkWithItsOwnCommit(t, {
    ...pinsMoving({ codex: '0.51.0' }),
    ...herdrPinMovingTo('0.9.6'),
    'bun.lock': '{ "lockfileVersion": 3, "fork": true }\n',
  });
  land(court, 'upstream', pinsMoving({ claude: '2.1.0' }));
  const { code, output } = await runUpdate(court, ['--check']);
  assert.equal(code, 0);
  assert.match(output, /^update-throne: plan: claude pinned 2\.1\.0, installed 2\.0\.0$/m);
  assert.match(output, /^update-throne: plan: codex pinned 0\.51\.0, installed 0\.50\.0$/m);
  assert.match(output, /^update-throne: plan: herdr pinned 0\.9\.6, running service 0\.9\.5$/m);
  assert.match(output, /^update-throne: plan: lockfile differs from the last install$/m);
});

test('a fork that keeps its own herdr pin is not told herdr moves', async (t) => {
  const court = forkWithItsOwnCommit(t, herdrPinMovingTo('0.9.6'));
  court.running.herdr = '0.9.6';
  land(court, 'upstream', UPSTREAM_SOURCE_CHANGE);
  const check = await runUpdate(court, ['--check']);
  assert.doesNotMatch(check.output, /question: restart herdr/);
  const { code, output } = await runUpdate(court, [BRING_IN_UPSTREAM]);
  assert.equal(code, 0);
  assert.doesNotMatch(output, /REFUSING/);
  assert.match(output, /^update-throne: report: herdr 0\.9\.6 unchanged$/m);
  assert.equal(git(court.checkout, 'rev-list', '--merges', '--count', 'HEAD'), '1');
});

test("a herdr move in a fork's merged tree refuses before the merge when there is no word", async (t) => {
  const court = forkWithItsOwnCommit(t, herdrPinMovingTo('0.9.6'));
  land(court, 'upstream', UPSTREAM_SOURCE_CHANGE);
  const before = snapshotCheckout(court);
  const { code, output } = await runUpdate(court, [BRING_IN_UPSTREAM]);
  assert.equal(code, 1);
  assert.match(output, /^update-throne: REFUSING — the update moves herdr from 0\.9\.5 to 0\.9\.6, /m);
  assert.deepEqual(snapshotCheckout(court), before);
  assert.deepEqual(callsTo(court, 'bun'), []);
  assert.deepEqual(callsTo(court, 'herdr-upgrade.mjs'), []);
});

test('a merge that will conflict refuses before anything changes', async (t) => {
  const court = forkThatWillConflict(t);
  const before = snapshotCheckout(court);
  const check = await runUpdate(court, ['--check']);
  assert.equal(check.code, 0);
  assert.match(check.output, /^update-throne: question: bring 1 new commit\(s\) from upstream main into this fork\? /m);
  assert.match(check.output, new RegExp(`^update-throne: a run would refuse: ${ABANDONED_WORDS}: .*package\\.json`, 'm'));
  assert.match(check.output, /^update-throne: plan: claude pinned 2\.0\.0, installed 2\.0\.0$/m);
  assert.doesNotMatch(check.output, /question: restart every agent/);
  const noAnswer = await runUpdate(court);
  assert.equal(noAnswer.code, 0);
  assert.match(noAnswer.output, /^update-throne: fork left alone: 1 new commit\(s\) from upstream were not brought in, and nothing changed$/m);
  const { code, output } = await runUpdate(court, [BRING_IN_UPSTREAM, ...THE_WORD]);
  assert.equal(code, 1);
  assert.match(output, new RegExp(`^update-throne: REFUSING — ${ABANDONED_WORDS}: .*package\\.json`, 'm'));
  assert.deepEqual(snapshotCheckout(court), before);
  assert.deepEqual(callsTo(court, 'bun'), []);
  assert.deepEqual(restartCalls(court), []);
});

test('a merge git cannot plan fails with its message and changes nothing', async (t) => {
  const court = forkWithItsOwnCommit(t, FORK_NAME);
  git(court.seed, 'checkout', '--orphan', 'unrelated');
  git(court.seed, 'commit', '-m', 'Start again');
  git(court.seed, 'push', '--force', 'upstream', 'unrelated:main');
  const before = snapshotCheckout(court);
  const { code, output } = await runUpdate(court, [BRING_IN_UPSTREAM]);
  assert.equal(code, 1);
  assert.match(output, /^update-throne: checkout: fork \(it has a remote named upstream\)$/m);
  assert.match(output, /^update-throne: FAILED: git merge-tree .*unrelated histories/m);
  assert.deepEqual(snapshotCheckout(court), before);
});

test('a merge that will conflict leaves nothing owed', async (t) => {
  const court = forkThatWillConflict(t);
  await runUpdate(court, [BRING_IN_UPSTREAM]);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test("a fork's report matches the merged tree", async (t) => {
  const court = forkWithItsOwnCommit(t, { ...herdrPinMovingTo('0.9.6'), ...pinsMoving({ codex: '0.51.0' }) });
  court.running.herdr = '0.9.6';
  court.running.codex = '0.51.0';
  const oldCommit = git(court.checkout, 'rev-parse', 'HEAD');
  land(court, 'upstream', pinsMoving({ claude: '2.1.0' }));
  const { code, output } = await runUpdate(court, [BRING_IN_UPSTREAM, ...THE_WORD]);
  assert.equal(code, 0);
  const merged = git(court.checkout, 'rev-parse', 'HEAD');
  assert.deepEqual(reportOf(output), [
    `update-throne: report: throne ${oldCommit.slice(0, 12)} -> ${merged.slice(0, 12)}`,
    'update-throne: report: claude 2.0.0 -> 2.1.0',
    'update-throne: report: codex 0.51.0 unchanged',
    'update-throne: report: herdr 0.9.6 unchanged',
    'update-throne: report: merged upstream locally, nothing was pushed',
    'update-throne: report: restarted throne-backend',
    'update-throne: report: restarting every agent, by throne restart-harnesses --force, which runs next',
    'update-throne: report: restarted every agent',
  ]);
  assert.deepEqual(callsTo(court, AGENT_RESTART_CALL), [AGENT_RESTART_CALL]);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a served file only the fork already has owes no restart', async (t) => {
  const court = forkWithItsOwnCommit(t, SERVED_FILE_CHANGE);
  land(court, 'upstream', UPSTREAM_SOURCE_CHANGE);
  await runUpdate(court, [BRING_IN_UPSTREAM]);
  assert.deepEqual(restartCalls(court).filter((call) => call.includes('ntfy')), []);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});

test('a merge that stops after a clean plan is abandoned and leaves nothing owed', async (t) => {
  const court = forkWithItsOwnCommit(t, FORK_NAME);
  land(court, 'upstream', SERVED_FILE_CHANGE);
  refuseEveryMergeCommit(court);
  const before = snapshotCheckout(court);
  const { code, output } = await runUpdate(court, [BRING_IN_UPSTREAM]);
  assert.equal(code, 1);
  assert.match(output, new RegExp(`^update-throne: FAILED: ${ABANDONED_WORDS}: `, 'm'));
  assert.deepEqual(snapshotCheckout(court), before);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
  assert.deepEqual(callsTo(court, 'bun'), []);
});

test('a fast-forward pulls on an install with no git identity', async (t) => {
  const court = courtFor(t);
  const latest = land(court, 'origin', UPSTREAM_SOURCE_CHANGE);
  runGitBehindShimWithNoIdentity(court);
  const { code, output } = await runUpdate(court);
  assert.equal(code, 0, output);
  assert.equal(git(court.checkout, 'rev-parse', 'HEAD'), latest);
});

test('a fork that is only behind fast-forwards with no merge commit', async (t) => {
  const court = courtFor(t, { withUpstream: true });
  git(court.checkout, 'config', 'merge.ff', 'false');
  const latest = land(court, 'upstream', UPSTREAM_SOURCE_CHANGE);
  const { code, output } = await runUpdate(court, [BRING_IN_UPSTREAM]);
  assert.equal(code, 0, output);
  assert.equal(git(court.checkout, 'rev-parse', 'HEAD'), latest);
  assert.equal(git(court.checkout, 'rev-list', '--merges', '--count', 'HEAD'), '0');
  assert.doesNotMatch(output, /merged upstream/);
});

test('a fork that is only behind pulls on an install with no git identity', async (t) => {
  const court = courtFor(t, { withUpstream: true });
  const latest = land(court, 'upstream', UPSTREAM_SOURCE_CHANGE);
  runGitBehindShimWithNoIdentity(court);
  const { code, output } = await runUpdate(court, [BRING_IN_UPSTREAM]);
  assert.equal(code, 0, output);
  assert.equal(git(court.checkout, 'rev-parse', 'HEAD'), latest);
});

test('a merge that makes a commit still needs a git identity', async (t) => {
  const court = forkWithItsOwnCommit(t, FORK_NAME);
  land(court, 'upstream', SERVED_FILE_CHANGE);
  runGitBehindShimWithNoIdentity(court);
  const before = snapshotCheckout(court);
  const { code, output } = await runUpdate(court, [BRING_IN_UPSTREAM]);
  assert.equal(code, 1);
  assert.match(output, /STOP RIGHT THERE/);
  assert.deepEqual(snapshotCheckout(court), before);
  assert.deepEqual(readPendingRestarts(court.checkout), []);
});
