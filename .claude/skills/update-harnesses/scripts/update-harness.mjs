#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
    if (!['managed-root', 'evidence', 'registry', 'throne-root', 'harness'].includes(key)) {
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

function currentTarget(harnessRoot) {
  const link = path.join(harnessRoot, 'current');
  return existsSync(link) || lstatExists(link) ? readlinkSync(link) : null;
}

function lstatExists(target) {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
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
  const tests = [
    'test/throne-launcher-path.test.ts',
    'test/create-agent-send-agent-handoff.canary.test.ts',
  ];
  const tsLoader = path.join(throneRoot, 'test', 'register-typescript.mjs');
  // The canary test itself spawns further `node src/tools.ts` subprocesses
  // (its own live create-agent/send-agent/reap-agent calls). `--import` only
  // installs the TS decorator loader in THIS process, not in a child spawned
  // via spawnSync, so those nested subprocesses need the loader too — set via
  // NODE_OPTIONS (inherited down the whole spawn chain) with an ABSOLUTE
  // path, since a relative `--import` path resolves against each subprocess's
  // own cwd, not the throne root.
  run(process.execPath, ['--import', tsLoader, '--test', ...tests], {
    cwd: throneRoot,
    env: {
      ...process.env,
      THRONE_RUN_LIVE_SEND_AGENT_HANDOFF_CANARY: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${tsLoader}`.trim(),
    },
  });
  results.push('launcher, create-agent, and live send-agent enqueue-drain-delivered handoff proof');
  return results;
}

function replaceLink(link, target) {
  const temporary = `${link}.next-${process.pid}`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, link);
}

function restoreLink(link, target) {
  if (target === null) {
    // The link is a symlink to a directory; `rmSync` resolves it and throws
    // EISDIR ("Path is a directory") rather than unlinking, which would abort
    // the unwind and strand a promoted `current` on a first install.
    if (lstatExists(link)) unlinkSync(link);
    return;
  }
  replaceLink(link, target);
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

function installedVersion(harnessRoot) {
  const target = currentTarget(harnessRoot);
  if (!target) return null;
  const releasePath = path.resolve(harnessRoot, target);
  const metadataPath = path.join(releasePath, '.throne-harness.json');
  if (!existsSync(metadataPath)) return null;
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  return {
    version: run(path.resolve(releasePath, metadata.binary), ['--version']),
    binary: path.resolve(releasePath, metadata.binary),
  };
}

function promote(staged, harnessRoot, metadata) {
  mkdirSync(path.join(harnessRoot, 'versions'), { recursive: true });
  const releaseName = `${metadata.version}-${metadata.integrity.slice('sha512-'.length, 'sha512-'.length + 12).replaceAll('/', '_')}`;
  const releasePath = path.join(harnessRoot, 'versions', releaseName);
  if (existsSync(releasePath)) rmSync(staged, { recursive: true, force: true });
  else renameSync(staged, releasePath);
  const currentLink = path.join(harnessRoot, 'current');
  const previousLink = path.join(harnessRoot, 'previous');
  const oldTarget = currentTarget(harnessRoot);
  const oldPreviousTarget = lstatExists(previousLink) ? readlinkSync(previousLink) : null;
  if (oldTarget) replaceLink(path.join(harnessRoot, 'previous'), oldTarget);
  replaceLink(currentLink, path.relative(harnessRoot, releasePath));
  return {
    oldTarget,
    oldPreviousTarget,
    newTarget: path.relative(harnessRoot, releasePath),
    releasePath,
    restore() {
      restoreLink(currentLink, oldTarget);
      restoreLink(previousLink, oldPreviousTarget);
    },
  };
}

function rollback(harnessRoot) {
  const current = currentTarget(harnessRoot);
  const previousLink = path.join(harnessRoot, 'previous');
  if (!current || !lstatExists(previousLink)) fail('rollback requires both current and previous releases');
  const previous = readlinkSync(previousLink);
  replaceLink(path.join(harnessRoot, 'current'), previous);
  replaceLink(previousLink, current);
  return { oldTarget: current, newTarget: previous };
}

function writeEvidence(destination, evidence) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.next-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, destination);
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
    const config = HARNESS[options.harness];
    const harnessRoot = path.join(options.managedRoot, options.harness);
    const before = currentTarget(harnessRoot);
    const oldCli = installedVersion(harnessRoot);
    if (options.action === 'rollback') {
      const promotion = rollback(harnessRoot);
      writeEvidence(options.evidence, {
        action: 'rollback',
        harness: options.harness,
        oldVersionPath: promotion.oldTarget,
        newVersionPath: promotion.newTarget,
        herdrPlanned: false,
        mutableServiceCaveat: 'Hosted services and model behavior remain mutable independently of these local CLI artifacts.',
      });
      process.stdout.write(`${options.harness} rolled back; evidence: ${options.evidence}\n`);
      return;
    }
    const metadata = discoverPackage(config, options.registry);
    if (options.action === 'check') {
      writeEvidence(options.evidence, {
        action: 'check',
        harness: options.harness,
        oldVersionPath: before,
        oldCliVersion: oldCli?.version ?? null,
        availableVersion: metadata.version,
        source: metadata.tarball,
        integrity: metadata.integrity,
        herdrPlanned: ownership.plansHerdr,
        mutableServiceCaveat: 'Hosted services and model behavior remain mutable independently of these local CLI artifacts.',
      });
      process.stdout.write(`${options.harness} ${metadata.version} is available; evidence: ${options.evidence}\n`);
      return;
    }
    const workRoot = mkdtempSync(path.join(options.managedRoot, `.stage-${options.harness}-`));
    try {
      const staged = stagePackage(config, metadata, options.registry, workRoot);
      const newCliVersion = run(staged.binary, ['--version']);
      const probes = probeStagedHarness(config, staged.binary, options.throneRoot);
      const promotion = promote(staged.staged, harnessRoot, metadata);
      try {
        writeEvidence(options.evidence, {
          action: 'update',
          harness: options.harness,
          package: metadata.name,
          oldVersionPath: promotion.oldTarget,
          oldCliVersion: oldCli?.version ?? null,
          newVersion: metadata.version,
          newCliVersion,
          newVersionPath: promotion.newTarget,
          activeBinary: path.join(harnessRoot, 'current', staged.binRelative),
          source: metadata.tarball,
          integrity: metadata.integrity,
          probes,
          promotionPath: path.join(harnessRoot, 'current'),
          rollbackPath: promotion.oldTarget ? path.join(harnessRoot, 'previous') : null,
          herdrPlanned: ownership.plansHerdr,
          herdrTouchedOrRestarted: false,
          mutableServiceCaveat: 'Hosted services and model behavior remain mutable independently of these local CLI artifacts.',
        });
      } catch (error) {
        promotion.restore();
        throw error;
      }
      process.stdout.write(`${options.harness} promoted to ${metadata.version}; evidence: ${options.evidence}\n`);
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(transactionLock, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`update-harness: ${error.message}\n`);
  process.exitCode = 1;
});
