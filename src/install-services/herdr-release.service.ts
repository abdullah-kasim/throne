import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type HerdrTarget = 'linux-aarch64' | 'linux-x86_64' | 'macos-aarch64' | 'macos-x86_64';

export interface HerdrReleaseArtifact {
  readonly filename: string;
  readonly sha256: string;
}

// Every sha256 below was read on 2026-08-24 from real GitHub release
// metadata for tag v0.8.2 (`gh api repos/herdrdev/herdr/releases/tags/v0.8.2`,
// the `digest` field of each asset) and NONE was hand-computed or inferred.
// linux-x86_64 additionally has an independent second confirmation: the
// artifact was downloaded and hashed locally by the herdr-update rehearsal
// and produced the identical digest. This provenance note exists because a
// previous pin move on this exact constant shipped fabricated checksums.
//
// `repository` moves with this bump: the upstream org migrated, and
// `herdr-update-release.ts` already targets `herdrdev/herdr`. Leaving this
// one on the pre-migration name kept two pins pointing at two repositories.
export const HERDR_RELEASE = {
  version: '0.8.2',
  repository: 'herdrdev/herdr',
  tag: 'v0.8.2',
  artifacts: {
    'linux-aarch64': {
      filename: 'herdr-linux-aarch64',
      sha256: 'f55610658e1c2e0d2aaef730b4b2ab885f7f8ba00285ab372bfb14f2e3d5b40d',
    },
    'linux-x86_64': {
      filename: 'herdr-linux-x86_64',
      sha256: '976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4',
    },
    'macos-aarch64': {
      filename: 'herdr-macos-aarch64',
      sha256: 'a5d4f4d504d8b309c91f811050559300faba31258425f53c50852fc96f6ae574',
    },
    'macos-x86_64': {
      filename: 'herdr-macos-x86_64',
      sha256: 'ab50262c8190cd7aa9056d249d255c08c328c3e8716de9cfa29db4f131b8e2c1',
    },
  },
} as const satisfies {
  version: string;
  repository: string;
  tag: string;
  artifacts: Record<HerdrTarget, HerdrReleaseArtifact>;
};

const SUPPORTED_TARGETS = Object.keys(HERDR_RELEASE.artifacts) as HerdrTarget[];

export function ownedHerdrExecutablePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(homeDirectory, '.local', 'share');
  return path.join(dataHome, 'throne', 'herdr', HERDR_RELEASE.tag, 'herdr');
}

export function ownedHerdrCacheDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const cacheHome = env.XDG_CACHE_HOME?.trim() || path.join(homeDirectory, '.cache');
  return path.join(cacheHome, 'throne', 'herdr');
}

export interface InstallHerdrOptions {
  readonly cacheDir: string;
  readonly installPath: string;
  readonly offline?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export interface HerdrInstallDeps {
  readonly readFile: (filePath: string) => Promise<Buffer>;
  readonly writeFile: (filePath: string, bytes: Buffer) => Promise<void>;
  readonly mkdir: (dirPath: string) => Promise<void>;
  readonly chmod: (filePath: string, mode: number) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly remove: (filePath: string) => Promise<void>;
  readonly download: (url: string) => Promise<Buffer>;
  readonly sha256: (bytes: Buffer) => string;
  readonly readVersion: (executablePath: string) => Promise<string>;
  readonly randomId: () => string;
}

export interface HerdrInstallResult {
  readonly target: HerdrTarget;
  readonly source: 'installed' | 'cache' | 'download';
  readonly installPath: string;
}

function runVersion(executablePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`herdr --version exited ${code}: ${Buffer.concat(stderr).toString().trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString().trim());
    });
  });
}

export const DEFAULT_HERDR_INSTALL_DEPS: HerdrInstallDeps = {
  readFile,
  writeFile: async (filePath, bytes) => writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 }),
  mkdir: async (dirPath) => {
    await mkdir(dirPath, { recursive: true });
  },
  chmod,
  rename,
  remove: async (filePath) => {
    await rm(filePath, { force: true });
  },
  download: async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`download failed with HTTP ${response.status} for ${url}`);
    }
    return Buffer.from(await response.arrayBuffer());
  },
  sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
  readVersion: runVersion,
  randomId: randomUUID,
};

export function selectHerdrTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): HerdrTarget {
  const os = platform === 'darwin' ? 'macos' : platform;
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  const requested = `${os}-${cpu}`;
  if (SUPPORTED_TARGETS.includes(requested as HerdrTarget)) {
    return requested as HerdrTarget;
  }
  throw new Error(
    `unsupported herdr target "${requested}"; supported targets: ${SUPPORTED_TARGETS.join(', ')}`,
  );
}

export function herdrReleaseUrl(artifact: HerdrReleaseArtifact): string {
  return `https://github.com/${HERDR_RELEASE.repository}/releases/download/${HERDR_RELEASE.tag}/${artifact.filename}`;
}

function hasExecutableFormat(bytes: Buffer, target: HerdrTarget): boolean {
  if (target.startsWith('linux-')) {
    return bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  }
  const magic = bytes.subarray(0, 4).toString('hex');
  return ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(magic);
}

function verifyArtifactBytes(
  bytes: Buffer,
  target: HerdrTarget,
  artifact: HerdrReleaseArtifact,
  deps: HerdrInstallDeps,
): void {
  const actual = deps.sha256(bytes);
  if (actual !== artifact.sha256) {
    throw new Error(
      `herdr ${target} checksum mismatch: expected ${artifact.sha256}, received ${actual}`,
    );
  }
  if (!hasExecutableFormat(bytes, target)) {
    throw new Error(`herdr ${target} artifact is not a supported executable format`);
  }
}

async function readVerifiedBytes(
  filePath: string,
  target: HerdrTarget,
  artifact: HerdrReleaseArtifact,
  deps: HerdrInstallDeps,
): Promise<Buffer | null> {
  try {
    const bytes = await deps.readFile(filePath);
    verifyArtifactBytes(bytes, target, artifact, deps);
    return bytes;
  } catch {
    return null;
  }
}

async function prepareExecutable(
  bytes: Buffer,
  destination: string,
  target: HerdrTarget,
  deps: HerdrInstallDeps,
): Promise<string> {
  const stagingPath = `${destination}.staging-${deps.randomId()}`;
  try {
    await deps.writeFile(stagingPath, bytes);
    await deps.chmod(stagingPath, 0o755);
    const version = await deps.readVersion(stagingPath);
    const expected = `herdr ${HERDR_RELEASE.version}`;
    if (version !== expected) {
      throw new Error(`herdr version mismatch: expected "${expected}", received "${version}"`);
    }
    return stagingPath;
  } catch (error) {
    await deps.remove(stagingPath).catch(() => undefined);
    throw error;
  }
}

async function cacheVerifiedBytes(
  bytes: Buffer,
  cachePath: string,
  deps: HerdrInstallDeps,
): Promise<void> {
  const stagingPath = `${cachePath}.partial-${deps.randomId()}`;
  try {
    await deps.writeFile(stagingPath, bytes);
    await deps.rename(stagingPath, cachePath);
  } catch (error) {
    await deps.remove(stagingPath).catch(() => undefined);
    throw error;
  }
}

export async function installPinnedHerdr(
  options: InstallHerdrOptions,
  deps: HerdrInstallDeps = DEFAULT_HERDR_INSTALL_DEPS,
): Promise<HerdrInstallResult> {
  const target = selectHerdrTarget(options.platform, options.arch);
  const artifact = HERDR_RELEASE.artifacts[target];
  const cachePath = path.join(options.cacheDir, HERDR_RELEASE.tag, artifact.filename);

  const installedBytes = await readVerifiedBytes(options.installPath, target, artifact, deps);
  if (installedBytes !== null) {
    const version = await deps.readVersion(options.installPath).catch(() => '');
    if (version === `herdr ${HERDR_RELEASE.version}`) {
      return { target, source: 'installed', installPath: options.installPath };
    }
  }

  let source: HerdrInstallResult['source'] = 'cache';
  let bytes = await readVerifiedBytes(cachePath, target, artifact, deps);
  if (bytes === null) {
    if (options.offline === true) {
      throw new Error(
        `cannot install herdr ${HERDR_RELEASE.version} for ${target} offline: no verified artifact at ${cachePath}`,
      );
    }
    source = 'download';
    bytes = await deps.download(herdrReleaseUrl(artifact));
    verifyArtifactBytes(bytes, target, artifact, deps);
    await deps.mkdir(path.dirname(cachePath));
    await cacheVerifiedBytes(bytes, cachePath, deps);
  }

  await deps.mkdir(path.dirname(options.installPath));
  const stagingPath = await prepareExecutable(bytes, options.installPath, target, deps);
  try {
    await deps.rename(stagingPath, options.installPath);
  } catch (error) {
    await deps.remove(stagingPath).catch(() => undefined);
    throw error;
  }
  return { target, source, installPath: options.installPath };
}

/** Injectable owner of the pinned Herdr release/install contract. */
export class HerdrReleaseService {
  readonly release = HERDR_RELEASE;

  executablePath(env: NodeJS.ProcessEnv = process.env, homeDirectory = os.homedir()): string {
    return ownedHerdrExecutablePath(env, homeDirectory);
  }

  cacheDirectory(env: NodeJS.ProcessEnv = process.env, homeDirectory = os.homedir()): string {
    return ownedHerdrCacheDirectory(env, homeDirectory);
  }

  install(options: InstallHerdrOptions, deps: HerdrInstallDeps = DEFAULT_HERDR_INSTALL_DEPS) {
    return installPinnedHerdr(options, deps);
  }
}
