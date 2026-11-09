import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { acquireTransactionLock } from './transaction-lock.mjs';
import { runPinned, runRollback, runUpdate } from './update-harness.mjs';
import {
  addOrigin,
  fakeNpmDir,
  fakeThroneDir,
  git,
  makeThroneRoot,
  npmCallLog,
  refusePushesTo,
  writeExecutable,
  writeJson,
  writeVendoredClaude,
} from './update-harness-fixtures.mjs';

const SCRIPTS_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(SCRIPTS_DIRECTORY, 'update-harness.mjs');
const REGISTRY = 'https://registry.npmjs.org';
const OLD_VERSION = '2.1.226';
const NEW_VERSION = '2.1.267';
const NEWER_VERSION = '2.1.268';

function makeUpdateRun(prefix, { pinnedVersion = OLD_VERSION, latestVersion = NEW_VERSION, yolo = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  const throneRoot = makeThroneRoot(root, { pinnedVersion });
  writeVendoredClaude(throneRoot, `${pinnedVersion} (Claude Code)`);
  const origin = addOrigin(root, throneRoot, { yolo });
  const managedRoot = path.join(root, 'managed');
  mkdirSync(managedRoot, { recursive: true });
  const searchPath = `${fakeNpmDir(root, { latestVersion })}:${fakeThroneDir(root)}:${process.env.PATH}`;
  return { root, throneRoot, origin, managedRoot, searchPath, evidencePath: path.join(root, 'evidence.json') };
}

function withSearchPath(searchPath, action) {
  const originalPath = process.env.PATH;
  process.env.PATH = searchPath;
  try {
    return action();
  } finally {
    process.env.PATH = originalPath;
  }
}

function updateHarness({ throneRoot, managedRoot, evidencePath, searchPath }) {
  return withSearchPath(searchPath, () => runUpdate({ harness: 'claude', throneRoot, managedRoot, registry: REGISTRY, evidencePath }));
}

function runScript(action, { throneRoot, managedRoot, evidencePath, searchPath }, script = SCRIPT) {
  return spawnSync(process.execPath, [
    script,
    action,
    '--harness',
    'claude',
    '--throne-root',
    throneRoot,
    '--managed-root',
    managedRoot,
    '--evidence',
    evidencePath,
  ], { encoding: 'utf8', env: { ...process.env, PATH: searchPath } });
}

function commitCount(repository) {
  return Number(git(repository, ['rev-list', '--count', 'HEAD']).trim());
}

function filesInLatestCommit(repository) {
  return git(repository, ['show', '--format=', '--name-only', 'HEAD']).trim().split('\n');
}

function latestSubject(repository) {
  return git(repository, ['log', '-1', '--format=%s']).trim();
}

function originHead(origin) {
  return execFileSync('git', ['--git-dir', origin, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
}

function localHead(repository) {
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

test('a harness update lands its pin as one commit holding only vendor-pins.json', () => {
  const run = makeUpdateRun('pin-one-commit');
  const evidence = updateHarness(run);
  assert.equal(commitCount(run.throneRoot), 2);
  assert.equal(latestSubject(run.throneRoot), `Pin claude to ${NEW_VERSION}`);
  assert.deepEqual(filesInLatestCommit(run.throneRoot), ['vendor-pins.json']);
  assert.match(evidence.diff, new RegExp(`\\+.*"version": "${NEW_VERSION}"`));
  assert.equal(evidence.pinCommit.committed, true);
  assert.deepEqual(JSON.parse(readFileSync(run.evidencePath, 'utf8')).pinCommit, evidence.pinCommit);
});

test('a pin commit leaves other work in the checkout alone', () => {
  const run = makeUpdateRun('pin-other-work');
  writeFileSync(path.join(run.throneRoot, 'staged-work.txt'), 'staged\n');
  git(run.throneRoot, ['add', 'staged-work.txt']);
  writeFileSync(path.join(run.throneRoot, 'bin', 'claudey'), '#!/usr/bin/env bash\nexec "${CLAUDE_BIN}" --version\n# edited\n');
  writeFileSync(path.join(run.throneRoot, 'untracked-work.txt'), 'untracked\n');
  updateHarness(run);
  assert.deepEqual(filesInLatestCommit(run.throneRoot), ['vendor-pins.json']);
  const status = git(run.throneRoot, ['status', '--porcelain']);
  assert.match(status, /^A {2}staged-work\.txt$/m);
  assert.match(status, /^ M bin\/claudey$/m);
  assert.match(status, /^\?\? untracked-work\.txt$/m);
  assert.doesNotMatch(status, /vendor-pins\.json/);
});

test('a pin is pushed when the repository is a yolo repository and only then', () => {
  const yoloRun = makeUpdateRun('pin-yolo');
  assert.equal(updateHarness(yoloRun).pinCommit.pushed, true);
  assert.equal(originHead(yoloRun.origin), localHead(yoloRun.throneRoot));

  const plainRun = makeUpdateRun('pin-not-yolo', { yolo: false });
  const originBefore = originHead(plainRun.origin);
  const { pinCommit } = updateHarness(plainRun);
  assert.equal(pinCommit.committed, true);
  assert.equal(pinCommit.pushed, false);
  assert.equal(originHead(plainRun.origin), originBefore);
});

test('a refused push keeps the commit and says so', () => {
  const run = makeUpdateRun('pin-refused-push');
  refusePushesTo(run.origin);
  const originBefore = originHead(run.origin);
  const result = runScript('update', run);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /FAILED: push to origin main was refused, the commit is kept/);
  assert.match(result.stderr, /fixture origin refuses this push/);
  assert.equal(latestSubject(run.throneRoot), `Pin claude to ${NEW_VERSION}`);
  assert.equal(originHead(run.origin), originBefore);
  const { pinCommit } = JSON.parse(readFileSync(run.evidencePath, 'utf8'));
  assert.equal(pinCommit.committed, true);
  assert.equal(pinCommit.pushed, false);
  assert.equal(pinCommit.pushRefused, true);
});

test('a pin commit whose push was refused is pushed by the next run', () => {
  const run = makeUpdateRun('pin-push-retried');
  refusePushesTo(run.origin);
  assert.equal(runScript('update', run).status, 1);
  const commitsAfterRefusal = commitCount(run.throneRoot);
  rmSync(path.join(run.origin, 'hooks', 'pre-receive'));
  const result = runScript('update', run);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(originHead(run.origin), localHead(run.throneRoot));
  assert.equal(commitCount(run.throneRoot), commitsAfterRefusal);
  const { pinCommit } = JSON.parse(readFileSync(run.evidencePath, 'utf8'));
  assert.equal(pinCommit.committed, false);
  assert.equal(pinCommit.pushed, true);
});

test('a pin commit refused again on the next run still fails loudly', () => {
  const run = makeUpdateRun('pin-push-refused-twice');
  refusePushesTo(run.origin);
  assert.equal(runScript('update', run).status, 1);
  const result = runScript('update', run);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAILED: push to origin main was refused, the commit is kept/);
});

test('an unpushed pin commit stays local when the repository is not a yolo repository', () => {
  const run = makeUpdateRun('pin-unpushed-not-yolo', { yolo: false });
  assert.equal(runScript('update', run).status, 0);
  const originBefore = originHead(run.origin);
  const result = runScript('update', run);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(originHead(run.origin), originBefore);
  assert.notEqual(originHead(run.origin), localHead(run.throneRoot));
});

test('an update of a harness already at the latest release changes nothing', () => {
  const run = makeUpdateRun('pin-already-current', { pinnedVersion: NEW_VERSION });
  const binary = path.join(run.throneRoot, 'vendor', 'node_modules', '.bin', 'claude');
  const binaryBefore = readFileSync(binary, 'utf8');
  const headBefore = localHead(run.throneRoot);
  const statusBefore = git(run.throneRoot, ['status', '--porcelain']);
  const evidence = updateHarness(run);
  assert.equal(localHead(run.throneRoot), headBefore);
  assert.equal(originHead(run.origin), headBefore);
  assert.equal(readFileSync(binary, 'utf8'), binaryBefore);
  assert.equal(existsSync(path.join(run.throneRoot, 'vendor', '.stamps', 'harnesses')), false);
  assert.deepEqual(evidence.probes, []);
  assert.equal(evidence.pinCommit.committed, false);
  assert.equal(git(run.throneRoot, ['status', '--porcelain']), statusBefore);
});

test('an update that stopped before its commit lands it on the next run', () => {
  const run = makeUpdateRun('pin-stopped-run');
  const indexLock = path.join(run.throneRoot, '.git', 'index.lock');
  writeFileSync(indexLock, '');
  assert.throws(() => updateHarness(run), /index\.lock/);
  assert.equal(commitCount(run.throneRoot), 1);
  rmSync(indexLock);

  const binary = path.join(run.throneRoot, 'vendor', 'node_modules', '.bin', 'claude');
  const binaryBefore = readFileSync(binary, 'utf8');
  const evidence = updateHarness(run);
  assert.equal(commitCount(run.throneRoot), 2);
  assert.equal(latestSubject(run.throneRoot), `Pin claude to ${NEW_VERSION}`);
  assert.equal(originHead(run.origin), localHead(run.throneRoot));
  assert.equal(readFileSync(binary, 'utf8'), binaryBefore);
  assert.deepEqual(evidence.probes, []);
});

function stopUpdateBeforeItsCommit(run) {
  const indexLock = path.join(run.throneRoot, '.git', 'index.lock');
  writeFileSync(indexLock, '');
  assert.throws(() => updateHarness(run), /index\.lock/);
  rmSync(indexLock);
}

function rollBackFromEvidence(run) {
  return withSearchPath(run.searchPath, () => runRollback({
    harness: 'claude',
    throneRoot: run.throneRoot,
    sourceEvidencePath: run.evidencePath,
    registry: REGISTRY,
    evidencePath: path.join(run.root, 'rollback-evidence.json'),
  }));
}

test('a run that finishes an interrupted update still records the version that was committed before it', () => {
  const run = makeUpdateRun('pin-old-version-same-latest');
  stopUpdateBeforeItsCommit(run);
  const evidence = updateHarness(run);
  assert.equal(evidence.oldVersion, OLD_VERSION);
  assert.equal(evidence.newVersion, NEW_VERSION);
  assert.equal(JSON.parse(readFileSync(run.evidencePath, 'utf8')).oldVersion, OLD_VERSION);
  assert.equal(rollBackFromEvidence(run).restoredVersion, OLD_VERSION);
  assert.equal(latestSubject(run.throneRoot), `Pin claude to ${OLD_VERSION}`);
});

test('a run that finishes an interrupted update after a newer release still records the version that was committed before it', () => {
  const run = makeUpdateRun('pin-old-version-newer-latest');
  stopUpdateBeforeItsCommit(run);
  fakeNpmDir(run.root, { latestVersion: NEWER_VERSION });
  const evidence = updateHarness(run);
  assert.equal(evidence.oldVersion, OLD_VERSION);
  assert.equal(evidence.newVersion, NEWER_VERSION);
  assert.equal(latestSubject(run.throneRoot), `Pin claude to ${NEWER_VERSION}`);
});

test('the update script does its work when it is called through a linked path', () => {
  const run = makeUpdateRun('script-through-link');
  const linkedScripts = path.join(run.root, 'linked-scripts');
  symlinkSync(SCRIPTS_DIRECTORY, linkedScripts);
  const result = runScript('check', run, path.join(linkedScripts, 'update-harness.mjs'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`evidence: ${run.evidencePath}`));
  assert.equal(existsSync(run.evidencePath), true);
});

test('the update script refuses a bad action when it is called through a linked path', () => {
  const run = makeUpdateRun('script-through-link-refuses');
  const linkedScripts = path.join(run.root, 'linked-scripts');
  symlinkSync(SCRIPTS_DIRECTORY, linkedScripts);
  const result = runScript('no-such-action', run, path.join(linkedScripts, 'update-harness.mjs'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: update-harness\.mjs/);
});

test('a rollback lands the restored pin the same way', () => {
  const run = makeUpdateRun('pin-rollback', { pinnedVersion: NEW_VERSION });
  const sourceEvidencePath = path.join(run.root, 'source-evidence.json');
  writeJson(sourceEvidencePath, { action: 'update', harness: 'claude', oldVersion: OLD_VERSION, newVersion: NEW_VERSION });
  const evidence = withSearchPath(run.searchPath, () => runRollback({
    harness: 'claude',
    throneRoot: run.throneRoot,
    sourceEvidencePath,
    registry: REGISTRY,
    evidencePath: run.evidencePath,
  }));
  assert.equal(latestSubject(run.throneRoot), `Pin claude to ${OLD_VERSION}`);
  assert.deepEqual(filesInLatestCommit(run.throneRoot), ['vendor-pins.json']);
  assert.equal(evidence.pinCommit.pushed, true);
  assert.equal(originHead(run.origin), localHead(run.throneRoot));
  assert.deepEqual(JSON.parse(readFileSync(run.evidencePath, 'utf8')).pinCommit, evidence.pinCommit);
});

test('a transaction lock left by a dead process does not stop the next run', () => {
  const run = makeUpdateRun('lock-dead-owner', { pinnedVersion: NEW_VERSION });
  const lockModule = pathToFileURL(path.join(SCRIPTS_DIRECTORY, 'transaction-lock.mjs')).href;
  const deadRun = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `const { acquireTransactionLock } = await import(${JSON.stringify(lockModule)}); acquireTransactionLock(${JSON.stringify(run.managedRoot)});`,
  ], { encoding: 'utf8' });
  assert.equal(deadRun.status, 0, deadRun.stderr);
  const result = runScript('check', run);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`taking over the transaction lock left by dead process ${deadRun.pid}`));
  assert.equal(existsSync(path.join(run.managedRoot, '.transaction-lock')), false);
});

test('a transaction lock with no owner file does not stop the next run', () => {
  const run = makeUpdateRun('lock-no-owner-file', { pinnedVersion: NEW_VERSION });
  mkdirSync(path.join(run.managedRoot, '.transaction-lock'));
  const result = runScript('check', run);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /taking over the transaction lock/);
  assert.equal(existsSync(path.join(run.managedRoot, '.transaction-lock')), false);
});

test('a transaction lock with an empty owner file does not stop the next run', () => {
  const run = makeUpdateRun('lock-empty-owner-file', { pinnedVersion: NEW_VERSION });
  mkdirSync(path.join(run.managedRoot, '.transaction-lock'));
  writeFileSync(path.join(run.managedRoot, '.transaction-lock', 'owner'), '');
  const result = runScript('check', run);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /taking over the transaction lock/);
  assert.equal(existsSync(path.join(run.managedRoot, '.transaction-lock')), false);
});

test('a transaction lock held by a running process still refuses', () => {
  const run = makeUpdateRun('lock-live-owner', { pinnedVersion: NEW_VERSION });
  const lock = acquireTransactionLock(run.managedRoot);
  const result = runScript('check', run);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`already running \\(process ${process.pid}\\)`));
  assert.equal(existsSync(lock), true);
});

const PINNED_VERSION = '2.1.250';

function makePinnedRun(prefix, { vendoredVersion = OLD_VERSION, npmOptions = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  const throneRoot = makeThroneRoot(root, { pinnedVersion: PINNED_VERSION });
  writeVendoredClaude(throneRoot, `${vendoredVersion} (Claude Code)`);
  const managedRoot = path.join(root, 'managed');
  mkdirSync(managedRoot, { recursive: true });
  const searchPath = `${fakeNpmDir(root, { latestVersion: NEW_VERSION, ...npmOptions })}:${process.env.PATH}`;
  return { root, throneRoot, managedRoot, searchPath, evidencePath: path.join(root, 'evidence.json') };
}

function goToPin({ throneRoot, managedRoot, evidencePath, searchPath }, harness = 'claude') {
  return withSearchPath(searchPath, () => runPinned({ harness, throneRoot, managedRoot, registry: REGISTRY, evidencePath }));
}

function vendoredClaudeReports({ throneRoot }) {
  return execFileSync(path.join(throneRoot, 'vendor', 'node_modules', '.bin', 'claude'), ['--version'], { encoding: 'utf8' }).trim();
}

function npmCalls({ root }) {
  return existsSync(npmCallLog(root)) ? readFileSync(npmCallLog(root), 'utf8').trim().split('\n') : [];
}

function copyOfVendor({ root, throneRoot }) {
  const copy = mkdtempSync(path.join(root, 'vendor-copy-'));
  cpSync(path.join(throneRoot, 'vendor'), copy, { recursive: true });
  return copy;
}

function assertVendorMatches({ throneRoot }, vendorBefore) {
  assert.equal(execFileSync('diff', ['-r', vendorBefore, path.join(throneRoot, 'vendor')], { encoding: 'utf8' }), '');
}

test('going to the pinned version installs the version the checkout pins, not the newest release', () => {
  const run = makePinnedRun('pinned-moves');
  const evidence = goToPin(run);
  assert.equal(vendoredClaudeReports(run), `${PINNED_VERSION} (Claude Code)`);
  assert.equal(evidence.action, 'pinned');
  assert.equal(evidence.harness, 'claude');
  assert.equal(evidence.moved, true);
  assert.equal(evidence.oldVersion, OLD_VERSION);
  assert.equal(evidence.newVersion, PINNED_VERSION);
  assert.ok(evidence.probes.length > 0);
  assert.deepEqual(JSON.parse(readFileSync(run.evidencePath, 'utf8')), evidence);
  assert.equal(JSON.parse(readFileSync(path.join(run.throneRoot, 'vendor', 'package.json'), 'utf8')).dependencies['@anthropic-ai/claude-code'], PINNED_VERSION);
  assert.equal(existsSync(path.join(run.throneRoot, 'vendor', '.stamps', 'harnesses')), true);
  assert.equal(npmCalls(run).some((call) => call.includes('@latest')), false);
  assert.equal(npmCalls(run).some((call) => call.includes(NEW_VERSION)), false);
});

test('going to the pinned version needs no readable court', () => {
  const run = makePinnedRun('pinned-no-court');
  const noThrone = path.join(run.root, 'throne-that-fails');
  mkdirSync(noThrone);
  writeExecutable(path.join(noThrone, 'throne'), '#!/usr/bin/env bash\nexit 1\n');
  const evidence = goToPin({ ...run, searchPath: `${noThrone}:${run.searchPath}` });
  assert.equal(evidence.moved, true);
});

test('a harness already at its pinned version installs nothing and probes nothing', () => {
  const run = makePinnedRun('pinned-unchanged', { vendoredVersion: PINNED_VERSION });
  const vendorBefore = copyOfVendor(run);
  const result = runScript('pinned', run);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^update-harness: claude unchanged at ${PINNED_VERSION}$`, 'm'));
  assert.deepEqual(npmCalls(run), []);
  const evidence = JSON.parse(readFileSync(run.evidencePath, 'utf8'));
  assert.equal(evidence.action, 'pinned');
  assert.equal(evidence.moved, false);
  assert.equal(evidence.oldVersion, PINNED_VERSION);
  assert.equal(evidence.newVersion, PINNED_VERSION);
  assert.deepEqual(evidence.probes, []);
  assertVendorMatches(run, vendorBefore);
});

test('going to the pinned version commits nothing and leaves the pin file byte for byte as it was', () => {
  const run = makePinnedRun('pinned-no-commit');
  const pinFile = path.join(run.throneRoot, 'vendor-pins.json');
  const pinFileWithOddSpacing = readFileSync(pinFile, 'utf8').replace('{\n', '{   \n');
  writeFileSync(pinFile, pinFileWithOddSpacing);
  git(run.throneRoot, ['commit', '--quiet', '--no-gpg-sign', '-am', 'odd spacing']);
  const headBefore = localHead(run.throneRoot);
  const result = runScript('pinned', run);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^update-harness: claude moved from ${OLD_VERSION} to ${PINNED_VERSION}$`, 'm'));
  assert.equal(readFileSync(pinFile, 'utf8'), pinFileWithOddSpacing);
  assert.equal(localHead(run.throneRoot), headBefore);
  assert.equal(git(run.throneRoot, ['status', '--porcelain', '--', 'vendor-pins.json']), '');
});

test('a run that died part way through is finished by the next run', () => {
  const run = makePinnedRun('pinned-died', { npmOptions: { dyingVendorInstall: true } });
  assert.equal(runScript('pinned', run).status, 1);
  fakeNpmDir(run.root, { latestVersion: NEW_VERSION });
  const evidence = goToPin(run);
  assert.equal(evidence.moved, true);
  assert.equal(evidence.oldVersion, 'none');
  assert.equal(vendoredClaudeReports(run), `${PINNED_VERSION} (Claude Code)`);
  assert.equal(goToPin(run).moved, false);
});

test('a failed probe leaves the vendored harness as it was', () => {
  const run = makePinnedRun('pinned-failed-probe', { npmOptions: { failingProbe: true } });
  const vendorBefore = copyOfVendor(run);
  const result = runScript('pinned', run);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^update-harness: /);
  assertVendorMatches(run, vendorBefore);
});

test('a failed integrity check leaves the vendored harness as it was', () => {
  const run = makePinnedRun('pinned-failed-integrity', { npmOptions: { packedIntegrity: 'sha512-BBBBBBBBBBBBBBBB' } });
  const vendorBefore = copyOfVendor(run);
  assert.throws(() => goToPin(run), /integrity differs/);
  assertVendorMatches(run, vendorBefore);
});

test('a checkout with nothing vendored moves from none', () => {
  const run = makePinnedRun('pinned-from-none');
  rmSync(path.join(run.throneRoot, 'vendor'), { recursive: true });
  const result = runScript('pinned', run);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^update-harness: claude moved from none to ${PINNED_VERSION}$`, 'm'));
  assert.equal(JSON.parse(readFileSync(run.evidencePath, 'utf8')).oldVersion, 'none');
});

test('a codex move records both versions without the words around them', () => {
  const run = makePinnedRun('pinned-codex');
  const binary = path.join(run.throneRoot, 'vendor', 'node_modules', '.bin', 'codex');
  writeExecutable(binary, '#!/usr/bin/env bash\necho "codex-cli 0.146.0"\n');
  writeExecutable(path.join(run.throneRoot, 'bin', 'codexy'), '#!/usr/bin/env bash\nexec "${CODEX_BIN}" --version\n');
  const evidence = goToPin(run, 'codex');
  assert.equal(evidence.oldVersion, '0.146.0');
  assert.equal(evidence.newVersion, '0.147.0');
  assert.equal(evidence.vendoredVersion, 'codex-cli 0.147.0');
});

test('an install that leaves another version in place fails after writing its evidence', () => {
  const run = makePinnedRun('pinned-wrong-version', { npmOptions: { vendoredVersionOverride: OLD_VERSION } });
  const result = runScript('pinned', run);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`vendored claude reports "${OLD_VERSION} \\(Claude Code\\)", expected ${PINNED_VERSION}`));
  assert.equal(JSON.parse(readFileSync(run.evidencePath, 'utf8')).newVersion, PINNED_VERSION);
});
