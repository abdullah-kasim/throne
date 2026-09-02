import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findRepoRoot } from '../shared-policy/runtime-throne-root.ts';

const execFileAsync = promisify(execFile);

/** The real upstream repository (post org-migration) that mints herdr releases. */
export const HERDR_UPDATE_REPOSITORY = 'herdrdev/herdr';

/** This repo's own `bin/gh` guard shim, which already permits read-only
 *  `gh api` calls (GET/HEAD). Resolved by path rather than trusting PATH: a
 *  globally installed `gh` shim elsewhere on PATH can lag behind this repo's
 *  guard and deny the exact read this capability needs.
 *
 *  Resolved through `findRepoRoot` rather than by counting `..` segments.
 *  Two `..` from this module's directory is the repo root only under source
 *  execution; from `dist/src/herdr-update/` it yields `dist/bin/gh`, which
 *  does not exist, and the compiled capability died with `spawn
 *  .../dist.build.<gen>/bin/gh ENOENT` (observed 2026-08-24, the first time
 *  it was ever driven from a compiled build). `findRepoRoot` walks up to the
 *  directory whose `package.json` is named "throne", so it is correct under
 *  source execution, plain `dist/`, and the symlinked
 *  `dist/ -> dist.build.<gen>/` generation shape alike. */
function repoGhShimPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(findRepoRoot(moduleDir), 'bin', 'gh');
}

export interface HerdrReleaseAsset {
  readonly name: string;
  readonly sha256: string;
  readonly downloadUrl: string;
}

export interface HerdrUpdateProcessBoundary {
  readonly ghApi: (endpoint: string) => Promise<string>;
  readonly download: (url: string) => Promise<Buffer>;
  readonly sha256: (bytes: Buffer) => string;
}

function runGhApi(endpoint: string): Promise<string> {
  return execFileAsync(repoGhShimPath(), ['api', endpoint], { maxBuffer: 16 * 1024 * 1024 }).then(
    (result) => result.stdout,
  );
}

export const DEFAULT_HERDR_UPDATE_PROCESS_BOUNDARY: HerdrUpdateProcessBoundary = {
  ghApi: runGhApi,
  download: async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`herdr-update: download failed with HTTP ${response.status} for ${url}`);
    }
    return Buffer.from(await response.arrayBuffer());
  },
  sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
};

function assetNameForPlatform(platform: NodeJS.Platform, arch: string): string {
  const osName = platform === 'darwin' ? 'macos' : platform;
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  return `herdr-${osName}-${cpu}`;
}

/** Fetches the release's real asset metadata from GitHub — filename, download
 *  URL, and sha256 digest — never a hand-typed or reconstructed value. */
export async function fetchRealReleaseAsset(
  tag: string,
  boundary: HerdrUpdateProcessBoundary = DEFAULT_HERDR_UPDATE_PROCESS_BOUNDARY,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<HerdrReleaseAsset> {
  const raw = await boundary.ghApi(`repos/${HERDR_UPDATE_REPOSITORY}/releases/tags/${tag}`);
  const release = JSON.parse(raw) as {
    assets?: Array<{ name: string; digest?: string; browser_download_url: string }>;
  };
  const wantedName = assetNameForPlatform(platform, arch);
  const asset = release.assets?.find((candidate) => candidate.name === wantedName);
  if (!asset) {
    throw new Error(`herdr-update: release "${tag}" has no asset named "${wantedName}"`);
  }
  if (!asset.digest?.startsWith('sha256:')) {
    throw new Error(
      `herdr-update: release asset "${wantedName}" carries no sha256 digest in its GitHub metadata`,
    );
  }
  return {
    name: asset.name,
    sha256: asset.digest.slice('sha256:'.length),
    downloadUrl: asset.browser_download_url,
  };
}

export interface HerdrUpdateDownloadResult {
  readonly artifactPath: string;
  readonly computedSha256: string;
  readonly expectedSha256: string;
  readonly hashMatched: boolean;
  readonly cleanup: () => Promise<void>;
}

/** Downloads the release asset beside (never over) the throne-pinned copy,
 *  computes its hash, and compares it against the hash GitHub's own release
 *  metadata reports for that exact asset. Never accepts a hand-typed hash. */
export async function downloadAndVerifyHerdrRelease(
  tag: string,
  boundary: HerdrUpdateProcessBoundary = DEFAULT_HERDR_UPDATE_PROCESS_BOUNDARY,
): Promise<HerdrUpdateDownloadResult> {
  const asset = await fetchRealReleaseAsset(tag, boundary);
  const bytes = await boundary.download(asset.downloadUrl);
  const computedSha256 = boundary.sha256(bytes);
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), 'herdr-update-rehearsal-'));
  const artifactPath = path.join(stagingDir, asset.name);
  await writeFile(artifactPath, bytes);
  await chmod(artifactPath, 0o755);
  return {
    artifactPath,
    computedSha256,
    expectedSha256: asset.sha256,
    hashMatched: computedSha256 === asset.sha256,
    cleanup: () => rm(stagingDir, { recursive: true, force: true }),
  };
}
