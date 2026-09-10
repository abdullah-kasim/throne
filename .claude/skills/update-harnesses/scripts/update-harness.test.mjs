import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  renderCheckReport,
  resolveHarnessState,
  runRollback,
  runUpdate,
} from './update-harness.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'update-harness.mjs');
const THRONE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SOURCE_FEATURE_FLAGS = path.join(THRONE_ROOT, 'src', 'shared-policy', 'feature-flags.service.ts');

const CLAUDE_VENDOR_PINS = {
  _comment: [
    'Pinned third-party harness versions the throne vendors into ./vendor/.',
    'This is a fixture copy for update-harness.test.mjs; byte-preservation of',
    'this array is exactly what the atomicity tests assert on.',
  ],
  tools: { ntfy: { image: 'binwiederhier/ntfy:v2.28.0' } },
  harnesses: {
    claude: { package: '@anthropic-ai/claude-code', version: '2.1.226', bin: 'claude' },
    codex: { package: '@openai/codex', version: '0.147.0', bin: 'codex' },
  },
};

function writeExecutable(target, contents) {
  writeFileSync(target, contents);
  chmodSync(target, 0o755);
}

function writeJson(target, data) {
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
}

function git(throneRoot, args) {
  return execFileSync('git', ['-C', throneRoot, ...args], { encoding: 'utf8' });
}

function makeThroneRoot(root, { pinnedVersion = '2.1.226' } = {}) {
  const throneRoot = path.join(root, 'throne');
  mkdirSync(path.join(throneRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(throneRoot, 'test'), { recursive: true });
  mkdirSync(path.join(throneRoot, 'src', 'shared-policy'), { recursive: true });
  mkdirSync(path.join(throneRoot, 'vendor', 'node_modules', '.bin'), { recursive: true });

  const pins = JSON.parse(JSON.stringify(CLAUDE_VENDOR_PINS));
  pins.harnesses.claude.version = pinnedVersion;
  writeJson(path.join(throneRoot, 'vendor-pins.json'), pins);
  writeJson(path.join(throneRoot, 'vendor', 'package.json'), {
    name: 'throne-vendor',
    private: true,
    version: '0.0.0',
    dependencies: { '@anthropic-ai/claude-code': pinnedVersion },
  });

  execFileSync('cp', [SOURCE_FEATURE_FLAGS, path.join(throneRoot, 'src', 'shared-policy', 'feature-flags.service.ts')]);
  execFileSync('ln', ['-s', path.join(THRONE_ROOT, 'node_modules'), path.join(throneRoot, 'node_modules')]);
  writeExecutable(path.join(throneRoot, 'bin', 'claudey'), '#!/usr/bin/env bash\nexec "${CLAUDE_BIN}" --version\n');
  writeFileSync(
    path.join(throneRoot, 'test', 'register-typescript.mjs'),
    readFileSync(path.join(THRONE_ROOT, 'test', 'register-typescript.mjs')),
  );
  writeFileSync(
    path.join(throneRoot, 'test', 'ompy-launcher.test.ts'),
    "import test from 'node:test';\n\ntest('fixture stand-in for the real launcher-resolution proof', () => {});\n",
  );

  git(throneRoot, ['init', '--quiet']);
  git(throneRoot, ['config', 'user.email', 'fixture@example.com']);
  git(throneRoot, ['config', 'user.name', 'fixture']);
  git(throneRoot, ['config', 'commit.gpgsign', 'false']);
  git(throneRoot, ['add', '-A']);
  git(throneRoot, ['commit', '--quiet', '--no-gpg-sign', '-m', 'fixture base']);

  return throneRoot;
}

function writeVendoredClaude(throneRoot, version) {
  writeExecutable(
    path.join(throneRoot, 'vendor', 'node_modules', '.bin', 'claude'),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(version)} + '\\n');\n`,
  );
}

function writePathBinary(dir, executable, version) {
  mkdirSync(dir, { recursive: true });
  writeExecutable(
    path.join(dir, executable),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(version)} + '\\n');\n`,
  );
}

function fakeNpmDir(root, { latestVersion = '2.1.267', failingProbe = false } = {}) {
  const dir = path.join(root, 'fake-npm-bin');
  mkdirSync(dir, { recursive: true });
  writeExecutable(path.join(dir, 'npm'), `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const latest = ${JSON.stringify(latestVersion)};
const failingProbe = ${JSON.stringify(failingProbe)};

if (argv[0] === 'view') {
  const spec = argv[1];
  const packageName = spec.slice(0, spec.lastIndexOf('@'));
  const jsonIndex = argv.indexOf('--json');
  const fields = argv.slice(2, jsonIndex);
  if (fields.length === 1 && fields[0] === 'version') {
    process.stdout.write(JSON.stringify(latest));
  } else {
    process.stdout.write(JSON.stringify({
      name: packageName,
      version: latest,
      'dist.integrity': 'sha512-AAAAAAAAAAAAAAAA',
      'dist.tarball': 'https://registry.npmjs.org/fake.tgz',
    }));
  }
} else if (argv[0] === 'pack') {
  const spec = argv[1];
  const packageName = spec.slice(0, spec.lastIndexOf('@'));
  const executable = packageName.includes('codex') ? 'codex' : 'claude';
  const destIndex = argv.indexOf('--pack-destination');
  const destination = argv[destIndex + 1];
  const fixture = mkdtempSync(path.join(tmpdir(), 'fake-npm-pack-'));
  mkdirSync(path.join(fixture, 'package'), { recursive: true });
  writeFileSync(path.join(fixture, 'package', 'package.json'), JSON.stringify({
    name: packageName,
    version: latest,
    bin: { [executable]: 'cli.js' },
  }));
  writeFileSync(path.join(fixture, 'package', 'cli.js'), \`#!/usr/bin/env node
if (\${JSON.stringify(failingProbe)} && process.argv.slice(2).join(' ') === 'auth --help') process.exit(23);
process.stdout.write(${JSON.stringify(latestVersion)} + '\\\\n');
\`);
  chmodSync(path.join(fixture, 'package', 'cli.js'), 0o755);
  const tarball = path.join(destination, 'fake.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', fixture, 'package']);
  process.stdout.write(JSON.stringify([{ filename: 'fake.tgz', integrity: 'sha512-AAAAAAAAAAAAAAAA' }]));
} else if (argv[0] === 'install' && argv.includes('--prefix')) {
  const prefixIndex = argv.indexOf('--prefix');
  const prefixDir = argv[prefixIndex + 1];
  const spec = argv[prefixIndex + 2];
  const packageName = spec.slice(0, spec.lastIndexOf('@'));
  const version = spec.slice(spec.lastIndexOf('@') + 1);
  const executable = packageName.includes('codex') ? 'codex' : 'claude';
  const binDir = path.join(prefixDir, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, executable), \`#!/usr/bin/env node
process.stdout.write(\${JSON.stringify(version)} + '\\\\n');
\`);
  chmodSync(path.join(binDir, executable), 0o755);
} else if (argv[0] === 'install') {
  const tarballPath = argv[1];
  const peek = mkdtempSync(path.join(tmpdir(), 'fake-npm-install-'));
  execFileSync('tar', ['-xzf', tarballPath, '-C', peek, '--strip-components=1']);
  const manifest = JSON.parse(readFileSync(path.join(peek, 'package.json'), 'utf8'));
  const dest = path.join(process.cwd(), 'node_modules', manifest.name);
  mkdirSync(dest, { recursive: true });
  execFileSync('cp', ['-R', peek + '/.', dest]);
  const binRelative = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin)[0];
  chmodSync(path.join(dest, binRelative), 0o755);
} else {
  process.exit(64);
}
`);
  return dir;
}

function ownership() {
  return { ownsHarnesses: true, plansHerdr: false };
}

function fakeThroneDir(root) {
  const dir = path.join(root, 'fake-throne-bin');
  mkdirSync(dir, { recursive: true });
  writeExecutable(path.join(dir, 'throne'), '#!/usr/bin/env node\nprocess.stdout.write("[]\\n");\n');
  return dir;
}

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
      ownership: ownership(),
    });
    assert.equal(evidence.newVersion, '2.1.267');
    const pins = JSON.parse(readFileSync(path.join(throneRoot, 'vendor-pins.json'), 'utf8'));
    assert.equal(pins.harnesses.claude.version, '2.1.267');
    assert.deepEqual(pins._comment, CLAUDE_VENDOR_PINS._comment);
    const vendorPackage = JSON.parse(readFileSync(path.join(throneRoot, 'vendor', 'package.json'), 'utf8'));
    assert.equal(vendorPackage.dependencies['@anthropic-ai/claude-code'], '2.1.267');
    assert.equal(existsSync(path.join(throneRoot, 'vendor', '.stamps', 'harnesses')), true);
    const vendoredVersion = execFileSync(path.join(throneRoot, 'vendor', 'node_modules', '.bin', 'claude'), ['--version'], { encoding: 'utf8' }).trim();
    assert.equal(vendoredVersion, '2.1.267');
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
      ownership: ownership(),
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
      ownership: ownership(),
    });
    assert.equal(evidence.restoredVersion, '2.1.226');
    const pins = JSON.parse(readFileSync(path.join(throneRoot, 'vendor-pins.json'), 'utf8'));
    assert.equal(pins.harnesses.claude.version, '2.1.226');
    const vendoredVersion = execFileSync(path.join(throneRoot, 'vendor', 'node_modules', '.bin', 'claude'), ['--version'], { encoding: 'utf8' }).trim();
    assert.equal(vendoredVersion, '2.1.226');
    assert.equal(evidence.mutableServiceCaveat.includes('registry access'), false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('harness ownership OFF exits before any registry, staging, or vendor mutation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-ownership-off-'));
  const throneRoot = makeThroneRoot(root);
  const configRoot = path.join(root, 'config');
  mkdirSync(path.join(configRoot, 'throne'), { recursive: true });
  writeJson(path.join(configRoot, 'throne', 'features.json'), { 'harness-decouple': false });
  const npmDir = fakeNpmDir(root, {});
  const managedRoot = path.join(root, 'managed');
  const result = spawnSync(process.execPath, [
    SCRIPT,
    'check',
    '--harness', 'claude',
    '--throne-root', throneRoot,
    '--managed-root', managedRoot,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configRoot,
      PATH: `${npmDir}:${process.env.PATH}`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ownership is OFF/);
  assert.equal(existsSync(managedRoot), false);
});

test('importing update-harness.mjs as a module never runs main()', () => {
  const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
