import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { turnOffCommitSigningThatTheEnvironmentTurnedOn } from '../../../../test/git-repo-test-fixture.ts';

turnOffCommitSigningThatTheEnvironmentTurnedOn();

const THRONE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export const CLAUDE_VENDOR_PINS = {
  _comment: [
    'Pinned third-party harness versions the throne vendors into ./vendor/.',
    'This is a fixture copy for update-harness.test.mjs; byte-preservation of',
    'this array is exactly what the atomicity tests assert on.',
  ],
  tools: { ntfy: { image: 'docker.io/binwiederhier/ntfy:v2.28.0' } },
  harnesses: {
    claude: { package: '@anthropic-ai/claude-code', version: '2.1.226', bin: 'claude' },
    codex: { package: '@openai/codex', version: '0.147.0', bin: 'codex' },
  },
};

export function writeExecutable(target, contents) {
  writeFileSync(target, contents);
  chmodSync(target, 0o755);
}

export function writeJson(target, data) {
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
}

export function git(throneRoot, args) {
  return execFileSync('git', ['-C', throneRoot, ...args], { encoding: 'utf8' });
}

export function makeThroneRoot(root, { pinnedVersion = '2.1.226' } = {}) {
  const throneRoot = path.join(root, 'throne');
  mkdirSync(path.join(throneRoot, 'bin'), { recursive: true });
  mkdirSync(path.join(throneRoot, 'test'), { recursive: true });
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

  execFileSync('ln', ['-s', path.join(THRONE_ROOT, 'node_modules'), path.join(throneRoot, 'node_modules')]);
  writeExecutable(path.join(throneRoot, 'bin', 'claudey'), '#!/usr/bin/env bash\nexec "${CLAUDE_BIN}" --version\n');
  writeFileSync(
    path.join(throneRoot, 'test', 'ompy-launcher.test.ts'),
    "import test from 'node:test';\n\ntest('fixture stand-in for the real launcher-resolution proof', () => {});\n",
  );

  git(throneRoot, ['init', '--quiet', '--initial-branch=main']);
  git(throneRoot, ['config', 'user.email', 'fixture@example.com']);
  git(throneRoot, ['config', 'user.name', 'fixture']);
  git(throneRoot, ['config', 'commit.gpgsign', 'false']);
  git(throneRoot, ['add', '-A']);
  git(throneRoot, ['commit', '--quiet', '--no-gpg-sign', '-m', 'fixture base']);

  return throneRoot;
}

export function writeVendoredClaude(throneRoot, version) {
  writeExecutable(
    path.join(throneRoot, 'vendor', 'node_modules', '.bin', 'claude'),
    `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(version)} + '\\n');\n`,
  );
}

export function writePathBinary(dir, executable, version) {
  mkdirSync(dir, { recursive: true });
  writeExecutable(
    path.join(dir, executable),
    `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(version)} + '\\n');\n`,
  );
}

export function npmCallLog(root) {
  return path.join(root, 'npm-calls.log');
}

export function fakeNpmDir(root, { latestVersion = '2.1.267', failingProbe = false, vendoredVersionOverride = null, dyingVendorInstall = false, packedIntegrity = 'sha512-AAAAAAAAAAAAAAAA', reportedModelId = 'claude-opus-5-5' } = {}) {
  const dir = path.join(root, 'fake-npm-bin');
  mkdirSync(dir, { recursive: true });
  writeExecutable(path.join(dir, 'npm'), `#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(npmCallLog(root))}, argv.join(' ') + '\\n');
const latest = ${JSON.stringify(latestVersion)};
const failingProbe = ${JSON.stringify(failingProbe)};
const vendoredVersionOverride = ${JSON.stringify(vendoredVersionOverride)};
const dyingVendorInstall = ${JSON.stringify(dyingVendorInstall)};
const sessionOutput = ${JSON.stringify(JSON.stringify({ modelUsage: { [reportedModelId]: {} } }))};

function versionAskedFor(spec) {
  const asked = spec.slice(spec.lastIndexOf('@') + 1);
  return asked === 'latest' ? latest : asked;
}

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
      version: versionAskedFor(spec),
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
    version: versionAskedFor(spec),
    bin: { [executable]: 'cli.js' },
  }));
  writeFileSync(path.join(fixture, 'package', 'cli.js'), \`#!/usr/bin/env bun
if (\${JSON.stringify(failingProbe)} && process.argv.slice(2).join(' ') === 'auth --help') process.exit(23);
if (process.argv.includes('-p')) { process.stdout.write(\${JSON.stringify(sessionOutput)}); process.exit(0); }
process.stdout.write(\${JSON.stringify(versionAskedFor(spec))} + '\\\\n');
\`);
  chmodSync(path.join(fixture, 'package', 'cli.js'), 0o755);
  const tarball = path.join(destination, 'fake.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', fixture, 'package']);
  process.stdout.write(JSON.stringify([{ filename: 'fake.tgz', integrity: ${JSON.stringify(packedIntegrity)} }]));
} else if (argv[0] === 'install' && argv.includes('--prefix')) {
  const prefixIndex = argv.indexOf('--prefix');
  const prefixDir = argv[prefixIndex + 1];
  const spec = argv[prefixIndex + 2];
  const packageName = spec.slice(0, spec.lastIndexOf('@'));
  const version = spec.slice(spec.lastIndexOf('@') + 1);
  const executable = packageName.includes('codex') ? 'codex' : 'claude';
  const binDir = path.join(prefixDir, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  if (dyingVendorInstall) {
    writeFileSync(path.join(binDir, executable), '#!/usr/bin/env bun\\nprocess.exit(9);\\n');
    chmodSync(path.join(binDir, executable), 0o755);
    process.exit(1);
  }
  const manifestPath = path.join(prefixDir, 'package.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  manifest.dependencies = { ...manifest.dependencies, [packageName]: version };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n');
  const reportedVersion = vendoredVersionOverride ?? version;
  const versionOutput = executable === 'codex' ? \`codex-cli \${reportedVersion}\` : \`\${reportedVersion} (Claude Code)\`;
  writeFileSync(path.join(binDir, executable), \`#!/usr/bin/env bun
process.stdout.write(\${JSON.stringify(versionOutput)} + '\\\\n');
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

export function fakeThroneDir(root) {
  const dir = path.join(root, 'fake-throne-bin');
  mkdirSync(dir, { recursive: true });
  writeExecutable(path.join(dir, 'throne'), '#!/usr/bin/env bun\nprocess.stdout.write("[]\\n");\n');
  return dir;
}

export function addOrigin(root, throneRoot, { yolo }) {
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(throneRoot, ['remote', 'add', 'origin', origin]);
  git(throneRoot, ['push', '--quiet', 'origin', 'main']);
  git(throneRoot, ['config', 'core.hooksPath', path.join(THRONE_ROOT, 'scripts', 'git-hooks')]);
  if (yolo) git(throneRoot, ['config', 'throne.yolo', 'true']);
  return origin;
}

export function refusePushesTo(origin) {
  writeExecutable(path.join(origin, 'hooks', 'pre-receive'), '#!/usr/bin/env bash\necho "fixture origin refuses this push" >&2\nexit 1\n');
}
