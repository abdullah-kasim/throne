import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PIN_FILE = 'vendor-pins.json';

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

export function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJsonFilePreservingShape(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function vendorDirectory(throneRoot) {
  return path.join(throneRoot, 'vendor');
}

export function vendorPinsPath(throneRoot) {
  return path.join(throneRoot, PIN_FILE);
}

function pinnedVersionIn(pins, harness) {
  const pinned = pins.harnesses?.[harness]?.version;
  if (typeof pinned !== 'string') throw new Error(`vendor-pins.json has no harnesses.${harness}.version`);
  return pinned;
}

export function readPinnedVersion(throneRoot, harness) {
  return pinnedVersionIn(readJsonFile(vendorPinsPath(throneRoot)), harness);
}

export function readCommittedPinnedVersion(throneRoot, harness) {
  return pinnedVersionIn(JSON.parse(run('git', ['-C', throneRoot, 'show', `HEAD:${PIN_FILE}`])), harness);
}

export function vendoredBinaryPath(throneRoot, executable) {
  return path.join(vendorDirectory(throneRoot), 'node_modules', '.bin', executable);
}

export function readVendoredVersion(throneRoot, executable) {
  const binary = vendoredBinaryPath(throneRoot, executable);
  if (!existsSync(binary)) return null;
  return run(binary, ['--version']);
}

export function installVendoredHarness(throneRoot, packageName, version, registry) {
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

export function writeVendorPin(throneRoot, harness, version) {
  const pinsPath = vendorPinsPath(throneRoot);
  const pins = readJsonFile(pinsPath);
  pins.harnesses[harness].version = version;
  writeJsonFilePreservingShape(pinsPath, pins);
  return pins;
}

export function writeVendorPackageDependency(throneRoot, packageName, version) {
  const packageJsonPath = vendorPackageJsonPath(throneRoot);
  const manifest = existsSync(packageJsonPath)
    ? readJsonFile(packageJsonPath)
    : { name: 'throne-vendor', private: true, version: '0.0.0' };
  manifest.dependencies = { ...manifest.dependencies, [packageName]: version };
  writeJsonFilePreservingShape(packageJsonPath, manifest);
}

export function refreshVendorHarnessesStamp(throneRoot, pins) {
  const stampPath = vendorHarnessesStampPath(throneRoot);
  mkdirSync(path.dirname(stampPath), { recursive: true });
  writeFileSync(stampPath, `${computeVendorHarnessesStamp(pins)}\n`);
}
