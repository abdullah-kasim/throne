import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  renderCheckReport,
  resolveHarnessState,
  runRollback,
  runUpdate,
  versionOutputReports,
} from './update-harness.mjs';
import {
  CLAUDE_VENDOR_PINS,
  fakeNpmDir,
  fakeThroneDir,
  git,
  makeThroneRoot,
  writeJson,
  writeExecutable,
  writePathBinary,
  writeVendoredClaude,
} from './update-harness-fixtures.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'update-harness.mjs');

test('the seam record carries all four versions when everything is present', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-seam-'));
  const throneRoot = makeThroneRoot(root, { pinnedVersion: '2.1.226' });
  writeVendoredClaude(throneRoot, '2.1.226');
  const nativeDir = path.join(root, 'native-bin');
  writePathBinary(nativeDir, 'claude', '2.1.200');
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.267' });
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${nativeDir}:${originalPath}`;
  try {
    const state = resolveHarnessState({ harness: 'claude', throneRoot });
    assert.equal(state.pinnedVersion, '2.1.226');
    assert.equal(state.vendoredVersion, '2.1.226');
    assert.equal(state.nativeVersion, '2.1.200');
    assert.equal(state.latestVersion, '2.1.267');
  } finally {
    process.env.PATH = originalPath;
  }
});

test('a harness with no vendored binary present yields vendoredVersion null rather than throwing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-no-vendor-'));
  const throneRoot = makeThroneRoot(root);
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.267' });
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${originalPath}`;
  try {
    const state = resolveHarnessState({ harness: 'claude', throneRoot });
    assert.equal(state.vendoredVersion, null);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('a native binary found under $throneRoot on PATH is excluded from nativeVersion', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-native-exclusion-'));
  const throneRoot = makeThroneRoot(root);
  writeVendoredClaude(throneRoot, '2.1.226');
  const insideThroneRoot = path.join(throneRoot, 'decoy-bin');
  writePathBinary(insideThroneRoot, 'claude', '9.9.9');
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.267' });
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${insideThroneRoot}:${path.dirname(process.execPath)}`;
  try {
    const state = resolveHarnessState({ harness: 'claude', throneRoot });
    assert.equal(state.nativeVersion, null);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("check's verdict text names the vendored version as what agents run and never calls the native version the harness", () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-verdict-'));
  const throneRoot = makeThroneRoot(root, { pinnedVersion: '2.1.226' });
  writeVendoredClaude(throneRoot, '2.1.226');
  const nativeDir = path.join(root, 'native-bin');
  writePathBinary(nativeDir, 'claude', '2.1.267');
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.267' });
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${nativeDir}:${originalPath}`;
  try {
    const state = resolveHarnessState({ harness: 'claude', throneRoot });
    const report = renderCheckReport(state);
    assert.match(report, /vendored claude 2\.1\.226 \(what agents run\) is behind registry 2\.1\.267/);
    assert.doesNotMatch(report, /native.*\(what agents run\)/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('the verdict never flips to up to date by comparing latestVersion against nativeVersion instead of pinnedVersion (RULING-5)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-ruling5-'));
  const throneRoot = makeThroneRoot(root, { pinnedVersion: '2.1.226' });
  writeVendoredClaude(throneRoot, '2.1.226');
  const nativeDir = path.join(root, 'native-bin');
  writePathBinary(nativeDir, 'claude', '2.1.267');
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.267' });
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${nativeDir}:${originalPath}`;
  try {
    const state = resolveHarnessState({ harness: 'claude', throneRoot });
    assert.equal(state.nativeVersion, state.latestVersion);
    assert.notEqual(state.pinnedVersion, state.latestVersion);
    assert.equal(state.upToDate, false);
    assert.match(renderCheckReport(state), /is behind registry/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("update rewrites vendor-pins.json (byte-preserving _comment), vendor/package.json, and the stamp atomically on success", () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-atomic-success-'));
  const throneRoot = makeThroneRoot(root, { pinnedVersion: '2.1.226' });
  writeVendoredClaude(throneRoot, '2.1.226');
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.267' });
  const throneDir = fakeThroneDir(root);
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${throneDir}:${originalPath}`;
  const managedRoot = path.join(root, 'managed');
  mkdirSync(managedRoot, { recursive: true });
  try {
    const evidence = runUpdate({
      harness: 'claude',
      throneRoot,
      managedRoot,
      registry: 'https://registry.npmjs.org',
      evidencePath: path.join(root, 'evidence.json'),
    });
    assert.equal(evidence.newVersion, '2.1.267');
    const pins = JSON.parse(readFileSync(path.join(throneRoot, 'vendor-pins.json'), 'utf8'));
    assert.equal(pins.harnesses.claude.version, '2.1.267');
    assert.deepEqual(pins._comment, CLAUDE_VENDOR_PINS._comment);
    const vendorPackage = JSON.parse(readFileSync(path.join(throneRoot, 'vendor', 'package.json'), 'utf8'));
    assert.equal(vendorPackage.dependencies['@anthropic-ai/claude-code'], '2.1.267');
    assert.equal(existsSync(path.join(throneRoot, 'vendor', '.stamps', 'harnesses')), true);
    const vendoredVersion = execFileSync(path.join(throneRoot, 'vendor', 'node_modules', '.bin', 'claude'), ['--version'], { encoding: 'utf8' }).trim();
    assert.equal(vendoredVersion, '2.1.267 (Claude Code)');
    assert.equal(evidence.vendoredVersion, '2.1.267 (Claude Code)');
  } finally {
    process.env.PATH = originalPath;
  }
});

test("check's verdict reads up to date when the vendored binary reports the pinned version in its real --version shape", () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-verdict-shape-'));
  const throneRoot = makeThroneRoot(root, { pinnedVersion: '2.1.267' });
  writeVendoredClaude(throneRoot, '2.1.267 (Claude Code)');
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.267' });
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${originalPath}`;
  try {
    const state = resolveHarnessState({ harness: 'claude', throneRoot });
    assert.equal(state.upToDate, true);
    assert.match(renderCheckReport(state), /matches registry latest 2\.1\.267/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('the reverify accepts the real --version shapes of both harnesses and rejects a different version', () => {
  assert.equal(versionOutputReports('2.1.268 (Claude Code)', '2.1.268'), true);
  assert.equal(versionOutputReports('codex-cli 0.154.0', '0.154.0'), true);
  assert.equal(versionOutputReports('2.1.268', '2.1.268'), true);
  assert.equal(versionOutputReports('2.1.2680 (Claude Code)', '2.1.268'), false);
  assert.equal(versionOutputReports('2.1.226 (Claude Code)', '2.1.268'), false);
  assert.equal(versionOutputReports(null, '2.1.268'), false);
});

test('a vendored binary that reports the wrong version fails the update after the evidence is written, so rollback has a source', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-reverify-failure-'));
  const throneRoot = makeThroneRoot(root, { pinnedVersion: '2.1.226' });
  writeVendoredClaude(throneRoot, '2.1.226');
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.267', vendoredVersionOverride: '2.1.226' });
  const throneDir = fakeThroneDir(root);
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${throneDir}:${originalPath}`;
  const managedRoot = path.join(root, 'managed');
  mkdirSync(managedRoot, { recursive: true });
  const evidencePath = path.join(root, 'evidence.json');
  try {
    assert.throws(
      () => runUpdate({
        harness: 'claude',
        throneRoot,
        managedRoot,
        registry: 'https://registry.npmjs.org',
        evidencePath,
      }),
      /vendored claude reports "2\.1\.226 \(Claude Code\)", expected 2\.1\.267/,
    );
    assert.equal(git(throneRoot, ['rev-list', '--count', 'HEAD']).trim(), '1');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal(evidence.oldVersion, '2.1.226');
    assert.equal(evidence.newVersion, '2.1.267');
    assert.equal(evidence.vendoredVersion, '2.1.226 (Claude Code)');
  } finally {
    process.env.PATH = originalPath;
  }
});

test('a failed probe leaves vendor-pins.json, vendor/package.json, and the stamp untouched', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-atomic-failure-'));
  const throneRoot = makeThroneRoot(root, { pinnedVersion: '2.1.226' });
  writeVendoredClaude(throneRoot, '2.1.226');
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.267', failingProbe: true });
  const throneDir = fakeThroneDir(root);
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${throneDir}:${originalPath}`;
  const managedRoot = path.join(root, 'managed');
  mkdirSync(managedRoot, { recursive: true });
  const pinsBefore = readFileSync(path.join(throneRoot, 'vendor-pins.json'), 'utf8');
  const vendorPackageBefore = readFileSync(path.join(throneRoot, 'vendor', 'package.json'), 'utf8');
  try {
    assert.throws(() => runUpdate({
      harness: 'claude',
      throneRoot,
      managedRoot,
      registry: 'https://registry.npmjs.org',
      evidencePath: path.join(root, 'evidence.json'),
    }));
    assert.equal(readFileSync(path.join(throneRoot, 'vendor-pins.json'), 'utf8'), pinsBefore);
    assert.equal(readFileSync(path.join(throneRoot, 'vendor', 'package.json'), 'utf8'), vendorPackageBefore);
    assert.equal(existsSync(path.join(throneRoot, 'vendor', '.stamps', 'harnesses')), false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('rollback restores the previous pin from evidence and re-vendors it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-rollback-'));
  const throneRoot = makeThroneRoot(root, { pinnedVersion: '2.1.267' });
  writeVendoredClaude(throneRoot, '2.1.267');
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.226' });
  const throneDir = fakeThroneDir(root);
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${throneDir}:${originalPath}`;
  const sourceEvidencePath = path.join(root, 'source-evidence.json');
  writeJson(sourceEvidencePath, { action: 'update', harness: 'claude', oldVersion: '2.1.226', newVersion: '2.1.267' });
  try {
    const evidence = runRollback({
      harness: 'claude',
      throneRoot,
      sourceEvidencePath,
      registry: 'https://registry.npmjs.org',
      evidencePath: path.join(root, 'rollback-evidence.json'),
    });
    assert.equal(evidence.restoredVersion, '2.1.226');
    const pins = JSON.parse(readFileSync(path.join(throneRoot, 'vendor-pins.json'), 'utf8'));
    assert.equal(pins.harnesses.claude.version, '2.1.226');
    const vendoredVersion = execFileSync(path.join(throneRoot, 'vendor', 'node_modules', '.bin', 'claude'), ['--version'], { encoding: 'utf8' }).trim();
    assert.equal(vendoredVersion, '2.1.226 (Claude Code)');
    assert.equal(evidence.vendoredVersion, '2.1.226 (Claude Code)');
    assert.equal(evidence.mutableServiceCaveat.includes('registry access'), false);
  } finally {
    process.env.PATH = originalPath;
  }
});

function runModelCheckedUpdate(reportedModelId) {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-model-ids-'));
  const throneRoot = makeThroneRoot(root, { pinnedVersion: '2.1.226' });
  writeVendoredClaude(throneRoot, '2.1.226');
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.267', reportedModelId });
  const throneDir = fakeThroneDir(root);
  const managedRoot = path.join(root, 'managed');
  mkdirSync(managedRoot, { recursive: true });
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${throneDir}:${originalPath}`;
  try {
    return {
      throneRoot,
      outcome: () => runUpdate({
        harness: 'claude',
        throneRoot,
        managedRoot,
        registry: 'https://registry.npmjs.org',
        evidencePath: path.join(root, 'evidence.json'),
        modelSessionCheck: true,
      }),
      restorePath: () => { process.env.PATH = originalPath; },
    };
  } catch (error) {
    process.env.PATH = originalPath;
    throw error;
  }
}

test('a claude update whose candidate reports a model id the registry cannot resolve fails naming the id and the registry file', () => {
  const update = runModelCheckedUpdate('claude-zeta-9-9');
  try {
    assert.throws(update.outcome, /claude-zeta-9-9.*src\/harness-routing\/model-registry\.ts/);
    assert.equal(JSON.parse(readFileSync(path.join(update.throneRoot, 'vendor-pins.json'), 'utf8')).harnesses.claude.version, '2.1.226');
  } finally {
    update.restorePath();
  }
});

test('a claude update whose candidate reports only known model ids proceeds', () => {
  const update = runModelCheckedUpdate('claude-fable-5-2');
  try {
    const evidence = update.outcome();
    assert.equal(evidence.newVersion, '2.1.267');
    assert.ok(evidence.probes.some((probe) => probe.includes('model ids')));
  } finally {
    update.restorePath();
  }
});

test('a claude check reports a model id the registry cannot resolve', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-check-model-ids-'));
  const throneRoot = makeThroneRoot(root, { pinnedVersion: '2.1.226' });
  writeExecutable(
    path.join(throneRoot, 'vendor', 'node_modules', '.bin', 'claude'),
    `#!/usr/bin/env bun\nif (process.argv.includes('-p')) process.stdout.write(${JSON.stringify(JSON.stringify({ modelUsage: { 'claude-zeta-9-9': {} } }))});\nelse process.stdout.write('2.1.226 (Claude Code)\\n');\n`,
  );
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.226' });
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${originalPath}`;
  try {
    const state = resolveHarnessState({ harness: 'claude', throneRoot, modelSessionCheck: true });
    assert.deepEqual(state.unresolvedModelIds, ['claude-zeta-9-9']);
    assert.match(renderCheckReport(state), /claude-zeta-9-9.*src\/harness-routing\/model-registry\.ts/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('without the model session check neither update nor check starts a model session', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-no-session-'));
  const throneRoot = makeThroneRoot(root, { pinnedVersion: '2.1.226' });
  writeExecutable(
    path.join(throneRoot, 'vendor', 'node_modules', '.bin', 'claude'),
    `#!/usr/bin/env bun\nif (process.argv.includes('-p')) process.exit(70);\nprocess.stdout.write('2.1.226 (Claude Code)\\n');\n`,
  );
  const npmDir = fakeNpmDir(root, { latestVersion: '2.1.226' });
  const originalPath = process.env.PATH;
  process.env.PATH = `${npmDir}:${originalPath}`;
  try {
    const state = resolveHarnessState({ harness: 'claude', throneRoot });
    assert.equal(state.unresolvedModelIds, undefined);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('importing update-harness.mjs as a module never runs main()', () => {
  const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
