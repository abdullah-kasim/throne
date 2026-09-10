#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HARNESS = {
  claude: {
    packageName: '@anthropic-ai/claude-code',
    executable: 'claude',
    safeProbes: [['--version'], ['--help'], ['auth', '--help'], ['resume', '--help'], ['remote-control', '--help']],
    launcher: 'claudey',
    binaryEnvironment: 'CLAUDE_BIN',
  },
  codex: {
    packageName: '@openai/codex',
    executable: 'codex',
    safeProbes: [['--version'], ['--help'], ['login', '--help'], ['resume', '--help'], ['cloud', '--help']],
    launcher: 'codexy',
    binaryEnvironment: 'CODEX_BIN',
  },
};

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    action: 'update',
    managedRoot: path.join(homedir(), '.local', 'share', 'throne', 'harnesses'),
    evidence: undefined,
    registry: 'https://registry.npmjs.org',
    throneRoot: undefined,
    harness: undefined,
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (!['managed-root', 'evidence', 'registry', 'throne-root', 'harness', 'source-evidence'].includes(key)) {
      fail(`unknown option --${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`--${key} requires a value`);
    options[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  if (positionals.length !== 1 || !['check', 'update', 'rollback'].includes(positionals[0])) {
    fail('usage: update-harness.mjs <check|update|rollback> --harness <claude|codex> --throne-root <path> [--managed-root <path>] [--evidence <path>] [--registry <url>]');
  }
  options.action = positionals[0];
  if (!HARNESS[options.harness]) fail('--harness must be claude or codex');
  if (!options.throneRoot) fail('--throne-root is required');
  options.throneRoot = path.resolve(options.throneRoot);
  options.managedRoot = path.resolve(options.managedRoot);
  options.evidence = path.resolve(options.evidence ?? path.join(options.managedRoot, 'evidence', `${options.harness}-${Date.now()}.json`));
  return options;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

async function loadOwnership(throneRoot) {
  const modulePath = path.join(throneRoot, 'src', 'shared-policy', 'feature-flags.service.ts');
  const featureFlags = await import(`${pathToFileURL(modulePath).href}?update=${Date.now()}`);
  const flags = featureFlags.loadFeatureFlags();
  return {
    ownsHarnesses: featureFlags.shouldOwnHarnessUpdates(flags),
    plansHerdr: featureFlags.shouldOwnHarnessUpdates(flags)
      && featureFlags.shouldUpdateHerdrInHarnessUpdate(flags),
  };
}

function discoverPackage(config, registry) {
  const raw = run('npm', [
    'view',
    `${config.packageName}@latest`,
    'name',
    'version',
    'dist.integrity',
    'dist.tarball',
    '--json',
    '--registry',
    registry,
  ]);
  const metadata = JSON.parse(raw);
  if (metadata.name !== config.packageName || typeof metadata.version !== 'string') {
    fail(`registry returned unexpected package identity for ${config.packageName}`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(metadata['dist.integrity'] ?? '')) {
    fail(`registry returned no valid sha512 integrity for ${config.packageName}`);
  }
  const registryHost = new URL(registry).host;
  if (new URL(metadata['dist.tarball']).host !== registryHost) {
    fail(`tarball host differs from authoritative registry host ${registryHost}`);
  }
  return {
    name: metadata.name,
    version: metadata.version,
    integrity: metadata['dist.integrity'],
    tarball: metadata['dist.tarball'],
  };
}

function stagePackage(config, metadata, registry, workRoot) {
  const packed = JSON.parse(run('npm', [
    'pack',
    `${metadata.name}@${metadata.version}`,
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    workRoot,
    '--registry',
    registry,
  ]));
  if (!Array.isArray(packed) || packed.length !== 1) fail('npm pack returned unexpected result count');
  if (packed[0].integrity !== metadata.integrity) fail('downloaded package integrity differs from registry metadata');
  const tarball = path.join(workRoot, packed[0].filename);
  const tarballManifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']));
  if (tarballManifest.name !== metadata.name || tarballManifest.version !== metadata.version) {
    fail('downloaded package manifest differs from registry metadata');
  }
  // Some packages (e.g. @anthropic-ai/claude-code) ship a platform-detection
  // stub for their declared `bin` entry and place the real native binary in a
  // platform optionalDependency, materialized only by the package's own
  // postinstall script. Extracting the tarball directly (`npm pack` +
  // untar) never resolves optionalDependencies and never runs that script,
  // leaving the stub in place. Installing the package as an ordinary
  // dependency of a throwaway host project — exactly how a real consumer
  // acquires it — resolves optionalDependencies and runs postinstall for
  // real; it also correctly skips the package's own `prepare` life-cycle
  // script, which fires only for the package's own repository (or a git
  // dependency), never for a registry/tarball dependency install. This
  // depends on nothing beyond "the package installs the way its own
  // manifest says it does", so it encodes no package-specific layout.
  const hostProject = path.join(workRoot, 'host');
  mkdirSync(hostProject, { recursive: true });
  writeFileSync(path.join(hostProject, 'package.json'), `${JSON.stringify({ name: 'throne-harness-stage', private: true }, null, 2)}\n`);
  run('npm', ['install', tarball, '--no-audit', '--no-fund', '--registry', registry], { cwd: hostProject });
  const staged = path.join(hostProject, 'node_modules', metadata.name);
  const manifest = JSON.parse(readFileSync(path.join(staged, 'package.json'), 'utf8'));
  if (manifest.name !== metadata.name || manifest.version !== metadata.version) {
    fail('installed package manifest differs from registry metadata');
  }
  const binRelative = typeof manifest.bin === 'string'
    ? manifest.bin
    : manifest.bin?.[config.executable];
  if (typeof binRelative !== 'string') fail(`package does not declare ${config.executable} executable`);
  const binary = path.resolve(staged, binRelative);
  if (!binary.startsWith(`${staged}${path.sep}`) || !existsSync(binary)) fail('package executable escapes or is absent from staging');
  chmodSync(binary, 0o755);
  writeFileSync(path.join(staged, '.throne-harness.json'), `${JSON.stringify({
    package: metadata.name,
    version: metadata.version,
    integrity: metadata.integrity,
    binary: binRelative,
  }, null, 2)}\n`);
  return { staged, binary, binRelative };
}

function probeStagedHarness(config, binary, throneRoot) {
  const results = [];
  for (const args of config.safeProbes) {
    run(binary, args, { cwd: tmpdir() });
    results.push(`${config.executable} ${args.join(' ')}`);
  }
  const launcher = path.join(throneRoot, 'bin', config.launcher);
  run(launcher, ['--version'], {
    cwd: tmpdir(),
    env: { ...process.env, [config.binaryEnvironment]: binary },
  });
  results.push(`${config.launcher} --version with staged binary override`);
  const tsLoader = path.join(throneRoot, 'test', 'register-typescript.mjs');
  const launcherResolutionTest = 'test/ompy-launcher.test.ts';
  run(process.execPath, ['--import', tsLoader, '--test', launcherResolutionTest], {
    cwd: throneRoot,
  });
  results.push(`${launcherResolutionTest} proves the shared binary-override resolution that ${config.launcher} also uses`);
  results.push("create-agent spawn-acceptance of the staged binary is not probed: no existing test proves it without a live agent spawn, and a live spawn is LORD'S-ORDER-ONLY heavy territory");
  return results;
}

function acquireTransactionLock(managedRoot) {
  mkdirSync(managedRoot, { recursive: true });
  const lock = path.join(managedRoot, '.transaction-lock');
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code === 'EEXIST') fail('another harness update transaction is already running');
    throw error;
  }
  return lock;
}

function readPinnedVersion(throneRoot, harness) {
  const pinsPath = path.join(throneRoot, 'vendor-pins.json');
  const pins = JSON.parse(readFileSync(pinsPath, 'utf8'));
  const pinned = pins.harnesses?.[harness]?.version;
  if (typeof pinned !== 'string') fail(`vendor-pins.json has no harnesses.${harness}.version`);
  return pinned;
}

function vendoredBinaryPath(throneRoot, executable) {
  return path.join(throneRoot, 'vendor', 'node_modules', '.bin', executable);
}

function readVendoredVersion(throneRoot, executable) {
  const binary = vendoredBinaryPath(throneRoot, executable);
  if (!existsSync(binary)) return null;
  return run(binary, ['--version']);
}

function readNativeVersionOutsideThroneRoot(throneRoot, executable) {
  const throneRootReal = existsSync(throneRoot) ? realpathSync(throneRoot) : path.resolve(throneRoot);
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  for (const entry of pathEntries) {
    if (!entry) continue;
    const candidate = path.join(entry, executable);
    if (!existsSync(candidate)) continue;
    const candidateReal = realpathSync(candidate);
    if (candidateReal.startsWith(`${throneRootReal}${path.sep}`)) continue;
    return run(candidate, ['--version']);
  }
  return null;
}

function fetchLatestRegistryVersion(packageName, registry) {
  try {
    const raw = run('npm', ['view', `${packageName}@latest`, 'version', '--json', '--registry', registry]);
    const version = JSON.parse(raw);
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

export function resolveHarnessState({ harness, throneRoot, registry = 'https://registry.npmjs.org' }) {
  const config = HARNESS[harness];
  const pinnedVersion = readPinnedVersion(throneRoot, harness);
  const vendoredVersion = readVendoredVersion(throneRoot, config.executable);
  const nativeVersion = readNativeVersionOutsideThroneRoot(throneRoot, config.executable);
  const latestVersion = fetchLatestRegistryVersion(config.packageName, registry);
  return {
    harness,
    packageName: config.packageName,
    pinnedVersion,
    vendoredVersion,
    nativeVersion,
    latestVersion,
    activeBinary: vendoredBinaryPath(throneRoot, config.executable),
    upToDate: pinnedVersion === latestVersion && vendoredVersion === pinnedVersion,
  };
}

export function renderCheckReport(state) {
  const verdict = state.upToDate
    ? `vendored ${state.harness} ${state.vendoredVersion} (what agents run) matches registry latest ${state.latestVersion}`
    : `vendored ${state.harness} ${state.vendoredVersion ?? 'MISSING'} (what agents run) is behind registry ${state.latestVersion ?? 'unknown'}`;
  return [
    `${state.harness} pinned: ${state.pinnedVersion}`,
    `${state.harness} vendored (what agents run): ${state.vendoredVersion ?? 'not installed'}`,
    `${state.harness} native (PATH, outside throne): ${state.nativeVersion ?? 'none'}`,
    `${state.harness} registry latest: ${state.latestVersion ?? 'unknown'}`,
    verdict,
  ].join('\n');
}

function assertCourtLivenessIsReadable() {
  try {
    run('throne', ['agent-statuses']);
  } catch (error) {
    fail(`cannot confirm court liveness before a harness pin transaction: ${error.message}`);
  }
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJsonFilePreservingShape(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function vendorDirectory(throneRoot) {
  return path.join(throneRoot, 'vendor');
}

function vendorPinsPath(throneRoot) {
  return path.join(throneRoot, 'vendor-pins.json');
}

function vendorPackageJsonPath(throneRoot) {
  return path.join(vendorDirectory(throneRoot), 'package.json');
}

function vendorHarnessesStampPath(throneRoot) {
  return path.join(vendorDirectory(throneRoot), '.stamps', 'harnesses');
}

function resolveSha256Command() {
  try {
    execFileSync('sha256sum', ['--version'], { stdio: 'ignore' });
    return { command: 'sha256sum', args: [] };
  } catch {
    return { command: 'shasum', args: ['-a', '256'] };
  }
}

function computeVendorHarnessesStamp(pins) {
  const specs = ['claude', 'codex'].map((harness) => `${pins.harnesses[harness].package}@${pins.harnesses[harness].version}`);
  const input = specs.map((spec) => `${spec}\n`).join('');
  const { command, args } = resolveSha256Command();
  const digest = execFileSync(command, args, { input, encoding: 'utf8' });
  return digest.trim().split(/\s+/)[0];
}

function writeVendorPin(throneRoot, harness, version) {
  const pinsPath = vendorPinsPath(throneRoot);
  const pins = readJsonFile(pinsPath);
  pins.harnesses[harness].version = version;
  writeJsonFilePreservingShape(pinsPath, pins);
  return pins;
}

function writeVendorPackageDependency(throneRoot, packageName, version) {
  const packageJsonPath = vendorPackageJsonPath(throneRoot);
  const manifest = existsSync(packageJsonPath)
    ? readJsonFile(packageJsonPath)
    : { name: 'throne-vendor', private: true, version: '0.0.0' };
  manifest.dependencies = { ...manifest.dependencies, [packageName]: version };
  writeJsonFilePreservingShape(packageJsonPath, manifest);
}

function refreshVendorHarnessesStamp(throneRoot, pins) {
  const stampPath = vendorHarnessesStampPath(throneRoot);
  mkdirSync(path.dirname(stampPath), { recursive: true });
  writeFileSync(stampPath, `${computeVendorHarnessesStamp(pins)}\n`);
}

function installVendoredHarness(throneRoot, packageName, version, registry) {
  run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    '--prefix',
    vendorDirectory(throneRoot),
    `${packageName}@${version}`,
    '--registry',
    registry,
  ]);
}

function assertVendoredVersionMatches(throneRoot, executable, expected) {
  const actual = readVendoredVersion(throneRoot, executable);
  if (actual !== expected) fail(`vendored ${executable} reports "${actual ?? 'nothing'}", expected ${expected}`);
}

function renderVendorPinDiff(throneRoot) {
  return run('git', [
    '-C',
    throneRoot,
    'diff',
    '--',
    'vendor-pins.json',
    'vendor/package.json',
    'vendor/package-lock.json',
  ]);
}

function commitHarnessTransaction({ harness, throneRoot, version, registry }) {
  const config = HARNESS[harness];
  const pins = writeVendorPin(throneRoot, harness, version);
  writeVendorPackageDependency(throneRoot, config.packageName, version);
  installVendoredHarness(throneRoot, config.packageName, version, registry);
  refreshVendorHarnessesStamp(throneRoot, pins);
  assertVendoredVersionMatches(throneRoot, config.executable, version);
  return renderVendorPinDiff(throneRoot);
}

function rollbackHarnessTransaction({ harness, throneRoot, sourceEvidencePath, registry }) {
  const priorEvidence = readJsonFile(sourceEvidencePath);
  const previousVersion = priorEvidence.oldVersion;
  if (typeof previousVersion !== 'string') fail(`${sourceEvidencePath} has no oldVersion to roll back to`);
  const diff = commitHarnessTransaction({ harness, throneRoot, version: previousVersion, registry });
  return { previousVersion, diff };
}

function writeEvidence(destination, evidence) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.next-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, destination);
}

const MUTABLE_SERVICE_CAVEAT = 'Hosted services and model behavior remain mutable independently of these local CLI artifacts.';

export function runUpdate({ harness, throneRoot, managedRoot, registry, evidencePath, ownership }) {
  const config = HARNESS[harness];
  assertCourtLivenessIsReadable();
  const oldVersion = readPinnedVersion(throneRoot, harness);
  const metadata = discoverPackage(config, registry);
  const workRoot = mkdtempSync(path.join(managedRoot, `.stage-${harness}-`));
  try {
    const staged = stagePackage(config, metadata, registry, workRoot);
    const probes = probeStagedHarness(config, staged.binary, throneRoot);
    const diff = commitHarnessTransaction({ harness, throneRoot, version: metadata.version, registry });
    const evidence = {
      action: 'update',
      harness,
      package: metadata.name,
      oldVersion,
      newVersion: metadata.version,
      source: metadata.tarball,
      integrity: metadata.integrity,
      probes,
      diff,
      herdrPlanned: ownership.plansHerdr,
      herdrTouchedOrRestarted: false,
      mutableServiceCaveat: MUTABLE_SERVICE_CAVEAT,
    };
    writeEvidence(evidencePath, evidence);
    return evidence;
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

export function runRollback({ harness, throneRoot, sourceEvidencePath, registry, evidencePath, ownership }) {
  const { previousVersion, diff } = rollbackHarnessTransaction({ harness, throneRoot, sourceEvidencePath, registry });
  const evidence = {
    action: 'rollback',
    harness,
    restoredVersion: previousVersion,
    diff,
    herdrPlanned: ownership.plansHerdr,
    mutableServiceCaveat: MUTABLE_SERVICE_CAVEAT,
  };
  writeEvidence(evidencePath, evidence);
  return evidence;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const ownership = await loadOwnership(options.throneRoot);
  if (!ownership.ownsHarnesses) {
    process.stdout.write('Harness ownership is OFF; no discovery, download, pin, update, promotion, rollback, or ownership action was performed.\n');
    return;
  }
  const transactionLock = acquireTransactionLock(options.managedRoot);
  try {
    if (options.action === 'check') {
      const state = resolveHarnessState({ harness: options.harness, throneRoot: options.throneRoot, registry: options.registry });
      writeEvidence(options.evidence, {
        action: 'check',
        ...state,
        herdrPlanned: ownership.plansHerdr,
        mutableServiceCaveat: MUTABLE_SERVICE_CAVEAT,
      });
      process.stdout.write(`${renderCheckReport(state)}\nevidence: ${options.evidence}\n`);
      return;
    }
    if (options.action === 'rollback') {
      if (!options.sourceEvidence) fail('--source-evidence is required for rollback');
      const evidence = runRollback({ ...options, sourceEvidencePath: path.resolve(options.sourceEvidence), evidencePath: options.evidence, ownership });
      process.stdout.write(`${options.harness} rolled back to ${evidence.restoredVersion}; evidence: ${options.evidence}\n${evidence.diff}\n`);
      return;
    }
    const evidence = runUpdate({ ...options, evidencePath: options.evidence, ownership });
    process.stdout.write(`${options.harness} pinned to ${evidence.newVersion}; evidence: ${options.evidence}\n${evidence.diff}\n`);
  } finally {
    rmSync(transactionLock, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`update-harness: ${error.message}\n`);
    process.exitCode = 1;
  });
}
