import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { run as writePushWaiver } from '../src/push-waiver/push-waiver-runtime.ts';
import {
  addCheck,
  gitOrThrow,
  guardedGit,
  REFUSED_SKIP_EXIT_CODE,
  remoteHas,
  removeSandboxes,
  sandbox,
  SYSTEM_PATH,
  writeGuardCopy,
  type Outcome,
  type Sandbox,
} from './push-check-sandbox.fixture.ts';

const PUSHING_AGENT = 'shadow-recipes-01';
const OTHER_AGENT = 'shadow-recipes-02';
const WAIVED_UNDER = /push checks skipped under waiver (\S+\.used\.json)/;

interface Court {
  readonly box: Sandbox;
  readonly dataHome: string;
  readonly checkout: string;
  readonly otherCheckout: string;
}

let court: Court;

async function addCourtCheckout(box: Sandbox, dataHome: string, agent: string, branch: string): Promise<string> {
  const checkout = path.join(dataHome, 'worktrees', 'recipes', agent);
  await mkdir(path.dirname(checkout), { recursive: true });
  await gitOrThrow(box.work, box.environment, ['worktree', 'add', '--quiet', '-b', branch, checkout]);
  const ledger = path.join(dataHome, 'data', agent);
  await mkdir(ledger, { recursive: true });
  await writeFile(path.join(ledger, 'identity.md'), `# Identity — ${agent}\n\n- **Role:** Shadow\n`);
  return checkout;
}

before(async () => {
  const box = await sandbox();
  const dataHome = path.join(await realpath(box.root), 'court-home');
  await addCheck(box, 'refuses', 3);
  const checkout = await addCourtCheckout(box, dataHome, PUSHING_AGENT, 'recipe-search');
  const otherCheckout = await addCourtCheckout(box, dataHome, OTHER_AGENT, 'recipe-ratings');
  court = { box, dataHome, checkout, otherCheckout };
});

after(removeSandboxes);

async function startBranch(branch: string): Promise<string> {
  return commitOnBranch(branch, 'HEAD', branch);
}

async function commitOnBranch(branch: string, parent: string, message: string): Promise<string> {
  const commit = await gitOrThrow(court.checkout, court.box.environment, ['commit-tree', `${parent}^{tree}`, '-p', parent, '-m', message]);
  await gitOrThrow(court.checkout, court.box.environment, ['update-ref', `refs/heads/${branch}`, commit]);
  return commit;
}

async function waive(branch: string): Promise<string> {
  const inputs = await mkdtemp(path.join(court.dataHome, 'waiver-input-'));
  const findingsFile = path.join(inputs, 'findings.txt');
  const entriesFile = path.join(inputs, 'entries.json');
  await writeFile(findingsFile, 'high file.txt:1 The recipe list is never sorted\n');
  await writeFile(entriesFile, JSON.stringify([{ finding: 1, reason: 'finding-wrong', location: 'file.txt:1' }]));
  const errors: string[] = [];
  const code = await writePushWaiver(
    ['--repo', court.checkout, '--remote', 'origin', '--ref', branch, '--findings-file', findingsFile, '--entries-file', entriesFile],
    { dataHome: court.dataHome, now: () => new Date(), out: () => undefined, err: (message) => void errors.push(message) },
  );
  assert.equal(code, 0, errors.join(''));
  const commit = await gitOrThrow(court.checkout, court.box.environment, ['rev-parse', `refs/heads/${branch}`]);
  return path.join(court.dataHome, 'data', PUSHING_AGENT, 'push-waivers', 'origin', branch, `${commit}.json`);
}

function courtPush(args: string[], cwd = court.checkout, extra: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  return guardedGit(court.box, args, cwd, { THRONE_AGENT_PANE: '1', THRONE_DATA_HOME: court.dataHome, ...extra });
}

async function waiverFilesFor(branch: string): Promise<string[]> {
  return (await readdir(path.join(court.dataHome, 'data', PUSHING_AGENT, 'push-waivers', 'origin', branch))).sort();
}

function assertRefusedNamingPushWaiver(outcome: Outcome): void {
  assert.equal(outcome.code, REFUSED_SKIP_EXIT_CODE, outcome.stderr);
  assert.match(outcome.stderr, /throne push-waiver/);
}

test("a court session's skipped push goes through once under its own waiver for that commit and ref", async () => {
  const commit = await startBranch('waived-once');
  const waiver = await waive('waived-once');

  const outcome = await courtPush(['push', '--no-verify', 'origin', 'waived-once']);

  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.stderr.match(WAIVED_UNDER)?.[1], waiver.replace(/\.json$/, '.used.json'));
  assert.equal(await remoteHas(court.box, 'refs/heads/waived-once'), true);
  assert.deepEqual(await waiverFilesFor('waived-once'), [`${commit}.used.json`]);
});

test('a waiver also admits the same push skipped with PUSH_CHECK_SKIP=1', async () => {
  await startBranch('waived-by-variable');
  await waive('waived-by-variable');

  const outcome = await courtPush(['push', 'origin', 'waived-by-variable'], court.checkout, { PUSH_CHECK_SKIP: '1' });

  assert.equal(outcome.code, 0, outcome.stderr);
  assert.match(outcome.stderr, WAIVED_UNDER);
  assert.equal(await remoteHas(court.box, 'refs/heads/waived-by-variable'), true);
});

test('a spent waiver does not let the same push skip the checks again', async () => {
  await startBranch('waived-replay');
  await waive('waived-replay');
  assert.equal((await courtPush(['push', '--no-verify', 'origin', 'waived-replay'])).code, 0);
  await gitOrThrow(court.box.root, court.box.environment, ['--git-dir', court.box.remote, 'update-ref', '-d', 'refs/heads/waived-replay']);

  const replay = await courtPush(['push', '--no-verify', 'origin', 'waived-replay']);

  assertRefusedNamingPushWaiver(replay);
  assert.equal(await remoteHas(court.box, 'refs/heads/waived-replay'), false);
});

test('a waiver does not cover a different commit on the same branch', async () => {
  await startBranch('waived-then-moved');
  const waiver = await waive('waived-then-moved');
  await commitOnBranch('waived-then-moved', 'waived-then-moved', 'a later commit');

  const outcome = await courtPush(['push', '--no-verify', 'origin', 'waived-then-moved']);

  assertRefusedNamingPushWaiver(outcome);
  assert.deepEqual(await waiverFilesFor('waived-then-moved'), [path.basename(waiver)]);
});

test('a waiver does not cover a push to a different branch', async () => {
  await startBranch('waived-branch');
  await waive('waived-branch');
  await gitOrThrow(court.checkout, court.box.environment, ['branch', 'unwaived-branch', 'waived-branch']);

  for (const args of [
    ['push', '--no-verify', 'origin', 'unwaived-branch'],
    ['push', '--no-verify', 'origin', 'waived-branch:unwaived-branch'],
    ['push', '--no-verify', 'origin', 'waived-branch', 'unwaived-branch'],
  ]) {
    const outcome = await courtPush(args);
    assertRefusedNamingPushWaiver(outcome);
  }
  assert.equal(await remoteHas(court.box, 'refs/heads/unwaived-branch'), false);
});

test("another agent's waiver does not let this agent skip the checks", async () => {
  await startBranch('waived-for-another');
  const waiver = await waive('waived-for-another');
  const copied = waiver.replace(`${path.sep}${PUSHING_AGENT}${path.sep}`, `${path.sep}${OTHER_AGENT}${path.sep}`);
  await mkdir(path.dirname(copied), { recursive: true });
  await copyFile(waiver, copied);

  const outcome = await courtPush(['push', '--no-verify', 'origin', 'waived-for-another'], court.otherCheckout);

  assertRefusedNamingPushWaiver(outcome);
  assert.equal(await remoteHas(court.box, 'refs/heads/waived-for-another'), false);
});

test("a checkout outside the court's worktrees cannot spend the waiver of the agent it is named after", async () => {
  await startBranch('waived-outside');
  const waiver = await waive('waived-outside');
  const outside = path.join(court.box.root, 'elsewhere', PUSHING_AGENT);
  await mkdir(path.dirname(outside), { recursive: true });
  await gitOrThrow(court.box.work, court.box.environment, ['worktree', 'add', '--quiet', '--detach', outside]);

  const outcome = await courtPush(['push', '--no-verify', 'origin', 'waived-outside'], outside);

  assertRefusedNamingPushWaiver(outcome);
  assert.deepEqual(await waiverFilesFor('waived-outside'), [path.basename(waiver)]);
});

test("a court session's skipped push with no waiver is refused and names push-waiver", async () => {
  await startBranch('never-waived');

  const outcome = await courtPush(['push', '--no-verify', 'origin', 'never-waived']);

  assertRefusedNamingPushWaiver(outcome);
  assert.match(outcome.stderr, /a court session may not skip the push checks/);
  assert.equal(await remoteHas(court.box, 'refs/heads/never-waived'), false);
});

test('a second copy of the guard further down PATH lets through a push the first copy admitted under a waiver', async () => {
  await startBranch('waived-stacked');
  await waive('waived-stacked');
  const secondGuardDirectory = path.join(court.box.root, 'second-guard-bin');
  await writeGuardCopy(secondGuardDirectory);

  const outcome = await courtPush(['push', '--no-verify', 'origin', 'waived-stacked'], court.checkout, {
    PATH: `${court.box.guardDirectory}:${secondGuardDirectory}:${SYSTEM_PATH}`,
  });

  assert.equal(outcome.code, 0, outcome.stderr);
  assert.match(outcome.stderr, WAIVED_UNDER);
  assert.equal(await remoteHas(court.box, 'refs/heads/waived-stacked'), true);
});
