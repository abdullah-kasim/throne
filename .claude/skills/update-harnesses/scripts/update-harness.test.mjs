import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'update-harness.mjs');
// The skill now lives inside the throne repository itself
// (`throne/.claude/skills/update-harnesses/`), so the real feature-flags source
// the fixture copies is resolved relative to this file rather than through a
// hard-coded absolute clone path. That path was `~/repos/throne` while the skill
// lived in the global skills tree, and it did not survive a clone anywhere else.
const SOURCE_FEATURE_FLAGS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..',
  'src', 'shared-policy', 'feature-flags.service.ts',
);

function writeExecutable(target, contents) {
  writeFileSync(target, contents);
  chmodSync(target, 0o755);
}

function makeFixture({
  ownership = true,
  herdrOwnership = true,
  failingProbe = false,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'update-harness-test-'));
  const throneRoot = path.join(root, 'throne');
  const configRoot = path.join(root, 'config');
  const managedRoot = path.join(root, 'managed');
  const fakeBin = path.join(root, 'bin');
  mkdirSync(path.join(throneRoot, 'src', 'shared-policy'), { recursive: true });
  mkdirSync(path.join(throneRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(throneRoot, 'test'), { recursive: true });
  mkdirSync(path.join(configRoot, 'throne'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  cpSync(SOURCE_FEATURE_FLAGS, path.join(throneRoot, 'src', 'shared-policy', 'feature-flags.service.ts'));
  writeFileSync(path.join(configRoot, 'throne', 'features.json'), JSON.stringify({
    'harness-decouple': ownership,
    'herdr-decouple': herdrOwnership,
  }));
  for (const launcher of ['claudey', 'codexy']) {
    const environmentName = launcher === 'claudey' ? 'CLAUDE_BIN' : 'CODEX_BIN';
    writeExecutable(path.join(throneRoot, 'bin', launcher), `#!/usr/bin/env bash\nexec "\${${environmentName}}" --version\n`);
  }
  for (const testName of [
    'throne-launcher-path.test.ts',
    'create-agent-registration-hermetic.test.ts',
  ]) {
    writeFileSync(path.join(throneRoot, 'test', testName), "import test from 'node:test'; test('fixture', () => {});\n");
  }
  const npmLog = path.join(root, 'npm.log');
  writeExecutable(path.join(fakeBin, 'npm'), `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
const log = process.env.FAKE_NPM_LOG;
writeFileSync(log, process.argv.slice(2).join(' ') + '\\n', { flag: 'a' });
if (process.argv[2] === 'view') {
  const codex = process.argv[3].includes('@openai/codex');
  process.stdout.write(JSON.stringify({
    name: codex ? '@openai/codex' : '@anthropic-ai/claude-code',
    version: '9.9.9',
    'dist.integrity': 'sha512-AAAAAAAAAAAAAAAA',
    'dist.tarball': 'https://registry.npmjs.org/fake.tgz'
  }));
} else if (process.argv[2] === 'pack') {
  const codex = process.argv[3].includes('@openai/codex');
  const packageName = codex ? '@openai/codex' : '@anthropic-ai/claude-code';
  const executable = codex ? 'codex' : 'claude';
  const destination = process.argv[process.argv.indexOf('--pack-destination') + 1];
  const fixture = path.join(process.env.FAKE_ROOT, 'package');
  mkdirSync(fixture, { recursive: true });
  writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
    name: packageName,
    version: '9.9.9',
    bin: { [executable]: 'cli.js' }
  }));
  writeFileSync(path.join(fixture, 'cli.js'), \`#!/usr/bin/env node
if (\${JSON.stringify(${failingProbe})} && process.argv.slice(2).join(' ') === 'auth --help') process.exit(23);
process.stdout.write('9.9.9\\\\n');
\`);
  chmodSync(path.join(fixture, 'cli.js'), 0o755);
  const tarball = path.join(destination, 'fake.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', process.env.FAKE_ROOT, 'package']);
  process.stdout.write(JSON.stringify([{ filename: 'fake.tgz', integrity: 'sha512-AAAAAAAAAAAAAAAA' }]));
} else if (process.argv[2] === 'install') {
  // Mirror what real \`npm install <tarball>\` does for stagePackage()'s
  // throwaway host project: extract into node_modules/<name> beneath cwd.
  const tarballPath = process.argv[3];
  const peek = mkdtempSync(path.join(tmpdir(), 'fake-npm-install-'));
  execFileSync('tar', ['-xzf', tarballPath, '-C', peek, '--strip-components=1']);
  const manifest = JSON.parse(readFileSync(path.join(peek, 'package.json'), 'utf8'));
  const dest = path.join(process.cwd(), 'node_modules', manifest.name);
  mkdirSync(dest, { recursive: true });
  cpSync(peek, dest, { recursive: true });
  rmSync(peek, { recursive: true, force: true });
  const binRelative = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin)[0];
  chmodSync(path.join(dest, binRelative), 0o755);
} else {
  process.exit(64);
}
`);
  return { root, throneRoot, configRoot, managedRoot, fakeBin, npmLog };
}

function invoke(fixture, action = 'update', extra = [], harness = 'claude') {
  return spawnSync(process.execPath, [
    SCRIPT,
    action,
    '--harness',
    harness,
    '--throne-root',
    fixture.throneRoot,
    '--managed-root',
    fixture.managedRoot,
    '--registry',
    'https://registry.npmjs.org',
    ...extra,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: fixture.configRoot,
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      FAKE_NPM_LOG: fixture.npmLog,
      FAKE_ROOT: fixture.root,
    },
  });
}

test('ownership OFF exits before registry, staging, evidence, or promotion', () => {
  const fixture = makeFixture({ ownership: false });
  const result = invoke(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ownership is OFF/);
  assert.equal(existsSync(fixture.npmLog), false);
  assert.equal(existsSync(fixture.managedRoot), false);
});

test('Herdr planning remains skipped when harness ownership is ON alone', () => {
  const fixture = makeFixture({ herdrOwnership: false });
  const evidence = path.join(fixture.root, 'harness-only-evidence.json');
  const result = invoke(fixture, 'check', ['--evidence', evidence]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(evidence, 'utf8')).herdrPlanned, false);
});

test('Herdr ownership alone cannot bypass harness ownership OFF', () => {
  const fixture = makeFixture({ ownership: false, herdrOwnership: true });
  const evidence = path.join(fixture.root, 'herdr-only-evidence.json');
  const result = invoke(fixture, 'check', ['--evidence', evidence]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.npmLog), false);
  assert.equal(existsSync(evidence), false);
  assert.equal(existsSync(fixture.managedRoot), false);
});

test('verified package probes and promotes while retaining evidence', () => {
  const fixture = makeFixture();
  const evidence = path.join(fixture.root, 'evidence.json');
  const result = invoke(fixture, 'update', ['--evidence', evidence]);
  assert.equal(result.status, 0, result.stderr);
  const current = path.join(fixture.managedRoot, 'claude', 'current');
  assert.equal(existsSync(current), true);
  assert.match(readlinkSync(current), /^versions\/9\.9\.9-/);
  const record = JSON.parse(readFileSync(evidence, 'utf8'));
  assert.equal(record.newVersion, '9.9.9');
  assert.equal(record.integrity, 'sha512-AAAAAAAAAAAAAAAA');
  assert.equal(record.herdrPlanned, true);
  assert.equal(record.herdrTouchedOrRestarted, false);
  assert.equal(record.probes.length, 7);
});

test('Codex uses its authoritative package and serial transaction path', () => {
  const fixture = makeFixture();
  const evidence = path.join(fixture.root, 'codex-evidence.json');
  const result = invoke(fixture, 'update', ['--evidence', evidence], 'codex');
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(readFileSync(evidence, 'utf8'));
  assert.equal(record.package, '@openai/codex');
  assert.equal(record.harness, 'codex');
  assert.match(readlinkSync(path.join(fixture.managedRoot, 'codex', 'current')), /^versions\/9\.9\.9-/);
});

test('a competing harness transaction fails before discovery or managed-state mutation', () => {
  const fixture = makeFixture();
  const evidence = path.join(fixture.root, 'contending-evidence.json');
  mkdirSync(path.join(fixture.managedRoot, '.transaction-lock'), { recursive: true });

  const result = invoke(fixture, 'check', ['--evidence', evidence], 'codex');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another harness update transaction is already running/);
  assert.equal(existsSync(fixture.npmLog), false);
  assert.equal(existsSync(path.join(fixture.managedRoot, 'codex')), false);
  assert.equal(existsSync(evidence), false);
  assert.deepEqual(readdirSync(fixture.managedRoot), ['.transaction-lock']);
});

test('a failed probe leaves the active release untouched', () => {
  const fixture = makeFixture({ failingProbe: true });
  const harnessRoot = path.join(fixture.managedRoot, 'claude');
  mkdirSync(path.join(harnessRoot, 'versions', 'old'), { recursive: true });
  writeFileSync(path.join(harnessRoot, 'versions', 'old', 'marker'), 'old');
  execFileSync('ln', ['-s', 'versions/old', path.join(harnessRoot, 'current')]);
  const result = invoke(fixture);
  assert.notEqual(result.status, 0);
  assert.equal(readlinkSync(path.join(harnessRoot, 'current')), 'versions/old');
  assert.equal(existsSync(path.join(harnessRoot, 'previous')), false);
});

test('evidence failure after promotion restores exact current and previous links', () => {
  const fixture = makeFixture();
  const harnessRoot = path.join(fixture.managedRoot, 'claude');
  mkdirSync(path.join(harnessRoot, 'versions', 'current-release'), { recursive: true });
  mkdirSync(path.join(harnessRoot, 'versions', 'previous-release'), { recursive: true });
  execFileSync('ln', ['-s', 'versions/current-release', path.join(harnessRoot, 'current')]);
  execFileSync('ln', ['-s', 'versions/previous-release', path.join(harnessRoot, 'previous')]);
  const evidenceParent = path.join(fixture.root, 'evidence-parent-is-a-file');
  writeFileSync(evidenceParent, 'block evidence directory creation');

  const result = invoke(fixture, 'update', ['--evidence', path.join(evidenceParent, 'evidence.json')]);

  assert.notEqual(result.status, 0);
  assert.equal(readlinkSync(path.join(harnessRoot, 'current')), 'versions/current-release');
  assert.equal(readlinkSync(path.join(harnessRoot, 'previous')), 'versions/previous-release');
});

test('first-install evidence failure after promotion leaves no current or previous link', () => {
  const fixture = makeFixture();
  const harnessRoot = path.join(fixture.managedRoot, 'claude');
  const evidenceParent = path.join(fixture.root, 'first-install-evidence-parent-is-a-file');
  writeFileSync(evidenceParent, 'block evidence directory creation');

  const result = invoke(fixture, 'update', ['--evidence', path.join(evidenceParent, 'evidence.json')]);

  assert.notEqual(result.status, 0);
  assert.equal(existsSync(path.join(harnessRoot, 'current')), false);
  assert.equal(existsSync(path.join(harnessRoot, 'previous')), false);
});

test('rollback atomically swaps current and previous without registry access', () => {
  const fixture = makeFixture();
  const harnessRoot = path.join(fixture.managedRoot, 'claude');
  mkdirSync(path.join(harnessRoot, 'versions', 'old'), { recursive: true });
  mkdirSync(path.join(harnessRoot, 'versions', 'new'), { recursive: true });
  execFileSync('ln', ['-s', 'versions/new', path.join(harnessRoot, 'current')]);
  execFileSync('ln', ['-s', 'versions/old', path.join(harnessRoot, 'previous')]);
  const result = invoke(fixture, 'rollback');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readlinkSync(path.join(harnessRoot, 'current')), 'versions/old');
  assert.equal(readlinkSync(path.join(harnessRoot, 'previous')), 'versions/new');
  assert.equal(existsSync(fixture.npmLog), false);
});
