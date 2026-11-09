#!/usr/bin/env node

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

import { landPinCommit } from '../../../../scripts/land-pin-commit.mjs';
import { acquireTransactionLock } from './transaction-lock.mjs';
import {
  installVendoredHarness,
  PIN_FILE,
  readCommittedPinnedVersion,
  readJsonFile,
  readPinnedVersion,
  readVendoredVersion,
  refreshVendorHarnessesStamp,
  run,
  vendoredBinaryPath,
  vendorPinsPath,
  writeVendorPackageDependency,
  writeVendorPin,
} from './vendor-files.mjs';

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
  if (positionals.length !== 1 || !['check', 'update', 'pinned', 'rollback'].includes(positionals[0])) {
    fail('usage: update-harness.mjs <check|update|pinned|rollback> --harness <claude|codex> --throne-root <path> [--managed-root <path>] [--evidence <path>] [--registry <url>] [--source-evidence <path>]');
  }
  options.action = positionals[0];
  if (!HARNESS[options.harness]) fail('--harness must be claude or codex');
  if (!options.throneRoot) fail('--throne-root is required');
  options.throneRoot = path.resolve(options.throneRoot);
  options.managedRoot = path.resolve(options.managedRoot);
  options.evidence = path.resolve(options.evidence ?? path.join(options.managedRoot, 'evidence', `${options.harness}-${Date.now()}.json`));
  return options;
}

function discoverPackage(config, registry, version = 'latest') {
  const raw = run('npm', [
    'view',
    `${config.packageName}@${version}`,
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
    upToDate: pinnedVersion === latestVersion && versionOutputReports(vendoredVersion, pinnedVersion),
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

export function versionOutputReports(versionOutput, expected) {
  if (typeof versionOutput !== 'string') return false;
  return versionOutput.trim().split(/\s+/).includes(expected);
}

function assertVendoredVersionMatches(vendoredVersion, executable, expected) {
  if (!versionOutputReports(vendoredVersion, expected)) {
    fail(`vendored ${executable} reports "${vendoredVersion ?? 'nothing'}", expected ${expected}`);
  }
}

function renderVendorPinDiff(throneRoot) {
  return run('git', ['-C', throneRoot, 'diff', '--', PIN_FILE]);
}

function applyHarnessVersion({ harness, throneRoot, version, registry }) {
  const config = HARNESS[harness];
  const pins = writeVendorPin(throneRoot, harness, version);
  writeVendorPackageDependency(throneRoot, config.packageName, version);
  installVendoredHarness(throneRoot, config.packageName, version, registry);
  refreshVendorHarnessesStamp(throneRoot, pins);
  return {
    diff: renderVendorPinDiff(throneRoot),
    vendoredVersion: readVendoredVersion(throneRoot, config.executable),
  };
}

function rollbackHarnessTransaction({ harness, throneRoot, sourceEvidencePath, registry }) {
  const priorEvidence = readJsonFile(sourceEvidencePath);
  const previousVersion = priorEvidence.oldVersion;
  if (typeof previousVersion !== 'string') fail(`${sourceEvidencePath} has no oldVersion to roll back to`);
  const { diff, vendoredVersion } = applyHarnessVersion({ harness, throneRoot, version: previousVersion, registry });
  return { previousVersion, diff, vendoredVersion };
}

function writeEvidence(destination, evidence) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.next-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, destination);
}

const MUTABLE_SERVICE_CAVEAT = 'Hosted services and model behavior remain mutable independently of these local CLI artifacts.';

function harnessIsCurrent(throneRoot, config, pinnedVersion, latestVersion) {
  return pinnedVersion === latestVersion
    && versionOutputReports(readVendoredVersion(throneRoot, config.executable), latestVersion);
}

function readCurrentHarness(throneRoot, config) {
  return {
    probes: [],
    diff: renderVendorPinDiff(throneRoot),
    vendoredVersion: readVendoredVersion(throneRoot, config.executable),
  };
}

function probeStagedPackage({ harness, throneRoot, managedRoot, metadata, registry }) {
  const config = HARNESS[harness];
  const workRoot = mkdtempSync(path.join(managedRoot, `.stage-${harness}-`));
  try {
    const staged = stagePackage(config, metadata, registry, workRoot);
    return probeStagedHarness(config, staged.binary, throneRoot);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function installProbedHarness({ harness, throneRoot, managedRoot, metadata, registry }) {
  const probes = probeStagedPackage({ harness, throneRoot, managedRoot, metadata, registry });
  return { probes, ...applyHarnessVersion({ harness, throneRoot, version: metadata.version, registry }) };
}

function installPinnedHarness({ harness, throneRoot, managedRoot, version, registry }) {
  const config = HARNESS[harness];
  const metadata = discoverPackage(config, registry, version);
  const probes = probeStagedPackage({ harness, throneRoot, managedRoot, metadata, registry });
  installVendoredHarness(throneRoot, config.packageName, version, registry);
  refreshVendorHarnessesStamp(throneRoot, readJsonFile(vendorPinsPath(throneRoot)));
  return {
    package: metadata.name,
    source: metadata.tarball,
    integrity: metadata.integrity,
    probes,
    vendoredVersion: readVendoredVersion(throneRoot, config.executable),
  };
}

function vendoredVersionIfItRuns(throneRoot, executable) {
  try {
    return readVendoredVersion(throneRoot, executable);
  } catch {
    return null;
  }
}

function versionReportedBy(versionOutput) {
  return versionOutput?.split(/\s+/).find((word) => /^\d/.test(word)) ?? 'none';
}

function landHarnessPin({ harness, throneRoot, version, evidence, evidencePath }) {
  const pinCommit = landPinCommit({
    repository: throneRoot,
    paths: [PIN_FILE],
    message: `Pin ${harness} to ${version}`,
  });
  const landedEvidence = { ...evidence, pinCommit };
  writeEvidence(evidencePath, landedEvidence);
  return landedEvidence;
}

export function runUpdate({ harness, throneRoot, managedRoot, registry, evidencePath }) {
  const config = HARNESS[harness];
  assertCourtLivenessIsReadable();
  const oldVersion = readCommittedPinnedVersion(throneRoot, harness);
  const metadata = discoverPackage(config, registry);
  const { probes, diff, vendoredVersion } = harnessIsCurrent(throneRoot, config, readPinnedVersion(throneRoot, harness), metadata.version)
    ? readCurrentHarness(throneRoot, config)
    : installProbedHarness({ harness, throneRoot, managedRoot, metadata, registry });
  const evidence = {
    action: 'update',
    harness,
    package: metadata.name,
    oldVersion,
    newVersion: metadata.version,
    vendoredVersion,
    source: metadata.tarball,
    integrity: metadata.integrity,
    probes,
    diff,
    herdrTouchedOrRestarted: false,
    mutableServiceCaveat: MUTABLE_SERVICE_CAVEAT,
  };
  writeEvidence(evidencePath, evidence);
  assertVendoredVersionMatches(vendoredVersion, config.executable, metadata.version);
  return landHarnessPin({ harness, throneRoot, version: metadata.version, evidence, evidencePath });
}

export function runPinned({ harness, throneRoot, managedRoot, registry, evidencePath }) {
  const { executable } = HARNESS[harness];
  const version = readPinnedVersion(throneRoot, harness);
  const versionOutputBefore = vendoredVersionIfItRuns(throneRoot, executable);
  const moved = !versionOutputReports(versionOutputBefore, version);
  const evidence = {
    action: 'pinned',
    harness,
    moved,
    oldVersion: versionReportedBy(versionOutputBefore),
    newVersion: version,
    ...(moved
      ? installPinnedHarness({ harness, throneRoot, managedRoot, version, registry })
      : { probes: [], vendoredVersion: versionOutputBefore }),
  };
  writeEvidence(evidencePath, evidence);
  assertVendoredVersionMatches(evidence.vendoredVersion, executable, version);
  return evidence;
}

export function runRollback({ harness, throneRoot, sourceEvidencePath, registry, evidencePath }) {
  const { previousVersion, diff, vendoredVersion } = rollbackHarnessTransaction({ harness, throneRoot, sourceEvidencePath, registry });
  const evidence = {
    action: 'rollback',
    harness,
    restoredVersion: previousVersion,
    vendoredVersion,
    diff,
    mutableServiceCaveat: MUTABLE_SERVICE_CAVEAT,
  };
  writeEvidence(evidencePath, evidence);
  assertVendoredVersionMatches(vendoredVersion, HARNESS[harness].executable, previousVersion);
  return landHarnessPin({ harness, throneRoot, version: previousVersion, evidence, evidencePath });
}

function renderPinnedOutcome({ harness, moved, oldVersion, newVersion }) {
  return moved
    ? `update-harness: ${harness} moved from ${oldVersion} to ${newVersion}`
    : `update-harness: ${harness} unchanged at ${newVersion}`;
}

function printPinCommit({ pushRefused, detail }) {
  const output = pushRefused ? process.stderr : process.stdout;
  output.write(`update-harness: ${detail}\n`);
  if (pushRefused) process.exitCode = 1;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const transactionLock = acquireTransactionLock(options.managedRoot);
  try {
    if (options.action === 'check') {
      const state = resolveHarnessState({ harness: options.harness, throneRoot: options.throneRoot, registry: options.registry });
      writeEvidence(options.evidence, {
        action: 'check',
        ...state,
        mutableServiceCaveat: MUTABLE_SERVICE_CAVEAT,
      });
      process.stdout.write(`${renderCheckReport(state)}\nevidence: ${options.evidence}\n`);
      return;
    }
    if (options.action === 'pinned') {
      const evidence = runPinned({ ...options, evidencePath: options.evidence });
      process.stdout.write(`${renderPinnedOutcome(evidence)}\nevidence: ${options.evidence}\n`);
      return;
    }
    if (options.action === 'rollback') {
      if (!options.sourceEvidence) fail('--source-evidence is required for rollback');
      const evidence = runRollback({ ...options, sourceEvidencePath: path.resolve(options.sourceEvidence), evidencePath: options.evidence });
      process.stdout.write(`${options.harness} rolled back to ${evidence.restoredVersion}; evidence: ${options.evidence}\n${evidence.diff}\n`);
      printPinCommit(evidence.pinCommit);
      return;
    }
    const evidence = runUpdate({ ...options, evidencePath: options.evidence });
    process.stdout.write(`${options.harness} pinned to ${evidence.newVersion}; evidence: ${options.evidence}\n${evidence.diff}\n`);
    printPinCommit(evidence.pinCommit);
  } finally {
    rmSync(transactionLock, { recursive: true, force: true });
  }
}

function calledAsTheEntryScript() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
}

if (calledAsTheEntryScript()) {
  main().catch((error) => {
    process.stderr.write(`update-harness: ${error.message}\n`);
    process.exitCode = 1;
  });
}
